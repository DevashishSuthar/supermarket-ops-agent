import { z } from "zod";

export const getProductSchema = z.object({
  query: z.string().describe("product name or SKU as the owner typed it"),
});
export type GetProductArgs = z.infer<typeof getProductSchema>;

export const addProductSchema = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.enum(["kg", "g", "litre", "ml", "packet", "dozen", "piece"]),
  isLoose: z.boolean().nullish(),
  costPrice: z.number(),
  mrp: z.number(),
  hsn: z.string().describe("HSN code for this product"),
  gstSlab: z.number().describe("GST % slab: 0, 5, 12, or 18"),
  initialQty: z.number().nullish(),
  reorderLevel: z.number().nullish(),
});
export type AddProductArgs = z.infer<typeof addProductSchema>;

export const receiveStockSchema = z.object({
  productQuery: z.string(),
  qty: z.number(),
  costPrice: z.number().nullish(),
  mrp: z.number().nullish(),
});
export type ReceiveStockArgs = z.infer<typeof receiveStockSchema>;

export const addItemSchema = z.object({
  productQuery: z.string(),
  qty: z.number(),
});
export type AddItemArgs = z.infer<typeof addItemSchema>;

export const removeItemSchema = z.object({
  productQuery: z.string(),
});
export type RemoveItemArgs = z.infer<typeof removeItemSchema>;

export const finalizeBillSchema = z.object({
  paymentMode: z.enum(["CASH", "UPI", "CARD"]),
  paymentRef: z.string().nullish().describe("UPI ref / card auth code if given"),
});
export type FinalizeBillArgs = z.infer<typeof finalizeBillSchema>;

export const addCreditSchema = z.object({
  customerName: z.string(),
  amount: z.number(),
  note: z.string().nullish()
});
export type AddCreditArgs = z.infer<typeof addCreditSchema>;

export const recordKhataPaymentSchema = z.object({
  customerName: z.string(),
  amount: z.number(),
});
export type RecordKhataPaymentArgs = z.infer<typeof recordKhataPaymentSchema>;

export const getKhataBalanceSchema = z.object({
  customerName: z.string(),
});
export type GetKhataBalanceArgs = z.infer<typeof getKhataBalanceSchema>;

export const dailyCloseSchema = z.object({
  date: z.string().nullish().describe("ISO date, defaults to today")
});
export type DailyCloseArgs = z.infer<typeof dailyCloseSchema>;

export const generateInvoicePdfSchema = z.object({
  billId: z.string()
});
export type GenerateInvoicePdfArgs = z.infer<typeof generateInvoicePdfSchema>;

export const generateAnalysisDeckSchema = z.object({
  startDate: z.string().describe("ISO date, start of range"),
  endDate: z.string().describe("ISO date, end of range"),
  label: z.string().describe("human label like 'This Week'"),
});
export type GenerateAnalysisDeckArgs = z.infer<typeof generateAnalysisDeckSchema>;

export const setPreferenceSchema = z.object({
  key: z.string(),
  value: z.string()
});
export type SetPreferenceArgs = z.infer<typeof setPreferenceSchema>;