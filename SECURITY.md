# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/iamlukethedev/The-Ninth-Vigil/security/advisories/new)
("Report a vulnerability" on the Security tab).

Include what you found, how to reproduce it, and what an attacker could do with it.
You should get a first response within a week.

## What is in scope

The Ninth Vigil is a static browser game. It has no server, no accounts, no network
calls at runtime and no stored user data, so the realistic attack surface is small:

- **The build and CI pipeline** — `.github/workflows/`, `tools/`, and anything that
  runs with repository permissions.
- **Dependencies** — `three`, `vite` and `playwright`, and what they pull in.
  Dependabot alerts and security updates are enabled; a report about a dependency
  is still welcome if it is actually reachable from this project.
- **Anything that would make the shipped page fetch, execute or leak something it
  should not.** The project's hard rule is no runtime fetches and no external
  assets (`tools/guard.mjs` enforces it), so a way around that is a real bug.

Gameplay exploits, save-state tampering and cheating in a single-player browser
game are not security issues; open a normal issue for those.
