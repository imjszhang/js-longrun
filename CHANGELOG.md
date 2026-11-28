# Changelog

## 0.2.0-alpha.4 — 2026-11-28

- Support `minIntervalMinutes` and `intervalMinutes` for task cadence, with a five-minute minimum and exclusive hour/minute units. Keep existing integer-hour definitions and frozen runs compatible.
- Preserve the `minIntervalHours: 72` default for existing callers. Retain saved due times and use frozen cadence during settlement and recovery.
- Document five-minute service checks and the existing weekly quota limits. Cover minute validation, CLI creation/planning, due-time gates, missed slots and frozen-definition recovery.

## 0.2.0-alpha.3 — 2026-11-28

- Keep complete v2 process identities usable when hostname lookup fails or returns no name; diagnostics no longer control identity capture or prior-boot recovery.
- Make the legacy PID 1 boot-display probe optional for v2 ownership. Stable machine, boot-session and namespace evidence remains mandatory; legacy receipts still fail closed when their old locality evidence is unavailable.
- Add regression coverage for missing hostname diagnostics, legacy boot-display failure and mandatory stable boot evidence. No task state, service settings or existing receipts are rewritten.

## 0.2.0-alpha.2 — 2026-11-28

- Identify service owners by scoped machine digest, OS boot session, PID namespace, process start and user identity; hostname is diagnostic only. Same-machine prior boots and reused PIDs no longer block recovery.
- Accept verified same-boot legacy owners after hostname changes, while refusing foreign, incomplete or ambiguous legacy evidence. No task-state or receipt rewriting is required.
- Check watcher and tick ownership before changing stop intent or disabling services. Recheck ownership immediately before signalling; unknown owners fail closed without an initial partial stop.
- Add hostname-change, reboot, PID-reuse, probe-failure, legacy-compatibility and service-management regression coverage on macOS and Linux.

## 0.2.0-alpha.1 — 2026-11-27

- Project task overviews and ticket business outcomes into the capable host's context store without moving authority out of longrun. Include active, cooling, disabled and unavailable tasks and distinguish a stopped Worker from applied settlement.
- Bind new submissions to an immutable host reference; preserve original ticket generations when projecting old outcomes. Pass precise queue, execution, preparation, review and invalid-result stop provenance with the observed generation.
- Reconcile derived context through existing startup, watcher, tick and manual collection paths, including idle tasks. Context failures have a separate diagnostic and never resubmit or recollect work; offline task definition commands remain offline.
- Export pure `js-longrun/context` builders and trusted host routes. Capability absence remains compatible with older peers, while unavailable or stale context is explicit.
- Add fictional lifecycle, retry, old-peer, generation, provenance and SDK material/context integration coverage. No production history migration or new execution policy.

## 0.2.0-alpha.0 — Published alpha

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
