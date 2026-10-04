const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

// Necode's merge dialog walks the same steps; this makes them hold for any merge an agent does,
// whether the user clicked a button or asked for it in chat.
const MERGE_PROTOCOL_INSTRUCTIONS = `<merge_protocol>
Merging into a branch others also use (the project's integration branch such as staging, or main) is a process, not a command. Follow it whenever you merge, push, or merge a pull request into such a branch, however the user asked for it ("mergéalo", "súbelo a staging", a button):
1. Fetch, then see what reached that branch since this work started: \`git log --first-parent <start>..origin/<branch>\` with authors and messages, and which of those changes touch the same files as this work or remove what this work added.
2. If others' work came in, stop before merging. Tell the user plainly, in their language and without jargon: who pushed what, what this work does, and where they overlap or one undoes the other. Ask how to proceed and wait.
3. Merge keeping what is already on the branch and reapplying this work on top; never restore an older version of a file to make this work fit. Run the project's checks, ask the user to try both their changes and this work by hand, and push only after they confirm. Never push straight to the branch to skip these steps.
4. Record it: the merge commit says what this work changes (## Resumen), how to try it (## Cómo probarlo) and what it was combined with and decided. Where one side's code was dropped or replaced, leave a short comment at that code saying what was removed, why and who decided, so a later agent does not silently undo it or bring it back.
The same applies when bringing the branch into this work: if incoming changes remove or rewrite what this work did, stop and say "X pushed Y, which changes Z of ours; how do you want to act?". Read such merge comments before changing the code they sit on.
</merge_protocol>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in Necode through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${MERGE_PROTOCOL_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
