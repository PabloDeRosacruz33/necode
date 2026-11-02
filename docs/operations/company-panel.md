# Company panel data

The company panel (right panel → Panel) shows files from the host's panel folder,
`~/.necora/empresa/panel/` (`NECODE_COMPANY_PANEL_DIR` overrides it). Each file has one owner, who
rewrites it whole whenever the data changes. A missing file shows "Sin dato" and a broken one "Dato
ilegible"; nothing is ever shown as zero. Usage data only, never text from real people's
conversations. The schemas are in `packages/contracts/src/companyPanel.ts`.

- `personas.json`: who may see the panel. `{ "members": { "<team member id>": "roi" } }`. The value
  must match a key of `informadores` in `../hilos.json`, which is where that person's answers go.
- `decisiones.json`: `{ "decisions": [{ "id", "title", "summary", "createdAt", "area"?, "problem"?,
"example"?, "thread"?, "options"?: [{ "id", "label", "short"?, "effect"?, "recommended"? }], "opinions"?: [{ "thread",
"optionId"?, "opinion" }], "references"?: [{ "name", "optionId"?, "how", "source"? }] }] }`. `title`
  describes the problem, `summary` explains it plainly, and `problem` with `example` are what "No lo
  entiendo" unfolds. `optionId` ties a row to an option: each option shows dots for how many pick it, `effect` is its short example of what changes, the seal counts the threads, and pressing the seal opens who picks what, with each reason and source. `short` names the option's column there. What is missing shows
  as missing. With `options`, the card shows them; without, yes and no. `thread` is the name of the thread waiting on it, which turns its tile purple.
- `costes.json`: `{ "currency": "EUR", "daysPerMonth", "perPerson": [{ "date", "total", "parts":
[{ "name", "amount" }], "release"? }], "simulator"?: { "withoutImages", "perFifthOfImages",
"baseVolume" }, "drops"?: [{ "amount", "reason" }], "spendLast30Days"?: [{ "date", "amount" }], "cache"?: { "percent", "detail"? } }`.
  `perPerson` follows the company's cost rule (D205), oldest first; real spend goes only in `spendLast30Days`. `drops` says what moved the cost; negative amounts lowered it.
- `salud.json`: `{ "strip"?: [{ "status", "text" }], "versions": [{ "environment", "version", "detail"? }], "systems": [{ "name",
"status": "ok" | "warning" | "down", "detail"?, "checkedAt"? }], "errorsByDay"?: [{ "date", "count", "detail"?, "byPlan"?: [{ "plan", "count" }] }], "database"?: { "readGbPerDay", "targetGbPerDay"?, "restGbPerDay"?, "checkedAt"?, "status"?, "callsPerMinute"?, "readGbToday"?, "readGbYesterday"?, "connectionsUsed"?, "connectionsLimit"?, "today"?: [number], "yesterday"?: [number], "log"?: [{ "at", "tone": "good" | "warning" | "bad" | "neutral", "text" }], "detail"? } }`. `strip` is the thin system strip, in plain words and without figures. `today` and `yesterday` hold calls per minute, one value per hour from midnight. `targetGbPerDay` is our own warning level, not what the database can take. Past 25 minutes since `checkedAt`, the block is marked old and loses its status.
- `pruebas.json`: `{ "currentVersion"?, "tests"?: [{ "id", "suite", "plan"?, "message", "runs": [{ "version", "at", "result": "passed" | "failed" | "warning" | "pending" | "skipped", "why"? }] }], "label", "passed", "failed", "skipped", "jobs"?: [{ "message", "result":
"passed" | "failed" | "skipped", "before"?, "now"?, "why"?, "version"?, "suite"? }] }`. Test messages only. `currentVersion` is the Cloud's version, written as in `runs`; only runs in it count. Without `currentVersion` and `tests`, the home says it has no data by version.
- `planes.json`: `{ "plans": [{ "id", "name", "color": "#rrggbb", "summary"?, "threads"?: ["<titulo>"], "steps": [{ "label", "status": "done" | "doing" | "todo", "who"? }], "squares"?: [{ "text", "status": "ok" | "bad" | "decide" | "partial", "why"? }], "yourTurn"?: { "text", "people"?: ["<person>"] } }] }`. `label` is a short verb, never a thread; `who` names a thread or "Tú". Squares have two or three words each, and `why` shows only when one is pressed. `yourTurn` shows only to `people`, as in `personas.json`, or to anyone without it. Each plan gets a card on its own. `threads` uses `titulo` from `../hilos.json`, and paints those tiles; a thread outside every plan is the system's. Plan colours must differ from the states': blue, purple, grey and red.
- `hilos-estado.json`: `{ "threads": [{ "name", "phrase"?, "done"?, "now"?, "next"?, "needsYou"?, "waitingFor"?, "updatedAt"? }] }`. Written by hand, matched to `../hilos.json` by title. It only gives a tile its words: the state's colour comes from what the server sees, so a note can never make a thread look like it works.

The server appends each answer to `respuestas.jsonl`, which takes the card out of the panel. Remove a
decision from `decisiones.json` once it is settled.
