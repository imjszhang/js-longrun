# Integrating an existing project

## Public package boundaries

Use exported package entrypoints, not paths inside the npm installation. The main SDK exposes generic task operations. Dedicated modules expose definitions, runtime, trial, project scheduling, the js-superagent adapter, locking and CLI delegation as listed in `package.json`.

The service adapter requires an explicit project root:

```js
import { serviceClient, watchServiceClient } from 'js-longrun/superagent';

const client = serviceClient({ projectRoot });
const observer = watchServiceClient({ projectRoot });
// The observer provides observe/watchChanges and must be closed during shutdown.
```

The adapter uses the public js-superagent SDK to submit, read, answer, reply and cancel tickets. It does not start another worker scheduler or Feishu listener. Generic tasks pass their frozen snapshot paths and capability restrictions when submitting a ticket. Both operational clients initialize the SDK runtime, which may initialize, migrate or recover its state. They are not strictly read-only diagnostics. The longrun service manager reads its own observations and the existing public superagent service/identity inspection APIs instead; no superagent change is required.

## Project layout

An optional `longrun.config.json` in the consuming project selects the generic task root:

```json
{ "schemaVersion": 1, "tasksDir": "automation/tasks" }
```

Without this file the root remains `research/longrun`. `resolveLayout(root)` from `js-longrun/layout` resolves the same configuration used by CLI, SDK, scheduler, collector and trial. It performs no initialization. `root` always identifies the consuming project and its superagent state, not the task directory. Task definitions cannot override this configuration or load routes.

The first mutating operation binds the chosen layout in the fixed project control directory. A changed/missing configuration that disagrees with that binding fails explicitly. Selecting a new root while the old default directory contains tasks also fails; it must not silently create another registry or budget. This release supports choosing a root for a new project, not relocating existing tasks. Do not delete the binding to bypass that check. Task paths are project-relative and reject traversal, symlinks and overlap with control files or dependency directories. Selecting a root does not grant material access or expand Worker write permission.

Each operation captures its resolved layout across asynchronous calls. New runs also freeze `taskBase`, `runBase` and `artifactBase` in their draft and binding; these paths participate in new material contract hashes. Collection and interrupted settlement use the frozen paths. Older runs without layout metadata retain their legacy paths and original hashes; no draft rewrite is needed. Input paths remain relative to the project root and retain their original bytes and SHA-256 evidence.

Machine runtime files have a separate resolver, `resolveRuntimeLayout({ projectRoot, runtimeHome })` from `js-longrun/service-runtime`. Trials use this machine directory, with an independent project ledger and Worker workspace. Existing task state, evidence, outcomes, memory and quotas remain in the configured task root. See [operation](operation.md) for the control-lock compatibility boundary.

## Explicit frozen project materials

Existing `local-worker@1` definitions and runs retain their original frozen-text behavior. A trusted host adapter can opt one new round into the separate `frozen-project-materials@1` contract. Task JSON and Worker prose cannot enable it.

```js
const snapshot = await client.createMaterialSnapshot({ sourceId: 'project-inputs' });
await startRun({ root: projectRoot, id: taskId, client, materials: {
  sources: [{ id: 'project-inputs', snapshotId: snapshot.id,
    digest: snapshot.digest, source: snapshot.source }],
} });
```

The project material entry must already be configured by the host and permit snapshot views. This adapter accepts one snapshot from the same project, requests an explicit native copy through `workspaceSourceId`, and preserves the original inline frozen inputs as the business evidence. It grants no managed jobs or superagent local application: longrun alone owns formal settlement. A custom business adapter must explicitly freeze and validate any cross-project inputs; built-in task types do not gain live or cross-project reading.

Capability preflight requires material contract version 1 and schema 15 before writing a round draft, reserving its budget, or submitting. Unsupported hosts leave the task unopened. Once submission has been attempted, unknown results retain the original `needs_attention` ownership and never create a replacement ticket.

The run draft and `binding.json` retain an immutable digest of inputs, output scope, original artifact baseline, limits, review rules, and snapshot identity. Collection requires the actual material binding, baseline and Worker increment. It accepts a complete same-contract generation lineage instead of pinning the first workspace forever; missing or changed evidence blocks collection without a root-directory fallback. The host's preparation-waiting state is not a business result or a new human-review window: immediate collection waits for preparation and retains the original execution deadline. Existing result validation, review evidence, cancellation, settlement conflict checks and idempotent reconciliation still apply. Changing a workspace does not reset a round or its budget.

