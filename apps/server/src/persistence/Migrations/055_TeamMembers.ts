import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// Team members are the people allowed on this environment. Their sessions carry
// the subject `member:<member_id>`; user messages record who sent them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_members (
      member_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!columns.some((column) => column.name === "author_member_id")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN author_member_id TEXT
    `;
  }
});
