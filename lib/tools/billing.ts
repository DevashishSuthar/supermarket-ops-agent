import { db } from "../db";
import { calcLine, summarizeBill } from "../gst";
import { decrementStockForSaleTx, getProductByNameOrSku } from "./inventory";
import { ToolError } from "./inventory";

/**
 * Hard part #4: a bill builds over several messages ("add sugar", "drop
 * the butter", "make it 6 Maggi") and only touches stock on finalize.
 * We track "the current draft bill for this chat" in ConversationState
 * so the model doesn't have to carry bill state in its own context —
 * every tool call looks it up fresh from the DB.
 */

async function getOrCreateDraftBill(chatId: string) {
  const state = await db.conversationState.upsert({
    where: { chatId },
    update: {},
    create: { chatId },
  });

  if (state.draftBillId) {
    const bill = await db.bill.findUnique({ where: { id: state.draftBillId } });
    if (bill && bill.status === "DRAFT") return bill;
  }

  const bill = await db.bill.create({ data: { chatId, status: "DRAFT" } });
  await db.conversationState.update({ where: { chatId }, data: { draftBillId: bill.id } });
  return bill;
}

export async function startBill(chatId: string) {
  // Force a fresh draft even if one exists (owner explicitly starting over)
  const bill = await db.bill.create({ data: { chatId, status: "DRAFT" } });
  await db.conversationState.upsert({
    where: { chatId },
    update: { draftBillId: bill.id },
    create: { chatId, draftBillId: bill.id },
  });
  return bill;
}

export async function addItemToBill(chatId: string, productQuery: string, qty: number) {
  if (qty <= 0) throw new ToolError("Quantity must be positive.");
  const bill = await getOrCreateDraftBill(chatId);
  const product = await getProductByNameOrSku(productQuery);
  if (!product) {
    throw new ToolError(
      `No product matching "${productQuery}". Ask the owner to clarify which exact product they mean, or add it as a new product first.`
    );
  }

  // Note: we do NOT touch Product.qty here — that only happens at finalize.
  // We do a soft availability check so the owner gets early feedback, but
  // it's re-checked (with a lock) again at finalize since stock can change
  // in between messages.
  if (Number(product.qty) < qty) {
    throw new ToolError(
      `Only ${Number(product.qty)} ${product.unit} of ${product.name} in stock right now — can't add ${qty} to the bill.`
    );
  }

  const line = calcLine(qty, Number(product.mrp), Number(product.gstSlab));

  const existingItem = await db.billItem.findFirst({ where: { billId: bill.id, productId: product.id } });
  if (existingItem) {
    await db.billItem.update({
      where: { id: existingItem.id },
      data: {
        qty: line.qty,
        lineSubtotal: line.lineSubtotal,
        lineCgst: line.lineCgst,
        lineSgst: line.lineSgst,
        lineTotal: line.lineTotal,
      },
    });
  } else {
    await db.billItem.create({
      data: {
        billId: bill.id,
        productId: product.id,
        qty: line.qty,
        unitPrice: line.unitPrice,
        gstSlab: line.gstSlab,
        lineSubtotal: line.lineSubtotal,
        lineCgst: line.lineCgst,
        lineSgst: line.lineSgst,
        lineTotal: line.lineTotal,
      },
    });
  }

  return recalcAndReturnDraft(bill.id);
}

export async function removeItemFromBill(chatId: string, productQuery: string) {
  const bill = await getOrCreateDraftBill(chatId);
  const product = await getProductByNameOrSku(productQuery);
  if (!product) throw new ToolError(`No product matching "${productQuery}".`);
  await db.billItem.deleteMany({ where: { billId: bill.id, productId: product.id } });
  return recalcAndReturnDraft(bill.id);
}

async function recalcAndReturnDraft(billId: string) {
  const items = await db.billItem.findMany({ where: { billId }, include: { product: true } });
  const summary = summarizeBill(
    items.map((i) => ({
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      gstSlab: Number(i.gstSlab),
      lineSubtotal: Number(i.lineSubtotal),
      lineCgst: Number(i.lineCgst),
      lineSgst: Number(i.lineSgst),
      lineTotal: Number(i.lineTotal),
    }))
  );
  await db.bill.update({ where: { id: billId }, data: summary });
  return { billId, items, ...summary };
}

export async function viewDraftBill(chatId: string) {
  const bill = await getOrCreateDraftBill(chatId);
  return recalcAndReturnDraft(bill.id);
}

/**
 * Hard part #4 (decrement only on finalize) + #5 (idempotency) + #6
 * (concurrency), all together. `idempotencyKey` should be a stable value
 * derived from the Telegram update (see webhook route) so a retried
 * "finalize" tool call — whether from Telegram redelivery or the model
 * re-invoking the tool — cannot double-bill or double-decrement.
 */
export async function finalizeBill(
  chatId: string,
  paymentMode: "CASH" | "UPI" | "CARD",
  paymentRef?: string,
  customerNameForCredit?: string
) {
  const bill = await getOrCreateDraftBill(chatId);

  return db.$transaction(async (tx) => {
    // Re-read bill status INSIDE the transaction with a lock. If it's
    // already FINALIZED, this is a retry — return the existing result
    // instead of processing again.
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM "Bill" WHERE id = ${bill.id} FOR UPDATE
    `;
    if (rows.length === 0) throw new ToolError("Bill not found.");
    if (rows[0].status === "FINALIZED") {
      const existing = await tx.bill.findUnique({ where: { id: bill.id }, include: { items: true } });
      return { alreadyFinalized: true, bill: existing };
    }

    const items = await tx.billItem.findMany({ where: { billId: bill.id }, include: { product: true } });
    if (items.length === 0) throw new ToolError("Can't finalize an empty bill.");

    // Guardrail: never sell below cost (hard-part #7)
    for (const item of items) {
      if (Number(item.unitPrice) < Number(item.product.costPrice)) {
        throw new ToolError(
          `Refusing to finalize: ${item.product.name} is priced below cost (₹${item.unitPrice} < ₹${item.product.costPrice}).`
        );
      }
    }

    // Oversell guard re-checked here, atomically, per line item.
    for (const item of items) {
      await decrementStockForSaleTx(tx, item.productId, Number(item.qty));
    }

    const summary = summarizeBill(
      items.map((i) => ({
        qty: Number(i.qty),
        unitPrice: Number(i.unitPrice),
        gstSlab: Number(i.gstSlab),
        lineSubtotal: Number(i.lineSubtotal),
        lineCgst: Number(i.lineCgst),
        lineSgst: Number(i.lineSgst),
        lineTotal: Number(i.lineTotal),
      }))
    );

    let customerId: string | undefined;
    if (paymentMode === "CREDIT" as any && customerNameForCredit) {
      // (khata sales handled via the dedicated addCredit tool instead;
      // kept here only if you choose to fold "bill on credit" into finalize)
    }

    const updated = await tx.bill.update({
      where: { id: bill.id },
      data: {
        status: "FINALIZED",
        paymentMode,
        paymentRef,
        finalizedAt: new Date(),
        customerId,
        ...summary,
      },
      include: { items: { include: { product: true } } },
    });

    // Clear the draft pointer so the next message starts a fresh bill
    await tx.conversationState.update({ where: { chatId }, data: { draftBillId: null } });

    return { alreadyFinalized: false, bill: updated };
  });
}
