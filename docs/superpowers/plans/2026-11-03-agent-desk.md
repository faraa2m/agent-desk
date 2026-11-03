# agent-desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app, open in one browser tab, that starts and owns the user's Claude Code sessions and shows a status-sorted session list beside each session's real terminal.

**Architecture:** A Node server owns one pseudo-terminal (`node-pty`) per interactive `claude -n <name>` process, keeps a scrollback buffer per session, and streams terminals to the page over WebSockets (`xterm.js`). A 3-second poller combines the server's own records, each session's `~/.claude/sessions/<pid>.json`, the team-lead scanner's output, a terminal-output prompt detector and team-lead's ledger into one status per session, and pushes that snapshot to the page. A CLI (`agent-desk`) opens the tab, serves, launches sessions for `launch-session`, and installs a login LaunchAgent.

**Tech Stack:** Node 24 (ESM, `node:test`), `node-pty`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`; plain HTML/CSS/JS page, no framework.

**Spec:** `docs/superpowers/specs/2026-11-03-agent-desk-design.md`

## Global Constraints

- macOS only; Node from fnm (`node -v` is v24).
- Server binds `127.0.0.1` only; every HTTP and WebSocket request except `GET /api/health` needs the per-install token.
- Sessions are spawned as `claude -n <name> [--agent <a>] [<brief>]` with an argv array, never through a shell, and never with permission-skipping flags.
- `npm install` and `npm test` go through `~/.claude/bin/heavy-run` (the global hook wraps them automatically). One at a time; subagents never run them in parallel. Use a 10-minute timeout.
- Never delete or overwrite any `.env` file.
- Outside this repo, only these files are written: `~/.claude/bin/launch-session`, `~/.claude/skills/team-lead/SKILL.md` (launcher text only), the symlink `~/.claude/bin/agent-desk`, and `~/Library/LaunchAgents/com.agent-desk.server.plist`.
- `~/.claude/skills/team-lead/scripts/scan_sessions.py` and `~/.claude/team-lead/ledger.jsonl` are read only.
- Status names (used everywhere): `needs-you`, `team-lead`, `working`, `done`, `ended`. UI labels: NEEDS YOU (red), TEAM-LEAD HANDLING (yellow), WORKING (blue), DONE (grey), ENDED (grey, with Resume).
- Grace period before an unhandled question becomes `needs-you`: `GRACE_MS = 120000`. Poll interval: `3000` ms.
- State lives in `AGENT_DESK_HOME` (default `~/.agent-desk`): `token`, `sessions.json`, `server.log`. Port `AGENT_DESK_PORT` (default `47321`).
- Comments describe the code as it stands; no change narration.

## Review Focus

1. A brief or name containing quotes, `$()`, newlines or spaces must reach `claude` verbatim and run nothing (Task 5 test).
2. A session that exits on its own (`/exit`, crash) must show ENDED with Resume, and not vanish or stay WORKING (Task 5 test).
3. A request with a missing/wrong token, or with a `Host`/`Origin` that is not `127.0.0.1:<port>`/`localhost:<port>`, must be rejected; a web page on another site must not be able to type into sessions (Task 6 test).
4. The same session open in two tabs: both see output, either can type, nothing crashes when one closes (Task 6 test).
5. Missing or failing scanner script, missing or malformed ledger, missing session meta file: the app keeps working and treats team-lead as not running (Tasks 3 and 4 tests).

---

### Task 1: Project scaffold and pure helpers

**Files:**
- Create: `package.json`, `src/config.js`, `src/repo-info.js`, `src/scrollback.js`
- Test: `test/repo-info.test.js`, `test/scrollback.test.js`

**Interfaces:**
- Produces:
  - `config.js`: `export const PORT`, `STATE_DIR`, `TOKEN_FILE`, `SESSIONS_FILE`, `LOG_FILE`, `CLAUDE_SESSIONS_DIR` (`~/.claude/sessions`), `SCANNER_SCRIPT` (`~/.claude/skills/team-lead/scripts/scan_sessions.py`), `LEDGER_FILE` (`~/.claude/team-lead/ledger.jsonl`), `GRACE_MS = 120000`, `POLL_MS = 3000`, `expandHome(p: string): string`.
  - `repo-info.js`: `repoInfo(cwd: string): {repo: string, branch: string}` (repo = basename of `git rev-parse --show-toplevel`, else basename of cwd; branch = `git rev-parse --abbrev-ref HEAD`, else `""`; never throws; cached 10 s per cwd). `colorFor(repo: string): string` — stable pick from an 8-color palette by string hash.
  - `scrollback.js`: `class Scrollback { constructor(maxBytes = 1_000_000); append(chunk: string): void; toString(): string }` — drops oldest data past `maxBytes`.

- [ ] **Step 1:** `git init` is done. Create `package.json`: `"type": "module"`, `"bin": {"agent-desk": "bin/agent-desk.js"}`, `"scripts": {"test": "node --test"}`, dependencies `node-pty`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`. Run `npm install` (queued, 10-min timeout). If `node-pty` fails to build, install `@homebridge/node-pty-prebuilt-multiarch` instead and import it under the same local name in Task 5.
- [ ] **Step 2: Write failing tests**
  - `colorFor("my-project") === colorFor("my-project")`; the 8 palette colors are distinct; `colorFor` returns a `#rrggbb` string.
  - `repoInfo` on a temp dir with `git init` + a commit on branch `feat/x` → `{repo: <dirname>, branch: "feat/x"}`; on a plain temp dir → `{repo: <dirname>, branch: ""}`; on a missing dir → does not throw.
  - `Scrollback(10)`: append `"abcdef"`, `"ghijkl"` → `toString() === "cdefghijkl"`.
