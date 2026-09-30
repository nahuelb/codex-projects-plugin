# Project Coordinator for Codex

Project Coordinator is a Codex plugin inspired by Cursor Projects and Claude Code Projects. Each project gets a coordinator chat. It hands each task to a background Codex agent in its own git worktree, tracks what needs you, and keeps notes and memory that every agent reads.

The prompts and code are original. See [docs/design.md](docs/design.md) for how each pattern maps here and what is not built yet.

> **Status: experimental.** Tested on macOS with the Codex desktop app. It relies on Codex's MCP extensions and on `codex app-server` requests such as `thread/fork`, and on `codex://` deep links. These can change between Codex releases. It is not affiliated with OpenAI, Cursor, or Anthropic.

## What you get

- **Create Coordinator.** Pick an icon, a name, a workspace, and a model. Project Coordinator opens the project's coordinator chat in that workspace with the kickoff message ready to send.
- **A Project Coordinator page in the Codex sidebar.** A project list like Code Review with each project's notes, agents, memory, and files. Click a project to open its coordinator chat.
- **One coordinator chat per project.** It lives in the project's repository folder in the Codex sidebar and is named "Project Coordinator: <name>". It keeps one long thread that compacts but is never replaced, so the coordinator builds up context. A coordinator chat started elsewhere moves into the repository folder the next time you open it from the page.
- **A Coordinator panel beside the chat.** Open it once per coordinator chat from the side panel: **More tools… → Coordinator**. Notes, agents grouped by *Needs you*, *Ready for review*, *Working*, and *Idle*, memory, and all files, in one scrolling panel.
- **Project files in Codex tabs.** All Files lists the project's plans, docs, notes, and memory. A file opens in a Codex file tab, where you can read and edit it and save with ⌘S. The coordinator writes plans and documents with `file_write` and links them in chat and in `notes.md`.
- **A coordinator skill (`$coordinator`).** The coordinator reads a project digest each turn, starts agents, forwards follow-ups, and keeps `notes.md` and memory current.
- **Codex agents.** Agents run through `codex app-server` and show up as Codex chats. Each one gets a brief with the project instructions, memory, and its task, and ends each turn with a report: `## Report`, `## Next`, `## Needs you`, and `## Remember`.
- **@-mention a project** in any chat to attach its current status.
- **Pull request follow-up.** When an agent's PR gets failing checks or a review that requests changes, the agent is told to fix it. When it merges, the coordinator hears about it.
- **Durable memory.** `MEMORY.md` is an index of typed memory files that every new agent receives. `preferences.md` holds cross-project preferences.

## Install (local)

Requires Node 22.18+, the Codex app, and the `codex` CLI signed in.

```sh
git clone https://github.com/nahuelb/codex-projects-plugin.git
cd codex-projects-plugin
npm install
npm run install:local
codex plugin add codex-projects-plugin@personal
```

Restart the Codex app, then open **Project Coordinator** in the sidebar and click **New Coordinator**.

`install:local` copies the built plugin to `~/plugins/codex-projects-plugin` and lists it in `~/.agents/plugins/marketplace.json`.

To update, pull and run `npm run install:local` again, then restart Codex. To remove it, run `codex plugin remove codex-projects-plugin@personal`. Your projects stay in `~/.projects-coordinator` until you delete that folder.

## How it works

```
Codex app ── MCP (stdio) ──► dist/server.js ── unix socket ──► dist/daemon.js (coordd)
   │  Coordinator page + panel (MCP App UI)          │                 └─ codex app-server (agents, models,
   │  coordinator chat with $coordinator skill       │                    thread names)
   └─────────────────────────────────────────────────┴── ~/.projects-coordinator/ (files are the record)
```

- The MCP server is stateless. It reads and writes project files and forwards agent commands to `coordd`.
- `coordd` is a small background service that owns the running agents. The MCP server starts it on first use. It keeps agents alive across chats and restarts itself after an update. It exits after 6 hours without work.
- If `coordd` restarts, running agents are marked *stopped*. Send them a message to continue in the same session.

## Data

```
~/.projects-coordinator/
  projects/<slug>/
    project.json      name, icon, color, workspace, model, coordinator chat id
    INSTRUCTIONS.md   standing instructions for every agent
    notes.md          the status board (coordinator-owned)
    MEMORY.md         memory index; memory/*.md typed memory files
    docs/ plans/ internal/
    agents/<id>.json  agent records and reports
    inbox/            events for the coordinator
  worktrees/<slug>/   one git worktree per agent (branch project/<slug>/<id>-<title>)
  user/preferences.md cross-project preferences
```

Set `PROJECTS_COORDINATOR_HOME` to use another folder.

## Notes and limits

- Codex agents run with the `workspace-write` sandbox, approval `never`, network on, and write access to their worktree and the repository's `.git` folder. Set `PROJECTS_CODEX_NETWORK=0` to turn network off.
- PR follow-up needs `gh` signed in. It runs while the background service is up.
- The plugin launches your own signed-in `codex` CLI. It never handles your credentials.
- Agents act on your machine without asking for approval, inside the sandbox above. Review what you ask the coordinator to start, and keep project instructions free of secrets: they are sent to every agent.
- The Project Coordinator page, Coordinator panel, quick action, mentions, deep links, and file tabs use OpenAI's MCP extensions. Other MCP hosts show the plain MCP App, if they support MCP Apps. There, files open in a built-in viewer with Preview and Source modes.
- Mobile needs a hosted endpoint and is not built yet.

## Development

```sh
npm run build      # dist/app.html, dist/server.js, dist/daemon.js
npm test           # node --test on the TypeScript sources
npm run typecheck
npm run preview    # the UI in a browser at http://localhost:4321/?mode=panel (or ?mode=home)
```

## License

MIT. See [LICENSE](LICENSE).
