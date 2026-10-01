import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

interface RemoteMismatch {
  readonly previousRemote: string | null;
  readonly newRemote: string | null;
}

/**
 * Points a project at the same repository in another folder, e.g. after moving it out of
 * Dropbox. Threads keep their history; the server checks the folder and its remote.
 */
export function ChangeProjectFolderDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  workspaceRoot,
  canBrowse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  /** The folder lives on this computer, so the system picker can browse it. */
  canBrowse: boolean;
}) {
  const relocate = useAtomCommand(projectEnvironment.relocate, { reportFailure: false });
  const [path, setPath] = useState(workspaceRoot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<RemoteMismatch | null>(null);

  const close = () => {
    setError(null);
    setMismatch(null);
    onOpenChange(false);
  };

  const browse = async () => {
    const picked = await readLocalApi()
      ?.dialogs.pickFolder({ initialPath: path })
      .catch(() => null);
    if (picked) {
      setPath(picked);
      setMismatch(null);
      setError(null);
    }
  };

  const submit = async (allowRemoteMismatch: boolean) => {
    const target = path.trim();
    if (!target) return;
    setPending(true);
    setError(null);
    const result = await relocate({
      environmentId,
      input: {
        projectId,
        workspaceRoot: target,
        ...(allowRemoteMismatch ? { allowRemoteMismatch } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : "No se pudo cambiar la carpeta.");
      return;
    }
    if (result.value._tag === "remote-mismatch") {
      setMismatch(result.value);
      return;
    }
    toastManager.add({
      type: "success",
      title: "Carpeta cambiada",
      description: `El proyecto y sus hilos usan ahora ${result.value.workspaceRoot}.`,
    });
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cambiar carpeta</DialogTitle>
          <DialogDescription>
            Elige dónde está ahora este repositorio. Los hilos conservan su historial y los nuevos
            mensajes trabajan en la carpeta nueva.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Carpeta</span>
              <div className="flex gap-2">
                <Input
                  size="sm"
                  className="flex-1"
                  value={path}
                  aria-label="Carpeta del proyecto"
                  onChange={(event) => {
                    setPath(event.target.value);
                    setMismatch(null);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void submit(false);
                    }
                  }}
                />
                {canBrowse ? (
                  <Button size="sm" variant="outline" type="button" onClick={() => void browse()}>
                    Elegir…
                  </Button>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">Antes: {workspaceRoot}</span>
            </label>
            {mismatch ? (
              <p className="flex gap-2 text-xs text-warning-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Esta carpeta es de otro repositorio ({mismatch.newRemote ?? "sin remoto"}); el
                  proyecto era {mismatch.previousRemote ?? "sin remoto"}. Muévelo solo si es lo que
                  quieres.
                </span>
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" type="button" onClick={close} disabled={pending}>
            Cancelar
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={pending || path.trim().length === 0 || path.trim() === workspaceRoot}
            onClick={() => void submit(mismatch !== null)}
          >
            {mismatch ? "Mover igualmente" : "Cambiar carpeta"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
