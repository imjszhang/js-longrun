# js-longrun

Persistent, bounded rounds of work for a long-term project goal. js-longrun decides when a task may run, freezes its inputs, submits work to js-superagent, verifies review evidence and applies results to the owning project.

**Version: `0.2.0-alpha.1` — alpha release.** This version adds coordinator-facing task and settlement facts to the existing configurable task storage and independent service management. Installing it does not enable tasks or start services. Existing task definitions and frozen runs remain compatible; historical records are not migrated.

## Responsibilities

- **js-longrun:** task definitions, run cadence and limits, review/settlement evidence, immediate collection and scheduled reconciliation.
- **js-superagent:** durable tickets, worker scheduling, isolated workspaces, human replies and Feishu transport. It is a peer dependency; the consumer owns its deployment and credentials.
- **Your project:** business rules, registered execution capabilities, custom validation/output behavior and production task history. A business adapter may use js-agent-runtime, but js-longrun does not require it.

Task data defaults to the consumer's `research/longrun/`, configurable through `longrun.config.json`. Machine logs and service observations live under `~/.js-longrun/projects/<project-key>/`. Small project-local compatibility locks and bindings remain under `working/longrun/`; they protect concurrent old callers and cannot be moved by changing the task directory. No account secret, production state, candidate record or review answer belongs in this npm package.

## Install

Node.js **22.13 or newer** is required.

```sh
# In this source checkout:
npm ci
npm run check
npm pack

# In the consuming project, install the published versions:
npm install --save-exact js-longrun@0.2.0-alpha.1 js-superagent@0.15.0-alpha.16
```

The package's scripts are authoritative for release checks. Runtime consumers do not need to compile the package. Install optional channel dependencies in the consuming project if its js-superagent deployment needs them, such as the Feishu SDK.

The peer range is `js-superagent@^0.14.0-alpha.1 || ^0.15.0-alpha.0`. Legacy tasks remain tested against published `0.14.0-alpha.1`. The frozen material contract requires material capabilities version 1 and schema 15; unsupported hosts reject it before starting or charging a round. The optional coordinator facts integration uses host facts capabilities version 1, introduced in `0.15.0-alpha.16`; older hosts retain ordinary task behavior and report this integration as unavailable. See [host integration](docs/integration.md) for explicit opt-in and compatibility tests. Updating source files alone does not update a running service.

## Create a task without starting it

```sh
npx --no-install js-longrun --project /path/to/project types
npx --no-install js-longrun --project /path/to/project design weekly-report --type change-report@1
npx --no-install js-longrun --project /path/to/project create weekly-report \
  --type change-report@1 --goal 'Summarize changes in the supplied local documents'
```

Creation stays **draft**. It does not submit a ticket, send a card or enable scheduling. Edit the instance's `task.json` to add repository-relative UTF-8 input files; use `task.md` for the goal and scope. Then inspect the actual execution plan:

```sh
npx --no-install js-longrun validate weekly-report
npx --no-install js-longrun plan weekly-report
npx --no-install js-longrun status weekly-report
```

The current working directory is the project unless `--project` is supplied. Task IDs and data are scoped to that project; installation location is never used as the project root.

