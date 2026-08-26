CREATE TABLE "estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"usage_record_id" text NOT NULL,
	"factors_version" text NOT NULL,
	"tier" text NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"energy_it_wh_low" double precision NOT NULL,
	"energy_it_wh_mid" double precision NOT NULL,
	"energy_it_wh_high" double precision NOT NULL,
	"energy_facility_wh_low" double precision NOT NULL,
	"energy_facility_wh_mid" double precision NOT NULL,
	"energy_facility_wh_high" double precision NOT NULL,
	"onsite_ml_low" double precision NOT NULL,
	"onsite_ml_mid" double precision NOT NULL,
	"onsite_ml_high" double precision NOT NULL,
	"offsite_ml_low" double precision NOT NULL,
	"offsite_ml_mid" double precision NOT NULL,
	"offsite_ml_high" double precision NOT NULL,
	"embodied_ml_low" double precision NOT NULL,
	"embodied_ml_mid" double precision NOT NULL,
	"embodied_ml_high" double precision NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factor_sets" (
	"version" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"soif_version" text NOT NULL,
	"document" jsonb NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"file_path" text NOT NULL,
	"committed_offset" bigint DEFAULT 0 NOT NULL,
	"file_size" bigint DEFAULT 0 NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"last_scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"credential_cipher" text,
	"credential_key_id" text,
	"account_json" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"records_ingested" bigint DEFAULT 0 NOT NULL,
	"bytes_scanned" bigint DEFAULT 0 NOT NULL,
	"warnings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bucket_end" timestamp with time zone NOT NULL,
	"granularity" text NOT NULL,
	"day_key" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"inference_geo" text,
	"service_tier" text,
	"workspace_id" text,
	"api_key_id" text,
	"session_id" text,
	"source_file" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_cursors" ADD CONSTRAINT "scan_cursors_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_record_factors_idx" ON "estimates" USING btree ("usage_record_id","factors_version");--> statement-breakpoint
CREATE INDEX "estimates_factors_idx" ON "estimates" USING btree ("factors_version");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_cursors_source_file_idx" ON "scan_cursors" USING btree ("source_id","file_path");--> statement-breakpoint
CREATE INDEX "sources_kind_idx" ON "sources" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "sync_runs_source_idx" ON "sync_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_source_dedupe_idx" ON "usage_records" USING btree ("source_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "usage_records_day_idx" ON "usage_records" USING btree ("day_key");--> statement-breakpoint
CREATE INDEX "usage_records_model_idx" ON "usage_records" USING btree ("model");--> statement-breakpoint
CREATE INDEX "usage_records_bucket_idx" ON "usage_records" USING btree ("bucket_start");