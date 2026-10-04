/**
 * "Simular" for projects whose t3.json declares `iosSimulator.build`, with the two ways to try
 * the iOS app:
 * - On this Mac: the environment builds a self-contained simulator app, this Mac downloads it and
 *   runs it in its own simulator. Nothing crosses the network while testing; seeing a change
 *   means simulating again.
 * - On the environment, live: its agent starts the app with the dev server on the environment's
 *   simulator, so saved changes appear at once, watched through the Device panel.
 */
import type { EnvironmentId, MacAppBuilt } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ChevronDownIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
import { randomUUID } from "~/lib/utils";
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
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "building"; readonly runId: string }
  | { readonly kind: "installing"; readonly app: MacAppBuilt }
  | { readonly kind: "failed"; readonly message: string };

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message ? error.message : "Algo ha fallado.";
}

const livePrompt = (environmentLabel: string) =>
  [
    `Arranca la app de iOS de este proyecto en un simulador de ${environmentLabel} (device_open con hostId "local"), con el servidor de desarrollo (Metro) en marcha para que los cambios se vean al guardar.`,
    "Ábrela en el panel Device y dime cuándo está lista.",
  ].join(" ");

export function SimulatorControl({
  environmentId,
  cwd,
  presentation,
  onAskAgent,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  presentation: "menu" | "toolbar";
  onAskAgent: (prompt: string) => void;
}) {
  const projectFile = useT3ProjectFileState(environmentId, cwd);
  const environment = useEnvironment(environmentId);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [logOpen, setLogOpen] = useState(false);
  const download = useAtomCommand(vcsEnvironment.macAppDownload, { reportFailure: false });
  const build = useEnvironmentQuery(
    phase.kind === "building"
      ? vcsEnvironment.macAppBuild({
          environmentId,
          input: { cwd, runId: phase.runId, target: "ios-simulator" },
        })
      : null,
  );
  const [finishedBuild, setFinishedBuild] = useState<typeof build.data>(null);
  const buildState = build.data ?? finishedBuild;
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [buildState?.output]);

  const bridge = window.desktopBridge;
  const canRunHere = bridge?.finishSimulatorAppInstall !== undefined;
  const environmentLabel = environment?.label ?? "el entorno";

  const install = async (app: MacAppBuilt) => {
    setPhase({ kind: "installing", app });
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
      const device = await bridge.finishSimulatorAppInstall!({
        id,
        name: app.name,
        bundleId: app.bundleId,
      });
      setPhase({ kind: "idle" });
      toastManager.add({ type: "success", title: `${app.name} abierta en ${device}` });
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
      void install(buildState.app);
    } else {
      setPhase({
        kind: "failed",
        message:
          buildState.exitCode === 0
            ? "La compilación terminó pero no encuentro la app. Añade iosSimulator.appPath en t3.json."
            : "La compilación ha fallado.",
      });
      setLogOpen(true);
    }
  }, [buildState?.done]);
  useEffect(() => {
    if (build.error && phase.kind === "building") {
      setPhase({ kind: "failed", message: "No se pudo compilar." });
      setLogOpen(true);
    }
  }, [build.error, phase.kind]);

  if (projectFile.file?.iosSimulator === undefined) return null;

  const busy = phase.kind === "building" || phase.kind === "installing";
  const runHere = () => {
    if (busy) return;
    setPhase({ kind: "building", runId: randomUUID() });
  };
  const runLive = () => onAskAgent(livePrompt(environmentLabel));
  const label =
    phase.kind === "building"
      ? "Compilando…"
      : phase.kind === "installing"
        ? "Abriendo…"
        : "Simular";

  const items = (density: "touch" | undefined) => (
    <>
      <MenuItem {...(density ? { density } : {})} disabled={busy || !canRunHere} onClick={runHere}>
        <MenuItemLabel>En este Mac</MenuItemLabel>
      </MenuItem>
      <MenuItem {...(density ? { density } : {})} onClick={runLive}>
        <MenuItemLabel>En {environmentLabel}, con cambios en directo</MenuItemLabel>
      </MenuItem>
      <MenuItem {...(density ? { density } : {})} onClick={() => setLogOpen(true)}>
        <MenuItemLabel>Ver log de la compilación</MenuItemLabel>
      </MenuItem>
    </>
  );

  const dialog = (
    <Dialog open={logOpen} onOpenChange={setLogOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Simulador</DialogTitle>
          <DialogDescription>
            {buildState?.command ?? projectFile.file.iosSimulator.build}
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

  if (presentation === "menu") {
    return (
      <>
        {items("touch")}
        {dialog}
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
    </>
  );
}
