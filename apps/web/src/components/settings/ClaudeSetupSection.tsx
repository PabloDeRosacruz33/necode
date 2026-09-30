import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

interface ClaudeSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  /** Start sign-in as soon as the section can, for a freshly added account. */
  readonly autoStart?: boolean;
}

/**
 * Claude subscription sign-in for one instance. The server runs Claude's own
 * login; Claude's page shows a code that the user pastes back here.
 */
export function ClaudeSetupSection(props: ClaudeSetupSectionProps) {
  if (props.provider?.setup === undefined) {
    return (
      <SettingsRow
        title="Claude account"
        description={
          props.provider ? "Update this environment to sign in here." : "Checking Claude."
        }
      />
    );
  }
  return <ClaudeSignIn key={`${props.environmentId}:${props.instanceId}`} {...props} />;
}

function ClaudeSignIn({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  autoStart,
}: ClaudeSetupSectionProps) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const auth = authQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, commandOptions);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState({ flowId: null as string | null, value: "" });
  const [copiedFlowId, setCopiedFlowId] = useState<string | null>(null);

  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const authenticated = provider?.auth.status === "authenticated";
  const authorizationUrl = auth?.phase === "waiting" ? auth.authorizationUrl : null;
  const code = codeDraft.flowId === auth?.flowId ? codeDraft.value : "";
  const email = provider?.auth.email?.trim();
  const status =
    auth === null
      ? "Reading sign-in status."
      : authActive || auth.phase === "failed" || auth.phase === "cancelled"
        ? (auth.message ?? "Sign in with your Claude account.")
        : authenticated
          ? email
            ? `Signed in as ${email}.`
            : "Signed in."
          : "Sign in with your Claude account.";

  async function run<A, E>(request: () => Promise<AtomCommandResult<A, E>>): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Claude sign-in failed.");
        }
        return false;
      }
      return true;
    } catch {
      setError("Claude sign-in failed. Try again.");
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const autoStarted = useRef(false);
  const startOnce = useEffectEvent(() => {
    autoStarted.current = true;
    void run(() => startAuth(target));
  });
  useEffect(() => {
    if (!autoStart || autoStarted.current || authenticated || auth?.phase !== "idle") return;
    startOnce();
  }, [autoStart, authenticated, auth?.phase]);

  async function openSignInPage() {
    if (!authorizationUrl) return;
    try {
      await ensureLocalApi().shell.openExternal(authorizationUrl);
    } catch {
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  async function copySignInLink() {
    if (!authorizationUrl) return;
    try {
      await writeTextToClipboard(authorizationUrl, "Claude sign-in link");
      setCopiedFlowId(auth?.flowId ?? null);
    } catch {
      setError("Could not copy the sign-in link. Use Open sign-in page.");
    }
  }

  async function submitCode() {
    const flowId = auth?.flowId;
    if (!flowId || !code.trim() || auth.phase !== "waiting") return;
    const accepted = await run(() =>
      completeAuth({ environmentId, input: { instanceId, flowId, callbackUrl: code.trim() } }),
    );
    if (accepted) setCodeDraft({ flowId: null, value: "" });
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Sign out of ${provider?.displayName ?? "Claude"} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    );
    if (confirmed) await run(() => logoutAuth(target));
  }

  return (
    <div className="divide-y divide-border/50 text-xs">
      <SettingsRow
        title="Claude account"
        description="Use a Claude Pro or Max subscription."
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:max-w-72 sm:items-end sm:text-right">
            <p role="status" className="text-muted-foreground [overflow-wrap:anywhere]">
              {status}
            </p>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {authorizationUrl ? (
                <>
                  <Button size="sm" onClick={() => void openSignInPage()}>
                    Open sign-in page
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void copySignInLink()}>
                    {copiedFlowId === auth?.flowId ? "Link copied" : "Copy link"}
                  </Button>
                </>
              ) : null}
              {authActive && auth?.flowId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    const flowId = auth.flowId;
                    if (flowId)
                      void run(() => cancelAuth({ environmentId, input: { instanceId, flowId } }));
                  }}
                >
                  Cancel
                </Button>
              ) : authenticated ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || auth === null}
                  onClick={() => void signOut()}
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || auth === null}
                  onClick={() => void run(() => startAuth(target))}
                >
                  {auth?.phase === "failed" || auth?.phase === "cancelled"
                    ? "Try again"
                    : "Sign in with Claude"}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {authorizationUrl ? (
          <form
            className="grid gap-2 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode();
            }}
          >
            <label htmlFor={`claude-code-${instanceId}`} className="text-muted-foreground">
              Sign in on the Claude page, then paste the code it shows.
            </label>
            <div className="flex gap-2">
              <Input
                id={`claude-code-${instanceId}`}
                size="sm"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste code"
                value={code}
                maxLength={4_096}
                disabled={pending}
                onChange={(event) =>
                  setCodeDraft({ flowId: auth?.flowId ?? null, value: event.target.value })
                }
              />
              <Button size="sm" type="submit" disabled={pending || !code.trim()}>
                Continue
              </Button>
            </div>
          </form>
        ) : auth?.phase === "waiting" ? (
          <p className="pb-2 text-muted-foreground">
            Sign-in is open in another client. Finish or cancel it there.
          </p>
        ) : null}
      </SettingsRow>
      {error || authQuery.error ? (
        <p role="alert" className="px-3 py-3 text-destructive [overflow-wrap:anywhere] sm:px-4">
          {error ?? authQuery.error}
        </p>
      ) : null}
    </div>
  );
}
