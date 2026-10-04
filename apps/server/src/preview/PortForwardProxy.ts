/**
 * Raw TCP over WebSocket to a port on this machine's loopback, so a desktop app connected from
 * another computer can make a dev server here answer on its own `localhost:<port>`. Each
 * WebSocket carries one TCP connection; binary frames are its bytes in both directions.
 *
 * Dev servers usually bind loopback only, which is why this goes through the Necode origin
 * (the same way the Device panel's streams do) instead of the machine's network address.
 * Reaching any local port is as powerful as a terminal, so it requires operate scope.
 */
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";

export const PORT_FORWARD_ROUTE_PREFIX = "/api/port-forward";

/** `localhost` resolves to IPv6 first for some dev servers, so both loopbacks are tried. */
const findLoopbackListener = (port: number) =>
  Effect.promise(async () => {
    for (const host of ["127.0.0.1", "::1"]) {
      const listening = await new Promise<boolean>((resolve) => {
        const probe = NodeNet.createConnection({ host, port, timeout: 1_000 });
        const done = (result: boolean) => {
          probe.destroy();
          resolve(result);
        };
        probe.once("connect", () => done(true));
        probe.once("error", () => done(false));
        probe.once("timeout", () => done(false));
      });
      if (listening) return host;
    }
    return null;
  });

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (EnvironmentAuth.isServerAuthCredentialError(error)) {
          return yield* failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          );
        }
        return yield* failEnvironmentInternal("internal_error", error);
      }),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const pump = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const port = Number(url.value.pathname.slice(PORT_FORWARD_ROUTE_PREFIX.length + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  yield* authenticate;
  const host = yield* findLoopbackListener(port);
  if (host === null) {
    return HttpServerResponse.text("Nothing is listening on that port", { status: 502 });
  }
  const client = yield* request.upgrade;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const target = yield* NodeSocket.makeNet({ host, port, openTimeout: "5 seconds" });
      const writeToClient = yield* client.writer;
      const writeToTarget = yield* target.writer;
      // Whichever side closes first ends the other through scope teardown.
      return yield* Effect.raceFirst(pump(target, writeToClient), pump(client, writeToTarget));
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

export const portForwardRouteLayer = HttpRouter.add(
  "GET",
  `${PORT_FORWARD_ROUTE_PREFIX}/*`,
  handler,
);
