// @effect-diagnostics nodeBuiltinImport:off -- Forwards accept raw TCP connections on loopback.
/**
 * Desktop apps that offer their own Mac's simulators to this environment, so people working
 * remotely test on a Simulator window on their screen while builds, agents and Metro run here.
 * Each connected app becomes a device host (`client-<member>`) for as long as its
 * `clientDeviceHost.connect` stream lives.
 *
 * The app is the transport (see RemoteDeviceHost.ts): it runs the device script and simulator
 * commands on its Mac, receives the device tools from this server instead of needing npm, and
 * keeps one WebSocket open to `/api/client-device-host/link/<linkId>` that carries every
 * connection to the forwarded ports (`@t3tools/shared/streamMux`). One link instead of a
 * handshake per connection keeps the host usable over slow links.
 */
import type { ClientDeviceHostRequest, ClientDeviceHostResponse } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { decodeMuxFrame, encodeMuxFrame } from "@t3tools/shared/streamMux";

import * as DeviceService from "./DeviceService.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import type { RemoteDeviceTransport } from "./RemoteDeviceHost.ts";
import { remoteDeviceEnvironment } from "./sshDeviceScript.ts";

export const CLIENT_DEVICE_HOST_ROUTE = "/api/client-device-host";
const LINK_OPEN_TIMEOUT = "30 seconds";

/** The open link of a registration: frames waiting to go out, and the connections it carries. */
interface Link {
  readonly outbox: Queue.Queue<Uint8Array>;
  readonly streams: Map<number, NodeNet.Socket>;
}

interface Registration {
  readonly hostId: string;
  readonly linkId: string;
  readonly queue: Queue.Queue<ClientDeviceHostRequest, Cause.Done>;
  readonly closed: Deferred.Deferred<void>;
  link: Link | null;
  linkReady: Deferred.Deferred<void>;
}

class ClientDeviceHostError extends Schema.TaggedError<ClientDeviceHostError>()(
  "ClientDeviceHostError",
  { message: Schema.String },
) {}

export class ClientDeviceHosts extends Context.Service<
  ClientDeviceHosts,
  {
    readonly connect: (input: {
      readonly connectionId: string;
      readonly memberId: string | null;
      readonly label: string;
    }) => Stream.Stream<ClientDeviceHostRequest>;
    readonly respond: (response: ClientDeviceHostResponse) => Effect.Effect<void>;
    /**
     * Carries a registration's forwarded connections over the app's link WebSocket until it
     * closes. False for an unknown link.
     */
    readonly acceptLink: (linkId: string, socket: Socket.Socket) => Effect.Effect<boolean>;
    /** The host of a person's desktop app while it is connected. */
    readonly hostIdForMember: (memberId: string) => string | null;
  }
>()("t3/device/ClientDeviceHosts") {}

