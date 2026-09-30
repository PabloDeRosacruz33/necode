/**
 * In-app Claude subscription sign-in for one instance.
 *
 * Runs `claude auth login` against the instance's config directory, shows the
 * CLI's manual authorization link, and types the code the user pastes back into
 * the CLI. Claude owns the token exchange and keychain storage. The manual link
 * returns a code instead of calling a localhost port, so it also works when the
 * client is on another device.
 *
 * @module provider/ClaudeAuth
 */
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";

const METHOD_ID = "claudeai";
const MAX_CODE_LENGTH = 4_096;
const TRANSCRIPT_LIMIT = 16_384;
const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/u;

/** The CLI's own failure line, e.g. `Login failed: Request failed with status code 400`. */
export function readClaudeLoginFailure(transcript: string): string | undefined {
  const line = transcript
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^.*>\s*/u, "").trim())
    .findLast((entry) => /fail|error|invalid|expired/iu.test(entry));
  return line ? line.slice(0, 300) : undefined;
}

export function readClaudeAuthorizeUrl(transcript: string): string | undefined {
  return transcript.match(AUTHORIZE_URL)?.[0];
}

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** Environment of the instance, including its CLAUDE_CONFIG_DIR. */
  readonly environment: NodeJS.ProcessEnv;
  /** The directory holding this login; instances with the same one share it. */
  readonly configDir: string;
  /** Runs before the CLI starts, e.g. to create the account directory. */
  readonly prepare: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });

  const runClaude = Effect.fn("ClaudeAuth.runClaude")(function* (
    args: ReadonlyArray<string>,
    operation: string,
  ) {
    const environment = {
      ...options.environment,
      // Keep the CLI from opening a browser on the host; the client shows the link.
      ...(platform === "win32" ? {} : { BROWSER: "/usr/bin/true" }),
    };
    const command = yield* resolveSpawnCommand(options.binaryPath, args, { env: environment });
    return yield* spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          env: environment,
          extendEnv: false,
          shell: command.shell,
        }),
      )
      .pipe(
        Effect.mapError(() =>
          failure(operation, "Could not start Claude. Check the binary path for this instance."),
        ),
      );
  });

  const authenticate = (_methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      yield* options.prepare;
      const child = yield* runClaude(["auth", "login", "--claudeai"], "start");
      let transcript = "";
      const link = yield* Deferred.make<string>();
      const readOutput = Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            transcript = (transcript + chunk).slice(-TRANSCRIPT_LIMIT);
            const url = readClaudeAuthorizeUrl(transcript);
            if (url) yield* Deferred.succeed(link, url);
          }),
        ),
        Effect.ignore,
      );
      const outputDone = yield* Effect.forkScoped(readOutput);
      const input = yield* Queue.unbounded<Uint8Array>();
      yield* Stream.fromQueue(input).pipe(
        Stream.run(child.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );

      const exited = child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(() => failure("start", "Claude sign-in stopped unexpectedly.")),
      );
      const url = yield* Deferred.await(link).pipe(
        Effect.raceFirst(
          exited.pipe(
            Effect.flatMap(() =>
              Effect.fail(
                failure(
                  "start",
                  readClaudeLoginFailure(transcript) ??
                    "Claude closed before showing a sign-in link.",
                ),
              ),
            ),
          ),
        ),
      );

      yield* context.setInteraction(
        {
          type: "browser",
          id: context.flowId,
          url,
          requiresConsent: false,
          acceptsCallback: true,
        },
        undefined,
        (pasted) =>
          Effect.gen(function* () {
            const code = pasted.trim();
            if (!code || code.length > MAX_CODE_LENGTH || /\s/u.test(code))
              return yield* failure("complete", "Paste the full code from the Claude page.");
            yield* context.verifying;
            yield* Queue.offer(input, new TextEncoder().encode(`${code}\n`));
          }),
      );

      const code = yield* exited;
      yield* Fiber.join(outputDone);
      if (code !== 0)
        return yield* failure(
          "complete",
          readClaudeLoginFailure(transcript) ?? "Claude sign-in failed. Start again.",
        );
    });

  const logout = Effect.gen(function* () {
    const child = yield* runClaude(["auth", "logout"], "logout");
    const code = yield* child.exitCode.pipe(
      Effect.map(Number),
      Effect.mapError(() => failure("logout", "Could not sign out of Claude. Try again.")),
    );
    if (code !== 0) return yield* failure("logout", "Could not sign out of Claude. Try again.");
    return "Signed out of Claude.";
  }).pipe(Effect.scoped);

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: METHOD_ID,
        name: "Sign in with Claude",
        description: "Use a Claude Pro or Max subscription.",
        type: "agent" as const,
      },
    ]),
    defaultMethodId: METHOD_ID,
    authenticate,
    logout,
  });
});
