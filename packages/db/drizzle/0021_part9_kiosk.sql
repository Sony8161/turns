CREATE TABLE "kiosk_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"pin_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "kiosk_devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "kiosk_devices_pairing_code_hash_unique" UNIQUE("pairing_code_hash")
);
--> statement-breakpoint
ALTER TABLE "kiosk_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "kiosk_device_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "kiosk_name" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "needs_confirm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_revoked_by_profiles_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kiosk_devices_location" ON "kiosk_devices" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_confirmed_by_profiles_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Part 9: the kiosk token and PIN hashes are secrets (threat model T25). No
-- app role reads this table, not even the owner; the admin screen gets names
-- and dates through the server. Same as calendar_feeds in 0019.
revoke all on "kiosk_devices" from anon, authenticated;
--> statement-breakpoint
-- A kiosk visit belongs to the kiosk's own location, and only a kiosk visit
-- can wait for the desk's confirm.
alter table "visits" add constraint "visits_confirm_needs_kiosk"
  check (not needs_confirm or kiosk_device_id is not null);
--> statement-breakpoint
create or replace function public.visits_kiosk_same_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.kiosk_device_id is not null and not exists (
    select 1 from kiosk_devices k
    where k.id = new.kiosk_device_id
      and k.location_id = new.location_id
      and k.organization_id = new.organization_id
  ) then
    raise exception 'kiosk visit at another location';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger visits_kiosk_same_location
  before insert or update of kiosk_device_id, location_id on "visits"
  for each row execute function public.visits_kiosk_same_location();
--> statement-breakpoint
-- The engine checks first; the database refuses a call for a kiosk visit the
-- desk has not confirmed yet (design doc, Customer self check-in; Q6).
create or replace function public.turn_calls_need_confirmed_visit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from visits v where v.id = new.visit_id and v.needs_confirm) then
    raise exception 'visit waits for the desk to confirm';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger turn_calls_need_confirmed_visit
  before insert on "turn_calls"
  for each row execute function public.turn_calls_need_confirmed_visit();
