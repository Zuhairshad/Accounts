#!/usr/bin/env bash
# Restore an encrypted backup into an ISOLATED, EMPTY database and prove it matches a reference fingerprint.
# It never touches production: the target must be empty and its name must end in _restore or _restore_test.
#
#   RESTORE_TARGET_URL=postgres://owner@host/azam_restore \
#   AGE_IDENTITY_FILE=/secure/backup.key \
#   scripts/restore-drill.sh <backup.dump.age | s3://bucket/prefix/file.dump.age> [reference-fingerprint.csv]
set -euo pipefail
umask 077
source="${1:?backup file or s3:// URI required}"
reference="${2:-}"
: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required}"
db_name="$(psql "$RESTORE_TARGET_URL" -X -tA -c 'SELECT current_database()')"
[[ "$db_name" =~ _restore(_test)?$ ]] || { echo "Target database must be named *_restore or *_restore_test (got $db_name)." >&2; exit 2; }
tables="$(psql "$RESTORE_TARGET_URL" -X -tA -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[[ "$tables" == "0" ]] || { echo "Target database is not empty; refusing to restore." >&2; exit 2; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
if [[ "$source" == s3://* ]]; then aws s3 cp "$source" "$work/backup.dump.age" --only-show-errors; else cp "$source" "$work/backup.dump.age"; fi
started=$(date +%s)
age --decrypt -i "$AGE_IDENTITY_FILE" "$work/backup.dump.age" | pg_restore --exit-on-error --no-owner --no-acl -d "$RESTORE_TARGET_URL"
echo "Restore completed in $(( $(date +%s) - started )) seconds."
psql "$RESTORE_TARGET_URL" -X -A -t -F',' -f "$(dirname "$0")/verify-restore.sql" > "$work/restored.csv"
cat "$work/restored.csv"
if [[ -n "$reference" ]]; then
  if diff -u "$reference" "$work/restored.csv"; then echo "RESTORE VERIFIED: fingerprint matches the reference."; else echo "RESTORE MISMATCH" >&2; exit 1; fi
fi
