ALTER TABLE "kiosk_devices" ADD COLUMN "unlock_token_hash" text;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD COLUMN "unlock_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "kiosk_phone" text;--> statement-breakpoint
-- v0.9.1: only a kiosk visit carries a typed phone, and only while it waits
-- for the desk (review finding 1).
alter table "visits" add constraint "visits_kiosk_phone_needs_kiosk"
  check (kiosk_phone is null or (kiosk_device_id is not null and needs_confirm));
