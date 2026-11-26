INSERT INTO day_book_entries(company_id,journal_line_id)
SELECT l.company_id,l.id FROM journal_lines l JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
WHERE v.status='posted' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO sale_purchase_register_entries(company_id,invoice_id)
SELECT company_id,id FROM invoices WHERE status='posted' ON CONFLICT DO NOTHING;