export const make = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const registrations = new Map<string, Registration>();
  const pending = new Map<
    string,
    Deferred.Deferred<ClientDeviceHostResponse, ClientDeviceHostError>
  >();
  let nextStream = 0;

  /** Sends a request to the app and waits for its answer, or fails when the app goes away. */
  const ask = (
    registration: Registration,
    build: (requestId: string) => ClientDeviceHostRequest,
    timeoutMs: number,
  ) => {
    const requestId = NodeCrypto.randomUUID();
    return Effect.gen(function* () {
      const answer = yield* Deferred.make<ClientDeviceHostResponse, ClientDeviceHostError>();
      pending.set(requestId, answer);
      if (!(yield* Queue.offer(registration.queue, build(requestId)))) {
        return yield* Effect.fail(
          new ClientDeviceHostError({ message: "The desktop app disconnected." }),
        );
      }
      return yield* Effect.raceFirst(
        Deferred.await(answer),
        Deferred.await(registration.closed).pipe(
          Effect.andThen(
            Effect.fail(new ClientDeviceHostError({ message: "The desktop app disconnected." })),
          ),
        ),
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(new ClientDeviceHostError({ message: "The desktop app did not answer." })),
        }),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
  };

  /** A connection to a forwarded port, carried as one stream of the app's link. */
  const carry = (registration: Registration, socket: NodeNet.Socket, port: number) => {
    const link = registration.link;
    if (!link) {
      socket.destroy();
      return;
    }
    const stream = (nextStream = (nextStream + 1) % 0xffffffff);
    link.streams.set(stream, socket);
    Queue.offerUnsafe(link.outbox, encodeMuxFrame({ kind: "open", stream, port }));
    socket.on("data", (chunk: Buffer) => {
      Queue.offerUnsafe(link.outbox, encodeMuxFrame({ kind: "data", stream, bytes: chunk }));
    });
    const close = () => {
      if (link.streams.delete(stream)) {
        Queue.offerUnsafe(link.outbox, encodeMuxFrame({ kind: "close", stream }));
      }
    };
    socket.on("close", close);
    socket.on("error", close);
  };

  const transportFor = (registration: Registration): RemoteDeviceTransport => {
    const exec = (
      command: string,
      args: ReadonlyArray<string>,
      options?: { readonly timeoutMs?: number; readonly stdin?: string },
    ) =>
      ask(
        registration,
        (requestId) => ({
          _tag: "exec",
          requestId,
          command,
          args: [...args],
          ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
        (options?.timeoutMs ?? 60_000) + 15_000,
      );
    const run: DeviceHost.DeviceHostReady["run"] = (command, args, options) =>
      exec(command, args, options).pipe(
        Effect.map(({ stdout, stderr, code }) => ({ stdout, stderr, code })),
        Effect.catch((error) => Effect.succeed({ stdout: "", stderr: error.message, code: 127 })),
      );
    return {
      unreachableReason: "Open Necode on that Mac to use its simulators.",
      bringsTools: true,
      slowLink: true,
      bootstrap: (script, mode) =>
        Effect.gen(function* () {
          if (mode === "start" || mode === "agent-start") {
            const installed = yield* ask(
              registration,
              (requestId) => ({
                _tag: "installTools",
                requestId,
                tools: [
                  { name: "expo-device-hub", version: DEVICE_HUB_VERSION },
                  ...(mode === "agent-start"
                    ? [{ name: "agent-device", version: AGENT_DEVICE_VERSION }]
                    : []),
                ],
              }),
              15 * 60_000,
            );
            if (installed.code !== 0) {
              return yield* Effect.fail(new ClientDeviceHostError({ message: installed.stderr }));
            }
          }
          // The app's own Electron runs the script as Node, so the Mac needs no Node install.
          const result = yield* exec(
            "/bin/sh",
            ["-c", `${remoteDeviceEnvironment}ELECTRON_RUN_AS_NODE=1 exec "$NECODE_NODE"`],
            {
              stdin: script,
              timeoutMs: mode === "start" || mode === "agent-start" ? 1_300_000 : 45_000,
            },
          );
          if (result.code !== 0) {
            return yield* Effect.fail(
              new ClientDeviceHostError({ message: result.stderr || result.stdout }),
            );
          }
          return { stdout: result.stdout };
        }),
      run,
      forward: (ports, scope) =>
        Effect.gen(function* () {
          yield* Deferred.await(registration.linkReady).pipe(
            Effect.timeoutOrElse({
              duration: LINK_OPEN_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new ClientDeviceHostError({ message: "The desktop app did not open its link." }),
                ),
            }),
          );
          const localPorts: Array<number> = [];
          for (const port of ports) {
            const server = yield* Effect.acquireRelease(
              Effect.promise(
                () =>
                  new Promise<NodeNet.Server>((resolve) => {
                    const listener = NodeNet.createServer();
                    listener.listen(0, "127.0.0.1", () => resolve(listener));
                  }),
              ),
              (listener) => Effect.sync(() => listener.close()),
            ).pipe(Effect.provideService(Scope.Scope, scope));
            server.on("connection", (socket) => carry(registration, socket, port));
            const address = server.address();
            localPorts.push(typeof address === "object" && address ? address.port : 0);
          }
          return {
            localPorts,
            closed: Deferred.await(registration.closed),
            diagnostics: () => "",
          };
        }),
    };
  };

  const connect: ClientDeviceHosts["Service"]["connect"] = (input) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const hostId = `client-${input.memberId ?? input.connectionId}`;
          const registration: Registration = {
            hostId,
            linkId: NodeCrypto.randomUUID(),
            queue: yield* Queue.unbounded<ClientDeviceHostRequest, Cause.Done>(),
            closed: yield* Deferred.make<void>(),
            link: null,
            linkReady: yield* Deferred.make<void>(),
          };
          // The newest app of a person takes over their host.
          const previous = registrations.get(hostId);
          if (previous) yield* Deferred.succeed(previous.closed, undefined);
          registrations.set(hostId, registration);
          yield* Queue.offer(registration.queue, { _tag: "link", linkId: registration.linkId });
          yield* devices.attachRemoteHost({
            id: hostId,
            label: input.label,
            kind: "client",
            transport: transportFor(registration),
          });
          return registration;
        }),
        (registration) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(registration.closed, undefined);
            yield* Queue.shutdown(registration.queue);
            if (registrations.get(registration.hostId) !== registration) return;
            registrations.delete(registration.hostId);
            yield* devices.detachHost(registration.hostId);
          }),
      ).pipe(Effect.map((registration) => Stream.fromQueue(registration.queue))),
    );

  const respond: ClientDeviceHosts["Service"]["respond"] = (response) =>
    Effect.suspend(() => {
      const answer = pending.get(response.requestId);
      return answer ? Deferred.succeed(answer, response).pipe(Effect.asVoid) : Effect.void;
    });

  const acceptLink: ClientDeviceHosts["Service"]["acceptLink"] = (linkId, socket) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registration = [...registrations.values()].find((entry) => entry.linkId === linkId);
        if (!registration) return false;
        const link: Link = { outbox: yield* Queue.unbounded<Uint8Array>(), streams: new Map() };
        registration.link = link;
        yield* Deferred.succeed(registration.linkReady, undefined);
        const write = yield* socket.writer;
        const send = Effect.forever(
          Queue.take(link.outbox).pipe(Effect.flatMap((frame) => write.writeAll([frame]))),
        );
        const receive = Effect.gen(function* () {
          const { pull } = yield* socket.reader;
          while (true) {
            for (const message of yield* pull) {
              if (typeof message === "string") continue;
              const frame = decodeMuxFrame(message);
              if (frame?.kind === "data") link.streams.get(frame.stream)?.write(frame.bytes);
              else if (frame?.kind === "close") {
                link.streams.get(frame.stream)?.destroy();
                link.streams.delete(frame.stream);
              }
            }
          }
        });
        yield* Effect.raceFirst(send, receive).pipe(Effect.ignoreCause);
        for (const stream of link.streams.values()) stream.destroy();
        if (registration.link === link) {
          registration.link = null;
          registration.linkReady = yield* Deferred.make<void>();
          // A dropped link is reopened while the app stays connected.
          yield* Queue.offer(registration.queue, { _tag: "link", linkId });
        }
        return true;
      }),
    );

  return ClientDeviceHosts.of({
    connect,
    respond,
    acceptLink,
    hostIdForMember: (memberId) =>
      registrations.has(`client-${memberId}`) ? `client-${memberId}` : null,
  });
});

export const layer = Layer.effect(ClientDeviceHosts, make);
