UPDATE accounts SET liquidity = control WHERE control IN ('cash', 'bank');
--> statement-breakpoint
INSERT INTO accounts (company_id, code, name, type, control)
SELECT c.id, a.code, a.name, a.type::account_type, a.control FROM companies c CROSS JOIN
  (VALUES ('4010','Sales Returns','income','sales_returns'),
          ('5150','Inventory Adjustments','expense','inventory_adjustment'),
          ('3200','Retained Earnings','equity','retained_earnings'),
          ('3900','Opening Balance Equity','equity','opening_equity')) AS a(code,name,type,control)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE voucher_documents ADD CONSTRAINT voucher_document_current_version
  FOREIGN KEY (company_id, id, current_voucher_id) REFERENCES voucher_versions (company_id, document_id, voucher_id);
--> statement-breakpoint
CREATE VIEW effective_vouchers AS
SELECT v.id, coalesce(d.id, v.id) AS document_id, v.company_id, v.period_id, v.accounting_date,
       coalesce(d.number, v.number) AS number, coalesce(d.reference, '') AS reference,
       v.type, v.narration, v.created_at
FROM vouchers v
LEFT JOIN voucher_versions vv ON vv.company_id = v.company_id AND vv.voucher_id = v.id
LEFT JOIN voucher_documents d ON d.company_id = vv.company_id AND d.id = vv.document_id
WHERE v.status = 'posted'
  AND (vv.voucher_id IS NULL OR (d.status = 'posted' AND d.current_voucher_id = v.id));
--> statement-breakpoint
CREATE FUNCTION assert_effective_period(company uuid, period uuid, day date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM accounting_periods ap JOIN financial_years fy ON fy.company_id = ap.company_id AND fy.id = ap.year_id
  WHERE ap.company_id = company AND ap.id = period AND NOT ap.closed AND NOT fy.closed
    AND day BETWEEN ap.starts_on AND ap.ends_on FOR SHARE OF ap, fy;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period is closed or missing' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_effective_voucher() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous vouchers%ROWTYPE;
DECLARE current_entry vouchers%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type OR NEW.source <> OLD.source
       OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.opening_party_id IS DISTINCT FROM OLD.opening_party_id
       OR NEW.opening_account_id IS DISTINCT FROM OLD.opening_account_id
       OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number) THEN
      RAISE EXCEPTION 'Voucher identity is permanent' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'posted' THEN
      SELECT * INTO previous FROM vouchers WHERE company_id = OLD.company_id AND id = OLD.current_voucher_id;
      PERFORM assert_effective_period(previous.company_id, previous.period_id, previous.accounting_date);
    END IF;
  END IF;
  IF NEW.status = 'posted' THEN
    SELECT * INTO current_entry FROM vouchers WHERE company_id = NEW.company_id AND id = NEW.current_voucher_id;
    IF NOT FOUND OR current_entry.status <> 'posted' OR current_entry.type <> NEW.type OR current_entry.accounting_date <> NEW.accounting_date THEN
      RAISE EXCEPTION 'The current posting must match the voucher document' USING ERRCODE = '23514';
    END IF;
    PERFORM assert_effective_period(current_entry.company_id, current_entry.period_id, current_entry.accounting_date);
    IF EXISTS (
      SELECT 1 FROM journal_lines l JOIN accounts a ON a.company_id = l.company_id AND a.id = l.account_id
      WHERE l.company_id = NEW.company_id AND l.voucher_id = current_entry.id
        AND a.control IN ('receivable','payable') AND l.party_id IS NULL
    ) THEN RAISE EXCEPTION 'A control account line requires a party' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_effective_voucher BEFORE INSERT OR UPDATE ON voucher_documents
FOR EACH ROW EXECUTE FUNCTION guard_effective_voucher();
--> statement-breakpoint
CREATE FUNCTION guard_party_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM parties p JOIN accounts a ON a.company_id = p.company_id AND a.id = NEW.account_id
    WHERE p.company_id = NEW.company_id AND p.id = NEW.party_id AND
    ((p.type = 'customer' AND a.control = 'receivable') OR (p.type = 'supplier' AND a.control = 'payable'))
  ) THEN
    RAISE EXCEPTION 'Party and control account must match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_party_account BEFORE INSERT OR UPDATE OF party_id, account_id, company_id ON journal_lines
FOR EACH ROW EXECUTE FUNCTION guard_party_account();
