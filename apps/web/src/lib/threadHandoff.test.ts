import type { OrchestrationMessage, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadHandoffPrompt, resolveThreadHandoffTargets } from "./threadHandoff";

const provider = (overrides: Partial<Record<keyof ServerProvider, unknown>>): ServerProvider =>
  ({
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    models: [
      { slug: "gpt-old", name: "Old", isCustom: false, isLegacy: true, capabilities: null },
      { slug: "gpt-new", name: "New", isCustom: false, isDefault: true, capabilities: null },
    ],
    ...overrides,
  }) as unknown as ServerProvider;

const message = (
  role: OrchestrationMessage["role"],
  text: string,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage =>
  ({
    id: `${role}-${text.length}`,
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    ...overrides,
  }) as OrchestrationMessage;

describe("resolveThreadHandoffTargets", () => {
  it("offers ready providers other than the current one, with their default model", () => {
    const targets = resolveThreadHandoffTargets(
      [
        provider({ instanceId: "claude", displayName: "Claude" }),
        provider({}),
        provider({ instanceId: "cursor", displayName: "Cursor", installed: false }),
        provider({ instanceId: "opencode", displayName: "OpenCode", enabled: false }),
      ],
      "claude",
    );
    expect(targets.map((target) => [target.label, target.modelSelection.model])).toEqual([
      ["Codex", "gpt-new"],
    ]);
  });
});

describe("buildThreadHandoffPrompt", () => {
  it("carries the conversation and leaves the next request for the user", () => {
    const prompt = buildThreadHandoffPrompt({
      title: "Fix login",
      sourceLabel: "Claude",
      messages: [
        message("user", "The login button does nothing"),
        message("reasoning", "thinking out loud"),
        message("assistant", "Found it: the handler is never bound."),
        message("assistant", "partial", { streaming: true }),
      ],
    });
    expect(prompt).toContain('started with Claude in the thread "Fix login"');
    expect(prompt).toContain("User:\nThe login button does nothing");
    expect(prompt).toContain("Claude:\nFound it: the handler is never bound.");
    expect(prompt).not.toContain("thinking out loud");
    expect(prompt).not.toContain("partial");
    expect(prompt.endsWith("Next request: ")).toBe(true);
  });

  it("keeps the most recent messages when the history is long", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `${index} ${"x".repeat(1_000)}`),
    );
    const prompt = buildThreadHandoffPrompt({ title: "Long", sourceLabel: "Codex", messages });
    expect(prompt).toContain("oldest messages are omitted");
    expect(prompt).toContain("39 x");
    expect(prompt).not.toContain("\n0 x");
  });
});
