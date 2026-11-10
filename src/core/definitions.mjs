import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLongrunLock } from '../lock.mjs';

export const TASK_TYPES = ['change-report@1', 'review-items@1'];
const CONTROLS = ['draft', 'enabled', 'paused', 'disabled'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function assertTaskId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('任务 ID 只能使用小写字母、数字和连字符，且以字母开头，最多 64 字符');
  return id;
}
function assertRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`不安全的项目内路径：${String(value)}`);
  }
  return value;
}
/** Resolve only repository-relative files. Reject symlinks, even internal ones. */
export function safePath(root, relative, { allowMissing = true } = {}) {
  assertRelative(relative);
  const base = fs.realpathSync(root), parts = relative.split('/');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`路径不能经过符号链接：${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`路径父级不是目录：${relative}`);
  }
  return current;
}
export function taskPaths(root, id) {
  assertTaskId(id);
  const relative = `research/longrun/${id}`;
  return Object.fromEntries([
    ['dir', relative], ['definition', `${relative}/task.json`], ['brief', `${relative}/task.md`],
    ['state', `${relative}/state.json`], ['runs', `${relative}/runs`], ['artifacts', `${relative}/artifacts`],
  ].map(([key, value]) => [key, safePath(root, value)]));
}
function registryPath(root) { return safePath(root, 'research/longrun/registry.json'); }
function readRegistry(root) {
  const file = registryPath(root);
  if (!fs.existsSync(file)) return { schemaVersion: 1, tasks: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'tasks'].includes(key)) || !Array.isArray(value.tasks)) throw new Error('长期任务注册表无效');
  value.tasks.forEach(assertTaskId);
  if (new Set(value.tasks).size !== value.tasks.length) throw new Error('长期任务注册表含重复 ID');
  return value;
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function validDate(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }

export function defaultDefinition(id, type = 'change-report@1') {
  assertTaskId(id);
  if (!TASK_TYPES.includes(type)) throw new Error(`未注册的任务类型：${type}`);
  return {
    schemaVersion: 1, id, type, revision: 1, brief: 'task.md', completion: { kind: 'until-disabled' },
    trigger: { kind: 'after-settlement', minIntervalHours: 72, timezone: 'Asia/Shanghai' },
    limits: { weeklyRuns: 4, weeklySubtasks: 0, maxSubtasksPerRun: 0, maxExecutionMinutes: 60, queueTimeoutHours: 24 },
    review: type === 'review-items@1' ? { mode: 'items', timeoutHours: 168, onTimeout: 'defer', allowReReview: true } : { mode: 'none' },
    executionProfile: 'local-worker@1', outputBinding: 'instance',
    notifications: { review: type === 'review-items@1' ? 'operator' : 'none', settled: 'none', failure: 'none' },
    inputs: [], parameters: type === 'review-items@1' ? { maxItems: 5 } : {},
  };
}

export function validateDefinition(definition) {
  const errors = [];
  const checkKeys = (value, keys, name) => {
    if (!object(value)) { errors.push(`${name} 必须是对象`); return false; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${name} 不支持字段 ${key}`);
    return true;
  };
  if (!checkKeys(definition, ['schemaVersion', 'id', 'type', 'revision', 'brief', 'completion', 'trigger', 'limits', 'review', 'executionProfile', 'outputBinding', 'notifications', 'inputs', 'parameters'], '任务定义')) return { ok: false, errors };
  const d = definition;
  try { assertTaskId(d.id); } catch (error) { errors.push(error.message); }
  if (d.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (!TASK_TYPES.includes(d.type)) errors.push(`未注册的任务类型：${d.type}`);
  if (!integer(d.revision, 1, 1_000_000)) errors.push('revision 必须为正整数');
  if (d.brief !== 'task.md') errors.push('brief 必须为 task.md');
  if (checkKeys(d.completion, ['kind'], 'completion') && d.completion.kind !== 'until-disabled') errors.push('completion 仅支持 until-disabled');
  if (checkKeys(d.trigger, ['kind', 'minIntervalHours', 'timezone', 'intervalHours', 'anchor'], 'trigger')) {
    try { new Intl.DateTimeFormat('en', { timeZone: d.trigger.timezone }).format(); if (typeof d.trigger.timezone !== 'string' || !d.trigger.timezone) throw new Error(); }
    catch { errors.push('trigger.timezone 必须为有效时区'); }
    if (d.trigger.kind === 'after-settlement') {
      if (!integer(d.trigger.minIntervalHours, 1, 87600)) errors.push('minIntervalHours 必须为 1–87600 小时');
      if ('intervalHours' in d.trigger || 'anchor' in d.trigger) errors.push('after-settlement 不接受 intervalHours / anchor');
    } else if (d.trigger.kind === 'fixed-interval') {
      if (!integer(d.trigger.intervalHours, 1, 87600) || !validDate(d.trigger.anchor) || !/(?:Z|[+-]\d\d:\d\d)$/.test(d.trigger.anchor)) errors.push('fixed-interval 需要有效 intervalHours 和带时区的 anchor');
      if ('minIntervalHours' in d.trigger) errors.push('fixed-interval 不接受 minIntervalHours');
    } else errors.push('trigger.kind 仅支持 after-settlement / fixed-interval');
  }
  if (checkKeys(d.limits, ['weeklyRuns', 'weeklySubtasks', 'maxSubtasksPerRun', 'maxExecutionMinutes', 'queueTimeoutHours'], 'limits')) {
    if (!integer(d.limits.weeklyRuns, 1, 1000)) errors.push('weeklyRuns 必须为 1–1000');
    if (d.limits.weeklySubtasks !== 0 || d.limits.maxSubtasksPerRun !== 0) errors.push('local-worker@1 不支持子任务，weeklySubtasks / maxSubtasksPerRun 必须为 0');
    if (!integer(d.limits.maxExecutionMinutes, 1, 60)) errors.push('maxExecutionMinutes 必须为 1–60');
    if (!integer(d.limits.queueTimeoutHours, 1, 168)) errors.push('queueTimeoutHours 必须为 1–168');
  }
  if (checkKeys(d.review, ['mode', 'timeoutHours', 'onTimeout', 'allowReReview'], 'review')) {
    if (d.type === 'review-items@1') {
      if (d.review.mode !== 'items' || !integer(d.review.timeoutHours, 1, 720) || d.review.onTimeout !== 'defer' || typeof d.review.allowReReview !== 'boolean') errors.push('review-items@1 需要 items 审核、1–720 小时期限、defer 过期策略和 allowReReview 布尔值');
    } else if (d.type === 'change-report@1' && (d.review.mode !== 'none' || Object.keys(d.review).some(key => key !== 'mode'))) errors.push('change-report@1 仅支持无需人工审核的 none 模式');
  }
  if (d.executionProfile !== 'local-worker@1') errors.push('executionProfile 仅支持已注册的 local-worker@1');
  if (d.outputBinding !== 'instance') errors.push('outputBinding 必须为 instance，不能覆盖其他实例或共享输出');
  if (checkKeys(d.notifications, ['review', 'settled', 'failure'], 'notifications')) {
    if (d.notifications.review !== (d.type === 'review-items@1' ? 'operator' : 'none')) errors.push('逐项审核通过已授权 operator 卡片，其余类型 review 通知必须为 none');
    if (d.notifications.settled !== 'none' || d.notifications.failure !== 'none') errors.push('本版本暂未实现业务结算／失败外发通知，必须为 none');
  }
  if (!Array.isArray(d.inputs) || d.inputs.length > 100) errors.push('inputs 必须为不超过 100 个项目相对文件路径');
  else {
    d.inputs.forEach(value => { try { assertRelative(value); } catch (error) { errors.push(error.message); } });
    if (new Set(d.inputs).size !== d.inputs.length) errors.push('inputs 不得重复');
  }
  if (checkKeys(d.parameters, d.type === 'review-items@1' ? ['maxItems'] : [], 'parameters') && d.type === 'review-items@1' && !integer(d.parameters.maxItems, 1, 10)) errors.push('maxItems 必须为 1–10');
  return { ok: errors.length === 0, errors };
}
function checkedDefinition(definition, id) {
  const result = validateDefinition(definition);
  if (definition?.id !== id) result.errors.push('定义 ID 与实例目录不一致');
  if (result.errors.length) throw new Error(result.errors.join('；'));
  return definition;
}
function checkInputs(root, definition) {
  for (const relative of definition.inputs) {
    const file = safePath(root, relative, { allowMissing: false });
    if (!fs.statSync(file).isFile()) throw new Error(`输入必须为普通文件：${relative}`);
  }
}
export function readDefinition(root, id) {
  const paths = taskPaths(root, id);
  const definition = checkedDefinition(JSON.parse(fs.readFileSync(paths.definition, 'utf8')), id);
  if (!fs.readFileSync(paths.brief, 'utf8').trim()) throw new Error('task.md 任务说明不能为空');
  checkInputs(root, definition);
  return definition;
}
export function weekId(now = new Date(), timezone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  return `${year}-W${String(Math.ceil(((day - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
export function initialState(id, now = new Date(), timezone = 'Asia/Shanghai') {
  assertTaskId(id);
  return { schemaVersion: 3, taskId: id, control: 'draft', round: 0, nextDueAt: null, running: null,
    week: { id: weekId(now, timezone), runs: 0, subtasks: 0 }, failures: 0, updatedAt: new Date(now).toISOString() };
}
function checkState(state, id) {
  if (!object(state) || state.schemaVersion !== 3 || state.taskId !== id || !CONTROLS.includes(state.control) || !integer(state.round, 0, Number.MAX_SAFE_INTEGER) || !object(state.week) || !integer(state.week.runs, 0, Number.MAX_SAFE_INTEGER) || !integer(state.week.subtasks, 0, Number.MAX_SAFE_INTEGER) || !integer(state.failures, 0, Number.MAX_SAFE_INTEGER) || state.nextDueAt !== null && !validDate(state.nextDueAt)) throw new Error(`任务 ${id} 的 state.json 无效`);
  return state;
}
export function loadState(root, id) { return checkState(JSON.parse(fs.readFileSync(taskPaths(root, id).state, 'utf8')), id); }
/** Atomic state write; caller must already hold the project lock for read-modify-write. */
export function saveState(root, state) {
  checkState(state, assertTaskId(state?.taskId));
  atomicJson(taskPaths(root, state.taskId).state, state);
  return state;
}

export async function createTask({ root, id, type = 'change-report@1', brief, definition, now = new Date() }) {
  assertTaskId(id);
  const d = checkedDefinition(structuredClone(definition ?? defaultDefinition(id, type)), id);
  if (typeof brief !== 'string' || !brief.trim()) throw new Error('需要非空的任务说明 brief');
  checkInputs(root, d);
  safePath(root, 'working/longrun/control-lock.sqlite3');
  return withLongrunLock(root, () => {
    const paths = taskPaths(root, id), registry = readRegistry(root);
    if (registry.tasks.includes(id) || fs.existsSync(paths.dir)) throw new Error(`任务 ${id} 已存在，不能覆盖`);
    const state = initialState(id, now, d.trigger.timezone);
    const staging = safePath(root, `research/longrun/.create-${id}-${randomUUID()}`);
    let renamed = false;
    try {
      fs.mkdirSync(staging, { recursive: true });
      atomicJson(path.join(staging, 'task.json'), d);
      fs.writeFileSync(path.join(staging, 'task.md'), `${brief.trim()}\n`, { flag: 'wx' });
      atomicJson(path.join(staging, 'state.json'), state);
      fs.mkdirSync(path.join(staging, 'runs'));
      fs.mkdirSync(path.join(staging, 'artifacts'));
      fs.renameSync(staging, paths.dir); renamed = true;
      atomicJson(registryPath(root), { schemaVersion: 1, tasks: [...registry.tasks, id].sort() });
      return { definition: d, state, paths };
    } catch (error) {
      if (renamed) fs.rmSync(paths.dir, { recursive: true, force: true });
      throw error;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}

/** Broken registered instances are surfaced independently instead of blocking all tasks. */
export function listTasks(root) {
  const registry = readRegistry(root), rows = [];
  for (const id of registry.tasks) {
    let state;
    try { state = loadState(root, id); }
    catch (error) { rows.push({ id, legacy: false, control: 'invalid', error: error.message }); continue; }
    const row = { id, legacy: false, control: state.control, nextDueAt: state.nextDueAt, running: state.running };
    try { rows.push({ ...row, type: readDefinition(root, id).type }); }
    catch (error) { rows.push({ ...row, error: error.message }); }
  }
  return rows;
}

async function changeControl({ root, id, reason, now = new Date() }, target) {
  assertTaskId(id);
  safePath(root, 'working/longrun/control-lock.sqlite3');
  return withLongrunLock(root, () => {
    if (!readRegistry(root).tasks.includes(id)) throw new Error(`任务 ${id} 尚未注册`);
    const state = loadState(root, id);
    let definition;
    if (target === 'enabled') {
      definition = readDefinition(root, id);
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('启用需要记录当前授权依据 reason');
      state.authorization = { reason: reason.trim(), at: new Date(now).toISOString() };
      state.control = 'enabled';
    } else if (target === 'resume') {
      if (state.control !== 'paused' || !state.authorization) throw new Error('只有已授权后暂停的任务才能恢复；草稿或已禁用任务请明确启用');
      definition = readDefinition(root, id);
      state.control = 'enabled';
    } else {
      if (target === 'paused' && !['enabled', 'paused'].includes(state.control)) throw new Error('只有启用中的任务才能暂停');
      state.control = target;
    }
    if (state.control === 'enabled') {
      state.failures = 0;
      const firstDue = definition.trigger.kind === 'fixed-interval' ? Math.max(new Date(now).getTime(), Date.parse(definition.trigger.anchor)) : new Date(now).getTime();
      state.nextDueAt ??= new Date(firstDue).toISOString();
    }
    state.controlReason = state.control === 'enabled' ? null : reason?.trim() || (state.control === 'paused' ? '用户暂停' : '用户禁用');
    state.updatedAt = new Date(now).toISOString();
    return saveState(root, state);
  });
}
export const enableTask = options => changeControl(options, 'enabled');
export const pauseTask = options => changeControl(options, 'paused');
export const resumeTask = options => changeControl(options, 'resume');
export const disableTask = options => changeControl(options, 'disabled');
