# Submitting to the OpenAI plugin directory

This page tracks what is ready for an official submission and what is still open. It follows OpenAI's [submission guide](https://developers.openai.com/plugins/deploy/submission), [package guide](https://developers.openai.com/plugins/build/plugins), [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines), and [submission errors](https://developers.openai.com/plugins/deploy/submission-errors).

## Blocker: the MCP server runs locally

Public submission expects a remote MCP server at an HTTPS URL. The dashboard connects to that URL, verifies the domain with a token at `/.well-known/openai-apps-challenge`, and scans the tools. The package guide says: "If your MCP server runs locally, deploy it to a public HTTPS URL. If you can't, reach out to your OpenAI contact for local MCP support."

Project Coordinator cannot move its server to a remote URL. It works with files, git worktrees, and the `codex` CLI on the user's computer. So the options are:

1. **Ask OpenAI for local MCP support.** Send them this page, the package, and the demo video. This is the only path to the official directory today.
2. **Publish through a Git marketplace in the meantime.** Codex can add a marketplace from a Git repository (`codex plugin marketplace add`). This needs no review, but users must add the marketplace themselves.

A skills-only submission is not an option: the skills depend on the MCP tools.

## What is ready

| Requirement | Where |
| --- | --- |
| Manifest with all listing fields | `.codex-plugin/plugin.json` |
| Display name (19 characters) and short description (26 characters) | `interface.displayName`, `interface.shortDescription` |
| Long description with limitations, no product comparisons | `interface.longDescription` |
| Website, support, privacy policy, and terms URLs (HTTPS) | `interface.*URL` |
| Square logos, 512 × 512 PNG, light and dark | `assets/logo.png`, `assets/logo-dark.png` (source SVGs next to them; `node scripts/render-icons.mjs` renders them) |
| Composer icons, 48 × 48 SVG, light and dark | `assets/icon.svg`, `assets/icon-dark.svg` |
| Screenshots under 5 MiB | `docs/images/coordinator-thread.png`, `docs/images/coordinator-page.png` |
| Brand colors with at least 2:1 contrast | `#4F46E5` on white, `#818CF8` on `#212121` |
| Five positive and three negative review cases | `extensions.com.openai.review.test_cases` |
| Release notes | `extensions.com.openai.publication.release_notes` |
| Privacy policy and terms | [docs/privacy.md](privacy.md), [docs/terms.md](terms.md) |
| Explicit `readOnlyHint`, `destructiveHint`, and `openWorldHint` on every tool | `src/server/tools.ts`, justifications below |
| One tool per operation, no generic action tools | `ui_agent_*` and `ui_project_*` tools |
| Tool results without session IDs, turn IDs, or timestamps for the model | UI data travels in `_meta`, which only the app reads |
| Package build and local checks | `npm run package` |

`npm run package` builds the plugin and checks the manifest, URLs, image sizes and formats, brand color contrast, skill front matter, review cases, tool annotations, file count, and possible secrets. Then it writes `release/codex-projects-plugin-<version>.zip` with only the files the plugin needs. `npm run package:check` runs the checks without writing the ZIP.

## Still to do before you submit

