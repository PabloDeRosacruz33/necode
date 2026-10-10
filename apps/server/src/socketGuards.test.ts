// @effect-diagnostics nodeBuiltinImport:off -- Exercises Node's own socket class.
import { assert, describe, it } from "@effect/vitest";
import * as NodeNet from "node:net";

import { isConnectionLevelError, makeTypeOfServiceBestEffort } from "./socketGuards.ts";

type WithTypeOfService = NodeNet.Socket & { setTypeOfService: (tos: number) => unknown };

/** A connected socket whose system call for the type of service fails as on macOS (EINVAL). */
const socketFailingTypeOfService = () =>
  new Promise<{ client: WithTypeOfService; close: () => void }>((resolve) => {
    const server = NodeNet.createServer((socket) => socket.resume()).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      const client = NodeNet.connect(port, "127.0.0.1", () => {
        const handle = (client as unknown as { _handle: { setTypeOfService: () => number } })
          ._handle;
        handle.setTypeOfService = () => -22; // UV_EINVAL
        resolve({
          client: client as WithTypeOfService,
          close: () => {
            client.destroy();
            server.close();
          },
        });
      });
    });
  });

describe("socket guards", () => {
  it("lets a failed type-of-service hint pass instead of throwing", async () => {
    // A prototype of our own, so the real one stays untouched for other tests.
    class GuardedSocket extends NodeNet.Socket {}
    Object.defineProperty(GuardedSocket.prototype, "setTypeOfService", {
      value: (NodeNet.Socket.prototype as WithTypeOfService).setTypeOfService,
      writable: true,
    });

    const unguarded = await socketFailingTypeOfService();
    assert.throws(() => unguarded.client.setTypeOfService(8), /setTypeOfService EINVAL/);
    unguarded.close();

    makeTypeOfServiceBestEffort(GuardedSocket.prototype as WithTypeOfService);
    const guarded = await socketFailingTypeOfService();
    Object.setPrototypeOf(guarded.client, GuardedSocket.prototype);
    assert.strictEqual(guarded.client.setTypeOfService(16), guarded.client);
    // A wrong value is still the caller's mistake.
    assert.throws(() => guarded.client.setTypeOfService(999), /out of range/);
    guarded.close();
  });

  it("tells one connection failing from a real crash", () => {
    const errno = (code: string, syscall: string) =>
      Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
    assert.isTrue(isConnectionLevelError(errno("EINVAL", "setTypeOfService")));
    assert.isTrue(isConnectionLevelError(errno("ECONNRESET", "read")));
    assert.isTrue(isConnectionLevelError(errno("EPIPE", "write")));
    assert.isFalse(isConnectionLevelError(errno("ENOSPC", "write")));
    assert.isFalse(isConnectionLevelError(errno("EADDRINUSE", "listen")));
    assert.isFalse(isConnectionLevelError(new TypeError("undefined is not a function")));
  });
});
