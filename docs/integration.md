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

The adapter uses the public js-superagent SDK to submit, read, answer, reply and cancel tickets. It does not start another worker scheduler or Feishu listener. Generic tasks pass their frozen snapshot paths and capability restrictions when submitting a ticket.

## Business-owned scheduler routes

Custom pipeline rules stay in the consumer. A project can provide route functions to `tickProject` and `startProjectWatcher`:

- `list(root)` enumerates built-in and business-owned instances.
- `load(root, row)` loads the matching state format.
- `tick({ root, row, client, now, open })` and `collect(...)` delegate to the owning engine.
- `canOpen({ root, row, state })` supplies eligibility for a custom state format; actual business gates remain in its engine.
- `preserveInitial({ root, row, state, view })` can recognize an already-frozen waiting review on watcher startup, preserving legacy state byte-for-byte.
- `afterCollect({ root, row, result })` refreshes consumer views after watcher collection; retry is independent from settlement.
- `onStart({ root })` repairs derived consumer views when the watcher starts. Failures retry independently and do not block collection. This closes the restart gap when settlement was saved but a view refresh failed before shutdown.

Every custom engine must use the same package lock and preserve ticket/output identity checks. Routes are code explicitly supplied by the host, not code loaded from task JSON.

Keep the existing state paths and IDs during extraction. Generic schema-3 state must not be written over an older business schema. No migration should recreate a card, resubmit a live ticket or reset a deadline merely because package location changed.

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
