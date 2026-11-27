# AZAM EASY ACCOUNTS V4.0 — Final project completion report (Phase 5)

Date: 26-11-2026 · Branch: `claude/clever-gauss-m8zc7i`

## Summary

The Phase 1–4 application was audited, not rebuilt. Phase 5 added an independent financial reconciliation dashboard, an
administrator-only legacy SQLite migration utility, append-only audit history, a stronger HTTP security policy, the
encrypted backup workflow and restore drill, keyboard-first entry improvements and the full documentation set. The audit
found and fixed one real accounting defect from Phase 3 and three gaps between documentation and reality.

**The application is ready for staging and accountant acceptance. It is not deployed and not yet approved for live
financial use** — see "Outstanding configuration" and "Required accountant approvals".

### Inputs available to this phase

| Input | Status |
|---|---|
| Phases 1–4 source archive | Received, committed as the first commit on this branch |
| Original desktop ZIP (`azam_easy_accounts_v2.py`, notes, scripts) | **Not supplied in this session.** The audit relied on `LEGACY_FEATURE_MAP.md`, written in Phase 1 from that ZIP |
| Two register photographs | **Not supplied in this session.** Register layouts were verified against them in Phase 4 |
| Live `azam_accounts_v2.db` | Not supplied (as in earlier phases) |
| Neon, Vercel, AWS/S3, GitHub environment secrets | Not supplied |

## Defects and gaps found by the audit

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | Stock replay crashed (`createdAt.getTime is not a function`) on **any** new managed invoice in a company that had legacy/imported stock movements; raw SQL returns timestamps as text. Would have blocked all sales and purchases immediately after migration. Never caught because no test combined imported stock with a later posting. | Critical | Fixed in `src/lib/trade/service.ts`; regression test posts a sale after a legacy import. |
| 2 | README described a "scheduled GitHub workflow" for encrypted backups that did not exist (only `scripts/backup.sh`). | High | Added `.github/workflows/backup.yml` with OIDC upload, failure alert and an independent 26-hour freshness check. |
| 3 | "Migration and recovery history" module was a placeholder tagged *Planned*. | Medium | Replaced with a working Super Admin history page showing backup freshness. |
| 4 | Audit and history tables were protected only by runtime-role grants; the owner role or a future code path could alter them. | Medium | Migration 0013: append-only triggers for every role; TRUNCATE blocked on audit logs. |
| 5 | CSP restricted only framing, plugins, base and form targets. | Low | CSP now limits scripts, connections, frames, workers and images to this origin; HSTS and COOP added. Verified with zero CSP violations in the browser suite. |
| 6 | New period badge (added in this phase) overlapped the phone top bar. | Low | Found by phone-width screenshot; fixed with a responsive second line. |

No fabricated financial data or mock production records were found: the only seeded data are the three starter
companies, the original chart of accounts and the default roles.

## Legacy feature preservation checklist

"Automated" = exercised by a passing automated test in this repository. "Review" = verified by code review only.

| Legacy feature (LEGACY_FEATURE_MAP.md) | V4 status | Evidence |
|---|---|---|
| Login / logout | Preserved, individual hashed accounts | Automated (e2e sign-in, password change, session revocation) |
| Company selection, creation, renaming, aliases | Preserved; aliases applied on import | Automated (e2e workspace; legacy alias unit test) |
| Chart of accounts and default controls | Preserved; permanent control tags | Automated (engine tests); UI by review |
| Customer / supplier master, inline creation | Preserved | Automated (e2e party + opening; trade e2e inline creation) |
| Opening balances (party, account, stock) | Preserved, versioned, approval-gated | Automated (phase 2/3/5 tests) |
| Inventory, stock ledger, moving average | Preserved with exact decimals and dated replay | Automated (phase 3, phase 5 reconciliation per item) |
| Six manual voucher types and party rules | Preserved | Automated (all six types; CRV/JV in browser) |
| Repair legacy party links | Preserved; importer routes unlinked lines here | Automated (phase 2; legacy import tests) |
| Sales / purchase invoices with stock checks | Preserved; normalized headers and lines | Automated (phase 3, phase 5, e2e) |
| Voucher and invoice registers, delete/restore | Preserved; void/restore audited, numbers never reused | Automated (phase 5 lifecycle) |
| General and party ledgers | Preserved; opening-credit bug of the original fixed | Automated (phase 4, e2e) |
| Debtors / creditors aging, combined list | Preserved; allocation-based aging | Automated (phase 2/4) |
| Trial Balance, P&L, Balance Sheet | Preserved; reconciled to the journal | Automated (phase 4; phase 5 reconciliation) |
| Daily MIS | Preserved | Automated (phase 4; MIS = GL reconciliation check) |
| Combined company report | Preserved (company-wise and mapped consolidated) | Automated (phase 4 e2e) |
| Report preview and printing | Preserved; PDF, Excel, CSV added | Automated (phase 4 e2e: on-screen = file totals) |
| Backup / restore / database check | Replaced by PITR + encrypted backups + restore drill | Drill executed locally; real infrastructure pending |
| Date formats DD-MM-YYYY etc. | Preserved for import; displayed DD-MM-YYYY | Automated (legacy date tests) |
| Day Book and Sale / Purchase registers | Digital registers with print templates | Automated (phase 4 e2e) |

