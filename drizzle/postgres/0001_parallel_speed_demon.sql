ALTER TABLE "usage_records" ADD COLUMN "project" text;--> statement-breakpoint
CREATE INDEX "usage_records_project_idx" ON "usage_records" USING btree ("project");