-- Trip ideas: holiday-aware date windows + live destination prices from the traveller's nearby airports.
CREATE TABLE trip_ideas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  params      jsonb NOT NULL DEFAULT '{}',
  result      jsonb,
  error       text,
  chosen_trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX trip_ideas_user ON trip_ideas(user_id, created_at DESC);
