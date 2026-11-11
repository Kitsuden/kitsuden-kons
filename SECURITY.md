# Security policy

## Supported versions

kitsuden-kons is in beta. Only the latest release receives security fixes. Each kon has its
own version; a fix ships as a new version of the affected kon in the next release.

## Reporting a vulnerability

Please do not describe a vulnerability in a public issue, pull request or discussion. Report it
privately through
[GitHub private vulnerability reporting](https://github.com/Kitsuden/kitsuden-kons/security/advisories/new)
(the **Report a vulnerability** button under the repository's **Security** tab).

If that page is not available to you, open a
[new issue](https://github.com/Kitsuden/kitsuden-kons/issues/new) whose title is only
"Security contact requested" and that says nothing else: no kon, no route, no details. A
maintainer answers there with a private channel, and you send the report through it.

In the report, include what you can of:

- the affected kon, route or file, and the kon version or commit;
- the steps to reproduce it, ideally with a request or a failing test;
- what an attacker gains, and what access they need first.

You can expect an acknowledgement within a week. Once a fix is ready, it is released with an
advisory that credits you, unless you prefer otherwise.

## How the code is checked

Every push and pull request runs the same security scanners as Kitsuden: gitleaks
(secrets), OSV-Scanner (dependencies; fails on HIGH and CRITICAL), Checkov (workflows) and
CodeQL, beside each kon's tests, its migrations on a real Postgres and contract tests with
Schemathesis. See `.github/workflows/security.yml` and Kitsuden's
[security scanning](https://github.com/Kitsuden/kitsuden/blob/main/docs/security-scanning.md).

Kons from other authors are not checked here. Before installing one, read its code: a kon
runs inside your Kitsuden with access to your database.

## Scope

In scope: the kons in this repository (`kons/`), their migrations and row security, their
policies and scopes, and their admin views.

Out of scope: the Kitsuden core (API, auth, MCP server, admin panel, CLI). Report those to
[Kitsuden](https://github.com/Kitsuden/kitsuden/security/advisories/new). Also out of scope:
kons from other authors, and problems that need an operator to have turned off a documented
safeguard.
