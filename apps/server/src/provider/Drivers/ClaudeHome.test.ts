import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectDirName,
  claudeSignedOutMessage,
  ensureClaudeTranscriptForCwd,
  linkClaudeSharedSessions,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  it.effect("copies a session's transcript to the folder a thread moved to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const claudeHome = yield* fs.makeTempDirectoryScoped({ prefix: "claude-home-" });
        const oldDir = path.join(claudeHome, "projects", claudeProjectDirName("/repo/task-a"));
        yield* fs.makeDirectory(oldDir, { recursive: true });
        yield* fs.writeFileString(path.join(oldDir, "abc.jsonl"), "{}\n");
        const input = { claudeHome, cwd: "/repo/task-b", sessionId: "abc" };

        expect(yield* ensureClaudeTranscriptForCwd(input)).toBe(true);
        const copied = path.join(claudeHome, "projects", "-repo-task-b", "abc.jsonl");
        expect(yield* fs.readFileString(copied)).toBe("{}\n");
        expect(yield* ensureClaudeTranscriptForCwd(input)).toBe(false);

        // After several moves, the newest copy wins over older ones left behind.
        const stale = path.join(claudeHome, "projects", "-repo-task-c");
        yield* fs.makeDirectory(stale, { recursive: true });
        yield* fs.writeFileString(path.join(stale, "abc.jsonl"), "old\n");
        yield* fs.utimes(path.join(stale, "abc.jsonl"), 1_000, 1_000);
        yield* ensureClaudeTranscriptForCwd({ ...input, cwd: "/repo/task-d" });
        const moved = path.join(claudeHome, "projects", "-repo-task-d", "abc.jsonl");
        expect(yield* fs.readFileString(moved)).toBe("{}\n");
      }),
    ),
  );

  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("lets an account share the default home's sessions without moving its login", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const sharedHome = path.join(root, "claude");
        const environment = { CLAUDE_CONFIG_DIR: sharedHome };
        const account = { homePath: path.join(root, "claude-personal") };

        expect(
          yield* makeClaudeContinuationGroupKey({ ...account, shareSessions: true }, environment),
        ).toBe(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment));

        yield* linkClaudeSharedSessions(account, environment);
        yield* fileSystem.writeFileString(path.join(sharedHome, "projects", "thread.jsonl"), "{}");
        expect(
          yield* fileSystem.readFileString(path.join(account.homePath, "projects", "thread.jsonl")),
        ).toBe("{}");

        // Existing account history is never replaced by the link.
        const separate = { homePath: path.join(root, "claude-work") };
        yield* fileSystem.makeDirectory(path.join(separate.homePath, "projects"), {
          recursive: true,
        });
        yield* linkClaudeSharedSessions(separate, environment);
        expect(
          yield* fileSystem.exists(path.join(separate.homePath, "projects", "thread.jsonl")),
        ).toBe(false);
      }).pipe(Effect.scoped),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
