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
  A report about a dependency is still welcome if it is actually reachable from
  this project. See [Dependency updates](#dependency-updates) for what is
  automated and what is not.
- **Anything that would make the shipped page fetch, execute or leak something it
  should not.** The project's hard rule is no runtime fetches and no external
  assets (`tools/guard.mjs` enforces it), so a way around that is a real bug.

## Dependency updates

Two separate GitHub switches, and this policy has to say which one is on rather
than implying both are.

**Version updates are automated by a file.** `.github/dependabot.yml` asks
Dependabot for npm updates once a week, grouped so the three-package surface opens
at most one PR for `three` and one for the dev tooling per run. That file is
everything this repository controls on its own.

**Security alerts and Dependabot security updates are repository settings, not
files**, and only a maintainer can read or change them (Settings → Code security).
Measured on 2026-10-24:

```bash
gh api repos/iamlukethedev/The-Ninth-Vigil/vulnerability-alerts -i          # HTTP/2.0 404
gh api repos/iamlukethedev/The-Ninth-Vigil/automated-security-fixes -i      # HTTP/2.0 404
```

An enabled setting answers `204 No Content`; `404` is what a disabled setting
returns — but it is also what a token without admin rights gets, and the token
used here had pull-only access, so **this is not evidence either way**. A
maintainer should confirm both switches are on. If they are off, no automated
security PR will ever be opened, and the previous wording of this file was simply
false.

Current drift, measured on 2026-10-24 with `npm view <package> version` against
`package.json` and a clean `npm audit` (0 vulnerabilities): `three` 0.185.1
against 0.186.1, `vite` 8.1.6 declared against 8.3.5, `playwright` 1.62.0 against
1.64.1. `three` is the runtime and the one worth care — a minor bump can move
shader behaviour, which is why it arrives as its own PR and is checked against the
captures (`node tools/shot.mjs --all && node tools/sheet.mjs --analyze`) rather
than merged blind.

Gameplay exploits, save-state tampering and cheating in a single-player browser
game are not security issues; open a normal issue for those.
