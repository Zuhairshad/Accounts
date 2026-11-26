CREATE TABLE "voucher_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "voucher_type" NOT NULL,
	"number" text,
	"accounting_date" date NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"current_voucher_id" uuid,
	"draft" jsonb,
	"submitted_by" uuid,
	"created_by" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"opening_party_id" uuid,
	"opening_account_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_document_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "voucher_document_number" UNIQUE("company_id","number"),
	CONSTRAINT "voucher_document_source" UNIQUE("company_id","source","source_id"),
	CONSTRAINT "voucher_document_opening_party" UNIQUE("company_id","opening_party_id"),
	CONSTRAINT "voucher_document_opening_account" UNIQUE("company_id","opening_account_id"),
	CONSTRAINT "voucher_document_source_values" CHECK ("voucher_documents"."source" in ('manual','opening','invoice','inventory_adjustment')),
	CONSTRAINT "voucher_document_link" CHECK (("voucher_documents"."source" = 'manual' and "voucher_documents"."source_id" is null and "voucher_documents"."opening_party_id" is null and "voucher_documents"."opening_account_id" is null)
    or ("voucher_documents"."source" = 'opening' and "voucher_documents"."type" = 'opening' and "voucher_documents"."source_id" is null and num_nonnulls("voucher_documents"."opening_party_id", "voucher_documents"."opening_account_id") = 1)
    or ("voucher_documents"."source" in ('invoice', 'inventory_adjustment') and "voucher_documents"."source_id" is not null and "voucher_documents"."opening_party_id" is null and "voucher_documents"."opening_account_id" is null)),
	CONSTRAINT "posted_document_voucher" CHECK ("voucher_documents"."status" <> 'posted' or ("voucher_documents"."current_voucher_id" is not null and "voucher_documents"."number" is not null and "voucher_documents"."draft" is null)),
	CONSTRAINT "draft_document_payload" CHECK ("voucher_documents"."status" <> 'draft' or ("voucher_documents"."draft" is not null and "voucher_documents"."current_voucher_id" is null))
);
--> statement-breakpoint
CREATE TABLE "voucher_versions" (
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	CONSTRAINT "voucher_versions_company_id_voucher_id_pk" PRIMARY KEY("company_id","voucher_id"),
	CONSTRAINT "voucher_version_document" UNIQUE("company_id","document_id","voucher_id")
);
--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP CONSTRAINT "allocation_invoice_payment";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "liquidity" text;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD COLUMN "ended_on" date;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD COLUMN "ended_by" uuid;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "voucher_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "opening_offset_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "contact" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "ntn" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "strn" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "credit_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "credit_limit" numeric(20, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD COLUMN "next_data" jsonb;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_company_id_current_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","current_voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_company_id_opening_party_id_parties_company_id_id_fk" FOREIGN KEY ("company_id","opening_party_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_documents" ADD CONSTRAINT "voucher_documents_company_id_opening_account_id_accounts_company_id_id_fk" FOREIGN KEY ("company_id","opening_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_versions" ADD CONSTRAINT "voucher_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_versions" ADD CONSTRAINT "voucher_versions_company_id_document_id_voucher_documents_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."voucher_documents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_versions" ADD CONSTRAINT "voucher_versions_company_id_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_document_company_date" ON "voucher_documents" USING btree ("company_id","accounting_date","status");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_company_id_parent_id_accounts_company_id_id_fk" FOREIGN KEY ("company_id","parent_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_company_id_opening_offset_id_accounts_company_id_id_fk" FOREIGN KEY ("company_id","opening_offset_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_allocation_invoice_payment" ON "payment_allocations" USING btree ("company_id","invoice_id","payment_line_id") WHERE "payment_allocations"."ended_on" is null;--> statement-breakpoint
CREATE INDEX "allocation_by_payment" ON "payment_allocations" USING btree ("company_id","payment_line_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "valid_account_parent" CHECK ("accounts"."parent_id" is distinct from "accounts"."id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "valid_account_liquidity" CHECK ("accounts"."liquidity" is null or ("accounts"."liquidity" in ('cash','bank') and "accounts"."type" = 'asset'));--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "allocation_end_valid" CHECK (("payment_allocations"."ended_on" is null and "payment_allocations"."ended_by" is null) or ("payment_allocations"."ended_on" is not null and "payment_allocations"."ended_by" is not null and "payment_allocations"."ended_on" >= "payment_allocations"."accounting_date"));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "valid_party_credit" CHECK ("parties"."credit_days" between 0 and 3650 and "parties"."credit_limit" >= 0 and "parties"."credit_limit" <> 'NaN');