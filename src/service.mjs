import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { listTasks, loadState } from './core/definitions.mjs';
import { resolveLayout } from './layout.mjs';
import { resolveRuntimeLayout, checkedPath, readRuntimeJSON, writeRuntimeJSON, ensureRuntime, acquireRuntimeLock,
  processIdentity, ownerState, serviceError, runtimeLogPaths, boundRuntimeLogs } from './service-runtime.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const serviceIdPattern = /^[0-9a-f-]{36}$/;

export function longrunServicePlist(manifest, component) {
  const log = runtimeLogPaths({ logDir: manifest.logDir }, component);
  const environment = { ...manifest.environment, JS_LONGRUN_HOME: manifest.runtimeHome, JS_LONGRUN_SERVICE_ID: manifest.installId,
    LONGRUN_OPEN_ROUNDS: component === 'tick' && manifest.openRounds ? '1' : '0' };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(manifest.labels[component])}</string>\n<key>WorkingDirectory</key><string>${xml(manifest.projectRoot)}</string>\n<key>ProgramArguments</key><array>${[manifest.nodePath, manifest.entrypoint, ...manifest.entryArgs, component].map(value => `<string>${xml(value)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>\n${component === 'watch'
    ? '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>'
    : `<key>RunAtLoad</key><false/>\n<key>StartInterval</key><integer>${manifest.intervalSeconds}</integer>`}\n<key>ExitTimeOut</key><integer>60</integer>\n<key>StandardOutPath</key><string>${xml(log.stdout)}</string>\n<key>StandardErrorPath</key><string>${xml(log.stderr)}</string>\n</dict></plist>\n`;
}

function launchctlRunner(args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000 }); }
function missingJob(result) { return /could not find service|no such process|service not found/i.test(`${result.stderr ?? ''} ${result.stdout ?? ''}`) || [3, 113].includes(result.status); }
// Package managers may hard-link installed executables. These paths are only
// inspected/read, unlike runtime control files that this manager can overwrite.
function regularFile(file) { checkedPath(file, { allowHardLinks: true }); if (!fs.statSync(file).isFile()) throw new Error('Expected a regular file'); return file; }
function entryDigest(manifest) { return sha(fs.readFileSync(regularFile(manifest.entrypoint))); }

