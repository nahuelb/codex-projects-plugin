# Privacy policy

Last updated: September 30, 2026

Project Coordinator is an open-source Codex plugin. It runs on your computer. The developer does not operate a server for it and does not receive any of your data.

## What the plugin stores

The plugin stores these files on your computer, in `~/.codex/plugins/data/codex-projects-plugin-<marketplace>/`:

- Project settings: name, goal, repository paths, icon, color, model, and standing instructions.
- Project notes, memory, plans, and documents that you or the coordinator write.
- Agent records: task, status, branch, reports, and follow-up messages.
- Your cross-project preferences.
- Git worktrees for agents, and a small log of the background service.

The plugin collects no analytics, telemetry, or usage data. It has no accounts, and it does not ask for passwords, API keys, or payment details.

## Who receives data

The plugin itself sends nothing over the network. It runs tools that are already on your computer, and these tools use your own accounts:

- **Codex.** Agents run through your signed-in `codex` CLI. The tasks, project instructions, memory, and code that agents work on go to OpenAI under your Codex account and OpenAI's terms and privacy policy.
- **GitHub CLI.** When an agent reports a pull request, the plugin runs your signed-in `gh` CLI to read that pull request's checks and reviews. GitHub handles these requests under your GitHub account.
- **Git.** Agents create branches and worktrees in your repositories. They push or open pull requests only when their task asks for it, using your git credentials.

## Purpose

The plugin uses this data only to coordinate your projects: to brief agents, show status in Codex, and keep notes and memory between conversations.

## Retention and control

Data stays on your computer until you delete it. You can:

- Edit or delete notes, memory, and files from the Coordinator panel or in the data folder.
- Archive a project from its settings. Its files stay until you delete them.
- Delete everything by removing the data folder above and the worktrees in it.
- Uninstall the plugin with `codex plugin remove codex-projects-plugin@<marketplace>`. Uninstalling does not delete the data folder.

## Children

The plugin is a developer tool and is not directed at children under 13.

## Changes

Changes to this policy are published in this file in the plugin's repository, with a new date above.

## Contact

Open an issue at https://github.com/nahuelb/codex-projects-plugin/issues.
