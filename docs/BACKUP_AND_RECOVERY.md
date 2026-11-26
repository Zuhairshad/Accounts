# Backup and recovery

Two independent layers protect production data. Neither depends on employees downloading files.

| Layer | What it protects against | Mechanism |
|---|---|---|
| Neon point-in-time recovery (PITR) | Bad deploys, mistaken bulk changes, accidental damage within the retention window | Neon history retention; restore into a new branch at a timestamp |
| Independent encrypted backups | Loss of the Neon project/account, retention expiry, provider incident | Daily `pg_dump` → `age` encryption → S3 in a separate cloud account |
| Recycle Bin (in-app) | A single voucher, invoice or adjustment voided by mistake | Void/restore with reason and audit trail; numbers preserved |

The Recycle Bin is **not** disaster recovery: it restores one document within intact books. Database recovery replaces
or rebuilds the whole database and always goes through an isolated restore first.

## Recovery objectives (to confirm with management)

- **RPO** (maximum data loss): PITR ≈ seconds within the retention window; independent backups ≤ 24 hours.
- **RTO** (time to restore service): target ≤ 4 hours. Measure it in every restore drill.
- **Retention**: PITR 7 days minimum (plan permitting); independent backups 35 daily + 12 monthly (S3 lifecycle rule).

## Independent encrypted backups

`.github/workflows/backup.yml` runs daily at 02:17 Asia/Karachi and on demand. It does nothing until configured.

1. **Encryption key** — on an offline machine: `age-keygen -o azam-backup.key`. Store the private key with two named
   recovery operators (password manager + sealed offline copy). Only the public recipient (`age1…`) goes to GitHub.
2. **Storage** — S3 bucket in a cloud account separate from Neon and Vercel: versioning on, Object Lock (compliance mode,
   35 days) recommended, public access blocked, lifecycle rule for retention.
3. **Upload identity** — IAM role trusted only for this repository's `backup` environment via GitHub OIDC, with
   `s3:PutObject` on the backup prefix only (no read, no delete). A separate restore role has read access.
4. **Database role** — `azam_backup`: `LOGIN`, `pg_read_all_data`, plus `INSERT ON migration_backup_history`.
5. **GitHub** — create environment `backup` (restrict to the default branch, add required reviewers if desired):
   - secrets: `AZAM_BACKUP_PGHOST`, `AZAM_BACKUP_PGDATABASE`, `AZAM_BACKUP_PGUSER`, `AZAM_BACKUP_PGPASSWORD`, optional `AZAM_ALERT_WEBHOOK_URL`
   - variables: `AZAM_BACKUP_AGE_RECIPIENT`, `AZAM_BACKUP_S3_PREFIX` (`s3://bucket/azam`), `AZAM_BACKUP_AWS_ROLE_ARN`,
     `AZAM_BACKUP_AWS_REGION`, then repository variable `AZAM_BACKUP_ENABLED=true`.
6. **Alerts** — a failed run emails the workflow owner and posts to the optional webhook. A separate `freshness` job fails
   and alerts when no successful backup has been recorded for 26 hours. The Super Admin page
   *Company directory → Migration and recovery history* shows the latest backup age.

Every run records `uploaded` or `failed` in `migration_backup_history` (append-only).

## Restore drill (monthly, and before go-live)

Never restore into production directly. `scripts/restore-drill.sh` refuses any target that is not empty or whose name does
not end in `_restore` / `_restore_test`.

```bash
# 1. Fingerprint the source (production read-only or the PITR branch you are comparing with)
psql "$SOURCE_URL" -X -A -t -F',' -f scripts/verify-restore.sql > reference.csv
# 2. Create an empty isolated database, e.g. a Neon branch database named azam_restore
# 3. Restore and verify
RESTORE_TARGET_URL="…/azam_restore" AGE_IDENTITY_FILE=/secure/azam-backup.key \
  scripts/restore-drill.sh s3://bucket/azam/azam-YYYYMMDDTHHMMSSZ-….dump.age reference.csv
```

The fingerprint compares, per company: effective vouchers, posted invoices, parties, items, total debits/credits,
Receivable, Payable and Inventory control balances, stock value and audit row count. Then open the restored copy with a
test deployment and run **Financial reconciliation** for each company. Record the drill (date, backup used, duration,
result, operator) in the operations log.

A drill was executed during Phase 5 against the isolated test database: encrypted dump → decrypt → restore → fingerprint
of all 143 test companies matched exactly; both safety guards refused a non-empty target and a non-restore database name.
A drill against real Neon infrastructure is still required.

## Disaster recovery procedure

1. Declare the incident; stop writes (Vercel: set the deployment to maintenance or remove `DATABASE_URL`).
2. Choose the recovery point: PITR timestamp (preferred) or the latest verified encrypted backup.
3. Restore into an **isolated** Neon branch/database. Re-apply runtime grants there.
4. Verify: `verify-restore.sql` fingerprint against the last known-good report, then Financial reconciliation per company.
5. Obtain written approval from the Accounts Manager and the system owner, naming the recovery point and accepted data loss.
6. Promote: make the verified branch the production branch (Neon "Set as default"/reset) or repoint `DATABASE_URL`.
7. Re-enter transactions recorded after the recovery point from source documents; record everything in the incident log.

## Migration recovery

A legacy import commits in one transaction. Before importing into production, create a Neon branch (or note the exact
timestamp): if the accountant later rejects the import, either *withdraw* it (deactivates imported companies; see
LEGACY_MIGRATION.md) or restore production to the pre-import timestamp following the procedure above.
