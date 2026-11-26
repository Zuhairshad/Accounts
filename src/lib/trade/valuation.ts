import { AccountingError, Exact, type EntryLine } from "@/lib/engine/model";
import {
  amountText, isReturn, isSale, lineFinancials, money, proratedPart, rateText,
  type AdjustmentCalculation, type AdjustmentInput, type InvoiceCalculation, type InvoiceInput, type ItemFacts, type TradeLine,
} from "./model";

type Decimal = InstanceType<typeof Exact>;
const decimal = (input: string | number) => new Exact(input);
type Position = { qty: Decimal; value: Decimal };
export type Move = {
  itemId: string; lineNo: number; movementKind: string; qty: string; value: string; unitCost: string;
  qtyAfter: string; valueAfter: string; averageCost: string;
};
type Source = { id: string; createdAt: Date };
export type InvoiceEvent = Source & { kind: "invoice"; input: InvoiceInput };
export type AdjustmentEvent = Source & { kind: "inventory_adjustment"; input: AdjustmentInput };
export type LegacyEvent = Source & { kind: "legacy"; input: { date: string; itemId: string; qty: string; value: string; lineNo: number } };
export type Event = InvoiceEvent | AdjustmentEvent | LegacyEvent;
type Settlement = { amount: string; date: string; endedOn: string | null };
export type Book = {
  items: Map<string, ItemFacts>;
  controls: Map<string, string>;
  allocations: Map<string, Settlement[]>;
};
export type Effect =
  | { event: InvoiceEvent; journal: EntryLine[]; moves: Move[]; calc: InvoiceCalculation }
  | { event: AdjustmentEvent; journal: EntryLine[]; moves: Move[]; calc: AdjustmentCalculation };

function position(positions: Map<string, Position>, itemId: string) {
  return positions.get(itemId) ?? { qty: decimal(0), value: decimal(0) };
}
function withdraw(current: Position, qty: Decimal) {
  return current.qty.eq(qty) ? current.value : current.qty.gt(0) ? money(qty.times(current.value).div(current.qty)) : decimal(0);
}
function stockMove(
  positions: Map<string, Position>, item: ItemFacts, qty: Decimal, value: Decimal, movementKind: string, lineNo: number,
) {
  const prior = position(positions, item.id);
  const after = { qty: prior.qty.plus(qty), value: prior.value.plus(value) };
  if (after.qty.lt(0)) throw new AccountingError(`Insufficient historical stock for ${item.name}.`);
  if (after.value.lt(0) || (after.qty.isZero() && !after.value.isZero())) {
    throw new AccountingError(`The movement would leave an invalid stock value for ${item.name}.`);
  }
  positions.set(item.id, after);
  return {
    itemId: item.id, lineNo, movementKind, qty: qty.toFixed(6), value: amountText(value),
    unitCost: rateText(qty.isZero() ? decimal(0) : value.div(qty)),
    qtyAfter: after.qty.toFixed(6), valueAfter: amountText(after.value),
    averageCost: rateText(after.qty.isZero() ? decimal(0) : after.value.div(after.qty)),
  };
}

function add(journal: EntryLine[], accountId: string | undefined | null, debit: Decimal, description: string, itemId?: string, partyId?: string) {
  if (debit.isZero()) return;
  if (!accountId) throw new AccountingError(`Configure the account for ${description} before posting.`);
  journal.push({ accountId, itemId, partyId: partyId ?? null, description,
    debit: debit.gt(0) ? amountText(debit) : "0.00", credit: debit.lt(0) ? amountText(debit.abs()) : "0.00" });
}

function itemFor(book: Book, itemId: string) {
  const item = book.items.get(itemId);
  if (!item) throw new AccountingError("An invoice or movement refers to an unavailable inventory item.");
  return item;
}

type ReturnProgress = { lines: Map<number, Decimal>; withholding: Decimal; applied: Decimal };

