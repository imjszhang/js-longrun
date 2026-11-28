# Runtime management

js-longrun owns its task scheduler and its local service lifecycle. js-superagent continues to own tickets, Workers, channels and structured answers. Installing or stopping longrun does not initialize, upgrade, stop or reconfigure the superagent service.

## Three kinds of configuration

| Layer | Responsibility |
| --- | --- |
| Project | `longrun.config.json` selects `tasksDir`; trusted host code registers business routes and the CLI wrapper. |
| Task | Goal, frozen inputs, output contract, cadence, quotas, review and task control remain in the task ledger. |
| Machine | An installed service records the absolute Node executable, entrypoint, arguments, timer interval, running/stopped intent and observations. |

The default machine home is `~/.js-longrun`; `JS_LONGRUN_HOME` or `service install --runtime-home <absolute-directory>` selects another location. Per-project files live below `projects/<canonical-project-name-and-hash>/`. The canonical project root is the identity, not `tasksDir`. Machine storage must be outside the consuming project. A stable binding remembers the selected location, so later commands do not need to repeat the override. Changing a bound machine home is rejected; automatic relocation is not implemented.

Machine files include `service.json`, `watch.json`, `tick.json`, `logs/` and new offline `trials/`. Observations contain timestamps, process identity, counts and error codes, not copies of answers or task bodies. They are diagnostic observations, not a second task database. Task state, budgets, `nextDueAt`, review evidence, outcomes and memory remain durable project records.

Small compatibility anchors deliberately remain in `working/longrun`: the existing `control-lock.sqlite3`, task layout and machine bindings, and service control/process locks and owner receipts. The operation lock continues to serialize old and new business operations. Separate OS-backed locks protect the watcher, tick and service-control lifetime; holding the watcher lock does not block collection. Changing task or machine paths cannot create another singleton namespace. Do not delete a live lock or binding to force a second service.

## Install and operate

The service backend currently supports macOS user LaunchAgents. Other platforms retain foreground `watch` and `tick`; they do not gain an unimplemented system service backend. Login, shutdown and sleep restrictions still apply.

```sh
./node_modules/.bin/js-longrun --project /absolute/project service install \
  --interval-seconds 3600 --open-rounds true
./node_modules/.bin/js-longrun --project /absolute/project service start
./node_modules/.bin/js-longrun --project /absolute/project service status
./node_modules/.bin/js-longrun --project /absolute/project service health
./node_modules/.bin/js-longrun --project /absolute/project service logs \
  --component watch --stream stderr --lines 100
./node_modules/.bin/js-longrun --project /absolute/project service stop
```

`install` writes a stopped deployment. `start` loads one persistent watcher and one periodic tick. Neither operation changes task controls. `--open-rounds true` permits the timer to open only already-enabled, eligible tasks through existing cadence/quota gates; its default is false. The watcher only collects. The timer is hourly by default, does not run immediately on load, and does not replay every missed interval after sleep.

Projects with business routes must retain their own wrapper:

```sh
./node_modules/.bin/js-longrun --project /absolute/project service install \
  --entrypoint /absolute/project/scripts/longrun.mjs --entry-args '[]' \
  --node /absolute/node --interval-seconds 3600 --open-rounds true
```

The generic CLI defaults to `['--project', canonicalRoot]` before `watch`/`tick`. A root-bound wrapper generally needs `[]`. The wrapper must use the managed watcher/tick integration, not merely accept the command names. Installation records its digest, package version and task root; changing them requires stopping and reinstalling the deployment. An unknown or externally edited LaunchAgent is never overwritten.

`restart` performs a controlled stop and start. `uninstall` stops and removes only owned service registrations and its deployment manifest; task records, observations, logs and stable bindings remain. Stop persists the stopped intent, disables both jobs, signals only the verified watcher and waits for its local collection to drain. An in-flight tick is allowed to finish. Worker cancellation is a different operation owned by superagent.

Repeated `start` waits for successful readiness when the owned process is still starting; it does not replace that process or reset the running intent. If the owned LaunchAgent remains loaded after a clean exit, `start` explicitly starts that idle watcher without force-killing a process. A loaded registration alone is not a running watcher.

Ownership includes a random run ID, PID, process birth, user, host and boot observation. PID alone, an old heartbeat or a stale lock file cannot authorize a kill. Stop timeout leaves an explicit stopped intent with `LONGRUN_STOP_PENDING`; it does not force-kill an unknown process or report success. The watcher restarts after abnormal exit through launchd, with a throttle; normal shutdown does not request a restart. This is not an automatic repair mechanism for invalid business results.

## SDK integration for host wrappers

