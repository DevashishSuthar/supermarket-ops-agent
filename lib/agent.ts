// import { anthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import { Prisma } from "@prisma/client";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";

import { getPreferences, setPreference } from "./tools/preferences";
import * as inventory from "./tools/inventory";
import * as billing from "./tools/billing";
import * as khata from "./tools/khata";
import * as reports from "./tools/reports";
import { generateInvoicePdf } from "./documents/invoice";
import { generateAnalysisDeck } from "./documents/deck";
import { sendDocument } from "./telegram";
import { db } from "./db";
import { ToolError } from "./tools/inventory";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SHOP_INFO = {
  name: process.env.SHOP_NAME ?? "My Kirana Store",
  gstin: process.env.SHOP_GSTIN,
  address: process.env.SHOP_ADDRESS,
  // Stretch goal: "branded invoices" — optional hex like "#1a5276" in env,
  // converted to the 0-1 RGB triple pdf-lib expects. Falls back to
  // invoice.ts's own default teal if unset or malformed.
  brandColor: parseHexColor(process.env.SHOP_BRAND_COLOR),
};

function parseHexColor(hex?: string): [number, number, number] | undefined {
  if (!hex) return undefined;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const int = parseInt(match[1], 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

const MAX_HISTORY_MESSAGES = 20; // ~10 turns — enough context, bounded token cost

const getProductSchema = z.object({
  query: z.string().describe("product name or SKU as the owner typed it"),
});

type GetProductArgs = z.infer<typeof getProductSchema>;

const addProductSchema = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.enum(["kg", "g", "litre", "ml", "packet", "dozen", "piece"]),
  isLoose: z.boolean().nullish(),
  costPrice: z.number(),
  mrp: z.number(),
  hsn: z.string().describe("HSN code for this product"),
  gstSlab: z.number().describe("GST % slab: 0, 5, 12, or 18"),
  initialQty: z.number().nullish(),
  reorderLevel: z.number().nullish(),
});

type AddProductArgs = z.infer<typeof addProductSchema>;

const receiveStockSchema = z.object({
  productQuery: z.string(),
  qty: z.number(),
  costPrice: z.number().nullish(),
  mrp: z.number().nullish(),
});

type ReceiveStockArgs = z.infer<typeof receiveStockSchema>;

const addItemSchema = z.object({
  productQuery: z.string(),
  qty: z.number(),
});

type AddItemArgs = z.infer<typeof addItemSchema>;

const removeItemSchema = z.object({
  productQuery: z.string(),
});

type RemoveItemArgs = z.infer<typeof removeItemSchema>;

const finalizeBillSchema = z.object({
  paymentMode: z.enum(["CASH", "UPI", "CARD"]),
  paymentRef: z.string().nullish().describe("UPI ref / card auth code if given"),
});

type FinalizeBillArgs = z.infer<typeof finalizeBillSchema>;

const addCreditSchema = z.object({
  customerName: z.string(),
  amount: z.number(),
  note: z.string().nullish()
});

type AddCreditArgs = z.infer<typeof addCreditSchema>;

const recordKhataPaymentSchema = z.object({
  customerName: z.string(),
  amount: z.number(),
});

type RecordKhataPaymentArgs = z.infer<typeof recordKhataPaymentSchema>;

const getKhataBalanceSchema = z.object({
  customerName: z.string(),
});

type GetKhataBalanceArgs = z.infer<typeof getKhataBalanceSchema>;

const dailyCloseSchema = z.object({
  date: z.string().nullish().describe("ISO date, defaults to today")
});

type DailyCloseArgs = z.infer<typeof dailyCloseSchema>;

const generateInvoicePdfSchema = z.object({
  billId: z.string()
});

type GenerateInvoicePdfArgs = z.infer<typeof generateInvoicePdfSchema>;

const generateAnalysisDeckSchema = z.object({
  startDate: z.string().describe("ISO date, start of range"),
  endDate: z.string().describe("ISO date, end of range"),
  label: z.string().describe("human label like 'This Week'"),
});

type GenerateAnalysisDeckArgs = z.infer<typeof generateAnalysisDeckSchema>;

const setPreferenceSchema = z.object({
  key: z.string(),
  value: z.string()
});

type SetPreferenceArgs = z.infer<typeof setPreferenceSchema>;