- [ ] **Step 3:** Run `npm test` → FAIL (modules missing).
- [ ] **Step 4:** Implement the three modules (`execFileSync` for git with `stdio: 'pipe'`).
- [ ] **Step 5:** `npm test` → PASS. Commit `feat(core): scaffold and helpers` (include `package-lock.json`).

### Task 2: Terminal prompt detector

**Files:**
- Create: `src/screen-watcher.js`
- Test: `test/screen-watcher.test.js`

**Interfaces:**
- Produces: `stripAnsi(s: string): string`; `detectPrompt(text: string): boolean`; `class ScreenWatcher { feed(chunk: string): void; userInput(): void; get waiting(): boolean }`.

`waiting` is `bellPending || detectPrompt(tail)`. `tail` is the last 4096 characters of ANSI-stripped output. `bellPending` is set by a BEL (`\x07`) outside an OSC sequence, or an OSC 9 / OSC 777 notification (`\x1b]9;…`, `\x1b]777;notify;…`). `userInput()` clears both `bellPending` and `tail`. Prompt patterns (verify against real Claude Code in Task 10 and adjust there): `/Do you want to (proceed|make this edit|create|run|allow)/i`, `/Enter to select/`, `/❯\s*1\.\s+Yes/`.

- [ ] **Step 1: Write failing tests:** `stripAnsi("\x1b[31mred\x1b[0m") === "red"`; feeding `"Do you want to proceed?\r\n❯ 1. Yes"` with color codes mixed in → `waiting === true`; then `userInput()` → `false`; feeding `"\x1b]9;Claude needs your input\x07"` → `true`; feeding `"\x1b]0;title\x07"` (window title, a BEL terminating OSC 0) → `false`; ordinary output `"Running tests…"` → `false`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(status): terminal prompt detector`.

### Task 3: Status rules and ledger reader

**Files:**
- Create: `src/status.js`, `src/ledger.js`
- Test: `test/status.test.js`, `test/ledger.test.js`

**Interfaces:**
- Produces:
  - `readLedger(path: string): object[]` — parsed JSON lines; missing file or bad lines skipped, never throws.
  - `findEntry(entries, sessionId: string, textHash: string|null): object|null` — last entry with that `session_id` and `text_hash`; `null` when `textHash` is null.
  - `computeStatus(i): Status` where `i = {exited, busy, scanWaiting, screenWaiting, isTeamLeadSession, teamLeadRunning, ledgerEntry, waitingSince, now}`.
  - `sortViews(views: SessionView[]): SessionView[]` — `pinned` first, then status order `needs-you, team-lead, working, done, ended`, then `waitingSince` ascending (oldest question first), then name.
  - `class WaitTracker { update(id: string, waiting: boolean, key: string, now: number): number|null }` — returns the time this wait began; resets when `key` changes; returns `null` and forgets when not waiting.

`computeStatus` rules, in order:
1. `exited` → `ended`.
2. `waiting = scanWaiting || screenWaiting`. Not waiting → `busy ? 'working' : 'done'`.
3. `isTeamLeadSession || !teamLeadRunning` → `needs-you`.
4. `ledgerEntry` present → `team-lead` if `sent === true && category !== 'escalate' && confidence !== 'low'`, else `needs-you`.
5. No entry → `now - waitingSince < GRACE_MS ? 'team-lead' : 'needs-you'`.

- [ ] **Step 1: Write failing tests**, one per rule plus: escalated entry (`category: 'escalate'`) → `needs-you`; low-confidence → `needs-you`; unsent shadow proposal (`sent: false`, `category: 'continue-obvious'`) → `needs-you`; no entry at `waitingSince = now - 119000` → `team-lead`, at `now - 121000` → `needs-you`; screen-only waiting while `busy` → not `working`. `readLedger` on a missing path → `[]`; on a file with one bad line between two good ones → 2 entries. `findEntry` picks the last of two matches. `WaitTracker` keeps the start time across same-key updates and resets on a new key. `sortViews` puts a pinned `done` view above a `needs-you` one.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(status): status rules and ledger reader`.

