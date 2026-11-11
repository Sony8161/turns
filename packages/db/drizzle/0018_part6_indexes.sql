CREATE INDEX "appointments_location_start" ON "appointments" USING btree ("location_id","start_at");--> statement-breakpoint
CREATE INDEX "technician_restrictions_location" ON "technician_restrictions" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "technician_skills_location" ON "technician_skills" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "technician_tags_location" ON "technician_tags" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "visits_client" ON "visits" USING btree ("client_id");