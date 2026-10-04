/**
 * `POST /api/open-url`, called by the `open` stand-ins in agent, terminal and script processes
 * (see openUrlEnvironment.ts). The token proves which thread the process works for; the page
 * goes to a device of that thread's person. 204 means a device opened it; anything else tells
 * the stand-in to open it on this machine instead.
 */
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { latestAuthorMemberId } from "../team/threadAuthor.ts";
import * as OpenUrlBroker from "./OpenUrlBroker.ts";
import { OPEN_URL_ROUTE, verifyOpenUrlToken } from "./openUrlEnvironment.ts";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  const body = new URLSearchParams(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
  const threadId = body.get("threadId") ?? "";
  const url = body.get("url") ?? "";
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
  if (
    !threadId ||
    !token ||
    !(yield* verifyOpenUrlToken({ stateDir: config.stateDir, threadId, token }))
  ) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }
  if (!/^https?:\/\//i.test(url)) {
    return HttpServerResponse.text("Only web pages are sent to devices", { status: 400 });
  }
  const authorMemberId = yield* latestAuthorMemberId(threadId);
  const broker = yield* OpenUrlBroker.OpenUrlBroker;
  const opened = yield* broker.open({ url, threadId, authorMemberId });
  return opened
    ? HttpServerResponse.empty({ status: 204 })
    : HttpServerResponse.text("No device took it", { status: 404 });
});

export const openUrlRouteLayer = HttpRouter.add("POST", OPEN_URL_ROUTE, handler);
