# Security policy

## Supported versions

kitsuden-kons is in beta. Only the latest release receives security fixes. Each kon has its
own version; a fix ships as a new version of the affected kon in the next release.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub private vulnerability reporting](https://github.com/Kitsuden/kitsuden-kons/security/advisories/new).

Include what you can of:

- the affected kon, route or file, and the kon version or commit;
- the steps to reproduce it, ideally with a request or a failing test;
- what an attacker gains, and what access they need first.

You can expect an acknowledgement within a week. Once a fix is ready, it is released with an
advisory that credits you, unless you prefer otherwise.

## Scope

In scope: the kons in this repository (`kons/`), their migrations and row security, their
policies and scopes, and their admin views.

Out of scope: the Kitsuden core (API, auth, MCP server, admin panel, CLI). Report those to
[Kitsuden](https://github.com/Kitsuden/kitsuden/security/advisories/new). Also out of scope:
kons from other authors, and problems that need an operator to have turned off a documented
safeguard.
