import { db } from "../db";

export async function dailyClose(date: Date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const bills = await db.bill.findMany({
    where: { status: "FINALIZED", finalizedAt: { gte: start, lte: end } },
    include: { items: { include: { product: true } } },
  });

  const totals = bills.reduce(
    (acc, b) => {
      acc.subtotal += Number(b.subtotal);
      acc.tax += Number(b.cgst) + Number(b.sgst);
      acc.total += Number(b.total);
      const mode = b.paymentMode ?? "UNKNOWN";
      acc.byMode[mode] = (acc.byMode[mode] ?? 0) + Number(b.total);
      return acc;
    },
    { subtotal: 0, tax: 0, total: 0, byMode: {} as Record<string, number> }
  );

  const itemTotals = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const bill of bills) {
    for (const item of bill.items) {
      const key = item.productId;
      const entry = itemTotals.get(key) ?? { name: item.product.name, qty: 0, revenue: 0 };
      entry.qty += Number(item.qty);
      entry.revenue += Number(item.lineTotal);
      itemTotals.set(key, entry);
    }
  }
  const topItems = Array.from(itemTotals.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return { date: start, billCount: bills.length, ...totals, topItems, bills };
}

export async function salesForRange(startDate: Date, endDate: Date) {
  return db.bill.findMany({
    where: { status: "FINALIZED", finalizedAt: { gte: startDate, lte: endDate } },
    include: { items: { include: { product: true } } },
    orderBy: { finalizedAt: "asc" },
  });
}

/**
 * Goal: "Reorder suggestions from sales velocity."
 *
 * For every product, looks at how much sold in the trailing `windowDays`
 * (default 14) to derive an average units-sold-per-day figure, then
 * estimates how many days of stock remain at that rate. Anything already
 * at/below its reorder level, or projected to run out within
 * `leadTimeDays` (default 3 — a realistic kirana restock lead time), is
 * flagged with a suggested reorder quantity (enough to cover `coverDays`,
 * default 7, of sales).
 *
 * This is intentionally a simple moving-average model, not a forecasting
 * library — it's meant to give the owner a "restock these soon" nudge from
 * real sales data instead of a fixed reorder threshold alone.
 */
export async function reorderSuggestions(windowDays = 14, leadTimeDays = 3, coverDays = 7) {
  const since = new Date();
  since.setDate(since.getDate() - windowDays);

  const products = await db.product.findMany();

  const soldQtyByProduct = new Map<string, number>();
  const items = await db.billItem.findMany({
    where: { bill: { status: "FINALIZED", finalizedAt: { gte: since } } },
    select: { productId: true, qty: true },
  });
  for (const item of items) {
    soldQtyByProduct.set(item.productId, (soldQtyByProduct.get(item.productId) ?? 0) + Number(item.qty));
  }

  const suggestions = products
    .map((p) => {
      const soldInWindow = soldQtyByProduct.get(p.id) ?? 0;
      const dailyVelocity = soldInWindow / windowDays;
      const currentQty = Number(p.qty);
      const daysOfStockLeft = dailyVelocity > 0 ? currentQty / dailyVelocity : Infinity;
      const belowReorderLevel = currentQty <= Number(p.reorderLevel);
      const runningOutSoon = daysOfStockLeft <= leadTimeDays;

      if (!belowReorderLevel && !runningOutSoon) return null;

      const suggestedQty = Math.max(
        Math.ceil(dailyVelocity * coverDays) - currentQty,
        Number(p.reorderLevel) - currentQty,
        1
      );

      return {
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        currentQty,
        reorderLevel: Number(p.reorderLevel),
        dailyVelocity: Math.round(dailyVelocity * 100) / 100,
        daysOfStockLeft: Number.isFinite(daysOfStockLeft) ? Math.round(daysOfStockLeft * 10) / 10 : null,
        suggestedReorderQty: Math.max(1, Math.round(suggestedQty)),
        reason: belowReorderLevel ? "at_or_below_reorder_level" : "projected_stockout",
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => (a.daysOfStockLeft ?? 0) - (b.daysOfStockLeft ?? 0));

  return { windowDays, leadTimeDays, coverDays, suggestions };
}
