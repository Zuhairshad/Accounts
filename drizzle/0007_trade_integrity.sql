INSERT INTO accounts (company_id, code, name, type, control)
SELECT c.id, a.code, a.name, a.type::account_type, a.control FROM companies c CROSS JOIN
  (VALUES ('1150','Input Tax Receivable','asset','input_tax'),
          ('1160','Withholding Receivable','asset','withholding_receivable'),
          ('2150','Sales Tax Payable','liability','output_tax'),
          ('2160','Withholding Payable','liability','withholding_payable'),
          ('5160','Purchase Return Variance','expense','purchase_return_variance'),
          ('5170','Damaged and Lost Inventory','expense','inventory_loss')) AS a(code,name,type,control)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE FUNCTION guard_trade_return_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS NULL OR NEW.status <> 'posted' THEN RETURN NEW; END IF;
  IF NEW.original_invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.company_id = NEW.company_id AND i.id = NEW.original_invoice_id
      AND i.party_id = NEW.party_id AND i.status = 'posted' AND i.accounting_date <= NEW.accounting_date
      AND ((NEW.type = 'sale_return' AND i.type = 'sale') OR (NEW.type = 'purchase_return' AND i.type = 'purchase'))
  ) THEN RAISE EXCEPTION 'Return must match its posted original transaction' USING ERRCODE='23514';
  END IF;
  IF NEW.exchange_return_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.company_id = NEW.company_id AND i.id = NEW.exchange_return_id
      AND i.party_id = NEW.party_id AND i.status = 'posted' AND i.accounting_date <= NEW.accounting_date
      AND NEW.type = 'sale' AND i.type = 'sale_return'
  ) THEN RAISE EXCEPTION 'Exchange sale must match its posted sale return' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_trade_return_link BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION guard_trade_return_link();
--> statement-breakpoint
CREATE INDEX stock_company_voucher ON stock_movements(company_id,voucher_id);
