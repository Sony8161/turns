ALTER TYPE "public"."call_response" ADD VALUE 'client_left';--> statement-breakpoint
ALTER TYPE "public"."visit_status" ADD VALUE 'left';--> statement-breakpoint
CREATE TABLE "help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid
);
--> statement-breakpoint
ALTER TABLE "help_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "is_fix" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "is_fix" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "fix_of_visit_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_acknowledged_by_profiles_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "help_requests_location_open" ON "help_requests" USING btree ("location_id","acknowledged_at");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visits_party" ON "visits" USING btree ("party_id");--> statement-breakpoint
-- v0.16.0: a fix points at the visit it fixes (same table, like a split).
ALTER TABLE "visits" ADD CONSTRAINT "visits_fix_of_fk" FOREIGN KEY ("fix_of_visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict;
--> statement-breakpoint
-- Only a fix waits for a manager's approval; a fix of nothing is allowed (the
-- manager approves it anyway when the desk found no visit in the window).
alter table "visits" add constraint "visits_approval_needs_fix"
  check (not needs_approval or is_fix);
--> statement-breakpoint
alter table "visits" add constraint "visits_fix_of_needs_fix"
  check (fix_of_visit_id is null or is_fix);
--> statement-breakpoint
-- The engine checks first; the database refuses a call for a kiosk visit the
-- desk has not confirmed, and (v0.16.0) for a fix a manager has not approved.
create or replace function public.turn_calls_need_confirmed_visit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from visits v where v.id = new.visit_id and v.needs_confirm) then
    raise exception 'visit waits for the desk to confirm';
  end if;
  if exists (select 1 from visits v where v.id = new.visit_id and v.needs_approval) then
    raise exception 'fix waits for a manager to approve';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
-- Need help: read like the board. Owners the whole salon, managers and
-- receptionists their own location, a technician her own rows. Writes go only
-- through the server (threat model T2).
grant select on "help_requests" to authenticated;
--> statement-breakpoint
create policy "help_requests_select_staff" on "help_requests"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "help_requests_select_own" on "help_requests"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
--> statement-breakpoint
-- One open request per technician: a second tap while one waits is the same request.
create unique index "help_requests_one_open" on "help_requests" ("technician_id")
  where acknowledged_at is null;
