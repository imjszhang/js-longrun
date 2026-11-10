# Operation and state

## Per-instance data

Each task owns `research/longrun/<id>/task.md`, `task.json`, `state.json`, `runs/` and `artifacts/`. The project registry is `research/longrun/registry.json`. `working/longrun/` stores control locks and isolated trial data. These are consumer files, not package files.

The generic state schema separates `control` (`draft`, `enabled`, `paused`, `disabled`) from `running.phase`. An instance has at most one active run. A review run does not become a new research round. Different instances are reconciled separately; one invalid definition must not prevent another task from progressing.

## Definitions and cadence

A run freezes its definition revision, brief, input contents, hashes and artifact baseline. Editing current configuration affects future runs. Invalid current configuration does not prevent collection under an existing run's frozen definition.

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

Trial requires supplied output fixtures. It does not invoke a model, browse, submit a production ticket or send a card. It creates a separate ledger under `working/longrun/trials/`, runs validation/settlement there and labels evidence as simulated. Successful trial validation is not a claim about model quality or real channel delivery.

## Notifications and authority

Review items use the deployed operator channel. Reports disable operator card notifications. Generic `notifications.settled` and `notifications.failure` currently accept only `none`; standalone business-settlement notifications are not implemented. A js-superagent completion message describes worker completion, not js-longrun settlement.

A reason recorded by `enable` documents the caller's authorization; it is not an authentication system. The host remains responsible for granting tools, destinations, credentials and user authority. A task definition cannot load arbitrary executable plugins or widen those permissions.
