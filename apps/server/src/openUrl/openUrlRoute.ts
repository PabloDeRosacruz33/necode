/**
 * `POST /api/open-url`, called by the `open` stand-ins in agent, terminal and script processes
 * (see openUrlEnvironment.ts). The token proves which thread the process works for; the page
 * goes to a device of that thread's person. 204 means a device opened it; anything else tells
 * the stand-in to open it on this machine instead.
 */
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as TeamService from "../team/TeamService.ts";
import { latestAuthorMemberId } from "../team/threadAuthor.ts";
import * as OpenUrlBroker from "./OpenUrlBroker.ts";
import { GIT_IDENTITY_ROUTE, OPEN_URL_ROUTE, verifyOpenUrlToken } from "./openUrlEnvironment.ts";

/** The form a stand-in posted, when its token is valid for the thread it names. */
const authorizedForm = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  const body = new URLSearchParams(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
  const threadId = body.get("threadId") ?? "";
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
  const valid =
    threadId !== "" &&
    token !== "" &&
    (yield* verifyOpenUrlToken({ stateDir: config.stateDir, threadId, token }));
  return valid ? { threadId, body } : null;
});

const handler = Effect.gen(function* () {
  const form = yield* authorizedForm;
  if (!form) return HttpServerResponse.text("Unauthorized", { status: 401 });
  const { threadId } = form;
  const url = form.body.get("url") ?? "";
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

/**
 * `POST /api/git-identity`, asked by the `git` stand-in before a command that makes commits:
 * the name and email (one per line) of whoever the thread works for now, or nothing for the
 * machine's own identity.
 */
const gitIdentityHandler = Effect.gen(function* () {
  const form = yield* authorizedForm;
  if (!form) return HttpServerResponse.text("Unauthorized", { status: 401 });
  const team = yield* TeamService.TeamService;
  const identity = yield* team.gitIdentityForThread(form.threadId);
  return HttpServerResponse.text(identity ? `${identity.name}\n${identity.email}\n` : "");
});

export const openUrlRouteLayer = HttpRouter.add("POST", OPEN_URL_ROUTE, handler);
export const gitIdentityRouteLayer = HttpRouter.add("POST", GIT_IDENTITY_ROUTE, gitIdentityHandler);
