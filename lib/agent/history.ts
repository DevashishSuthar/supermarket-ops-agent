import { Prisma } from "@prisma/client";
import { db } from "../db";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY_MESSAGES = 20; // ~10 turns — enough context, bounded token cost

export async function loadHistory(chatId: string): Promise<ChatMessage[]> {
  const state = await db.conversationState.findUnique({ where: { chatId } });
  if (!state?.history) return [];
  try {
    const parsed = state.history as unknown as ChatMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveHistory(chatId: string, history: ChatMessage[]) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  await db.conversationState.upsert({
    where: { chatId },
    update: { history: trimmed as unknown as Prisma.InputJsonValue },
    create: { chatId, history: trimmed as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Clears short-term conversation memory only — NOT standing preferences.
 * Wire this to a "/new" command so the demo's "/new chat, preferences
 * still apply" step has something real to show.
 */
export async function resetConversationHistory(chatId: string) {
  await db.conversationState.upsert({
    where: { chatId },
    update: { history: [] as unknown as Prisma.InputJsonValue },
    create: { chatId, history: [] as unknown as Prisma.InputJsonValue },
  });
}