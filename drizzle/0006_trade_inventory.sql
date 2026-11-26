ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_line_number";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "valid_stock_move";--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ALTER COLUMN "voucher_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "trade_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "trade_withholding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "number" text;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "accounting_date" date;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "status" "document_status" DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "calculation" jsonb;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "effect_hash" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "posting_voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "original_line_no" integer;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "unit_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "subtotal" numeric(20, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "discount" numeric(20, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax" numeric(20, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "inventory_cost" numeric(20, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "disposition" text DEFAULT 'saleable' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "party_amount" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "applied_credit" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "external_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "po_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_return_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "duplicate_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "calculation" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "effect_hash" text;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "kind" text DEFAULT 'stock' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "reorder_quantity" numeric(24, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "purchase_account_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "line_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "movement_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_company_id_item_id_inventory_items_company_id_id_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."inventory_items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_company_id_posting_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","posting_voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_exchange_return_id_invoices_company_id_id_fk" FOREIGN KEY ("company_id","exchange_return_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_company_id_purchase_account_id_accounts_company_id_id_fk" FOREIGN KEY ("company_id","purchase_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_initial_inventory_opening" ON "inventory_adjustments" USING btree ("company_id","item_id") WHERE "inventory_adjustments"."kind" = 'opening';--> statement-breakpoint
CREATE INDEX "adjustment_company_date" ON "inventory_adjustments" USING btree ("company_id","accounting_date");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_invoice_line_number" ON "invoice_lines" USING btree ("company_id","invoice_id","line_no") WHERE "invoice_lines"."posting_voucher_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "versioned_invoice_line_number" ON "invoice_lines" USING btree ("company_id","invoice_id","posting_voucher_id","line_no");--> statement-breakpoint
CREATE INDEX "invoice_original_index" ON "invoices" USING btree ("company_id","original_invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_external_reference" ON "invoices" USING btree ("company_id","party_id",lower("external_ref"));--> statement-breakpoint
CREATE UNIQUE INDEX "one_posted_exchange_sale" ON "invoices" USING btree ("company_id","exchange_return_id") WHERE "invoices"."exchange_return_id" is not null and "invoices"."status" = 'posted';--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "adjustment_company_id" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "adjustment_number" UNIQUE("company_id","number");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "trade_party_amount_range" CHECK (("invoices"."party_amount" is null or "invoices"."party_amount" between 0 and "invoices"."total") and
    ("invoices"."applied_credit" is null or ("invoices"."party_amount" is not null and "invoices"."applied_credit" between 0 and "invoices"."party_amount")));--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_item_kind" CHECK ("inventory_items"."kind" in ('stock','service') and "inventory_items"."reorder_quantity" >= 0 and "inventory_items"."reorder_quantity" <> 'NaN');--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "valid_stock_move" CHECK ("stock_movements"."unit_cost" >= 0 and
    (("stock_movements"."signed_quantity" = 0 and "stock_movements"."signed_value" <> 0 and "stock_movements"."movement_kind" = 'valuation') or
    ("stock_movements"."signed_quantity" <> 0 and ("stock_movements"."signed_value" = 0 or sign("stock_movements"."signed_value") = sign("stock_movements"."signed_quantity")))));