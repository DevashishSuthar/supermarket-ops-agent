import { NextRequest, NextResponse } from "next/server";
import * as reports from "@/lib/tools/reports";
import * as inventory from "@/lib/tools/inventory";
import { generateAnalysisDeck } from "@/lib/documents/deck";
import { sendDocument, sendMessage } from "@/lib/telegram";

export const maxDuration = 60;

/**
 * Goal: "Scheduled weekly analysis deck, auto-sent."
 *
 * Triggered by Vercel Cron (see vercel.json) once a week. Vercel
 * automatically sends `Authorization: Bearer <CRON_SECRET>` on requests it
 * fires when CRON_SECRET is set in the project's env vars — we verify that
 * here so this route can't be triggered by a random public GET.
 *
 * Sends the deck to OWNER_CHAT_ID — the single shop owner's Telegram chat
 * id. This bot is modeled as one owner per deployment (per the brief: "the
 * owner operates the whole shop"), so a single configured chat id is
 * sufficient; multi-owner support would mean storing subscriber chat ids
 * instead.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ownerChatId = process.env.OWNER_CHAT_ID;
  if (!ownerChatId) {
    console.error("weekly-deck cron: OWNER_CHAT_ID not configured");
    return NextResponse.json({ error: "OWNER_CHAT_ID not configured" }, { status: 500 });
  }

  try {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 7);

    const bills = await reports.salesForRange(startDate, endDate);
    const lowStock = await inventory.lowStockReport();

    const label = `Week of ${startDate.toLocaleDateString("en-IN")} - ${endDate.toLocaleDateString("en-IN")}`;

    const deck = await generateAnalysisDeck(
      bills.map((b) => ({
        finalizedAt: b.finalizedAt,
        subtotal: Number(b.subtotal),
        cgst: Number(b.cgst),
        sgst: Number(b.sgst),
        total: Number(b.total),
        items: b.items.map((i) => ({
          qty: Number(i.qty),
          lineTotal: Number(i.lineTotal),
          product: { name: i.product.name },
        })),
      })),
      lowStock.map((p) => ({ name: p.name, qty: Number(p.qty), reorderLevel: Number(p.reorderLevel) })),
      label
    );

    if (bills.length === 0) {
      await sendMessage(ownerChatId, `Weekly analysis (${label}): no finalized bills this week — skipping the deck.`);
      return NextResponse.json({ ok: true, sent: false, reason: "no_bills" });
    }

    await sendDocument(ownerChatId, deck, `weekly-analysis-${startDate.toISOString().slice(0, 10)}.pptx`, `Here's your weekly analysis deck (${label}).`);
    return NextResponse.json({ ok: true, sent: true, billCount: bills.length });
  } catch (err) {
    console.error("weekly-deck cron failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
