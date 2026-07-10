import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn, resetConversationHistory } from "@/lib/agent";
import { claimUpdateOnce } from "@/lib/idempotency";
import { TelegramUpdate, sendMessage, downloadVoiceFile } from "@/lib/telegram";
import { transcribeVoice } from "@/lib/transcribe";

export const maxDuration = 60; // agent turns with multiple tool calls can take a bit

export async function POST(req: NextRequest) {
  // Verify the request really came from Telegram, not a random POST to
  // our public webhook URL.
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  console.log("Received Telegram webhook request with secret:", secret);
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await req.json();
  console.log("Received Telegram update:", update);
  // Hard part #5 (idempotency): Telegram retries webhook deliveries that
  // don't get a fast 200 OK. We claim the update_id atomically BEFORE
  // doing any work; if it's already claimed, we just ack and stop —
  // no double-processing, no double-reply.
  const isNew = await claimUpdateOnce(update.update_id);
  console.log(`Update ${update.update_id} is new?`, isNew);
  if (!isNew) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const chatId = update.message?.chat.id;
  const voice = update.message?.voice;
  let text = update.message?.text;

  if (!chatId) {
    // Non-message update (e.g. edited message, channel post) — ack and ignore.
    return NextResponse.json({ ok: true });
  }

  if (voice) {
    try {
      const audio = await downloadVoiceFile(voice.file_id);
      text = await transcribeVoice(audio);
      await sendMessage(chatId, `🎙️ Heard: "${text}"`);
    } catch (err) {
      console.error("Voice transcription failed:", err);
      await sendMessage(chatId, "Couldn't understand that voice note — try typing it, or send it again.");
      return NextResponse.json({ ok: true });
    }
  }

  if (!text) {
    await sendMessage(chatId, "I only understand text and voice notes for now — please type or speak your request.");
    return NextResponse.json({ ok: true });
  }

  // Explicit "new chat" signal — clears short-term conversation memory only.
  // Standing preferences (lib/tools/preferences.ts) are untouched, which is
  // exactly what hard-part #9 requires you to demonstrate.
  if (text.trim().toLowerCase() === "/new") {
    await resetConversationHistory(String(chatId));
    await sendMessage(chatId, "Started a new chat. Your standing preferences still apply.");
    return NextResponse.json({ ok: true });
  }

  try {
    const reply = await runAgentTurn(String(chatId), text);
    console.log("Agent turn result:", reply);
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("Agent turn failed:", err);
    await sendMessage(chatId, "Something went wrong handling that — please try again.");
  }

  // Always return 200 fast so Telegram doesn't consider this a failed
  // delivery and retry it (which the idempotency layer would then dedupe
  // anyway, but better not to rely on that as the only line of defense).
  return NextResponse.json({ ok: true });
}

// Telegram calls GET on webhook URLs in some health-check scenarios; make
// it harmless.
export async function GET() {
  return NextResponse.json({ ok: true, service: "supermarket-ops-agent webhook" });
}
