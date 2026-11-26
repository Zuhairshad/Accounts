# AZAM EASY ACCOUNTS V4.0

Multi-company accounting web application with invoicing, inventory, reporting, digital registers, independent financial
reconciliation and a legacy SQLite migration utility.

| Guide | For |
|---|---|
| [FINAL_REPORT.md](FINAL_REPORT.md) | Phase 5 completion report: features, test results, security, limitations, readiness |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Neon + Vercel production setup and go-live checklist |
| [docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md) | PITR, encrypted backups, restore drills, disaster recovery |
| [docs/LEGACY_MIGRATION.md](docs/LEGACY_MIGRATION.md) | Importing `azam_accounts_v2.db` |
| [docs/ACCOUNTANT_MANUAL.md](docs/ACCOUNTANT_MANUAL.md) | Daily accounting use |
| [docs/ADMIN_MANUAL.md](docs/ADMIN_MANUAL.md) | Users, roles, security model, routine operations |

## Run with an isolated Neon database

Use Node.js 24 and the committed dependency lockfile. In Neon, create a development branch or an independent project, a database owner for migrations and a separate unprivileged PostgreSQL login without owner membership. Copy `.env.example` to `.env.local` and configure it privately. Use the direct owner URL for `DATABASE_MIGRATION_URL` and the pooled runtime URL for `DATABASE_URL`. Use TLS certificate verification on both. Generate an independent `NEXTAUTH_SECRET` for every environment.

```sh
npm ci
npm run db:migrate
npm run db:grant-runtime -- azam_app
```

Legacy data: `npm run legacy -- inspect|dry-run|import|withdraw` (see [docs/LEGACY_MIGRATION.md](docs/LEGACY_MIGRATION.md)).

Bootstrap the first administrator with a one-time value supplied via stdin and the migration owner connection. The following is a Bash example. Passwords are absent from shell arguments and command history.

```bash
read -r -s -p 'Initial administrator password: ' initial_password
printf '\n'
printf '%s\n' "$initial_password" | DATABASE_URL="$DATABASE_MIGRATION_URL" npm run admin:bootstrap -- your-admin 'Your Name'
unset initial_password
npm run dev
```

Export the owner URL to the shell before that bootstrap command, then remove it from the shell. Bootstrap creates the three starter companies, default roles and default chart accounts atomically. Sign in and change the initial password. Open Company directory to create additional companies, provision users and assign users to company roles.

## Set up accounting

In the company settings, add the actual financial year. Open **Accounting modules** and **Period close and approvals** to create an open period covering the posting date. The same page configures manual approvals and the equity offset for opening balances. Default approval is direct posting by an authorized user.

Open **Vouchers** for entry, editing, duplicate drafts, PDF and the recycle bin. The module directory links the chart, party master, bulk openings, ledgers, party reports, allocation and explicitly confirmed legacy-party repairs.

## Invoices and inventory

Open **Invoices** or choose one of the four trade modules from **Accounting modules**. Use a posted invoice to create a linked item return. Invoice settings allow authorized users to enable manual tax and withholding fields. The inventory module provides item openings, dated stock ledgers and the adjustment register. Read the posting, return-credit and moving-average policies in [ACCOUNTING_RULES.md](ACCOUNTING_RULES.md).

## Reports and registers

Open **Reports and registers** from the company workspace. Daily MIS offers **Account-wise Summary** and **Voucher Number Wise Detail**. Use the company selector for authorized comparisons and the report settings to map equivalent accounts. Drafts and voided entries are visible in authorized audit views. The approvals permission also grants access to historical voucher reports.

Use **Day Book** or **Sale / Purchase** for the original seven-column registers. Enter informational rows in the editable table. Choose **Accounting entry** to attach a source or post a new transaction with the required information. Edit the source voucher or invoice to revise a linked entry. Use **Print Preview**, **Blank template**, or the download buttons for paper and digital copies. See [ACCOUNTING_RULES.md](ACCOUNTING_RULES.md) for balances, return signs and cross-company rules.

## GitHub and Vercel

Connect the repository to a Vercel project using Node.js 24 and the default Next.js preset. Configure the pooled `DATABASE_URL`, `NEXTAUTH_SECRET`, and the exact HTTPS application origin in `NEXTAUTH_URL`. Use separate credentials and a separate Neon branch for preview deployments. Run migrations through the direct owner connection from an authorized operator or release job before the deployment that depends on them. The Vercel runtime only needs the restricted application login. Set a gateway or WAF rate limit on the credentials endpoint, particularly if using a platform other than Vercel. On Vercel the application adds a platform-forwarded IP bucket to the per-account database limiter.

## Financial reconciliation

**Reports and registers → Financial reconciliation** (requires the export permission) independently recomputes journal
balance, single source postings, invoice and COGS postings, AR/AP against party balances, inventory against the stock
ledger, and the Trial Balance, Balance Sheet, Profit & Loss, Daily MIS and net sales, with links to affected records. It
never changes data.

## Checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Set `AZAM_TEST_DATABASE_URL` to a migrated disposable PostgreSQL/Neon database named with the `_test` suffix to enable integration tests. Set `AZAM_E2E_ADMIN` and `AZAM_E2E_PASSWORD` to a newly bootstrapped test administrator, and set application env for the same isolated database. The accounting browser scenarios also use the owner test URL in `AZAM_TEST_DATABASE_URL` for fixture setup and the restricted runtime URL for the application. See the GitHub verification workflow for the automated setup.

## Recovery

Neon point-in-time recovery plus the scheduled encrypted backup workflow (`.github/workflows/backup.yml`) and an isolated
restore drill (`scripts/restore-drill.sh`). See [docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md).

For implemented and deferred work see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
