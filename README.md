# js-longrun

Persistent, bounded rounds of work for a long-term project goal. js-longrun decides when a task may run, freezes its inputs, submits work to js-superagent, verifies review evidence and applies results to the owning project.

**Status: `0.1.0-alpha.1`, local npm candidate; not published.** Preparing or installing a tarball does not publish it. This extraction preserves the existing task format and execution model; it does not introduce a new cloud service.

## Responsibilities

- **js-longrun:** task definitions, run cadence and limits, review/settlement evidence, immediate collection and scheduled reconciliation.
- **js-superagent:** durable tickets, worker scheduling, isolated workspaces, human replies and Feishu transport. It is a peer dependency; the consumer owns its deployment and credentials.
- **Your project:** business rules, registered execution capabilities, custom validation/output behavior and production task history. A business adapter may use js-agent-runtime, but js-longrun does not require it.

Runtime data remains under the consumer's `research/longrun/` and `working/longrun/`. No account secret, production state, candidate record or review answer belongs in this npm package.

## Install the candidate

Node.js **22.13 or newer** is required.

```sh
# In this source checkout:
npm ci
npm run check
npm pack

# In the consuming project, use the produced tarball:
npm install --save-exact /path/to/js-longrun-0.1.0-alpha.1.tgz /path/to/js-superagent-0.14.0-alpha.1.tgz
```

The package's scripts are authoritative for release checks. Runtime consumers do not need to compile the package. Install optional channel dependencies in the consuming project if its js-superagent deployment needs them, such as the Feishu SDK.

The peer range is `js-superagent@^0.14.0-alpha.0`; SDK and offline package checks still use the published `0.14.0-alpha.0`. Deployments using DSH with managed jobs enabled need the local `js-superagent@0.14.0-alpha.1` repair candidate for built-in longrun tasks. Those tasks disable managed jobs per ticket, and the repair applies that restriction to the DSH executor as well. The repair candidate is not published to npm; prepare its tarball from the js-superagent checkout and install it alongside this package, as above. Updating source files alone does not update a running service.

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
