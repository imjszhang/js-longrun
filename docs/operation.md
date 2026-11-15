# Operation and state

## Per-instance data

Each task owns `<tasksDir>/<id>/task.md`, `task.json`, `state.json`, `runs/` and `artifacts/`. The project registry is `<tasksDir>/registry.json`. `tasksDir` defaults to `research/longrun` and can be selected for a new project in `longrun.config.json`; see [layout configuration](integration.md#project-layout). Changing configuration is not a migration of existing tasks.

Business state includes the active ticket, quota reservations and `nextDueAt`; these are durable task records, not disposable runtime cache. Machine deployment records, heartbeat observations, logs and new offline trials live in the independent user-level longrun runtime directory. Historical execution records referenced by outcomes must be preserved rather than removed during cleanup. Existing `working/longrun/control-lock.sqlite3` remains the shared operation-lock anchor for compatibility; moving it while old entrypoints exist would split the lock domain. The project also retains small layout/runtime bindings and service ownership/lock anchors. These are consumer files, not package files.

The generic state schema separates `control` (`draft`, `enabled`, `paused`, `disabled`) from `running.phase`. An instance has at most one active run. A review run does not become a new research round. Different instances are reconciled separately; one invalid definition must not prevent another task from progressing.

## Definitions and cadence

A run freezes its definition revision, brief, input contents, hashes, output layout and artifact baseline. Editing the current task definition affects future runs. An invalid current task definition does not prevent collection under an existing run's frozen definition. A conflicting project-level `tasksDir` is different: restore the original layout configuration before operating; the collector must not reinterpret the existing run under another root.

Supported cadence:

- `after-settlement`: wait `minIntervalHours` after settlement; failed work also has a delay.
- `fixed-interval`: elapsed-hour spacing from a timezone-qualified absolute `anchor`. Missed intervals coalesce into one run, then advance to a future due time. This is not a calendar cron expression or a guarantee of a fixed local clock time across daylight-saving transitions.

Each task has a timezone for its weekly quota. A research run reserves one weekly run before ticket submission; a failed submission does not create a free retry. Re-review does not consume a research-run count. Built-in local tasks set both subtask limits to zero because they cannot start managed jobs.

Current limits are run counts and time bounds, not measured token or currency budgets. There is no account-wide billing controller. Consecutive failures pause the task after two failures. Resume clears the failure gate only for a previously authorized paused task; a disabled task must be explicitly enabled again.

## Review boundaries

`review-items@1` requires item decisions and supports deferred-item re-review. `change-report@1` has no item review. These are the implemented modes, not arbitrary combinations.

Item content, identity, options and host evidence must match the pre-answer snapshot. Results cannot invent an approval or rewrite an old source. Re-review binds items with `sourceRunId:itemId`, allowing distinct source runs to use the same local item number.

When review expires, new pending suggestions are deferred; re-review keeps prior formal decisions and memory. Queue, execution and review deadlines are distinct. A pause stops new work but does not discard in-flight tickets or prevent their collection.

## Settlement and recovery

The collector checks ticket binding, the allowed output paths, immutable review evidence, exact decisions and the current artifact baseline. It writes an `applying` settlement record with file hashes before application, then an applied receipt and run outcome. Recovery recognizes already-applied files; unrelated concurrent edits become conflicts instead of being overwritten.

`watch` consumes durable-state invalidations, not user decisions. It reads the current ticket before collecting and retries transient collection/rebuild failures. Scheduled `tick` is the fallback for missed events, timeouts and opening due rounds. Both paths share the same control lock. A healthy watcher cannot prove delivery of a future Feishu submission; production end-to-end acceptance requires an actual authorized submission.

## Offline trial

```sh
js-longrun trial my-report --result /path/to/result.json
js-longrun trial my-review --result /path/to/result.json --answers /path/to/answers.json --memory /path/to/memory.md
```

Trial requires supplied output fixtures. It does not invoke a model, browse, submit a production ticket or send a card. It creates a separate project ledger under the machine runtime's `trials/`, preserves the configured relative task layout inside that project, and uses a separate Worker workspace. Input evidence is copied from the selected production inputs; production task records and artifacts are not changed. SDK callers may supply `runtimeHome` to isolate trial storage. Evidence is labeled as simulated. Successful trial validation is not a claim about model quality or real channel delivery.

## Notifications and authority

Review items use the deployed operator channel. Reports disable operator card notifications. Generic `notifications.settled` and `notifications.failure` currently accept only `none`; standalone business-settlement notifications are not implemented. A js-superagent completion message describes worker completion, not js-longrun settlement.

A reason recorded by `enable` documents the caller's authorization; it is not an authentication system. The host remains responsible for granting tools, destinations, credentials and user authority. A task definition cannot load arbitrary executable plugins or widen those permissions.
