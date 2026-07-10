const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    voice?: {
      file_id: string;
      duration?: number;
      mime_type?: string
    };
  };
}

export async function sendMessage(chatId: number | string, text: string) {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    console.error("sendMessage failed", await res.text());
  }
  const data = await res.json();
  return data;
}

export async function sendDocument(
  chatId: number | string,
  fileBuffer: Buffer,
  filename: string,
  caption?: string
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  // form.append("document", new Blob([fileBuffer]), filename);
  form.append("document", new Blob([new Uint8Array(fileBuffer)]), filename);

  const res = await fetch(`${API}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) {
    console.error("sendDocument failed", await res.text());
  }
  return res.json();
}

/**
 * Resolves a Telegram file_id to actual bytes. Telegram only sends a
 * file_id in the update — the audio itself needs a separate round trip
 * via getFile -> the file server.
 */
export async function downloadVoiceFile(fileId: string): Promise<Buffer> {
  const metaRes = await fetch(`${API}/getFile?file_id=${fileId}`);
  const meta = await metaRes.json();
  if (!meta.ok) throw new Error(`getFile failed: ${JSON.stringify(meta)}`);

  const fileRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error("Failed to download voice file from Telegram.");

  return Buffer.from(await fileRes.arrayBuffer());
}