function invoiceEffect(
  book: Book, event: InvoiceEvent, positions: Map<string, Position>,
  known: Map<string, { event: InvoiceEvent; calc: InvoiceCalculation }>, progress: Map<string, ReturnProgress>,
): Effect & { event: InvoiceEvent; calc: InvoiceCalculation } {
  const { input } = event;
  const sale = isSale(input.type);
  const returned = isReturn(input.type);
  const direction = returned ? -1 : 1;
  const journal: EntryLine[] = [];
  const moves: Move[] = [];
  const originalId = input.originalInvoiceId;
  const original = originalId ? known.get(originalId) : undefined;
  if (originalId && (!original || original.event.input.partyId !== input.partyId || original.event.input.type !== (sale ? "sale" : "purchase"))) {
    throw new AccountingError("A return requires the matching posted original before its return date.");
  }
  if (input.exchangeReturnId) {
    const exchange = known.get(input.exchangeReturnId);
    if (!exchange || exchange.event.input.type !== "sale_return" || exchange.event.input.partyId !== input.partyId) {
      throw new AccountingError("The exchange must follow a posted sale return for this customer.");
    }
  }
  const returnedToDate = originalId ? progress.get(originalId) ?? { lines: new Map<number, Decimal>(), withholding: decimal(0), applied: decimal(0) } : undefined;
  let subtotal = decimal(0);
  let discount = decimal(0);
  let tax = decimal(0);
  const lines: TradeLine[] = input.lines.map((line, index) => {
    const item = itemFor(book, line.itemId);
    const qty = decimal(line.quantity);
    if (qty.lte(0)) throw new AccountingError("An invoice line requires a positive quantity.");
    let before = decimal(0);
    let after = qty;
    const originalLine = original && line.originalLineNo ? original.calc.lines[line.originalLineNo - 1] : undefined;
    if (original && (!originalLine || originalLine.itemId !== line.itemId)) throw new AccountingError("Select the original invoice line being returned.");
    if (line.originalLineNo && !original) throw new AccountingError("A standalone return cannot select an original line.");
    if (returnedToDate && originalLine && line.originalLineNo) {
      before = returnedToDate.lines.get(line.originalLineNo) ?? decimal(0);
      after = before.plus(qty);
      if (after.gt(originalLine.quantity)) throw new AccountingError(`Cumulative returns exceed the original quantity of ${item.name}.`);
      returnedToDate.lines.set(line.originalLineNo, after);
    }
    const { gross, discount: reduction, net, tax: levy } = lineFinancials(line, originalLine, before);
    if (net.lt(0)) throw new AccountingError("Discount cannot exceed a line’s subtotal.");
    const account = (tag: string) => book.controls.get(tag);
    let inventoryCost = decimal(0);
    if (item.kind === "stock") {
      const current = position(positions, item.id);
      if (input.type === "purchase") {
        inventoryCost = net;
        moves.push(stockMove(positions, item, qty, inventoryCost, "purchase", index + 1));
        add(journal, account("inventory"), net, "Inventory purchased", item.id);
      } else if (input.type === "sale") {
        inventoryCost = withdraw(current, qty);
        moves.push(stockMove(positions, item, qty.negated(), inventoryCost.negated(), "sale", index + 1));
        add(journal, account("cogs"), inventoryCost, "Cost of goods sold", item.id);
        add(journal, account("inventory"), inventoryCost.negated(), "Inventory issued", item.id);
      } else if (input.type === "sale_return") {
        inventoryCost = originalLine ? proratedPart(originalLine.inventoryCost, originalLine.quantity, before, after) : money(qty.times(line.historicalCost));
        if (line.disposition === "saleable") {
          moves.push(stockMove(positions, item, qty, inventoryCost, "sale_return", index + 1));
          add(journal, account("inventory"), inventoryCost, "Returned saleable inventory", item.id);
        } else add(journal, account("inventory_loss"), inventoryCost, "Returned damaged inventory loss", item.id);
        add(journal, account("cogs"), inventoryCost.negated(), "Reverse original cost of goods sold", item.id);
      } else {
        inventoryCost = withdraw(current, qty);
        moves.push(stockMove(positions, item, qty.negated(), inventoryCost.negated(), "purchase_return", index + 1));
        add(journal, account("inventory"), inventoryCost.negated(), "Inventory returned to supplier", item.id);
        add(journal, account("purchase_return_variance"), inventoryCost.minus(net), "Purchase return cost variance", item.id);
      }
    } else if (!sale) {
      add(journal, originalLine?.purchaseAccountId ?? line.purchaseAccountId, net.times(direction), "Service purchase or return", item.id);
    }
    if (sale) add(journal, account(returned ? "sales_returns" : "sales"), net.times(-direction),
      returned ? "Sales return" : "Sales revenue", item.id);
    subtotal = subtotal.plus(gross);
    discount = discount.plus(reduction);
    tax = tax.plus(levy);
    return {
      itemId: item.id, quantity: qty.toFixed(6), rate: rateText(decimal(originalLine?.rate ?? line.rate)),
      description: line.description, unitLabel: originalLine?.unitLabel ?? line.unitLabel ?? item.unit,
      originalLineNo: line.originalLineNo, subtotal: amountText(gross), discount: amountText(reduction),
      tax: amountText(levy), amount: amountText(net.plus(levy)), inventoryCost: amountText(inventoryCost),
      disposition: line.disposition, purchaseAccountId: originalLine?.purchaseAccountId ?? line.purchaseAccountId ?? null,
    };
  });
  const total = subtotal.minus(discount).plus(tax);
  const withholding = decimal(input.withholding);
  if (returnedToDate && original) {
    returnedToDate.withholding = returnedToDate.withholding.plus(withholding);
    if (returnedToDate.withholding.gt(original.calc.withholding)) throw new AccountingError("Return withholding exceeds the original withheld amount.");
  }
  const settled = input.payments.reduce((sum, payment) => sum.plus(payment.amount), decimal(0));
  const partyAmount = total.minus(settled).minus(withholding);
  if (partyAmount.lt(0)) throw new AccountingError("Payments, refunds and withholding cannot exceed the document total.");
  const sign = (sale ? 1 : -1) * direction;
  add(journal, book.controls.get(sale ? "output_tax" : "input_tax"), tax.times(-sign), sale ? "Sales tax" : "Input tax");
  add(journal, book.controls.get(sale ? "withholding_receivable" : "withholding_payable"), withholding.times(sign), "Withholding");
  add(journal, book.controls.get(sale ? "receivable" : "payable"), partyAmount.times(sign), sale ? "Customer control" : "Supplier control", undefined, input.partyId);
  for (const payment of input.payments) add(journal, payment.accountId, decimal(payment.amount).times(sign), returned ? "Refund" : "Invoice payment");
  let appliedCredit = decimal(0);
  if (original && originalId && returnedToDate) {
    const allocated = (book.allocations.get(originalId) ?? []).filter((row) => row.date <= input.date && (!row.endedOn || row.endedOn > input.date))
      .reduce((total, row) => total.plus(row.amount), decimal(0));
    const originalAvailable = decimal(original.calc.partyAmount).minus(allocated).minus(returnedToDate.applied);
    appliedCredit = Exact.min(partyAmount, Exact.max(originalAvailable, 0));
    returnedToDate.applied = returnedToDate.applied.plus(appliedCredit);
    progress.set(originalId, returnedToDate);
  }
  const calc: InvoiceCalculation = {
    lines, subtotal: amountText(subtotal), discount: amountText(discount), tax: amountText(tax), withholding: amountText(withholding),
    total: amountText(total), settled: amountText(settled), partyAmount: amountText(partyAmount), appliedCredit: amountText(appliedCredit),
  };
  known.set(event.id, { event, calc });
  return { event, journal, moves, calc };
}

