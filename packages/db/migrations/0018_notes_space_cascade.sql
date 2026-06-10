-- Deleting a space with notes used to 500: notes.space_id was created with
-- ON DELETE NO ACTION in 0000_initial.sql, so DELETE /api/spaces/:spaceId
-- blew up with an FK violation (and leaked the raw Postgres message).
-- Every sibling FK off spaces (chunks, folders, note_tags, note_links,
-- memberships via 0002) already cascades — notes was the odd one out.

ALTER TABLE notes DROP CONSTRAINT "notes_space_id_spaces_id_fk";
ALTER TABLE notes ADD CONSTRAINT "notes_space_id_spaces_id_fk"
  FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id")
  ON DELETE cascade ON UPDATE no action;
