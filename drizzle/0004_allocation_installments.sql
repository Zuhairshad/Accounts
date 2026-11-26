DROP INDEX "active_allocation_invoice_payment";--> statement-breakpoint
CREATE INDEX "allocation_invoice_payment" ON "payment_allocations" USING btree ("company_id","invoice_id","payment_line_id");