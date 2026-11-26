CREATE OR REPLACE VIEW effective_vouchers AS
SELECT v.id, coalesce(d.id, v.id) AS document_id, v.company_id, v.period_id, v.accounting_date,
       coalesce(d.number, v.number) AS number, coalesce(d.reference, '') AS reference,
       v.type, v.narration, coalesce(d.created_at, v.created_at) AS created_at
FROM vouchers v
LEFT JOIN voucher_versions vv ON vv.company_id = v.company_id AND vv.voucher_id = v.id
LEFT JOIN voucher_documents d ON d.company_id = vv.company_id AND d.id = vv.document_id
WHERE v.status = 'posted'
  AND (vv.voucher_id IS NULL OR (d.status = 'posted' AND d.current_voucher_id = v.id));
--> statement-breakpoint
CREATE FUNCTION check_posting_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'invoice' AND NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.company_id = NEW.company_id AND i.id = NEW.source_id
      AND i.voucher_id = NEW.current_voucher_id AND i.status = 'posted'
      AND i.accounting_date = NEW.accounting_date AND i.type::text = NEW.type::text
  ) THEN
    RAISE EXCEPTION 'Invoice journal requires its matching posted source' USING ERRCODE = '23514';
  ELSIF NEW.source = 'inventory_adjustment' AND NOT EXISTS (
    SELECT 1 FROM inventory_adjustments a WHERE a.company_id = NEW.company_id AND a.id = NEW.source_id
      AND a.voucher_id = NEW.current_voucher_id
  ) THEN
    RAISE EXCEPTION 'Inventory adjustment journal requires its matching source' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER posted_journal_source AFTER INSERT OR UPDATE ON voucher_documents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.status = 'posted' AND NEW.source IN ('invoice','inventory_adjustment'))
EXECUTE FUNCTION check_posting_source();
--> statement-breakpoint
CREATE FUNCTION protect_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.control IS DISTINCT FROM OLD.control THEN
    RAISE EXCEPTION 'Account identity and system control are permanent' USING ERRCODE = '23514';
  END IF;
  IF OLD.control IS NOT NULL AND (NEW.type <> OLD.type OR NEW.liquidity IS DISTINCT FROM OLD.liquidity OR NOT NEW.active) THEN
    RAISE EXCEPTION 'System account classification and active status are protected' USING ERRCODE = '23514';
  END IF;
  IF NEW.type <> OLD.type AND EXISTS (SELECT 1 FROM journal_lines WHERE company_id = OLD.company_id AND account_id = OLD.id) THEN
    RAISE EXCEPTION 'Posted account classification cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protect_account_identity BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_account_identity();
--> statement-breakpoint
CREATE FUNCTION protect_party_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'Party identity and classification are permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protect_party_identity BEFORE UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION protect_party_identity();
