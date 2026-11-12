ALTER TABLE "clients" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "search_name" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "receptionist_edits_technicians" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "kiosk_last_name" text;--> statement-breakpoint
CREATE INDEX "clients_location_search" ON "clients" USING btree ("location_id","search_name" text_pattern_ops);--> statement-breakpoint
-- Existing names: the first word is the first name, the rest the last name.
UPDATE "clients" SET
  "first_name" = nullif(split_part(btrim("name"), ' ', 1), ''),
  "last_name" = nullif(btrim(substr(btrim("name"), length(split_part(btrim("name"), ' ', 1)) + 1)), '')
WHERE "name" IS NOT NULL;--> statement-breakpoint
-- The search copy: lower case, Vietnamese and other Latin accents removed (the app writes it the same way).
UPDATE "clients" SET "search_name" = nullif(btrim(translate(lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '')), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿāăąćĉċčďēĕėęěĝğġģĥĩīĭįĵķĺļľńņňōŏőŕŗřśŝşšţťũūŭůűųŵŷźżžơưǎǐǒǔǖǘǚǜǟǡǧǩǫǭǰǵǹǻȁȃȅȇȉȋȍȏȑȓȕȗșțȟȧȩȫȭȯȱȳḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕẖẗẘẙạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ', 'aaaaaaceeeeiiiinooooouuuuyyaaaccccdeeeeegggghiiiijklllnnnooorrrssssttuuuuuuwyzzzouaiouuuuuaagkoojgnaaaeeiioorruusthaeooooyabbbcdddddeeeeefghhhhhiikkkllllmmmnnnnoooopprrrrsssssttttuuuuuvvwwwwwxxyzzzhtwyaaaaaaaaaaaaeeeeeeeeiioooooooooooouuuuuuuyyyyd')), '')
WHERE "name" IS NOT NULL;
