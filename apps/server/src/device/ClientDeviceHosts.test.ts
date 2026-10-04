// @effect-diagnostics nodeBuiltinImport:off -- A fake Mac service and the link socket are plain Node.
import { assert, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { serveMuxLink } from "@t3tools/shared/streamMux";
import * as NodeNet from "node:net";
import type { ClientDeviceHostRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

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

const listen = <T extends NodeNet.Server | InstanceType<typeof NodeSocket.NodeWS.WebSocketServer>>(
  make: () => T,
  port: (server: T) => number,
) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: T; port: number }>((resolve) => {
          const server = make();
          server.once("listening", () => resolve({ server, port: port(server) }));
        }),
    ),
    ({ server }) => Effect.sync(() => server.close()),
  );

it.effect("carries connections to the Mac's ports over the app's one link", () => {
  const devices = recordingDevices();
  return Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* ClientDeviceHosts.make;
      const linkSockets =
        yield* Queue.unbounded<InstanceType<typeof NodeSocket.NodeWS.WebSocket>>();
      const replies = yield* Queue.unbounded<string>();
      // A service on the person's Mac, and the link route of this server.
      const mac = yield* listen(
        () => NodeNet.createServer((socket) => socket.pipe(socket)).listen(0, "127.0.0.1"),
        (server) => (server.address() as NodeNet.AddressInfo).port,
      );
      let linkId = "";
      const route = yield* listen(
        () => new NodeSocket.NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1" }),
        (server) => (server.address() as NodeNet.AddressInfo).port,
      );
      route.server.on("connection", (ws) => Queue.offerUnsafe(linkSockets, ws));
      // The link route: serves each link the app opens.
      yield* Queue.take(linkSockets).pipe(
        Effect.flatMap((ws) => Socket.fromWebSocket(Effect.succeed(ws))),
        Effect.flatMap((socket) => hosts.acceptLink(linkId, socket)),
        Effect.forever,
        Effect.forkScoped,
      );
      // The desktop app: opens its link when asked.
      yield* hosts
        .connect({ connectionId: "connection-1", memberId: "roi-mac", label: "Simuladores de Roi" })
        .pipe(
          Stream.runForEach((request) =>
            Effect.sync(() => {
              if (request._tag !== "link") return;
              linkId = request.linkId;
              serveMuxLink(
                new NodeSocket.NodeWS.WebSocket(
                  `ws://127.0.0.1:${route.port}`,
                ) as unknown as WebSocket,
                (port) => NodeNet.createConnection({ host: "127.0.0.1", port }),
              );
            }),
          ),
          Effect.forkScoped,
        );
      while (!devices.attached.has("client-roi-mac")) yield* Effect.yieldNow;
      const host = devices.attached.get("client-roi-mac")!;
      const linkScope = yield* Scope.make();
      const forwarded = yield* host.transport.forward([mac.port], linkScope);

      const client = NodeNet.createConnection({
        host: "127.0.0.1",
        port: forwarded.localPorts[0]!,
      });
      client.on("connect", () => client.write("hola"));
      client.on("data", (chunk) => Queue.offerUnsafe(replies, chunk.toString()));
      assert.equal(yield* Queue.take(replies), "hola");
      client.destroy();
      yield* Scope.close(linkScope, Exit.void);
    }),
  ).pipe(Effect.provide(devices.layer));
});
