# System administrator manual

## Roles and access

- **Super Admin** (global): creates companies and users, sees all companies, the legacy-import and backup history page.
  Bootstrapped from the terminal only. Keep to two named people.
- **Company roles** (per company): Company Admin, Accounts Manager, Accountant, Data Entry Operator, Viewer / Auditor, or
  custom roles built from: view, create, edit, delete (void), restore, post, export, print, approve, close_period,
  view_combined, manage_company, manage_users, manage_roles.
- An administrator can only delegate permissions they hold, and cannot change their own access.
- Financial reconciliation requires `export`. Historical (time-travel) and void/draft audit views require `approve`.

## Users

1. **Company directory → Provision user** (Super Admin): username, name and a temporary password (15+ characters).
2. The user must change it at first sign-in. Changing a password signs out all their sessions.
3. **Company settings → Members** assigns the user a role in each company. Removing membership takes effect immediately.
4. Deactivate leavers instead of sharing accounts. Sign-in is rate-limited per account (and per IP on Vercel).

## Companies, years and periods

- Company settings hold the name, logo URL (HTTPS), address, NTN/STRN, number prefix and padding.
- Add each **financial year** and open **accounting periods** (Accounting modules → Period close and approvals). Postings
  require an open period inside an open year. Closing and reopening periods is logged with a reason.
- Deactivating a company hides it from accounting; data is retained and it can be reactivated.

## Security model (what protects the books)

- Passwords: scrypt with per-user salt; constant-time verification. Sessions: encrypted, 8-hour JWT re-checked against the
  database on every request (password change or deactivation revokes them).
- Every write runs on the server: it re-authenticates, locks the company, checks the user's role for that company and
  runs in one database transaction. Retried requests with the same key return the original result (no duplicates).
- PostgreSQL enforces tenant isolation with composite (company, id) keys, balanced posted journals, immutable posted
  lines, open-period checks and party/control-account matching — even if application code were wrong.
- Audit logs, revisions, voucher timeline, deletions, restorations and backup/migration history are append-only at the
  database level (migration 0013).
- The web runtime uses a restricted role that cannot delete financial records; migrations and imports use a separate owner
  role that is never configured in Vercel.
- HTTP security headers: CSP restricted to this origin, HSTS, no framing, nosniff, strict referrer. CSV/Excel exports
  neutralise formula injection.

## Routine operations

| Frequency | Task |
|---|---|
| Daily | Check *Migration and recovery history* shows a backup younger than 26 hours (alerts also fire automatically). |
| Weekly | Review Financial reconciliation for each company with the Accounts Manager. |
| Monthly | Restore drill on a Neon branch (BACKUP_AND_RECOVERY.md); review users and roles; close the previous period after sign-off. |
| Each release | `npm run db:migrate` then `npm run db:grant-runtime -- azam_app` with the owner URL, **before** deploying code. |
| Yearly | Add the next financial year; rotate `NEXTAUTH_SECRET` (signs everyone out) and database passwords; test the backup key. |

See DEPLOYMENT.md, BACKUP_AND_RECOVERY.md and LEGACY_MIGRATION.md for procedures.
