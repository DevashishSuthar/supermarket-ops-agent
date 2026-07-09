import PptxGenJS from "pptxgenjs";

interface DeckBill {
  finalizedAt: Date | null;
  subtotal: number;
  cgst: number;
  sgst: number;
  total: number;
  items: { qty: number; lineTotal: number; product: { name: string } }[];
}

interface LowStockProduct {
  name: string;
  qty: number;
  reorderLevel: number;
}

/**
 * Hard part #8: a real PPTX with actual charts (pptxgenjs renders native
 * PowerPoint chart objects, not embedded images), not a text-only deck.
 */
export async function generateAnalysisDeck(
  bills: DeckBill[],
  lowStock: LowStockProduct[],
  periodLabel: string
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "LAYOUT", width: 10, height: 5.63 });
  pptx.layout = "LAYOUT";

  // --- Title slide ---
  const title = pptx.addSlide();
  title.addText("Store Sales Analysis", { x: 0.5, y: 1.8, w: 9, h: 1, fontSize: 32, bold: true });
  title.addText(periodLabel, { x: 0.5, y: 2.7, w: 9, h: 0.6, fontSize: 16, color: "666666" });

  // --- Summary numbers ---
  const totalRevenue = bills.reduce((s, b) => s + b.total, 0);
  const totalTax = bills.reduce((s, b) => s + b.cgst + b.sgst, 0);
  const summary = pptx.addSlide();
  summary.addText("Summary", { x: 0.5, y: 0.3, fontSize: 24, bold: true });
  summary.addText(
    [
      { text: `Total Revenue: Rs.${totalRevenue.toFixed(2)}\n`, options: { fontSize: 18 } },
      { text: `GST Collected: Rs.${totalTax.toFixed(2)}\n`, options: { fontSize: 18 } },
      { text: `Bills Processed: ${bills.length}\n`, options: { fontSize: 18 } },
    ],
    { x: 0.5, y: 1.2, w: 9, h: 2 }
  );

  // --- Revenue over time chart ---
  const byDay = new Map<string, number>();
  for (const b of bills) {
    if (!b.finalizedAt) continue;
    const day = b.finalizedAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + b.total);
  }
  const days = Array.from(byDay.keys()).sort();
  if (days.length > 0) {
    const trendSlide = pptx.addSlide();
    trendSlide.addText("Revenue Trend", { x: 0.5, y: 0.3, fontSize: 24, bold: true });
    trendSlide.addChart(
      pptx.ChartType.line,
      [{ name: "Revenue (Rs.)", labels: days, values: days.map((d) => byDay.get(d) ?? 0) }],
      { x: 0.5, y: 1.1, w: 9, h: 4 }
    );
  }

  // --- Top items chart ---
  const itemTotals = new Map<string, number>();
  for (const b of bills) {
    for (const item of b.items) {
      itemTotals.set(item.product.name, (itemTotals.get(item.product.name) ?? 0) + item.lineTotal);
    }
  }
  const topItems = Array.from(itemTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (topItems.length > 0) {
    const topSlide = pptx.addSlide();
    topSlide.addText("Top Selling Items", { x: 0.5, y: 0.3, fontSize: 24, bold: true });
    topSlide.addChart(
      pptx.ChartType.bar,
      [{ name: "Revenue (Rs.)", labels: topItems.map((i) => i[0]), values: topItems.map((i) => i[1]) }],
      { x: 0.5, y: 1.1, w: 9, h: 4, barDir: "bar" }
    );
  }

  // --- Stock health ---
  const stockSlide = pptx.addSlide();
  stockSlide.addText("Stock Health — Low / Reorder", { x: 0.5, y: 0.3, fontSize: 24, bold: true });
  if (lowStock.length === 0) {
    stockSlide.addText("Nothing below reorder level right now.", { x: 0.5, y: 1.3, fontSize: 16 });
  } else {
    stockSlide.addTable(
      [
        [{ text: "Product", options: { bold: true } }, { text: "Qty Left", options: { bold: true } }, { text: "Reorder Level", options: { bold: true } }],
        // ...lowStock.map((p) => [p.name, String(p.qty), String(p.reorderLevel)]),
        ...lowStock.map((p) => [
          { text: p.name },
          { text: String(p.qty) },
          { text: String(p.reorderLevel) },
        ])
      ],
      { x: 0.5, y: 1.1, w: 9, colW: [5, 2, 2] }
    );
  }

  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return buf;
}
