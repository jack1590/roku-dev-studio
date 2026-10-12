# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this repo is

A public fork of `paramount-engineering/roku-dev-studio` (MIT) that we extend into an SDLC console: a Roku device UI plus an AI-driven code review and task pipeline.

- `origin` = `jack1590/roku-dev-studio` (our fork). Push here. Releases and in-app updates come from this repo.
- `upstream` = `paramount-engineering/roku-dev-studio`. Pull from here deliberately; never push to it.
- Keep the upstream `LICENSE` and copyright notice. Do not use Paramount branding or names in our UI, binaries, or docs.

## Goals

1. Keep the Electron app as the UI shell. Add our own tabs and views to it.
2. Put the review/task pipeline in its own package, not inside the Electron `main` or `renderer` code, so it can run headless later.
3. Let each project define its own settings (devices, repos, JIRA site, models) in a repo-tracked, non-secret config file.

## Review pipeline design

What the pipeline does:

1. **Code review**: multi-model review of a PR against its JIRA ticket, linked Figma designs, CI checks, and the repo's standards files (`AGENTS.md`, `.cursor/rules/`, `CONTRIBUTING.md`, lint/format configs).
2. **Implement task** (planned): takes a JIRA ticket end to end (plan, implement, build and test, PR, review) using its Figma designs.
3. **PR watch** (planned): keeps the user's own PRs current with their base branch; auto-reviews new or outdated PRs on each poll, reading only new commits.
4. **Other people's PRs**: off by default. When on, review-only: findings post as GitHub comments; never touches their branch.
5. **Fix / push**: applies fixes in an isolated git worktree, reports on each finding.

How a review works:

- Three reviewers run in parallel, each with one lens: correctness; security and data safety; maintainability, tests, and standards. A lens narrows what to hunt for, not what can be reported. Single reviewer gets all lenses.
- An arbiter merges duplicate findings (fingerprint-based), opens files to verify before ruling, marks each `real` or `dismissed`, and gives a 0 to 1 confidence.
- Reviewer failures are tolerated; the review names which lenses it lost.
- Red CI checks with file/line annotations skip arbitration and count as confirmed facts.
- Findings are tied to the diff; unresolved paths are marked "not found in the diff".
- Large PRs: lock files, build output, vendored code, snapshots, and binaries are dropped and named on the review.

Counting rules:

- `severityFloor` default `minor`: lower severities are shown but not counted as work.
- `confidenceFloor` default `0.5`: hedged findings are shown but not counted.
- Floors are changed in Settings. Do not hard-code them.

Context sources and how they are found:

- JIRA: issue key from PR description, then PR title, then branch name. A key counts only if it resolves in JIRA.
- Figma: links in PR description, ticket description, and ticket remote links.
- Standards: read from the checkout itself, not from a global config.

## Packager

- The Packager panel drives `roku-pkg generate --json` from `main/packager/`. roku-pkg-cli (≥ 1.2.1) is an app dependency run with Electron's Node (`ELECTRON_RUN_AS_NODE`); users install nothing. The renderer only gets masked projects and run state over IPC.
- Projects live in roku-pkg's own `~/.roku-pkg/config.json`, shared with the terminal CLI. Sign keys and device passwords never reach the renderer.
- Package runs share the PR Reviews device pool (`claimPoolDevice` in `main/review/review-service.ts`), so a review and a package run never hold the same device.

## Architecture rules

- Renderer is plain TypeScript and HTML (`apps/roku-dev-studio/renderer/`). No React or Vue. Add views as modules under `renderer/modules/` and pages as `.html` files in the same style.
- The pipeline must not run in the renderer. Run it in the Electron main process or a child process it starts. Renderer talks to it only through IPC.
- Electron stops when the window closes. Anything that must keep polling (PR watch, auto-review) must not depend on the window being open.
- Reuse device logic from `packages/roku-dev-studio-api` (sideload, ECP, console, screenshots). Do not re-implement it.
- Keep MCP behaviour intact. The bundled MCP server only works while the app is open; do not rely on it for background work.

## Secrets and config

- Never commit tokens, passwords, or API keys. Nothing secret goes in the repo or in chat.
- Per-project non-secret settings: a tracked config file (name to be decided, e.g. `.rds-project.json`).
- Secrets: OS keychain, or a per-project `.env` listed in `.gitignore`.
- Never log tokens or passwords, even truncated.
- Device passwords stay local. Agents and MCP calls must not send them.

## Commands (run from repo root)

```bash
npm install          # installs workspaces; postinstall runs build:libs
npm start            # builds and launches the Electron app
npm run typecheck    # full TypeScript check across all workspaces
npm test             # unit tests in every workspace that has them
npm run build:libs   # rebuild shared platform and api packages
```

Windows: the commands above are the same in PowerShell or cmd, run from the repo root. Windows installers are built with `npm run build:win` on Windows (see `INSTALLATION.md`). Cross-building from macOS needs Wine or a Windows machine. No code signing is configured yet.

## Working rules for agents

- Read the code you change and the code that calls it before editing.
- Prefer editing existing files. Keep changes small and in the owning package.
- Run `npm run typecheck` and the relevant tests before reporting done. Report failures verbatim.
- Do not change upstream-owned files just to suit our tabs. Wrap them instead, so upstream merges stay clean.
- Do not push to `upstream`. Do not force-push to `origin/main`.
- Do not change the license, copyright, or author lines.
