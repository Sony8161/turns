-- Part 4: the database enforces what the engine must never get wrong
-- (design doc, Architecture; threat model T3), and read access for the floor.

-- A technician has at most one open call; a visit has at most one open call.
create unique index "turn_calls_one_open_per_technician"
  on "turn_calls" ("technician_id") where "responded_at" is null;
--> statement-breakpoint
create unique index "turn_calls_one_open_per_visit"
  on "turn_calls" ("visit_id") where "responded_at" is null;
--> statement-breakpoint

-- Read only. Visits and calls are visible to the salon's staff; technicians
-- see only their own calls, and never client details (none stored yet).
grant select on "visits", "visit_services", "turn_calls" to authenticated;
--> statement-breakpoint
create policy "visits_select_staff" on "visits"
  for select to authenticated
  using (public.is_org_role(organization_id, array['owner','manager','receptionist']::"role"[]));
--> statement-breakpoint
create policy "visit_services_select_member" on "visit_services"
  for select to authenticated using (public.is_org_member(organization_id));
--> statement-breakpoint
create policy "turn_calls_select_staff" on "turn_calls"
  for select to authenticated
  using (public.is_org_role(organization_id, array['owner','manager','receptionist']::"role"[]));
--> statement-breakpoint
create policy "turn_calls_select_own" on "turn_calls"
  for select to authenticated
  using (technician_id in (
    select t.id from public.technicians t where t.user_id = (select auth.uid())
  ));
