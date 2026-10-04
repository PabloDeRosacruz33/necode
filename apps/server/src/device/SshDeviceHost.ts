/** A device host the server logs into over SSH; see RemoteDeviceHost.ts for what runs there. */
import type { SshDeviceHostConfig } from "@t3tools/contracts";
import { runSshCommand, baseSshArgs, resolveSshCommand } from "@t3tools/ssh/command";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import * as RemoteDeviceHost from "./RemoteDeviceHost.ts";
import { quoteRemoteArg, remoteDeviceEnvironment } from "./sshDeviceScript.ts";

const targetFor = (config: SshDeviceHostConfig) => ({
  alias: config.target,
  hostname: config.target,
  username: null,
  port: config.port ?? null,
});
const identityArgs = (config: SshDeviceHostConfig) =>
  config.identityFile ? ["-i", config.identityFile] : [];
const commandArgs = (script: string) => [
  "sh",
  "-c",
  quoteRemoteArg(remoteDeviceEnvironment + script),
];

const sshTransport = Effect.fn("SshDeviceHost.transport")(function* (config: SshDeviceHostConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  // Only forwarding needs it; probing a host does not.
  const net = yield* Effect.serviceOption(NetService.NetService);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ssh = yield* resolveSshCommand;
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | ServerConfig.ServerConfig
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, server),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const run: DeviceHost.DeviceHostReady["run"] = (command, args, options) =>
    provide(
      runSshCommand(targetFor(config), {
        preHostArgs: identityArgs(config),
        remoteCommandArgs: commandArgs(`exec ${[command, ...args].map(quoteRemoteArg).join(" ")}`),
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
    ).pipe(
      Effect.map((result) => ({ ...result, code: 0 })),
      Effect.catch((error) =>
        Effect.succeed({
          stdout: "stdout" in error ? (error.stdout ?? "") : "",
          stderr: error.message,
          code: "exitCode" in error ? (error.exitCode ?? 127) : 127,
        }),
      ),
    );

  return {
    unreachableReason: "Cannot reach device host. Test its SSH connection in Settings.",
    bootstrap: (script, mode) =>
      provide(
        runSshCommand(targetFor(config), {
          preHostArgs: identityArgs(config),
          remoteCommandArgs: commandArgs(
            'command -v node >/dev/null 2>&1 || { echo "Node is missing from the non-interactive SSH PATH" >&2; exit 1; }; exec node',
          ),
          stdin: script,
          timeoutMs: mode === "start" || mode === "agent-start" ? 1_300_000 : 45_000,
        }),
      ),
    run,
    forward: (ports, scope) =>
      Effect.gen(function* () {
        const localPorts: Array<number> = [];
        if (Option.isNone(net)) return yield* Effect.die("NetService is required to forward ports");
        for (const _ of ports) localPorts.push(yield* net.value.reserveLoopbackPort("127.0.0.1"));
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              ssh,
              [
                ...baseSshArgs(targetFor(config), { batchMode: "yes" }),
                ...identityArgs(config),
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=10",
                "-o",
                "ServerAliveCountMax=3",
                "-N",
                ...ports.flatMap((port, index) => [
                  "-L",
                  `127.0.0.1:${localPorts[index]}:127.0.0.1:${port}`,
                ]),
                config.target,
              ],
              { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        let stderr = "";
        yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stderr = (stderr + chunk).slice(-2000);
            }),
          ),
          Effect.forkIn(scope),
        );
        return {
          localPorts,
          closed: child.exitCode.pipe(Effect.ignore),
          diagnostics: () => stderr,
        };
      }),
  } satisfies RemoteDeviceHost.RemoteDeviceTransport;
});

const optionsFor = (config: SshDeviceHostConfig) =>
  sshTransport(config).pipe(
    Effect.map((transport): RemoteDeviceHost.RemoteDeviceHostOptions => ({
      id: config.id,
      label: config.label,
      kind: "ssh",
      transport,
    })),
  );

export const probe = Effect.fn("SshDeviceHost.probe")(function* (
  config: SshDeviceHostConfig,
  owner?: string,
) {
  return yield* RemoteDeviceHost.probe(
    yield* optionsFor(config),
    owner ?? (yield* RemoteDeviceHost.ownerFor(config.id)),
  );
});

export const make = Effect.fn("SshDeviceHost.make")(function* (
  config: SshDeviceHostConfig,
  onReady?: Parameters<typeof RemoteDeviceHost.make>[2],
  onStatus?: Parameters<typeof RemoteDeviceHost.make>[3],
) {
  return yield* RemoteDeviceHost.make(
    yield* optionsFor(config),
    yield* RemoteDeviceHost.ownerFor(config.id),
    onReady,
    onStatus,
  );
});
