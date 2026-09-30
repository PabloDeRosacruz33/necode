import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeClaudeAuth, readClaudeLoginFailure } from "./ClaudeAuth.ts";

// Stands in for `claude auth login`: prints the manual link, reads the pasted
// code, and accepts only `good#state`, like the real CLI's code exchange.
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1 $2" = "auth logout" ]; then exit 0; fi
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=state"
printf "Paste code here if prompted > "
read code
if [ "$code" = "good#state" ] && [ -n "$CLAUDE_CONFIG_DIR" ]; then
  echo "Login successful."
  exit 0
fi
echo "Login failed: Request failed with status code 400"
exit 1
`;

const makeFakeClaude = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped();
  const binaryPath = path.join(dir, "claude");
  yield* fileSystem.writeFileString(binaryPath, FAKE_CLAUDE);
  yield* fileSystem.chmod(binaryPath, 0o755);
  return { dir, binaryPath };
});

const signIn = (code: string) =>
  Effect.gen(function* () {
    const { dir, binaryPath } = yield* makeFakeClaude;
    const auth = yield* makeClaudeAuth({
      instanceId: ProviderInstanceId.make("claude_personal"),
      binaryPath,
      environment: { CLAUDE_CONFIG_DIR: dir },
      configDir: dir,
      prepare: Effect.void,
    });
    const reach = (phases: ReadonlyArray<ProviderAuthState["phase"]>) =>
      auth.subscribe("owner").pipe(
        Stream.filter((state) => phases.includes(state.phase)),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    yield* auth.start("owner");
    const waiting = yield* reach(["waiting"]);
    yield* auth.complete("owner", { flowId: waiting.flowId!, callbackUrl: code });
    return { waiting, finished: yield* reach(["succeeded", "failed"]) };
  });

it.effect("signs in by relaying Claude's link and the pasted code", () =>
  Effect.gen(function* () {
    const { waiting, finished } = yield* signIn("good#state");
    assert.strictEqual(
      waiting.authorizationUrl,
      "https://claude.com/cai/oauth/authorize?code=true&state=state",
    );
    assert.strictEqual(finished.phase, "succeeded");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports Claude's own failure when the code is rejected", () =>
  Effect.gen(function* () {
    const { finished } = yield* signIn("wrong#state");
    assert.strictEqual(finished.phase, "failed");
    assert.strictEqual(finished.message, "Login failed: Request failed with status code 400");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("reads the failure line even after the paste prompt", () => {
  assert.strictEqual(
    readClaudeLoginFailure("visit: https://x\nPaste code here if prompted > Login failed: expired"),
    "Login failed: expired",
  );
  assert.isUndefined(readClaudeLoginFailure("Opening browser to sign in…"));
});
