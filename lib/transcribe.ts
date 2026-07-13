import { GROQ_TRANSCRIPTION_URL, GROQ_API_KEY } from "./config";

/**
 * Voice-note orders: transcribes Telegram voice notes to
 * plain text via Groq's Whisper endpoint, then hands the text through the
 * SAME runAgentTurn path as typed messages.
 */
export async function transcribeVoice(audio: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), "voice.ogg");
  form.append("model", "whisper-large-v3-turbo");

  const res = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });

  if (!res.ok) throw new Error(`Transcription failed: ${await res.text()}`);

  const data = await res.json();
  if (!data.text?.trim()) throw new Error("Could not make out any speech in that voice note.");

  return data.text.trim();
}