### Task 4: Readers for Claude session metadata and the scanner

**Files:**
- Create: `src/claude-meta.js`, `src/scanner.js`
- Test: `test/claude-meta.test.js`, `test/scanner.test.js`

**Interfaces:**
- Produces:
  - `readSessionMeta(pid: number, dir = CLAUDE_SESSIONS_DIR): {sessionId, status, name, cwd}|null` — reads `<dir>/<pid>.json`; null on missing or bad JSON.
  - `parseScanOutput(stdout: string): ScanEntry[]` — one JSON object per line, bad lines skipped. `ScanEntry` fields used: `name, session_id, status, waiting, text_hash, question, last_text`.
  - `runScanner(script = SCANNER_SCRIPT, timeoutMs = 10000): Promise<ScanEntry[]>` — `execFile('python3', ['-I', script])`; resolves `[]` on any error (logs once per distinct error message).

- [ ] **Step 1: Write failing tests:** meta read from a temp dir fixture `123.json` → fields; missing pid → `null`; bad JSON → `null`. `parseScanOutput` with two good lines and one garbage line → 2 entries. `runScanner('/nonexistent.py')` → `[]`. `runScanner` on a temp script that prints `{"name":"a","waiting":true}` → one entry.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(status): session metadata and scanner readers`.

### Task 5: Session manager

**Files:**
- Create: `src/session-manager.js`
- Test: `test/session-manager.test.js` (uses a fake pty)

**Interfaces:**
- Consumes: `Scrollback` (Task 1), `ScreenWatcher` (Task 2), `expandHome` (Task 1).
- Produces: `class SessionManager extends EventEmitter` (emits `'change'`):
  - `constructor({stateFile, spawn, claudeBin = 'claude'})` — `spawn(file, args, {cwd, cols, rows, env, name})` returns a pty-like `{pid, onData(cb), onExit(cb), write(s), resize(c, r), kill(sig)}` (the `node-pty` `spawn` signature). On construct, loads `stateFile`; records without `endedAt` get `endedAt = now` (they died with the previous server).
  - `start({name, cwd, agent = null, brief = ''}): SessionRecord` — throws `Error` with `code = 'NAME_TAKEN'` when a live session has that name, `'NO_DIR'` when `expandHome(cwd)` is not a directory, `'BAD_NAME'` when name is empty. Spawns `claudeBin` with args `['-n', name, ...(agent ? ['--agent', agent] : []), ...(brief ? [brief] : [])]`, `cols 120, rows 40`, env = `process.env` plus `TERM=xterm-256color`, `COLORTERM=truecolor`. `goal` = first non-empty line of `brief`, cut to 120 chars.
  - `resume(id): SessionRecord` — only for an ended record with `claudeSessionId`; spawns `['--resume', claudeSessionId, '-n', name]` in the same record (clears `endedAt`).
  - `stop(id)`, `dismiss(id)` (ended records only), `setGoal(id, goal)`, `setClaudeSessionId(id, sid)`.
  - `write(id, data)` (also calls the watcher's `userInput()`), `resize(id, cols, rows)`.
  - `attach(id, onData): {scrollback: string, detach(): void}` — any number of attachments per session.
  - `get(id)`, `list(): SessionRecord[]`, `live(id): {pid, screenWaiting}|null`.
  - `SessionRecord = {id, name, cwd, agent, goal, claudeSessionId, pid, createdAt, endedAt, exitCode}`; `id` is 8 random hex chars. Every change persists `list()` to `stateFile` (write to temp file, then rename).

- [ ] **Step 1: Write failing tests** with a fake spawn that records `(file, args, opts)` and lets the test emit data and exit:
  - start passes args exactly; a brief of `` it's "$(rm -rf ~)"\nline2 `` arrives as one argv element, unchanged.
  - duplicate live name → `NAME_TAKEN`; missing dir → `NO_DIR`; `~/` paths expand.
  - data reaches two attached listeners and the scrollback; a late `attach` gets earlier output in `scrollback`.
  - fake exit → record has `endedAt` and `exitCode`, emits `'change'`; `dismiss` then removes it; `dismiss` on a live record throws.
  - a new `SessionManager` on the same `stateFile` sees the old records as ended; `resume` spawns `--resume <sid> -n <name>`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(sessions): pty session manager`.

