ALTER TABLE "appointments" ADD COLUMN "no_show_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "no_show_by" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "receptionist_acts_for_technicians" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD COLUMN "answered_by" uuid;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD COLUMN "left_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD COLUMN "left_claim_outcome" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "auto_finished" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "finished_by" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_show_by_profiles_id_fk" FOREIGN KEY ("no_show_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_answered_by_profiles_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_finished_by_profiles_id_fk" FOREIGN KEY ("finished_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- v0.17.0: the reasons a visit closes without a finish, and the desk's
-- answers to a technician's "client left". Anything else is refused.
alter table "visits" add constraint "visits_close_reason_known"
  check (close_reason is null or close_reason in ('day_end', 'walked_out', 'client_left'));
--> statement-breakpoint
alter table "turn_calls" add constraint "turn_calls_left_claim_outcome_known"
  check (left_claim_outcome is null or left_claim_outcome in ('confirmed', 'client_here', 'direct'));
--> statement-breakpoint
-- An auto-finished visit is a completed one.
alter table "visits" add constraint "visits_auto_finished_completed"
  check (not auto_finished or status = 'completed');
--> statement-breakpoint
-- The client page counts no-shows by client.
create index "appointments_client" on "appointments" ("client_id") where client_id is not null;
