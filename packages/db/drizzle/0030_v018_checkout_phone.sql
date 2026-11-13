ALTER TABLE "locations" ADD COLUMN "checkout_list" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "receptionist_sees_client_phone" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "checked_out_by" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_checked_out_by_profiles_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visits_to_check_out" ON "visits" USING btree ("location_id","completed_at") WHERE "visits"."status" = 'completed' and "visits"."checked_out_at" is null;--> statement-breakpoint
-- v0.18.0 (F1): only a finished visit is checked out.
alter table "visits" add constraint "visits_checked_out_completed"
  check (checked_out_at is null or status = 'completed');