## New feature checklist (Phase 5)

| Feature | Status | Evidence |
|---|---|---|
| Financial reconciliation dashboard (authorized, read-only, linked discrepancies) | Done | Vitest + e2e |
| Legacy SQLite migration utility (inspect, dry run, import, withdraw) | Done; mapping for the real DB unverified | Vitest (synthetic fixtures) + CLI smoke test |
| Append-only audit history | Done | Vitest (owner role refused) |
| CSP / HSTS hardening | Done | e2e with CSP violation capture |
| Encrypted backup workflow with alerts | Done, inactive until configured | Workflow reviewed; not executed (no cloud credentials) |
| Restore drill + books fingerprint | Done | Executed locally: 143 companies matched; guards verified |
| Keyboard shortcuts, Enter-advance, search-to-select, period badge | Done | e2e |
| Deployment, recovery, migration, accountant and admin manuals | Done | `docs/` |

## Database architecture

PostgreSQL (Neon in production) with 14 forward-only migrations (`drizzle/0000`–`0013`). Each company's data is isolated by
composite `(company_id, id)` keys. Posted vouchers and journal lines are immutable; corrections create new versions and
the `effective_vouchers` view exposes only the current posting of each document. Database triggers enforce balanced
postings, open periods and years, party/control matching, source integrity for invoice and adjustment journals, and
(new) append-only history. The web runtime uses a restricted role; migrations, bootstrap and legacy imports use the owner
role, never configured in Vercel. See DATABASE_SCHEMA.md.

## Accounting reconciliation results

The reconciliation engine (`src/lib/audit/reconcile.ts`) runs 14 checks per company: balanced vouchers; single source
posting; invoice settlement and revenue totals; COGS against issued cost; AR and AP against party subledgers; inventory GL
against the stock ledger per item; Trial Balance; Balance Sheet; Profit & Loss against the journal; Daily MIS against the
General Ledger; net sales against invoices; allocation validity; postings inside their periods.

- A full trading cycle (openings, partial payments, fractional quantities, 3-decimal rates, saleable and damaged sale
  returns, purchase return, receipt, stock count, void, restore) — **all 14 checks pass**.
- After **every** lifecycle step in the lifecycle suite (draft, post, revise, void, restore, repeated restore, voucher
  revise/void/restore, closed-period refusals, rollback, parallel posting, edge values, advances) — **all checks pass**.
- Injected discrepancies are detected with exact amounts: an unattributed PKR 75 inventory JV (inventory −75.00), a
  PKR 300 receivable without a customer (AR 300.00 vs 0.00) and sales posted outside invoices (net sales 300.00).
- Production data has not been reconciled because none exists yet.

## Automated test results (executed, from an empty database)

| Step | Result |
|---|---|
| Migrations 0000–0013 on a fresh PostgreSQL 16 database; runtime grants; bootstrap | Passed |
| `npm run typecheck` | Passed |
| `npm test` (Vitest, 9 files) | **60 / 60 passed** (33 from Phases 1–4, 27 new) |
| `npm run build` (production) | Passed |
| `npm run test:e2e` (Playwright, Chromium, restricted runtime role) | **8 / 8 passed** in the clean run (6 existing, 2 new); one intermittent failure noted below |
| Restore drill (age-encrypted dump → isolated restore → fingerprint) | Passed; both safety guards refused unsafe targets |
| Legacy CLI smoke test (inspect, dry run, import guard) | Passed |

Observations reported for completeness:
- **Open item — intermittent autosave failure.** `reports.spec.ts` (Day Book autosave) failed in 2 of 12 runs. In both,
  the description typed first into a new register row was not saved, while the amount and reference typed afterwards
  were. This may be a real autosave race that can drop typed text. Ruled out: CPU load (4/4 passed under full load), a
  delayed post-link refresh (a control run passed), the new Enter-key handler and the CSP. Not ruled out: that it predates
  Phase 5 (the browser suite was not run before Phase 5 changes in this environment). CI now keeps and uploads a
  Playwright trace for every failed test; investigate the first captured trace before relying on the registers for live entry.
