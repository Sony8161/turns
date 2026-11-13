ALTER TABLE "calendar_feeds" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "tech_calendar_links" text DEFAULT 'owner_approves' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_calls_location_called" ON "turn_calls" USING btree ("location_id","called_at");--> statement-breakpoint
CREATE INDEX "visits_location_arrived" ON "visits" USING btree ("location_id","arrived_at");--> statement-breakpoint
CREATE INDEX "visits_assigned_open" ON "visits" USING btree ("assigned_technician_id") WHERE "visits"."status" in ('called', 'in_service');--> statement-breakpoint
-- v0.17.1 (review #6): the owner's choice for a technician's own Fresha link.
alter table "locations" add constraint "locations_tech_calendar_links_known"
  check (tech_calendar_links in ('owner_approves', 'name_must_match', 'open'));
--> statement-breakpoint
-- An approved link is not waiting any more.
alter table "calendar_feeds" add constraint "calendar_feeds_approval_consistent"
  check (not (needs_approval and approved_at is not null));
