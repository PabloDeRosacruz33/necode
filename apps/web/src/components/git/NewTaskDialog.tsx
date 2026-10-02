import { useState } from "react";

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
import { Switch } from "../ui/switch";

/**
 * "Nueva tarea": a branch from the latest integration branch, its own folder and a new thread.
 * A permanent task (`…-v1`) is a thread that lives forever: each merge continues it in the next
 * version.
 * The worktree is created when the first message is sent, with the project's setup script.
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  integrationBranch,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrationBranch: string;
  /** An empty name is taken from the first message. */
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [permanent, setPermanent] = useState(false);
  const create = () => {
    const trimmed = name.trim();
    if (permanent && !trimmed) return;
    onCreate(permanent ? `${trimmed}-v1` : trimmed);
    setName("");
    setPermanent(false);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva tarea</DialogTitle>
          <DialogDescription>
            Rama nueva desde lo último de {integrationBranch}, con su propia carpeta y su hilo.
            Ningún otro hilo ve sus cambios.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            size="sm"
            autoFocus
            placeholder="arreglar-sidebar (opcional)"
            aria-label="Nombre de la tarea"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                create();
              }
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {permanent
              ? `Hilo permanente: empieza en ${name.trim() || "nombre"}-v1 y, cada vez que fusionas, sigue solo en la versión siguiente con toda la conversación.`
              : "Si lo dejas vacío, se nombra a partir de tu primer mensaje."}
          </p>
          <label className="mt-3 flex items-center justify-between gap-3 text-sm">
            <span>Hilo permanente (UI, performance, app de Mac…)</span>
            <Switch
              size="sm"
              checked={permanent}
              aria-label="Hilo permanente"
              onCheckedChange={(checked) => setPermanent(Boolean(checked))}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button size="sm" disabled={permanent && !name.trim()} onClick={create}>
            Crear tarea
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
