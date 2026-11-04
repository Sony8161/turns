-- Part 3: the audit log is append-only for every role, and the daily-operation
-- tables are readable by salon members (no writes: those go through the server).
-- Design doc "Audit log"; threat model T2, T17.

-- Nobody updates or deletes an audit row, not even the service key.
create or replace function public.audit_log_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;
--> statement-breakpoint
create trigger audit_log_no_update
  before update on "audit_log"
  for each row execute function public.audit_log_append_only();
--> statement-breakpoint
create trigger audit_log_no_delete
  before delete on "audit_log"
  for each row execute function public.audit_log_append_only();
--> statement-breakpoint

-- Does the current user hold one of these roles at this organization?
create or replace function public.is_org_role(org uuid, roles "role"[])
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
      and m.role = any(roles)
  );
$$;
--> statement-breakpoint
revoke all on function public.is_org_role(uuid, "role"[]) from public, anon;
--> statement-breakpoint
grant execute on function public.is_org_role(uuid, "role"[]) to authenticated, service_role;
--> statement-breakpoint

-- Read only. The board is visible to everyone in the salon; the audit log to
-- owners and managers (design doc, Roles and permissions).
grant select on "shifts", "technician_status", "turn_ledger", "audit_log" to authenticated;
--> statement-breakpoint
create policy "shifts_select_member" on "shifts"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "technician_status_select_member" on "technician_status"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "turn_ledger_select_member" on "turn_ledger"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "audit_log_select_owner_manager" on "audit_log"
  for select to authenticated
  using (public.is_org_role(organization_id, array['owner','manager']::"role"[]));
