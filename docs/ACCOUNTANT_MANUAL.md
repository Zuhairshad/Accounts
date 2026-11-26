# Accountant user manual

AZAM EASY ACCOUNTS V4.0 replaces the desktop program and the two paper registers (Day Book and Sale / Purchase).
Everything you post is stored centrally, numbered automatically and audited. Nothing is ever physically deleted.

## Getting around

- **Company and year** — the company selector and the current financial year are always shown in the top bar. Every
  report shows its own date range at the top; check both before posting or printing.
- **Search** — press `/` to search accounts, parties, vouchers and invoices of the selected company.
- **Keyboard** — press `?` for all shortcuts. Common ones: `n v` new voucher, `n s` new sales invoice, `n p` new purchase
  invoice, `g v` vouchers, `g i` invoices, `g r` reports, `g c` financial reconciliation.
- **Fast entry** — in voucher and invoice lines, type part of an account, party or item name in the search box above the
  list (e.g. `rec ali`) and press Enter to choose it; focus moves to the amount. In entry tables, Enter moves to the next
  field; it never posts the document. Use the **Post** button to post.
- Dates are shown as DD-MM-YYYY. Amounts accept at most two decimals; quantities six; rates ten.

## Daily work

| Paper/desktop task | In V4 |
|---|---|
| Cash/bank receipts and payments (CRV, BRV, CPV, BPV), JV, VR | **Vouchers → New voucher**. Party mode requires a customer (receipts) or supplier (payments). |
| Sales and purchase invoices | **Invoices** → choose type. Add items/parties inline. Optional payment received/paid on the invoice. |
| Returns | Open the posted invoice → **Create return**. Returns cannot exceed the original quantity. Choose *saleable* or *damaged* for sale returns. |
| Day Book register | **Reports and registers → Day Book**. Rows follow posted cash/bank activity; informational rows can be added and later linked to a posting. |
| Sale / Purchase register | **Reports and registers → Sale / Purchase**. Returns appear as negative amounts. |
| Allocating receipts to invoices | **Accounting modules → Payments, receipts and allocations**. FIFO or a specific invoice. Unallocated amounts remain as advances. |
| Opening balances | **Opening balances** (parties and accounts) and item opening stock in **Inventory**. Requires approval before go-live. |

### Drafts, approval and corrections

- Save as **draft** to finish later — drafts have no accounting effect.
- If the company requires approval, a second authorized person posts submitted drafts.
- To correct a posted document, **Edit** it and give a reason: the number stays the same, the previous version is kept
  in history and the ledger switches to the corrected posting in one step.
- **Void** removes a document's effect but keeps its number, lines and reason. **Restore** brings it back exactly once.
  Voided numbers are never reused.
- Documents in a **closed period** cannot be changed. Ask an Accounts Manager to reopen the period (logged with reason)
  or post a correction in the current period.
- An invoice with active payment allocations, posted returns or later sales that depend on its stock must be resolved
  before it can be voided. The system explains what blocks the change.

## Reports

Trial Balance, Profit & Loss, Balance Sheet, Daily MIS, General/Party/Cash-Bank ledgers, Debtors/Creditors and aging,
invoice and voucher registers, inventory valuation, stock ledger, adjustments, and company-wise/combined reports.
Every report can be printed, or downloaded as PDF, Excel and CSV; the files contain exactly the figures on screen.
Click a figure to drill down to the vouchers behind it.

## Financial reconciliation (check daily or before month-end)

**Reports and registers → Financial reconciliation** recomputes the books independently and compares them with the
reports. Each check shows *Reconciled*, *Review* or *Discrepancy*, the expected and actual figures, and links to the exact
vouchers, invoices or items involved:

- every voucher balances; no invoice or adjustment posts twice or stays active after a void;
- invoice totals equal their party/payment/withholding lines and their sales/tax lines; COGS equals issued stock cost;
- Accounts Receivable equals the sum of customer balances; Accounts Payable equals supplier balances;
- Inventory account equals the stock ledger value, item by item;
- Trial Balance, Balance Sheet, Profit & Loss and Daily MIS agree with the journal;
- net sales agree with sale and return invoices; allocations are valid; postings sit inside their periods.

The page never changes anything. Correct a discrepancy through the linked document so the correction is approved and
audited. Never post a balancing figure just to make a report agree.

## Policies the accountant must approve before live use

Opening balances and their offset account; return costing (saleable returns at original cost, damaged returns to loss,
purchase returns at carrying average with variance); Day Book balance convention (cash/bank or company-defined);
tax and withholding configuration (amounts are entered, not calculated); account mappings for combined reports;
the legacy migration reconciliation; and the first full set of financial statements.
