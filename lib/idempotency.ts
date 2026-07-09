import { db } from "./db";

/**
 * Hard part #5: Telegram redelivers updates (retries on timeout, network
 * blips, etc). We must not process the same update_id twice.
 *
 * Strategy: try to INSERT the update_id first. Postgres's unique
 * constraint does the deduplication atomically — no read-then-write race.
 * If the insert fails with a unique violation, this update was already
 * handled (or is being handled right now) and we simply skip it.
 */
export async function claimUpdateOnce(updateId: string | number): Promise<boolean> {
  try {
    await db.processedUpdate.create({ data: { updateId: String(updateId) } });
    return true; // first time seeing this update — go ahead and process it
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Unique constraint violation => duplicate delivery, already processed
      return false;
    }
    throw err;
  }
}