- `workspace.spec.ts` consumes the bootstrapped administrator's one-time password, so it passes only once per bootstrap
  (as documented in TEST_PLAN.md). CI bootstraps a fresh database every run.
- Local runs used Node.js 22 and PostgreSQL 16; CI and production target Node.js 24 and PostgreSQL 18. CI has not been
  observed running this branch from this session.

## Security audit results

| Area | Result |
|---|---|
| Authentication, password hashing | scrypt (N=32768, per-user salt), constant-time compare with dummy salt for unknown users; 15-character minimum; forced first-login change |
| Sessions | Encrypted JWT, 8-hour limit, re-validated against the database (active flag, session version) on every request |
| Server-side RBAC | Every mutation re-authenticates, locks actor and company, checks company role in the same transaction; delegation cannot exceed the grantor; no self-assignment |
| Company isolation / IDOR | Company-scoped queries plus composite foreign keys; tests confirm another company's accounts, parties and invoices are rejected or invisible; report scope re-checked per company |
| SQL injection | Parameterized queries throughout; the legacy importer only uses identifiers verified against the SQLite schema |
| XSS | React escaping; no raw HTML rendering; CSP restricts script, connect and frame sources |
| CSRF | Next.js server-action origin checks; explicit Origin check on the register API |
| Input validation | Zod schemas at every boundary; database CHECK constraints for amounts, quantities and dates |
| File handling | No user file uploads in the web app; legacy file processed only by the operator CLI, read-only |
| Export permissions / formula injection | Exports require export or print permission; CSV prefixes formula characters; XLSX writes text as literal strings (tested) |
| Credentials | Separate runtime, owner and backup roles; no secrets in source; `.env*` git-ignored; CI uses throwaway service-container credentials |
| Audit integrity | Append-only at the database level for all roles (new) |
| Log redaction | Server logs record only error class and database code, never payloads or credentials |

Residual risks: scripts need `'unsafe-inline'` because Next.js injects inline bootstrap scripts (a nonce-based CSP would be
stronger); denied workspace pages render the not-found page with HTTP 200 because of streaming (no data is rendered; API
routes return 404); IP-based login limiting applies only behind Vercel's trusted header — add a WAF rule elsewhere.

## Known limitations

1. The legacy mapping template is unverified because the original Python source and live database were not available.
2. Stock values for imported legacy sales are derived at moving average; differences from the legacy ledger are reported
   for approval, not corrected.
3. Committed imports cannot be deleted (journals are immutable); rejection means withdrawal or a point-in-time restore.
4. Reconciliation runs on demand; there is no scheduled reconciliation alert.
5. Account search filters a native select rather than a full combobox; long company names truncate in the phone top bar.
6. No offline entry; interrupted saves rely on idempotent retry and the uncertain-save message.
7. Production-scale latency (stock replay, very large exports) has not been measured on real volumes.
8. Intermittent Day Book autosave test failure (see "Automated test results"); cause not yet isolated.

## Outstanding configuration requirements

1. Neon project, branches and roles; PITR retention (docs/DEPLOYMENT.md §1).
2. Vercel project, environment variables, custom domain and login rate-limit rule (§2, §5).
3. Migrations, runtime grants and the first Super Admin on production (§3, §4).
4. Backup: S3 bucket in a separate account, OIDC role, `age` key custody, GitHub `backup` environment, `AZAM_BACKUP_ENABLED`.
5. A restore drill on real Neon infrastructure, with measured RPO/RTO.
6. Financial years and periods per company.

## Migration readiness

Ready for a **staging dry run** as soon as `azam_accounts_v2.db` and the original Python source are supplied: run
`inspect`, complete the mapping, dry run, review, approve, import into a staging branch, reconcile, then repeat on
production. Not ready for production import until the mapping has been verified against the real schema and the
accountant has signed the reconciliation.

## Deployment readiness

Deployed on 27-11-2026 to **https://azam-easy-accounts.vercel.app** (Vercel, Singapore functions) with Neon PostgreSQL 18
in Singapore. Verified on the live site: security headers (CSP, HSTS, frame denial), anonymous redirect to sign-in, and a
real sign-in by the Super Admin reaching the forced password change through the restricted database role. Still
outstanding: encrypted backup activation, a restore drill on Neon, longer PITR retention (requires a paid Neon plan),
and the accountant approvals below.

## Required accountant approvals before live use

Opening balances and their offset; return costing policy; Day Book balance convention; tax and withholding configuration;
combined-report account mappings; the legacy migration reconciliation (every accepted issue); and the first complete set
of financial statements produced by the system. Record each approval with name, role and date.
