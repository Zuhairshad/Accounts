# Production deployment

Target: **Vercel** (Next.js, Node.js 24) + **Neon PostgreSQL**. Every step that needs credentials is performed by an
authorized operator; no secret belongs in the repository, in this document or in shell history.

> Status (27-11-2026): **deployed** at https://azam-easy-accounts.vercel.app (Vercel project `azam-easy-accounts`,
> functions in `sin1`) on Neon project `azam-easy-accounts` (AWS ap-southeast-1, PostgreSQL 18, database `azam_accounts`,
> branch `production`, 6-hour PITR on the free plan). Migrations 0000–0013 and runtime grants are applied; the Super Admin
> `admin` must change the temporary password at first sign-in. Backups, the restore drill on Neon and the accountant
> approvals in the go-live checklist are still outstanding. The database is not yet approved for live financial use.

## 1. Neon

1. Create a Neon project in the region closest to the office (e.g. AWS ap-south-1 or ap-southeast-1). PostgreSQL 16–18.
2. Branches: `production` (default), `staging`, and short-lived `preview-*` branches. Never point a preview or test at `production`.
3. Roles, on each branch:
   - `azam_owner` – owns the schema; used only for migrations, grants, bootstrap and the legacy importer (direct, unpooled URL).
   - `azam_app` – runtime login; **not** a member of the owner role (pooled URL). Created once: `CREATE ROLE azam_app LOGIN PASSWORD '…'`.
   - `azam_backup` – read-only role for the backup job (see BACKUP_AND_RECOVERY.md).
4. Set PITR history retention (Project settings → Storage) to the business recovery window (see recovery guide).
5. Use `sslmode=verify-full` on every connection string.

## 2. Environment variables

| Variable | Where | Value |
|---|---|---|
| `DATABASE_URL` | Vercel (Production/Preview, separately) | Pooled URL for `azam_app` on the matching branch |
| `NEXTAUTH_SECRET` | Vercel, per environment | `openssl rand -base64 48`, unique per environment |
| `NEXTAUTH_URL` | Vercel | Exact HTTPS origin, e.g. `https://accounts.example.com` |
| `DATABASE_MIGRATION_URL` | Operator terminal / release job only — **never** in Vercel | Direct URL for `azam_owner` |

`.env.example` is the template for local development. `.env.local` is git-ignored.

## 3. Database migrations and grants (operator terminal)

```bash
npm ci
read -r -s -p 'Owner URL: ' DATABASE_MIGRATION_URL; export DATABASE_MIGRATION_URL; printf '\n'
npm run db:migrate                     # applies drizzle/0000 … 0013 in order (forward-only)
npm run db:grant-runtime -- azam_app   # re-run after every migration release
unset DATABASE_MIGRATION_URL
```

Run migrations **before** deploying the code that depends on them. Never use `drizzle-kit push` against Neon.
Migration 0013 makes audit history append-only for every role; this is intentional.

## 4. First administrator

```bash
read -r -s -p 'Initial administrator password (15+ chars): ' initial_password; printf '\n'
printf '%s\n' "$initial_password" | DATABASE_URL="$DATABASE_MIGRATION_URL" npm run admin:bootstrap -- your-admin 'Your Name'
unset initial_password
```

This creates the Super Admin and the three starter companies (AZAM ENTERPRISES, SAKOON / KHAWAB, ABDULLAH TRADERS) with
their chart and roles. The administrator must change the password at first sign-in. Create individual users from
**Company directory**; never share accounts.

## 5. Vercel

1. Import the GitHub repository; framework preset Next.js; Node.js 24.
2. Add the variables from section 2 per environment. Preview uses the `staging` branch credentials.
3. Add a firewall/rate-limit rule for `POST /api/auth/callback/credentials` (e.g. 20 requests/minute per IP).
4. Attach the custom domain; Vercel serves HTTPS and HSTS. The app also sends HSTS, CSP and frame protection.

## 6. Build and test commands (CI runs all of these on every push)

```bash
npm run typecheck
npm test                       # Vitest; PostgreSQL suites need AZAM_TEST_DATABASE_URL (a *_test database)
npm run build
npx playwright install chromium
npm run test:e2e               # needs AZAM_E2E_ADMIN/AZAM_E2E_PASSWORD and an isolated database
```

## 7. Go-live checklist

- [ ] Migrations 0000–0013 applied to production; runtime grants applied; app role confirmed non-owner.
- [ ] Super Admin bootstrapped; password changed; individual user accounts and roles assigned.
- [ ] Financial years and periods configured per company with accountant approval.
- [ ] Neon PITR window set; backup workflow enabled; first encrypted backup uploaded; **restore drill passed on staging**.
- [ ] Legacy data imported (if applicable) through the documented dry-run → approval → import procedure, and the
      reconciliation sign-off recorded (LEGACY_MIGRATION.md).
- [ ] Accountant approval of: opening balances, return costing policy, Day Book conventions, tax/withholding configuration,
      migration reconciliation and the first set of final financial statements.
- [ ] Financial reconciliation dashboard shows no discrepancies for every company (or each is documented and approved).
- [ ] Smoke test on the production URL: sign in, post and void a test voucher in a test company, export a PDF.