After an interrupted operation, inspect the bound ticket and its durable operation receipt before retrying. Superagent-owned local applications provide `materialApplicationStatus` and explicit `recoverMaterialApplication`; a rollback undoes only unchanged bytes recorded by that application and never authorizes a Worker restart. These APIs always refuse longrun-owned artifacts. A longrun round resumes only its own saved settlement journal through collection, with its original task/run/ticket binding and artifact conflict checks.

## Business-owned scheduler routes

Custom pipeline rules stay in the consumer. A project can provide route functions to `tickProject` and `startProjectWatcher`:

- `list(root)` enumerates built-in and business-owned instances.
- `registryDirectories(root)` returns project-relative directories to watch for registry changes (default: the configured task root).
- `instanceDirectory(root, row)` returns the project-relative instance directory to watch (default: `<tasksDir>/<row.id>`). A host with legacy paths must supply these explicitly instead of assuming its business routes also change filesystem subscriptions.
- `load(root, row)` loads the matching state format.
- `tick({ root, row, client, now, open })` and `collect(...)` delegate to the owning engine.
- `canOpen({ root, row, state })` supplies eligibility for a custom state format; actual business gates remain in its engine.
- `preserveInitial({ root, row, state, view })` can recognize an already-frozen waiting review on watcher startup, preserving legacy state byte-for-byte.
- `afterCollect({ root, row, result })` refreshes consumer views after watcher collection; retry is independent from settlement.
- `onStart({ root })` repairs derived consumer views when the watcher starts. Failures retry independently and do not block collection. This closes the restart gap when settlement was saved but a view refresh failed before shutdown.
- `facts({ root, row })` returns bounded host fact records from the owning engine's authoritative state. The default uses the generic projector; a legacy engine supplies its own reader instead of teaching the package its business schema.

Watcher options `onReady` and `onActivity` expose observations for the owning service manager. `onReady` fires after a successful initial catch-up and startup repair; the existing `watcher.ready` promise only means that the first attempt has ended and may resolve even when retryable errors occurred. Activity records distinguish a check, its success/failure, a durable collection and a follow-up view error. Ticket observation signatures include domain and assignment identity, so a replacement reconciles even when the public ID and status remain unchanged. Observations do not authorize new work or become another task database.

Every custom engine must use the same package lock and preserve ticket/output identity checks. Routes are code explicitly supplied by the host, not code loaded from task JSON.

Keep the existing state paths and IDs during extraction. Generic schema-3 state must not be written over an older business schema. No migration should recreate a card, resubmit a live ticket or reset a deadline merely because package location changed.

## Host context projection

`js-longrun/context` exposes pure readers/builders and best-effort synchronization:

```js
import { readTaskFacts, makeTaskFact, makeRunFact, syncTaskFacts, syncProjectFacts } from 'js-longrun/context';

// No SDK initialization and no writes to task state, outcomes or old receipts.
const records = readTaskFacts({ root, id: 'report' });
const contextSync = await syncTaskFacts({ root, id: 'report', client });

// A trusted legacy adapter provides the same protocol using its own records.
const routes = {
  // ...the adapter's list/load/tick/collect routes...
  facts: ({ root, row }) => readLegacyFacts({ root, id: row.id }),
};
await syncProjectFacts({ root, client, routes });
```

`makeTaskFact({ taskId, type, state, observedAt, availability, error })` selects only operational fields: control, phase, round, due time and active run/ticket identity. `observedAt` defaults to the persisted `state.updatedAt`; legacy adapters should normalize their state and use an actual persisted update time. `makeRunFact({ taskId, runId, kind, ticketId, domainId, assignmentId, record, observedAt, result })` produces a separate historical outcome. Its observation defaults to `record.finishedAt`; `result` can supply a bounded business summary. Task briefs, raw source paths and review content do not belong in project-scope facts. Ticket-scope summaries remain subject to the host's material disclosure rules.

