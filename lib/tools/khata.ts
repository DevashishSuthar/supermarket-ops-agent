import { db } from "../db";
import { ToolError } from "./inventory";
import { Prisma } from "@prisma/client";

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
 * Hard part #7 guardrail: don't settle a khata that doesn't exist, and
 * don't let a payment bigger than what's actually owed push the balance
 * negative (typo'd amount, misheard voice note, etc — "confirm or refuse"
 * per the brief). The balance is re-read with a row lock INSIDE the
 * transaction, not just checked up front, so two payments for the same
 * customer arriving at once can't both pass a stale "is this <= balance"
 * check the way two sales against the same product could.
 */
export async function recordPayment(customerName: string, amount: number) {
  if (amount <= 0) throw new ToolError("Payment amount must be positive.");
  const customer = await findCustomer(customerName);
  if (!customer) {
    throw new ToolError(`No khata account found for "${customerName}". Nothing to settle.`);
  }

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; balance: Prisma.Decimal }[]>`
      SELECT id, balance FROM "customers" WHERE id = ${customer.id} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new ToolError(`No khata account found for "${customerName}".`);
    }
    const outstanding = Number(rows[0].balance);
    if (outstanding <= 0) {
      throw new ToolError(`${customer.name} has no outstanding balance to pay off.`);
    }
    if (amount > outstanding) {
      throw new ToolError(
        `${customer.name} only owes ₹${outstanding.toFixed(2)} — ₹${amount.toFixed(2)} is more than that. ` +
        `Confirm the amount with the owner, or record ₹${outstanding.toFixed(2)} to fully settle it.`
      );
    }

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

/**
 * Goal: "Khata payment reminders."
 *
 * Returns every customer with an outstanding balance, along with how many
 * days it's been since their last ledger activity (credit or payment) —
 * used both as an on-demand "who owes me money?" tool and by the weekly
 * reminder cron job (see app/api/cron/khata-reminders).
 */
export async function listOutstandingKhata(minBalance = 1) {
  const customers = await db.customer.findMany({
    where: { balance: { gt: minBalance } },
    include: { ledger: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { balance: "desc" },
  });

  return customers.map((c) => {
    const lastActivity = c.ledger[0]?.createdAt ?? c.createdAt;
    const daysSinceActivity = Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));
    return {
      name: c.name,
      phone: c.phone,
      balance: Number(c.balance),
      daysSinceActivity,
    };
  });
}