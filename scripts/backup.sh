#!/usr/bin/env bash
set -euo pipefail
umask 077

for setting in PGHOST PGDATABASE PGUSER PGPASSWORD BACKUP_AGE_RECIPIENT BACKUP_S3_PREFIX; do
  if [[ -z "${!setting:-}" ]]; then
    printf 'Required backup setting is empty: %s\n' "$setting" >&2
    exit 1
  fi
done
[[ "$BACKUP_S3_PREFIX" == s3://* ]]
backup_id="azam-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
ciphertext="$(mktemp)"
trap 'rm -f "$ciphertext"' EXIT

postgres_client() {
  docker run --rm -i     --env PGHOST --env PGDATABASE --env PGUSER --env PGPASSWORD     --env PGSSLMODE=verify-full --env PGSSLROOTCERT=system     --env PGCONNECT_TIMEOUT=10 postgres:18 "$@"
}

record() {
  postgres_client psql --no-psqlrc -v ON_ERROR_STOP=1 -v backup_id="$backup_id" -v backup_status="$1" <<'SQL'
INSERT INTO migration_backup_history(kind, reference, status)
VALUES ('backup', :'backup_id', :'backup_status');
SQL
}

trap 'record failed || true' ERR
postgres_client pg_dump --format=custom --no-owner --no-acl | age --encrypt -r "$BACKUP_AGE_RECIPIENT" > "$ciphertext"
test -s "$ciphertext"
aws s3 cp "$ciphertext" "${BACKUP_S3_PREFIX%/}/$backup_id.dump.age" --only-show-errors
record uploaded
