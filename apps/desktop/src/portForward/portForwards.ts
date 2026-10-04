// @effect-diagnostics nodeBuiltinImport:off -- Port forwarding is raw TCP listening in the main process.
/**
 * Makes dev servers running on a remote environment answer on this Mac's own
 * `localhost:<port>`, like an SSH `-L` forward. The renderer keeps the set of wanted ports in
 * step with what the environment reports; each accepted connection is carried over its own
 * WebSocket to the environment's `/api/port-forward/<port>`, which connects to that port there.
 *
 * A forward keeps the remote port number so absolute URLs, hot reload and login callbacks to
 * `localhost` keep working. A port already taken on this Mac is left alone and reported busy;
 * the next sync tries again.
 */
import * as NodeNet from "node:net";

export interface PortForwardRequest {
  readonly port: number;
  /** `ws(s)://…/api/port-forward/<port>?wsTicket=…`; refreshed before the ticket expires. */
  readonly url: string;
}

interface Forward {
  url: string;
  readonly servers: ReadonlyArray<NodeNet.Server>;
  readonly sockets: Set<NodeNet.Socket>;
}

const forwards = new Map<number, Forward>();

function listen(port: number, host: string): Promise<NodeNet.Server | null> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(null));
    server.listen({ port, host, exclusive: true }, () => resolve(server));
  });
}

function bridge(socket: NodeNet.Socket, forward: Forward) {
  forward.sockets.add(socket);
  const ws = new WebSocket(forward.url);
  ws.binaryType = "arraybuffer";
  const early: Array<Uint8Array<ArrayBuffer>> = [];
  const close = () => {
    forward.sockets.delete(socket);
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

function stop(port: number) {
  const forward = forwards.get(port);
  if (!forward) return;
  forwards.delete(port);
  for (const server of forward.servers) server.close();
  for (const socket of forward.sockets) socket.destroy();
}

/** Brings the forwards to exactly `wanted` and reports which ports now answer here. */
export async function syncPortForwards(
  wanted: ReadonlyArray<PortForwardRequest>,
): Promise<ReadonlyArray<{ readonly port: number; readonly forwarding: boolean }>> {
  const byPort = new Map(wanted.map((request) => [request.port, request.url]));
  for (const port of [...forwards.keys()]) {
    if (!byPort.has(port)) stop(port);
  }
  const result: Array<{ port: number; forwarding: boolean }> = [];
  for (const [port, url] of byPort) {
    const existing = forwards.get(port);
    if (existing) {
      existing.url = url;
      result.push({ port, forwarding: true });
      continue;
    }
    const v4 = await listen(port, "127.0.0.1");
    if (!v4) {
      result.push({ port, forwarding: false });
      continue;
    }
    // `localhost` resolves to ::1 first in some browsers; without it they would still fall back.
    const v6 = await listen(port, "::1");
    const forward: Forward = { url, servers: v6 ? [v4, v6] : [v4], sockets: new Set() };
    for (const server of forward.servers)
      server.on("connection", (socket) => bridge(socket, forward));
    forwards.set(port, forward);
    result.push({ port, forwarding: true });
  }
  return result;
}
