# Changelog

## Unreleased

- Project task overviews and ticket business outcomes into the capable host's context store without moving authority out of longrun. Include active, cooling, disabled and unavailable tasks and distinguish a stopped Worker from applied settlement.
- Bind new submissions to an immutable host reference; preserve original ticket generations when projecting old outcomes. Pass precise queue, execution, preparation, review and invalid-result stop provenance with the observed generation.
- Reconcile derived context through existing startup, watcher, tick and manual collection paths, including idle tasks. Context failures have a separate diagnostic and never resubmit or recollect work; offline task definition commands remain offline.
- Export pure `js-longrun/context` builders and trusted host routes. Capability absence remains compatible with older peers, while unavailable or stale context is explicit.
- Add fictional lifecycle, retry, old-peer, generation, provenance and SDK material/context integration coverage. No production history migration or new execution policy.

## 0.2.0-alpha.0 — Unreleased candidate

- Configure a project-relative task root through one validated layout, freeze paths in new runs, and retain legacy contract hashes and recoverable settlement.
- Add independent machine runtime storage, macOS management for one watcher plus one periodic tick, ownership-checked stop/restart and project-anchored singleton locks.
- Provide read-only deployment/health inspection without opening the execution runtime, bounded logs, watch observations and tick completion records.
- Preserve host routes and explicit watcher directories, task enablement, original operation locks and all existing superagent interfaces.
- Keep active SQLite connections reachable until release, preventing garbage collection from dropping a live asynchronous operation or startup lease.
- Add custom-layout lifecycle/recovery, service concurrency/ownership, CLI and clean-package consumer tests, plus an opt-in real launchd missed-event fallback smoke.

## 0.1.0-alpha.3 — Published alpha

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
