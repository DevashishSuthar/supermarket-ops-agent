import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { gstBreakupBySlab } from "../gst";

interface InvoiceBill {
  id: string;
  finalizedAt: Date | null;
  paymentMode: string | null;
  subtotal: number;
  cgst: number;
  sgst: number;
  total: number;
  items: {
    qty: number;
    unitPrice: number;
    gstSlab: number;
    lineSubtotal: number;
    lineCgst: number;
    lineSgst: number;
    lineTotal: number;
    product: { name: string; unit: string; hsn: string };
  }[];
}

interface ShopInfo {
  name: string;
  gstin?: string;
  address?: string;
  /** Optional 0-1 RGB triple for the letterhead band. Defaults to a neutral
   *  teal so every shop still looks intentional without configuring one. */
  brandColor?: [number, number, number];
}

// --- shared palette / layout constants (stretch: "branded invoices") ---
const PAGE = { width: 595, height: 842 }; // A4
const MARGIN_LEFT = 40;
const MARGIN_RIGHT = 555;
const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.45, 0.45, 0.48);
const LINE = rgb(0.82, 0.82, 0.84);
const HEADER_FILL = rgb(0.93, 0.94, 0.96);
const ROW_FILL_ALT = rgb(0.975, 0.975, 0.98);

/**
 * Hard part #8: a real, rendered PDF invoice — not a screenshot or a
 * plain-text message. Draws an actual GST invoice with a legible per-slab
 * tax breakup, per the spec.
 *
 * Stretch goal ("branded / templated invoices"): a colored letterhead
 * band, bordered/shaded tables, and a footer — instead of plain unstyled
 * text — so every shop's invoice reads like a real business document. The
 * brand color is configurable per shop but defaults sensibly.
 */
