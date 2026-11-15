# Release preparation

The next candidate is `0.2.0-alpha.0` under the `alpha` tag; `0.1.0-alpha.3` remains the published alpha baseline. The package is MIT licensed and requires Node 22.13+. Legacy task contracts support `js-superagent@^0.14.0-alpha.1`; the new material contract additionally supports `^0.15.0-alpha.0` and requires version-1 material capabilities with schema 15. This is an early release, not a stable compatibility promise.

From a clean checkout:

```sh
npm ci --ignore-scripts
npm run release:prepare
```

This validates metadata and lock consistency, runs unit/integration/CLI tests, checks a tarball in a fresh consumer, and creates `release/js-longrun-0.2.0-alpha.0.tgz` and `release/manifest.json`. The manifest records SHA-512 integrity, source commit and dirty status. Commit and push changes, then regenerate the final candidate and require `sourceDirty: false`. CI checks minimum Node 22.13 and Node 24. No preparation command publishes anything.

The locked development dependency remains the published 0.14.0-alpha.1 compatibility baseline. Also run the new-contract matrix against the reviewed 0.15 SDK candidate (prefer its unpacked package entrypoint in a temporary consumer):

```sh
JS_LONGRUN_MATERIAL_SDK=/absolute/path/to/candidate/src/index.mjs \
  node --test test/material-sdk-integration.test.mjs
```

The fixture creates its own temporary `JS_SUPERAGENT_HOME`. It exercises frozen input despite later source edits, initial copy, same-contract workspace generation change, denied superagent artifact application, and longrun-only settlement with duplicate collection. The normal suite verifies rejection before round/budget mutation on unsupported hosts, unknown-submit ownership, missing evidence, out-of-scope outputs, review evidence and recoverable settlement. The candidate test skips when no SDK entrypoint is specified; a release must run it explicitly and record the exact tested package.

## Trusted publishing

All subsequent npm releases use GitHub trusted publishing, following the js-superagent release model. Do not run local npm publish or ask for per-release browser authorization. Do not fall back to long-lived npm tokens.

Dispatch `gh workflow run publish.yml --ref main -f version=0.2.0-alpha.0` only for an authorized release. The macOS preparation job runs release checks; the separate Linux job publishes the verified archive with OIDC and provenance. It validates the clean workflow SHA, package/lock versions and archive integrity. Existing identical versions are verified without republishing; uncertain registry responses never trigger blind retries.

The one-time npm binding is package `js-longrun`, repository `imjszhang/js-longrun`, workflow `publish.yml`, environment `npm`, with direct publish enabled. The GitHub environment allows only main, with no per-release reviewer or wait timer. Configuring this binding can require one-time account verification. Normal pushes do not publish.

After success, download the same run's `npm-release-candidate` artifact, verify registry integrity and provenance, create the annotated version tag at its source commit and a GitHub prerelease with archive and manifest, then verify a clean registry consumer. Preserve historical latest; publish prereleases to alpha.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Publication record

Version 0.1.0-alpha.2 was published on 2026-11-10 from clean commit `739711635fc714fa52f0c7d871cd5105b2ac68a0`. The annotated tag and GitHub prerelease contain the verified tarball and source manifest. Registry integrity matches the manifest; a fresh registry consumer passed CLI/SDK and offline settlement checks. npm assigned both `alpha` and `latest` on this first publication. It remains an alpha release; prefer the exact version.

Runtime management must also be tested against the consuming project’s exact superagent version (this candidate targets the verified 0.15.0-alpha.11 integration without changing it). Old peers lacking public health APIs report unavailable. Run service tests with isolated project/runtime homes; do not use production credentials or states. Stop old unmanaged watchers and timers before replacing their entrypoints. Real Feishu card submission and launchd timing require separate authorized deployment evidence; unit tests do not prove them.
