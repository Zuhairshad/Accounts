-- Audit and history records are append-only for every role, including the migration owner.
-- Changing them requires an explicit, reviewable DDL change that disables this trigger.
CREATE FUNCTION reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_history_change();
--> statement-breakpoint
CREATE TRIGGER transaction_revisions_append_only BEFORE UPDATE OR DELETE ON transaction_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_change();
--> statement-breakpoint
CREATE TRIGGER voucher_timeline_append_only BEFORE UPDATE OR DELETE ON voucher_timeline FOR EACH ROW EXECUTE FUNCTION reject_history_change();
--> statement-breakpoint
CREATE TRIGGER deleted_records_append_only BEFORE UPDATE OR DELETE ON deleted_records FOR EACH ROW EXECUTE FUNCTION reject_history_change();
--> statement-breakpoint
CREATE TRIGGER restoration_history_append_only BEFORE UPDATE OR DELETE ON restoration_history FOR EACH ROW EXECUTE FUNCTION reject_history_change();
--> statement-breakpoint
CREATE TRIGGER operation_history_append_only BEFORE UPDATE OR DELETE ON migration_backup_history FOR EACH ROW EXECUTE FUNCTION reject_history_change();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
