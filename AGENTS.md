# alice. Repository Instructions

These instructions apply to the entire repository.

## Product definition

alice. is the independent project intelligence layer for the AI tools users already use.

The product has two fundamental loops:

- Consumption: trusted project intelligence is assembled into task-specific context and delivered to the current AI through MCP.
- Capture: after an explicit user request, an AI submits evidence and candidate claims through MCP; only human review can change trusted state.

The central trust invariant is:

> Host-generated does not mean alice.-verified.

No AI tool call may directly mutate trusted state.

## Milestone workflow

Implementation work is organized by `MILESTONES.md`.

1. Every milestone begins in a new Codex chat named `MilestoneXX - <short description>`.
2. At the start of the chat, read `MILESTONES.md`, inspect Git branch/history, and read relevant decision documents.
3. Confirm the previous milestone is complete before starting another.
4. Create a dedicated branch named `milestone-XX-<short-description>` before implementation.
5. Never implement more than one milestone on the same branch.
6. Break the milestone into verified tasks. Commit after each fully completed task.
7. Update `MILESTONES.md` continuously, including task checkboxes, status, decisions, unresolved issues, and handoff notes.
8. Record durable decisions in the relevant file under `docs/`; do not leave them only in chat.
9. A milestone is complete only when its tasks and success criteria are verified, documentation is current, checks pass, and the working tree is clean unless an exception is documented.
10. Stop after completing a milestone. The next milestone must begin in a new chat.

Commit messages must describe the completed task. Do not commit partially completed work unless a documented technical reason requires it.

## Start-of-milestone checklist

- Read `MILESTONES.md`.
- Inspect `git status`, the current branch, and recent commits.
- Read relevant files in `docs/`.
- Confirm the previous milestone is complete.
- Create or switch to the milestone branch.
- Mark the milestone `In Progress` and commit that update with the first completed task when appropriate.

## Completion checklist

- All milestone tasks are complete.
- Each completed task has an appropriate commit.
- Relevant tests, typechecks, and builds pass.
- `MILESTONES.md` is current.
- Architectural and product decisions are documented.
- Deferred work and known issues are documented.
- Success criteria are verified.
- The working tree is clean unless explicitly documented.

## Core convention

> Chat is temporary. Git and repository documentation are persistent.

