# Source control

Necode integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your Necode server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your Necode server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

Necode prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source Control**, expand **Bitbucket**, and choose how to sign in:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **API token**: an Atlassian API token for your account, used with your account email. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

Choose **Save**; the change applies right away, and replaces any credential saved with the other
method. Credentials are saved on the environment's server, so select a remote environment to
configure it. Saved tokens can't be viewed again; enter a new one to replace it, or choose
**Remove**.

If no credentials are saved, Necode falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Work in tasks

A task is one branch in its own folder (a git worktree) with its own thread, so several agents can
work on the same repository at once without seeing each other's files. Tasks start from and merge
into the project's integration branch: `integrationBranch` in the repository's `t3.json`, else the
project setting **Rama de integración** in **Settings → Project**, else `staging` when it exists,
else the remote's default branch.

- **Nueva tarea** (branch menu under the composer) names the task and opens a new thread. The
  first message creates the branch `<prefix>/<name>` from the latest integration branch on origin,
  creates its folder under `~/.necode/worktrees/<repo>/<name>` and runs the `runOnWorktreeCreate`
  script from `t3.json` (waiting for it when `async` is `false`). The prefix is your first name in
  Git, or the one set in **Settings → Source Control → Tareas**. An empty name is taken from the
  first message.
- **Actualizar desde …** fetches the integration branch and merges it into the thread's folder,
  keeping uncommitted work.
- When work brought into a task (Actualizar desde, Pull or a merge) changes its lockfiles, Necode runs
  the setup script (`runOnWorktreeCreate`) again in that task before it is used or merged, so its
  dependencies match its code. If the reinstall fails, Necode says so and the merge does not go
  ahead.
- **Fusionar en …**, in a task, merges without checking the integration branch out anywhere: it
  brings the integration branch into the task's folder and shows a plain summary of what this task
  changes. If teammates merged since the task started, it first lists what each of them brought in,
  with the summary their merge recorded, and asks you to try every change, theirs and yours, by
  hand in the task's app and tick each one. **Pedir al agente cómo probarlo** has the task's agent
  run the automatic checks and explain how to try each item. Then it runs the project's pre-merge
  check (`preMergeCheck` in `t3.json`, or the script marked `runBeforeMerge`) with its log live, and
  builds the merge commit, which records this task's summary for whoever merges next, and pushes
  it. Uncommitted work, conflicts (left in the task's folder for its agent) and a failed check stop
  the merge with a way forward. Afterwards, **Cerrar tarea** deletes the task's folder and its
  branch, locally and on the remote; the thread stays usable in the project's folder.
- **Seguir en una tarea nueva**, after a merge or from the branch menu, keeps the thread and its
  whole conversation: the current task is closed and the same thread continues on a new branch and
  folder from the latest integration branch.
- **Permanent threads** suit work that never ends (UI, performance, the Mac app). Turn on
  **Hilo permanente** in **Nueva tarea**: the task starts as `name-v1`, and every merge continues
  the same thread in the next version (`name-v2`, `name-v3`…) with its whole conversation.
- **Duplicar en un hilo paralelo**, from the branch menu or the thread menu, opens a new thread with
  the same conversation in its own task, on any connected computer that has the project and with
  any agent ready there. Start from the integration branch or from where the thread is now (from
  another computer, its branch must be pushed). The same agent on the same computer carries its
  full context over (Claude and Codex); otherwise the copy gets the history and a written summary.
  Work in the copy never changes the original.

Threads without their own folder share the project's checkout, so switching branches there
changes it for all of them; Necode warns before it does. If uncommitted edits would be overwritten,
choose **Stash and switch**: the edits are saved for that branch and come back when you switch to
it again. In that shared checkout, **Fusionar en …** checks the integration branch out, merges and
pushes, so commit first.

## Who commits are by

When several people work on one environment, give each of them a Git name and email in
**Settings → Team → Git** (use an email of their GitHub account so GitHub links the commits to it;
**Also for** copies it to the person's other devices). Commits a thread's agent, terminals and
**Fusionar en …** make are then signed by whoever sent the thread's latest message, and the tasks
they start are named after them (`roi/…`). Without one, commits use the machine's own Git identity.
An agent already running keeps the identity it started with until its session restarts.

## Git history

Open **Git** from the right panel (shortcut `G`) to see the project's history as a branch graph:
every local branch, remote branch and tag, who made each commit, and how the checked-out branch
stands against its remote (commits to push or pull, uncommitted files, stashes). Select a commit to
read its message and changes. **Fetch**, **Pull** and **Push** sit in the panel's header. The graph
refreshes when an agent commits or the background fetch brings in a teammate's work.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. Necode can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub CLI credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between Necode and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record Necode can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in Necode**.

The **Code** tab is a web and desktop surface. The mobile app reports a pull request's status but
does not show its diff, so marks are made and read on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
