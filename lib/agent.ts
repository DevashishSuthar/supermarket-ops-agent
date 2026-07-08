import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";

import { getPreferences, setPreference } from "./tools/preferences";
import * as inventory from "./tools/inventory";
import * as billing from "./tools/billing";
import * as khata from "./tools/khata";
import * as reports from "./tools/reports";
// import { generateInvoicePdf } from "./documents/invoice";
import { generateAnalysisDeck } from "./documents/deck";
import { sendDocument } from "./telegram";
import { db } from "./db";
import { ToolError } from "./tools/inventory";

const SHOP_INFO = {
  name: process.env.SHOP_NAME ?? "My Kirana Store",
  gstin: process.env.SHOP_GSTIN,
  address: process.env.SHOP_ADDRESS,
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
      inputSchema: z.object({ query: z.string().describe("product name or SKU as the owner typed it") }),
      execute: async ({ query }) => wrap(() => inventory.checkStock(query)),
    }),

    addProduct: tool({
      description: "Register a brand-new product/SKU that doesn't exist yet.",
      inputSchema: z.object({
        sku: z.string(),
        name: z.string(),
        unit: z.enum(["kg", "g", "litre", "ml", "packet", "dozen", "piece"]),
        isLoose: z.boolean().optional(),
        costPrice: z.number(),
        mrp: z.number(),
        hsn: z.string().describe("HSN code for this product"),
        gstSlab: z.number().describe("GST % slab: 0, 5, 12, or 18"),
        initialQty: z.number().optional(),
        reorderLevel: z.number().optional(),
      }),
      execute: async (input) => wrap(() => inventory.addProduct(input)),
    }),

    receiveStock: tool({
      description: "Record incoming stock for an EXISTING product (e.g. '50 packets of Maggi came in, cost 12').",
      inputSchema: z.object({
        productQuery: z.string(),
        qty: z.number(),
        costPrice: z.number().optional(),
        mrp: z.number().optional(),
      }),
      execute: async (input) => wrap(() => inventory.receiveStock(input)),
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
      inputSchema: z.object({ productQuery: z.string(), qty: z.number() }),
      execute: async ({ productQuery, qty }) => wrap(() => billing.addItemToBill(chatId, productQuery, qty)),
    }),

    removeItemFromBill: tool({
      description: "Remove an item entirely from the current draft bill.",
      inputSchema: z.object({ productQuery: z.string() }),
      execute: async ({ productQuery }) => wrap(() => billing.removeItemFromBill(chatId, productQuery)),
    }),

    viewDraftBill: tool({
      description: "Show the current draft bill's items and running total before finalizing.",
      inputSchema: z.object({}),
      execute: async () => wrap(() => billing.viewDraftBill(chatId)),
    }),

    finalizeBill: tool({
      description:
        "Finalize (close out) the current draft bill: decrements stock, computes final GST totals, records payment mode. This is the ONLY point stock actually decrements.",
      inputSchema: z.object({
        paymentMode: z.enum(["CASH", "UPI", "CARD"]),
        paymentRef: z.string().optional().describe("UPI ref / card auth code if given"),
      }),
      execute: async ({ paymentMode, paymentRef }) =>
        wrap(() => billing.finalizeBill(chatId, paymentMode, paymentRef)),
    }),

    addCredit: tool({
      description: "Put an amount on a customer's khata (credit) tab.",
      inputSchema: z.object({ customerName: z.string(), amount: z.number(), note: z.string().optional() }),
      execute: async ({ customerName, amount, note }) => wrap(() => khata.addCredit(customerName, amount, note)),
    }),

    recordKhataPayment: tool({
      description: "Record a customer paying down their khata balance.",
      inputSchema: z.object({ customerName: z.string(), amount: z.number() }),
      execute: async ({ customerName, amount }) => wrap(() => khata.recordPayment(customerName, amount)),
    }),

    getKhataBalance: tool({
      description: "Check a customer's current khata (credit) balance.",
      inputSchema: z.object({ customerName: z.string() }),
      execute: async ({ customerName }) => wrap(() => khata.getBalance(customerName)),
    }),

    dailyClose: tool({
      description: "Summarize today's (or a given date's) sales: totals, tax collected, payment mode split, top items.",
      inputSchema: z.object({ date: z.string().optional().describe("ISO date, defaults to today") }),
      execute: async ({ date }) => wrap(() => reports.dailyClose(date ? new Date(date) : new Date())),
    }),

    generateInvoicePdf: tool({
      description: "Generate and SEND a GST-correct PDF invoice for a finalized bill directly to the owner's chat.",
      inputSchema: z.object({ billId: z.string() }),
      execute: async ({ billId }) =>
        wrap(async () => {
          const bill = await db.bill.findUnique({ where: { id: billId }, include: { items: { include: { product: true } } } });
          if (!bill) throw new ToolError("Bill not found.");
          // const pdf = await generateInvoicePdf(
          //   {
          //     id: bill.id,
          //     finalizedAt: bill.finalizedAt,
          //     paymentMode: bill.paymentMode,
          //     subtotal: Number(bill.subtotal),
          //     cgst: Number(bill.cgst),
          //     sgst: Number(bill.sgst),
          //     total: Number(bill.total),
          //     items: bill.items.map((i) => ({
          //       qty: Number(i.qty),
          //       unitPrice: Number(i.unitPrice),
          //       gstSlab: Number(i.gstSlab),
          //       lineSubtotal: Number(i.lineSubtotal),
          //       lineCgst: Number(i.lineCgst),
          //       lineSgst: Number(i.lineSgst),
          //       lineTotal: Number(i.lineTotal),
          //       product: i.product,
          //     })),
          //   },
          //   SHOP_INFO
          // );
          // await sendDocument(chatId, pdf, `invoice-${bill.id}.pdf`, "Here's the invoice.");
          return { sent: true };
        }),
    }),

    generateAnalysisDeck: tool({
      description: "Generate and SEND a PPTX sales analysis deck with charts for a date range.",
      inputSchema: z.object({
        startDate: z.string().describe("ISO date, start of range"),
        endDate: z.string().describe("ISO date, end of range"),
        label: z.string().describe("human label like 'This Week'"),
      }),
      execute: async ({ startDate, endDate, label }) =>
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
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      execute: async ({ key, value }) => wrap(() => setPreference(chatId, key, value)),
    }),
  };
}

