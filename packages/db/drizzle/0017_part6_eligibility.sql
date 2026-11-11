CREATE TYPE "public"."appointment_source" AS ENUM('ics', 'manual');--> statement-breakpoint
CREATE TYPE "public"."client_gender" AS ENUM('female', 'male', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."restriction_type" AS ENUM('no_male_clients', 'no_kids', 'no_same_time', 'min_client_age', 'custom');--> statement-breakpoint
-- 'excuse' must not be used by SQL in this same migration run: drizzle applies
-- pending migrations in one transaction, and Postgres refuses a new enum value
-- inside the transaction that added it. Code uses it; a later migration may.
ALTER TYPE "public"."ledger_reason" ADD VALUE 'excuse';--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"external_id" text,
	"client_name" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"source" "appointment_source" DEFAULT 'manual' NOT NULL,
	"synced_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text,
	"phone" text,
	"gender" "client_gender",
	"notes" text,
	"anonymised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "technician_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"type" "restriction_type" NOT NULL,
	"value" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_restrictions_technician_type" UNIQUE("technician_id","type")
);
--> statement-breakpoint
ALTER TABLE "technician_restrictions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "technician_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_skills_technician_category" UNIQUE("technician_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "technician_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "technician_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_tags_technician_tag" UNIQUE("technician_id","tag")
);
--> statement-breakpoint
ALTER TABLE "technician_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "turn_ledger" ADD COLUMN "reverses_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "client_gender" "client_gender";--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "client_is_kid" boolean;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "client_age" integer;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_restrictions" ADD CONSTRAINT "technician_restrictions_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_restrictions" ADD CONSTRAINT "technician_restrictions_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_category_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."service_categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_tags" ADD CONSTRAINT "technician_tags_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_tags" ADD CONSTRAINT "technician_tags_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_technician_start" ON "appointments" USING btree ("technician_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_location_external" ON "appointments" USING btree ("location_id","external_id") WHERE "appointments"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_location_phone" ON "clients" USING btree ("location_id","phone") WHERE "clients"."phone" is not null;--> statement-breakpoint
ALTER TABLE "turn_ledger" ADD CONSTRAINT "turn_ledger_reverses_id_turn_ledger_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."turn_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_ledger" ADD CONSTRAINT "turn_ledger_reverses" UNIQUE("reverses_id");--> statement-breakpoint

-- Part 6: read access. Writes still go only through the server (threat model
-- T2). Owners read the whole salon; managers and receptionists their own
-- location (as audit_log in 0009; T10). Skills, tags and restrictions: also a
-- technician for their own row. Clients: staff only; a technician's phone
-- never shows the client (design doc, Call flow; T11). Appointments: staff,
-- and a technician for their own.
grant select on "technician_skills", "technician_tags", "technician_restrictions",
  "clients", "appointments" to authenticated;
--> statement-breakpoint
create policy "technician_skills_select_staff" on "technician_skills"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "technician_skills_select_own" on "technician_skills"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
--> statement-breakpoint
create policy "technician_tags_select_staff" on "technician_tags"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "technician_tags_select_own" on "technician_tags"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
--> statement-breakpoint
create policy "technician_restrictions_select_staff" on "technician_restrictions"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "technician_restrictions_select_own" on "technician_restrictions"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
--> statement-breakpoint
create policy "clients_select_staff" on "clients"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "appointments_select_staff" on "appointments"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager','receptionist']::"role"[])
  );
--> statement-breakpoint
create policy "appointments_select_own" on "appointments"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
--> statement-breakpoint

-- The queue snapshot on a call says why each technician was passed over,
-- which can reveal the client's gender or age band and colleagues'
-- restrictions. A technician reads their own call (turn_calls_select_own)
-- without that column; the staff screens read through the server. Column
-- grants replace the table grant from 0012.
revoke select on "turn_calls" from authenticated;
--> statement-breakpoint
grant select ("id", "organization_id", "location_id", "visit_id", "technician_id",
  "called_at", "responded_at", "response", "deny_reason", "excused_by", "excused_at",
  "called_by", "created_at") on "turn_calls" to authenticated;
