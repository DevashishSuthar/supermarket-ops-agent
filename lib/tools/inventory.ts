import { db } from "../db";
import { Prisma } from "@prisma/client";

export class ToolError extends Error {}

export async function getProductByNameOrSku(query: string) {
  const product = await db.product.findFirst({
    where: {
      OR: [
        { sku: { equals: query, mode: "insensitive" } },
        { name: { contains: query, mode: "insensitive" } },
      ],
    },
  });
  return product;
}

export async function addProduct(input: {
  sku: string;
  name: string;
  unit: string;
  isLoose?: boolean;
  costPrice: number;
  mrp: number;
  hsn: string;
  gstSlab: number;
  initialQty?: number;
  reorderLevel?: number;
}) {
  const existing = await db.product.findUnique({ where: { sku: input.sku } });
  if (existing) {
    throw new ToolError(`Product with SKU "${input.sku}" already exists. Use receiveStock to add quantity instead.`);
  }
  return db.product.create({
    data: {
      sku: input.sku,
      name: input.name,
      unit: input.unit,
      isLoose: input.isLoose ?? false,
      costPrice: input.costPrice,
      mrp: input.mrp,
      hsn: input.hsn,
      gstSlab: input.gstSlab,
      qty: input.initialQty ?? 0,
      reorderLevel: input.reorderLevel ?? 0,
    },
  });
}

/**
 * Receiving stock also needs the row lock: a stock-in and a sale on the
 * SAME product happening at once must not corrupt the qty. This is
 * hard-part #6 (concurrency).
 */
export async function receiveStock(input: { productQuery: string; qty: number; costPrice?: number; mrp?: number }) {
  if (input.qty <= 0) throw new ToolError("Quantity received must be positive.");

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Product"
      WHERE sku ILIKE ${input.productQuery} OR name ILIKE ${'%' + input.productQuery + '%'}
      LIMIT 1
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new ToolError(`No product matching "${input.productQuery}". Add it first with addProduct.`);
    }
    const productId = rows[0].id;

    const updated = await tx.product.update({
      where: { id: productId },
      data: {
        qty: { increment: input.qty },
        ...(input.costPrice ? { costPrice: input.costPrice } : {}),
        ...(input.mrp ? { mrp: input.mrp } : {}),
      },
    });

    await tx.stockIn.create({
      data: {
        productId,
        qty: input.qty,
        costPrice: input.costPrice ?? updated.costPrice,
      },
    });

    return updated;
  });
}

export async function checkStock(productQuery: string) {
  const product = await getProductByNameOrSku(productQuery);
  if (!product) throw new ToolError(`No product matching "${productQuery}".`);
  return product;
}

export async function lowStockReport() {
  const products = await db.product.findMany();
  return products.filter((p) => Number(p.qty) <= Number(p.reorderLevel));
}

/**
 * Hard part #2 (oversell guard) + hard part #6 (concurrency), combined.
 * The check-and-decrement happens inside one transaction, using a
 * `FOR UPDATE` row lock, so two simultaneous bills against the same
 * product can never both pass the stock check on stale data — the
 * second transaction blocks until the first commits, then re-reads the
 * now-updated qty and is correctly refused if stock is gone.
 *
 * This function is called at BILL FINALIZE time, not at add-item time,
 * per hard-part #4 (stock only decrements on finalize).
 */
export async function decrementStockForSaleTx(
  tx: Prisma.TransactionClient,
  productId: string,
  qty: number
) {
  const rows = await tx.$queryRaw<{ id: string; qty: Prisma.Decimal }[]>`
    SELECT id, qty FROM "Product" WHERE id = ${productId} FOR UPDATE
  `;
  if (rows.length === 0) throw new ToolError("Product no longer exists.");
  const available = Number(rows[0].qty);
  if (available < qty) {
    throw new ToolError(
      `Oversell blocked: only ${available} available but ${qty} requested. Refusing to let stock go negative.`
    );
  }
  await tx.product.update({ where: { id: productId }, data: { qty: { decrement: qty } } });
}
