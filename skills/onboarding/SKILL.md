---
name: coordinator-setup
description: Set up Project Coordinator after installation. Create the first project and start its coordinator chat.
---

# Project Coordinator setup

Help the user create their first project in a few short steps.

1. Call `project_list`. If projects exist, tell the user to open **Project Coordinator** in the sidebar to see them, and stop.
2. Ask for a project name and the local repository it covers. Accept an absolute path. If the user is in a repository right now, offer its path.
3. Call `project_create` with the name and the repository as `workspace`. This chat becomes the project's coordinator.
4. Say: "Open **Project Coordinator** in the sidebar to see all your projects, and open the **Project** panel beside this chat to follow notes, agents, and memory." Then ask for the first piece of work.

Do not start agents during setup.