/** Manages only longrun's existing watch + periodic tick; never initializes superagent. */
export function createLongrunServiceManager(options = {}, dependencies = {}) {
  const layout = resolveRuntimeLayout(options);
  const platform = dependencies.platform ?? process.platform;
  const uid = dependencies.uid ?? process.getuid?.();
  const domain = `gui/${uid}`;
  const labels = { watch: `io.js-longrun.${layout.key}.watch`, tick: `io.js-longrun.${layout.key}.tick` };
  const launchAgentsDir = path.resolve(options.launchAgentsDir ?? path.join(os.homedir(), 'Library/LaunchAgents'));
  const paths = Object.fromEntries(Object.entries(labels).map(([kind, label]) => [kind, path.join(launchAgentsDir, `${label}.plist`)]));
  const runner = dependencies.runLaunchctl ?? launchctlRunner;
  const probe = dependencies.processIdentity ?? processIdentity;
  const now = dependencies.now ?? Date.now;
  const signal = dependencies.signal ?? ((pid, value) => process.kill(pid, value));
  const sleep = dependencies.sleep ?? delay;
  const timeoutMs = options.timeoutMs ?? 30_000;
  function requirePlatform() { if (platform !== 'darwin' || !Number.isSafeInteger(uid)) throw serviceError('LONGRUN_UNSUPPORTED_PLATFORM', 'Managed services currently require a macOS user login session; foreground watch/tick remain available'); }
  function launch(args, { absentOK = false } = {}) {
    const result = runner(args);
    if (result.error || result.status !== 0) {
      if (absentOK && missingJob(result)) return result;
      throw serviceError('LONGRUN_LAUNCHD_ERROR', `launchctl ${args[0]} failed (${result.status ?? 'unavailable'})`);
    }
    return result;
  }
  function loaded(kind) {
    if (platform !== 'darwin') return { supported: false, loaded: false, running: false, pid: null };
    const result = runner(['print', `${domain}/${labels[kind]}`]);
    if (result.status !== 0) return { supported: true, loaded: false, running: false, pid: null, ...(missingJob(result) ? {} : { error: 'launchd-unavailable' }) };
    const match = /\bpid\s*=\s*(\d+)/.exec(result.stdout ?? '');
    const pid = match ? Number(match[1]) : null;
    return { supported: true, loaded: true, running: !!pid, pid };
  }
  function manifest(required = false) {
    const value = readRuntimeJSON(layout.manifestPath);
    if (!value) { if (required) throw serviceError('LONGRUN_NOT_INSTALLED', 'Install the longrun service first'); return null; }
    if (value.schemaVersion !== 1 || value.projectRoot !== layout.projectRoot || value.runtimeDir !== layout.runtimeDir || !serviceIdPattern.test(value.installId ?? '')
      || JSON.stringify(value.labels) !== JSON.stringify(labels) || JSON.stringify(value.plistPaths) !== JSON.stringify(paths)) {
      throw serviceError('LONGRUN_SERVICE_CONFLICT', 'Service manifest does not match this project or installation directory');
    }
    return value;
  }
  function assertOwnedFiles(value) {
    for (const kind of ['watch', 'tick']) {
      checkedPath(paths[kind]);
      if (!fs.existsSync(paths[kind]) || sha(fs.readFileSync(paths[kind])) !== value.plistHashes[kind]) throw serviceError('LONGRUN_SERVICE_CONFLICT', 'A LaunchAgent is missing or was changed outside this manager');
    }
  }
  function readOwner(kind) {
    const value = readRuntimeJSON(kind === 'watch' ? layout.ownerPath : layout.tickOwnerPath);
    if (value && (value.projectRoot !== layout.projectRoot || value.runtimeDir !== layout.runtimeDir || value.kind !== kind)) throw serviceError('LONGRUN_UNKNOWN_OWNER', 'Process ownership belongs to another deployment');
    return value;
  }
  function processReport(kind, launchState = loaded(kind)) {
    const owner = readOwner(kind), process = ownerState(owner, probe);
    // A loaded PID without a matching receipt is not safe to stop or replace.
    if (launchState.pid && (process.state !== 'alive' || launchState.pid !== owner?.pid)) {
      if (!probe(launchState.pid)) return { state: 'exited', pid: launchState.pid, owner };
      return { state: 'unknown', pid: launchState.pid, owner };
    }
    return { ...process, owner };
  }
  function assertNoLiveProcesses() {
    for (const kind of ['watch', 'tick']) {
      const state = processReport(kind);
      if (state.state === 'alive') throw serviceError('LONGRUN_SERVICE_RUNNING', 'Stop the longrun service before changing installation');
      if (state.state === 'unknown') throw serviceError('LONGRUN_UNKNOWN_OWNER', 'An unverified process may still own this project');
    }
  }
  function taskStatus() {
    const read = options.readTaskStatus ?? (() => listTasks(layout.projectRoot).map(row => {
      try { const state = loadState(layout.projectRoot, row.id); return { taskId: row.id, control: state.control, status: state.status,
        nextDueAt: state.nextDueAt, running: state.running ? { runId: state.running.runId, phase: state.running.phase } : null,
        ...(row.error ? { error: 'definition-invalid' } : {}) }; }
      catch { return { taskId: row.id, error: 'state-unavailable' }; }
    }));
    try { return { available: true, entries: read() }; }
    catch { return { available: false, reason: 'task-status-unavailable' }; }
  }
  function status() {
    const value = manifest(), watch = loaded('watch'), tick = loaded('tick');
    const watchOwner = processReport('watch', watch), tickOwner = processReport('tick', tick);
    const watchObservation = readRuntimeJSON(layout.watchPath), tickObservation = readRuntimeJSON(layout.tickPath);
    let currentTasksDir, entryMatches = true;
    try { currentTasksDir = resolveLayout(layout.projectRoot).tasksDir; } catch { currentTasksDir = null; }
    if (value) { try { entryMatches = entryDigest(value) === value.entryDigest && value.packageVersion === packageVersion; } catch { entryMatches = false; } }
    return { schemaVersion: 1, installed: !!value, intent: value?.intent ?? 'uninstalled', projectRoot: layout.projectRoot,
      runtimeDir: layout.runtimeDir, packageVersion, installedVersion: value?.packageVersion ?? null,
      tasksDir: currentTasksDir, installedTasksDir: value?.tasksDir ?? null, configurationMatches: !value || (currentTasksDir === value.tasksDir && entryMatches),
      entrypoint: value?.entrypoint ?? null, intervalSeconds: value?.intervalSeconds ?? null, openRounds: value?.openRounds ?? false,
      labels, plistPaths: paths, observedAt: new Date(now()).toISOString(),
      watch: { ...watch, process: watchOwner.state, runId: watchOwner.owner?.runId ?? null, observation: watchObservation },
      tick: { ...tick, process: tickOwner.state, runId: tickOwner.owner?.runId ?? null, observation: tickObservation },
      tasks: taskStatus(),
    };
  }
  async function health({ dependency = true } = {}) {
    const state = status(), reasons = [];
    const observation = state.watch.observation;
    const validOwner = observation && observation.runId === state.watch.runId && observation.pid === readOwner('watch')?.pid;
    const heartbeatTime = Date.parse(observation?.heartbeatAt), age = now() - heartbeatTime;
    const fresh = validOwner && Number.isFinite(age) && age >= -1000 && age <= 30_000;
    let localState = !state.installed ? 'not-installed' : state.intent === 'stopped' ? 'stopped' : 'healthy';
    if (state.installed && state.intent === 'running') {
      if (state.watch.process !== 'alive') reasons.push('watch-owner-unverified-or-exited');
      if (!fresh) reasons.push('watch-heartbeat-stale-or-unobserved');
      if (observation?.phase !== 'ready') reasons.push('watch-startup-not-ready');
      if (observation?.lastError) reasons.push('watch-check-failed');
      const checkingSince = Date.parse(observation?.checkStartedAt);
      if (Number.isFinite(checkingSince) && now() - checkingSince > (options.watchCheckTimeoutMs ?? 300_000)) reasons.push('watch-check-overdue');
      if (!state.tick.loaded) reasons.push('periodic-tick-not-loaded');
      if (!state.configurationMatches) reasons.push('installed-entry-package-or-task-layout-changed');
      if (state.tick.observation?.phase === 'failed' || state.tick.observation?.phase === 'degraded') reasons.push('last-periodic-check-failed');
      const lastTick = Date.parse(state.tick.observation?.finishedAt ?? manifest()?.startedAt);
      if (Number.isFinite(lastTick) && now() - lastTick > (state.intervalSeconds * 2 + 60) * 1000 && state.tick.process !== 'alive') reasons.push('periodic-check-overdue');
      if (reasons.length) localState = 'degraded';
    }
    if (state.intent === 'stopped' && [state.watch.process, state.tick.process].some(value => ['alive', 'unknown'].includes(value))) { localState = 'stopping'; reasons.push('process-exit-pending'); }
    let dependencyHealth = { state: 'not-requested', healthy: null };
    if (dependency) {
      try {
        const sdk = dependencies.superagent ?? await import('js-superagent');
        if (typeof sdk.createServiceManager !== 'function') dependencyHealth = { state: 'unavailable', healthy: null, reason: 'public-health-api-unavailable' };
        else {
          const report = await sdk.createServiceManager({ projectRoot: layout.projectRoot }).health();
          dependencyHealth = { state: report.state ?? 'unobserved', healthy: report.healthy === true, observedAt: report.observedAt ?? null,
            lastHeartbeatAt: report.lastHeartbeatAt ?? null, reason: report.reason ?? null };
        }
      } catch { dependencyHealth = { state: 'unavailable', healthy: null, reason: 'dependency-health-unavailable' }; }
    }
    const healthy = localState === 'healthy' && (!dependency || dependencyHealth.healthy === true);
    return { ...state, state: localState === 'healthy' && !healthy ? 'degraded' : localState, healthy, localState, reasons,
      heartbeatAgeMs: Number.isFinite(age) ? Math.max(0, age) : null, dependency: dependencyHealth,
      nextCheckEstimate: state.installed && state.intent === 'running' ? new Date((Date.parse(state.tick.observation?.finishedAt ?? manifest()?.startedAt) || now()) + state.intervalSeconds * 1000).toISOString() : null,
      timing: 'Login-session timer; sleep and logout can delay execution. Task due times remain business state.' };
  }
  function installationPlan() {
    const entrypoint = fs.realpathSync(path.resolve(options.entrypoint ?? fileURLToPath(new URL('../bin/js-longrun.mjs', import.meta.url))));
    const nodePath = fs.realpathSync(path.resolve(options.nodePath ?? process.execPath));
    regularFile(entrypoint); regularFile(nodePath);
    const intervalSeconds = options.intervalSeconds ?? 3600;
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 31_536_000) throw new Error('intervalSeconds must be an integer between 1 and 31536000');
    const entryArgs = options.entryArgs ?? ['--project', layout.projectRoot];
    if (!Array.isArray(entryArgs) || entryArgs.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('entryArgs must be an array of strings');
    if (options.openRounds !== undefined && typeof options.openRounds !== 'boolean') throw new Error('openRounds must be a boolean');
    const environment = { PATH: `${path.dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`, ...options.environment };
    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(?:JS_)?LONGRUN_|TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Use explicit non-secret environment settings; service ownership variables are reserved');
    }
    const result = { schemaVersion: 1, installId: randomUUID(), projectRoot: layout.projectRoot, runtimeHome: layout.runtimeHome, runtimeDir: layout.runtimeDir,
      tasksDir: resolveLayout(layout.projectRoot).tasksDir,
      packageVersion, nodePath, entrypoint, entryArgs, intervalSeconds, openRounds: options.openRounds ?? false, environment,
      labels, plistPaths: paths, logDir: layout.logDir, intent: 'stopped', installedAt: new Date(now()).toISOString() };
    result.entryDigest = entryDigest(result);
    result.plistHashes = Object.fromEntries(['watch', 'tick'].map(kind => [kind, sha(longrunServicePlist(result, kind))]));
    return result;
  }
  async function controlled(fn) { requirePlatform(); const release = acquireRuntimeLock(layout, 'control'); try { return await fn(); } finally { release(); } }
  async function install() { return controlled(async () => {
    const previous = manifest();
    if (previous) assertOwnedFiles(previous);
    assertNoLiveProcesses();
    for (const kind of ['watch', 'tick']) {
      if (loaded(kind).loaded) throw serviceError('LONGRUN_SERVICE_RUNNING', 'Unload the previous longrun installation before installing');
      if (!previous && fs.existsSync(paths[kind])) throw serviceError('LONGRUN_SERVICE_CONFLICT', 'Refusing to replace an unowned LaunchAgent');
    }
    const value = installationPlan();
    checkedPath(launchAgentsDir, { directory: true }); fs.mkdirSync(launchAgentsDir, { recursive: true, mode: 0o700 });
    ensureRuntime(layout); boundRuntimeLogs(layout);
    const originals = Object.fromEntries(['watch', 'tick'].map(kind => [kind, previous ? fs.readFileSync(paths[kind]) : null]));
    try {
      for (const kind of ['watch', 'tick']) { launch(['disable', `${domain}/${labels[kind]}`]); checkedPath(paths[kind]); fs.writeFileSync(paths[kind], longrunServicePlist(value, kind), { mode: 0o600, flag: previous ? 'w' : 'wx' }); }
      writeRuntimeJSON(layout.manifestPath, value);
    } catch (error) {
      for (const kind of ['watch', 'tick']) { if (originals[kind]) fs.writeFileSync(paths[kind], originals[kind]); else if (fs.existsSync(paths[kind]) && sha(fs.readFileSync(paths[kind])) === value.plistHashes[kind]) fs.unlinkSync(paths[kind]); }
      throw error;
    }
    return status();
  }); }
  async function startControlled() {
    const value = manifest(true); assertOwnedFiles(value);
    if (entryDigest(value) !== value.entryDigest || value.packageVersion !== packageVersion) throw serviceError('LONGRUN_INSTALLATION_CHANGED', 'Installed entry or package changed; stop and install this version before starting');
    if (resolveLayout(layout.projectRoot).tasksDir !== value.tasksDir) throw serviceError('LONGRUN_INSTALLATION_CHANGED', 'Task layout changed; reinstall the stopped service before starting');
    const prior = status();
    const ready = state => {
      const observation = state.watch.observation, age = now() - Date.parse(observation?.heartbeatAt);
      return state.watch.loaded && state.watch.process === 'alive' && observation?.runId === state.watch.runId
        && observation?.phase === 'ready' && Number.isFinite(age) && age >= -1000 && age <= 30_000 && state.tick.loaded;
    };
    for (const kind of ['watch', 'tick']) {
      if (prior[kind].process === 'unknown') throw serviceError('LONGRUN_UNKNOWN_OWNER', 'An unverified process may still own this project');
      if (prior[kind].process === 'alive' && (prior.intent !== 'running' || (kind === 'watch' && !prior.watch.loaded))) {
        throw serviceError('LONGRUN_SERVICE_RUNNING', 'An existing foreground or stopping process must drain before managed start');
      }
    }
    if (prior.intent === 'running' && ready(prior)) return prior;
    if (prior.intent !== 'running') {
      writeRuntimeJSON(layout.manifestPath, { ...value, intent: 'running', intentToken: randomUUID(), startedAt: new Date(now()).toISOString() });
    }
    boundRuntimeLogs(layout);
    try {
      for (const kind of ['tick', 'watch']) {
        launch(['enable', `${domain}/${labels[kind]}`]);
        const state = loaded(kind);
        if (!state.loaded) launch(['bootstrap', domain, paths[kind]]);
        else if (kind === 'watch' && !state.running) {
          // SuccessfulExit:false leaves a cleanly exited job loaded and idle.
          // Start it explicitly, without -k (never kill an existing process).
          const process = processReport(kind, state);
          if (process.state === 'unknown') throw serviceError('LONGRUN_UNKNOWN_OWNER', 'Idle watcher ownership is unverified');
          if (process.state !== 'alive') launch(['kickstart', `${domain}/${labels[kind]}`]);
        }
      }
      const deadline = now() + timeoutMs;
      while (true) {
        const state = status();
        if (ready(state)) return state;
        if (now() >= deadline) throw serviceError(state.watch.process === 'unknown' ? 'LONGRUN_UNKNOWN_OWNER' : 'LONGRUN_START_PENDING', 'Service loaded but successful owned watcher startup has not been observed');
        await sleep(100);
      }
    } catch (error) {
      // Preserve truthful desired-running intent for launchd's existing restart behavior.
      // The caller can stop it explicitly; never claim a failed startup is ready.
      throw error;
    }
  }
  async function stopControlled() {
    const value = manifest(true); assertOwnedFiles(value);
    writeRuntimeJSON(layout.manifestPath, { ...value, intent: 'stopped', intentToken: randomUUID(), stoppedRequestedAt: new Date(now()).toISOString() });
    for (const kind of ['tick', 'watch']) launch(['disable', `${domain}/${labels[kind]}`]);
    const stoppingOwners = Object.fromEntries(['watch', 'tick'].map(kind => [kind, readOwner(kind)]));
    const watch = processReport('watch');
    if (watch.state === 'unknown') throw serviceError('LONGRUN_UNKNOWN_OWNER', 'Refusing to signal an unverified watcher');
    if (watch.state === 'alive') signal(watch.owner.pid, 'SIGTERM');
    const deadline = now() + timeoutMs;
    while (true) {
      const states = ['watch', 'tick'].map(kind => {
        const state = processReport(kind), previous = stoppingOwners[kind];
        if (state.state === 'unknown' && previous?.pid === state.pid) {
          const verified = ownerState(previous, probe);
          if (verified.state !== 'unknown') return verified;
        }
        return state;
      });
      if (states.some(state => state.state === 'unknown')) throw serviceError('LONGRUN_UNKNOWN_OWNER', 'Process ownership is unverified; no process was force-killed');
      if (states.every(state => state.state !== 'alive')) break;
      if (now() >= deadline) throw serviceError('LONGRUN_STOP_PENDING', 'Stopped intent saved; waiting for the owned watcher/tick to drain');
      await sleep(100);
    }
    for (const kind of ['tick', 'watch']) if (loaded(kind).loaded) launch(['bootout', `${domain}/${labels[kind]}`], { absentOK: true });
    const final = status();
    if (final.watch.loaded || final.tick.loaded || ['alive', 'unknown'].includes(final.watch.process) || ['alive', 'unknown'].includes(final.tick.process)) throw serviceError('LONGRUN_STOP_PENDING', 'Service unload or process exit is not yet confirmed');
    return final;
  }
  const start = () => controlled(startControlled);
  const stop = () => controlled(stopControlled);
  const restart = () => controlled(async () => { await stopControlled(); return startControlled(); });
  async function uninstall() { return controlled(async () => {
    const value = manifest(true); assertOwnedFiles(value); await stopControlled(); assertNoLiveProcesses();
    for (const kind of ['watch', 'tick']) fs.unlinkSync(paths[kind]);
    fs.unlinkSync(layout.manifestPath);
    // Business records, runtime observations, logs and stable binding deliberately remain.
    return status();
  }); }
  function logs({ component = 'watch', stream = 'stdout', lines = 100 } = {}) {
    if (!['stdout', 'stderr'].includes(stream) || !Number.isSafeInteger(lines) || lines < 1 || lines > 1000) throw new Error('Invalid log selection');
    const file = runtimeLogPaths(layout, component)[stream]; checkedPath(file);
    if (!fs.existsSync(file)) return { file, text: '', available: false };
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd), bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const read = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length));
      return { file, available: true, text: bytes.subarray(0, read).toString('utf8').split('\n').slice(-lines - 1).join('\n'), truncated: stat.size > bytes.length };
    } finally { fs.closeSync(fd); }
  }
  return { layout, install, start, stop, restart, status, health, logs, uninstall };
}
