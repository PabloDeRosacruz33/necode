/**
 * The two HTTP routes behind ClientDeviceHosts: the link a desktop app keeps open to carry the
 * connections to its forwarded ports, and the device tools it downloads so its Mac needs no npm. Both take the
 * same ticket or cookie as `/ws` and need operate scope.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { authenticateOperate } from "../preview/PortForwardProxy.ts";
import * as ClientDeviceHosts from "./ClientDeviceHosts.ts";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  ensureAgentDevice,
  ensureDeviceHub,
} from "./DeviceToolchain.ts";

const routeParam = (prefix: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
    Option.map(HttpServerRequest.toURL(request), (url) =>
      decodeURIComponent(url.pathname.slice(prefix.length)),
    ),
  );

const linkPrefix = `${ClientDeviceHosts.CLIENT_DEVICE_HOST_ROUTE}/link/`;
const toolsPrefix = `${ClientDeviceHosts.CLIENT_DEVICE_HOST_ROUTE}/tools/`;

const link = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const linkId = yield* routeParam(linkPrefix);
  if (Option.isNone(linkId) || request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  yield* authenticateOperate;
  const hosts = yield* ClientDeviceHosts.ClientDeviceHosts;
  const socket = yield* request.upgrade;
  yield* hosts.acceptLink(linkId.value, socket);
  return HttpServerResponse.empty();
});

/** The server's own install of a tool, packed as it must appear under `<name>@<version>`. */
const tools = Effect.gen(function* () {
  const name = yield* routeParam(toolsPrefix);
  if (Option.isNone(name) || !["expo-device-hub", "agent-device"].includes(name.value)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  yield* authenticateOperate;
  const config = yield* ServerConfig.ServerConfig;
  const install = yield* (
    name.value === "expo-device-hub"
      ? ensureDeviceHub(config.baseDir)
      : ensureAgentDevice(config.baseDir)
  ).pipe(Effect.provide(ProcessRunner.layer));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", "-", "-C", install.installDir, "."], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }),
  );
  return HttpServerResponse.stream(child.stdout.pipe(Stream.orDie), {
    contentType: "application/gzip",
    headers: {
      "x-tool-version":
        name.value === "expo-device-hub" ? DEVICE_HUB_VERSION : AGENT_DEVICE_VERSION,
      "cache-control": "no-store, no-transform",
    },
  });
}).pipe(
  Effect.catchTag("DeviceToolchainInstallError", () =>
    Effect.succeed(
      HttpServerResponse.text("The server could not install the tool", { status: 503 }),
    ),
  ),
);

export const clientDeviceHostLinkRouteLayer = HttpRouter.add("GET", `${linkPrefix}*`, link);
export const clientDeviceHostToolsRouteLayer = HttpRouter.add("GET", `${toolsPrefix}*`, tools);
