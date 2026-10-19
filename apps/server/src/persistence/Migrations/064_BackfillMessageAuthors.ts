import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

// Necode: history copied from orchestration v1 into v2 lost who sent each user message. The v1
// rows still record it (author_member_id, migration 63); put it back on the copied messages, in
// both the import events and their projections so a projection rebuild keeps it. Threads copied
// later get it from LegacyV1ThreadImporter.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const [prefix, idPath] of [
    ["migration:v1:message:", "$.id"],
    ["migration:v1:turn-item:", "$.messageId"],
  ] as const) {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(
        payload_json,
        '$.authorMemberId',
        (
          SELECT legacy.author_member_id
          FROM projection_thread_messages AS legacy
          WHERE legacy.message_id = json_extract(orchestration_events.payload_json, ${idPath})
        )
      )
      WHERE event_id LIKE ${prefix + "%"}
        AND application_event_version = 2
        AND json_extract(payload_json, '$.authorMemberId') IS NULL
        AND (json_extract(payload_json, '$.role') = 'user'
          OR json_extract(payload_json, '$.type') = 'user_message')
        AND EXISTS (
          SELECT 1
          FROM projection_thread_messages AS legacy
          WHERE legacy.message_id = json_extract(orchestration_events.payload_json, ${idPath})
            AND legacy.author_member_id IS NOT NULL
        )
    `;
  }

  yield* sql`
    UPDATE orchestration_v2_projection_messages
    SET payload_json = json_set(
      payload_json,
      '$.authorMemberId',
      (
        SELECT legacy.author_member_id
        FROM projection_thread_messages AS legacy
        WHERE legacy.message_id = orchestration_v2_projection_messages.message_id
      )
    )
    WHERE role = 'user'
      AND json_extract(payload_json, '$.authorMemberId') IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_thread_messages AS legacy
        WHERE legacy.message_id = orchestration_v2_projection_messages.message_id
          AND legacy.author_member_id IS NOT NULL
      )
  `;

  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET payload_json = json_set(
      payload_json,
      '$.authorMemberId',
      (
        SELECT legacy.author_member_id
        FROM projection_thread_messages AS legacy
        WHERE legacy.message_id = json_extract(
          orchestration_v2_projection_turn_items.payload_json,
          '$.messageId'
        )
      )
    )
    WHERE type = 'user_message'
      AND json_extract(payload_json, '$.authorMemberId') IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_thread_messages AS legacy
        WHERE legacy.message_id = json_extract(
          orchestration_v2_projection_turn_items.payload_json,
          '$.messageId'
        )
          AND legacy.author_member_id IS NOT NULL
      )
  `;
});
