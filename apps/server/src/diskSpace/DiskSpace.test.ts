import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as DiskSpace from "./DiskSpace.ts";

const GiB = 1024 ** 3;

describe("DiskSpace", () => {
  it("warns below 15 GB free and stops new task folders below 5 GB", () => {
    assert.equal(DiskSpace.diskSpaceLevel(40 * GiB, 228 * GiB), "ok");
    assert.equal(DiskSpace.diskSpaceLevel(14 * GiB, 228 * GiB), "low");
    assert.equal(DiskSpace.diskSpaceLevel(0.2 * GiB, 228 * GiB), "critical");
    // A small disk is judged by its share free, not by gigabytes it never had.
    assert.equal(DiskSpace.diskSpaceLevel(8 * GiB, 32 * GiB), "ok");
    assert.equal(DiskSpace.diskSpaceLevel(0.5 * GiB, 32 * GiB), "critical");
  });

  it.effect("measures the disk holding the state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-disk-space-" });
      const disk = yield* DiskSpace.DiskSpace.pipe(
        Effect.provide(
          DiskSpace.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
        ),
      );
      const space = yield* disk.current;
      assert.isAbove(space.totalBytes, 0);
      assert.isAtMost(space.freeBytes, space.totalBytes);
      assert.equal(space.level, DiskSpace.diskSpaceLevel(space.freeBytes, space.totalBytes));
      assert.equal(
        yield* disk.refusal,
        space.level === "critical"
          ? `Al disco de este equipo solo le quedan ${DiskSpace.formatGigabytes(space.freeBytes)} libres. Libera espacio antes de crear otra tarea.`
          : null,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
