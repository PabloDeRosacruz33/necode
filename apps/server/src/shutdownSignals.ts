// @effect-diagnostics globalConsole:off -- Signal handling outside the Effect runtime.
// @effect-diagnostics globalTimers:off -- The deadline must fire even when the runtime is stuck.
/**
 * Which signals stop the server, installed by bin.ts right after `NodeRuntime.runMain` (which
 * stops the program on SIGINT and SIGTERM):
 *
 * - Under the desktop app only SIGINT does, which is what the app sends. SIGTERM is what
 *   `kill <pid>` and `kill $(lsof -ti tcp:<port>)` send: agents run those to stop their own dev
 *   servers, and this server is often connected to those very ports (it forwards and previews
 *   them), so it stopped along with them and every client was left on "Reconnecting".
 * - Once stopping, the process ends within a deadline even if a cleanup step never finishes, so
 *   the desktop app sees the exit and, when it did not ask for the stop, starts another server.
 */
const DESKTOP_MANAGED_ENV = "T3CODE_DESKTOP_MANAGED";
const STOP_DEADLINE_MS = 15_000;

export function installShutdownSignals(target: NodeJS.Process = process): void {
  const desktopManaged = target.env[DESKTOP_MANAGED_ENV] === "1";
  // Read once: agents, terminals and the servers they start must not inherit it.
  delete target.env[DESKTOP_MANAGED_ENV];
  if (desktopManaged) {
    for (const listener of target.listeners("SIGTERM")) target.removeListener("SIGTERM", listener);
    target.on("SIGTERM", () => {
      console.warn("Ignored SIGTERM: under the desktop app only SIGINT stops the server.");
    });
  }
  const stopSignals: ReadonlyArray<NodeJS.Signals> = desktopManaged
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  for (const signal of stopSignals) {
    target.once(signal, () => {
      setTimeout(() => {
        console.error(
          `The server did not finish stopping ${STOP_DEADLINE_MS / 1000}s after ${signal}; exiting.`,
        );
        target.exit(1);
      }, STOP_DEADLINE_MS).unref();
    });
  }
}
