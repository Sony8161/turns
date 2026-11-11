CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_hint" text NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"last_event_count" integer,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feeds_technician" UNIQUE("technician_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_feeds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "feed_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "visit_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_feeds_location" ON "calendar_feeds" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_feed_id_calendar_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."calendar_feeds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_feed" ON "appointments" USING btree ("feed_id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_visit" UNIQUE("visit_id");--> statement-breakpoint

-- Part 7: the feed URL is a secret (threat model T14). No app role reads this
-- table at all, not even its own salon's rows; the server reads it with the
-- service connection and the screens get the hint and the sync state. The
-- default privileges from 0001 already grant nothing; this says it on purpose
-- so a later "grant select on all tables" cannot be read as covering it.
revoke all on "calendar_feeds" from anon, authenticated;
--> statement-breakpoint

-- Part 7: with a second location, visits and calls are read per location like
-- the Part 6 tables (T10). 0012 let any receptionist or manager of the salon
-- read every location's visits and calls; the owner still reads the whole salon.
drop policy "visits_select_staff" on "visits";
--> statement-breakpoint
create policy "visits_select_staff" on "visits"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
drop policy "turn_calls_select_staff" on "turn_calls";
--> statement-breakpoint
create policy "turn_calls_select_staff" on "turn_calls"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
-- visit_services has no location of its own: it follows the visit (staff of
-- that location) or the technician's own call. Both subqueries run under the
-- caller's own policies.
drop policy "visit_services_select_member" on "visit_services";
--> statement-breakpoint
create policy "visit_services_select_scoped" on "visit_services"
  for select to authenticated
  using (
    visit_id in (select v.id from public.visits v)
    or visit_id in (select c.visit_id from public.turn_calls c)
  );