### Task 6: Snapshot poller and server

**Files:**
- Create: `src/token.js`, `src/snapshot.js`, `src/server.js`
- Test: `test/snapshot.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `loadOrCreateToken(file = TOKEN_FILE): string` — 32 random bytes hex, file mode `0600`.
  - `buildSnapshot({records, liveFor, metaFor, scan, ledger, repoInfoFor, waitTracker, now}): SessionView[]` (sorted with `sortViews`). For each record: meta from `metaFor(pid)`; scan entry matched by `meta.sessionId === entry.session_id`; `teamLeadRunning` = any scan entry named `team-lead` or any live record with `agent === 'team-lead'` or `name === 'team-lead'`; wait key = scan `text_hash` when scan says waiting, else `'screen'`. Calls back `onSessionId(id, sid)` so the manager stores `claudeSessionId`.
  - `SessionView = {id, name, cwd, repo, branch, color, goal, status, question, pinned, waitingSince, endedAt, resumable}`; `question` = first line of the scan `question` (≤160 chars) or `"Waiting for your input"` when screen-only; `pinned` = team-lead session.
  - `startPoller({manager, intervalMs = POLL_MS, onSnapshot}): {stop(), current(): SessionView[]}`.
  - `createServer({manager, poller, token, port = PORT}): http.Server` listening on `127.0.0.1`.

Auth: accept the token from `?key=` (then set cookie `ad_key`, `HttpOnly; SameSite=Strict; Path=/`), the `ad_key` cookie, or `Authorization: Bearer <token>`; compare with `crypto.timingSafeEqual`. Reject (403) any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, and any WebSocket upgrade whose `Origin` is present and not `http://127.0.0.1:<port>` or `http://localhost:<port>`. Missing/wrong token → 401.

Routes: `GET /` → `public/index.html`; `GET /static/*` → `public/`; `GET /vendor/*` → the `@xterm/xterm` css/js and `@xterm/addon-fit` js from `node_modules`; `GET /api/health` → `{ok: true}` (no token); `GET /api/sessions` → `SessionView[]`; `POST /api/sessions` `{name, cwd, agent?, brief?}` → 201 record, 400 `{error}` for `NO_DIR`/`BAD_NAME`, 409 for `NAME_TAKEN`; `POST /api/sessions/:id/{stop|resume|dismiss}`; `PATCH /api/sessions/:id` `{goal}`. WebSocket `/ws/events`: on connect and on every snapshot, sends `{type: 'snapshot', sessions}`. WebSocket `/ws/term/:id`: on connect sends the scrollback, then live output, as text frames; accepts JSON `{type: 'input', data}` and `{type: 'resize', cols, rows}`; detaches on close.

