# Security Policy

## Supported versions

Rocketpod is a starter kit: you copy it and the copy becomes your application. Security fixes land
on `main`; there are no maintained release lines. Apps built from the kit should track `main` for
fixes and pull them in with `/rp-upgrade` (`docs/CONCEPTS.md` §13).

## Reporting a vulnerability

Please **do not** open a public issue for anything exploitable. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/rocketflare-dev/rocketpod/security/advisories/new).
Include the subsystem (auth, tenancy, files, jobs, realtime, AI…), reproduction steps and the impact you
believe it has. You will get an acknowledgement, and a fix or a reasoned response, before anything is
made public.

Anything non-sensitive (a hardening suggestion, a missing header, a dependency advisory) is fine as
an [ordinary issue](https://github.com/rocketflare-dev/rocketpod/issues/new) titled "Security: ".
