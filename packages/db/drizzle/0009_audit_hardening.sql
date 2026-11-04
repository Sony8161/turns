-- Security sweep after Part 3: the audit log cannot be truncated either, and a
-- manager reads the audit log of their own location only (threat model T10, T17).

create trigger audit_log_no_truncate
  before truncate on "audit_log"
  for each statement execute function public.audit_log_append_only();
--> statement-breakpoint

-- Does the current user hold one of these roles at this location?
create or replace function public.is_location_role(loc uuid, roles "role"[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.location_id = loc
      and m.active
      and m.role = any(roles)
  );
$$;
--> statement-breakpoint
revoke all on function public.is_location_role(uuid, "role"[]) from public, anon;
--> statement-breakpoint
grant execute on function public.is_location_role(uuid, "role"[]) to authenticated, service_role;
--> statement-breakpoint

drop policy "audit_log_select_owner_manager" on "audit_log";
--> statement-breakpoint
-- Owners see the whole salon; managers see their own location.
create policy "audit_log_select_owner_or_location_manager" on "audit_log"
  for select to authenticated
  using (
    public.is_org_role(organization_id, array['owner']::"role"[])
    or public.is_location_role(location_id, array['manager']::"role"[])
  );
