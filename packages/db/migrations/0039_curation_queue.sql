-- The curation queue: what an owner is asked to confirm this week.
--
-- The mechanism from "Company Brain — modo funcional" §8, stored. An agent
-- proposes what deserves to be confirmed, with its citation; a domain owner
-- clears the batch in fifteen minutes; what is confirmed rises to
-- `rank: preferred` with a signature (migration 0036).
--
-- THE RULE THIS TABLE ENFORCES, and the reason it is small: the human budget
-- is fixed, and when there are more candidates than budget the bar rises —
-- never the load. So a build REPLACES the open batch rather than appending to
-- it. There is no backlog by construction: a queue that grows is the failure
-- signal, not evidence of demand. What did not make this week's cut stays in
-- the notes, uncurated and marked as such, and competes again next week if it
-- gets used more.
CREATE TABLE IF NOT EXISTS curation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,

  -- The question, already written, that the owner answers with yes or no.
  -- For a fact derived from a table this is a template and no model is
  -- involved; for prose it is drafted (ADR-006) and may be absent when no
  -- generation provider is configured — which is a working state, not a
  -- broken one.
  question text NOT NULL,
  -- Where it came from, so a bad question is visible rather than silently
  -- promoted: the quoted claim and the line it sits on.
  citation text NOT NULL,
  source_line integer,

  -- What put it here, in the ordering's own terms. Kept so the queue can
  -- explain itself: "used 9 times this month · nobody ever signed it".
  use_count bigint NOT NULL DEFAULT 0,
  score real NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'open',
  -- Recorded on every decision, and REQUIRED to reject: an owner must not be
  -- able to turn the memory into their version of events in silence.
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  reason text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT curation_queue_status_known
    CHECK (status IN ('open', 'confirmed', 'superseded', 'rejected', 'reassigned')),
  -- A rejection without a reason is exactly the silence this table exists to
  -- prevent, so the table refuses it rather than trusting every caller.
  CONSTRAINT curation_queue_rejection_has_reason
    CHECK (status <> 'rejected' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

-- One open item per note: proposing the same claim twice in a batch spends
-- the human budget on a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS curation_queue_open_note_uniq
  ON curation_queue (space_id, note_id)
  WHERE status = 'open';

-- The batch read: this space's open items, best first.
CREATE INDEX IF NOT EXISTS curation_queue_open_idx
  ON curation_queue (space_id, score DESC)
  WHERE status = 'open';

ALTER TABLE curation_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE curation_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS curation_queue_space_member ON curation_queue;
CREATE POLICY curation_queue_space_member ON curation_queue
    USING (diluxite_can_access_space(curation_queue.space_id, diluxite_current_user_id()));
