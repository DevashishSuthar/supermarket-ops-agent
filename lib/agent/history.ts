import type { ModelMessage } from "ai";
import { Prisma } from "@prisma/client";
import { db } from "../db";

const MAX_HISTORY_MESSAGES = 40;

export async function loadHistory(chatId: string): Promise<ModelMessage[]> {
  const state = await db.conversationState.findUnique({ where: { chatId } });
  if (!state?.history) return [];
  try {
    const parsed = state.history as unknown as ModelMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Trims to the most recent complete turns, never cutting in the middle of
 * a turn. A raw `slice(-N)` on a message list that contains tool-call /
 * tool-result pairs can easily lop off a tool result while keeping its
 * tool call (or vice versa) — most providers reject that as malformed
 * history on the next request. Cutting only right before a "user" message
 * guarantees every tool-call/tool-result pair stays intact together.
 */
function trimToTurnBoundary(history: ModelMessage[], maxMessages: number): ModelMessage[] {
  if (history.length <= maxMessages) return history;

  const userIndices: number[] = [];
  history.forEach((m, i) => {
    if (m.role === "user") userIndices.push(i);
  });

  for (const idx of userIndices) {
    if (history.length - idx <= maxMessages) return history.slice(idx);
  }

  // Every individual turn is bigger than the budget (e.g. a huge multi-item
  // bill) — keep at least the single most recent turn rather than an empty
  // or truncated one.
  return userIndices.length > 0 ? history.slice(userIndices[userIndices.length - 1]) : history;
}

export async function saveHistory(chatId: string, history: ModelMessage[]) {
  const trimmed = trimToTurnBoundary(history, MAX_HISTORY_MESSAGES);
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