import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironments } from "~/state/environments";
import { teamEnvironment, useTeamSnapshot } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The name and email each environment signs your commits with (your agent's, your terminals'
 * and your merges). Set from your own device, so it works on environments you only connect to.
 */
export function GitIdentitySettingsSection() {
  const { environments } = useEnvironments();
  return (
    <SettingsSection title="Quién firma tus commits">
      {environments.map((environment) => (
        <GitIdentityRow
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </SettingsSection>
  );
}

function GitIdentityRow(props: { readonly environmentId: EnvironmentId; readonly label: string }) {
  const { environmentId, label } = props;
  const team = useTeamSnapshot(environmentId);
  const setGitIdentity = useAtomCommand(teamEnvironment.setGitIdentity, { reportFailure: false });
  const self = team.members.find((member) => member.memberId === team.selfMemberId);
  const [draft, setDraft] = useState<{ name: string; email: string } | null>(null);
  const [alsoForMyDevices, setAlsoForMyDevices] = useState(true);
  if (!self) return null;

  const name = draft?.name ?? self.gitName ?? "";
  const email = draft?.email ?? self.gitEmail ?? "";
  const firstWord = self.name.split(/\s+/)[0]?.toLowerCase() ?? "";
  const hasOtherDevices = team.members.some(
    (member) =>
      member.memberId !== self.memberId && member.name.split(/\s+/)[0]?.toLowerCase() === firstWord,
  );

  const save = async (clear: boolean) => {
    if (!clear && (name.trim().length === 0 || !email.includes("@"))) return;
    const result = await setGitIdentity({
      environmentId,
      input: {
        git: clear ? null : { name: name.trim(), email: email.trim() },
        alsoForMyDevices: hasOtherDevices && alsoForMyDevices,
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "No se pudo guardar",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    setDraft(null);
    toastManager.add({ type: "success", title: `Guardado en ${label}` });
  };

  return (
    <SettingsRow
      title={label}
      description={
        self.gitEmail
          ? `Tus commits aquí salen como ${self.gitName} <${self.gitEmail}>.`
          : "Sin poner: tus commits aquí salen con la cuenta de Git de esta máquina. Usa el email de tu cuenta de GitHub."
      }
    >
      <form
        className="flex flex-col gap-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            className="w-40"
            placeholder="Nombre"
            aria-label="Nombre en Git"
            value={name}
            onChange={(event) => setDraft({ name: event.currentTarget.value, email })}
          />
          <Input
            size="sm"
            className="w-56"
            type="email"
            placeholder="Email"
            aria-label="Email en Git"
            value={email}
            onChange={(event) => setDraft({ name, email: event.currentTarget.value })}
          />
          <Button size="xs" type="submit">
            Guardar
          </Button>
          {self.gitEmail ? (
            <Button size="xs" variant="outline" onClick={() => void save(true)}>
              Quitar
            </Button>
          ) : null}
        </div>
        {hasOtherDevices ? (
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={alsoForMyDevices}
              onCheckedChange={(checked) => setAlsoForMyDevices(checked === true)}
            />
            También para mis otros aparatos
          </label>
        ) : null}
      </form>
    </SettingsRow>
  );
}
