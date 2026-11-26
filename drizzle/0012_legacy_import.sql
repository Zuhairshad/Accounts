CREATE TABLE "legacy_import_records" (
	"import_id" uuid NOT NULL,
	"company_id" uuid,
	"entity" text NOT NULL,
	"legacy_id" text NOT NULL,
	"target_id" uuid,
	"outcome" text NOT NULL,
	"issue" text,
	"source" jsonb,
	CONSTRAINT "legacy_import_records_import_id_entity_legacy_id_pk" PRIMARY KEY("import_id","entity","legacy_id"),
	CONSTRAINT "legacy_record_outcome" CHECK ("legacy_import_records"."outcome" in ('imported','reused','quarantined','skipped')),
	CONSTRAINT "legacy_record_target" CHECK (("legacy_import_records"."outcome" in ('imported','reused')) = ("legacy_import_records"."target_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "legacy_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_sha256" text NOT NULL,
	"mapping_sha256" text NOT NULL,
	"report_sha256" text NOT NULL,
	"status" text DEFAULT 'committed' NOT NULL,
	"approved_by" text NOT NULL,
	"approval" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdraw_reason" text,
	CONSTRAINT "legacy_import_status" CHECK ("legacy_imports"."status" in ('committed','withdrawn')),
	CONSTRAINT "legacy_import_withdrawal" CHECK (("legacy_imports"."status" = 'withdrawn') = ("legacy_imports"."withdrawn_at" is not null and "legacy_imports"."withdraw_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "legacy_import_records" ADD CONSTRAINT "legacy_import_records_import_id_legacy_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."legacy_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_import_records" ADD CONSTRAINT "legacy_import_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_import_once" ON "legacy_imports" USING btree ("source_sha256") WHERE "legacy_imports"."status" = 'committed';