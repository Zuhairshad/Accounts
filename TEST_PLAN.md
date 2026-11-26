# Test plan

| Layer | Coverage |
|---|---|
| Vitest unit | Exact debit/credit arithmetic, invalid numeric input, safe display of large balances, username normalization, salted password verification, date validation and year boundaries. |
| Vitest PostgreSQL | Tenant foreign keys, concurrent document numbering, idempotent retries, failed-post rollback, immutable posted journals, company delete protection, period/year range constraints. |
| Playwright | Anonymous redirect, administrator password change, company-scoped search, company creation and rename, user provisioning and assignment, financial-year setup and filtering, company activation, and viewer denial of cross-company and manager routes. |
| Build | Type checking and optimized Next.js production build. |
| Production acceptance | Verify restricted database grants on a Neon test branch, Vercel HTTPS session cookies, real gateway rate limits, backup upload and decryption, Neon PITR, production-equivalent restore reconciliation, and actual deployment smoke test. |

Use a disposable database with a name ending in `_test` for Vitest database tests. The tests create companies and posted journals. Playwright setup also creates data and consumes the supplied administrator's initial password. CI repeats the flow in an isolated database. Backups and recoveries should be tested with separate infrastructure and no production traffic.

Phase 2 verifies every manual voucher type, exact multi-line entries, both required opening-and-settlement examples, advances, draft exclusion, concurrent revisions and document numbering, duplicate requests, closed periods, approval permissions, explicitly confirmed legacy links, source protection, credit notes, explicit and FIFO allocation, partial settlement and dated allocation release. Playwright covers posting, void and restore, PDF, tenant scope and limited viewer permissions under a restricted PostgreSQL role.

Phase 3 tests the 10-unit purchase, 4-unit sale and 1-unit return with assertions for stock, inventory value, net sales, net COGS, gross profit and both party controls. PostgreSQL scenarios also cover duplicate supplier references, mixed payments, supplier refunds and variance, tax and withholding on services, damaged returns, cumulative quantity limits, historical shortages, closed-period replay, concurrent sales, fractional depletion, zero values, stock-count and valuation adjustments, revisions, voids and restoration. Chromium covers creating a supplier and item inside invoice entry, posting the acceptance case, reading the one-header register and exporting the linked return PDF.

## Phase 4 reporting and digital registers

Verify accounting-date boundaries, opening-only accounts, retained earnings, Trial Balance equality, stock control, returns, multiple invoice lines, aggregate mapping, and voucher time travel across a void and restoration. Use isolated PostgreSQL and the restricted runtime role for browser access. Exercise autosave with a dropped reply that follows a successful commit, a reload, a concurrent version conflict, permission boundaries, and an attempt to create a second financial entry with the same source reference. Compare screen, spreadsheet, CSV and rendered PDF totals. Compare both print previews against the supplied photographs and check pagination with 1,800 rows.

## Phase 5 audit, migration and recovery

- `tests/phase5-reconcile.test.ts`: a full trading cycle (openings, partial payments, fractional sale at a 3-decimal rate,
  saleable and damaged returns, purchase return, receipt, stock count, void and restore) passes every reconciliation check;
  injected discrepancies (unattributed inventory JV, legacy receivable without customer, sales outside invoices) are
  detected with exact amounts and links; reconciliation is proven read-only.
- `tests/phase5-lifecycle.test.ts`: create/draft/post/edit/void/restore/repeat-restore with full reconciliation after every
  step; voided numbers never reused; dependent purchase protected; viewer, cross-company and closed period/year refusals;
  rollback after a simulated failure; idempotent retry; parallel numbering; rounding; identical lines; large values;
  numeric overflow; refunds beyond credit; advances, partial and over-payments; schema-level invalid input.
- `tests/phase5-legacy.test.ts`: synthetic SQLite fixtures (test-only data) for read-only inspection, mapping validation,
  dry run, approval-bound import, repeat protection, quarantine, unlinking, withdrawal, non-empty target refusal and
  posting after migration.
- `tests/phase5-security.test.ts`: CSV/XLSX formula-injection neutralisation; append-only audit history for the owner role.
- `e2e/phase5.spec.ts`: keyboard entry, search-to-select, Enter-advance, period badge and reconciliation under the
  production CSP (no CSP violations); permission denial for reconciliation and operations history.
- Restore drill: `scripts/restore-drill.sh` with `scripts/verify-restore.sql` (manual; executed locally in Phase 5).
