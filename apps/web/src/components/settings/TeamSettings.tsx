import { teamMemberInitials } from "@t3tools/client-runtime/state/team";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AdvertisedEndpoint,
  EnvironmentId,
  TeamInvitableRole,
  TeamMember,
  TeamSnapshot,
} from "@t3tools/contracts";
import { useState } from "react";

import { teamEnvironment, useTeamSnapshot } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ROLE_LABELS: Record<TeamMember["role"], string> = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer",
};

const ROLE_HINTS: Record<TeamInvitableRole, string> = {
  member: "Can send messages, approve actions and use terminals.",
  viewer: "Can watch every session live but cannot act.",
};

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Something went wrong.",
  });
}

function MemberAvatar({ member }: { member: TeamMember }) {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-2xs font-semibold text-white"
      style={{ backgroundColor: member.color }}
      aria-hidden
    >
      {teamMemberInitials(member.name)}
    </span>
  );
}

function isOnline(snapshot: TeamSnapshot, memberId: string): boolean {
  return snapshot.presence.some((entry) => entry.memberId === memberId);
}

/**
 * The people allowed on this environment. Invites are one-time links bound to
 * a person and a role; removing someone cuts their open sessions at once.
 */
export function TeamSettings(props: {
  readonly environmentId: EnvironmentId;
  /** Public address (Tailscale Funnel) that works from anywhere; null while it is off. */
  readonly publicEndpoint: AdvertisedEndpoint | null;
  /** Fallback address that only works on this network or tailnet. */
  readonly localEndpoint: AdvertisedEndpoint | null;
}) {
  const { environmentId, publicEndpoint, localEndpoint } = props;
  const endpoint = publicEndpoint ?? localEndpoint;
  const team = useTeamSnapshot(environmentId);
  const invite = useAtomCommand(teamEnvironment.invite, { reportFailure: false });
  const revokeMember = useAtomCommand(teamEnvironment.revokeMember, { reportFailure: false });
  const updateMember = useAtomCommand(teamEnvironment.updateMember, { reportFailure: false });

  const [name, setName] = useState("");
  const [role, setRole] = useState<TeamInvitableRole>("member");
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<{
    name: string;
    url: string;
    isPublic: boolean;
  } | null>(null);
  const [editingOwnerName, setEditingOwnerName] = useState<string | null>(null);

  const submitInvite = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || inviting) return;
    setInviting(true);
    const result = await invite({ environmentId, input: { name: trimmed, role } });
    setInviting(false);
    if (result._tag === "Failure") {
      reportFailure("Could not create the invite", result);
      return;
    }
    const credential = result.value.credential.credential;
    const url = endpoint
      ? resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
      : resolveDesktopPairingUrl(window.location.origin, credential);
    setLastInvite({ name: trimmed, url, isPublic: publicEndpoint !== null });
    setName("");
  };

  const removeMember = async (member: TeamMember) => {
    if (!window.confirm(`Remove ${member.name}? Their devices disconnect immediately.`)) return;
    const result = await revokeMember({ environmentId, input: { memberId: member.memberId } });
    if (result._tag === "Failure") reportFailure(`Could not remove ${member.name}`, result);
  };

  const saveOwnerName = async (member: TeamMember) => {
    const next = editingOwnerName?.trim() ?? "";
    setEditingOwnerName(null);
    if (next.length === 0 || next === member.name) return;
    const result = await updateMember({
      environmentId,
      input: { memberId: member.memberId, name: next },
    });
    if (result._tag === "Failure") reportFailure("Could not rename", result);
  };

  return (
    <SettingsSection title="Team">
      {team.members.map((member) => {
        const online = isOnline(team, member.memberId);
        const isSelf = member.memberId === team.selfMemberId;
        return (
          <SettingsRow
            key={member.memberId}
            title={
              <span className="flex items-center gap-2">
                <MemberAvatar member={member} />
                {isSelf && editingOwnerName !== null ? (
                  <Input
                    autoFocus
                    size="sm"
                    aria-label="Your name"
                    value={editingOwnerName}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setEditingOwnerName(event.currentTarget.value)}
                    onBlur={() => void saveOwnerName(member)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveOwnerName(member);
                      if (event.key === "Escape") setEditingOwnerName(null);
                    }}
                  />
                ) : (
                  <span>
                    {member.name}
                    {isSelf ? <span className="text-muted-foreground"> (you)</span> : null}
                  </span>
                )}
              </span>
            }
            description={`${ROLE_LABELS[member.role]} · ${online ? "Online" : "Offline"}`}
            control={
              member.role === "owner" ? (
                isSelf && editingOwnerName === null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setEditingOwnerName(member.name)}
                  >
                    Rename
                  </Button>
                ) : null
              ) : (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => void removeMember(member)}
                >
                  Remove
                </Button>
              )
            }
          />
        );
      })}
      <SettingsRow
        title="Invite someone"
        description={ROLE_HINTS[role]}
        control={
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitInvite();
            }}
          >
            <Input
              size="sm"
              className="w-36"
              placeholder="Name"
              aria-label="Name"
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <ToggleGroup
              aria-label="Role"
              value={[role]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "member" || next === "viewer") setRole(next);
              }}
            >
              <Toggle value="member">Member</Toggle>
              <Toggle value="viewer">Viewer</Toggle>
            </ToggleGroup>
            <Button size="xs" type="submit" disabled={name.trim().length === 0 || inviting}>
              {inviting ? "Creating…" : "Create invite"}
            </Button>
          </form>
        }
      />
      {lastInvite ? (
        <SettingsRow
          title={`Invite for ${lastInvite.name}`}
          description="One use, valid for 7 days. Scan it with Necode on their phone or open it in their browser."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(lastInvite.url).then(
                  () => toastManager.add({ type: "success", title: "Invite link copied" }),
                  () => toastManager.add({ type: "error", title: "Could not copy the link" }),
                );
              }}
            >
              Copy link
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-2 pt-2">
            <QRCodeSvg
              value={lastInvite.url}
              size={148}
              level="M"
              marginSize={2}
              title="Invite link"
            />
            <code className="max-w-full break-all text-2xs text-muted-foreground">
              {lastInvite.url}
            </code>
            {lastInvite.isPublic ? null : (
              <p className="text-2xs text-warning">
                This link only works on your own network or tailnet. Turn on Tailscale HTTPS below
                to publish this machine, then create a new invite.
              </p>
            )}
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
