# Database schema

The Drizzle definition is `src/db/schema.ts`. Apply the migrations in `drizzle/` in order. The hand-written migrations contain PostgreSQL views, exclusions and triggers that are managed by reviewed SQL. Development uses forward migrations and never uses schema push against production.

| Domain | Relations and guarantees |
|---|---|
| Identity | `users`, `login_attempts`, `company_roles`, `company_members`. Roles are company-local and membership links both company and role. Per-user session version provides password-change revocation. |
| Company | `companies`, `company_settings`, `financial_years`, `accounting_periods`. Company names are unique case-insensitively. Date ranges cannot overlap inside one company. |
| Master data | `accounts`, `parties`, `inventory_items`, `inventory_units`. Accounts have tenant-local parents and liquidity classification. Party identities and system account controls are permanent. |
| Ledger | `voucher_documents`, `voucher_versions`, `vouchers`, `journal_lines` and `effective_vouchers`. The document retains the public number and points to its active immutable journal. Deferred checks enforce balanced postings and matched originating sources. Official reports use the view. |
| Trade | `invoices`, `invoice_lines`, `payment_allocations`. An invoice type identifies sales/purchase returns, with an optional company-local original invoice reference. Allocations point to immutable journal lines. Dated release events preserve as-of invoice aging. Trade source authoring extends the shared posting service. |
| Inventory and opening values | `stock_movements`, `inventory_valuations`, `inventory_adjustments`, `opening_balances`. Posted stock workflows will link inventory, valuation and journal writes in one transaction. |
| Registers | `day_book_entries`, `sale_purchase_register_entries`. These reference the canonical journal line or invoice, avoiding a separate source for financial amounts. |
| Reliable writes and traceability | `document_sequences`, `idempotency_requests`, `transaction_revisions`, `deleted_records`, `restoration_history`, `audit_logs`, `report_settings`, `migration_backup_history`. |

## Access boundary

The application is the identity boundary for pooled connections. Server queries enforce the authorized company and the application database role is shared across the tenant rows it can read. PostgreSQL composite keys independently block cross-company links. The runtime grants permit service-controlled accounting transactions and prohibit destructive deletes on financial records. The shared role does not implement per-request database RLS. Database credentials must remain server-side and separate from migration and backup roles.

The application uses a small PostgreSQL pool. Atomic write services hold a transaction on one connection. Company mutations serialize on the company row, use optimistic versions for profile and role updates, and write audit events before commit. Company summaries use exact SQL aggregation. A statement or connection failure produces an uncertain-save message when commit was not confirmed.

Apply Phase 2 migrations before updating the runtime grants with `npm run db:grant-runtime -- azam_app`. Existing physical postings remain effective unless explicitly mapped to a logical document.

## Phase 3 additions

`invoices` retains the accounting identity, current posting pointer, submission payload and current calculated totals. `invoice_lines.posting_voucher_id` identifies immutable item lines of each posted revision. A void leaves the posted snapshot visible for authorized review and removes it from the official accounting view. Sale returns and purchase returns use the tenant-local original invoice, and exchange sales use a tenant-local sale return.

`stock_movements` and `inventory_valuations` are immutable per posting revision. Inventory reads project only moves whose voucher is in `effective_vouchers`. `inventory_adjustments` retains the separately numbered accountable source, typed adjustment input and derived quantity and value. The initial opening is unique per company and item. Official journal lines and posted trade sources are referenced in `day_book_entries` and `sale_purchase_register_entries`. Readers use official posting state to suppress voided and superseded activity.

Apply migrations `0006` through `0009` before reapplying the restricted database grants. No extra production store is introduced.

## Phase 4 reporting and register migrations

- Migration 0010 defines company-scoped account mappings, manual register rows and the voucher timeline. The register stores an optimistic version, lifecycle state, validated JSON payload, and at most one company-scoped voucher or invoice link. A source can be linked to only one manual row per company and register.
- Migration 0011 backfills the timeline from voucher history and captures future document changes in the posting transaction. Historical official balances select the latest state recorded by the requested instant and use the original immutable journal lines.
- The existing transaction revision, audit, idempotency and restoration tables record register mutations. Company report settings retain print layout and the Day Book perspective. Reapply the runtime grants after the migrations.
