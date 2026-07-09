import { db } from "../db";
import { ToolError } from "./inventory";

async function findCustomer(name: string) {
  return db.customer.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
}

export async function addCredit(customerName: string, amount: number, note?: string) {
  if (amount <= 0) throw new ToolError("Credit amount must be positive.");

  return db.$transaction(async (tx) => {
    let customer = await tx.customer.findFirst({ where: { name: { equals: customerName, mode: "insensitive" } } });
    if (!customer) {
      customer = await tx.customer.create({ data: { name: customerName } });
    }
    const updated = await tx.customer.update({
      where: { id: customer.id },
      data: { balance: { increment: amount } },
    });
    await tx.khataEntry.create({
      data: { customerId: customer.id, type: "CREDIT", amount, note },
    });
    return updated;
  });
}

/**
 * Hard part #7 guardrail: don't settle a khata that doesn't exist.
 */
export async function recordPayment(customerName: string, amount: number) {
  if (amount <= 0) throw new ToolError("Payment amount must be positive.");
  const customer = await findCustomer(customerName);
  if (!customer) {
    throw new ToolError(`No khata account found for "${customerName}". Nothing to settle.`);
  }
  if (Number(customer.balance) <= 0) {
    throw new ToolError(`${customer.name} has no outstanding balance to pay off.`);
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id: customer.id },
      data: { balance: { decrement: amount } },
    });
    await tx.khataEntry.create({
      data: { customerId: customer.id, type: "PAYMENT", amount },
    });
    return updated;
  });
}

export async function getBalance(customerName: string) {
  const customer = await findCustomer(customerName);
  if (!customer) throw new ToolError(`No khata account found for "${customerName}".`);
  return customer;
}
