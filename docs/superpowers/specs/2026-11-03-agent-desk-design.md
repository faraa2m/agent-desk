# agent-desk: one browser tab for all Claude Code sessions

## Intent

The user runs many Claude Code sessions at once (11 across 4 Terminal windows on a typical day, 5 of
them on the same repo, my-project). With that many, sessions are indistinguishable: messages get
typed into the wrong session, and the same session gets asked to do unrelated work while another
duplicates it. Two existing options were tried and rejected:

- tmux: too many keys to learn.
- `claude agents`: only shows backgrounded sessions, and the user does not want to background
  everything.

agent-desk is a local web app, open in one browser tab, that starts and owns the user's Claude Code
sessions and shows them side by side: a list on the left, the selected session's real Claude Code
screen on the right. The single most important property is that the user can never be unsure which
session they are typing into.

The user also runs a `team-lead` agent (`~/.claude/agents/team-lead.md`, skill at
`~/.claude/skills/team-lead/`) that answers or triages questions from the other sessions. agent-desk
hosts team-lead as one of its sessions and must not break anything team-lead does.

## Success

The user opens all sessions, including team-lead, from agent-desk. They can tell at a glance which
sessions are waiting on them, click one, and answer it. They stop sending messages to the wrong
session.

## Goals

1. **Layout (chosen from mockups): list + session pane.**
   - Left: one entry per session. Entries that need the user are at the top, then working, then
     done/idle. team-lead is pinned above all of them.
   - Each entry shows: a status tag (NEEDS YOU in red / WORKING / DONE), the session name, a one-line
     current goal (what it was started to do), and repo + branch in small text. A colored left border
     per repo (sessions in the same repo share a color).
   - Right: the selected session's real, interactive Claude Code terminal UI, rendered in the browser.
     Everything that works in Terminal works here: permission prompts, AskUserQuestion choices, slash
     commands, Esc to interrupt, scrolling.
   - Above the terminal: a large colored header bar with the session name, repo, branch and goal, in
     that repo's color. The header is always visible while typing.
2. **Sessions are real, normal Claude Code sessions.** Each one is an interactive `claude -n <name>`
   process running in a pseudo-terminal owned by the agent-desk server. Because they are ordinary
   interactive sessions, they register in `~/.claude/sessions/`, write transcripts under
   `~/.claude/projects/`, appear in ListAgents, and receive SendMessage from team-lead, exactly as
   Terminal-launched sessions do today.
3. **Start sessions from the UI.** A "New session" button asks for name, folder, optional agent (for
   example `team-lead`), and the first prompt (the brief). The brief becomes the entry's goal line. The
   goal line can be edited later.
4. **team-lead launches into agent-desk.** `~/.claude/bin/launch-session` gets a mode that asks the
   running agent-desk server to start the session (local HTTP call), and that mode becomes the default
   when agent-desk is running. If agent-desk is not running, it falls back to today's `--bg`
   behaviour. Existing flags (`--window`, `--agent`, `--brief-file`) keep working. `--window` still
   means a Terminal window, because it is an explicit request. A new `--bg` flag forces today's
   background launch. When agent-desk is not running and the launcher falls back, it prints a clear
   warning that the session went to `claude agents` and not to agent-desk (my call). The brief is
   still saved under `~/.claude/team-lead/briefs/`.
