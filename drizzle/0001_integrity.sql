CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE financial_years ADD CONSTRAINT financial_years_no_overlap
  EXCLUDE USING gist (company_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE accounting_periods ADD CONSTRAINT accounting_periods_no_overlap
  EXCLUDE USING gist (company_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE journal_lines ADD CONSTRAINT journal_amounts_finite CHECK (debit <> 'NaN' AND credit <> 'NaN');
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoice_amount_finite CHECK (total <> 'NaN');
--> statement-breakpoint
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_line_amounts_finite CHECK (quantity <> 'NaN' AND rate <> 'NaN' AND amount <> 'NaN');
--> statement-breakpoint
ALTER TABLE stock_movements ADD CONSTRAINT stock_amounts_finite CHECK (signed_quantity <> 'NaN' AND unit_cost <> 'NaN' AND signed_value <> 'NaN');
--> statement-breakpoint
ALTER TABLE inventory_valuations ADD CONSTRAINT valuation_amounts_finite CHECK (quantity_after <> 'NaN' AND value_after <> 'NaN' AND average_cost <> 'NaN');
--> statement-breakpoint
ALTER TABLE payment_allocations ADD CONSTRAINT allocation_amount_finite CHECK (amount <> 'NaN');
--> statement-breakpoint
CREATE FUNCTION guard_voucher_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period_row accounting_periods%ROWTYPE;
  year_row financial_years%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Posted vouchers are immutable; use a reversal' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  IF NEW.status = 'posted' THEN
    PERFORM 1 FROM companies WHERE id = NEW.company_id AND active FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A posted voucher requires an active company' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO period_row FROM accounting_periods WHERE id = NEW.period_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR period_row.closed OR NEW.accounting_date NOT BETWEEN period_row.starts_on AND period_row.ends_on THEN
      RAISE EXCEPTION 'Voucher date must fall in an open accounting period' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO year_row FROM financial_years WHERE id = period_row.year_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR year_row.closed OR NEW.accounting_date NOT BETWEEN year_row.starts_on AND year_row.ends_on THEN
      RAISE EXCEPTION 'Voucher date must fall in an open financial year' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_voucher_transition BEFORE INSERT OR UPDATE OR DELETE ON vouchers
FOR EACH ROW EXECUTE FUNCTION guard_voucher_transition();
--> statement-breakpoint
CREATE FUNCTION validate_posted_voucher() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_count bigint;
  balance numeric;
BEGIN
  SELECT count(*), coalesce(sum(debit - credit), 0) INTO line_count, balance
  FROM journal_lines WHERE company_id = NEW.company_id AND voucher_id = NEW.id;
  IF line_count < 2 OR balance <> 0 THEN
    RAISE EXCEPTION 'A posted voucher must contain balanced journal lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER posted_voucher_balanced AFTER INSERT OR UPDATE ON vouchers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'posted')
EXECUTE FUNCTION validate_posted_voucher();
--> statement-breakpoint
CREATE FUNCTION guard_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status document_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO parent_status FROM vouchers WHERE id = OLD.voucher_id AND company_id = OLD.company_id FOR UPDATE;
    IF parent_status = 'posted' THEN
      RAISE EXCEPTION 'Posted journal lines are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  SELECT status INTO parent_status FROM vouchers WHERE id = NEW.voucher_id AND company_id = NEW.company_id FOR UPDATE;
  IF parent_status = 'posted' THEN
    RAISE EXCEPTION 'Posted journal lines are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_posted_journal BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION guard_posted_journal();
--> statement-breakpoint
CREATE FUNCTION guard_accounting_period_range() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  year_row financial_years%ROWTYPE;
BEGIN
  SELECT * INTO year_row FROM financial_years WHERE id = NEW.year_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND OR NEW.starts_on < year_row.starts_on OR NEW.ends_on > year_row.ends_on THEN
    RAISE EXCEPTION 'Accounting period must be inside its financial year' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM vouchers WHERE company_id = OLD.company_id AND period_id = OLD.id AND status = 'posted'
      AND (accounting_date NOT BETWEEN NEW.starts_on AND NEW.ends_on OR OLD.year_id <> NEW.year_id)) THEN
      RAISE EXCEPTION 'Period change would invalidate posted vouchers' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_accounting_period_range BEFORE INSERT OR UPDATE ON accounting_periods
FOR EACH ROW EXECUTE FUNCTION guard_accounting_period_range();
--> statement-breakpoint
CREATE FUNCTION guard_financial_year_range() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_periods WHERE company_id = OLD.company_id AND year_id = OLD.id
    AND (starts_on < NEW.starts_on OR ends_on > NEW.ends_on)) THEN
    RAISE EXCEPTION 'Financial year change would invalidate an accounting period' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_financial_year_range BEFORE UPDATE OF starts_on, ends_on ON financial_years
FOR EACH ROW EXECUTE FUNCTION guard_financial_year_range();
