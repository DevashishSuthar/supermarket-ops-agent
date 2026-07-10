const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

/**
 * Telegram's API occasionally times out on connect (ConnectTimeoutError)
 * from serverless regions — a transient network blip, not an application
 * error. A single un-retried fetch turns that blip into a lost reply to
 * the owner. Retries with a short exponential backoff (500ms, 1s) before
 * giving up and letting the caller's own error handling take over.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

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
  const res = await fetchWithRetry(`${API}/sendMessage`, {
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

  const res = await fetchWithRetry(`${API}/sendDocument`, { method: "POST", body: form });
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
  const metaRes = await fetchWithRetry(`${API}/getFile?file_id=${fileId}`, {});
  const meta = await metaRes.json();
  if (!meta.ok) throw new Error(`getFile failed: ${JSON.stringify(meta)}`);

  const fileRes = await fetchWithRetry(`https://api.telegram.org/file/bot${TOKEN}/${meta.result.file_path}`, {});
  if (!fileRes.ok) throw new Error("Failed to download voice file from Telegram.");

  return Buffer.from(await fileRes.arrayBuffer());
}