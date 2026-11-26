-- Historical revisions are authoritative for the effective posting that followed them.
INSERT INTO voucher_timeline(company_id,document_id,version,recorded_at,voucher_id,accounting_date,number,reference,status,type,draft)
SELECT r.company_id,r.entity_id,r.version,r.created_at,(r.next_data->>'currentVoucherId')::uuid,
  (r.next_data->>'date')::date,r.next_data->>'number',coalesce(r.next_data->>'reference',''),
  (r.next_data->>'status')::document_status,(r.next_data->>'type')::voucher_type,nullif(r.next_data->'draft','null'::jsonb)
FROM transaction_revisions r JOIN voucher_documents d ON d.company_id=r.company_id AND d.id=r.entity_id
WHERE r.entity_type='voucher' AND r.next_data ? 'status' AND r.next_data ? 'date'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO voucher_timeline(company_id,document_id,version,recorded_at,voucher_id,accounting_date,number,reference,status,type,draft)
SELECT DISTINCT ON (r.company_id,r.entity_id) r.company_id,r.entity_id,(r.previous_data->>'version')::integer,
  (r.previous_data->>'createdAt')::timestamptz,(r.previous_data->>'currentVoucherId')::uuid,(r.previous_data->>'date')::date,
  r.previous_data->>'number',coalesce(r.previous_data->>'reference',''),
  (r.previous_data->>'status')::document_status,(r.previous_data->>'type')::voucher_type,nullif(r.previous_data->'draft','null'::jsonb)
FROM transaction_revisions r JOIN voucher_documents d ON d.company_id=r.company_id AND d.id=r.entity_id
WHERE r.entity_type='voucher' AND r.previous_data ? 'version' AND r.previous_data ? 'createdAt' AND r.previous_data->>'status'='draft'
ORDER BY r.company_id,r.entity_id,r.version
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO voucher_timeline(company_id,document_id,version,recorded_at,voucher_id,accounting_date,number,reference,status,type,draft)
SELECT d.company_id,d.id,d.version,coalesce(v.posted_at,d.created_at),d.current_voucher_id,d.accounting_date,d.number,d.reference,d.status,d.type,d.draft
FROM voucher_documents d LEFT JOIN vouchers v ON v.company_id=d.company_id AND v.id=d.current_voucher_id
WHERE NOT EXISTS (SELECT 1 FROM voucher_timeline t WHERE t.company_id=d.company_id AND t.document_id=d.id AND t.version=d.version)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION record_voucher_timeline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_timeline(company_id,document_id,version,voucher_id,accounting_date,number,reference,status,type,draft)
  VALUES(NEW.company_id,NEW.id,NEW.version,NEW.current_voucher_id,NEW.accounting_date,NEW.number,NEW.reference,NEW.status,NEW.type,NEW.draft)
  ON CONFLICT (company_id,document_id,version) DO UPDATE SET
    voucher_id=excluded.voucher_id,accounting_date=excluded.accounting_date,number=excluded.number,
    reference=excluded.reference,status=excluded.status,draft=excluded.draft,recorded_at=clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER record_voucher_timeline AFTER INSERT OR UPDATE ON voucher_documents FOR EACH ROW EXECUTE FUNCTION record_voucher_timeline();
