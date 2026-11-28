import { readFileSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const positive = value => Number.isSafeInteger(value) && value > 0;
const uid = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) && !/^0+(?:-0+)*$/.test(value);
const validScope = scope => scope && /^sha256:[a-f\d]{64}$/.test(scope.machineId ?? '') && uuid(scope.bootSessionId)
  && (scope.pidNamespace === 'host' || /^pid:\[\d+\]$/.test(scope.pidNamespace ?? ''));
const hasV2 = owner => ['identityVersion', 'machineId', 'bootSessionId', 'pidNamespace'].some(key => Object.hasOwn(owner, key));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 }).trim();

export function readNativeMachineId(platform = process.platform, read = readFileSync, command = run) {
  let raw;
  if (platform === 'darwin') {
    raw = /"IOPlatformUUID"\s*=\s*"([a-f\d-]+)"/i.exec(command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1];
    if (!uuid(raw)) throw Error('Machine UUID unavailable');
  } else if (platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const candidate = read(file, 'utf8').trim(); if (/^[a-f\d]{32}$/i.test(candidate) && !/^0+$/.test(candidate)) { raw = candidate; break; } } catch { /* Try the standard fallback. */ }
    }
    if (!raw) throw Error('Machine ID unavailable');
  } else throw Error('Process identity platform unsupported');
  return `sha256:${createHash('sha256').update(`js-longrun/process-machine/v1\0${platform}\0${raw.toLowerCase()}`).digest('hex')}`;
}

export function readNativeScope(platform = process.platform, read = readFileSync, link = readlinkSync, command = run) {
  const linux = platform === 'linux';
  const scope = {
    machineId: readNativeMachineId(platform, read, command),
    bootSessionId: (linux ? read('/proc/sys/kernel/random/boot_id', 'utf8').trim() : command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).toLowerCase(),
    pidNamespace: linux ? link('/proc/self/ns/pid') : 'host',
  };
  // This display timestamp is legacy evidence only. Its absence must not discard
  // the stable v2 scope; old receipts still fail closed without it.
  try { scope.boot = command('/bin/ps', ['-p', '1', '-o', 'lstart=']); } catch { /* Legacy evidence unavailable. */ }
  return scope;
}

function nativeProcessInfo(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH' ? null : undefined; }
  const ps = field => spawnSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8', timeout: 5000 });
  const state = ps('stat'), birth = ps('lstart'), user = ps('uid');
  if ([state, birth, user].some(result => result.status !== 0)) return undefined;
  if (state.stdout.trim().startsWith('Z')) return null;
  if (!birth.stdout.trim() || !/^\d+$/.test(user.stdout.trim())) return undefined;
  return { pid, birth: birth.stdout.trim(), uid: Number(user.stdout.trim()) };
}

/** Injectable probes keep missing evidence distinct from an absent process. */
export function createProcessIdentityInspector({ scope = readNativeScope, processInfo = nativeProcessInfo, host = hostname } = {}) {
  const readScope = () => {
    let value;
    try { value = scope(); } catch { return undefined; }
    if (!validScope(value)) return undefined;
    let diagnosticHost;
    try { const name = host(); if (text(name)) diagnosticHost = name; } catch { /* Hostname is not v2 identity evidence. */ }
    return { ...value, host: diagnosticHost };
  };
  const processIdentity = (pid = process.pid) => {
    if (!positive(pid)) return null;
    const current = readScope();
    if (!current) return { pid, unknown: true };
    let info;
    try { info = processInfo(pid); } catch { return { pid, unknown: true }; }
    if (info === null) return null;
    if (!info || info.pid !== pid || !text(info.birth) || !uid(info.uid)) return { pid, unknown: true };
    return { ...info, ...current, identityVersion: 2 };
  };
  // Resolve machine scope before interpreting a locally absent PID as exited.
  processIdentity.scope = readScope;
  return { processIdentity, ownerState: owner => ownerState(owner, processIdentity) };
}

export function ownerState(owner, probe = processIdentity) {
  if (!owner) return { state: 'unobserved' };
  const unknown = () => ({ state: 'unknown', pid: owner.pid });
  const exited = () => ({ state: 'exited', pid: owner.pid });
  if (!positive(owner.pid) || !text(owner.birth) || !uid(owner.uid)) return unknown();
  const modern = hasV2(owner);
  if (modern && (owner.identityVersion !== 2 || !validScope(owner))) return unknown();
  if (!modern && (!text(owner.host) || !text(owner.boot))) return unknown();
  let current, actual, probed = false;
  try {
    // The fallback preserves custom probes returning complete identities. A null
    // probe without a separate scope cannot prove locality and remains unknown.
    if (typeof probe.scope === 'function') current = probe.scope();
    else { actual = probe(owner.pid); current = actual; probed = true; }
  } catch { return unknown(); }
  if (!current || current.unknown) return unknown();
  if (modern) {
    if (!validScope(current) || owner.machineId !== current.machineId) return unknown();
    if (owner.bootSessionId.toLowerCase() !== current.bootSessionId.toLowerCase()) return exited();
    if (owner.pidNamespace !== current.pidNamespace) return unknown();
  } else {
    if (!text(current.boot) || !text(current.host)) return unknown();
    // An old receipt cannot prove its machine across both rename and reboot.
    if (owner.boot !== current.boot) return owner.host === current.host ? exited() : unknown();
  }
  try { if (!probed) actual = probe(owner.pid); } catch { return unknown(); }
  if (actual === null) return exited();
  if (!actual || actual.unknown || actual.pid !== owner.pid || !text(actual.birth) || !uid(actual.uid)) return unknown();
  // Revalidate fresh scope when provided by the PID probe rather than treating
  // a change during inspection as permission to signal the process.
  if (modern && (!validScope(actual) || actual.machineId !== current.machineId || actual.bootSessionId.toLowerCase() !== current.bootSessionId.toLowerCase() || actual.pidNamespace !== current.pidNamespace)) return unknown();
  if (!modern && (actual.boot !== current.boot || !text(actual.host))) return unknown();
  if (actual.birth !== owner.birth) return exited();
  if (actual.uid !== owner.uid) return unknown();
  return { state: 'alive', pid: owner.pid };
}

export const { processIdentity } = createProcessIdentityInspector();
