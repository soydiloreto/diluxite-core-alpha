-- v4.1 — Organizations + tiered roles.
--
-- Adds the `organizations` and `org_memberships` tables, links existing
-- spaces to a per-space "Local" org (so v4.0 installs migrate cleanly), and
-- refines the workspace membership role default ('editor' replaces 'member').
--
-- Data-safe: org_id is added nullable, backfilled with an auto-created org
-- per existing space, then promoted to NOT NULL.

CREATE TABLE "organizations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "slug" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);

CREATE TABLE "org_memberships" (
    "org_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "role" text DEFAULT 'member' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "org_memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
    CONSTRAINT "org_memberships_org_id_organizations_id_fk"
        FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade,
    CONSTRAINT "org_memberships_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade
);

CREATE INDEX "org_memberships_user_idx" ON "org_memberships" USING btree ("user_id");

ALTER TABLE "spaces" ADD COLUMN "org_id" uuid;

-- Backfill: every existing space gets its own auto-created "Local" org, and
-- the space's owner becomes super_admin of it. Existing membership rows for
-- the workspace are mirrored into org_memberships so members stay reachable.
DO $$
DECLARE
    space_row RECORD;
    new_org_id uuid;
    membership_row RECORD;
BEGIN
    FOR space_row IN SELECT id, owner_id, name FROM spaces WHERE org_id IS NULL LOOP
        INSERT INTO organizations (name, slug)
        VALUES (
            'Local',
            'local-' || substr(space_row.id::text, 1, 8)
        )
        RETURNING id INTO new_org_id;

        UPDATE spaces SET org_id = new_org_id WHERE id = space_row.id;

        INSERT INTO org_memberships (org_id, user_id, role)
        VALUES (new_org_id, space_row.owner_id, 'super_admin')
        ON CONFLICT DO NOTHING;

        -- Any user that already had per-space membership becomes a plain
        -- org member as well, so they remain visible in the admin console.
        FOR membership_row IN
            SELECT user_id FROM memberships WHERE space_id = space_row.id
        LOOP
            INSERT INTO org_memberships (org_id, user_id, role)
            VALUES (new_org_id, membership_row.user_id, 'member')
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

ALTER TABLE "spaces" ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "spaces"
    ADD CONSTRAINT "spaces_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;

-- Membership refinement: replace 'member' default with 'editor' (closer to
-- the intended ACL meaning); add created_at so admin UI can sort joins by
-- recency. Existing rows keep their role; the default only affects new rows.
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'editor';
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;

-- Re-create cascading FKs to match the new schema (Drizzle drops + re-adds
-- them when the cascade clause changes; we do it here explicitly).
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_space_id_spaces_id_fk";
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_user_id_users_id_fk";
ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_space_id_spaces_id_fk"
    FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade;
ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;

CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");