1. **Resolve the blocker** above with OpenAI.
2. **Merge this work to `main` and push.** The privacy policy and terms URLs point to `main` on GitHub.
3. **Record the demo video.** It must show the five positive and three negative cases. Upload it, then set `extensions.com.openai.review.demo_recording_url`.
4. **Choose the version.** The guidelines reject "trial or demo versions". Consider `1.0.0` and removing the "experimental" note from the README when the plugin is ready.
5. **Verify your developer identity** in the [organization settings](https://platform.openai.com/settings/organization/general). You need to be an owner or have the "Apps Management Write" permission.
6. **Check the screenshots.** They show your account initials in the Codex rail.
7. **Decide on the Git history items** noted earlier (a commit message that names a private project, the author email, and emoji commit messages).

## Dashboard steps

1. Run `npm run package`.
2. Open the [Plugins dashboard](https://platform.openai.com/plugins) and choose "Upload new or existing plugin".
3. Choose your verified developer identity and upload `release/codex-projects-plugin-<version>.zip`.
4. Fix any "Metadata & Skills" issues in the source, run `npm run package` again, and reupload.
5. Connect the MCP server, as OpenAI instructs for local servers.
6. In "Review information → Review details", check the imported test cases and add the video URL. No reviewer credentials are needed: the plugin has no accounts.
7. Enter the tool justifications below where the dashboard asks for them.
8. Choose "Submit for review" and complete the policy attestations. Only one review can be active at a time.

The reviewer needs macOS with the Codex desktop app, a signed-in `codex` CLI, Node.js 22.18 or later, and optionally the `gh` CLI for pull request follow-up. The test cases need no repository: agents then work in a scratch folder.

## Tool annotations and justifications

Model tools:

| Tool | Read only | Destructive | Open world | Justification |
| --- | --- | --- | --- | --- |
| `coordinator_home` | yes | no | no | Renders the Project Coordinator page from local project files. |
| `project_new` | yes | no | no | Opens the create form; nothing is saved until the user submits it. |
| `project_panel` | yes | no | no | Renders the Coordinator panel from local project files. |
| `project_open` | no | no | no | Shows a status card; links an unlinked chat to the project and names it. |
| `project_list` | yes | no | no | Lists local projects with agent counts. |
| `project_create` | no | no | no | Creates a new project folder on this computer; additive. |
| `project_update` | no | yes | no | Replaces project settings and can archive the project. |
| `project_context` | no | no | no | Reads the project digest; the first call links the chat to the project and names it. |
| `agent_start` | no | no | yes | Starts a Codex agent with network access that can push branches and open pull requests. |
| `agent_send` | no | no | yes | Sends a follow-up that makes an agent with network access work again. |
| `agent_read` | yes | no | no | Reads an agent's local record and its Codex transcript. |
| `agent_stop` | no | yes | no | Cancels an agent's running turn. |
| `agent_review` | no | no | no | Marks a report as seen; additive status change. |
| `agent_resolve` | no | yes | no | Closes an agent and can remove its clean worktree. |
| `notes_write` | no | yes | no | Replaces the whole notes.md file. |
| `file_write` | no | yes | no | Creates or replaces a Markdown file in the project folder. |
| `memory_write` | no | yes | no | Creates or replaces a memory file. |
| `memory_delete` | no | yes | no | Deletes a memory file. |
| `preferences_write` | no | yes | no | Replaces the preferences file. |
| `inbox_ack` | no | no | no | Moves handled inbox items to a done folder; additive. |

App-only tools (called by the plugin's UI, hidden from the model):

| Tool | Read only | Destructive | Open world | Justification |
| --- | --- | --- | --- | --- |
| `search_mentions` | yes | no | no | Finds local projects for @-mentions. |
| `ui_state` | no | no | no | Loads page data and remembers the selected project. |
| `ui_create_options` | yes | no | no | Lists Codex models and recent workspace folders. |
| `ui_coordinator` | no | yes | no | Finds the coordinator chat; can copy it into the repository folder and archive the old copy. |
| `ui_file` | yes | no | no | Reads one file from the project or user folder. |
| `ui_file_write` | no | yes | no | Replaces a file with the user's edits. |
| `ui_transcript` | yes | no | no | Reads an agent's recent Codex messages. |
| `ui_agent_review` | no | no | no | Marks a report as seen. |
| `ui_agent_reopen` | no | no | no | Reopens a resolved agent. |
| `ui_agent_stop` | no | yes | no | Cancels an agent's running turn. |
| `ui_agent_resolve` | no | yes | no | Closes an agent. |
| `ui_agent_send` | no | no | yes | Sends the user's message to an agent with network access. |
| `ui_project_create` | no | no | no | Creates a new project folder; additive. |
| `ui_project_update` | no | yes | no | Replaces project settings. |
| `ui_project_archive` | no | yes | no | Archives a project; its files stay. |

## Review risks to expect

- **Local execution.** Agents run with `workspace-write`, network access, and approval `never`. The listing, README, and terms say so. Reviewers may still ask for approval prompts.
- **Chat relocation.** `ui_coordinator` forks the coordinator chat into the repository folder and archives the old copy. It copies the user's own chat through Codex; the plugin does not read or store its contents. Reviewers may ask about this under the guideline that servers must not pull the chat log.
- **Destructive hints.** `notes_write`, `memory_write`, and `file_write` are marked destructive because they replace files. If Codex asks for approval on destructive tools, the coordinator's normal turns will need more approvals. (Not verified: Codex's approval behavior for these hints.)
