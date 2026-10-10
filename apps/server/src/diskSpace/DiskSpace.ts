// @effect-diagnostics nodeBuiltinImport:off -- statfs has no Effect FileSystem equivalent.
/**
 * Watches free space on the disk holding the environment's state (the database, logs) and its
 * task folders, which is what filling up takes the whole server down with. Every client is told
 * when it runs low; when it is critical, new task folders are refused so what is left stays for
 * the database.
 */
import type { ServerDiskSpace } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

const GiB = 1024 ** 3;
const CHECK_INTERVAL = Duration.minutes(1);

/** Level for `freeBytes` free of `totalBytes`; small disks get proportional thresholds. */
export const diskSpaceLevel = (freeBytes: number, totalBytes: number): ServerDiskSpace["level"] =>
  freeBytes < Math.min(5 * GiB, totalBytes * 0.03)
    ? "critical"
    : freeBytes < Math.min(15 * GiB, totalBytes * 0.1)
      ? "low"
      : "ok";

const measure = (path: string) =>
  Effect.tryPromise(() => NodeFSP.statfs(path)).pipe(
    Effect.map((stats): ServerDiskSpace => {
      const freeBytes = stats.bavail * stats.bsize;
      const totalBytes = stats.blocks * stats.bsize;
      return { level: diskSpaceLevel(freeBytes, totalBytes), freeBytes, totalBytes };
    }),
    Effect.option,
  );

/** "4,2 GB" in the person's terms. */
export const formatGigabytes = (bytes: number) =>
  `${(bytes / 1e9).toLocaleString("es-ES", { maximumFractionDigits: 1 })} GB`;

export class DiskSpace extends Context.Service<
  DiskSpace,
  {
    readonly current: Effect.Effect<ServerDiskSpace>;
    /** The current measurement, then one whenever the level or about a gigabyte changes. */
    readonly changes: Stream.Stream<ServerDiskSpace>;
    /** Why a new task folder must not be made now, or null when there is room. */
    readonly refusal: Effect.Effect<string | null>;
  }
>()("t3/diskSpace/DiskSpace") {}

export const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const initial: ServerDiskSpace = { level: "ok", freeBytes: 0, totalBytes: 0 };
  const ref = yield* SubscriptionRef.make(initial);
  const check = measure(stateDir).pipe(
    Effect.flatMap((measured) =>
      measured._tag === "None"
        ? Effect.void
        : SubscriptionRef.update(ref, (previous) =>
            previous.level === measured.value.level &&
            Math.abs(previous.freeBytes - measured.value.freeBytes) < GiB
              ? previous
              : measured.value,
          ),
    ),
  );
  yield* check;
  yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  const current = SubscriptionRef.get(ref);
  return DiskSpace.of({
    current,
    changes: SubscriptionRef.changes(ref).pipe(Stream.changes),
    refusal: current.pipe(
      Effect.map((space) =>
        space.level === "critical"
          ? `Al disco de este equipo solo le quedan ${formatGigabytes(space.freeBytes)} libres. Libera espacio antes de crear otra tarea.`
          : null,
      ),
    ),
  });
});

export const layer = Layer.effect(DiskSpace, make);
