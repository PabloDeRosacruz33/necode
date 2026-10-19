import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("064_BackfillMessageAuthors", (it) => {
  it.effect("puts the v1 author back on copied user messages and their turn items", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      const at = "2026-10-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, author_member_id
        ) VALUES
          ('m-roi', 't-1', 'user', 'hola', 0, ${at}, ${at}, 'member-roi'),
          ('m-none', 't-1', 'user', 'sin autor', 0, ${at}, ${at}, NULL)
      `;
      for (const id of ["m-roi", "m-none"]) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (${id}, 't-1', 'user', 0, ${at}, ${at}, ${JSON.stringify({ id, role: "user" })})
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`migration:v1:turn-item:${id}`}, 't-1', 1, 'user_message', 'completed', ${at},
            ${JSON.stringify({ type: "user_message", messageId: id })}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 64 });

      const messages = yield* sql<{ readonly id: string; readonly author: string | null }>`
        SELECT message_id AS "id", json_extract(payload_json, '$.authorMemberId') AS "author"
        FROM orchestration_v2_projection_messages ORDER BY message_id
      `;
      assert.deepEqual(messages, [
        { id: "m-none", author: null },
        { id: "m-roi", author: "member-roi" },
      ]);
      const items = yield* sql<{ readonly id: string; readonly author: string | null }>`
        SELECT json_extract(payload_json, '$.messageId') AS "id",
          json_extract(payload_json, '$.authorMemberId') AS "author"
        FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id
      `;
      assert.deepEqual(items, [
        { id: "m-none", author: null },
        { id: "m-roi", author: "member-roi" },
      ]);
    }),
  );
});
