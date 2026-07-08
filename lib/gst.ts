/**
 * GST math lives HERE — in code the model cannot bypass — not in the
 * system prompt. This is the "hard part #3: GST correctness" requirement.
 *
 * Intra-state sale => CGST + SGST, split evenly from the total GST slab.
 * e.g. an 18% slab item = 9% CGST + 9% SGST.
 * Loose staples (atta/rice/produce sold loose) typically carry a 0% slab —
 * that's just a `gstSlab: 0` row on the Product, not special-cased logic.
 */

export interface LineGst {
  qty: number;
  unitPrice: number;
  gstSlab: number;
  lineSubtotal: number;
  lineCgst: number;
  lineSgst: number;
  lineTotal: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function calcLine(qty: number, unitPrice: number, gstSlab: number): LineGst {
  const lineSubtotal = round2(qty * unitPrice);
  const gstAmount = round2(lineSubtotal * (gstSlab / 100));
  const lineCgst = round2(gstAmount / 2);
  // sgst gets the remainder so rounding never loses/gains a paisa
  const lineSgst = round2(gstAmount - lineCgst);
  const lineTotal = round2(lineSubtotal + lineCgst + lineSgst);
  return { qty, unitPrice, gstSlab, lineSubtotal, lineCgst, lineSgst, lineTotal };
}

export function summarizeBill(lines: LineGst[]) {
  const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const cgst = round2(lines.reduce((s, l) => s + l.lineCgst, 0));
  const sgst = round2(lines.reduce((s, l) => s + l.lineSgst, 0));
  const total = round2(subtotal + cgst + sgst);
  return { subtotal, cgst, sgst, total };
}

/** Groups line items by GST slab for the "tax breakup" table on the invoice. */
export function gstBreakupBySlab(lines: LineGst[]) {
  const bySlab = new Map<number, { taxable: number; cgst: number; sgst: number }>();
  for (const l of lines) {
    const entry = bySlab.get(l.gstSlab) ?? { taxable: 0, cgst: 0, sgst: 0 };
    entry.taxable = round2(entry.taxable + l.lineSubtotal);
    entry.cgst = round2(entry.cgst + l.lineCgst);
    entry.sgst = round2(entry.sgst + l.lineSgst);
    bySlab.set(l.gstSlab, entry);
  }
  return Array.from(bySlab.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slab, v]) => ({ slab, ...v }));
}
