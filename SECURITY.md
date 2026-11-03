# Security policy

## Supported versions

Security fixes currently target the latest code on `main`. No older release line is maintained.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/faraa2m/agent-desk/security/advisories/new). Include the affected commit, reproduction steps, impact, and a minimal example with credentials and private terminal content removed. Do not open a public issue for an unpatched vulnerability.

If private reporting is unavailable, email mohdfaraaz1@gmail.com with the subject "Agent Desk security report". Allow time for investigation and a coordinated fix before public disclosure. There is no guaranteed response time or bounty program.

## Trust boundary

Agent Desk is a local, single-user tool with access to agent processes. Its token grants access to session operations and terminal input. Keep it private, keep the server on loopback, and review code before running contributions locally.
