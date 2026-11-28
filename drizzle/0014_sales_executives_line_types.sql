CREATE TABLE "sales_executives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_executive_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "sales_executive_company_name" UNIQUE("company_id","name"),
	CONSTRAINT "sales_executive_name_present" CHECK (length(btrim("sales_executives"."name")) between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "line_type" text DEFAULT 'product' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sales_executive_id" uuid;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD COLUMN "sales_executive_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_executives" ADD CONSTRAINT "sales_executives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_sales_executive_id_sales_executives_company_id_id_fk" FOREIGN KEY ("company_id","sales_executive_id") REFERENCES "public"."sales_executives"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_company_id_sales_executive_id_sales_executives_company_id_id_fk" FOREIGN KEY ("company_id","sales_executive_id") REFERENCES "public"."sales_executives"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_line_posting" ON "invoice_lines" USING btree ("company_id","posting_voucher_id");--> statement-breakpoint
CREATE INDEX "invoice_sales_executive" ON "invoices" USING btree ("company_id","sales_executive_id");--> statement-breakpoint
CREATE INDEX "voucher_document_sales_executive" ON "voucher_documents" USING btree ("company_id","sales_executive_id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_line_type" CHECK ("invoice_lines"."line_type" in ('product','services','freight'));