const SYSTEM_PROMPT = `You are the ops brain for an Indian kirana (grocery) store, talking to the shop owner over Telegram.

Rules you must follow:
- NEVER invent a product, price, stock quantity, or GST slab. Always call a tool to look it up. If a tool returns an error, relay it plainly — don't work around it.
- If a request is genuinely ambiguous (e.g. "add atta" when multiple atta products exist, or none do), ASK a short clarifying question instead of guessing.
- A bill is built up over multiple messages. Use addItemToBill / removeItemFromBill as items are mentioned, viewDraftBill to show progress, and finalizeBill only when the owner clearly says to close it out (e.g. "make the bill", "that's it", gives a payment mode).
- Stock only decrements at finalizeBill — never before.
- Speak in short, plain, shopkeeper-friendly language. Use ₹ for money. Confirm important actions (finalizing a bill, recording a large credit) briefly.
- When the owner asks for an invoice or analysis deck, call the relevant tool — it sends the file directly, you don't need to describe the file's contents in detail, just confirm it's sent.
`;

export async function runAgentTurn(chatId: string, userText: string): Promise<string> {
  const prefs = await getPreferences(chatId);
  const prefsBlock =
    Object.keys(prefs).length > 0
      ? `\nStanding preferences for this owner (apply these automatically unless they say otherwise):\n${Object.entries(prefs)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")}`
      : "";

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: SYSTEM_PROMPT + prefsBlock,
    prompt: userText,
    tools: buildTools(chatId),
    stopWhen: stepCountIs(8),
    // maxSteps: 8, // allows chaining multiple tool calls in one turn (observe -> reason -> act -> repeat)
  });

  return result.text || "Done.";
}
