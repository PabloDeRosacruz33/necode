# Company panel data

The company panel (right panel → Panel) shows files from the host's panel folder,
`~/.necora/empresa/panel/` (`NECODE_COMPANY_PANEL_DIR` overrides it). Each file has one owner, who
rewrites it whole whenever the data changes. A missing file shows "Sin dato" and a broken one "Dato
ilegible"; nothing is ever shown as zero. Usage data only, never text from real people's
conversations. The schemas are in `packages/contracts/src/companyPanel.ts`.

- `personas.json`: who may see the panel. `{ "members": { "<team member id>": "roi" } }`. The value
  must match a key of `informadores` in `../hilos.json`, which is where that person's answers go.
- `decisiones.json`: `{ "decisions": [{ "id", "title", "summary", "createdAt", "area"?, "problem"?,
"example"?, "options"?: [{ "id", "label", "effect"?, "recommended"? }], "opinions"?: [{ "thread",
"optionId"?, "opinion" }], "references"?: [{ "name", "optionId"?, "how", "source"? }] }] }`. `title`
  describes the problem, `summary` explains it plainly, and `problem` with `example` are what "No lo
  entiendo" unfolds. `optionId` ties a row to an option; the seal counts them. What is missing shows
  as missing. With `options`, the card shows them; without, yes and no.
- `costes.json`: `{ "currency": "EUR", "daysPerMonth", "perPerson": [{ "date", "total", "parts":
[{ "name", "amount" }], "release"? }], "simulator"?: { "withoutImages", "perFifthOfImages",
"baseVolume" }, "spendLast30Days"?: [{ "date", "amount" }], "cache"?: { "percent", "detail"? } }`.
  `perPerson` follows the company's cost rule (D205), oldest first; real spend goes only in
  `spendLast30Days`.
- `salud.json`: `{ "versions": [{ "environment", "version", "detail"? }], "systems": [{ "name",
"status": "ok" | "warning" | "down", "detail"?, "checkedAt"? }], "errorsByDay"?: [{ "date", "count",
"detail"? }], "database"?: { "readGbPerDay", "detail"? } }`.
- `pruebas.json`: `{ "label", "passed", "failed", "skipped", "jobs"?: [{ "message", "result":
"passed" | "failed" | "skipped", "before"?, "now"?, "why"?, "version"?, "suite"? }] }`. Test
  messages only.

The server appends each answer to `respuestas.jsonl`, which takes the card out of the panel. Remove a
decision from `decisiones.json` once it is settled.
