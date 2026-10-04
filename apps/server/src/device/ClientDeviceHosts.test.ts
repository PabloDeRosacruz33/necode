import { assert, it } from "@effect/vitest";
import type { ClientDeviceHostRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ClientDeviceHosts from "./ClientDeviceHosts.ts";
import * as DeviceService from "./DeviceService.ts";
import type { RemoteDeviceHostOptions } from "./RemoteDeviceHost.ts";

/** Records the hosts the registry attaches and detaches, without starting any of them. */
const recordingDevices = () => {
  const attached = new Map<string, RemoteDeviceHostOptions>();
  const layer = Layer.mock(DeviceService.DeviceService)({
    attachRemoteHost: (options) => Effect.sync(() => void attached.set(options.id, options)),
    detachHost: (hostId) => Effect.sync(() => void attached.delete(hostId)),
  });
  return { attached, layer };
};

it.effect("a desktop app is a device host while connected and answers commands on its Mac", () => {
  const devices = recordingDevices();
  return Effect.gen(function* () {
    const hosts = yield* ClientDeviceHosts.make;
    const requests: Array<ClientDeviceHostRequest> = [];
    // The desktop app: answers every command it is sent.
    const app = yield* hosts
      .connect({
        connectionId: "connection-1",
        memberId: "pablo-mac",
        label: "Simuladores de Pablo",
      })
      .pipe(
        Stream.runForEach((request) =>
          Effect.gen(function* () {
            requests.push(request);
            if (request._tag !== "exec") return;
            yield* hosts.respond({
              requestId: request.requestId,
              stdout: `ran ${request.command} ${request.args.join(" ")}`,
              stderr: "",
              code: 0,
            });
          }),
        ),
        Effect.forkChild,
      );
    yield* Effect.yieldNow;

    const host = devices.attached.get("client-pablo-mac");
    assert.isDefined(host);
    assert.equal(host?.kind, "client");
    assert.equal(hosts.hostIdForMember("pablo-mac"), "client-pablo-mac");
    assert.isNull(hosts.hostIdForMember("roi-mac"));

    const result = yield* host!.transport.run("xcrun", ["simctl", "list"]);
    assert.deepStrictEqual(result, { stdout: "ran xcrun simctl list", stderr: "", code: 0 });

    yield* Fiber.interrupt(app);
    assert.isFalse(devices.attached.has("client-pablo-mac"));
    assert.isNull(hosts.hostIdForMember("pablo-mac"));
    // A host whose app left reports the command as failed instead of hanging.
    const after = yield* host!.transport.run("xcrun", ["simctl", "list"]);
    assert.equal(after.code, 127);
  }).pipe(Effect.provide(devices.layer));
});
