import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessIdentityInspector, ownerState, processIdentity, readNativeMachineId } from '../src/process-identity.mjs';

const bootA = '12345678-1234-1234-1234-123456789abc';
const bootB = '87654321-4321-4321-4321-cba987654321';
const machineA = `sha256:${'a'.repeat(64)}`;
const machineB = `sha256:${'b'.repeat(64)}`;
const scope = { machineId: machineA, bootSessionId: bootA, pidNamespace: 'host', boot: 'Mon Nov 23 21:58:10 2026' };
const info = { pid: 1234, birth: 'Sat Nov 28 01:55:54 2026', uid: 501 };
const v2 = { ...scope, ...info, identityVersion: 2, host: 'old-host' };
const legacy = { ...info, host: 'old-host', boot: scope.boot };

function inspector(changes = {}) {
  return createProcessIdentityInspector({ scope: () => ({ ...scope }), processInfo: () => ({ ...info }), host: () => 'old-host', ...changes });
}

test('v2 captures stable scope and hostname changes do not change process ownership', () => {
  let host = 'old-host';
  const probe = inspector({ host: () => host });
  const recorded = probe.processIdentity(info.pid);
  assert.deepEqual(recorded, v2);
  host = 'new-host';
  assert.equal(probe.ownerState(recorded).state, 'alive');
  assert.equal(probe.processIdentity(info.pid).host, 'new-host');
  assert.deepEqual(recorded, v2, 'inspection never rewrites a receipt');
});

test('same machine prior boot is exited after reboot, even after rename or PID reuse', () => {
  let probes = 0;
  const probe = inspector({ scope: () => ({ ...scope, bootSessionId: bootB, boot: 'new boot' }), host: () => 'new-host', processInfo: () => { probes++; return { ...info, birth: 'new process' }; } });
  assert.equal(probe.ownerState(v2).state, 'exited');
  assert.equal(probes, 0, 'a proven prior boot does not query a reused PID');
});

test('foreign machine or PID namespace is unknown even if the local PID is absent', () => {
  for (const patch of [{ machineId: machineB }, { pidNamespace: 'pid:[42]' }]) {
    let probes = 0;
    const probe = inspector({ scope: () => ({ ...scope, ...patch }), processInfo: () => { probes++; return null; } });
    assert.equal(probe.ownerState(v2).state, 'unknown');
    assert.equal(probes, 0);
  }
});

test('same boot PID exit and reuse are distinguished from failed or denied probes', () => {
  assert.equal(inspector({ processInfo: () => null }).ownerState(v2).state, 'exited');
  assert.equal(inspector({ processInfo: () => ({ ...info, birth: 'new process' }) }).ownerState(v2).state, 'exited');
  for (const processInfo of [() => undefined, () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); }, () => ({ ...info, uid: 502 }), () => ({ ...info, birth: '' })]) {
    assert.equal(inspector({ processInfo }).ownerState(v2).state, 'unknown');
  }
});

test('unavailable scope never becomes an exited receipt or a v1 capture', () => {
  for (const getScope of [() => undefined, () => { throw Error('unavailable'); }, () => ({ ...scope, machineId: '' }), () => ({ ...scope, bootSessionId: 'invalid' })]) {
    const probe = inspector({ scope: getScope, processInfo: () => null });
    assert.equal(probe.ownerState(v2).state, 'unknown');
    assert.deepEqual(probe.processIdentity(info.pid), { pid: info.pid, unknown: true });
  }
});

test('partial, malformed and future v2 records cannot downgrade to legacy hostname matching', () => {
  for (const owner of [
    { ...legacy, identityVersion: 2 }, { ...legacy, machineId: machineA }, { ...v2, identityVersion: 3 },
    { ...v2, machineId: '' }, { ...v2, bootSessionId: '' }, { ...v2, pidNamespace: '' },
    { ...v2, birth: '' }, { ...v2, uid: -1 }, { ...v2, pid: 0 },
  ]) assert.equal(inspector().ownerState(owner).state, 'unknown');
});

