# Contributing

Thanks for helping improve Agent Desk. Bug reports, documentation, tests, and focused fixes are welcome.

## Before starting

Search existing issues and pull requests. Open an issue before a substantial behavior or architecture change so maintainers can discuss the scope. For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## Local setup

Use macOS, Node.js 22 or 24, npm, and Xcode Command Line Tools. Claude Code is needed for manual session testing.

```sh
git clone https://github.com/YOUR-USERNAME/agent-desk.git
cd agent-desk
npm ci
git switch -c fix/short-description
npm test
node bin/agent-desk.js open
```

Fork the repository if you do not have write access. Use a separate port and `AGENT_DESK_HOME` when testing alongside your usual desk.

## Code and tests

- Use JavaScript ES modules and follow nearby formatting.
- Keep changes focused and avoid unrelated refactoring.
- Test behavior with `node:test`; inject fakes for external processes where possible.
- Add regression coverage for behavior changes, especially authentication, session ownership, and process lifecycle.
- For browser changes, check session creation, terminal input, resizing, and reconnecting manually.
- Update user documentation when commands or configuration change.
- Keep credentials, local state, private paths, and terminal transcripts out of commits.

The source is in `src/`, the CLI in `bin/`, browser assets in `public/`, and tests in `test/`. No bundler is required.

## Pull requests

Target `main`. Explain the problem, resulting behavior, and validation performed. Include screenshots for visible changes with sensitive content removed. CI must pass and review conversations must be resolved before merging. Maintainers may ask for revisions; no response-time guarantee is offered.

Use a descriptive commit subject, preferably `fix:`, `feat:`, `docs:`, or `chore:`. Contributions are licensed under the repository's MIT license. By contributing, you confirm you have the right to submit the work.