Task cadence supports integer minutes starting at **5 minutes**. Set `trigger.minIntervalMinutes` for an `after-settlement` delay, or `trigger.intervalMinutes` with a timezone-qualified `anchor` for a `fixed-interval` schedule. For example, `intervalMinutes: 30` schedules half-hour slots. Existing integer-hour definitions remain supported, with exactly one unit allowed per trigger. Generated defaults retain `minIntervalHours: 72` for existing callers. This feature requires the updated runtime; published releases through `0.2.0-alpha.3` accept hour fields only. See [cadence and compatibility](docs/operation.md#definitions-and-cadence).

## Configure storage and manage the background service

```json
{ "schemaVersion": 1, "tasksDir": "research/longrun" }
```

Save this as `longrun.config.json` before creating tasks. Task roots are project-relative; changing a populated root is not a migration. Old runs keep their original paths and hashes.

On macOS, install one project-wide watcher and one hourly fallback timer:

```sh
npx --no-install js-longrun service install --interval-seconds 3600 --open-rounds true
npx --no-install js-longrun service start
npx --no-install js-longrun service health
npx --no-install js-longrun service stop
```

For five-minute tasks, set `--interval-seconds 300` during service installation. The task's interval determines its due time, and the service interval determines how often eligibility is checked. Weekly quotas still apply; `weeklyRuns` defaults to 4 and has a maximum of 1000.

Install only writes a stopped deployment. Start does not enable draft tasks. Stop drains local operations without cancelling Worker tickets or stopping superagent. Projects with business routes must install their existing wrapper with `--entrypoint <absolute-file> --entry-args '[]'`. Status and health inspect stored observations without initializing the execution SDK. See [runtime management](docs/runtime-management.md) for ownership, upgrades, logs, limitations and explicit old-service migration.

## Built-in task types

| Type | Output | Review | Execution |
|---|---|---|---|
| `review-items@1` | Evidence-backed suggestions | Adopt / reject / defer, with reasons; supports re-review | Supplied local inputs |
| `change-report@1` | Change report, evidence and next-round memory | No item-by-item review | Supplied local inputs |

These types do not browse the web or start managed subjobs. Unsupported definitions fail validation. Custom business pipelines stay in the consuming project and can integrate through scheduler routes; their state must not be silently rewritten as a built-in type.

## Enable and operate

After the user has authorized the task and the js-superagent service is configured for the project:

```sh
npx --no-install js-longrun enable weekly-report --reason 'User authorized this task and its configured cadence'
npx --no-install js-longrun round weekly-report
npx --no-install js-longrun watch
```

`enable` records authorization but does not immediately submit work. `round` enforces enabled state, due time, quotas and active-run checks. `watch` only collects results; it never opens new rounds.

Run reconciliation through the consuming project's scheduler:

```sh
npx --no-install js-longrun tick                   # collect/check only
LONGRUN_OPEN_ROUNDS=1 npx --no-install js-longrun tick # also open eligible rounds
```

A project integrating custom task routes should schedule its own thin CLI wrapper instead, so those routes are registered for both `watch` and `tick`. Use one production watcher and one fallback timer for the project. Hosts can use the watcher’s `routes.onStart` hook to repair derived views after restart; repair failures retry without blocking result collection. This package does not install a scheduler or send a message merely by being installed.

## Review and settle

Feishu is provided by the existing js-superagent operator channel. The host saves an immutable snapshot before presenting a review. A structured answer is stored against that review, and the original worker writes its result. After the ticket completes, `watch` wakes the collector, which verifies the snapshot, answer, output scope and existing artifact baseline before applying the result.

**Worker completion and business settlement are separate facts.** Collection also works through `tick` or manual `collect`. Repeated events and concurrent collectors use the same lock and settlement record. Multi-file settlement is recoverable and conflict-aware; it is not a distributed exactly-once transaction.

On a host advertising context capabilities version 1, the same collection paths also project the project's active tasks, next due times and completed business outcomes for its coordinator. This lets a project conversation account for work already underway and distinguish an expired review from a user cancellation. Longrun still owns the task records and decisions; the host stores a query copy. Unsupported hosts continue normal execution with an explicit `contextSync: unavailable` diagnostic. See [host context integration](docs/integration.md#host-context-projection).

Re-review uses source-run identities and frozen original evidence:

```sh
npx --no-install js-longrun rereview suggestions --ids R0001:I0001,R0002:I0001
npx --no-install js-longrun reply suggestions --answers answers.json
```

Text replies do not substitute for structured item decisions. Re-review expiry preserves old decisions and memory.

## Documentation

- [Task design template](templates/task-brief.md)
- [Operation, limits and state](docs/operation.md)
- [Host integration and migration](docs/integration.md)

MIT license. See [LICENSE](LICENSE).

See [release preparation](docs/releasing.md) for reproducible archives, validation and publication boundaries.
