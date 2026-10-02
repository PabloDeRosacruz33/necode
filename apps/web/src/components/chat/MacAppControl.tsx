/**
 * "Compilar y abrir" for projects whose t3.json declares `macApp.build`. The environment builds
 * in the thread's folder; the app then opens on the Mac in front of the user, downloaded first
 * when the environment is another machine. Opening and "Cerrar app" always quit the copies
 * already running, so the one on screen is the newest build.
 */
import type { EnvironmentId, MacAppBuilt } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AppWindowMacIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
import { randomUUID } from "~/lib/utils";
import { useRemoteOpenState } from "~/remoteOpen";
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
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "building"; readonly runId: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "opening"; readonly app: MacAppBuilt }
  | { readonly kind: "opened"; readonly app: MacAppBuilt };

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message ? error.message : "Algo ha fallado.";
}

export function MacAppControl({
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
  const remote = useRemoteOpenState(environmentId);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [logOpen, setLogOpen] = useState(false);
  const lastApp = useRef<MacAppBuilt | null>(null);
  const download = useAtomCommand(vcsEnvironment.macAppDownload, { reportFailure: false });
  const serverOpen = useAtomCommand(vcsEnvironment.macAppOpen, { reportFailure: false });
  const serverQuit = useAtomCommand(vcsEnvironment.macAppQuit, { reportFailure: false });

  const build = useEnvironmentQuery(
    phase.kind === "building"
      ? vcsEnvironment.macAppBuild({ environmentId, input: { cwd, runId: phase.runId } })
      : null,
  );
  // The query stops once the build ends; keep its last state so the log stays readable.
  const [finishedBuild, setFinishedBuild] = useState<typeof build.data>(null);
  const buildState = build.data ?? finishedBuild;
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [buildState?.output]);

  const bridge = window.desktopBridge;
  const isLocal = remote.mode === "local-exec";
  // A browser can only ask the environment to open the app on its own screen.
  const available = projectFile.file?.macApp !== undefined && (bridge !== undefined || isLocal);

  const openApp = async (app: MacAppBuilt) => {
    lastApp.current = app;
    setPhase({ kind: "opening", app });
    try {
      if (bridge?.openMacApp && isLocal) {
        await bridge.openMacApp({ appPath: app.path, bundleId: app.bundleId });
      } else if (bridge?.beginMacAppInstall && bridge.appendMacAppInstall) {
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
        await bridge.finishMacAppInstall!({ id, name: app.name, bundleId: app.bundleId });
      } else {
        const result = await serverOpen({
          environmentId,
          input: { appPath: app.path, bundleId: app.bundleId },
        });
        if (result._tag === "Failure") throw new Error(failureMessage(result));
      }
      setPhase({ kind: "opened", app });
    } catch (error) {
      setPhase({
        kind: "failed",
        message: `No se pudo abrir ${app.name}: ${error instanceof Error ? error.message : String(error)}`,
      });
      setLogOpen(true);
    }
  };

  useEffect(() => {
    if (phase.kind !== "building" || !buildState?.done) return;
    setFinishedBuild(buildState);
    if (buildState.exitCode === 0 && buildState.app) {
      void openApp(buildState.app);
    } else {
      setPhase({
        kind: "failed",
        message:
          buildState.exitCode === 0
            ? "La compilación terminó pero no encuentro la app. Añade macApp.appPath en t3.json."
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

  if (!available) return null;

  const busy = phase.kind === "building" || phase.kind === "opening";
  const startBuild = () => {
    if (busy) return;
    setPhase({ kind: "building", runId: randomUUID() });
  };
  const quitApp = async () => {
    const bundleId = lastApp.current?.bundleId ?? null;
    if (!bundleId) {
      toastManager.add({ type: "info", title: "Compila primero para saber qué app cerrar." });
      return;
    }
    if (bridge?.quitMacApp && (isLocal || bridge.finishMacAppInstall)) {
      await bridge.quitMacApp({ bundleId });
    } else {
      await serverQuit({ environmentId, input: { bundleId } });
    }
    setPhase({ kind: "idle" });
  };
  const label =
    phase.kind === "building"
      ? "Compilando…"
      : phase.kind === "opening"
        ? "Abriendo…"
        : "Compilar y abrir";

  const dialog = (
    <Dialog open={logOpen} onOpenChange={setLogOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>App Mac</DialogTitle>
          <DialogDescription>
            {buildState?.command ?? projectFile.file?.macApp?.build ?? ""}
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
            {phase.kind === "opened" ? <p>{phase.app.name} abierta.</p> : null}
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
                  `La compilación de la app Mac ha fallado. Arréglalo. Final del log:\n\n\`\`\`\n${buildState.output.slice(-6000)}\n\`\`\``,
                );
                setLogOpen(false);
              }}
            >
              Pedir al agente que lo arregle
            </Button>
          ) : null}
          <Button size="sm" disabled={busy} onClick={startBuild}>
            {phase.kind === "failed" ? "Reintentar" : "Compilar y abrir"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  if (presentation === "menu") {
    return (
      <>
        <MenuItem density="touch" disabled={busy} onClick={startBuild}>
          <AppWindowMacIcon className="size-4" />
          <MenuItemLabel>{label}</MenuItemLabel>
        </MenuItem>
        <MenuItem density="touch" onClick={() => void quitApp()}>
          <MenuItemLabel>Cerrar app</MenuItemLabel>
        </MenuItem>
        <MenuItem density="touch" onClick={() => setLogOpen(true)}>
          <MenuItemLabel>Ver log de la compilación</MenuItemLabel>
        </MenuItem>
        {dialog}
      </>
    );
  }

  return (
    <>
      <Group aria-label="App Mac">
        <Button size="xs" variant="outline" disabled={busy} onClick={startBuild}>
          {busy ? (
            <Spinner className="size-3.5" />
          ) : (
            <AppWindowMacIcon aria-hidden="true" className="size-3.5" />
          )}
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {label}
          </span>
        </Button>
        <GroupSeparator className="hidden @3xl/header-actions:block" />
        <Menu>
          <MenuTrigger
            render={
              <Button aria-label="Más opciones de la app Mac" size="icon-xs" variant="outline" />
            }
          >
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void quitApp()}>
              <MenuItemLabel>Cerrar app</MenuItemLabel>
            </MenuItem>
            <MenuItem onClick={() => setLogOpen(true)}>
              <MenuItemLabel>Ver log de la compilación</MenuItemLabel>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </Group>
      {dialog}
    </>
  );
}
