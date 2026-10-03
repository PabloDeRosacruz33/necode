import type { VcsWorktreeSetupRun } from "@t3tools/contracts";

/**
 * The toast line after bringing work into a task whose lockfiles changed, so its setup script
 * ran again. Null when nothing had to be reinstalled.
 */
export function describeWorktreeSetup(
  setup: VcsWorktreeSetupRun | undefined,
): { readonly failed: boolean; readonly text: string } | null {
  if (!setup) return null;
  if (setup.exitCode === 0) {
    return {
      failed: false,
      text: `Las dependencias cambiaron y se han reinstalado con «${setup.name}».`,
    };
  }
  const tail = setup.output.trim().split("\n").slice(-3).join("\n");
  const code = setup.exitCode === null ? "" : ` (código ${setup.exitCode})`;
  return {
    failed: true,
    text: `Las dependencias cambiaron, pero «${setup.name}» ha fallado${code}: la app puede no arrancar en esta tarea.${tail ? `\n${tail}` : ""}`,
  };
}