- [ ] **Step 1: Write failing tests**
  - `buildSnapshot` with fixtures: a waiting scan entry, no ledger, no team-lead running → `needs-you`; same with a `team-lead` scan entry and a fresh wait → `team-lead`; repo/branch/color filled from a stub `repoInfoFor`.
  - Server with a fake-spawn `SessionManager` on a random port: `GET /api/sessions` without token → 401; with `?key=` → 200 and a `Set-Cookie`; `Host: evil.example:<port>` with a valid token → 403; WS upgrade with `Origin: http://evil.example` → rejected; `POST /api/sessions` → 201, then two `/ws/term/:id` clients both receive emitted fake output, input from one reaches the fake pty's `write`, closing one leaves the other working; `GET /api/health` without token → 200.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement (`ws` with `noServer: true` on the `upgrade` event).
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(server): snapshot poller, API and terminal sockets`.

### Task 7: Web page

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: the HTTP and WebSocket API from Task 6; `/vendor/xterm.js`, `/vendor/xterm.css`, `/vendor/addon-fit.js`.

Behaviour (layout A from the spec):
- Left column (about 320 px): one entry per `SessionView` in server order: status tag, bold name, goal line, `repo · branch` small, a 4 px left border in `color`. NEEDS YOU entries also show `question`. ENDED entries show Resume and Dismiss buttons. A "＋ New session" button at the top.
- Right: a header bar in the session's `color` with name (large), `repo · branch`, goal (click to edit, saved with `PATCH`), and a Stop button. Stop asks for confirmation inline in the header ("Stop <name>? Yes / No"), never `window.confirm`. Under it, one `xterm.js` Terminal per session (created on first selection, kept and hidden when switching so scrollback stays), sized with the fit addon on select and window resize, sending `resize`.
- New session form (inline panel, not a dialog): name, folder (text, `~` allowed), agent (optional), first prompt (textarea). Errors from the API shown under the form.
- Tab title: `(<n>) agent-desk` when `n` sessions are `needs-you`, else `agent-desk`.
- Desktop notifications: request permission on the first click anywhere on the page. When a session's status changes to `needs-you` (not on first load), show `new Notification(name, {body: question, tag: id})`; on click, `window.focus()` and select that session.
- Selection persists in `location.hash` (`#<id>`) so reload keeps it.

- [ ] **Step 1:** Implement the three files.
- [ ] **Step 2:** `node --check public/app.js` passes. Visual checks happen in Task 10, once the CLI from Task 8 can start the server.
- [ ] **Step 3:** Commit `feat(ui): session list and terminal page`.

### Task 8: CLI and login LaunchAgent

**Files:**
- Create: `bin/agent-desk.js`, `src/launchd.js`, `src/serve.js`
- Test: `test/launchd.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `createServer`, `SessionManager`, `startPoller`, `loadOrCreateToken`.
- Produces:
  - `serve.js`: `async function serve(): Promise<void>` — wires real `node-pty` spawn, manager, poller and server; logs to `LOG_FILE`.
  - `launchd.js`: `plistFor({nodePath, scriptPath, pathEnv, home, logPath}): string` (label `com.agent-desk.server`, `ProgramArguments [nodePath, scriptPath, 'serve']`, `RunAtLoad true`, `KeepAlive true`, `EnvironmentVariables {PATH, HOME}`, stdout/stderr to `logPath`); `installLogin()` writes `~/Library/LaunchAgents/com.agent-desk.server.plist` and runs `launchctl bootstrap gui/<uid> <plist>` (bootout first if loaded); `uninstallLogin()` boots out and deletes it.
  - CLI `bin/agent-desk.js` (shebang `#!/usr/bin/env node`):
    - no args or `open`: if `/api/health` fails, start `serve` detached (stdio to `LOG_FILE`), poll health up to 5 s; then `open "http://127.0.0.1:<port>/?key=<token>"`.
    - `serve`: run `serve()`.
    - `launch <name> <dir> [--agent <a>] (--brief-file <path> | <brief...>)`: `POST /api/sessions` with the bearer token; prints `launched '<name>' in agent-desk`; exit 0. Server unreachable → exit 3 with no output. API error → message on stderr, exit 1.
    - `status`: prints one line per session: `STATUS  name  repo·branch  goal`.
    - `install-login` / `uninstall-login`. `install-login` uses `process.execPath` and the current `PATH`, and also creates the symlink `~/.claude/bin/agent-desk` → `bin/agent-desk.js` (skip if it already points there).

