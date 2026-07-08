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
