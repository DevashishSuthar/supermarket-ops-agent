const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    voice?: unknown;
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
