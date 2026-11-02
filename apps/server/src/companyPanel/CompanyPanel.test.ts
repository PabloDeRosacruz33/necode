import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { prepareCompanyPanelAnswer, readCompanyPanelSnapshot } from "./CompanyPanel.ts";

const decision = {
  id: "D300",
  title: "¿Abrimos HubSpot?",
  summary: "Ha pasado su batería.",
  createdAt: "2026-11-02T10:00:00.000Z",
  options: [{ id: "a", label: "Abrirlo para todos" }],
};

const makePanel = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "company-panel-" });
  const dir = path.join(root, "panel");
  yield* fileSystem.makeDirectory(dir);
  const write = (name: string, value: unknown) =>
    fileSystem.writeFileString(path.join(dir, name), JSON.stringify(value));
  yield* write("personas.json", { members: { "member-roi": "roi" } });
  yield* fileSystem.writeFileString(
    path.join(root, "hilos.json"),
    JSON.stringify({
      informadores: { roi: { threadId: "informer-roi" } },
      trabajo: { PE: { threadId: "thread-pe", titulo: "Performance" } },
    }),
  );
  return { dir, write };
});

const snapshot = (dir: string, memberId: string | null = "member-roi") =>
  readCompanyPanelSnapshot({
    dir,
    memberId,
    threadStatus: (threadId) => Effect.succeed(threadId === "thread-pe" ? "running" : null),
  });

describe("company panel", () => {
  it.effect("shows nothing to people the panel does not list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dir } = yield* makePanel;
        assert.isFalse((yield* snapshot(dir, "member-other")).available);
        assert.isFalse((yield* snapshot(dir, null)).available);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tells missing and broken data apart from real data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, write } = yield* makePanel;
        yield* write("costes.json", { currency: 12 });
        yield* write("decisiones.json", { decisions: [decision] });
        const result = yield* snapshot(dir);
        assert.isTrue(result.available);
        assert.equal(result.person, "roi");
        assert.equal(result.health.status, "missing");
        assert.equal(result.costs.status, "invalid");
        assert.equal(result.decisions.status, "ok");
        assert.deepEqual(result.threads, [{ name: "Performance", status: "running" }]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends an answer to the person's informer and takes the card out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, write } = yield* makePanel;
        yield* write("decisiones.json", { decisions: [decision] });
        const prepared = yield* prepareCompanyPanelAnswer({
          dir,
          memberId: "member-roi",
          decisionId: "D300",
          answer: { type: "option", optionId: "a" },
        });
        assert.equal(prepared.informerThreadId, "informer-roi");
        assert.equal(
          prepared.text,
          "Decisión D300 · ¿Abrimos HubSpot?\nMi respuesta: Abrirlo para todos",
        );
        yield* prepared.record;

        const result = yield* snapshot(dir);
        assert.equal(result.decisions.status, "ok");
        assert.deepEqual(
          result.decisions.status === "ok" ? result.decisions.data.decisions : [],
          [],
        );
        assert.equal(result.answered[0]?.answer, "Abrirlo para todos");
        assert.equal(result.answered[0]?.person, "roi");
        assert.equal(result.answered[0]?.title, "¿Abrimos HubSpot?");

        const again = yield* prepareCompanyPanelAnswer({
          dir,
          memberId: "member-roi",
          decisionId: "D300",
          answer: { type: "yes" },
        }).pipe(Effect.flip);
        assert.equal(again.message, "Esa decisión ya está contestada.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses answers from people the panel does not list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, write } = yield* makePanel;
        yield* write("decisiones.json", { decisions: [decision] });
        const refused = yield* prepareCompanyPanelAnswer({
          dir,
          memberId: "member-other",
          decisionId: "D300",
          answer: { type: "yes" },
        }).pipe(Effect.flip);
        assert.equal(refused.message, "No tienes acceso a este panel.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
