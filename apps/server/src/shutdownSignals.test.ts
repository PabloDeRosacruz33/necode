// @effect-diagnostics nodeBuiltinImport:off -- A stand-in for the Node process.
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import * as NodeEvents from "node:events";

import { installShutdownSignals } from "./shutdownSignals.ts";

/** A process with runMain's listeners already on it, recording what would stop the program. */
const fakeProcess = (env: Record<string, string>) => {
  const emitter = new NodeEvents.EventEmitter();
  const stopped: Array<string> = [];
  const exits: Array<number> = [];
  emitter.on("SIGINT", () => stopped.push("SIGINT"));
  emitter.on("SIGTERM", () => stopped.push("SIGTERM"));
  const target = Object.assign(emitter, { env, exit: (code: number) => void exits.push(code) });
  return { target: target as unknown as NodeJS.Process, emitter, stopped, exits, env };
};

describe("installShutdownSignals", () => {
  afterEach(() => vi.useRealTimers());

  it("under the desktop app, a SIGTERM from someone else stops nothing", () => {
    vi.useFakeTimers();
    const process = fakeProcess({ T3CODE_DESKTOP_MANAGED: "1" });
    installShutdownSignals(process.target);

    assert.isUndefined(process.env.T3CODE_DESKTOP_MANAGED);
    process.emitter.emit("SIGTERM");
    vi.advanceTimersByTime(60_000);
    assert.deepStrictEqual(process.stopped, []);
    assert.deepStrictEqual(process.exits, []);

    // The app's own SIGINT stops it, and a cleanup that never ends cannot keep it alive.
    process.emitter.emit("SIGINT");
    assert.deepStrictEqual(process.stopped, ["SIGINT"]);
    vi.advanceTimersByTime(15_000);
    assert.deepStrictEqual(process.exits, [1]);
  });

  it("outside the desktop app, SIGTERM still stops the server, within the deadline", () => {
    vi.useFakeTimers();
    const process = fakeProcess({});
    installShutdownSignals(process.target);

    process.emitter.emit("SIGTERM");
    assert.deepStrictEqual(process.stopped, ["SIGTERM"]);
    vi.advanceTimersByTime(14_000);
    assert.deepStrictEqual(process.exits, []);
    vi.advanceTimersByTime(1_000);
    assert.deepStrictEqual(process.exits, [1]);
  });
});
