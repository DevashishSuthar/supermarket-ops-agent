import { db } from "../db";

/**
 * Hard part #9: memory across sessions. This is deliberately just a
 * plain key-value table, NOT anything stored in the conversation. Every
 * time the agent handles a message (see lib/agent.ts), we load all
 * Preference rows for this chatId and inject them into the system
 * prompt as plain facts. Starting a `/new chat` in Telegram doesn't
 * touch this table at all, so preferences survive it by construction.
 */

export async function setPreference(chatId: string, key: string, value: string) {
  return db.preference.upsert({
    where: { chatId_key: { chatId, key } },
    update: { value },
    create: { chatId, key, value },
  });
}

export async function getPreferences(chatId: string): Promise<Record<string, string>> {
  const rows = await db.preference.findMany({ where: { chatId } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
