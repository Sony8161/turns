ALTER TABLE "turn_calls" ADD COLUMN "auto_excused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "request_ack_at" timestamp with time zone;