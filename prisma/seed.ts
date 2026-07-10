import "dotenv/config";
import { db } from "../lib/db";

/**
 * Seeds a realistic Indian kirana catalog so the bot has real SKUs, real
 * HSN codes, and real GST slabs to reason over from message one — instead
 * of the owner having to hand-type HSN/GST for every product (which is how
 * we ended up with an invoice showing HSN "atta5kg" and 18% GST on atta).
 *
 * Idempotent: upserts by `sku`, so re-running this after a schema change or
 * a fresh `db:push` is always safe.
 *
 * NOTE: GST slabs/HSN codes below are representative of common CBIC
 * classifications for a kirana store and are good enough for a realistic
 * demo — verify against the latest CBIC rate notification before treating
 * this as tax advice for a real shop.
 */
const PRODUCTS = [
  // --- Packaged branded staples ---
  {
    sku: "AASHIRVAAD-ATTA-5KG",
    name: "Aashirvaad Atta 5kg",
    unit: "packet",
    isLoose: false,
    costPrice: 210,
    mrp: 250,
    hsn: "1101",
    gstSlab: 5,
    initialQty: 40,
    reorderLevel: 8,
  },
  {
    sku: "TATA-SALT-1KG",
    name: "Tata Salt 1kg",
    unit: "packet",
    isLoose: false,
    costPrice: 20,
    mrp: 28,
    hsn: "2501",
    gstSlab: 0, // edible salt is nil-rated
    initialQty: 60,
    reorderLevel: 10,
  },
  {
    sku: "AMUL-BUTTER-100G",
    name: "Amul Butter 100g",
    unit: "piece",
    isLoose: false,
    costPrice: 48,
    mrp: 58,
    hsn: "0405",
    gstSlab: 12,
    initialQty: 30,
    reorderLevel: 6,
  },
  {
    sku: "FORTUNE-SFLOWER-OIL-1L",
    name: "Fortune Sunflower Oil 1L",
    unit: "piece",
    isLoose: false,
    costPrice: 140,
    mrp: 165,
    hsn: "1512",
    gstSlab: 5,
    initialQty: 25,
    reorderLevel: 5,
  },
  {
    sku: "MAGGI-70G",
    name: "Maggi 70g",
    unit: "packet",
    isLoose: false,
    costPrice: 12,
    mrp: 14,
    hsn: "1902",
    gstSlab: 12,
    initialQty: 100,
    reorderLevel: 20,
  },
  {
    sku: "PARLE-G-BISCUIT",
    name: "Parle-G Biscuit",
    unit: "packet",
    isLoose: false,
    costPrice: 8,
    mrp: 10,
    hsn: "1905",
    gstSlab: 5, // low-MRP biscuits (<= Rs.100/kg) attract the concessional 5% slab
    initialQty: 120,
    reorderLevel: 24,
  },
  {
    sku: "SURF-EXCEL-1KG",
    name: "Surf Excel 1kg",
    unit: "packet",
    isLoose: false,
    costPrice: 95,
    mrp: 115,
    hsn: "3402",
    gstSlab: 18,
    initialQty: 20,
    reorderLevel: 5,
  },

  // --- Loose items, sold by weight, no brand => 0% slab ---
  {
    sku: "LOOSE-SUGAR-KG",
    name: "Sugar (loose)",
    unit: "kg",
    isLoose: true,
    costPrice: 38,
    mrp: 45,
    hsn: "1701",
    gstSlab: 5, // sugar attracts 5% GST regardless of loose/packaged
    initialQty: 80,
    reorderLevel: 15,
  },
  {
    sku: "LOOSE-RICE-KG",
    name: "Rice (loose)",
    unit: "kg",
    isLoose: true,
    costPrice: 32,
    mrp: 40,
    hsn: "1006",
    gstSlab: 0, // unbranded loose rice is nil-rated
    initialQty: 100,
    reorderLevel: 20,
  },
  {
    sku: "LOOSE-TUR-DAL-KG",
    name: "Tur Dal (loose)",
    unit: "kg",
    isLoose: true,
    costPrice: 95,
    mrp: 110,
    hsn: "0713",
    gstSlab: 0, // unbranded loose dal/pulses are nil-rated
    initialQty: 50,
    reorderLevel: 10,
  },
  {
    sku: "LOOSE-ATTA-KG",
    name: "Atta (loose)",
    unit: "kg",
    isLoose: true,
    costPrice: 30,
    mrp: 36,
    hsn: "1101",
    gstSlab: 0, // unbranded loose atta is nil-rated (unlike the packaged Aashirvaad SKU above)
    initialQty: 60,
    reorderLevel: 12,
  },
];

async function main() {
  for (const p of PRODUCTS) {
    const { initialQty, ...rest } = p;
    await db.product.upsert({
      where: { sku: p.sku },
      update: {
        name: rest.name,
        unit: rest.unit,
        isLoose: rest.isLoose,
        costPrice: rest.costPrice,
        mrp: rest.mrp,
        hsn: rest.hsn,
        gstSlab: rest.gstSlab,
        reorderLevel: rest.reorderLevel,
        // Deliberately NOT touching `qty` on update — re-running the seed
        // must never silently reset real stock the owner has since sold.
      },
      create: { ...rest, qty: initialQty },
    });
    console.log(`Seeded: ${p.name} (${p.sku})`);
  }
  console.log(`Done — ${PRODUCTS.length} products seeded/updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
