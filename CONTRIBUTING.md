# Contributing

Use feature/fix branches and PRs targeting `develop`. Reviewed integration goes
to `main` through a separate PR; pushes and green checks are not releases.

Keep user documentation concise and current. README and wiki explain setup,
usage and limitations; release notes describe changes. Do not publish internal
work logs or debugging narratives in user guides.

The launcher uses semantic versioning (`major.minor.patch`), starting at `0.1.0`.
Use patch releases for compatible fixes and minor releases for new features;
before `1.0.0`, breaking changes may arrive in a minor release. Runtime builds
are versioned separately. Keep `package.json` and `package-lock.json` in sync.

```sh
npm ci
npm run build
npm run test:runtime-tools
npm run test:ci-tools
```

The launcher, backend and runtime are separate components built in their own
repositories: [nexus-launcher](https://github.com/domsvoboda/nexus-launcher),
[nexus-backend](https://github.com/domsvoboda/nexus-backend) and
[nexus-runtime](https://github.com/domsvoboda/nexus-runtime). Change runtime
libraries and patches in the runtime repository, not here.

Use disposable test directories, never a user's active game installation,
runtime, saves or Xodus checkout. Keep credentials, raw diagnostics, prefixes
and private work records outside Git. Include redacted reproduction steps,
versions and actual test results in bug reports and PRs.

Ordinary pushes and pull requests run source checks without distribution builds,
including on `main`. Launcher candidates require an explicit manual CI dispatch
on `main`; backend and runtime candidates are built in their own repositories.
Commit messages do not select the build mode. Promotion reuses the exact tested
files without rebuilding.
Stable publication requires explicit maintainer approval
for the exact tested artifact, with no rebuild after validation. The approval
record is [release-validation.json](.github/release-validation.json).

Detailed guides are prepared for the [wiki](https://github.com/domsvoboda/nexus-launcher/wiki)
(currently pending). Runtime build, source and license documentation lives in
the [runtime repository](https://github.com/domsvoboda/nexus-runtime).

For interface translations and Tolgee import/export, see
[Translating the launcher](docs/TRANSLATING.md).