test('legacy renamed receipt on the same boot remains alive without rewriting evidence', () => {
  const before = structuredClone(legacy);
  const probe = inspector({ host: () => 'new-host' });
  assert.equal(probe.ownerState(legacy).state, 'alive');
  assert.equal(inspector({ host: () => 'new-host', processInfo: () => null }).ownerState(legacy).state, 'exited');
  assert.equal(inspector({ host: () => 'new-host', processInfo: () => ({ ...info, birth: 'reused' }) }).ownerState(legacy).state, 'exited');
  assert.deepEqual(legacy, before);
});

test('legacy reboot is recoverable only with retained hostname evidence', () => {
  const rebooted = { ...scope, bootSessionId: bootB, boot: 'new boot' };
  assert.equal(inspector({ scope: () => rebooted }).ownerState(legacy).state, 'exited');
  assert.equal(inspector({ scope: () => rebooted, host: () => 'new-host', processInfo: () => null }).ownerState(legacy).state, 'unknown');
  for (const patch of [{ host: '' }, { boot: '' }, { birth: '' }, { uid: undefined }]) {
    assert.equal(inspector().ownerState({ ...legacy, ...patch }).state, 'unknown');
  }
});

test('custom probes must provide locality before reporting a missing PID as exited', () => {
  assert.equal(ownerState(v2, () => null).state, 'unknown');
  const absent = () => null;
  absent.scope = () => ({ ...scope, host: 'new-host' });
  assert.equal(ownerState(v2, absent).state, 'exited');
  const foreign = () => null;
  foreign.scope = () => ({ ...scope, host: 'old-host', machineId: machineB });
  assert.equal(ownerState(v2, foreign).state, 'unknown');
  assert.equal(ownerState(v2, () => ({ ...v2, host: 'new-host' })).state, 'alive');
  assert.equal(ownerState(null).state, 'unobserved');
});

test('scope changes during a PID probe are unknown rather than signal authorization', () => {
  const probe = () => ({ ...v2, bootSessionId: bootB });
  probe.scope = () => ({ ...scope, host: 'old-host' });
  assert.equal(ownerState(v2, probe).state, 'unknown');
  const legacyProbe = () => ({ ...v2, boot: 'changed during probe' });
  legacyProbe.scope = () => ({ ...scope, host: 'old-host' });
  assert.equal(ownerState(legacy, legacyProbe).state, 'unknown');
});

test('machine identity is an application-scoped digest and rejects unavailable native IDs', () => {
  const raw = '12345678-1234-1234-1234-123456789abc';
  const darwin = readNativeMachineId('darwin', undefined, () => `"IOPlatformUUID" = "${raw}"`);
  assert.match(darwin, /^sha256:[a-f\d]{64}$/);
  assert.equal(darwin.includes(raw), false);
  assert.equal(darwin, readNativeMachineId('darwin', undefined, () => `"IOPlatformUUID" = "${raw.toUpperCase()}"`));
  assert.throws(() => readNativeMachineId('darwin', undefined, () => 'no uuid'));
  assert.throws(() => readNativeMachineId('linux', () => '0'.repeat(32)));
  const reads = [];
  const linux = readNativeMachineId('linux', file => { reads.push(file); if (reads.length === 1) throw Error(); return 'a'.repeat(32); });
  assert.equal(reads.length, 2); assert.match(linux, /^sha256:[a-f\d]{64}$/); assert.notEqual(linux, darwin);
  assert.throws(() => readNativeMachineId('unsupported'));
});

test('native current process capture and ownership use the complete v2 identity', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const identity = processIdentity();
  assert.equal(identity.identityVersion, 2);
  assert.equal(identity.pid, process.pid);
  assert.equal(identity.uid, process.getuid());
  assert.equal(ownerState({ ...identity, host: 'renamed-diagnostic-only' }).state, 'alive');
  assert.equal(processIdentity(-1), null);
});
