import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { pickFailoverProvider, providerLimitedUntil } from "./ProviderAccountFailover.ts";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const LATER = "2026-10-31T12:00:00.000Z";

const claude = (
  instanceId: string,
  overrides: Partial<ServerProvider> = {},
  usedPercent: number | null = null,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T11:59:00.000Z",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...(usedPercent === null
    ? {}
    : {
        usageLimits: {
          checkedAt: "2026-10-30T11:59:00.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "5h", usedPercent, resetsAt: LATER },
          ],
        },
      }),
  ...overrides,
});

const selection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};

const pick = (
  providers: ReadonlyArray<ServerProvider>,
  reported: ReadonlyMap<string, number> = new Map([["claudeAgent", Date.parse(LATER)]]),
) =>
  pickFailoverProvider({
    providers,
    selection,
    reportedResets: reported,
    nowMs: NOW,
    enabledForProject: () => true,
  })?.instanceId ?? null;

describe("providerLimitedUntil", () => {
  it("counts a reported limit or a full window until it resets", () => {
    expect(providerLimitedUntil(claude("a"), new Map([["a", Date.parse(LATER)]]), NOW)).toBe(
      Date.parse(LATER),
    );
    expect(providerLimitedUntil(claude("a", {}, 100), new Map(), NOW)).toBe(Date.parse(LATER));
    expect(providerLimitedUntil(claude("a", {}, 99), new Map(), NOW)).toBeNull();
    expect(providerLimitedUntil(claude("a"), new Map([["a", NOW - 1]]), NOW)).toBeNull();
  });
});

describe("pickFailoverProvider", () => {
  it("keeps work on an account that is not limited", () => {
    expect(pick([claude("claudeAgent"), claude("claudeAgent_b")], new Map())).toBeNull();
  });

  it("moves a limited account's work to the same provider's account with most room", () => {
    expect(
      pick([
        claude("claudeAgent"),
        claude("claudeAgent_b", {}, 80),
        claude("claudeAgent_c", {}, 20),
        claude("codex", { driver: ProviderDriverKind.make("codex") }),
      ]),
    ).toBe("claudeAgent_c");
  });

  it("only moves to accounts that serve the same model and can run", () => {
    expect(
      pick([
        claude("claudeAgent"),
        claude("claudeAgent_noModel", { models: [] }),
        claude("claudeAgent_off", { enabled: false }),
        claude("claudeAgent_logout", { auth: { status: "unauthenticated" } }),
        claude("claudeAgent_full", {}, 100),
      ]),
    ).toBeNull();
  });

  it("does not bounce back to an account that reported its own limit", () => {
    const reported = new Map([
      ["claudeAgent", Date.parse(LATER)],
      ["claudeAgent_b", Date.parse(LATER)],
    ]);
    expect(pick([claude("claudeAgent"), claude("claudeAgent_b")], reported)).toBeNull();
  });
});