5. **Knowing when a session needs you.** When a session starts waiting on the user:
   - it moves to the top of the list with the red NEEDS YOU tag,
   - the browser tab title shows the count, for example `(2) agent-desk`,
   - a desktop notification (browser Notification API) names the session and shows the first line of
     its question. Clicking the notification focuses the tab and selects that session.
   The user confirmed notifications are wanted.

   **Coordination with team-lead (user's decision).** A newly waiting question first shows a yellow
   "TEAM-LEAD HANDLING" tag, sorted just below NEEDS YOU, with no notification and no tab-title count.
   agent-desk reads team-lead's ledger (`~/.claude/team-lead/ledger.jsonl`) read-only, matching
   entries by `session_id` and `text_hash` (the scanner provides both):
   - team-lead answered it (the session moves on): the tag clears.
   - team-lead escalated it (category `escalate`, or `confidence: low`): it turns red NEEDS YOU and
     notifies.
   - no ledger entry for that question after about 2 minutes: it turns red NEEDS YOU and notifies.
   - team-lead is not running: questions go straight to NEEDS YOU.
   The team-lead session's own questions always go straight to NEEDS YOU. agent-desk never writes to
   the ledger.
6. **Sessions outlive the browser tab.** Closing or reloading the tab does not stop sessions; the
   server owns them. Reopening the tab shows them again, with the terminal's recent output restored.
7. **Stop a session** from its list entry (with a confirm step in the page, not a browser `confirm()`
   dialog).

## Non-goals

- Adopting sessions already running in Terminal windows. Only sessions started by agent-desk (or by
  `launch-session` through it) appear. The user agreed to start all sessions from agent-desk.
- A custom chat UI with rebuilt Yes/No buttons. The right pane is the real Claude Code screen
  (user's decision).
- Remote access, other machines, phones. Localhost only.
- Changing team-lead's triage logic, policy, ledger or answering rules.
- tmux in any form.

## Anti-goals (failure even if it works)

- Any situation where the session the user is typing into is not obvious from the screen.
- Anything the user has to learn keys for.
- A session behaving differently in agent-desk than in Terminal (a prompt that cannot be answered,
  broken colors, broken input).
- team-lead losing the ability to see or message sessions.

## How status is determined

Reuse the logic in `~/.claude/skills/team-lead/scripts/scan_sessions.py`: it reads each live session's
metadata in `~/.claude/sessions/` (status, cwd, sessionId, name) and the tail of its transcript, and
reports `waiting: true` when the session is not busy and has a pending tool call (permission prompt,
AskUserQuestion) or its last message asks a question. agent-desk maps this to:

- NEEDS YOU: `waiting` is true.
- WORKING: status is `busy`.
- DONE: everything else (idle, nothing asked).

The scanner only reports `waiting` for sessions that are not `busy`, and it is not known whether a
permission prompt or AskUserQuestion shows as `busy`. agent-desk owns each session's terminal, so it
may also detect waiting from the terminal output (for example a bell or notification escape
sequence, or a visible permission or choice prompt). If either the scanner or the terminal says the
session is waiting, the entry shows NEEDS YOU. agent-desk only reads and observes for this; it never
changes how sessions run. The scanner script is not modified, so team-lead's view stays as it is
(my call).

Sessions are matched between agent-desk's processes and the scanner's output by name and pid.
Polling interval is the builder's call (my call: every 3 seconds). The builder may call the scanner
script directly or port its logic; if it is ported, the scanner script stays the source of truth for
team-lead and must not change behaviour.

Branch comes from `git -C <cwd> rev-parse --abbrev-ref HEAD` (empty if not a repo). Repo name is the
basename of the git top-level, or of the cwd.

## Constraints

- macOS (Darwin), Node is available (v24 via fnm).
- Server binds to 127.0.0.1 only and requires a random per-install token on every HTTP and WebSocket
  request (it can type into sessions that have the user's permissions).
- Sessions run with the user's own Claude Code permissions and settings; agent-desk never passes
  permission-skipping flags.
- Heavy commands (`npm install`, tests, builds) go through the machine-wide queue described in the
  user's global CLAUDE.md (`~/.claude/bin/heavy-run`). Subagents must not run them in parallel.
- Never delete or overwrite any `.env` file.
- The user's global hooks and settings in `~/.claude/` are not edited by this project, except
  `~/.claude/bin/launch-session` (goal 4) and the team-lead SKILL.md's description of the launcher.

## Decisions made by me (not the user), open to override

- Local web app opened in a browser tab (user said "anything is fine").
- Stack: Node server with `node-pty` for the pseudo-terminals and `xterm.js` in the page; no frontend
  framework required. Plain WebSocket per attached terminal.
- Name and location: `~/Documents/dev/agent-desk` (user confirmed the location).
- Restore-on-reload: server keeps a scrollback buffer per session (size is the builder's call, about
  a few thousand lines) and replays it when a tab attaches.
- If the agent-desk server itself stops, its sessions stop with it. On next start the server lists
  the sessions it had (name, folder, goal, session id) and offers a one-click "resume" that runs
  `claude --resume <session-id> -n <name>` in a new pseudo-terminal.
- Started with a single command (for example `agent-desk` on PATH) that starts the server if needed
  and opens the tab.

## Starting at login (user's decision)

The server starts automatically when the user logs into their Mac, through a LaunchAgent plist in
`~/Library/LaunchAgents/` that runs the server and restarts it if it crashes. It does not open the
browser tab on its own; `agent-desk` (or a bookmark) opens the tab. Install and uninstall are
commands of the project (`agent-desk install-login`, `agent-desk uninstall-login`), and the plist is
the only file the project writes outside its own folder besides `launch-session` and the team-lead
SKILL.md text. The LaunchAgent must start the server with the same PATH and environment the user's
shell has (node from fnm, `claude` on PATH), since launchd provides a minimal environment.

## Left to the builder

- Exact visual styling, repo color palette (must be distinguishable across at least 6 repos).
- Scrollback size, poll interval, notification wording.
- Project layout, test approach, how the token is stored.