/**
 * Agent-first design: EVERY one of these tools is a thin, single-purpose
 * function. There is no keyword router deciding "this is a billing
 * message" vs "this is a stock message" — the model reads the raw text
 * and picks the tool(s) itself, chaining as many as it needs in one turn
 * (e.g. addItemToBill -> addItemToBill -> viewDraftBill -> finalizeBill).
 * All business rules (GST, oversell, idempotency, khata existence) are
 * enforced INSIDE these tools / the DB transaction, never in the prompt.
 */
function buildTools(chatId: string) {
  const wrap = <T>(fn: () => Promise<T>) =>
    fn().catch((e) => {
      if (e instanceof ToolError) return { error: e.message };
      console.error(e);
      return { error: "Something went wrong on our end — please try again." };
    });

  return {
    getProduct: tool({
      description: "Look up a product's price, stock, GST slab, etc. by name or SKU.",
      inputSchema: getProductSchema,
      execute: async ({ query }: GetProductArgs) => wrap(() => inventory.checkStock(query)),
    }),

    addProduct: tool({
      description: "Register a brand-new product/SKU that doesn't exist yet.",
      inputSchema: addProductSchema,
      // addProductSchema uses .nullish() on isLoose/initialQty/reorderLevel so the
      // model can explicitly pass `null`, but inventory.addProduct's parameter type
      // only allows `undefined` for these optional fields (no `null`). Normalize
      // null -> undefined here at the boundary rather than loosening the schema or
      // inventory's type, since `null` from the LLM never carries distinct meaning
      // from "not provided" for these fields.
      execute: async (input: AddProductArgs) =>
        wrap(() =>
          inventory.addProduct({
            ...input,
            isLoose: input.isLoose ?? undefined,
            initialQty: input.initialQty ?? undefined,
            reorderLevel: input.reorderLevel ?? undefined,
          })
        ),
    }),

    receiveStock: tool({
      description: "Record incoming stock for an EXISTING product (e.g. '50 packets of Maggi came in, cost 12').",
      inputSchema: receiveStockSchema,
      // Same null -> undefined normalization as addProduct: receiveStockSchema's
      // .nullish() fields allow the model to send explicit null, but
      // inventory.receiveStock's parameter type only allows undefined here.
      execute: async (input: ReceiveStockArgs) =>
        wrap(() =>
          inventory.receiveStock({
            ...input,
            costPrice: input.costPrice ?? undefined,
            mrp: input.mrp ?? undefined,
          })
        ),
    }),

    lowStockReport: tool({
      description: "List products at or below their reorder level ('what's running out?').",
      inputSchema: z.object({}),
      execute: async () => wrap(() => inventory.lowStockReport()),
    }),

    startBill: tool({
      description: "Start a brand-new bill, discarding any in-progress draft for this chat.",
      inputSchema: z.object({}),
      execute: async () => wrap(() => billing.startBill(chatId)),
    }),

    addItemToBill: tool({
      description: "Add (or update the quantity of) one item on the CURRENT draft bill. Call once per distinct item.",
      inputSchema: addItemSchema,
      execute: async ({ productQuery, qty }: AddItemArgs) => wrap(() => billing.addItemToBill(chatId, productQuery, qty)),
    }),

    removeItemFromBill: tool({
      description: "Remove an item entirely from the current draft bill.",
      inputSchema: removeItemSchema,
      execute: async ({ productQuery }: RemoveItemArgs) => wrap(() => billing.removeItemFromBill(chatId, productQuery)),
    }),

    viewDraftBill: tool({
      description: "Show the current draft bill's items and running total before finalizing.",
      inputSchema: z.object({}),
      execute: async () => wrap(() => billing.viewDraftBill(chatId)),
    }),

    finalizeBill: tool({
      description:
        "Finalize (close out) the current draft bill: decrements stock, computes final GST totals, records payment mode. This is the ONLY point stock actually decrements.",
      inputSchema: finalizeBillSchema,
      execute: async ({ paymentMode, paymentRef }: FinalizeBillArgs) =>
        wrap(() => billing.finalizeBill(chatId, paymentMode, paymentRef ?? undefined)),
    }),

    addCredit: tool({
      description: "Put an amount on a customer's khata (credit) tab.",
      inputSchema: addCreditSchema,
      execute: async ({ customerName, amount, note }: AddCreditArgs) => wrap(() => khata.addCredit(customerName, amount, note ?? undefined)),
    }),

    recordKhataPayment: tool({
      description: "Record a customer paying down their khata balance.",
      inputSchema: recordKhataPaymentSchema,
      execute: async ({ customerName, amount }: RecordKhataPaymentArgs) => wrap(() => khata.recordPayment(customerName, amount)),
    }),

    getKhataBalance: tool({
      description: "Check a customer's current khata (credit) balance.",
      inputSchema: getKhataBalanceSchema,
      execute: async ({ customerName }: GetKhataBalanceArgs) => wrap(() => khata.getBalance(customerName)),
    }),

    dailyClose: tool({
      description: "Summarize today's (or a given date's) sales: totals, tax collected, payment mode split, top items.",
      inputSchema: dailyCloseSchema,
      execute: async ({ date }: DailyCloseArgs) => wrap(() => reports.dailyClose(date ? new Date(date) : new Date())),
    }),

    reorderSuggestions: tool({
      description:
        "Get restock suggestions based on recent sales velocity, not just a fixed reorder level ('what should I reorder soon?', 'what's about to run out based on how fast it's selling?').",
      inputSchema: z.object({}),
      execute: async () => wrap(() => reports.reorderSuggestions()),
    }),

    getOutstandingKhata: tool({
      description:
        "List all customers who currently owe money on their khata (credit) tab, with balance and days since their last activity ('who owes me money?', 'khata pending list').",
      inputSchema: z.object({}),
      execute: async () => wrap(() => khata.listOutstandingKhata()),
    }),

    generateInvoicePdf: tool({
      description: "Generate and SEND a GST-correct PDF invoice for a finalized bill directly to the owner's chat.",
      inputSchema: generateInvoicePdfSchema,
      execute: async ({ billId }: GenerateInvoicePdfArgs) =>
        wrap(async () => {
          const bill = await db.bill.findUnique({ where: { id: billId }, include: { items: { include: { product: true } } } });
          if (!bill) throw new ToolError("Bill not found.");
          const pdf = await generateInvoicePdf(
            {
              id: bill.id,
              finalizedAt: bill.finalizedAt,
              paymentMode: bill.paymentMode,
              subtotal: Number(bill.subtotal),
              cgst: Number(bill.cgst),
              sgst: Number(bill.sgst),
              total: Number(bill.total),
              items: bill.items.map((i) => ({
                qty: Number(i.qty),
                unitPrice: Number(i.unitPrice),
                gstSlab: Number(i.gstSlab),
                lineSubtotal: Number(i.lineSubtotal),
                lineCgst: Number(i.lineCgst),
                lineSgst: Number(i.lineSgst),
                lineTotal: Number(i.lineTotal),
                product: i.product,
              })),
            },
            SHOP_INFO
          );
          await sendDocument(chatId, pdf, `invoice-${bill.id}.pdf`, "Here's the invoice.");
          return { sent: true };
        }),
    }),

    generateAnalysisDeck: tool({
      description: "Generate and SEND a PPTX sales analysis deck with charts for a date range.",
      inputSchema: generateAnalysisDeckSchema,
      execute: async ({ startDate, endDate, label }: GenerateAnalysisDeckArgs) =>
        wrap(async () => {
          const bills = await reports.salesForRange(new Date(startDate), new Date(endDate));
          const lowStock = await inventory.lowStockReport();
          const deck = await generateAnalysisDeck(
            bills.map((b) => ({
              finalizedAt: b.finalizedAt,
              subtotal: Number(b.subtotal),
              cgst: Number(b.cgst),
              sgst: Number(b.sgst),
              total: Number(b.total),
              items: b.items.map((i) => ({ qty: Number(i.qty), lineTotal: Number(i.lineTotal), product: { name: i.product.name } })),
            })),
            lowStock.map((p) => ({ name: p.name, qty: Number(p.qty), reorderLevel: Number(p.reorderLevel) })),
            label
          );
          await sendDocument(chatId, deck, `analysis-${label.replace(/\s+/g, "-")}.pptx`, "Here's the analysis deck.");
          return { sent: true };
        }),
    }),

    setPreference: tool({
      description:
        "Remember a standing owner preference (default payment mode, preferred brand, shop name/GSTIN) that must persist across chats.",
      inputSchema: setPreferenceSchema,
      execute: async ({ key, value }: SetPreferenceArgs) => wrap(() => setPreference(chatId, key, value)),
    }),
  };
}

