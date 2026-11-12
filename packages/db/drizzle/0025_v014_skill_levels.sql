CREATE TYPE "public"."skill_level" AS ENUM('regular', 'gel', 'dip', 'acrylic');--> statement-breakpoint
CREATE TABLE "technician_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_services_technician_service" UNIQUE("technician_id","service_id")
);
--> statement-breakpoint
ALTER TABLE "technician_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "min_level" "skill_level" DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "turn_levels" "skill_level"[];--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "desk_picks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "technicians" ADD COLUMN "skill_level" "skill_level";--> statement-breakpoint
ALTER TABLE "turn_calls" ADD COLUMN "kind" text DEFAULT 'turn' NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "split_from_visit_id" uuid;--> statement-breakpoint
ALTER TABLE "technician_services" ADD CONSTRAINT "technician_services_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_services" ADD CONSTRAINT "technician_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_services" ADD CONSTRAINT "technician_services_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "technician_services_location" ON "technician_services" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_kind_check" CHECK ("kind" in ('turn', 'offer', 'desk_pick'));
--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_split_from_fk" FOREIGN KEY ("split_from_visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict;
--> statement-breakpoint
-- v0.14.0: read access as technician_skills (0017): owners the whole salon,
-- managers and receptionists their own location, a technician their own rows.
-- Writes go only through the server (threat model T2).
grant select on "technician_services" to authenticated;
--> statement-breakpoint
create policy "technician_services_select_staff" on "technician_services"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "technician_services_select_own" on "technician_services"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