function adjustmentEffect(book: Book, event: AdjustmentEvent, positions: Map<string, Position>): Effect {
  const { input } = event;
  const item = itemFor(book, input.itemId);
  if (item.kind !== "stock") throw new AccountingError("Inventory adjustments apply only to stock items.");
  const current = position(positions, item.id);
  const physical = ["count", "opening_correction"].includes(input.kind) ? decimal(input.physical) : null;
  const outbound = ["deduct", "damaged", "lost"].includes(input.kind);
  const qty = physical ? physical.minus(current.qty) : input.kind === "valuation" ? decimal(0) : decimal(input.quantity).times(outbound ? -1 : 1);
  if (input.kind === "opening" && positions.has(item.id)) throw new AccountingError("Initial opening stock must precede other stock movements.");
  if (qty.isZero() && !physical && input.kind !== "valuation") throw new AccountingError("Enter a positive adjustment quantity.");
  const value = input.kind === "valuation" ? decimal(input.valueChange) : qty.lt(0) ? withdraw(current, qty.negated()).negated()
    : money(qty.times(input.rate));
  if (input.kind === "valuation" && (value.isZero() || current.qty.isZero())) throw new AccountingError("Enter a nonzero valuation change for stock on hand.");
  const journal: EntryLine[] = [];
  const note = input.kind === "valuation" ? "Inventory valuation" : "Stock adjustment";
  add(journal, book.controls.get("inventory"), value, note, item.id);
  add(journal, input.offsetId, value.negated(), "Adjustment offset", item.id);
  const moves = qty.isZero() && value.isZero() ? [] : [stockMove(positions, item, qty, value, input.kind, 1)];
  return {
    event, journal, moves, calc: {
      previous: current.qty.toFixed(6), physical: physical?.toFixed(6) ?? null,
      difference: qty.isZero() ? "0" : qty.toFixed(6), value: amountText(value),
      unitCost: rateText(qty.isZero() ? decimal(0) : value.div(qty)),
    },
  };
}

