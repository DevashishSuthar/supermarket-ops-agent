// import { anthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";

import { db } from "../db";
import { generateInvoicePdf } from "../documents/invoice";
import { generateAnalysisDeck } from "../documents/deck";
import * as billing from "../tools/billing";
import * as khata from "../tools/khata";
import * as reports from "../tools/reports";
import * as inventory from "../tools/inventory";
import { ToolError } from "../tools/inventory";
import { getPreferences, setPreference } from "../tools/preferences";
import { sendDocument } from "../telegram";
import { parseHexColor } from "../utils";
import { SYSTEM_PROMPT } from "./prompt";
import { loadHistory, saveHistory } from "./history";
import * as schema from "./schema";

const SHOP_INFO = {
  name: process.env.SHOP_NAME ?? "My Kirana Store",
  gstin: process.env.SHOP_GSTIN,
  address: process.env.SHOP_ADDRESS,
  // Stretch goal: "branded invoices" — optional hex like "#1a5276" in env,
  // converted to the 0-1 RGB triple pdf-lib expects. Falls back to
  // invoice.ts's own default teal if unset or malformed.
  brandColor: parseHexColor(process.env.SHOP_BRAND_COLOR),
};

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
      inputSchema: schema.getProductSchema,
      execute: async ({ query }: schema.GetProductArgs) => wrap(() => inventory.checkStock(query)),
    }),

    addProduct: tool({
      description: "Register a brand-new product/SKU that doesn't exist yet.",
      inputSchema: schema.addProductSchema,
      // addProductSchema uses .nullish() on isLoose/initialQty/reorderLevel so the
      // model can explicitly pass `null`, but inventory.addProduct's parameter type
      // only allows `undefined` for these optional fields (no `null`). Normalize
      // null -> undefined here at the boundary rather than loosening the schema or
      // inventory's type, since `null` from the LLM never carries distinct meaning
      // from "not provided" for these fields.
      execute: async (input: schema.AddProductArgs) =>
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
      inputSchema: schema.receiveStockSchema,
      // Same null -> undefined normalization as addProduct: receiveStockSchema's
      // .nullish() fields allow the model to send explicit null, but
      // inventory.receiveStock's parameter type only allows undefined here.
      execute: async (input: schema.ReceiveStockArgs) =>
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
      inputSchema: schema.addItemSchema,
      execute: async ({ productQuery, qty }: schema.AddItemArgs) => wrap(() => billing.addItemToBill(chatId, productQuery, qty)),
    }),

    removeItemFromBill: tool({
      description: "Remove an item entirely from the current draft bill.",
      inputSchema: schema.removeItemSchema,
      execute: async ({ productQuery }: schema.RemoveItemArgs) => wrap(() => billing.removeItemFromBill(chatId, productQuery)),
    }),

    viewDraftBill: tool({
      description: "Show the current draft bill's items and running total before finalizing.",
      inputSchema: z.object({}),
      execute: async () => wrap(() => billing.viewDraftBill(chatId)),
    }),

    finalizeBill: tool({
      description:
        "Finalize (close out) the current draft bill: decrements stock, computes final GST totals, records payment mode. This is the ONLY point stock actually decrements.",
      inputSchema: schema.finalizeBillSchema,
      execute: async ({ paymentMode, paymentRef }: schema.FinalizeBillArgs) =>
        wrap(() => billing.finalizeBill(chatId, paymentMode, paymentRef ?? undefined)),
    }),

    addCredit: tool({
      description: "Put an amount on a customer's khata (credit) tab.",
      inputSchema: schema.addCreditSchema,
      execute: async ({ customerName, amount, note }: schema.AddCreditArgs) => wrap(() => khata.addCredit(customerName, amount, note ?? undefined)),
    }),

    recordKhataPayment: tool({
      description: "Record a customer paying down their khata balance.",
      inputSchema: schema.recordKhataPaymentSchema,
      execute: async ({ customerName, amount }: schema.RecordKhataPaymentArgs) => wrap(() => khata.recordPayment(customerName, amount)),
    }),

    getKhataBalance: tool({
      description: "Check a customer's current khata (credit) balance.",
      inputSchema: schema.getKhataBalanceSchema,
      execute: async ({ customerName }: schema.GetKhataBalanceArgs) => wrap(() => khata.getBalance(customerName)),
    }),

    dailyClose: tool({
      description: "Summarize today's (or a given date's) sales: totals, tax collected, payment mode split, top items.",
      inputSchema: schema.dailyCloseSchema,
      execute: async ({ date }: schema.DailyCloseArgs) => wrap(() => reports.dailyClose(date ? new Date(date) : new Date())),
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
      inputSchema: schema.generateInvoicePdfSchema,
      execute: async ({ billId }: schema.GenerateInvoicePdfArgs) =>
        wrap(async () => {
          const bill = await db.bill.findUnique({ where: { id: billId }, include: { items: { include: { product: true } } } });
          if (!bill) throw new ToolError("Bill not found.");
          // Shop identity preferences (if the owner has ever corrected them
          // from chat) override the env defaults, so a stored GSTIN/name
          // actually shows up on the invoice instead of silently doing nothing.
          const prefs = await getPreferences(chatId);
          const effectiveShopInfo = {
            ...SHOP_INFO,
            name: prefs.shopName ?? SHOP_INFO.name,
            gstin: prefs.shopGstin ?? SHOP_INFO.gstin,
            address: prefs.shopAddress ?? SHOP_INFO.address,
          };

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
            effectiveShopInfo
          );
          await sendDocument(chatId, pdf, `invoice-${bill.id}.pdf`, "Here's the invoice.");
          return { sent: true };
        }),
    }),

    generateAnalysisDeck: tool({
      description: "Generate and SEND a PPTX sales analysis deck with charts for a date range.",
      inputSchema: schema.generateAnalysisDeckSchema,
      execute: async ({ startDate, endDate, label }: schema.GenerateAnalysisDeckArgs) =>
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
      inputSchema: schema.setPreferenceSchema,
      execute: async ({ key, value }: schema.SetPreferenceArgs) => wrap(() => setPreference(chatId, key, value)),
    }),
  };
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