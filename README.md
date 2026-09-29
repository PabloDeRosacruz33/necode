# Necode

Necode is a private fork of [T3 Code](https://github.com/pingdotgg/t3code) for small teams. It keeps everything T3 Code does (a desktop app that runs your coding agents and a mobile app to follow and drive them from anywhere) and adds multiplayer: several people can sign in to the same host machine and watch and drive the same sessions live, each with their own name and role.

Builds are distributed privately for now: a signed macOS app and an iOS app through TestFlight.

## Requirements

> [!WARNING]
> Necode currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Necode as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Building from source

Necode uses Vite+ (`vp`) and Node 24. Install dependencies with `vp i` (or `pnpm install`), then run `vp run dev`.

Necode is built on T3 Code by T3 Tools and keeps its MIT license.
