// @effect-diagnostics nodeBuiltinImport:off -- This Mac's side of a remote environment's device host: processes, files and sockets.
// @effect-diagnostics globalTimers:off -- A plain process timeout, outside any Effect.
// @effect-diagnostics globalFetch:off -- Streams a download straight into tar.
/**
 * This Mac's simulators, offered to a remote environment so the people working there test in a
 * Simulator window on their own screen. The environment drives this through the renderer
 * (components/device/ClientDeviceHosts.tsx): it runs its device script and simulator commands
 * here, sends the device tools so this Mac needs no Node or npm (the script runs on this app's
 * own Electron as Node), and asks for a tunnel per connection to the tools' loopback ports.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import * as NodeStreamPromises from "node:stream/promises";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const TOOLS_DIR = NodePath.join(NodeOS.homedir(), ".t3", "device", "tools");

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export function exec(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      // The device script runs on this app's binary as Node.
      env: { ...process.env, NECODE_NODE: process.execPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || error.message, code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(input.stdin ?? "");
  });
}

/**
 * Downloads each tool from the environment (a gzipped tar of its install) into the folder the
 * device script looks in, unless that version is already complete there.
 */
export async function installTools(input: {
  readonly toolsUrl: string;
  readonly query: Readonly<Record<string, string>>;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly version: string }>;
}): Promise<ExecResult> {
  try {
    for (const tool of input.tools) {
      const dir = NodePath.join(TOOLS_DIR, `${tool.name}@${tool.version}`);
      const marker = NodePath.join(dir, ".install-complete");
      const installed = await NodeFSP.readFile(marker, "utf8").catch(() => "");
      if (installed.trim() === tool.version) continue;
      await NodeFSP.mkdir(TOOLS_DIR, { recursive: true });
      const staging = await NodeFSP.mkdtemp(NodePath.join(TOOLS_DIR, ".download-"));
      try {
        const url = new URL(`${input.toolsUrl}/${encodeURIComponent(tool.name)}`);
        for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);
        const response = await fetch(url);
        if (!response.ok || !response.body) {
          throw new Error(`Downloading ${tool.name} failed with ${response.status}.`);
        }
        const tar = NodeChildProcess.spawn("tar", ["-xzf", "-", "-C", staging], {
          stdio: ["pipe", "ignore", "pipe"],
        });
        const done = new Promise<void>((resolve, reject) => {
          tar.on("error", reject);
          tar.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`Unpacking ${tool.name} failed.`)),
          );
        });
        await NodeStreamPromises.pipeline(
          NodeStream.Readable.fromWeb(response.body as NodeStreamWeb.ReadableStream),
          tar.stdin,
        );
        await done;
        await NodeFSP.writeFile(NodePath.join(staging, ".install-complete"), tool.version);
        await NodeFSP.rm(dir, { recursive: true, force: true });
        await NodeFSP.rename(staging, dir);
      } finally {
        await NodeFSP.rm(staging, { recursive: true, force: true });
      }
    }
    return { stdout: "", stderr: "", code: 0 };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
  }
}

/** Carries one connection between the environment's tunnel WebSocket and a port on this Mac. */
export function openTunnel(input: { readonly url: string; readonly port: number }): void {
  const ws = new WebSocket(input.url);
  ws.binaryType = "arraybuffer";
  const socket = NodeNet.createConnection({ host: "127.0.0.1", port: input.port });
  const early: Array<Uint8Array<ArrayBuffer>> = [];
  const close = () => {
    socket.destroy();
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
  };
  socket.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    else early.push(bytes);
  });
  socket.on("close", close);
  socket.on("error", close);
  ws.addEventListener("open", () => {
    for (const chunk of early) ws.send(chunk);
    early.length = 0;
  });
  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) socket.write(Buffer.from(event.data));
  });
  ws.addEventListener("close", close);
  ws.addEventListener("error", close);
}