The generic reader follows the configured task root and each run's frozen layout. It requires a bound ticket identity and an applied settlement receipt before asserting settled/expired results. Invalid definitions or history are surfaced as unavailable, not an empty task list. Its source time combines persisted state updates and source file modification times so definition repair is observable; repeated reconciliation never invents a fresh time. Runtime phase transitions update `state.updatedAt` only when state changes. Historical drafts, outcomes and receipts are never rewritten by the projector.

The service adapter checks `hostFactsCapabilities().version === 1` before forwarding `publishHostFacts`, submission `hostReference` or cancellation provenance. New submissions carry `{ producer: 'js-longrun', taskId, runId, kind }`. Snapshots and `identity(ticketId)` expose current `domainId`/`assignmentId`, proven `initialDomainId`/`initialAssignmentId`, and the original `hostReference` with its explicit `hostReferenceDomainId`/`hostReferenceAssignmentId`. New outcome and settlement receipts freeze the actually observed terminal tuple. An unbound old outcome can use only an exact reference's original tuple or the host's proven initial tuple; a matching reference never permits substitution of today's assignment. If neither proof is available, synchronization reports an unresolved record. A retry or ordinary continuation cannot attach an old outcome to a new assignment; historical records are not rewritten.

`startRun`, `collectTask` and `tickTask` return a separate `contextSync` diagnostic (`synced`, `partial`, `unavailable` or `pending`). Project ticks attach it to each task result. The watcher reconciles all registered tasks after its startup/collection hooks, including tasks with no active run, and reports `context-sync` activity. A verified empty registry is recorded explicitly; a selected subset does not overwrite the full inventory. Pending writes retry through the existing watcher retry path and scheduled reconciliation; there is no added queue or timer. Project-wide inventory is bounded to 100 IDs with an explicit completeness flag; task facts remain individually keyed. Inventory availability records the time of the actual listing attempt, advancing beyond the previous stored observation even for same-millisecond failure/recovery. Its semantic version excludes time, so repeated identical observations cause no host write or event. This also supports legacy registries outside the generic task root without inventing task-state updates.

Sync runs outside submission and settlement error handling. If the host write fails after an outcome was saved, the result remains collected and the next reconciliation republishes from that outcome; it cannot create another ticket or apply the artifacts again. Same content/version is a no-op. Older observations and same-time conflicts remain diagnostics rather than making old facts fresh. Offline `create`, `enable`, `pause`, `resume`, `disable`, planning and status commands do not open an SDK; their changes become visible when a connected watcher/tick next observes them.

Timeout behavior is unchanged. Cancellation provenance records `source: 'js-longrun'`, a precise `queue_timeout`, `execution_timeout`, `workspace_preparation_timeout`, `review_timeout` or `invalid_result` reason, the task/run reference and the observed `expectedDomainId` and `expectedAssignmentId` when available. A capable host rejects a changed generation or assignment. These are explanatory facts; they add no Core state, approval policy or automatic restart rule.

## CLI delegation

`handleGenericCommand` lets a thin host CLI reuse package commands while retaining business-specific commands. It accepts the existing `root`, `command`, `taskId`, `explicitTask` and `flags` fields, plus:

- `dependencies`: selected definition/runtime/project/adapter function overrides; defaults to the package implementations.
- `additionalTypes`: business type rows to include in `types`.
- `skipTask(id)`: return `true` to delegate task-specific commands to the host after shared commands have been handled.
- `routes`: passed to project-wide scheduling.
- `afterTick(results)`: optional consumer view refresh after project-wide ticks.
- `watcherOptions`: scheduler options/hooks for the host's watcher.
- `print(value)`: injectable JSON output sink.

`create` and `design` precede `skipTask`; hosts reserving legacy IDs must also guard them in the relevant `dependencies` overrides. `list` similarly uses the injected `listTasks`. Keep production launchd/systemd entries pointing to the host wrapper when it registers custom routes.

## Extraction acceptance

An extraction should verify:

1. Installation from a tarball works in a clean consumer without access to the source checkout.
2. CLI help/version and planning do not start workers or send messages.
3. SDK state events drive immediate collection, with timer reconciliation still available.
4. A user answer matches its frozen card snapshot before applying outputs.
5. Existing state and candidate files retain their hashes throughout migration checks.
6. Real channel health, model execution and production user submission are reported separately from isolated fixture tests.

Public npm publication and remote repository creation are separate actions from preparing the package. Existing deployments are not automatically upgraded by publishing a new version.
