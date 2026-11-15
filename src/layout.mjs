import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TASKS_DIR = 'research/longrun';
const layouts = new AsyncLocalStorage();
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function assertRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`不安全的项目内路径：${String(value)}`);
  }
  return value;
}

/** Repository-relative paths only; symlinks are rejected even inside the repository. */
export function safePath(root, relative, { allowMissing = true } = {}) {
  assertRelative(relative);
  const base = fs.realpathSync(root), parts = relative.split('/');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT' || !allowMissing) throw error; continue; }
    if (stat.isSymbolicLink()) throw new Error(`路径不能经过符号链接：${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`路径父级不是目录：${relative}`);
  }
  return current;
}

function tasksDir(value) {
  assertRelative(value);
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (['.git', 'node_modules', 'working/longrun', 'longrun.config.json'].some(name => overlaps(value, name))) throw new Error('任务目录不能覆盖项目运行时、配置或依赖目录');
  return value;
}
function hasTasks(root, relative) {
  const directory = safePath(root, relative);
  if (!fs.existsSync(directory)) return false;
  if (!fs.statSync(directory).isDirectory()) throw new Error('任务根必须为目录');
  return fs.readdirSync(directory).some(name => {
    if (name === 'registry.json') {
      const value = JSON.parse(fs.readFileSync(safePath(root, `${relative}/${name}`), 'utf8'));
      return !Array.isArray(value.tasks) || value.tasks.length > 0;
    }
    if (name.startsWith('.')) return false;
    const entry = safePath(root, `${relative}/${name}`);
    return fs.statSync(entry).isDirectory() && ['task.json', 'task.md', 'state.json'].some(file => fs.existsSync(safePath(root, `${relative}/${name}/${file}`)));
  });
}

/** Pure read. Configuration changes are not a task-directory migration. */
export function resolveLayout(root) {
  root = fs.realpathSync(root);
  const scoped = layouts.getStore()?.get(root);
  if (scoped) return scoped;
  const configPath = safePath(root, 'longrun.config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { schemaVersion: 1, tasksDir: DEFAULT_TASKS_DIR };
  if (!object(config) || config.schemaVersion !== 1 || Object.keys(config).some(key => !['schemaVersion', 'tasksDir'].includes(key))) throw new Error('longrun.config.json 必须包含 schemaVersion: 1 和 tasksDir');
  const relative = tasksDir(config.tasksDir ?? DEFAULT_TASKS_DIR);
  const bindingPath = safePath(root, 'working/longrun/layout.json');
  if (fs.existsSync(bindingPath)) {
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    if (!object(binding) || binding.schemaVersion !== 1 || binding.tasksDir !== relative) throw new Error('LONGRUN_LAYOUT_CONFLICT: 任务目录已绑定；修改配置不会迁移已有任务，请恢复原 tasksDir');
  }
  if (relative !== DEFAULT_TASKS_DIR && hasTasks(root, DEFAULT_TASKS_DIR)) throw new Error('LONGRUN_LAYOUT_CONFLICT: 旧任务目录仍有任务，不能创建第二套注册表');
  const tasksDirectory = safePath(root, relative);
  if (fs.existsSync(tasksDirectory) && !fs.statSync(tasksDirectory).isDirectory()) throw new Error('任务根必须为目录');
  return Object.freeze({ schemaVersion: 1, root, tasksDir: relative, tasksDirectory, registryPath: safePath(root, `${relative}/registry.json`), bindingPath });
}

/** Capture one layout for all awaits in an operation. Nested trial projects stay independent. */
export function withTaskLayout(root, operation) {
  const layout = resolveLayout(root), map = new Map(layouts.getStore());
  map.set(layout.root, layout);
  return layouts.run(map, () => operation(layout));
}

/** Caller owns the existing project operation lock. Never invoked by status queries. */
export function bindTaskLayout(root) {
  const layout = resolveLayout(root);
  if (fs.existsSync(layout.bindingPath)) {
    const binding = JSON.parse(fs.readFileSync(layout.bindingPath, 'utf8'));
    if (binding.schemaVersion !== 1 || binding.tasksDir !== layout.tasksDir) throw new Error('LONGRUN_LAYOUT_CONFLICT: 任务目录绑定已改变');
    return layout;
  }
  fs.mkdirSync(path.dirname(layout.bindingPath), { recursive: true });
  const temporary = `${layout.bindingPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, tasksDir: layout.tasksDir }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, layout.bindingPath);
  } finally { fs.rmSync(temporary, { force: true }); }
  return layout;
}

export function freezeRunLayout(root, taskId, runId) {
  const { tasksDir: base } = resolveLayout(root);
  return checkedRunLayout({ schemaVersion: 1, tasksDir: base, taskBase: `${base}/${taskId}`, runBase: `${base}/${taskId}/runs/${runId}`, artifactBase: `${base}/${taskId}/artifacts` }, taskId, runId);
}
function checkedRunLayout(layout, taskId, runId) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(taskId ?? '') || !/^(R|RV)\d{4,}$/.test(runId ?? '')) throw new Error('Invalid frozen task/run identity');
  if (!object(layout) || layout.schemaVersion !== 1 || Object.keys(layout).some(key => !['schemaVersion', 'tasksDir', 'taskBase', 'runBase', 'artifactBase'].includes(key))) throw new Error('Invalid frozen layout');
  const base = tasksDir(layout.tasksDir);
  if (layout.taskBase !== `${base}/${taskId}` || layout.runBase !== `${base}/${taskId}/runs/${runId}` || layout.artifactBase !== `${base}/${taskId}/artifacts`) throw new Error('Frozen layout escapes its task/run');
  return Object.freeze({ ...layout });
}

/** Old drafts retain their original paths and contract hashes. */
export function frozenRunLayout(frozen) {
  const { taskId, runId } = frozen;
  return checkedRunLayout(frozen.layout ?? { schemaVersion: 1, tasksDir: DEFAULT_TASKS_DIR, taskBase: `${DEFAULT_TASKS_DIR}/${taskId}`, runBase: `${DEFAULT_TASKS_DIR}/${taskId}/runs/${runId}`, artifactBase: `${DEFAULT_TASKS_DIR}/${taskId}/artifacts` }, taskId, runId);
}