- [ ] **Step 1: Write failing tests:** `plistFor` output contains the label, `<string>serve</string>`, the given PATH and `<key>KeepAlive</key><true/>`, and parses with `plutil -lint -` (pipe it in). CLI: `launch` against a closed port exits 3; `launch` against a test server built from Task 6 parts with fake spawn exits 0 and the fake spawn saw `--brief-file` contents as the brief.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement; `chmod +x bin/agent-desk.js`.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(cli): agent-desk command and login agent`.

### Task 9: team-lead launcher integration

**Files:**
- Modify: `~/.claude/bin/launch-session`
- Modify: `~/.claude/skills/team-lead/SKILL.md` (the Launcher line in its paths list and the dispatch section only)

Not in this repo; commit nothing for these files. Show the user the diff before writing either file.

Behaviour of `launch-session` after the change:
- Flags: `--window` (Terminal window, unchanged), new `--bg` (today's `claude --bg`, unchanged output), `--agent`, `--brief-file`.
- Default (neither flag): save the brief as today, then run `agent-desk launch "$name" "$dir" [--agent "$agent"] --brief-file "$brief"`. Exit 0 → print its output and the brief path. Exit 3, or `agent-desk` not on PATH → run the `--bg` path and print `WARNING: agent-desk is not running, so '<name>' started in the background. Open it with: claude agents`. Any other non-zero exit → print the error and exit non-zero without launching.
- Header comment updated to describe these three modes.
- SKILL.md: Launcher line says sessions open in agent-desk (the browser tab started with `agent-desk`) by default, `--bg` for `claude agents`, `--window` for a Terminal window; dispatch section tells the user the session is in agent-desk.

- [ ] **Step 1:** With agent-desk stopped, run `launch-session ad-test-1 /tmp "say hi and stop"` → prints the WARNING and the session appears in `claude agents --json`; stop it.
- [ ] **Step 2:** Make the edit (after the user sees the diff).
- [ ] **Step 3:** With agent-desk running, `launch-session ad-test-2 /tmp "say hi and stop"` → prints `launched 'ad-test-2' in agent-desk`; `agent-desk status` lists it. `launch-session ad-test-3 /tmp --window …` is not run (it opens a window); check by reading the script that `--window` still takes the old branch.
- [ ] **Step 4:** Stop and dismiss the test sessions.

### Task 10: End-to-end verification with real Claude sessions

No new files unless fixes are needed (fixes get their own commits with tests where the code is testable).

- [ ] **Step 1:** `node bin/agent-desk.js install-login`; `launchctl print gui/$(id -u)/com.agent-desk.server` shows it running; `curl -s 127.0.0.1:47321/api/health` → `{"ok":true}`.
- [ ] **Step 2:** `agent-desk` opens the tab. In Chrome (claude-in-chrome tools), create session `ad-e2e` in `/tmp` with prompt `Create the file /tmp/ad-e2e.txt containing hi`. Check: the real Claude UI renders with colors; the permission prompt appears; the entry turns NEEDS YOU (red, with the scanner off this relies on the screen watcher — if not, adjust Task 2 patterns from the actual screen text and add a test with that text); the tab title shows `(1)`; answering in the terminal works; the entry goes WORKING then DONE.
- [ ] **Step 3:** Start a `team-lead` session from the form (agent `team-lead`, name `team-lead`): it is pinned at the top. From another Claude session, run `ListAgents` and check `ad-e2e` is listed and can receive a `SendMessage`.
- [ ] **Step 4:** Reload the tab: sessions and scrollback come back. `launchctl kickstart -k gui/$(id -u)/com.agent-desk.server`: entries show ENDED with Resume; Resume brings `ad-e2e` back with its conversation.
- [ ] **Step 5:** Notification: switch to another session, make `ad-e2e` ask a question, confirm a desktop notification appears and clicking it selects `ad-e2e`.
- [ ] **Step 6:** Stop and dismiss test sessions; delete `/tmp/ad-e2e.txt`. Run `npm test` → PASS. Commit any fixes.
