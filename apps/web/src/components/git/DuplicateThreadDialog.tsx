import { useEffect, useState } from "react";
import { create } from "zustand";

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
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface DuplicateThreadChoice {
  readonly taskName: string;
  readonly from: "integration" | "current";
}
type Request = {
  readonly suggestedName: string;
  readonly resolve: (choice: DuplicateThreadChoice | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks how to start a parallel copy of a thread; null when cancelled. */
export function requestDuplicateThread(
  suggestedName: string,
): Promise<DuplicateThreadChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { suggestedName, resolve } }));
}

function finish(choice: DuplicateThreadChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function DuplicateThreadDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <DuplicateThreadDialog suggestedName={request.suggestedName} /> : null;
}

/**
 * "Duplicar en un hilo paralelo": a new thread with this one's history and agent context, in its
 * own task, so two people can work on the same subject without touching each other's thread.
 */
function DuplicateThreadDialog({ suggestedName }: { suggestedName: string }) {
  const [name, setName] = useState(suggestedName);
  const [from, setFrom] = useState<DuplicateThreadChoice["from"]>("integration");
  const submit = () => {
    if (name.trim()) finish({ taskName: name.trim(), from });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicar en un hilo paralelo</DialogTitle>
          <DialogDescription>
            Un hilo nuevo con esta conversación y su contexto, en su propia tarea. Lo que hagáis en
            uno no toca el otro.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Input
              size="sm"
              autoFocus
              aria-label="Nombre de la tarea del hilo paralelo"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Empezar desde</span>
              <ToggleGroup
                aria-label="Empezar desde"
                className="w-full *:flex-1"
                value={[from]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "integration" || next === "current") setFrom(next);
                }}
              >
                <Toggle value="integration">Lo último de integración</Toggle>
                <Toggle value="current">Donde va este hilo</Toggle>
              </ToggleGroup>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => finish(null)}>
            Cancelar
          </Button>
          <Button size="sm" disabled={!name.trim()} onClick={submit}>
            Duplicar
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
