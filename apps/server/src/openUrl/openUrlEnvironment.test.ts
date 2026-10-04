// @effect-diagnostics nodeBuiltinImport:off -- The fake endpoint is a plain Node server the shell script calls.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeHttp from "node:http";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { openUrlEnvironment, verifyOpenUrlToken, withPathPrefix } from "./openUrlEnvironment.ts";

const TestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** A stand-in for the server's `/api/open-url` answering every call with `status`. */
const fakeServer = (status: number) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          port: number;
          calls: Array<{ auth: string; body: string }>;
          server: NodeHttp.Server;
        }>((resolve) => {
          const calls: Array<{ auth: string; body: string }> = [];
          const server = NodeHttp.createServer((request, response) => {
            let body = "";
            request.on("data", (chunk: Buffer) => (body += chunk.toString()));
            request.on("end", () => {
              calls.push({ auth: request.headers.authorization ?? "", body });
              response.writeHead(status).end();
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              port: typeof address === "object" && address ? address.port : 0,
              calls,
              server,
            });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const runOpen = (url: string, input: { stateDir: string; port: number; fakeOpenDir: string }) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const env = yield* openUrlEnvironment({
      stateDir: input.stateDir,
      port: input.port,
      host: undefined,
      threadId: "thread-1",
    });
    // A fake `open` after the stand-in records what would have opened on this machine.
    const processEnv = withPathPrefix(
      { ...process.env, PATH: `${input.fakeOpenDir}:${process.env.PATH ?? ""}` },
      env,
    );
    return yield* runner.run({ command: "open", args: [url], env: processEnv });
  });

const makeDirs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "open-url-" });
  const fakeOpenDir = path.join(base, "fake-bin");
  const record = path.join(base, "opened-here");
  yield* fs.makeDirectory(fakeOpenDir);
  yield* fs.writeFileString(
    path.join(fakeOpenDir, "open"),
    `#!/bin/sh\necho "$@" >> "${record}"\n`,
  );
  yield* fs.chmod(path.join(fakeOpenDir, "open"), 0o755);
  return { stateDir: path.join(base, "state"), fakeOpenDir, record };
});

it.layer(TestLayer)("open-url stand-in", (it) => {
  it.effect("sends the page to the server with a token bound to its thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dirs = yield* makeDirs;
        const server = yield* fakeServer(204);

        const result = yield* runOpen("https://example.test/login?next=a&b", {
          ...dirs,
          port: server.port,
        });

        assert.equal(result.code, 0);
        assert.equal(server.calls.length, 1);
        const body = new URLSearchParams(server.calls[0]!.body);
        assert.equal(body.get("threadId"), "thread-1");
        assert.equal(body.get("url"), "https://example.test/login?next=a&b");
        const token = server.calls[0]!.auth.replace(/^Bearer /, "");
        assert.isTrue(
          yield* verifyOpenUrlToken({ stateDir: dirs.stateDir, threadId: "thread-1", token }),
        );
        assert.isFalse(
          yield* verifyOpenUrlToken({ stateDir: dirs.stateDir, threadId: "thread-2", token }),
        );
        assert.isFalse(yield* fs.exists(dirs.record));
      }),
    ),
  );

  it.effect("opens the page on this machine when no device takes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dirs = yield* makeDirs;
        const server = yield* fakeServer(404);

        yield* runOpen("https://example.test", { ...dirs, port: server.port });

        assert.equal((yield* fs.readFileString(dirs.record)).trim(), "https://example.test");
      }),
    ),
  );

  it.effect("passes anything that is not a web page straight through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dirs = yield* makeDirs;
        const server = yield* fakeServer(204);

        yield* runOpen("/tmp/report.pdf", { ...dirs, port: server.port });

        assert.equal(server.calls.length, 0);
        assert.equal((yield* fs.readFileString(dirs.record)).trim(), "/tmp/report.pdf");
      }),
    ),
  );
});