export async function generateInvoicePdf(bill: InvoiceBill, shop: ShopInfo): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([PAGE.width, PAGE.height]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const brand = shop.brandColor ?? [0.10, 0.32, 0.36];
  const brandColor = rgb(...brand);

  const drawText = (text: string, x: number, yy: number, size = 10, f = font, color = INK) => {
    page.drawText(text, { x, y: yy, size, font: f, color });
  };
  const drawRect = (x: number, yy: number, w: number, h: number, color: ReturnType<typeof rgb>) => {
    page.drawRectangle({ x, y: yy, width: w, height: h, color });
  };
  const drawHLine = (yy: number, color = LINE, thickness = 0.75) => {
    page.drawLine({ start: { x: MARGIN_LEFT, y: yy }, end: { x: MARGIN_RIGHT, y: yy }, thickness, color });
  };

  const drawLetterhead = () => {
    const bandHeight = 78;
    drawRect(0, PAGE.height - bandHeight, PAGE.width, bandHeight, brandColor);
    drawText(shop.name, MARGIN_LEFT, PAGE.height - 32, 20, bold, rgb(1, 1, 1));
    let subY = PAGE.height - 50;
    if (shop.gstin) {
      drawText(`GSTIN: ${shop.gstin}`, MARGIN_LEFT, subY, 9.5, font, rgb(0.9, 0.95, 0.95));
      subY -= 13;
    }
    if (shop.address) {
      drawText(shop.address, MARGIN_LEFT, subY, 9.5, font, rgb(0.9, 0.95, 0.95));
    }
    const badgeText = "TAX INVOICE";
    const badgeWidth = bold.widthOfTextAtSize(badgeText, 13) + 20;
    drawRect(MARGIN_RIGHT - badgeWidth, PAGE.height - 40, badgeWidth, 22, rgb(1, 1, 1));
    drawText(badgeText, MARGIN_RIGHT - badgeWidth + 10, PAGE.height - 33, 12, bold, brandColor);
    return PAGE.height - bandHeight - 26;
  };

  let y = drawLetterhead();

  // ---------- Invoice meta ----------
  drawText("Invoice #", MARGIN_LEFT, y, 8.5, font, MUTED);
  drawText("Date", MARGIN_LEFT + 260, y, 8.5, font, MUTED);
  drawText("Payment Mode", MARGIN_LEFT + 420, y, 8.5, font, MUTED);
  y -= 13;
  drawText(bill.id, MARGIN_LEFT, y, 10, bold);
  drawText((bill.finalizedAt ?? new Date()).toLocaleString("en-IN"), MARGIN_LEFT + 260, y, 10, bold);
  drawText(bill.paymentMode ?? "N/A", MARGIN_LEFT + 420, y, 10, bold);
  y -= 22;
  drawHLine(y);
  y -= 20;

  // ---------- Line-items table ----------
  const cols = { item: MARGIN_LEFT + 6, hsn: 235, qty: 295, rate: 345, taxable: 405, gst: 468, total: 500 };
  const rowHeight = 18;

  const drawTableHeader = () => {
    drawRect(MARGIN_LEFT, y - 5, MARGIN_RIGHT - MARGIN_LEFT, rowHeight, HEADER_FILL);
    drawText("Item", cols.item, y, 8.5, bold);
    drawText("HSN", cols.hsn, y, 8.5, bold);
    drawText("Qty", cols.qty, y, 8.5, bold);
    drawText("Rate", cols.rate, y, 8.5, bold);
    drawText("Taxable", cols.taxable, y, 8.5, bold);
    drawText("GST%", cols.gst, y, 8.5, bold);
    drawText("Total", cols.total, y, 8.5, bold);
    y -= rowHeight;
  };

  drawTableHeader();

  bill.items.forEach((item, idx) => {
    // Overflow to a fresh page (with a repeated header) for long bills.
    if (y < 140) {
      drawText("Continued on next page...", MARGIN_LEFT, 40, 8, font, MUTED);
      page = pdfDoc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - 60;
      drawTableHeader();
    }

    if (idx % 2 === 1) {
      drawRect(MARGIN_LEFT, y - 4, MARGIN_RIGHT - MARGIN_LEFT, rowHeight, ROW_FILL_ALT);
    }
    drawText(item.product.name.slice(0, 26), cols.item, y, 9);
    drawText(item.product.hsn, cols.hsn, y, 9);
    drawText(`${item.qty} ${item.product.unit}`, cols.qty, y, 9);
    drawText(`Rs.${item.unitPrice.toFixed(2)}`, cols.rate, y, 9);
    drawText(`Rs.${item.lineSubtotal.toFixed(2)}`, cols.taxable, y, 9);
    drawText(`${item.gstSlab}%`, cols.gst, y, 9);
    drawText(`Rs.${item.lineTotal.toFixed(2)}`, cols.total, y, 9, bold);
    y -= rowHeight;
  });

  y -= 4;
  drawHLine(y, brandColor, 1.2);
  y -= 24;

  // ---------- Tax breakup by slab ----------
  if (y < 200) {
    page = pdfDoc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - 60;
  }
  drawText("Tax Breakup", MARGIN_LEFT, y, 11, bold, brandColor);
  y -= 18;
  const breakup = gstBreakupBySlab(bill.items);
  const bCols = { slab: MARGIN_LEFT + 6, taxable: MARGIN_LEFT + 90, cgst: MARGIN_LEFT + 250, sgst: MARGIN_LEFT + 340 };
  drawRect(MARGIN_LEFT, y - 5, MARGIN_RIGHT - MARGIN_LEFT, rowHeight, HEADER_FILL);
  drawText("Slab", bCols.slab, y, 8.5, bold);
  drawText("Taxable Value", bCols.taxable, y, 8.5, bold);
  drawText("CGST", bCols.cgst, y, 8.5, bold);
  drawText("SGST", bCols.sgst, y, 8.5, bold);
  y -= rowHeight;
  breakup.forEach((row, idx) => {
    if (idx % 2 === 1) drawRect(MARGIN_LEFT, y - 4, MARGIN_RIGHT - MARGIN_LEFT, rowHeight, ROW_FILL_ALT);
    drawText(`${row.slab}%`, bCols.slab, y, 9);
    drawText(`Rs.${row.taxable.toFixed(2)}`, bCols.taxable, y, 9);
    drawText(`Rs.${row.cgst.toFixed(2)}`, bCols.cgst, y, 9);
    drawText(`Rs.${row.sgst.toFixed(2)}`, bCols.sgst, y, 9);
    y -= rowHeight;
  });

  y -= 10;

  // ---------- Totals box ----------
  const boxWidth = 220;
  const boxX = MARGIN_RIGHT - boxWidth;
  const boxTop = y;
  const lineGap = 16;
  const boxHeight = lineGap * 4 + 14 + 8;
  page.drawRectangle({
    x: boxX,
    y: boxTop - boxHeight,
    width: boxWidth,
    height: boxHeight,
    borderColor: LINE,
    borderWidth: 1,
    color: rgb(1, 1, 1),
  });
  let ty = boxTop - 14;
  const totalsRow = (label: string, value: number, emphasize = false) => {
    const size = emphasize ? 11 : 9.5;
    const f = emphasize ? bold : font;
    const color = emphasize ? brandColor : MUTED;
    drawText(label, boxX + 12, ty, size, f, color);
    const valText = `Rs.${value.toFixed(2)}`;
    const valWidth = f.widthOfTextAtSize(valText, size);
    drawText(valText, boxX + boxWidth - 12 - valWidth, ty, size, f, emphasize ? brandColor : INK);
    ty -= lineGap;
  };
  totalsRow("Subtotal", bill.subtotal);
  totalsRow("CGST", bill.cgst);
  totalsRow("SGST", bill.sgst);
  // Scoped to the box's own width (boxX -> MARGIN_RIGHT), NOT drawHLine's
  // full-page width — that mismatch was the misaligned rule under Grand Total.
  page.drawLine({
    start: { x: boxX + 10, y: ty + 6 },
    end: { x: MARGIN_RIGHT - 10, y: ty + 6 },
    thickness: 0.75,
    color: LINE,
  });
  ty -= 8;
  totalsRow("Grand Total", bill.total, true);

  // ---------- Footer ----------
  drawHLine(70);
  drawText(
    "This is a system-generated tax invoice and does not require a signature.",
    MARGIN_LEFT,
    54,
    8,
    font,
    MUTED
  );
  drawText(`Thank you for shopping at ${shop.name}!`, MARGIN_LEFT, 40, 9, bold, brandColor);

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}