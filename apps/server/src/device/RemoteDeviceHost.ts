/**
 * A device host on another machine, reached through a transport: SSH to a Mac the server can log
 * into, or the Necode desktop app of a person working remotely (their own Mac's simulators).
 * The host runs the device script (sshDeviceScript.ts) there with Node, which installs and starts
 * expo-device-hub and agent-device on that machine's loopback; the transport makes those ports
 * reachable on this machine and runs simulator commands there.
 */
import * as NodeCrypto from "node:crypto";
import {
  type DeviceHostSummary,
  DevicePlatformAvailability,
  DeviceToolVersions,
  deviceToolInstallMessage,
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ServerConfig from "../config.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { remoteDeviceScript } from "./sshDeviceScript.ts";

const Probe = Schema.Struct({
  nodePath: Schema.String,
  tools: Schema.optional(DeviceToolVersions),
  platforms: Schema.Array(DevicePlatformAvailability),
});
const Started = Schema.Struct({
  ...Probe.fields,
  hubPort: Schema.Int,
  daemonPort: Schema.optionalKey(Schema.Int),
  token: Schema.optionalKey(Schema.String),
  entryPath: Schema.optionalKey(Schema.String),
  helpers: Schema.Struct({
    serveSimAxSettings: Schema.NullOr(Schema.String),
    serveSimCli: Schema.NullOr(Schema.String),
  }),
});
const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(Probe));
const decodeStarted = Schema.decodeUnknownEffect(Schema.fromJsonString(Started));

export type DeviceScriptMode = "probe" | "start" | "agent-start" | "stop-agent" | "stop";

export interface RemoteDeviceTransport {
  /** Runs the device script with Node on the host and returns what it printed. */
  readonly bootstrap: (
    script: string,
    mode: DeviceScriptMode,
  ) => Effect.Effect<{ readonly stdout: string }, Error>;
  readonly run: DeviceHost.DeviceHostReady["run"];
  /**
   * Makes the host's loopback `ports` reachable on this machine's loopback for as long as
   * `scope` is open. `closed` completes when the link drops.
   */
  readonly forward: (
    ports: ReadonlyArray<number>,
    scope: Scope.Scope,
  ) => Effect.Effect<
    {
      readonly localPorts: ReadonlyArray<number>;
      readonly closed: Effect.Effect<void>;
      /** Why the link may have failed, for error messages. */
      readonly diagnostics: () => string;
    },
    Error
  >;
  /** Shown when the host cannot be reached at all. */
  readonly unreachableReason: string;
  /** The transport installs the tools itself before starting, so the host needs no npm. */
  readonly bringsTools?: boolean;
  /** Round trips are slow (a person's Mac on any network): wait longer for its endpoints. */
  readonly slowLink?: boolean;
}

export interface RemoteDeviceHostOptions {
  readonly id: string;
  readonly label: string;
  readonly kind: DeviceHostSummary["kind"];
  readonly transport: RemoteDeviceTransport;
}

/** Stable per environment and host, so this server's helpers are told apart from others'. */
export const ownerFor = Effect.fn("RemoteDeviceHost.ownerFor")(function* (hostId: string) {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* ServerConfig.ServerConfig;
  const environmentId = yield* fs
    .readFileString(server.environmentIdPath)
    .pipe(Effect.orElseSucceed(() => server.stateDir));
  return NodeCrypto.createHash("sha256")
    .update(`${environmentId}\0${server.stateDir}\0${hostId}`)
    .digest("hex")
    .slice(0, 24);
});

const bootstrap = (options: RemoteDeviceHostOptions, owner: string, mode: DeviceScriptMode) =>
  options.transport
    .bootstrap(remoteDeviceScript(owner, mode, options.transport.bringsTools === true), mode)
    .pipe(
      Effect.mapError(
        (cause) => new DeviceHost.DeviceHostError({ hostId: options.id, step: mode, cause }),
      ),
    );

export const probe = Effect.fn("RemoteDeviceHost.probe")(function* (
  options: RemoteDeviceHostOptions,
  owner: string,
) {
  const result = yield* bootstrap(options, owner, "probe");
  const value = yield* decodeProbe(result.stdout.trim()).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceHost.DeviceHostError({ hostId: options.id, step: "reading probe result", cause }),
    ),
  );
  return {
    id: options.id,
    label: options.label,
    kind: options.kind,
    tools: value.tools,
    hubInstalled:
      value.tools?.hub.installedVersions.includes(value.tools.hub.requiredVersion) ?? false,
    agentDeviceInstalled:
      value.tools?.agent.installedVersions.includes(value.tools.agent.requiredVersion) ?? false,
    platforms: value.platforms,
  } satisfies DeviceHostSummary;
});

