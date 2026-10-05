/**
 * Web pages that agents, terminals and scripts open on this machine go to the device the person
 * is working from. Their processes get a PATH entry holding `open` and `xdg-open` stand-ins, and
 * `BROWSER` pointing at the same script. For an http(s) URL the script posts to `/api/open-url`
 * with a token bound to its thread; whatever Necode cannot deliver to a device opens here, as it
 * did before.
 *
 * The same PATH entry holds a `git` stand-in: before commands that make commits it asks
 * `/api/git-identity` who the thread works for now (whoever sent its latest message), so a
 * long-running agent shared by several people signs each commit as the right one.
 *
 * The secret behind the tokens lives in the state directory so terminals that outlive a server
 * restart keep working.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const OPEN_URL_ROUTE = "/api/open-url";
export const GIT_IDENTITY_ROUTE = "/api/git-identity";

const SHIM_DIR = "open-url/bin";
const SECRET_FILE = "open-url/secret";

const shimScript = (fallback: string) => `#!/bin/sh
# Necode: web pages opened here go to the device the person is working from.
url=""
for arg in "$@"; do
  case "$arg" in http://*|https://*) url="$arg" ;; esac
done
if [ -n "$url" ] && [ -n "$NECODE_OPEN_URL_ENDPOINT" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 20 -o /dev/null \\
    -H "Authorization: Bearer $NECODE_OPEN_URL_TOKEN" \\
    --data-urlencode "threadId=$NECODE_THREAD_ID" \\
    --data-urlencode "url=$url" \\
    "$NECODE_OPEN_URL_ENDPOINT" 2>/dev/null; then
    exit 0
  fi
fi
# Nobody to send it to: open it on this machine.
self_dir=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "$self_dir" | paste -sd: -)
export PATH
${fallback}
`;

const gitScript = `#!/bin/sh
# Necode: commits are signed by the person the thread works for right now.
self_dir=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "$self_dir" | paste -sd: -)
export PATH
signs=""
for arg in "$@"; do
  case "$arg" in
    commit|commit-tree|merge|pull|rebase|cherry-pick|revert|am|stash|tag|notes) signs=1; break ;;
  esac
done
if [ -n "$signs" ] && [ -n "$NECODE_OPEN_URL_ENDPOINT" ] && command -v curl >/dev/null 2>&1; then
  if identity=$(curl -fsS -m 5 \\
    -H "Authorization: Bearer $NECODE_OPEN_URL_TOKEN" \\
    --data-urlencode "threadId=$NECODE_THREAD_ID" \\
    "\${NECODE_OPEN_URL_ENDPOINT%/open-url}/git-identity" 2>/dev/null); then
    name=$(printf '%s\\n' "$identity" | sed -n 1p)
    email=$(printf '%s\\n' "$identity" | sed -n 2p)
    if [ -n "$name" ] && [ -n "$email" ]; then
      export GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email"
      export GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email"
    else
      # Nobody's identity: the machine's own, not whoever this process started for.
      unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
    fi
  fi
fi
real=$(command -v git)
[ "$real" != "$self_dir/git" ] || real=/usr/bin/git
exec "$real" "$@"
`;

const cache = new Map<string, { readonly binDir: string; readonly secret: string }>();

/** Writes the stand-ins and the secret once per state directory. */
const ensureOpenUrlShim = Effect.fn("ensureOpenUrlShim")(function* (stateDir: string) {
  const cached = cache.get(stateDir);
  if (cached) return cached;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binDir = path.join(stateDir, SHIM_DIR);
  const secretPath = path.join(stateDir, SECRET_FILE);
  yield* fs.makeDirectory(binDir, { recursive: true });
  let secret = (yield* fs.readFileString(secretPath).pipe(Effect.orElseSucceed(() => ""))).trim();
  if (!secret) {
    secret = NodeCrypto.randomBytes(32).toString("hex");
    yield* fs.writeFileString(secretPath, `${secret}\n`, { mode: 0o600 });
  }
  const scripts = {
    open: 'exec open "$@"',
    "xdg-open": 'exec xdg-open "$@"',
    "necode-browser":
      'if command -v open >/dev/null 2>&1; then exec open "$@"; else exec xdg-open "$@"; fi',
  };
  const files = {
    ...Object.fromEntries(
      Object.entries(scripts).map(([name, fallback]) => [name, shimScript(fallback)]),
    ),
    git: gitScript,
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(binDir, name);
    yield* fs.writeFileString(file, contents);
    yield* fs.chmod(file, 0o755);
  }
  const result = { binDir, secret };
  cache.set(stateDir, result);
  return result;
});

const tokenFor = (secret: string, threadId: string) =>
  NodeCrypto.createHmac("sha256", secret).update(threadId).digest("hex");

/**
 * The variables a process working for `threadId` needs, with `PATH` holding only the directory
 * to put first. Null on Windows, where the stand-ins do not apply.
 */
export const openUrlEnvironment = Effect.fn("openUrlEnvironment")(function* (input: {
  readonly stateDir: string;
  readonly port: number;
  readonly host: string | undefined;
  readonly threadId: string;
}) {
  if ((yield* HostProcessPlatform) === "win32") return null;
  const { binDir, secret } = yield* ensureOpenUrlShim(input.stateDir);
  const host =
    !input.host || input.host === "0.0.0.0" || input.host === "::"
      ? "127.0.0.1"
      : input.host.includes(":")
        ? `[${input.host}]`
        : input.host;
  return {
    PATH: binDir,
    BROWSER: `${binDir}/necode-browser`,
    NECODE_OPEN_URL_ENDPOINT: `http://${host}:${input.port}${OPEN_URL_ROUTE}`,
    NECODE_OPEN_URL_TOKEN: tokenFor(secret, input.threadId),
    NECODE_THREAD_ID: input.threadId,
  } satisfies Record<string, string>;
});

/** Whether `token` was issued for `threadId` by this state directory's secret. */
export const verifyOpenUrlToken = Effect.fn("verifyOpenUrlToken")(function* (input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly token: string;
}) {
  const { secret } = yield* ensureOpenUrlShim(input.stateDir);
  const expected = Buffer.from(tokenFor(secret, input.threadId));
  const actual = Buffer.from(input.token);
  return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
});

/** `base` with `extra` applied, its `PATH` entry put in front of the existing one. */
export function withPathPrefix(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | null | undefined,
): NodeJS.ProcessEnv {
  if (!extra) return base;
  const { PATH: prefix, ...rest } = extra;
  const current = base.PATH ?? base.Path;
  return {
    ...base,
    ...rest,
    ...(prefix ? { PATH: current ? `${prefix}:${current}` : prefix } : {}),
  };
}
