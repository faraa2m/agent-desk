# Agent Desk

One browser tab to see, switch between, and answer your Claude Code sessions.

[![CI](https://github.com/faraa2m/agent-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/faraa2m/agent-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Agent Desk runs locally, hosts sessions in pseudo-terminals, and streams them to a browser with xterm.js. Session records persist across server restarts; running processes do not survive a server restart.

## Requirements

- macOS (browser opening and login startup use macOS tools)
- Node.js 22 or 24 and npm
- Claude Code installed, signed in, and available as `claude` on your PATH
- Xcode Command Line Tools (`xcode-select --install`) for the native `node-pty` dependency

## Get started

```sh
git clone https://github.com/faraa2m/agent-desk.git
cd agent-desk
npm ci
node bin/agent-desk.js open
```

The last command starts the server if needed and opens an authenticated browser tab at `http://127.0.0.1:47321`. Keep this checkout in place while using it.

Launch a session from another terminal:

```sh
node bin/agent-desk.js launch review /absolute/path/to/repo "Review the current changes"
node bin/agent-desk.js status
```

Use `--brief-file /path/to/brief.md` for a longer brief or `--agent NAME` for a configured Claude agent.

## Commands

| Command | Purpose |
| --- | --- |
| `open` (default) | Start the server if needed and open the desk |
| `serve` | Run the server in the foreground; Ctrl-C stops it |
| `launch <name> <dir> <brief...>` | Start a named Claude Code session |
| `status` | List sessions |
| `install-login` | Install and load a macOS LaunchAgent |
| `uninstall-login` | Unload and remove the LaunchAgent |

`install-login` also links the CLI at `~/.claude/bin/agent-desk`; add that directory to PATH to use `agent-desk` directly. Uninstalling the LaunchAgent leaves this symlink and local state in place.

## Configuration and local data

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_DESK_PORT` | `47321` | Local server and CLI port |
| `AGENT_DESK_HOME` | `~/.agent-desk` | Token, session records, and server log |
| `AGENT_DESK_TIMEOUT_MS` | `5000` | CLI request timeout |

Set the same port and home for the server and CLI. The login installer does not copy these overrides into its LaunchAgent.

Optional session discovery reads `~/.claude/sessions`, the team-lead scanner at `~/.claude/skills/team-lead/scripts/scan_sessions.py`, and `~/.claude/team-lead/ledger.jsonl`. These are local integrations, not dependencies supplied by this repository.

The desk can send input to local agent processes. Treat its authentication token and authenticated browser as access to those processes. Keep it on loopback; remote hosting and multi-user operation are outside the supported setup. Do not attach tokens, private prompts, or terminal transcripts to public issues.

## Development

```sh
npm ci
npm test
```

Tests use Node's built-in test runner, including a real pseudo-terminal smoke test. There is no frontend build step. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [SECURITY.md](SECURITY.md) for private vulnerability reports, and [SUPPORT.md](SUPPORT.md) for help.

Agent Desk is early-stage software. Install from source; npm publishing and a release automation workflow are not configured. Development happens on `main` through pull requests.

## License

[MIT](LICENSE), copyright Faraazuddin Mohammed.
