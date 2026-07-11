/**
 * Concurrency test for hard-part #6.
 *
 * Bypasses Telegram and the LLM entirely and calls the transaction-level
 * functions directly, so the test is deterministic and isn't at the mercy
 * of model tool-calling variance. Uses its own throwaway product (prefixed
 * TESTCONC-) so it never touches your seeded catalog — safe to run
 * against a dev DB repeatedly.
 *
 * Run with:
 *   pnpm exec tsx scripts/test-concurrency.ts
 *
 * Requires DATABASE_URL to point at Postgres (SQLite will not exhibit
 * correct locking behavior for this test, by design of the schema).
 */
import "dotenv/config";
import { db } from "../lib/db";
import { decrementStockForSaleTx } from "../lib/tools/inventory";
import { receiveStock } from "../lib/tools/inventory";

const SKU = "TESTCONC-ITEM";

async function setup(initialQty: number) {
  await db.product.deleteMany({ where: { sku: SKU } });
  return db.product.create({
    data: {
      sku: SKU,
      name: "Concurrency Test Item",
      unit: "piece",
      isLoose: false,
      costPrice: 10,
      mrp: 15,
      hsn: "0000",
      gstSlab: 0,
      qty: initialQty,
      reorderLevel: 0,
    },
  });
}

async function teardown() {
  await db.stockIn.deleteMany({ where: { product: { sku: SKU } } });
  await db.product.deleteMany({ where: { sku: SKU } });
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

/**
 * Test 1: two "bills" racing to decrement the SAME product where only one
 * of them can succeed. Stock = 10, each wants 8. Exactly one should
 * succeed; the other must be refused (not both succeed, which would leave
 * qty at -6).
 */
async function testTwoConcurrentSales() {
  console.log("\n--- Test 1: two concurrent oversell-risking sales ---");
  const product = await setup(10);

  const attempt = (qty: number) =>
    db
      .$transaction((tx) => decrementStockForSaleTx(tx, product.id, qty))
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, message: err.message as string }));

  const [r1, r2] = await Promise.all([attempt(8), attempt(8)]);

  const succeeded = [r1, r2].filter((r) => r.ok).length;
  const failed = [r1, r2].filter((r) => !r.ok);

  assert(succeeded === 1, `exactly one of the two concurrent 8-unit sales succeeded (got ${succeeded})`);
  assert(failed.length === 1, "exactly one of the two was refused");
  if (failed[0] && !failed[0].ok) {
    assert(/oversell/i.test(failed[0].message), `refusal message mentions oversell ("${failed[0].message}")`);
  }

  const finalProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  assert(Number(finalProduct.qty) === 2, `final qty is 2 (10 - 8), not negative or double-decremented (got ${finalProduct.qty})`);

  await teardown();
}

/**
 * Test 2: a sale and a stock-in racing on the same product. Stock = 5.
 * A sale of 5 and a stock-in of +20 happen "at once". Whichever order
 * Postgres actually serializes them in, the final qty must be internally
 * consistent (25 if stock-in-then-sale, or 20 if sale-then-stock-in) —
 * never a corrupted intermediate value from a lost update.
 */
async function testSalePlusStockIn() {
  console.log("\n--- Test 2: concurrent sale + stock-in on the same product ---");
  const product = await setup(5);

  const sale = db
    .$transaction((tx) => decrementStockForSaleTx(tx, product.id, 5))
    .then(() => ({ ok: true as const }))
    .catch((err) => ({ ok: false as const, message: err.message as string }));

  const stockIn = receiveStock({ productQuery: SKU, qty: 20, costPrice: 10 })
    .then(() => ({ ok: true as const }))
    .catch((err) => ({ ok: false as const, message: err.message as string }));

  const [saleResult, stockInResult] = await Promise.all([sale, stockIn]);

  assert(stockInResult.ok, "stock-in succeeded (should always succeed, it only ever increments)");
  assert(saleResult.ok, "sale of 5 against a stock of 5 succeeded (should not be blocked by the stock-in racing it)");

  const finalProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  const finalQty = Number(finalProduct.qty);
  // Regardless of DB-chosen serialization order, decrementing 5 and
  // incrementing 20 against a starting qty of 5 must net to exactly 20.
  // A lost-update bug would show up as 0 (sale's decrement overwritten by
  // stock-in's stale-read increment) or 25-with-no-sale-effect etc.
  assert(finalQty === 20, `final qty reflects BOTH operations with no lost update (expected 20, got ${finalQty})`);

  await teardown();
}

/**
 * Test 3 (sanity/negative control): confirm the oversell guard actually
 * blocks a single, non-concurrent overselling request, i.e. the guard
 * isn't only "correct" by accident of the race losing.
 */
async function testSingleOversellStillBlocked() {
  console.log("\n--- Test 3: sanity check, non-concurrent oversell is still blocked ---");
  const product = await setup(3);

  const result = await db
    .$transaction((tx) => decrementStockForSaleTx(tx, product.id, 10))
    .then(() => ({ ok: true as const }))
    .catch((err) => ({ ok: false as const, message: err.message as string }));

  assert(!result.ok, "a straightforward oversell (10 requested, 3 in stock) is refused");

  const finalProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  assert(Number(finalProduct.qty) === 3, "stock is untouched after a refused sale");

  await teardown();
}

async function main() {
  try {
    await testTwoConcurrentSales();
    await testSalePlusStockIn();
    await testSingleOversellStillBlocked();
    console.log("\n🎉 All concurrency tests passed.");
  } catch (err) {
    console.error("\n💥", err);
    await teardown().catch(() => {});
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();