-- Row-level security for the Part 1 tables.
-- Design: Turn System Design Doc.md ("Multi-tenant from day one");
-- threat model T1 (cross-salon), T2 (bypassing the engine), T11 (techs and client data).
--
-- Rules:
--   1. App users (role authenticated) may SELECT rows of organizations they are
--      an active member of, and only their own profile.
--   2. App users have NO insert, update or delete on any table. Every write goes
--      through the server, which holds the service-role key. (T2)
--   3. The anon role sees nothing. The kiosk gets its own device key later (T25).
--   4. service_role bypasses RLS (Supabase default); the server's tenancy helper
--      is responsible for scoping those writes (memo 1, condition 1).

-- profiles.id must be a real auth user.
alter table "profiles"
  add constraint "profiles_id_auth_users_fk"
  foreign key ("id") references auth.users("id") on delete cascade;
--> statement-breakpoint

-- Supabase grants anon and authenticated ALL on every new table in public by
-- default, and does the same for future tables through default privileges.
-- Take that away first, for existing and future tables, so a right exists only
-- where a later migration grants it on purpose. (code review, 2026-11-04)
revoke all on all tables in schema public from anon, authenticated;
--> statement-breakpoint
revoke all on all sequences in schema public from anon, authenticated;
--> statement-breakpoint
revoke all on all functions in schema public from anon, authenticated;
--> statement-breakpoint
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
--> statement-breakpoint
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
--> statement-breakpoint
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
--> statement-breakpoint

-- Is the current user an active member of this organization?
-- security definer so the check does not itself trip the memberships policy.
-- search_path is empty and every name is qualified, so a caller cannot shadow
-- memberships with a temp table.
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.organization_id = org
      and m.active
  );
$$;
--> statement-breakpoint
revoke all on function public.is_org_member(uuid) from public, anon;
--> statement-breakpoint
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
--> statement-breakpoint

alter table "organizations" enable row level security;
--> statement-breakpoint
alter table "locations" enable row level security;
--> statement-breakpoint
alter table "profiles" enable row level security;
--> statement-breakpoint
alter table "memberships" enable row level security;
--> statement-breakpoint
alter table "technicians" enable row level security;
--> statement-breakpoint
alter table "service_categories" enable row level security;
--> statement-breakpoint
alter table "services" enable row level security;
--> statement-breakpoint
alter table "rule_configs" enable row level security;
--> statement-breakpoint

-- Read only for app users. No write grants on purpose.
grant select on "organizations", "locations", "profiles", "memberships", "technicians",
  "service_categories", "services", "rule_configs" to authenticated;
--> statement-breakpoint

create policy "organizations_select_member" on "organizations"
  for select to authenticated using (public.is_org_member(id));
--> statement-breakpoint
create policy "locations_select_member" on "locations"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "profiles_select_own" on "profiles"
  for select to authenticated using (id = (select auth.uid()));
--> statement-breakpoint
create policy "memberships_select_member" on "memberships"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "technicians_select_member" on "technicians"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "service_categories_select_member" on "service_categories"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "services_select_member" on "services"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "rule_configs_select_member" on "rule_configs"
  for select to authenticated using (public.is_org_member(organization_id));
