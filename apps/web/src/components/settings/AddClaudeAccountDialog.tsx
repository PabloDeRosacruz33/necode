import { useAtomValue } from "@effect/atom-react";
import { ProviderDriverKind, ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { ClaudeSetupSection } from "./ClaudeSetupSection";
import { SettingsRow } from "./settingsLayout";

export function ClaudeConnectionButton(props: { readonly onClick: () => void }) {
  return (
    <Button onClick={props.onClick}>
      <ClaudeAI className="size-4 shrink-0" aria-hidden="true" />
      Continue with Claude
    </Button>
  );
}

/**
 * Adds a Claude account as its own instance. The account keeps its login in a
 * separate config directory and shares sessions with the default Claude home,
 * so a thread can switch to it when another account runs out of usage.
 */
export function AddClaudeAccountDialog({
  environmentId,
  environmentLabel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, "Add Claude account");
  const [name, setName] = useState("Personal");
  const displayName = `Claude - ${name.trim()}`;
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  const connected = provider?.auth.status === "authenticated";
  const closeAfterConnection = useEffectEvent(onClose);
  useEffect(() => {
    if (connected) closeAfterConnection();
  }, [connected]);

  const createAccount = async () => {
    if (pending || !name.trim()) return;
    setPending(true);
    // The ID is routing identity and names the login directory; the name stays editable.
    const suffix = randomUUID().slice(0, 8);
    const id = ProviderInstanceId.make(`claudeAgent_${suffix}`);
    const result = await update({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            ...settings.providerInstances,
            [id]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName,
              enabled: true,
              config: {
                enabled: true,
                homePath: `~/.claude-accounts/${suffix}`,
                shareSessions: true,
              },
            },
          },
        },
      },
    });
    if (result._tag === "Success") setInstanceId(id);
    setPending(false);
  };

  return (
    <Dialog
      open={!connected}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={instanceId ? displayName : "Add Claude account"}
          description="Each account has its own sign-in. Threads can switch between accounts from the model picker."
        />
        <WizardPanel>
          {instanceId ? (
            <ClaudeSetupSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={provider}
              autoStart
            />
          ) : (
            <form
              id="add-claude-account"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title="Account name"
                description="Shown in the provider list and model picker."
                control={
                  <Input
                    aria-label="Account name"
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Personal or Work"
                  />
                }
              />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {instanceId ? (
            <Button variant="outline" onClick={onClose}>
              Finish later
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="add-claude-account" disabled={pending || !name.trim()}>
                {pending ? "Adding account…" : "Continue"}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
