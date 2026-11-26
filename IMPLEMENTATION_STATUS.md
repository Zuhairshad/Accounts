# Phase 4 implementation status

The report center and digital registers continue the same web application and PostgreSQL schema from Phases 1–3. Reports use the effective accounting journal, posted trade and inventory movements, and authorized company scope. Daily MIS supports account summaries, voucher drill-downs and historical voucher audit views. The Day Book and Sale / Purchase registers persist drafts and edits in PostgreSQL, retain a register audit trail and use explicit financial linkage. Reports provide browser print preview and PDF, Excel and CSV downloads. Both registers provide blank print templates based on their source photographs.

Apply migrations 0010 and 0011 and reapply the restricted runtime grants. Production Neon and Vercel configuration remains pending. Historical views use transaction state from the journal timeline and current master labels. Production-scale export latency remains unmeasured.

## Verification

Migrations passed on both a fresh PostgreSQL database and an existing Phase 3 test database. The production build, 33 Vitest tests and six Chromium Playwright scenarios passed. Browser requests used the restricted runtime role. The same Profit & Loss total was verified on screen and in the downloaded PDF, Excel and CSV. Both A4 register previews and PDFs were visually compared with the source photographs. The large-report test generated a 1,800-row spreadsheet and a paginated PDF.

# Phase 3 implementation status

## Delivered

- Continued the Phase 1 and Phase 2 Git repository, authentication, Neon architecture and company controls.
- Added Sales Invoice, Purchase Invoice, Sale Return and Purchase Return. The browser workflows include drafts, posting, edit, void, restore, duplicate, search, filters, inline party and item creation, printing and PDF. The register shows one document with expandable lines and a link to its voucher.
- Added stock and service items, stock openings, quantity and valuation adjustments, and a dated stock ledger. Each posting enters the existing double-entry engine. Revision history retains the previous source, journal and movements.
- Added mixed settlement, optional entered tax and withholding amounts, approval-gated external-reference exceptions and standalone historical returns, linked exchanges and chronological inventory replay.
- Guarded changes that would exceed original quantities, create negative historical stock, affect closed periods or invalidate active dependent documents.

## Environment and boundaries

The production Neon and Vercel connections remain external configuration. No live legacy SQLite database was provided. The tests use isolated PostgreSQL. Tax eligibility and statutory rates remain accountant-reviewed inputs. Replay latency at production data volume remains unmeasured. See the README for migrations, runtime grants and deployment.

## Verification

Applied all migrations to a fresh isolated PostgreSQL database and applied the Phase 3 migrations to an existing Phase 2 test database. TypeScript, the optimized Next.js build, 27 Vitest tests and four Chromium Playwright scenarios passed. Browser workflows used the restricted runtime database role.

The acceptance case reconciled to 7 units, PKR 7,000 inventory, PKR 4,500 net sales, PKR 3,000 COGS, PKR 1,500 gross profit, PKR 4,500 customer receivable and PKR 10,000 supplier payable.
