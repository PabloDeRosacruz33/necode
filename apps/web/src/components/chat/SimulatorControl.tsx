/**
 * "Simular" for projects with an iOS app (found by the environment, or declared in t3.json's
 * `iosSimulator`), with the ways to try it:
 * - On this Mac: the environment builds a self-contained simulator app, this Mac downloads it and
 *   runs it in its own simulator. Nothing crosses the network while testing; seeing a change
 *   means simulating again.
 * - On this Mac, live (Expo, React Native): the environment starts the dev server (Metro) in a
 *   terminal and builds the development app, which runs in this Mac's simulator and loads its
 *   code from localhost:8081. The desktop app forwards that port to the environment
 *   (preview/PortForwards.tsx), so saved changes appear at once with native touch and typing.
 * - On the environment, live: its agent starts the app with the dev server on the environment's
 *   simulator, so saved changes appear at once, watched through the Device panel.
 * - Expo apps replace both live ways with Expo Go, the simple one: the environment runs Metro on
 *   its local network and Expo Go opens it, in this Mac's simulator or on a phone (a QR code).
 *   No build, and every saved change appears at once.
 */
import type { EnvironmentId, MacAppBuilt, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ChevronDownIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
import { randomUUID } from "~/lib/utils";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { useRightPanelStore } from "~/rightPanelStore";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The port a development build of a React Native app loads its code from. */
const METRO_PORT = 8081;
/** How long a finished live build waits for Metro before opening anyway. */
const METRO_WAIT_MS = 120_000;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "building"; readonly runId: string; readonly live: boolean }
  | { readonly kind: "waiting-metro"; readonly app: MacAppBuilt }
  | { readonly kind: "installing"; readonly app: MacAppBuilt; readonly live: boolean }
  | { readonly kind: "failed"; readonly message: string };

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message ? error.message : "Algo ha fallado.";
}

interface ListedSimulator {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
}

const EXPO_GO_BUNDLE_ID = "host.exp.Exponent";

/**
 * Opens the app in Expo Go on this Mac's simulator, through the desktop app's device host: the
 * booted iPhone (or the newest one, booted now), shown in Simulator, or DeviceHub on Xcode 27.
 * The address is this Mac's localhost: the desktop app forwards Metro's port to the environment,
 * which a laptop away from the environment's network reaches when its LAN address does not.
 * Expo Go is installed first when the simulator lacks it (`expoGoApp`, the build for the app's SDK).
 */
async function openInExpoGoHere(expoGoApp: string | null): Promise<string> {
  const url = `exp://127.0.0.1:${METRO_PORT}`;
  const host = window.desktopBridge?.deviceHost;
  if (!host) throw new Error("Solo la app de escritorio puede abrir el simulador de este Mac.");
  const run = (command: string, args: ReadonlyArray<string>) =>
    host.exec({ command, args, timeoutMs: 120_000 });
  const listed = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (listed.code !== 0) throw new Error("Este Mac no tiene Xcode con simuladores de iOS.");
  const runtimes = Object.entries(
    (JSON.parse(listed.stdout) as { devices: Record<string, ReadonlyArray<ListedSimulator>> })
      .devices,
  )
    .filter(([runtime]) => runtime.includes("iOS"))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
  const devices = runtimes.flatMap(([, entries]) => entries);
  let device =
    devices.find(
      (candidate) => candidate.state === "Booted" && candidate.name.includes("iPhone"),
    ) ?? devices.find((candidate) => candidate.state === "Booted");
  if (!device) {
    device = devices.find((candidate) => candidate.name.includes("iPhone")) ?? devices[0];
    if (!device) throw new Error("Este Mac no tiene simuladores de iOS; instala uno en Xcode.");
    await run("/usr/bin/xcrun", ["simctl", "boot", device.udid]);
  }
  // The window: Simulator up to Xcode 26; Xcode 27 replaced it with DeviceHub.
  for (const args of [
    ["-b", "com.apple.iphonesimulator"],
    ["-b", "com.apple.dt.Devices"],
    ["-a", "/Applications/Xcode.app/Contents/Applications/DeviceHub.app"],
  ]) {
    if ((await run("/usr/bin/open", args)).code === 0) break;
  }
  const installed = await run("/usr/bin/xcrun", [
    "simctl",
    "get_app_container",
    device.udid,
    EXPO_GO_BUNDLE_ID,
  ]);
  if (installed.code !== 0) {
    if (!expoGoApp)
      throw new Error(
        `${device.name} no tiene Expo Go y no se ha podido saber qué versión instalar.`,
      );
    // Expo's simulator build is a tarball of the app's contents.
    const install = await run("/bin/sh", [
      "-c",
      'set -e; dir=$(mktemp -d); mkdir "$dir/Exponent.app"; curl -fsSL "$1" | tar -xz -C "$dir/Exponent.app"; xcrun simctl install "$2" "$dir/Exponent.app"; rm -rf "$dir"',
      "install-expo-go",
      expoGoApp,
      device.udid,
    ]);
    if (install.code !== 0)
      throw new Error(`No se pudo instalar Expo Go en ${device.name}: ${install.stderr.trim()}`);
  }
  const opened = await run("/usr/bin/xcrun", ["simctl", "openurl", device.udid, url]);
  if (opened.code !== 0)
    throw new Error(`Expo Go no abrió la app en ${device.name}: ${opened.stderr.trim()}`);
  return device.name;
}