```js
import { runManagedWatcher, recordManagedTick } from 'js-longrun/service-runtime';

const watcher = await runManagedWatcher({
  projectRoot,
  start({ onReady, onActivity, onError }) {
    // Open the existing SDK observer here, after the project singleton is acquired.
    // Return a watcher with ready and close; close must also close that observer.
    return startHostWatcher({ onReady, onActivity, onError });
  },
});
await watcher.ready; // resolves only after explicit successful onReady
// SIGTERM/SIGINT handlers await watcher.close(), including local in-flight work.

const results = await recordManagedTick({
  projectRoot,
  run: () => tickHostProject(),
});
```

`startProjectWatcher` supplies `onReady` after a successful startup catch-up and projection repair. Its existing `ready` promise still denotes the first attempted pass for older callers; the managed wrapper waits for the successful callback. `onActivity` reports checking, reconciliation success/failure, collection and errors. Existing routes can expose `registryDirectories(root)` and `instanceDirectory(root, row)` to watch legacy business paths alongside the configured generic root.

`createLongrunServiceManager(options)` is exported from `js-longrun/service`. It supplies `install/start/stop/restart/status/health/logs/uninstall`. A trusted host may supply `readTaskStatus` to include its legacy task summaries. Explicit `environment` settings are non-secret values; do not pass the entire inherited environment. No credential is copied from superagent.

## Read-only inspection and evidence

`service status`, `service health` and `service logs` do not create directories, initialize an SDK runtime, collect results, run recovery, call models or send messages. Health uses longrun's own observations and, when available, the existing standalone public `js-superagent.createServiceManager().health()`. Older SDKs lacking that public API return dependency health as unavailable. Inspection never substitutes a temporary `createProjectAgent().init()`.

The existing operational superagent adapter still calls `.init()` during authorized watching/collection; it is not a strictly read-only adapter. This release does not modify that interface or superagent itself.

Health separates:

- owned process and fresh heartbeat;
- successful initial observation, ongoing checks and failures;
- loaded timer, its latest completion/failure and an approximate next check;
- existing task controls and waiting phases;
- dependency health, with its own observation time.

A live process alone is not ready. A heartbeat older than 30 seconds is stale. An ongoing watcher reconciliation exceeding five minutes is degraded even if the heartbeat remains fresh; idle waiting without an active check is normal. Missing periodic completion beyond two configured intervals plus a small grace period is reported overdue. These observations diagnose delays rather than force cancellation. A card submission, Worker completion, business settlement and derived-view refresh are separate facts.

Logs are bounded to approximately 5 MiB per stream, retaining a recent tail; active watcher maintenance and tick/start operations enforce that bound. Log reading returns a bounded tail and never follows a symlink. Historical execution evidence referenced by business records must not be treated as disposable logs.

## Upgrade from unmanaged watch/tick

1. Record the existing wrapper, Node path, environment references, service intent and task/ticket identities. Preserve the complete task ledger and verify a consistent backup under the shared operation lock.
2. Stop the old timer and watcher and confirm both processes exited. Old code does not participate in the new watcher lease; arbitrary old/new watcher coexistence is unsupported.
3. Install the pinned package and retain the business wrapper. Keep task directories, active tickets, answers, quota reservations and frozen contracts unchanged. Do not move the old operation lock.
4. Install the new stopped deployment, verify its exact entrypoint and timer gates, then start it only when continuous operation was already authorized. There is no need to stop superagent merely to reload longrun.
5. Check ownership/readiness and startup catch-up. Validate the timer by allowing a real scheduled occurrence in an isolated test task. Validate card answers through the existing channel and record answer, Worker completion and automatic settlement times; do not manually collect and label that an immediate-settlement test.

Before new business writes, rollback can restore the earlier stopped deployment. After new answers or settlements arrive, preserve those facts; restoring an old task backup or downgrading solely because the schema number is unchanged is unsafe. This release does not migrate active task roots, promise zero-downtime replacement, or create a replacement ticket to hide a failed transition.

## Process identity and legacy deployments

From 0.2.0-alpha.2, new owner receipts use identity version 2: an application-scoped machine digest, OS boot-session ID, PID namespace, PID, process start and UID. Hostname is diagnostic and may change while the service runs. A receipt from an earlier boot of the same machine is exited; foreign machines, unknown namespaces and incomplete evidence remain unverified. Raw machine identifiers are not stored.

Legacy receipts remain readable. A same-boot owner with matching PID, start time and UID can be verified after a hostname change. A simultaneous hostname change and reboot cannot establish locality from a legacy receipt and remains unknown; do not delete locks or fabricate owner records. Stop/restart preflight both watcher and tick before changing running intent or disabling jobs, and recheck identity before signalling.

To recover a running legacy deployment whose hostname changed, use the new release's service manager to stop and uninstall the existing registration (preserving original installation options and all task records), then install and start the new release through the existing project wrapper. Do not replace a globally shared package while any dependent service is running. Unknown ownership must be investigated rather than bypassed.
