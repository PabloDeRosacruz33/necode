// @effect-diagnostics nodeBuiltinImport:off -- Patches Node's socket class before the Effect runtime starts.
// @effect-diagnostics globalConsole:off -- Runs outside the Effect runtime, as the last word before a crash.
/**
 * Keeps the server process alive through socket failures Node reports as crashes. Installed once
 * by bin.ts, before the server makes or accepts any connection.
 *
 * - `setTypeOfService` becomes best effort everywhere, as Node already treats it on Windows.
 *   undici calls it before writing every HTTP/1 request; on macOS it fails with EINVAL when the
 *   peer has just closed an idle keep-alive connection that undici is reusing, and the throw
 *   escapes as an uncaught exception that took the whole server down.
 * - Any other uncaught failure of a single connection (a socket option or a reset/broken pipe)
 *   is logged instead of ending the process. Everything else still crashes as before, so the
 *   desktop app restarts a server whose state may be broken.
 */
import * as NodeNet from "node:net";

const SOCKET_OPTION_SYSCALLS = new Set(["setTypeOfService", "setNoDelay", "setKeepAlive"]);
const CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

const errnoFields = (error: unknown) =>
  error instanceof Error && "syscall" in error && "code" in error
    ? { syscall: String(error.syscall), code: String(error.code) }
    : null;

/** Whether `error` is one connection failing, which must not take the server down. */
export function isConnectionLevelError(error: unknown): boolean {
  const errno = errnoFields(error);
  if (!errno) return false;
  return (
    SOCKET_OPTION_SYSCALLS.has(errno.syscall) ||
    (CONNECTION_CODES.has(errno.code) && (errno.syscall === "read" || errno.syscall === "write"))
  );
}

const bestEffort = Symbol.for("necode.setTypeOfService.bestEffort");

/** `socket.setTypeOfService(tos)`, newer than the Node types this project builds against. */
interface TypeOfServiceSocket {
  setTypeOfService?: ((tos: number) => unknown) & { [bestEffort]?: true };
}

/** Makes `setTypeOfService` ignore failures of the system call; argument errors still throw. */
export function makeTypeOfServiceBestEffort(
  prototype: TypeOfServiceSocket = NodeNet.Socket.prototype as TypeOfServiceSocket,
): void {
  const original = prototype.setTypeOfService;
  if (typeof original !== "function" || original[bestEffort]) return;
  prototype.setTypeOfService = Object.assign(
    function (this: unknown, tos: number) {
      try {
        return original.call(this, tos);
      } catch (error) {
        if (errnoFields(error)?.syscall === "setTypeOfService") return this;
        throw error;
      }
    },
    { [bestEffort]: true as const },
  );
}

let installed = false;

export function installSocketGuards(): void {
  if (installed) return;
  installed = true;
  makeTypeOfServiceBestEffort();
  process.on("uncaughtException", (error, origin) => {
    if (isConnectionLevelError(error)) {
      console.warn("Ignored a failed connection instead of stopping the server:", error);
      return;
    }
    // What Node does without a listener: report and stop, so the desktop app restarts us.
    console.error(
      origin === "unhandledRejection" ? "Unhandled rejection:" : "Uncaught exception:",
      error,
    );
    process.exit(1);
  });
}
