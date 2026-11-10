# Release preparation

The first proposed npm publication is `0.1.0-alpha.2` under the `alpha` tag. Alpha.0 and alpha.1 were local candidates only. The package is MIT licensed and requires Node 22.13+ and js-superagent alpha.1 or a compatible newer version. This is an early release, not a stable compatibility promise.

From a clean checkout:

```sh
npm ci --ignore-scripts
npm run release:prepare
```

This validates metadata and lock consistency, runs unit/integration/CLI tests, checks a tarball in a fresh consumer, and creates `release/js-longrun-0.1.0-alpha.2.tgz` and `release/manifest.json`. The manifest records SHA-512 integrity, source commit and dirty status. Commit and push changes, then regenerate the final candidate and require `sourceDirty: false`. CI checks minimum Node 22.13 and Node 24. No preparation command publishes anything.

Before an explicitly authorized publication, check CI, `npm whoami`, name/version availability and the manifest. Then publish the exact archive:

```sh
npm publish ./release/js-longrun-0.1.0-alpha.2.tgz --access public --tag alpha --registry=https://registry.npmjs.org/
```

Verify the exact registry version and integrity before reporting success or retrying a network failure. First publications may take several minutes to become available. Inspect actual dist-tags; do not assume npm assigned only alpha. Create the annotated `v0.1.0-alpha.2` tag at the manifest source commit and a GitHub prerelease with the archive and manifest only when publishing is authorized. Finish with a fresh registry consumer CLI/SDK check. Do not store credentials or production task state in the repository or archive.

## Publication record

Version 0.1.0-alpha.2 was published on 2026-11-10 from clean commit `739711635fc714fa52f0c7d871cd5105b2ac68a0`. The annotated tag and GitHub prerelease contain the verified tarball and source manifest. Registry integrity matches the manifest; a fresh registry consumer passed CLI/SDK and offline settlement checks. npm assigned both `alpha` and `latest` on this first publication. It remains an alpha release; prefer the exact version.
