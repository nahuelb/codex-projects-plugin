# Design notes

How Project Coordinator brings the ideas of Cursor Projects and Claude Code Projects into the Codex app. The wording, prompts, and code here are original.

## Shared model

| Pattern | Inspiration | Here |
| --- | --- | --- |
| One coordinator per project that plans and delegates but does no heavy work | Cursor, Claude | The project's coordinator is a normal Codex chat running the `$coordinator` skill |
| Workers are full agent sessions; parallel edits get their own worktree and branch | Cursor, Claude | Native Codex subagents from `spawn_agent`; `agent_prepare` records the task and, for parallel code changes, creates `<repo>/.worktrees/<id>-<title>` on `coordinator/<id>-<title>` |
| A project list that is always visible | Cursor | The Project Coordinator page lists every project beside its details, and the page's own chat runs the coordinator |
| A project panel beside the conversation | Cursor | The Coordinator panel shows notes, agents, memory, and files for the chat it sits next to |
| A status board the user reads instead of opening every worker | Cursor (`notes.md`), Claude (Overview) | `notes.md` written by the coordinator, plus agent groups derived from state |
| Fixed agent states that drive an inbox | Claude | Needs you, Ready for review, Working, Idle, Resolved |
| Standing instructions sent to every worker | Claude (project instructions), Cursor (project context) | `INSTRUCTIONS.md`, up to 16,000 characters |
| Memory as small Markdown files behind an index | Claude (`MEMORY.md` + typed files), Cursor (Agent Store) | `MEMORY.md` index + `memory/*.md` with `name`, `description`, `type` |
| Separate status, durable context, and user preferences | Cursor | `notes.md`, project memory, and `user/preferences.md` with `workflows/` and `principles/` |
| Preferences saved only when stated, corrected, or repeated | Cursor | Skill rule; workers never write memory |
| Relayed or tool text is data, never approval | Claude | Skill rule, worker contract, and a digest label |
| Per-turn policy that survives compaction | Cursor (prompt re-sent every turn) | `project_context` digest ending with coordinator reminders |
| Worker reports with next actions | Cursor, Claude | Report contract: `PR:`, `## Report`, `## Next`, `## Needs you`, `## Remember` |
| PR follow-up: failing checks and review comments go back to the worker | Claude (auto-fix), Cursor (PR subscriptions) | PRs in reports are checked with `gh` when the coordinator reads the project; events land in its inbox and it sends a `followup_task` |
| Project files the user reads and edits: plans, docs, notes, memory | Cursor (All Files, file tabs with Preview and Source) | All Files opens each file in a Codex file tab through `openai/files/open`; the coordinator writes `plans/` and `docs/` with `file_write` and links absolute paths |
| Setup pass that explores repositories before work starts | Claude (automatic setup) | Skill offers a read-only exploration agent on the first turn |
| Concurrency limit | Claude (daily thread cap) | Codex's own subagent limit; the skill asks for at most 6 at once |

## Native to Codex

- **Coordinator chats are Codex threads.** Create Coordinator opens a new Codex chat in the project's repository folder through `codex://threads/new?path=&prompt=`. On its first tool call the plugin reads the thread id Codex sends, links the thread to the project, and names it "Project Coordinator: <name>". A coordinator thread outside the repository folder is forked into it with `thread/fork` and the old thread is archived.
- **The page chat is not a coordinator.** Codex gives every global page a chat and no way to hide it or pick its thread, so the page sends it a hidden note that points to each project's own chat.
- **Workers are native subagents.** They appear in the coordinator chat's Subagents tab. The board follows them by reading the coordinator's session file, which records each child's thread id and agent path (`/root/<task_name>`), and each child's own session file for its activity and final report. Clicking an agent opens its thread.
- **Plugin surfaces.** A Project Coordinator page in the sidebar with a New Coordinator quick action, a Coordinator panel beside any chat, and `@` mentions that attach a project's digest to a chat.
- **Local first.** Everything lives in the Codex plugin data folder, `~/.codex/plugins/data/codex-projects-plugin-<marketplace>`. Agents run inside the Codex app on this machine.

## Not built yet

| Feature | Inspiration | Notes |
| --- | --- | --- |
| Routines (scheduled coordinator or agent work) | Claude routines, Cursor timers | Could build on Codex automations and a coordinator wake-up path |
| Event subscriptions (Slack, Linear) | Cursor | Same wake-up path as routines |
| Per-turn status card from a small model | Claude | Today the report summary line plays this role |
| Relevant-memory recall per turn | Claude | Today the brief inlines memory up to 24,000 characters |
| Memory consolidation pass | Claude | Today the skill asks the coordinator to merge and prune |
| Usage view per project and model | Claude | Subagent session files carry token counts |
| Side chats and mid-level coordinators | Cursor | |
| Mobile | Claude mobile, Cursor iOS | Needs a hosted MCP endpoint for the ChatGPT phone app |
| Shared projects and team memory | Claude, Cursor | |
