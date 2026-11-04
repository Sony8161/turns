CREATE TYPE "public"."call_response" AS ENUM('accepted', 'denied', 'overridden', 'expired');--> statement-breakpoint
CREATE TYPE "public"."visit_source" AS ENUM('walk_in', 'appointment', 'request', 'self_checkin');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('waiting', 'called', 'in_service', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "turn_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"response" "call_response",
	"deny_reason" text,
	"excused_by" uuid,
	"excused_at" timestamp with time zone,
	"called_by" uuid,
	"queue_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visit_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"points_value_snapshot" numeric(4, 1) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_services_visit_service" UNIQUE("visit_id","service_id")
);
--> statement-breakpoint
ALTER TABLE "visit_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source" "visit_source" DEFAULT 'walk_in' NOT NULL,
	"status" "visit_status" DEFAULT 'waiting' NOT NULL,
	"requested_technician_id" uuid,
	"assigned_technician_id" uuid,
	"created_by" uuid,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"points_posted" numeric(4, 1),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_excused_by_profiles_id_fk" FOREIGN KEY ("excused_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_called_by_profiles_id_fk" FOREIGN KEY ("called_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_calls" ADD CONSTRAINT "turn_calls_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_services" ADD CONSTRAINT "visit_services_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_services" ADD CONSTRAINT "visit_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_requested_technician_id_technicians_id_fk" FOREIGN KEY ("requested_technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_assigned_technician_id_technicians_id_fk" FOREIGN KEY ("assigned_technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_calls_visit" ON "turn_calls" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "turn_calls_technician" ON "turn_calls" USING btree ("technician_id");--> statement-breakpoint
CREATE INDEX "visits_location_status" ON "visits" USING btree ("location_id","status");