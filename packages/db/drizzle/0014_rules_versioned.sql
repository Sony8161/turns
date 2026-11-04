ALTER TABLE "rule_configs" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "rule_configs" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "rule_configs" ADD CONSTRAINT "rule_configs_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Part 5: the "attention" rules (Duong, 2026-11-04: an unanswered call comes
-- back to the desk after 15 minutes; a wait of 30 minutes or more is a long
-- wait). A location whose newest config predates them gets a new version with
-- the defaults, so every stored config validates against the full schema.
insert into "rule_configs" ("organization_id", "location_id", "version", "config", "note")
select r."organization_id", r."location_id", r."version" + 1,
       r."config" || '{"attention": {"unanswered_call_min": 15, "long_wait_min": 30, "default_service_min": 45}}'::jsonb,
       'attention rules added with their defaults (migration 0014)'
from "rule_configs" r
where r."version" = (select max(v."version") from "rule_configs" v where v."location_id" = r."location_id")
  and jsonb_typeof(r."config") = 'object'
  and jsonb_typeof(r."config"->'attention') is distinct from 'object';
--> statement-breakpoint

-- Part 5: a rule config version is history. Nobody edits or removes one, not
-- even the service key; a change is a new version (design doc, working rules;
-- threat model T18).
create or replace function public.rule_configs_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'rule_configs is append-only: save a new version';
end;
$$;
--> statement-breakpoint
create trigger rule_configs_no_update
  before update on "rule_configs"
  for each row execute function public.rule_configs_append_only();
--> statement-breakpoint
create trigger rule_configs_no_delete
  before delete on "rule_configs"
  for each row execute function public.rule_configs_append_only();
--> statement-breakpoint
create trigger rule_configs_no_truncate
  before truncate on "rule_configs"
  for each statement execute function public.rule_configs_append_only();