const SYSTEM_PROMPT = `You are the ops brain for an Indian kirana (grocery) store, talking to the shop owner over Telegram.

Rules you must follow:
- NEVER invent a product, price, stock quantity, or GST slab. Always call a tool to look it up. If a tool returns an error, relay it plainly — don't work around it.
- If a request is genuinely ambiguous (e.g. "add atta" when multiple atta products exist, or none do), ASK a short clarifying question instead of guessing.
- If the owner names a SPECIFIC product/size/variant (e.g. "Aashirvaad atta 5kg") that does NOT exactly match any existing product, do NOT silently substitute the closest match (e.g. a 1kg pack). Tell them plainly that exact item isn't in stock, name what similar items DO exist, and ask which one they mean. Never assume a different size/variant is "close enough."
- When adding a NEW product via addProduct: packaged/branded items (atta, salt, butter, oil, packets of any FMCG good) should almost always use unit "packet" or "piece" with isLoose: false, and quantity should mean number of packets — not the product's internal weight/volume. Only genuinely loose commodities sold by weight (loose sugar, rice, dal, etc.) should use unit "kg"/"g"/"litre"/"ml" with isLoose: true. If you're not sure which applies, ask rather than guessing.
- Do not state a specific number (GST slab, price, HSN code, etc.) as if it's already decided before the owner has actually given it or a tool has confirmed it. If you don't have a real value yet, ask for it plainly instead of writing a provisional-sounding figure.
- When summarizing a bill's tax in chat, never show a single blended tax percentage (e.g. "12.6%") across multiple GST slabs — show each item's own GST% and CGST/SGST amounts separately, since that's what's legally required on the actual invoice too.
- A bill is built up over multiple messages. Use addItemToBill / removeItemFromBill as items are mentioned, viewDraftBill to show progress, and finalizeBill only when the owner clearly says to close it out (e.g. "make the bill", "that's it", gives a payment mode).
- Stock only decrements at finalizeBill — never before.
- Speak in short, plain, shopkeeper-friendly language. Use ₹ for money. Confirm important actions (finalizing a bill, recording a large credit) briefly.
- When the owner asks for an invoice or analysis deck, call the relevant tool — it sends the file directly, you don't need to describe the file's contents in detail, just confirm it's sent.
`;

