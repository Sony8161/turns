ALTER TABLE "locations" DROP CONSTRAINT "locations_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_location_id_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "rule_configs" DROP CONSTRAINT "rule_configs_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "rule_configs" DROP CONSTRAINT "rule_configs_location_id_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "service_categories" DROP CONSTRAINT "service_categories_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "service_categories" DROP CONSTRAINT "service_categories_location_id_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_location_id_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_category_id_service_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "technicians" DROP CONSTRAINT "technicians_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "technicians" DROP CONSTRAINT "technicians_location_id_locations_id_fk";
--> statement-breakpoint
-- Hand-reordered (2026-11-04): the composite foreign keys below need these
-- unique constraints to exist first; drizzle-kit emitted them last.
ALTER TABLE "locations" ADD CONSTRAINT "locations_id_organization" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_id_organization" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_configs" ADD CONSTRAINT "rule_configs_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."service_categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_active_user_org" ON "memberships" USING btree ("user_id","organization_id") WHERE active;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_name" UNIQUE("organization_id","name");--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_location_name" UNIQUE("location_id","name");--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_user_location" UNIQUE("user_id","location_id");