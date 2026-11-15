# Real timer fallback smoke

The regular test suite uses isolated fixtures and injected service operations. This optional check additionally installs and runs two real macOS login-session services for a fresh temporary project, then stops and removes only those services. Run it explicitly in an authorized local login session:

```sh
node scripts/service-smoke.mjs --run --package /absolute/installed/js-longrun
```

The package must already be installed and export the layout, service and service-runtime APIs. The script resolves public exports from that package's manifest, so it can exercise an installed tarball without depending on a sibling source checkout. The script itself is a repository development tool and is not included in the npm package.

The fixture uses `automation/tasks`, a separate machine directory, an empty-input report and a weekly allowance of one run. It starts the real managed watcher before creating and enabling the task. Only the real periodic launchd entry may submit the synthetic ticket. The fake ticket remains queued for 3.5 seconds, then appears completed based on wall-clock time; its result files are in an isolated workspace. SDK invalidation callbacks are deliberately suppressed.

The check requires all of the following:

- The watcher starts successfully and observes the queued ticket.
- A real periodic tick opens the first round.
- A later real periodic tick collects and settles the completed result despite the suppressed SDK event; the watcher does not receive credit for the settlement.
- Another periodic tick holds without changing state, submitting twice or spending another run.
- The settlement receipt is applied, artifact validation succeeds and local service health is healthy.
- Both uniquely owned services unload and their processes exit before the temporary project is deleted.

No model, real superagent SDK client, account, message or production project is used. The main process never calls manual tick/collect. Dependency health is explicitly excluded from the synthetic check. Failure preserves the fixture and prints diagnostics; if process ownership or shutdown cannot be proved, it leaves the files in place and reports pending cleanup.

## Recorded acceptance

On 2026-11-15, the installed `0.2.0-alpha.0` candidate passed with these UTC observations:

| Observation | Time |
|---|---|
| Managed watcher ready | 11:04:19.294 |
| Periodic tick opened R0001 | 11:04:21.315 |
| Synthetic ticket became complete | 11:04:24.813 |
| Periodic fallback settled R0001 | 11:04:31.403 |
| Later timer held without another charge | 11:04:41.500 |

The final state had one round, one weekly run, one submission, no active ticket and an applied settlement receipt. Watcher settlements remained zero. The fixture services and temporary files were removed after verified shutdown.

The configured interval was two seconds; observed repeated launches were about ten seconds apart because launchd controls actual process scheduling. This is evidence of automatic timer execution and missed-event fallback, not an exact scheduling guarantee. It does not establish real model execution or Feishu card handling; those require separate authorized end-to-end acceptance.
