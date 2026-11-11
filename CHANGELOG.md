# Changelog

## 0.1.0-alpha.3 — Unreleased candidate

- Add explicit host opt-in for a same-project frozen material snapshot, with a distinct `frozen-project-materials@1` contract and native snapshot-copy workspace selection.
- Check capabilities before creating a draft, reserving a round or submitting. Unknown submission outcomes retain their existing recovery ownership.
- Bind frozen inputs, output scope, limits, review rules and artifact baseline. Verify the material identity, complete workspace generation lineage and Worker increment before collection; missing evidence never falls back to the project directory.
- Recognize host preparation waiting before result collection, without cancelling a valid preparation or resetting its execution deadline.
- Keep longrun as the only formal artifact writer and preserve existing review, deadline, cancellation, budget and settlement behavior. Legacy `local-worker@1` tasks and published 0.14 peers remain compatible.
- Verify the new SDK path in an isolated fixture through initial snapshot copy, re-preparation, source changes after freezing and idempotent longrun settlement.

## 0.1.0-alpha.2 — Published 2026-11-10

- Require the published js-superagent alpha.1 repair as the minimum peer version and test against it.
- Add repository metadata, release consistency checks and durable tarball/integrity manifests.
- Refresh installation and publication documentation; no runtime behavior or state format changes.

## 0.1.0-alpha.1 — Unreleased local candidate

- Accept compatible js-superagent updates through the `^0.14.0-alpha.0` peer range while retaining published alpha.0 for SDK and offline package checks.
- Document use of the unpublished js-superagent `0.14.0-alpha.1` repair candidate when DSH has managed jobs enabled. The executor fix lives in js-superagent; this package continues submitting built-in tasks with managed jobs disabled.
- Preserve task formats and runtime state; no migration is required.

## 0.1.0-alpha.0 — Unreleased

- Extract generic task definitions, frozen runs, local report and review-item types, validation and recoverable settlement.
- Project-wide scheduling and immediate collection with host route hooks.
- Explicit-project js-superagent SDK adapter and CLI.
- Preserve existing disk layouts; host-specific topic research stays in the consuming project.
