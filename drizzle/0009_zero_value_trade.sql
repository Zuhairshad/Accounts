CREATE OR REPLACE FUNCTION validate_posted_voucher() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count bigint;
DECLARE balance numeric;
BEGIN
  SELECT count(*), coalesce(sum(debit - credit), 0) INTO line_count, balance
    FROM journal_lines WHERE company_id = NEW.company_id AND voucher_id = NEW.id;
  IF line_count = 0 AND EXISTS (
    SELECT 1 FROM voucher_versions v JOIN voucher_documents d ON d.company_id=v.company_id AND d.id=v.document_id
    WHERE v.company_id=NEW.company_id AND v.voucher_id=NEW.id AND d.source IN ('invoice','inventory_adjustment')
  ) AND (
    (EXISTS (SELECT 1 FROM stock_movements s WHERE s.company_id=NEW.company_id AND s.voucher_id=NEW.id)
      AND NOT EXISTS (SELECT 1 FROM stock_movements s WHERE s.company_id=NEW.company_id AND s.voucher_id=NEW.id AND s.signed_value<>0))
    OR (EXISTS (SELECT 1 FROM invoices i JOIN invoice_lines il ON il.company_id=i.company_id AND il.invoice_id=i.id
        AND il.posting_voucher_id=i.voucher_id
        WHERE i.company_id=NEW.company_id AND i.voucher_id=NEW.id AND i.total=0)
      AND NOT EXISTS (SELECT 1 FROM stock_movements s WHERE s.company_id=NEW.company_id AND s.voucher_id=NEW.id AND s.signed_value<>0))
    OR EXISTS (SELECT 1 FROM inventory_adjustments a WHERE a.company_id=NEW.company_id AND a.voucher_id=NEW.id
      AND a.kind IN ('count','opening_correction') AND a.calculation->>'difference'='0')
  ) THEN RETURN NULL;
  END IF;
  IF line_count < 2 OR balance <> 0 THEN
    RAISE EXCEPTION 'A posted voucher must contain balanced journal lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
