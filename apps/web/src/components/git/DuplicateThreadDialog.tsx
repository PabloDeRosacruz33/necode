import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** An environment that has the thread's project, and the agents ready there. */
export interface DuplicateThreadDestination {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly agents: ReadonlyArray<{
    readonly label: string;
    readonly modelSelection: ModelSelection;
  }>;
}

export interface DuplicateThreadChoice {
  readonly taskName: string;
  readonly from: "integration" | "current";
  readonly destination: DuplicateThreadDestination;
  readonly modelSelection: ModelSelection;
}

interface DuplicateThreadRequest {
  readonly suggestedName: string;
  readonly destinations: ReadonlyArray<DuplicateThreadDestination>;
  /** The source thread's environment and agent, preselected. */
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceInstanceId: string;
}
type Request = DuplicateThreadRequest & {
  readonly resolve: (choice: DuplicateThreadChoice | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks where, with which agent and from where to start a parallel copy; null when cancelled. */
export function requestDuplicateThread(
  request: DuplicateThreadRequest,
): Promise<DuplicateThreadChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...request, resolve } }));
}

function finish(choice: DuplicateThreadChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function DuplicateThreadDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <DuplicateThreadDialog request={request} /> : null;
}

/**
 * "Duplicar en un hilo paralelo": a new thread with this one's history in its own task, on any
 * connected environment that has the project and with any agent ready there. The same agent on
 * the same environment keeps the full context.
 */
function DuplicateThreadDialog({ request }: { request: DuplicateThreadRequest }) {
  const [name, setName] = useState(request.suggestedName);
  const [from, setFrom] = useState<DuplicateThreadChoice["from"]>("integration");
  const [environmentId, setEnvironmentId] = useState<string>(request.sourceEnvironmentId);
  const destination =
    request.destinations.find((candidate) => candidate.environmentId === environmentId) ??
    request.destinations[0];
  const [instanceId, setInstanceId] = useState<string>(request.sourceInstanceId);
  const agent =
    destination?.agents.find((candidate) => candidate.modelSelection.instanceId === instanceId) ??
    destination?.agents[0];
  const sameAgentHere =
    destination?.environmentId === request.sourceEnvironmentId &&
    agent?.modelSelection.instanceId === request.sourceInstanceId;
  const submit = () => {
    if (!name.trim() || !destination || !agent) return;
    finish({ taskName: name.trim(), from, destination, modelSelection: agent.modelSelection });
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
            Un hilo nuevo con esta conversación, en su propia tarea. Lo que hagáis en uno no toca el
            otro.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 text-sm">
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
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <span className="text-muted-foreground">Dónde</span>
                <Select
                  value={destination?.environmentId ?? ""}
                  items={Object.fromEntries(
                    request.destinations.map((candidate) => [
                      candidate.environmentId,
                      candidate.label,
                    ]),
                  )}
                  onValueChange={(value) => {
                    if (typeof value === "string") setEnvironmentId(value);
                  }}
                >
                  <SelectTrigger aria-label="Dónde">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {request.destinations.map((candidate) => (
                      <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <span className="text-muted-foreground">Con qué agente</span>
                <Select
                  value={agent?.modelSelection.instanceId ?? ""}
                  items={Object.fromEntries(
                    (destination?.agents ?? []).map((candidate) => [
                      candidate.modelSelection.instanceId,
                      candidate.label,
                    ]),
                  )}
                  onValueChange={(value) => {
                    if (typeof value === "string") setInstanceId(value);
                  }}
                >
                  <SelectTrigger aria-label="Con qué agente">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {(destination?.agents ?? []).map((candidate) => (
                      <SelectItem
                        key={candidate.modelSelection.instanceId}
                        value={candidate.modelSelection.instanceId}
                      >
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
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
            <p className="text-xs text-muted-foreground">
              {sameAgentHere
                ? "Mismo agente y mismo ordenador: la copia sabe todo lo que sabe este hilo."
                : "Otro agente u otro ordenador: la copia lleva el historial y un resumen en el primer mensaje."}
              {destination?.environmentId !== request.sourceEnvironmentId && from === "current"
                ? " Desde otro ordenador, la rama de este hilo tiene que estar subida."
                : ""}
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => finish(null)}>
            Cancelar
          </Button>
          <Button size="sm" disabled={!name.trim() || !destination || !agent} onClick={submit}>
            Duplicar
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