const livePrompt = (environmentLabel: string) =>
  [
    `Arranca la app de iOS de este proyecto en un simulador de ${environmentLabel} (device_open con hostId "local"). Si usa un servidor de desarrollo (Metro, Expo), déjalo en marcha para que los cambios se vean al guardar.`,
    "Ábrela en el panel Device y dime cuándo está lista.",
  ].join(" ");

export function SimulatorControl({
  environmentId,
  cwd,
  presentation,
  onAskAgent,
  onRunCommand,
  threadRef,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  presentation: "menu" | "toolbar";
  onAskAgent: (prompt: string) => void;
  /** Runs a shell command in one of the thread's terminals on the environment. */
  onRunCommand: (command: string) => void;
  /** The thread whose Device panel can show the simulator; null for drafts. */
  threadRef: ScopedThreadRef | null;
}) {
  const projectFile = useT3ProjectFileState(environmentId, cwd);
  const environment = useEnvironment(environmentId);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [logOpen, setLogOpen] = useState(false);
  const download = useAtomCommand(vcsEnvironment.macAppDownload, { reportFailure: false });
  const plan = useEnvironmentQuery(
    vcsEnvironment.iosSimulatorPlan({ environmentId, input: { cwd } }),
  );
  // Environments from before the plan request only know t3.json's.
  const buildCommand = plan.data?.build ?? projectFile.file?.iosSimulator?.build ?? null;
  const devServer = plan.data?.devServer ?? null;
  const expoGoUrl = plan.data?.expoGoUrl ?? null;
  const expoGoSimulatorUrl = plan.data?.expoGoSimulatorUrl ?? null;
  // Expo Go: where it is being opened while Metro starts, and the phone's QR code.
  const [expoGo, setExpoGo] = useState<"here" | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const live =
    (phase.kind === "building" && phase.live) ||
    phase.kind === "waiting-metro" ||
    expoGo !== null ||
    phoneOpen;
  // Watched only during a live run: the scan has a cost and nothing else here needs it.
  const { servers } = useDiscoveredPortsState(live ? environmentId : null);
  const metroRunning = servers.some((server) => server.port === METRO_PORT);
  const build = useEnvironmentQuery(
    phase.kind === "building"
      ? vcsEnvironment.macAppBuild({
          environmentId,
          input: {
            cwd,
            runId: phase.runId,
            target: phase.live ? "ios-simulator-dev" : "ios-simulator",
          },
        })
      : null,
  );
  const [finishedBuild, setFinishedBuild] = useState<typeof build.data>(null);
  const buildState = build.data ?? finishedBuild;
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [buildState?.output]);

  // This Mac's simulators reach the environment's device list as its client host (or its local
  // one when the environment is this Mac); watched from the install on, so the panel can open it.
  const [opened, setOpened] = useState(false);
  const watchDevices = threadRef !== null && (opened || phase.kind === "installing");
  const { state: deviceState } = useDeviceState(watchDevices ? environmentId : null);
  const deviceStateRef = useRef(deviceState);
  deviceStateRef.current = deviceState;
  const openDeviceSession = useAtomCommand(deviceEnvironment.open, { reportFailure: false });
  const listDevices = useAtomCommand(deviceEnvironment.list, { reportFailure: false });

  const showInDevicePanel = async (simulator: { readonly udid: string; readonly name: string }) => {
    if (!threadRef) return;
    const findDevice = () => {
      const state = deviceStateRef.current;
      const ownHosts = new Set(
        state.hosts
          .filter((host) => host.kind === "client" || host.kind === "local")
          .map((host) => host.id),
      );
      return state.devices.find(
        (candidate) =>
          candidate.platform === "ios" &&
          candidate.id === simulator.udid &&
          ownHosts.has(candidate.hostId),
      );
    };
    // A simulator booted moments ago reaches the environment's list on its next refresh.
    let device = findDevice();
    for (let attempt = 0; !device && attempt < 8; attempt++) {
      await listDevices({ environmentId, input: {} });
      await new Promise((resolve) => setTimeout(resolve, 750));
      device = findDevice();
    }
    if (!device) {
      toastManager.add({
        type: "error",
        title: "Este simulador no está en el panel Device",
        description:
          "Activa los dispositivos en Settings → Integrations → Devices y vuelve a intentarlo.",
      });
      return;
    }
    const result = await openDeviceSession({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        hostId: device.hostId,
        deviceId: device.id,
        platform: "ios",
        boot: false,
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "No se pudo abrir en el panel Device",
        description: failureMessage(result),
      });
      return;
    }
    useRightPanelStore.getState().openDevice(threadRef, {
      hostId: result.value.hostId,
      deviceId: result.value.deviceId,
      platform: "ios",
      name: device.name,
    });
  };

  const bridge = window.desktopBridge;
  const canRunHere = bridge?.finishSimulatorAppInstall !== undefined;
  const environmentLabel = environment?.label ?? "el entorno";

  const install = async (app: MacAppBuilt, live: boolean) => {
    setPhase({ kind: "installing", app, live });
    try {
      if (!bridge?.beginMacAppInstall || !bridge.appendMacAppInstall) {
        throw new Error("Solo la app de escritorio puede abrir el simulador de este Mac.");
      }
      const id = await bridge.beginMacAppInstall();
      // Chunks are written in order; the IPC calls queue behind each other.
      let writes = Promise.resolve();
      const result = await download({
        environmentId,
        input: {
          appPath: app.path,
          onChunk: (data) => {
            writes = writes.then(() => bridge.appendMacAppInstall!({ id, data }));
          },
        },
      });
      if (result._tag === "Failure") throw new Error(failureMessage(result));
      await writes;
      const simulator = await bridge.finishSimulatorAppInstall!({
        id,
        name: app.name,
        bundleId: app.bundleId,
      });
      setPhase({ kind: "idle" });
      setOpened(true);
      // No Simulator window on this Mac (Xcode 27 ships none): the panel is where it shows.
      if (!simulator.window) void showInDevicePanel(simulator);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${app.name} abierta en ${simulator.name}`,
          ...(live
            ? {
                description:
                  "Los cambios que guardes se ven al momento. Si sale una pantalla roja, espera a que Metro termine de arrancar en la terminal y pulsa ⌘R en el simulador.",
              }
            : {}),
          // The Simulator window is the smooth way to work; the panel keeps it beside the chat.
          ...(threadRef && simulator.window
            ? {
                actionProps: {
                  children: "Ver en el panel Device",
                  onClick: () => void showInDevicePanel(simulator),
                },
              }
            : {}),
        }),
      );
    } catch (error) {
      setPhase({
        kind: "failed",
        message: `No se pudo abrir en el simulador: ${error instanceof Error ? error.message : String(error)}`,
      });
      setLogOpen(true);
    }
  };

  useEffect(() => {
    if (phase.kind !== "building" || !buildState?.done) return;
    setFinishedBuild(buildState);
    if (buildState.exitCode === 0 && buildState.app) {
      if (phase.live && !metroRunning) setPhase({ kind: "waiting-metro", app: buildState.app });
      else void install(buildState.app, phase.live);
    } else {
      setPhase({
        kind: "failed",
        message:
          buildState.exitCode === 0
            ? "La compilación terminó pero no encuentro la app. Indica dónde queda con iosSimulator en t3.json."
            : "La compilación ha fallado.",
      });
      setLogOpen(true);
    }
  }, [buildState?.done]);
  // The development app needs Metro answering before it opens, or it starts on an error screen.
  useEffect(() => {
    if (phase.kind !== "waiting-metro") return;
    if (metroRunning) {
      void install(phase.app, true);
      return;
    }
    const timeout = setTimeout(() => void install(phase.app, true), METRO_WAIT_MS);
    return () => clearTimeout(timeout);
  }, [phase, metroRunning]);
  // Expo Go needs Metro answering, or it opens on an error; after two minutes it opens anyway.
  useEffect(() => {
    if (expoGo !== "here" || !expoGoUrl) return;
    const open = () => {
      setExpoGo(null);
      openInExpoGoHere(expoGoSimulatorUrl).then(
        (name) =>
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Expo Go abierto en ${name}`,
              description: "Los cambios que guardes se ven al momento.",
            }),
          ),
        (error: unknown) =>
          toastManager.add({
            type: "error",
            title: "No se pudo abrir Expo Go",
            description: error instanceof Error ? error.message : String(error),
          }),
      );
    };
    if (metroRunning) {
      open();
      return;
    }
    const timeout = setTimeout(open, METRO_WAIT_MS);
    return () => clearTimeout(timeout);
  }, [expoGo, metroRunning, expoGoUrl, expoGoSimulatorUrl]);
  useEffect(() => {
    if (build.error && phase.kind === "building") {
      // The build's stream broke (dropped connection, server restart): say why, not just that.
      setPhase({ kind: "failed", message: `Se cortó la compilación: ${build.error}` });
      setLogOpen(true);
    }
  }, [build.error, phase.kind]);

  if (buildCommand === null) return null;

  const busy =
    phase.kind === "building" ||
    phase.kind === "waiting-metro" ||
    phase.kind === "installing" ||
    expoGo !== null;
  const runHere = () => {
    if (busy) return;
    setPhase({ kind: "building", runId: randomUUID(), live: false });
  };
  // Leaving the building phase drops the build subscription, which ends the build on the
  // environment; a download or install in flight is simply forgotten.
  const cancel = () => {
    setPhase({ kind: "idle" });
    setExpoGo(null);
  };
  // A Metro left running from before keeps serving; a second one would ask for another port.
  const startMetro = () => {
    if (devServer === null) return;
    onRunCommand(
      `lsof -nP -iTCP:${METRO_PORT} -sTCP:LISTEN >/dev/null 2>&1 && echo "Metro ya está en marcha en el puerto ${METRO_PORT}." || (${devServer})`,
    );
  };
  const runHereLive = () => {
    if (busy || devServer === null) return;
    startMetro();
    setPhase({ kind: "building", runId: randomUUID(), live: true });
  };
  const runExpoGoHere = () => {
    if (busy || expoGoUrl === null) return;
    startMetro();
    setExpoGo("here");
  };
  const runExpoGoPhone = () => {
    if (expoGoUrl === null) return;
    startMetro();
    setPhoneOpen(true);
  };
  const runLive = () => onAskAgent(livePrompt(environmentLabel));
  const label =
    expoGo === "here"
      ? metroRunning
        ? "Abriendo Expo Go…"
        : "Esperando a Metro…"
      : phase.kind === "building"
        ? "Compilando…"
        : phase.kind === "waiting-metro"
          ? "Esperando a Metro…"
          : phase.kind === "installing"
            ? "Abriendo…"
            : "Simular";

  const items = (density: "touch" | undefined) => (
    <>
      <MenuItem {...(density ? { density } : {})} disabled={busy || !canRunHere} onClick={runHere}>
        <MenuItemLabel>En este Mac</MenuItemLabel>
      </MenuItem>
      {expoGoUrl !== null ? (
        <>
          <MenuItem
            {...(density ? { density } : {})}
            disabled={busy || bridge?.deviceHost === undefined}
            onClick={runExpoGoHere}
          >
            <MenuItemLabel>Expo Go en este Mac</MenuItemLabel>
          </MenuItem>
          <MenuItem {...(density ? { density } : {})} onClick={runExpoGoPhone}>
            <MenuItemLabel>Expo Go en el móvil</MenuItemLabel>
          </MenuItem>
        </>
      ) : (
        <>
          {devServer !== null ? (
            <MenuItem
              {...(density ? { density } : {})}
              disabled={busy || !canRunHere}
              onClick={runHereLive}
            >
              <MenuItemLabel>En este Mac, con cambios en directo</MenuItemLabel>
            </MenuItem>
          ) : null}
          <MenuItem {...(density ? { density } : {})} onClick={runLive}>
            <MenuItemLabel>En {environmentLabel}, con cambios en directo</MenuItemLabel>
          </MenuItem>
        </>
      )}
      <MenuItem {...(density ? { density } : {})} onClick={() => setLogOpen(true)}>
        <MenuItemLabel>Ver log de la compilación</MenuItemLabel>
      </MenuItem>
      {busy ? (
        <MenuItem {...(density ? { density } : {})} onClick={cancel}>
          <MenuItemLabel>Cancelar</MenuItemLabel>
        </MenuItem>
      ) : null}
    </>
  );

  const dialog = (
    <Dialog open={logOpen} onOpenChange={setLogOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Simulador</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs whitespace-pre-wrap">
              {buildState?.command ?? buildCommand}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 text-sm">
            {busy ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-4" />
                {label}
              </p>
            ) : null}
            {phase.kind === "failed" ? (
              <p className="text-destructive-foreground">{phase.message}</p>
            ) : null}
            <pre
              ref={logRef}
              className="max-h-80 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
            >
              {buildState?.output ?? ""}
            </pre>
          </div>
        </DialogPanel>
        <DialogFooter>
          {phase.kind === "failed" && buildState?.output ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onAskAgent(
                  `La compilación para el simulador ha fallado. Arréglalo. Final del log:\n\n\`\`\`\n${buildState.output.slice(-6000)}\n\`\`\``,
                );
                setLogOpen(false);
              }}
            >
              Pedir al agente que lo arregle
            </Button>
          ) : null}
          <Button size="sm" disabled={busy || !canRunHere} onClick={runHere}>
            {phase.kind === "failed" ? "Reintentar en este Mac" : "Simular en este Mac"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  const phoneDialog =
    expoGoUrl !== null ? (
      <Dialog open={phoneOpen} onOpenChange={setPhoneOpen}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Expo Go en el móvil</DialogTitle>
            <DialogDescription>
              Escanea el código con la cámara del móvil o con Expo Go. El móvil tiene que estar en
              la misma red que {environmentLabel}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid justify-items-center gap-3">
              <div className="rounded-md bg-white p-3">
                <QRCodeSvg value={expoGoUrl} size={200} />
              </div>
              <p className="flex items-center gap-2 text-muted-foreground text-xs">
                {metroRunning ? null : <Spinner className="size-3.5" />}
                {metroRunning ? "Metro está en marcha." : "Arrancando Metro…"}
              </p>
              <code className="select-all font-mono text-xs">{expoGoUrl}</code>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(expoGoUrl)}
            >
              Copiar dirección
            </Button>
            <Button size="sm" onClick={() => setPhoneOpen(false)}>
              Hecho
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    ) : null;

  if (presentation === "menu") {
    return (
      <>
        {items("touch")}
        {dialog}
        {phoneDialog}
      </>
    );
  }

  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Simular la app de iOS" size="xs" variant="outline" />}
        >
          {busy ? (
            <Spinner className="size-3.5" />
          ) : (
            <SmartphoneIcon aria-hidden="true" className="size-3.5" />
          )}
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {label}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">{items(undefined)}</MenuPopup>
      </Menu>
      {dialog}
      {phoneDialog}
    </>
  );
}
