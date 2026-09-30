# Design notes

How Projects brings the ideas of Cursor Projects and Claude Code Projects into the Codex app. The wording, prompts, and code here are original.

## Shared model

| Pattern | Inspiration | Here |
| --- | --- | --- |
| One coordinator per project that plans and delegates but does no heavy work | Cursor, Claude | The project's coordinator is a normal Codex chat running the `$projects` skill |
| Workers are full agent sessions in their own branch or worktree | Cursor, Claude | `agent_start` runs a Codex thread in a `project/<slug>/<id>-<title>` worktree |
| A project list that is always visible | Cursor | Coordinator chats are renamed to the project name and grouped in a "Projects" section of the Codex sidebar |
| A project panel beside the conversation | Cursor | The Project panel shows notes, agents, memory, and files for the chat it sits next to |
| A status board the user reads instead of opening every worker | Cursor (`notes.md`), Claude (Overview) | `notes.md` written by the coordinator, plus agent groups derived from state |
| Fixed agent states that drive an inbox | Claude | Needs you, Ready for review, Working, Idle, Resolved |
| Standing instructions sent to every worker | Claude (project instructions), Cursor (project context) | `INSTRUCTIONS.md`, up to 16,000 characters |
| Memory as small Markdown files behind an index | Claude (`MEMORY.md` + typed files), Cursor (Agent Store) | `MEMORY.md` index + `memory/*.md` with `name`, `description`, `type` |
| Separate status, durable context, and user preferences | Cursor | `notes.md`, project memory, and `user/preferences.md` with `workflows/` and `principles/` |
| Preferences saved only when stated, corrected, or repeated | Cursor | Skill rule; workers never write memory |
| Relayed or tool text is data, never approval | Claude | Skill rule, worker contract, and a digest label |
| Per-turn policy that survives compaction | Cursor (prompt re-sent every turn) | `project_context` digest ending with coordinator reminders |
| Worker reports with next actions | Cursor, Claude | Report contract: `PR:`, `## Report`, `## Next`, `## Needs you`, `## Remember` |
| PR follow-up: failing checks and review comments go back to the worker | Claude (auto-fix), Cursor (PR subscriptions) | The background service polls `gh` every 2 minutes and queues a follow-up |
| Setup pass that explores repositories before work starts | Claude (automatic setup) | Skill offers a read-only exploration agent on the first turn |
| Concurrency limit | Claude (daily thread cap) | At most 10 working agents (`PROJECTS_MAX_WORKING`) |

## Native to Codex

- **Coordinator chats are Codex threads.** Create Project starts the coordinator in a new Codex chat. On its first tool call the plugin reads the thread id Codex sends, links the thread to the project, names it after the project, and moves it into the "Projects" sidebar section.
- **Workers are Codex threads.** Agents run through `codex app-server`, so each one appears in Codex and opens with **Open chat**.
- **Plugin surfaces.** A Projects page in the sidebar with a New Project quick action, a Project panel beside any chat, and `@` mentions that attach a project's digest to a chat.
- **Local first.** Everything lives in `~/.projects-coordinator`. Agents run on this machine with the user's signed-in Codex CLI.

## Not built yet

| Feature | Inspiration | Notes |
| --- | --- | --- |
| Routines (scheduled coordinator or agent work) | Claude routines, Cursor timers | Needs a scheduler in the background service and a coordinator wake-up path |
| Event subscriptions (Slack, Linear) | Cursor | Same wake-up path as routines |
| Per-turn status card from a small model | Claude | Today the report summary line plays this role |
| Relevant-memory recall per turn | Claude | Today the brief inlines memory up to 24,000 characters |
| Memory consolidation pass | Claude | Today the skill asks the coordinator to merge and prune |
| Usage view per project and model | Claude | Agent records already store token counts |
| Side chats and mid-level coordinators | Cursor | |
| Mobile | Claude mobile, Cursor iOS | Needs a hosted MCP endpoint for the ChatGPT phone app |
| Shared projects and team memory | Claude, Cursor | |
