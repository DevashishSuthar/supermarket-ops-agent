import {  PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
}

/**
 * Hard part #8: a real, rendered PDF invoice — not a screenshot or a
 * plain-text message. This draws an actual GST invoice with a legible
 * per-slab tax breakup, per the spec.
 */
export async function generateInvoicePdf(bill: InvoiceBill, shop: ShopInfo): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 800;
  const left = 40;

  const drawText = (text: string, x: number, yy: number, size = 10, f = font) => {
    page.drawText(text, { x, y: yy, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  };

  drawText(shop.name, left, y, 18, bold);
  y -= 20;
  if (shop.gstin) {
    drawText(`GSTIN: ${shop.gstin}`, left, y, 10);
    y -= 14;
  }
  if (shop.address) {
    drawText(shop.address, left, y, 10);
    y -= 14;
  }

  y -= 10;
  drawText("TAX INVOICE", left, y, 14, bold);
  y -= 20;
  drawText(`Invoice #: ${bill.id}`, left, y);
  drawText(
    `Date: ${(bill.finalizedAt ?? new Date()).toLocaleString("en-IN")}`,
    left + 300,
    y
  );
  y -= 14;
  drawText(`Payment: ${bill.paymentMode ?? "N/A"}`, left, y);
  y -= 24;

  // Table header
  const cols = { item: left, hsn: 240, qty: 300, rate: 350, taxable: 410, gst: 470, total: 520 };
  drawText("Item", cols.item, y, 9, bold);
  drawText("HSN", cols.hsn, y, 9, bold);
  drawText("Qty", cols.qty, y, 9, bold);
  drawText("Rate", cols.rate, y, 9, bold);
  drawText("Taxable", cols.taxable, y, 9, bold);
  drawText("GST%", cols.gst, y, 9, bold);
  drawText("Total", cols.total, y, 9, bold);
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: 555, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 14;

  for (const item of bill.items) {
    drawText(item.product.name.slice(0, 28), cols.item, y, 9);
    drawText(item.product.hsn, cols.hsn, y, 9);
    drawText(`${item.qty} ${item.product.unit}`, cols.qty, y, 9);
    drawText(`Rs.${item.unitPrice.toFixed(2)}`, cols.rate, y, 9);
    drawText(`Rs.${item.lineSubtotal.toFixed(2)}`, cols.taxable, y, 9);
    drawText(`${item.gstSlab}%`, cols.gst, y, 9);
    drawText(`Rs.${item.lineTotal.toFixed(2)}`, cols.total, y, 9);
    y -= 16;
  }

  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: 555, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 20;

  // Tax breakup by slab — required by the spec ("legible tax breakup")
  drawText("Tax Breakup", left, y, 11, bold);
  y -= 16;
  const breakup = gstBreakupBySlab(bill.items);
  drawText("Slab", left, y, 9, bold);
  drawText("Taxable Value", left + 80, y, 9, bold);
  drawText("CGST", left + 220, y, 9, bold);
  drawText("SGST", left + 300, y, 9, bold);
  y -= 14;
  for (const row of breakup) {
    drawText(`${row.slab}%`, left, y, 9);
    drawText(`Rs.${row.taxable.toFixed(2)}`, left + 80, y, 9);
    drawText(`Rs.${row.cgst.toFixed(2)}`, left + 220, y, 9);
    drawText(`Rs.${row.sgst.toFixed(2)}`, left + 300, y, 9);
    y -= 14;
  }

  y -= 16;
  drawText(`Subtotal: Rs.${bill.subtotal.toFixed(2)}`, left + 300, y, 10, bold);
  y -= 14;
  drawText(`CGST: Rs.${bill.cgst.toFixed(2)}`, left + 300, y, 10);
  y -= 14;
  drawText(`SGST: Rs.${bill.sgst.toFixed(2)}`, left + 300, y, 10);
  y -= 14;
  drawText(`Grand Total: Rs.${bill.total.toFixed(2)}`, left + 300, y, 12, bold);

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
