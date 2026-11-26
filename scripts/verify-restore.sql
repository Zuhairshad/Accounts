-- Deterministic fingerprint of the books, used to compare a restored copy with its source.
-- Run with: psql "$URL" -X -A -t -F',' -f scripts/verify-restore.sql
SELECT c.name,
  (SELECT count(*) FROM effective_vouchers e WHERE e.company_id=c.id) AS effective_vouchers,
  (SELECT count(*) FROM invoices i WHERE i.company_id=c.id AND i.status='posted') AS posted_invoices,
  (SELECT count(*) FROM parties p WHERE p.company_id=c.id) AS parties,
  (SELECT count(*) FROM inventory_items g WHERE g.company_id=c.id) AS items,
  (SELECT coalesce(sum(l.debit),0) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id WHERE e.company_id=c.id) AS total_debit,
  (SELECT coalesce(sum(l.credit),0) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id WHERE e.company_id=c.id) AS total_credit,
  (SELECT coalesce(sum(l.debit-l.credit),0) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE e.company_id=c.id AND a.control='receivable') AS receivable,
  (SELECT coalesce(sum(l.debit-l.credit),0) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE e.company_id=c.id AND a.control='payable') AS payable,
  (SELECT coalesce(sum(l.debit-l.credit),0) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE e.company_id=c.id AND a.control='inventory') AS inventory_gl,
  (SELECT coalesce(sum(m.signed_value),0) FROM stock_movements m JOIN effective_vouchers e ON e.company_id=m.company_id AND e.id=m.voucher_id WHERE m.company_id=c.id) AS stock_value,
  (SELECT count(*) FROM audit_logs a WHERE a.company_id=c.id) AS audit_rows
FROM companies c ORDER BY c.id;
