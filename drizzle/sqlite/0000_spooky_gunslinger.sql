CREATE TABLE `estimates` (
	`id` text PRIMARY KEY NOT NULL,
	`usage_record_id` text NOT NULL,
	`factors_version` text NOT NULL,
	`tier` text NOT NULL,
	`provider` text NOT NULL,
	`region` text NOT NULL,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`energy_it_wh_low` real NOT NULL,
	`energy_it_wh_mid` real NOT NULL,
	`energy_it_wh_high` real NOT NULL,
	`energy_facility_wh_low` real NOT NULL,
	`energy_facility_wh_mid` real NOT NULL,
	`energy_facility_wh_high` real NOT NULL,
	`onsite_ml_low` real NOT NULL,
	`onsite_ml_mid` real NOT NULL,
	`onsite_ml_high` real NOT NULL,
	`offsite_ml_low` real NOT NULL,
	`offsite_ml_mid` real NOT NULL,
	`offsite_ml_high` real NOT NULL,
	`embodied_ml_low` real NOT NULL,
	`embodied_ml_mid` real NOT NULL,
	`embodied_ml_high` real NOT NULL,
	`computed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`usage_record_id`) REFERENCES `usage_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `estimates_record_factors_idx` ON `estimates` (`usage_record_id`,`factors_version`);--> statement-breakpoint
CREATE INDEX `estimates_factors_idx` ON `estimates` (`factors_version`);--> statement-breakpoint
CREATE TABLE `factor_sets` (
	`version` text PRIMARY KEY NOT NULL,
	`schema_version` text NOT NULL,
	`soif_version` text NOT NULL,
	`document` text NOT NULL,
	`loaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scan_cursors` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`file_path` text NOT NULL,
	`committed_offset` integer DEFAULT 0 NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`last_scanned_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_cursors_source_file_idx` ON `scan_cursors` (`source_id`,`file_path`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`credential_cipher` text,
	`credential_key_id` text,
	`account_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_synced_at` integer,
	`last_sync_error` text
);
--> statement-breakpoint
CREATE INDEX `sources_kind_idx` ON `sources` (`kind`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`records_ingested` integer DEFAULT 0 NOT NULL,
	`bytes_scanned` integer DEFAULT 0 NOT NULL,
	`warnings_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_source_idx` ON `sync_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`bucket_end` integer NOT NULL,
	`granularity` text NOT NULL,
	`day_key` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`inference_geo` text,
	`service_tier` text,
	`workspace_id` text,
	`api_key_id` text,
	`session_id` text,
	`source_file` text,
	`ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_source_dedupe_idx` ON `usage_records` (`source_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `usage_records_day_idx` ON `usage_records` (`day_key`);--> statement-breakpoint
CREATE INDEX `usage_records_model_idx` ON `usage_records` (`model`);--> statement-breakpoint
CREATE INDEX `usage_records_bucket_idx` ON `usage_records` (`bucket_start`);