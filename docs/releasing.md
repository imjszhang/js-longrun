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

Before an explicitly authorized publication, check CI, `npm whoami`, name/version availability and the manifest. Then publish the exact archive:

```sh
npm publish ./release/js-longrun-0.2.0-alpha.0.tgz --access public --tag alpha --registry=https://registry.npmjs.org/
```

Verify the exact registry version and integrity before reporting success or retrying a network failure. First publications may take several minutes to become available. Inspect actual dist-tags; do not assume npm assigned only alpha. Create the annotated `v0.2.0-alpha.0` tag at the manifest source commit and a GitHub prerelease with the archive and manifest only when publishing is authorized. Finish with a fresh registry consumer CLI/SDK check. Do not store credentials or production task state in the repository or archive.

## Publication record

Version 0.1.0-alpha.2 was published on 2026-11-10 from clean commit `739711635fc714fa52f0c7d871cd5105b2ac68a0`. The annotated tag and GitHub prerelease contain the verified tarball and source manifest. Registry integrity matches the manifest; a fresh registry consumer passed CLI/SDK and offline settlement checks. npm assigned both `alpha` and `latest` on this first publication. It remains an alpha release; prefer the exact version.

Runtime management must also be tested against the consuming project’s exact superagent version (this candidate targets the verified 0.15.0-alpha.11 integration without changing it). Old peers lacking public health APIs report unavailable. Run service tests with isolated project/runtime homes; do not use production credentials or states. Stop old unmanaged watchers and timers before replacing their entrypoints. Real Feishu card submission and launchd timing require separate authorized deployment evidence; unit tests do not prove them.
