CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'posted', 'void');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('sale', 'purchase', 'sale_return', 'purchase_return');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('customer', 'supplier');--> statement-breakpoint
CREATE TYPE "public"."voucher_type" AS ENUM('JV', 'VR', 'CPV', 'CRV', 'BPV', 'BRV', 'sale', 'purchase', 'sale_return', 'purchase_return', 'opening', 'adjustment', 'reversal');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"control" text,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "account_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "account_company_code" UNIQUE("company_id","code"),
	CONSTRAINT "account_company_name" UNIQUE("company_id","name"),
	CONSTRAINT "account_company_control" UNIQUE("company_id","control")
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_line_id" uuid NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"accounting_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_invoice_payment" UNIQUE("company_id","invoice_id","payment_line_id"),
	CONSTRAINT "allocation_positive_amount" CHECK ("payment_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_name_present" CHECK (length(btrim("companies"."name")) between 1 and 160)
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_members_company_id_user_id_pk" PRIMARY KEY("company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "company_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "role_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "role_company_name" UNIQUE("company_id","name"),
	CONSTRAINT "roles_permissions_array" CHECK (jsonb_typeof("company_roles"."permissions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"logo_url" text,
	"address" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"ntn" text DEFAULT '' NOT NULL,
	"strn" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'Asia/Karachi' NOT NULL,
	"currency" text DEFAULT 'PKR' NOT NULL,
	"display_date_format" text DEFAULT 'DD-MM-YYYY' NOT NULL,
	"number_prefix" text DEFAULT '' NOT NULL,
	"number_padding" integer DEFAULT 4 NOT NULL,
	CONSTRAINT "document_padding_range" CHECK ("company_settings"."number_padding" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "day_book_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	CONSTRAINT "day_book_source" UNIQUE("company_id","journal_line_id")
);
--> statement-breakpoint
CREATE TABLE "deleted_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"deleted_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_company_id" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"company_id" uuid NOT NULL,
	"year_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_sequences_company_id_year_id_kind_pk" PRIMARY KEY("company_id","year_id","kind"),
	CONSTRAINT "sequence_nonnegative" CHECK ("document_sequences"."last_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "financial_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "year_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "year_company_name" UNIQUE("company_id","name"),
	CONSTRAINT "year_valid_range" CHECK ("financial_years"."starts_on" <= "financial_years"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "idempotency_requests" (
	"company_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_requests_company_id_operation_key_pk" PRIMARY KEY("company_id","operation","key")
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_voucher" UNIQUE("company_id","voucher_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_valuations" (
	"company_id" uuid NOT NULL,
	"stock_movement_id" uuid NOT NULL,
	"quantity_after" numeric(24, 6) NOT NULL,
	"value_after" numeric(20, 2) NOT NULL,
	"average_cost" numeric(28, 10) NOT NULL,
	CONSTRAINT "inventory_valuations_company_id_stock_movement_id_pk" PRIMARY KEY("company_id","stock_movement_id"),
	CONSTRAINT "nonnegative_inventory_valuation" CHECK ("inventory_valuations"."quantity_after" >= 0 and "inventory_valuations"."value_after" >= 0 and "inventory_valuations"."average_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"rate" numeric(28, 10) NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	CONSTRAINT "invoice_line_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "invoice_line_number" UNIQUE("company_id","invoice_id","line_no"),
	CONSTRAINT "invoice_line_values" CHECK ("invoice_lines"."line_no" > 0 and "invoice_lines"."quantity" > 0 and "invoice_lines"."rate" >= 0 and "invoice_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"type" "invoice_type" NOT NULL,
	"accounting_date" date NOT NULL,
	"due_on" date,
	"party_id" uuid NOT NULL,
	"voucher_id" uuid,
	"original_invoice_id" uuid,
	"total" numeric(20, 2) NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoice_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "invoice_company_number" UNIQUE("company_id","type","number"),
	CONSTRAINT "invoice_company_voucher" UNIQUE("company_id","voucher_id"),
	CONSTRAINT "posted_invoice_metadata" CHECK ("invoices"."status" <> 'posted' or ("invoices"."number" is not null and "invoices"."voucher_id" is not null)),
	CONSTRAINT "invoice_nonnegative_total" CHECK ("invoices"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "item_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "item_company_sku" UNIQUE("company_id","sku"),
	CONSTRAINT "item_company_name" UNIQUE("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"party_id" uuid,
	"item_id" uuid,
	"line_no" integer NOT NULL,
	"debit" numeric(20, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 2) DEFAULT '0' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "journal_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "journal_voucher_line" UNIQUE("company_id","voucher_id","line_no"),
	CONSTRAINT "positive_journal_line" CHECK ("journal_lines"."line_no" > 0 and (("journal_lines"."debit" > 0 and "journal_lines"."credit" = 0) or ("journal_lines"."credit" > 0 and "journal_lines"."debit" = 0)))
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"year_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	CONSTRAINT "opening_balance_line" UNIQUE("company_id","journal_line_id")
);
--> statement-breakpoint
CREATE TABLE "migration_backup_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"status" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valid_operation_kind" CHECK ("migration_backup_history"."kind" in ('legacy_import', 'backup', 'restore'))
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "party_type" NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "party_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "party_company_name" UNIQUE("company_id","type","name")
);
--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"year_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "period_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "period_valid_range" CHECK ("accounting_periods"."starts_on" <= "accounting_periods"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "report_settings" (
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"settings" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "report_settings_company_id_key_pk" PRIMARY KEY("company_id","key")
);
--> statement-breakpoint
CREATE TABLE "restoration_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deletion_id" uuid NOT NULL,
	"restored_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_restore_per_deletion" UNIQUE("company_id","deletion_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"previous_data" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_revision_version" UNIQUE("company_id","entity_type","entity_id","version")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"accounting_date" date NOT NULL,
	"signed_quantity" numeric(24, 6) NOT NULL,
	"unit_cost" numeric(28, 10) NOT NULL,
	"signed_value" numeric(20, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_move_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "valid_stock_move" CHECK ("stock_movements"."signed_quantity" <> 0 and "stock_movements"."unit_cost" >= 0 and ("stock_movements"."signed_value" = 0 or sign("stock_movements"."signed_value") = sign("stock_movements"."signed_quantity")))
);
--> statement-breakpoint
CREATE TABLE "sale_purchase_register_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	CONSTRAINT "trade_register_source" UNIQUE("company_id","invoice_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "unit_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "unit_company_name" UNIQUE("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"super_admin" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "canonical_username" CHECK ("users"."username" ~ '^[a-z0-9][a-z0-9_.@+-]{2,119}$')
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"number" text,
	"accounting_date" date NOT NULL,
	"type" "voucher_type" NOT NULL,
	"narration" text DEFAULT '' NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "voucher_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "voucher_company_number" UNIQUE("company_id","number"),
	CONSTRAINT "posted_voucher_metadata" CHECK ("vouchers"."status" <> 'posted' or ("vouchers"."number" is not null and "vouchers"."posted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_invoice_id_invoices_company_id_id_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_payment_line_id_journal_lines_company_id_id_fk" FOREIGN KEY ("company_id","payment_line_id") REFERENCES "public"."journal_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_role_id_company_roles_company_id_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."company_roles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_roles" ADD CONSTRAINT "company_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_book_entries" ADD CONSTRAINT "day_book_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_book_entries" ADD CONSTRAINT "day_book_entries_company_id_journal_line_id_journal_lines_company_id_id_fk" FOREIGN KEY ("company_id","journal_line_id") REFERENCES "public"."journal_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_year_id_financial_years_company_id_id_fk" FOREIGN KEY ("company_id","year_id") REFERENCES "public"."financial_years"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_years" ADD CONSTRAINT "financial_years_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_requests" ADD CONSTRAINT "idempotency_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_requests" ADD CONSTRAINT "idempotency_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_company_id_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_company_id_stock_movement_id_stock_movements_company_id_id_fk" FOREIGN KEY ("company_id","stock_movement_id") REFERENCES "public"."stock_movements"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_company_id_invoice_id_invoices_company_id_id_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_company_id_item_id_inventory_items_company_id_id_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."inventory_items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_party_id_parties_company_id_id_fk" FOREIGN KEY ("company_id","party_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_original_invoice_id_invoices_company_id_id_fk" FOREIGN KEY ("company_id","original_invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_company_id_unit_id_inventory_units_company_id_id_fk" FOREIGN KEY ("company_id","unit_id") REFERENCES "public"."inventory_units"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_account_id_accounts_company_id_id_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_party_id_parties_company_id_id_fk" FOREIGN KEY ("company_id","party_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_item_id_inventory_items_company_id_id_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."inventory_items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_company_id_year_id_financial_years_company_id_id_fk" FOREIGN KEY ("company_id","year_id") REFERENCES "public"."financial_years"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_company_id_journal_line_id_journal_lines_company_id_id_fk" FOREIGN KEY ("company_id","journal_line_id") REFERENCES "public"."journal_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_company_id_year_id_financial_years_company_id_id_fk" FOREIGN KEY ("company_id","year_id") REFERENCES "public"."financial_years"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_settings" ADD CONSTRAINT "report_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restoration_history" ADD CONSTRAINT "restoration_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restoration_history" ADD CONSTRAINT "restoration_history_restored_by_users_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restoration_history" ADD CONSTRAINT "restoration_history_company_id_deletion_id_deleted_records_company_id_id_fk" FOREIGN KEY ("company_id","deletion_id") REFERENCES "public"."deleted_records"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_item_id_inventory_items_company_id_id_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."inventory_items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_voucher_id_vouchers_company_id_id_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_purchase_register_entries" ADD CONSTRAINT "sale_purchase_register_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_purchase_register_entries" ADD CONSTRAINT "sale_purchase_register_entries_company_id_invoice_id_invoices_company_id_id_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_units" ADD CONSTRAINT "inventory_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_company_id_period_id_accounting_periods_company_id_id_fk" FOREIGN KEY ("company_id","period_id") REFERENCES "public"."accounting_periods"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_company_time" ON "audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_unique_name" ON "companies" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "member_by_user" ON "company_members" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "invoice_company_date" ON "invoices" USING btree ("company_id","accounting_date","status");--> statement-breakpoint
CREATE INDEX "journal_by_account" ON "journal_lines" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_by_party" ON "journal_lines" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE INDEX "login_attempt_expiry" ON "login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "stock_company_item_date" ON "stock_movements" USING btree ("company_id","item_id","accounting_date");--> statement-breakpoint
CREATE INDEX "voucher_company_date" ON "vouchers" USING btree ("company_id","accounting_date","status");