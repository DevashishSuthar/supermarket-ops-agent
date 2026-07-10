import { NextRequest, NextResponse } from "next/server";
import { listOutstandingKhata } from "@/lib/tools/khata";
import { sendMessage } from "@/lib/telegram";

export const maxDuration = 30;

/**
 * Stretch goal: "Khata payment reminders."
 *
 * Weekly nudge to the OWNER (not the customers — the bot has no channel to
 * reach customers directly) listing who still owes money, so the owner
 * knows who to follow up with. Same CRON_SECRET auth pattern as
 * weekly-deck.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ownerChatId = process.env.OWNER_CHAT_ID;
  if (!ownerChatId) {
    console.error("khata-reminders cron: OWNER_CHAT_ID not configured");
    return NextResponse.json({ error: "OWNER_CHAT_ID not configured" }, { status: 500 });
  }

  try {
    const outstanding = await listOutstandingKhata();

    if (outstanding.length === 0) {
      await sendMessage(ownerChatId, "Khata check: no outstanding balances this week. 🎉");
      return NextResponse.json({ ok: true, sent: true, outstandingCount: 0 });
    }

    const lines = outstanding.map(
      (c) => `• ${c.name}: ₹${c.balance.toFixed(2)} (${c.daysSinceActivity} days since last activity)`
    );
    const totalOwed = outstanding.reduce((s, c) => s + c.balance, 0);

    const message = [
      `*Weekly Khata Reminder*`,
      `Total outstanding: ₹${totalOwed.toFixed(2)} across ${outstanding.length} customer(s).`,
      "",
      ...lines,
    ].join("\n");

    await sendMessage(ownerChatId, message);
    return NextResponse.json({ ok: true, sent: true, outstandingCount: outstanding.length });
  } catch (err) {
    console.error("khata-reminders cron failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
