ALTER TABLE "service_categories" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "archived_at" timestamp with time zone;