export function replayInventory(events: Event[], book: Book): Effect[] {
  const ordered = [...events].sort((a, b) => a.input.date.localeCompare(b.input.date) ||
    Number(b.kind === "inventory_adjustment" && b.input.kind === "opening") - Number(a.kind === "inventory_adjustment" && a.input.kind === "opening") ||
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id) ||
    (a.kind === "legacy" && b.kind === "legacy" ? a.input.lineNo - b.input.lineNo : 0));
  const positions = new Map<string, Position>();
  const invoiceBook = new Map<string, { event: InvoiceEvent; calc: InvoiceCalculation }>();
  const progress = new Map<string, ReturnProgress>();
  const effects: Effect[] = [];
  for (const event of ordered) {
    try {
      if (event.kind === "invoice") effects.push(invoiceEffect(book, event, positions, invoiceBook, progress));
      else if (event.kind === "inventory_adjustment") effects.push(adjustmentEffect(book, event, positions));
      else {
        const { itemId, qty, value, lineNo } = event.input;
        const item = itemFor(book, itemId);
        if (decimal(qty).lt(0) && !withdraw(position(positions, itemId), decimal(qty).abs()).negated().eq(value)) {
          throw new AccountingError(`The change would revalue an imported stock movement for ${item.name}. Reconcile that history before changing it.`);
        }
        stockMove(positions, item, decimal(qty), decimal(value), "legacy", lineNo);
      }
    } catch (error) {
      if (error instanceof AccountingError) throw new AccountingError(`${error.message} Accounting date ${event.input.date}.`);
      throw error;
    }
  }
  // Each persisted customer or supplier allocation stays covered after return credit recomputation.
  for (const [id, rows] of book.allocations) {
    const posted = invoiceBook.get(id);
    if (!posted) continue;
    const stillAllocated = rows.filter((row) => !row.endedOn).reduce((total, row) => total.plus(row.amount), decimal(0));
    if (stillAllocated.plus(progress.get(id)?.applied ?? 0).gt(posted.calc.partyAmount)) {
      throw new AccountingError("The change overlaps existing invoice allocations. Release or reconcile those allocations first.");
    }
  }
  return effects;
}
