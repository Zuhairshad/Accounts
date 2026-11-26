# Legacy SQLite migration (azam_accounts_v2.db)

Imports the desktop application's SQLite database into PostgreSQL without fabricating, regenerating or silently correcting
records. It runs only from a trusted terminal with the migration owner connection; it is not part of the web application.

> **Important limitation.** The original `azam_easy_accounts_v2.py` source and the live database were not available while
> the importer was built. No legacy table or column names are assumed. `scripts/legacy/mapping.example.json` is an
> **unverified template**; it must be completed from the `inspect` output of the real database and reviewed against the
> Python source before any dry run is trusted. The importer refuses to run when a mapped table or column does not exist.

## What it does

| Requirement | Implementation |
|---|---|
| Read-only inspection | Source opened with SQLite `readOnly` + `query_only`; SHA-256 of the file identifies it in every report |
| Schema version detection | `inspect` lists tables, columns, types, row counts, `user_version` and a schema signature hash |
| Company / account / party / inventory mapping | Mapping file; company aliases (AZAM ENTERPRISE→AZAM ENTERPRISES, AZAM TRADERS→SAKOON / KHAWAB, AZAM SERVICES→ABDULLAH TRADERS); accounts map by code onto the seeded chart |
| Vouchers and journals | Imported as legacy posted vouchers with their **original number, date, narration and lines**. No journal is regenerated |
| Invoices | Rows sharing an invoice number and voucher ID become one header with lines, linked to the existing voucher — no second financial effect |
| Opening balances | Legacy opening vouchers are imported as recorded. Item opening stock is linked to an equivalent legacy posting if one exists; otherwise an opening voucher is created **only with approval** |
| Stock movements | Derived chronologically from openings and invoice lines at moving average, linked to the source voucher |
| Document numbers | Preserved; duplicates within a company get a visible `-DUP<id>` suffix only with approval; new-format sequences are advanced past imported numbers |
| Duplicate detection | Duplicate voucher numbers, party names, item names, account codes, invoices sharing a voucher |
| Error reporting | Every anomaly is an issue with a code, severity, record reference and stated resolution |
| Rollback | The whole import is one PostgreSQL transaction. Dry run always rolls back. After commit: *withdraw* or Neon PITR |
| Repeat-import protection | A unique index allows one committed import per source SHA-256 |
| Unlinked party transactions | Control-account lines without a valid party are imported unchanged and listed for **Legacy party voucher linking** |
| Discrepancy detection | Unbalanced vouchers, orphan lines, invalid/inconsistent dates, unknown references, negative historical stock, missing stock-opening postings, invoice/voucher total differences, inventory valuation vs ledger |
| Reconciliation | Source vs target trial balance by account, party balances, invoice totals by type and record counts; then the application's Financial reconciliation per company. **Any unexplained difference aborts the import** |

### Issue severities

- **fatal** – cannot proceed and cannot be approved (mapping mismatch, account conflicts, target company not empty,
  closed period/year, already imported). Fix the mapping or target.
- **blocking** – a record cannot be imported as-is. The listed resolution (quarantine, unlink, suffix, create opening) is
  applied only when the approval file accepts that issue code and count. Quarantined rows are stored verbatim in
  `legacy_import_records.source`.
- **review** – imported exactly as recorded, but must be acknowledged (e.g. unlinked control lines, invoice/voucher
  total differences, inventory valuation differences).
- **info** – no action (e.g. zero lines omitted, stock opening linked to an existing posting).

## Procedure

1. **Never on production first.** Create a Neon branch from production (or a separate staging database) and run all
   steps there. Production is touched only by the final, approved import.
2. Copy the `.db` file to the operator machine (encrypted disk). Record its SHA-256.
3. Inspect:
   ```bash
   npm run legacy -- inspect --source azam_accounts_v2.db --out schema.json
   ```
4. Copy `scripts/legacy/mapping.example.json` to a private file and set every table/column and value mapping from
   `schema.json` and the Python source. Set `fiscalYearStartMonth` (7 = July–June). Use `companyTargets` to place a legacy
   company into a specific **empty** company (`{"companyId": "…"}`) or a new name (`{"name": "…"}`).
5. Dry run (imports and verifies inside a transaction that is always rolled back):
   ```bash
   DATABASE_MIGRATION_URL=… npm run legacy -- dry-run --source azam_accounts_v2.db --mapping mapping.json \
     --actor <super-admin-username> --out dry-run.json
   ```
   Review `dry-run.json`: `issues`, `details`, `verification.differences`, `manualReconciliation`, `inventory`, and the
   per-company `verification.reconciliation`.
6. The accountant documents a decision for every blocking and review issue and signs an approval file:
   ```json
   { "approvedBy": "Name", "role": "Chief Accountant", "approvedAt": "2026-12-01",
     "reportSha256": "<reportSha256 from the dry run>",
     "accepted": { "unbalanced-voucher": 1, "unlinked-control-line": 4 },
     "notes": "Reviewed against paper day book; JV-6 to be re-entered as approved correction." }
   ```
   `accepted` must list **exactly** the blocking and review codes and counts of that dry run. Any change to the source,
   mapping or target produces a different report hash and invalidates the approval.
7. Import (create a Neon branch or note the timestamp immediately before):
   ```bash
   npm run legacy -- import --source azam_accounts_v2.db --mapping mapping.json --actor <super-admin> \
     --approval approval.json --confirm-database <database-name> --out import.json
   ```
8. After import: run **Financial reconciliation** for each company, link the listed control lines through **Legacy
   party voucher linking**, re-enter quarantined vouchers as approved corrections, and post approved stock or valuation
   adjustments for reported inventory differences. Obtain accountant sign-off.
9. If the import is rejected after commit:
   ```bash
   npm run legacy -- withdraw --import <importId> --actor <super-admin> --reason "Rejected by accountant: …"
   ```
   This deactivates the companies the import **created** (posted journals are immutable by design and are never deleted)
   and marks the import withdrawn so the source may be re-imported. If the import used an existing empty company, restore
   the database to the pre-import timestamp (BACKUP_AND_RECOVERY.md) instead.

## Verified behaviour (automated tests, synthetic SQLite fixture)

`tests/phase5-legacy.test.ts` builds synthetic SQLite files (clearly test-only data) and proves: the source is never
written; mapping mismatches are reported precisely; a clean ledger imports with identical numbers and balances; repeat
import is refused; the dry run leaves no rows; imports without or with a mismatched approval are refused; only approved
resolutions are applied; quarantined rows keep their raw data; party tags on the wrong account are moved to the
description without changing amounts; withdrawal deactivates created companies; imports into non-empty companies are
refused; and **new invoices post correctly after migration on top of imported stock** (this test exposed and fixed a
Phase 3 defect where stock replay crashed once legacy movements existed).
