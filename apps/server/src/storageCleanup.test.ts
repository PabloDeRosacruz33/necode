import { assert, describe, it } from "@effect/vitest";

import { REGENERABLE_IGNORED } from "./storageCleanup.ts";

describe("REGENERABLE_IGNORED", () => {
  it("lets builds, installs and setup links go with a task folder, but not anything personal", () => {
    for (const entry of [
      "node_modules/",
      "apps/mobile/node_modules/",
      "apps/mobile/build/",
      "apps/mobile/ios/",
      "apps/cloud/.next/",
      "apps/web/dist/",
      ".vercel",
      "supabase/.temp",
    ]) {
      assert.isTrue(REGENERABLE_IGNORED.test(entry), entry);
    }
    for (const entry of [
      ".env",
      "apps/web/.env.local",
      "notes.md",
      "data/export.csv",
      "buildinfo/",
    ]) {
      assert.isFalse(REGENERABLE_IGNORED.test(entry), entry);
    }
  });
});
