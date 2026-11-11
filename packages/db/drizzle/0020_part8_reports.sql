CREATE TABLE "daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"date" date NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_summaries_location_date" UNIQUE("location_id","date")
);
--> statement-breakpoint
ALTER TABLE "daily_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_location_action_at" ON "audit_log" USING btree ("location_id","action","at");--> statement-breakpoint
-- Part 8: end-of-day summaries are written once and never changed, like the
-- audit log they are counted from (threat model T17).
create or replace function public.daily_summaries_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'daily_summaries is append-only';
end;
$$;
--> statement-breakpoint
create trigger daily_summaries_no_update
  before update on "daily_summaries"
  for each row execute function public.daily_summaries_append_only();
--> statement-breakpoint
create trigger daily_summaries_no_delete
  before delete on "daily_summaries"
  for each row execute function public.daily_summaries_append_only();
--> statement-breakpoint
create trigger daily_summaries_no_truncate
  before truncate on "daily_summaries"
  for each statement execute function public.daily_summaries_append_only();
--> statement-breakpoint
-- Read only, and only by whoever may read the audit log it summarises: the
-- owner for the whole salon, a manager for their own location.
revoke all on "daily_summaries" from anon, authenticated;
--> statement-breakpoint
grant select on "daily_summaries" to authenticated;
--> statement-breakpoint
create policy "daily_summaries_select_owner_or_location_manager" on "daily_summaries"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager']::"role"[])
  );
