CREATE TABLE "manual_register_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"register" text NOT NULL,
	"accounting_date" date,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"linked_voucher_id" uuid,
	"linked_invoice_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_register_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "manual_register_voucher" UNIQUE("company_id","register","linked_voucher_id"),
	CONSTRAINT "manual_register_invoice" UNIQUE("company_id","register","linked_invoice_id"),
	CONSTRAINT "manual_register_kind" CHECK ("manual_register_rows"."register" in ('day-book','sale-purchase')),
	CONSTRAINT "manual_register_status" CHECK ("manual_register_rows"."status" in ('draft','saved','void','linked')),
	CONSTRAINT "manual_register_link" CHECK (("manual_register_rows"."status" <> 'linked' and "manual_register_rows"."linked_voucher_id" is null and "manual_register_rows"."linked_invoice_id" is null)
    or ("manual_register_rows"."status"='linked' and (("manual_register_rows"."register"='day-book' and "manual_register_rows"."linked_voucher_id" is not null and "manual_register_rows"."linked_invoice_id" is null)
    or ("manual_register_rows"."register"='sale-purchase' and "manual_register_rows"."linked_invoice_id" is not null and "manual_register_rows"."linked_voucher_id" is null))))
);
--> statement-breakpoint
CREATE TABLE "report_account_mappings" (
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"group_key" text,
	"label" text DEFAULT '' NOT NULL,
	"type" "account_type" NOT NULL,
	"other_expense" boolean DEFAULT false NOT NULL,
	CONSTRAINT "report_account_mappings_company_id_account_id_pk" PRIMARY KEY("company_id","account_id"),
	CONSTRAINT "report_mapping_key" CHECK ("report_account_mappings"."group_key" is null or "report_account_mappings"."group_key" ~ '^[a-z0-9_-]{1,50}$')
);
--> statement-breakpoint
CREATE TABLE "voucher_timeline" (
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"voucher_id" uuid,
	"accounting_date" date NOT NULL,
	"number" text,
	"reference" text DEFAULT '' NOT NULL,
	"status" "document_status" NOT NULL,
	"type" "voucher_type" NOT NULL,
	"draft" jsonb,
	CONSTRAINT "voucher_timeline_company_id_document_id_version_pk" PRIMARY KEY("company_id","document_id","version")
);
--> statement-breakpoint
ALTER TABLE "manual_register_rows" ADD CONSTRAINT "manual_register_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_register_rows" ADD CONSTRAINT "manual_register_rows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_register_rows" ADD CONSTRAINT "manual_register_rows_company_id_linked_voucher_id_voucher_documents_company_id_id_fk" FOREIGN KEY ("company_id","linked_voucher_id") REFERENCES "public"."voucher_documents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_register_rows" ADD CONSTRAINT "manual_register_rows_company_id_linked_invoice_id_invoices_company_id_id_fk" FOREIGN KEY ("company_id","linked_invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_account_mappings" ADD CONSTRAINT "report_account_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_account_mappings" ADD CONSTRAINT "report_account_mappings_company_id_account_id_accounts_company_id_id_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_timeline" ADD CONSTRAINT "voucher_timeline_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_timeline" ADD CONSTRAINT "voucher_timeline_company_id_document_id_voucher_documents_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."voucher_documents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_timeline" ADD CONSTRAINT "voucher_timeline_company_id_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_register_range" ON "manual_register_rows" USING btree ("company_id","register","accounting_date","status");--> statement-breakpoint
CREATE INDEX "voucher_timeline_cutoff" ON "voucher_timeline" USING btree ("company_id","recorded_at","document_id");