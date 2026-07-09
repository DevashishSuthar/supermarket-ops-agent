# 🛒 Supermarket Ops Agent — Kirana Store, run from a chat window

**Telegram bot: [@StorePilotAIBot](https://t.me/StorePilotAIBot)**

A conversational agent that runs a small Indian kirana (grocery) store end-to-end —
receiving stock, cutting GST-correct bills, running customer credit (khata), closing
the day, and generating real PDF invoices and PPTX analysis decks — entirely through
plain-language Telegram messages. There is no admin panel and no web app. The chat
is the product.

---

## Table of contents

1. [The brief, in one line](#the-brief-in-one-line)
2. [Harness — why the Vercel AI SDK](#harness--why-the-vercel-ai-sdk)
3. [Control loop](#control-loop)
4. [Skill / tool design](#skill--tool-design)
5. [The domain model](#the-domain-model)
6. [How each hard part is solved](#how-each-hard-part-is-solved)
7. [What the owner can do (capability map)](#what-the-owner-can-do-capability-map)
8. [Setup & running it yourself](#setup--running-it-yourself)
9. [Demo script](#demo-script)
10. [Known limitations / what I'd harden next](#known-limitations--what-id-harden-next)
11. [Stretch goals not attempted](#stretch-goals-not-attempted)

---

## The brief, in one line

> Chat as the interface, an LLM as the reasoning brain, and a set of small,
> business-rule-enforcing tools as the execution layer — no keyword router,
> no CRUD forms.

Everything below explains how that's actually built, not just described.

---

## Harness — why the Vercel AI SDK

I built this on the **Vercel AI SDK** (`generateText` + `tool()` + `stopWhen: stepCountIs(8)`)
rather than the Claude Agent SDK or a deep-agent framework, because:

- It gives an explicit, fully inspectable tool-calling loop — `stepCountIs(8)` lets
  the model chain multiple tool calls in a single turn (e.g. `addItemToBill` →
  `addItemToBill` → `viewDraftBill` → `finalizeBill`) without me writing any
  orchestration/routing logic myself.
- It deploys as a single Next.js API route (the Telegram webhook) with no separate
  long-running process to manage — a good fit for a take-home reviewed remotely.
- It's a listed "or equivalent" harness in the brief, and lets me reuse a stack
  (Next.js + TypeScript + Prisma) I already run in production elsewhere.

**Model note:** the bot currently runs on **Groq (`openai/gpt-oss-120b`)** —
`llama-3.3-70b-versatile` was tried first but was unreliable at emitting real
structured tool calls (it produced pseudo-XML instead), so `gpt-oss-120b` is
the working default for cost-free iteration during development. The Anthropic
provider (`@ai-sdk/anthropic`, `claude-sonnet-4-6`) is already wired in
`lib/agent.ts` behind a one-line swap and is the intended model for the
production/reviewed deployment.

---

## Control loop

1. Telegram POSTs an update to `POST /api/telegram/webhook`.
2. The route verifies the request via the `x-telegram-bot-api-secret-token`
   header against `TELEGRAM_WEBHOOK_SECRET` — rejects anything that isn't
   actually from Telegram.
3. **Idempotency claim first, before any business logic:** `claimUpdateOnce`
   tries to `INSERT` the Telegram `update_id` into `ProcessedUpdate`. A unique-
   constraint failure means this update was already handled (Telegram
   redelivers on timeout) — we ack and stop right there.
4. `/new` is special-cased at the route level only to clear short-term
   conversation history (`resetConversationHistory`) — it does **not** touch
   the `Preference` table, which is the whole point of hard part #9.
5. Everything else — the raw message text — is handed to `runAgentTurn`,
   which:
   - loads this chat's standing preferences from Postgres and injects them
     into the system prompt as plain facts,
   - loads the last `MAX_HISTORY_MESSAGES` (20) turns of conversation,
   - calls `generateText` with the full tool surface and `stopWhen: stepCountIs(8)`.
6. The model reasons over the message, calls whichever tools it judges
   necessary — observe → reason → act → feed result back → continue — and
   produces a final natural-language reply.
7. The reply (or a generated PDF/PPTX file) is sent back to the chat via the
   Telegram Bot API, and the turn is appended to conversation history.

**There is no keyword/regex router anywhere in this path** — `route.ts` passes
raw text straight to the model; `lib/agent.ts` never branches on message content.

---

## Skill / tool design

Tools are grouped by domain, each kept thin and single-purpose, so the model
composes them rather than relying on one mega-tool:

| File | Tools | Responsibility |
|---|---|---|
| `lib/tools/inventory.ts` | `getProduct`, `addProduct`, `receiveStock`, `lowStockReport` + `decrementStockForSaleTx` | Product master data, stock-in, low-stock alerts, and the row-locked stock decrement used at bill finalize |
| `lib/tools/billing.ts` | `startBill`, `addItemToBill`, `removeItemFromBill`, `viewDraftBill`, `finalizeBill` | The multi-turn draft bill lifecycle; stock is untouched until finalize |
| `lib/tools/khata.ts` | `addCredit`, `recordKhataPayment`, `getKhataBalance` | Customer credit ledger, with existence/positive-balance guardrails |
| `lib/tools/reports.ts` | `dailyClose`, `salesForRange` | Daily close summary and date-range sales data for the analysis deck |
| `lib/tools/preferences.ts` | `setPreference` / `getPreferences` | The cross-session memory mechanism (hard part #9) |
| `lib/documents/invoice.ts` | used by `generateInvoicePdf` | Renders a real GST tax-invoice PDF with `pdf-lib` |
| `lib/documents/deck.ts` | used by `generateAnalysisDeck` | Renders a real `.pptx` with native charts via `pptxgenjs` |
| `lib/gst.ts` | — | Single source of truth for all tax math; every money-touching tool calls into it instead of re-deriving GST logic |

The `generateInvoicePdf` and `generateAnalysisDeck` tools call `sendDocument`
directly and push the finished file to the Telegram chat — the model doesn't
need to (and is told not to) describe the file's contents in prose.

---

## The domain model

Modeled with a real kirana store in mind, not a generic "products" table:

- **Currency:** ₹ throughout; all money columns are `Decimal(10,2)` in Postgres
  (never floats), and `qty` is `Decimal(10,3)` to support fractional kg/litre.
- **Units:** `kg | g | litre | ml | packet | dozen | piece`, with an `isLoose`
  flag distinguishing loose commodities (sugar/rice/dal by weight) from
  packaged/branded SKUs (Aashirvaad Atta 5kg, Tata Salt 1kg, Amul Butter 100g,
  Fortune Sunflower Oil 1L, Maggi 70g, Parle-G, Surf Excel, etc.).
- **GST:** every `Product` carries its own `hsn` and `gstSlab` (0 / 5 / 12 / 18).
  `lib/gst.ts` splits each line's GST evenly into CGST + SGST (intra-state
  sale), rounds to the paisa, and `gstBreakupBySlab` groups lines by slab for
  the invoice's tax breakup table — never a single blended percentage.
- **Payments:** `CASH | UPI | CARD` recorded on the bill with an optional
  reference (UPI ref / card auth code); no real payment gateway.
- **Khata (credit ledger):** a first-class `Customer` + `KhataEntry` model —
  "put ₹500 on Ramesh's credit", "Ramesh paid ₹300", "Ramesh's balance?" all
  map directly onto `addCredit` / `recordKhataPayment` / `getKhataBalance`.
- **Stock discipline:** every SKU has `costPrice`, `mrp`, `qty`, and
  `reorderLevel`; selling decrements stock atomically and only at bill
  finalize, never before.

---

## How each hard part is solved

1. **Grounding.** Every tool reads product/stock/GST data from Postgres via
   Prisma — nothing is ever hard-coded or invented in the prompt. The system
   prompt also explicitly forbids silently substituting a different
   size/variant (e.g. answering "Aashirvaad atta 5kg" with a 1kg pack) and
   requires the model to ask instead of guess.
2. **Oversell guard.** Enforced inside `decrementStockForSaleTx`, which runs
   `SELECT ... FOR UPDATE` and only decrements if `available >= qty`, inside
   the `finalizeBill` transaction. `addItemToBill` also does a soft pre-check
   for early feedback, but the **authoritative** check — the one that can't be
   bypassed — is at finalize, at the tool/DB layer, not the prompt layer.
3. **GST correctness.** `lib/gst.ts` computes per-line taxable value, splits
   GST into CGST/SGST, rounds to the paisa, and `gstBreakupBySlab` groups
   lines by slab for a legible tax breakup table on the invoice. The system
   prompt also forbids the model from ever quoting a single blended tax % in
   chat.
4. **Multi-turn bills.** `ConversationState.draftBillId` tracks the active
   draft bill per chat; `addItemToBill` / `removeItemFromBill` mutate
   `BillItem` rows directly across as many messages as needed; `Product.qty`
   is untouched until `finalizeBill` actually runs.
5. **Idempotency.** Two independent layers: (a) the webhook route claims the
   Telegram `update_id` via a unique-constraint insert *before* any business
   logic runs, so a redelivered webhook is dropped outright; (b)
   `finalizeBill` itself re-reads `Bill.status` under a row lock inside its
   own transaction — if it's already `FINALIZED`, it returns the existing
   result instead of re-decrementing stock, so even a tool-level retry
   (independent of Telegram's delivery guarantees) is safe.
6. **Concurrency.** Every stock mutation (`receiveStock`,
   `decrementStockForSaleTx`) runs inside a Prisma transaction using
   `SELECT ... FOR UPDATE`, so a simultaneous sale and stock-in on the same
   product serialize correctly instead of racing on stale reads. This is
   also why the schema requires Postgres rather than SQLite.
7. **Guardrails.** `finalizeBill` refuses to sell below cost;
   `recordKhataPayment` refuses to settle an account that doesn't exist or
   has no outstanding balance; there is intentionally **no** "delete stock"
   tool anywhere in the tool surface.
8. **Real artifacts.** `invoice.ts` draws an actual PDF (`pdf-lib`) with a
   line-item table and a per-slab CGST/SGST tax breakup; `deck.ts` builds a
   real `.pptx` (`pptxgenjs`) with native chart objects (revenue trend, top
   items) and a stock-health table — not screenshots, not plain text.
9. **Memory across sessions.** `Preference` is a plain Postgres table keyed
   by `chatId`, loaded fresh on every turn and injected into the system
   prompt. `/new` clears `ConversationState.history` only — `Preference` rows
   are never touched, so standing preferences (default payment mode,
   preferred brand, shop name/GSTIN) survive a fresh chat by construction.

---

## What the owner can do (capability map)

These are capabilities the model composes from tools — not fixed commands.

| Intent | Example message | Tool(s) involved |
|---|---|---|
| Receive stock | *"50 packets of Maggi came in, cost ₹12, MRP ₹14"* | `receiveStock` |
| Add a new product | *"new item: Amul Butter 100g, GST 12%, MRP ₹62"* | `addProduct` |
| Cut a bill | *"make a bill: 2kg sugar, 1 Aashirvaad atta 5kg, 4 Maggi, 1 Amul butter, UPI"* | `startBill` → `addItemToBill` (×N) → `finalizeBill` |
| Edit a bill mid-build | *"drop the butter, make it 6 Maggi"* | `removeItemFromBill`, `addItemToBill` |
| Stock query | *"how much sugar is left?"* | `getProduct` |
| Low-stock / reorder | *"what's running out?"* | `lowStockReport` |
| Credit (khata) | *"put ₹500 on Ramesh's credit" / "Ramesh paid ₹300" / "Ramesh's balance?"* | `addCredit`, `recordKhataPayment`, `getKhataBalance` |
| Daily close | *"today's sales?" / "close the day"* | `dailyClose` |
| Invoice as PDF | *"send me that bill as a PDF"* | `generateInvoicePdf` |
| Analysis deck | *"make this week's sales analysis deck"* | `generateAnalysisDeck` (via `salesForRange` + `lowStockReport`) |
| Set a preference | *"always assume UPI unless I say cash" / "default atta = Aashirvaad 5kg"* | `setPreference` |

When a request is genuinely ambiguous (e.g. *"add atta"* when multiple atta
products exist, or none do), the model asks a clarifying question — this
comes from the system prompt's instructions to the model, not a hardcoded
branch in code.

---

## Setup & running it yourself

**Requirements:** Node 20+, a Postgres database (Supabase, Neon, or local —
row locking is required, so it must be Postgres, not SQLite), a Telegram bot
token from [@BotFather](https://t.me/BotFather), and a publicly reachable URL
(Vercel in production, `ngrok` for local testing).

**1. Environment variables** (no `.env.example` is checked in — create `.env` with):

```bash
DATABASE_URL=postgres://...              # Postgres connection string
TELEGRAM_BOT_TOKEN=...                   # from @BotFather
TELEGRAM_WEBHOOK_SECRET=...              # any random string; verified on every webhook call
PUBLIC_APP_URL=https://your-deployment   # used only by scripts/set-webhook.ts
SHOP_NAME=My Kirana Store                # printed on invoices
SHOP_GSTIN=...                           # optional, printed on invoices
SHOP_ADDRESS=...                         # optional, printed on invoices
GROQ_API_KEY=...                         # current model provider
# ANTHROPIC_API_KEY=...                  # needed once lib/agent.ts is switched to the Anthropic provider
```

**2. Install, migrate, run:**

```bash
pnpm install
pnpm exec prisma generate
pnpm run db:push        # pushes prisma/schema.prisma to Postgres
pnpm run dev            # local dev server on :3000
```

**3. Point Telegram at the webhook** (needs a public URL — use `ngrok http 3000`
for local testing, or your Vercel deployment URL in production):

```bash
pnpm run set-webhook    # registers PUBLIC_APP_URL/api/telegram/webhook with Telegram
```

**4. Message the bot** — [@StorePilotAIBot](https://t.me/StorePilotAIBot) — and start
running the store.

---

## Demo script

The recorded walkthrough covers, in order:

1. Receive stock for a couple of SKUs.
2. Build a multi-item bill across several messages, including an edit
   ("drop the butter, make it 6 Maggi").
3. Attempt to oversell a product — refused at the tool layer.
4. A full khata cycle: put an amount on a customer's credit, check their
   balance, record a payment.
5. Generate a PDF invoice for a finalized bill.
6. Generate a PPTX analysis deck for a date range.
7. Set a standing preference, send `/new`, and show the preference still
   applies in the fresh conversation.

---

## Known limitations / what I'd harden next

- **Model provider:** currently running on Groq (`openai/gpt-oss-120b`) for
  cost-free iteration; the Anthropic provider is wired but commented out in
  `lib/agent.ts` and is the intended provider for the reviewed deployment.
- **Invoice/deck layout** is functional and GST-correct but not visually
  branded — listed as a stretch goal in the brief, not attempted here.
- **`viewDraftBill`** returns structured data to the model, but the bill
  summary the owner sees in chat is composed by the model's reply text
  rather than a fixed, Telegram-native formatted table.
- **Credit-funded bills:** `finalizeBill` currently only handles CASH / UPI /
  CARD; billing an item directly onto a customer's khata in one step (rather
  than finalizing cash/UPI/card and separately calling `addCredit`) isn't
  wired end-to-end yet.
- **Single Telegram bot instance, single shop.** No multi-tenant / multi-shop
  support — every chat shares one `Product` catalog by design, matching the
  "one shop, one owner" brief.

## Stretch goals not attempted

Per the brief's §7, none of the following were built (all optional):
branded/templated invoices, scheduled auto-sent weekly decks, reorder
suggestions from sales velocity, expiry/batch (FEFO) tracking, voice-note
ordering, multi-language support, barcode/photo product identification, or
khata payment reminders.