async function loadHistory(chatId: string): Promise<ChatMessage[]> {
  const state = await db.conversationState.findUnique({ where: { chatId } });
  if (!state?.history) return [];
  try {
    const parsed = state.history as unknown as ChatMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistory(chatId: string, history: ChatMessage[]) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  await db.conversationState.upsert({
    where: { chatId },
    update: { history: trimmed as unknown as Prisma.InputJsonValue },
    create: { chatId, history: trimmed as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Clears short-term conversation memory only — NOT standing preferences.
 * Wire this to a "/new" command so the demo's "/new chat, preferences
 * still apply" step has something real to show.
 */
export async function resetConversationHistory(chatId: string) {
  await db.conversationState.upsert({
    where: { chatId },
    update: { history: [] as unknown as Prisma.InputJsonValue },
    create: { chatId, history: [] as unknown as Prisma.InputJsonValue },
  });
}

export async function runAgentTurn(chatId: string, userText: string): Promise<string> {
  const prefs = await getPreferences(chatId);
  const prefsBlock =
    Object.keys(prefs).length > 0
      ? `\nStanding preferences for this owner (apply these automatically unless they say otherwise):\n${Object.entries(prefs)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")}`
      : "";

  const history = await loadHistory(chatId);

  const result = await generateText({
    // model: anthropic("claude-sonnet-4-6"),
    // model: groq("llama-3.3-70b-versatile"),
    model: groq("openai/gpt-oss-120b"),
    system: SYSTEM_PROMPT + prefsBlock,
    messages: [...history, { role: "user", content: userText }],
    tools: buildTools(chatId),
    stopWhen: stepCountIs(8),
    // maxSteps: 8, // allows chaining multiple tool calls in one turn (observe -> reason -> act -> repeat)
  });

  const replyText = result.text || "Done.";

  await saveHistory(chatId, [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: replyText },
  ]);

  return replyText;
}