export const make = Effect.fn("RemoteDeviceHost.make")(function* (
  options: RemoteDeviceHostOptions,
  owner: string,
  onReady: (
    ready: DeviceHost.DeviceHostAgentReady,
  ) => Effect.Effect<void, DeviceHost.DeviceHostError> = () => Effect.void,
  onStatus: (
    status: "starting" | "ready" | "failed",
    detail?: string,
  ) => Effect.Effect<void> = () => Effect.void,
) {
  const http = yield* HttpClient.HttpClient;
  const parentScope = yield* Scope.Scope;
  const { id, transport } = options;
  const lock = yield* Semaphore.make(1);
  let stopped = false;
  let activated = false;
  let wantsAgent = false;
  let ready:
    | (DeviceHost.DeviceHostReady & {
        agentDevice?: DeviceHost.DeviceHostAgentReady["agentDevice"];
      })
    | null = null;
  let connectionScope: Scope.Closeable | null = null;
  let summary: DeviceHostSummary = {
    id,
    label: options.label,
    kind: options.kind,
    hubInstalled: false,
    agentDeviceInstalled: false,
    platforms: [],
  };

  const connectOnce = Effect.fn("RemoteDeviceHost.connectOnce")(function* (): Effect.fn.Return<
    DeviceHost.DeviceHostReady & { agentDevice?: DeviceHost.DeviceHostAgentReady["agentDevice"] },
    DeviceHost.DeviceHostError
  > {
    activated = true;
    const result = yield* bootstrap(options, owner, wantsAgent ? "agent-start" : "start");
    yield* onStatus("starting");
    const remote = yield* decodeStarted(result.stdout.trim()).pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({ hostId: id, step: "reading host endpoints", cause }),
      ),
    );
    summary = {
      ...summary,
      platforms: remote.platforms,
      tools: remote.tools,
      hubInstalled: true,
      agentDeviceInstalled: wantsAgent || summary.agentDeviceInstalled,
    };
    const scope = yield* Scope.make();
    connectionScope = scope;
    const link = yield* transport
      .forward(
        remote.daemonPort === undefined ? [remote.hubPort] : [remote.hubPort, remote.daemonPort],
        scope,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeviceHost.DeviceHostError({ hostId: id, step: "forwarding ports", cause }),
        ),
      );
    const [hubPort, daemonPort] = link.localPorts;
    const next = {
      nodePath: remote.nodePath,
      hub: { origin: `http://127.0.0.1:${hubPort}` },
      ...(daemonPort !== undefined && remote.token !== undefined && remote.entryPath !== undefined
        ? {
            agentDevice: {
              baseUrl: `http://127.0.0.1:${daemonPort}`,
              token: remote.token,
              entryPath: remote.entryPath,
            },
          }
        : {}),
      helpers: remote.helpers,
      run: transport.run,
    };
    for (const [baseUrl, route] of [
      [next.hub.origin, "/readyz"],
      ...(next.agentDevice ? [[next.agentDevice.baseUrl, "/health"]] : []),
    ]) {
      yield* waitForHttpReady({
        baseUrl: baseUrl!,
        path: route!,
        timeoutMs: transport.slowLink ? 60_000 : 15_000,
        ...(transport.slowLink ? { probeTimeoutMs: 10_000, intervalMs: 500 } : {}),
        makeError: () =>
          new DeviceHost.DeviceHostError({
            hostId: id,
            step: "waiting for SSH forward",
            cause: new Error(link.diagnostics() || "Forwarded endpoint did not answer."),
          }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    }
    if (next.agentDevice) yield* onReady({ ...next, agentDevice: next.agentDevice });
    ready = next;
    yield* onStatus("ready");
    // Reconnect also repairs helpers that died while the link itself stayed up.
    const unhealthy = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("10 seconds");
        const alive = yield* http.get(`${next.hub.origin}/readyz`).pipe(
          Effect.timeout("5 seconds"),
          Effect.map((r) => r.status === 200),
          Effect.orElseSucceed(() => false),
        );
        const daemonAlive = next.agentDevice
          ? yield* http.get(`${next.agentDevice!.baseUrl}/health`).pipe(
              Effect.timeout("5 seconds"),
              Effect.map((r) => r.status === 200),
              Effect.orElseSucceed(() => false),
            )
          : true;
        if (!alive || !daemonAlive) return;
      }
    });
    yield* Effect.gen(function* () {
      yield* Effect.raceFirst(link.closed, unhealthy);
      if (stopped || connectionScope !== scope) return;
      ready = null;
      yield* onStatus("starting", "Reconnecting to device host…");
      yield* Scope.close(scope, Exit.void);
      let delay = 1000;
      while (true) {
        if (stopped || connectionScope !== scope) return;
        yield* Effect.sleep(delay);
        const result = yield* lock
          .withPermit(
            Effect.suspend(() => (stopped || ready ? Effect.void : connect().pipe(Effect.asVoid))),
          )
          .pipe(Effect.result);
        if (result._tag === "Success") return;
        yield* onStatus("failed", result.failure.message);
        if (connectionScope && connectionScope !== scope)
          yield* Scope.close(connectionScope, Exit.void);
        connectionScope = scope;
        delay = Math.min(delay * 2, 30000);
      }
    }).pipe(Effect.forkIn(parentScope));
    return next;
  });

  const connect = Effect.fn("RemoteDeviceHost.connect")(function* () {
    for (let attempt = 0; ; attempt++) {
      const result = yield* connectOnce().pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      const failedScope = connectionScope;
      connectionScope = null;
      if (failedScope) yield* Scope.close(failedScope, Exit.void);
      // A forward can lose its reserved port to a competing bind; retry with fresh ports.
      if (
        attempt >= 2 ||
        !["forwarding ports", "waiting for SSH forward"].includes(result.failure.step)
      )
        return yield* result.failure;
    }
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    lock.withPermit(
      Effect.gen(function* () {
        stopped = false;
        if (ready) return ready;
        summary = yield* probe(options, owner);
        yield* onPhase(
          summary.hubInstalled ? "starting" : "installing",
          summary.hubInstalled
            ? undefined
            : deviceToolInstallMessage("device hub", summary.tools?.hub),
        );
        return yield* connect().pipe(
          Effect.tapError(() =>
            connectionScope ? Scope.close(connectionScope, Exit.void) : Effect.void,
          ),
        );
      }),
    );
  const stop = lock.withPermit(
    Effect.gen(function* () {
      stopped = true;
      ready = null;
      if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
      connectionScope = null;
      if (activated) yield* bootstrap(options, owner, "stop").pipe(Effect.ignore);
      activated = false;
      wantsAgent = false;
    }),
  );
  const changeAgent = (enabled: boolean) =>
    lock.withPermit(
      Effect.gen(function* () {
        wantsAgent = enabled;
        if (enabled && ready?.agentDevice) return { ...ready, agentDevice: ready.agentDevice };
        if (!enabled && !ready?.agentDevice) return null;
        ready = null;
        const previousScope = connectionScope;
        connectionScope = null;
        if (previousScope) yield* Scope.close(previousScope, Exit.void);
        if (!enabled) yield* bootstrap(options, owner, "stop-agent");
        return yield* connect().pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              const failedScope = connectionScope;
              connectionScope = null;
              if (failedScope) yield* Scope.close(failedScope, Exit.void);
              if (enabled) yield* bootstrap(options, owner, "stop-agent").pipe(Effect.ignore);
            }),
          ),
        );
      }),
    );
  yield* Effect.addFinalizer(() => stop);
  return {
    id,
    summary: Effect.sync(() => summary),
    inspect: probe(options, owner).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          summary = value;
        }),
      ),
    ),
    current: Effect.sync(() => ready),
    ensureReady,
    ensureAgentReady: (onPhase) =>
      ensureReady(onPhase).pipe(
        Effect.flatMap(() =>
          onPhase(
            summary.agentDeviceInstalled ? "starting" : "installing",
            summary.agentDeviceInstalled
              ? undefined
              : deviceToolInstallMessage("agent tools", summary.tools?.agent),
          ),
        ),
        Effect.flatMap(() => changeAgent(true)),
        Effect.flatMap((value) =>
          value?.agentDevice
            ? Effect.succeed({ ...value, agentDevice: value.agentDevice })
            : Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: id,
                  step: "starting agent tools",
                  cause: new Error("Daemon endpoint missing"),
                }),
              ),
        ),
      ),
    stopAgent: changeAgent(false).pipe(Effect.asVoid, Effect.ignore),
    stop,
    platformAvailability: (platform) =>
      probe(options, owner).pipe(
        Effect.map((value) => {
          summary = { ...summary, platforms: value.platforms };
          return value.platforms.find((p) => p.platform === platform)!;
        }),
        Effect.orElseSucceed(() => ({
          platform,
          available: false,
          reason: transport.unreachableReason,
        })),
      ),
  } satisfies DeviceHost.DeviceHost["Service"];
});
