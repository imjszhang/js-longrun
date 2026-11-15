import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as definitions from './core/definitions.mjs';
import * as runtime from './core/runtime.mjs';
import { tickProject, startProjectWatcher } from './project.mjs';
import { serviceClient, watchServiceClient } from './superagent.mjs';
import { trialTask } from './core/trial.mjs';
import { createLongrunServiceManager } from './service.mjs';
import { runManagedWatcher, recordManagedTick } from './service-runtime.mjs';
import { withTaskLayout } from './layout.mjs';

const commands = new Set(['types', 'design', 'create', 'list', 'validate', 'plan', 'trial', 'enable', 'disable', 'pause', 'resume', 'status', 'verify', 'round', 'rereview', 'collect', 'tick', 'watch', 'reply', 'service']);
const flagCommands = {
  project: null, all: ['tick', 'watch'], type: ['design', 'create'], brief: ['create'], goal: ['create'], definition: ['create'],
  reason: ['enable', 'disable', 'pause'], result: ['trial'], answers: ['trial', 'reply'], memory: ['trial'], ids: ['rereview'],
  entrypoint: ['service'], 'entry-args': ['service'], node: ['service'], 'runtime-home': ['service'],
  'interval-seconds': ['service'], 'open-rounds': ['service'],
  component: ['service'], stream: ['service'], lines: ['service'],
};
const printJSON = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const HELP = `js-longrun — persistent project tasks\n\nUsage: js-longrun [--project <directory>] <command> [task-id] [options]\n\nCommands:\n  service install|start|stop|restart|status|health|logs|uninstall\n  types | list\n  design <id> [--type review-items@1|change-report@1]\n  create <id> [--type <type>] --brief <file> | --goal <text> [--definition <file>]\n  validate | plan | status | verify <id>\n  trial <id> --result <file> [--answers <file>] [--memory <file>]\n  enable <id> --reason <authorization>\n  disable | pause <id> [--reason <text>]\n  resume | round | collect <id>\n  rereview <id> --ids R0001:I0001,R0002:I0001\n  reply <id> --answers <file>\n  tick [id | --all] | watch [--all]\n\nProject defaults to the current directory. Create stays draft; enable does not start work.\nTick collects by default; LONGRUN_OPEN_ROUNDS=1 permits eligible enabled tasks to start.\nWatch collects only. Trial uses supplied local fixtures and sends no messages.\nService install options: --entrypoint <file> --entry-args <JSON-array> --node <file>\n  --interval-seconds <seconds> --open-rounds true|false --runtime-home <directory>.\nInstall does not start services or enable tasks. Service status/health are read-only.\n--help, -h, --version, -v are read-only.\n`;

export function parseArguments(argv, cwd = process.cwd()) {
  const flags = new Map(), positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const key = token.slice(2);
    if (!token.startsWith('--') || !Object.hasOwn(flagCommands, key)) throw new Error(`Unknown option: ${token}`);
    if (flags.has(key)) throw new Error(`Duplicate option: --${key}`);
    if (key === 'all') { flags.set(key, 'true'); continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    flags.set(key, value);
  }
  const [command, taskId] = positional;
  if (!commands.has(command)) throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  if (positional.length > 2) throw new Error('Too many positional arguments');
  for (const key of flags.keys()) if (flagCommands[key] && !flagCommands[key].includes(command)) throw new Error(`--${key} is not supported by ${command}`);
  if (['types', 'list'].includes(command) && taskId) throw new Error(`${command} does not accept a task ID`);
  if (!taskId && !['types', 'list', 'tick', 'watch'].includes(command)) throw new Error(`${command} requires a task ID`);
  if (flags.has('all') && taskId) throw new Error('Choose a task ID or --all, not both');
  if (command === 'watch' && taskId) throw new Error('Use watch without a task ID (project-wide)');
  if (flags.has('brief') && flags.has('goal')) throw new Error('Choose --brief or --goal, not both');
  return { root: path.resolve(cwd, flags.get('project') ?? '.'), command, taskId, explicitTask: !!taskId, flags };
}

/** Host CLI adapters can supply routes and compatibility guards without package-level business imports. */
export function handleGenericCommand(options) {
  if (['service', 'types', 'design'].includes(options.command)) return handleCommand(options);
  return withTaskLayout(options.root, () => handleCommand(options));
}

async function handleCommand({ root, command, taskId, explicitTask = !!taskId, flags = new Map(),
  dependencies = {}, routes, additionalTypes = [], skipTask = () => false, afterTick = async () => {},
  watcherOptions = {}, serviceOptions = {}, print = printJSON,
}) {
  const api = { ...definitions, ...runtime, trialTask, tickProject, startProjectWatcher, serviceClient, watchServiceClient,
    createLongrunServiceManager, runManagedWatcher, recordManagedTick, ...dependencies };
  if (command === 'service') {
    const actions = ['install', 'start', 'stop', 'restart', 'status', 'health', 'logs', 'uninstall'];
    if (!actions.includes(taskId)) throw new Error(`service requires one of: ${actions.join(', ')}`);
    for (const key of ['entrypoint', 'entry-args', 'node', 'interval-seconds', 'open-rounds']) {
      if (flags.has(key) && taskId !== 'install') throw new Error(`--${key} is only supported by service install`);
    }
    for (const key of ['component', 'stream', 'lines']) {
      if (flags.has(key) && taskId !== 'logs') throw new Error(`--${key} is only supported by service logs`);
    }
    const options = { projectRoot: root, ...serviceOptions };
    for (const [flag, key] of [['entrypoint','entrypoint'],['node','nodePath'],['runtime-home','runtimeHome']]) {
      if (flags.has(flag)) options[key] = path.resolve(root, flags.get(flag));
    }
    if (flags.has('entry-args')) options.entryArgs = JSON.parse(flags.get('entry-args'));
    if (flags.has('interval-seconds')) options.intervalSeconds = Number(flags.get('interval-seconds'));
    if (flags.has('open-rounds')) {
      if (!['true', 'false'].includes(flags.get('open-rounds'))) throw new Error('--open-rounds requires true or false');
      options.openRounds = flags.get('open-rounds') === 'true';
    }
    const logOptions = Object.fromEntries(['component','stream','lines'].filter(key => flags.has(key))
      .map(key => [key, key === 'lines' ? Number(flags.get(key)) : flags.get(key)]));
    print(await api.createLongrunServiceManager(options)[taskId](...(taskId === 'logs' ? [logOptions] : [])));
    return true;
  }
  const client = () => api.serviceClient({ projectRoot: root });
  const readFlag = name => JSON.parse(fs.readFileSync(path.resolve(root, flags.get(name)), 'utf8'));
  if (command === 'types') { print([...additionalTypes, ...definitions.TASK_TYPES.map(id => ({ id, creatable: true }))]); return true; }
  if (command === 'list') { print(api.listTasks(root)); return true; }
  if (command === 'design') {
    if (!explicitTask) throw new Error('design requires a new task ID');
    print({ definition: api.defaultDefinition(taskId, flags.get('type')), template: fileURLToPath(new URL('../templates/task-brief.md', import.meta.url)), next: 'create --brief <file>; creation stays draft' });
    return true;
  }
  if (command === 'create') {
    if (!explicitTask) throw new Error('create requires a new task ID');
    const brief = flags.has('brief') ? fs.readFileSync(path.resolve(root, flags.get('brief')), 'utf8') : flags.get('goal');
    print(await api.createTask({ root, id: taskId, type: flags.get('type'), brief, definition: flags.has('definition') ? readFlag('definition') : undefined }));
    return true;
  }
  if ((command === 'tick' || command === 'watch') && (!explicitTask || flags.has('all'))) {
    if (command === 'tick') {
      const results = await api.recordManagedTick({ projectRoot: root, run: async () => {
        const rows = await api.tickProject({ root, client: client(), open: process.env.LONGRUN_OPEN_ROUNDS === '1', routes });
        await afterTick(rows);
        return rows;
      }});
      for (const result of results) print(result);
      if (results.some(result => result.action === 'error')) process.exitCode = 1;
      return true;
    }
    let watcher, stopRequested = false, closePromise;
    const close = async () => {
      stopRequested = true;
      process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
      if (watcher) await (closePromise ??= Promise.resolve().then(() => watcher.close()));
    };
    const onSignal = () => { void close().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }); };
    process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
    try {
      watcher = await api.runManagedWatcher({ projectRoot: root, start: ({ onReady, onActivity, onError }) => {
        const observer = api.watchServiceClient({ projectRoot: root });
        let collector;
        try {
          collector = api.startProjectWatcher({ ...watcherOptions, root, client: observer, routes, onReady, onActivity,
            onResult: result => print({ at: new Date().toISOString(), ...result }),
            onError: error => {
              onError(error);
              process.stderr.write(`${new Date().toISOString()} ${error.stack ?? error}\n`);
              if (['WATCH_REOPEN_REQUIRED', 'WATCH_FAILED'].includes(error.code)) { process.exitCode = 1; onSignal(); }
            },
          });
        } catch (error) { void observer.close(); throw error; }
        return { ready: collector.ready, close: async () => { try { await collector.close(); } finally { await observer.close(); } } };
      },
      });
      if (stopRequested) { await close(); return true; }
      await watcher.ready;
      if (stopRequested) return true;
      print({ status: 'watching', scope: 'registered-project-tasks' });
    } catch (error) { await close(); throw error; }
    return true;
  }
  if (skipTask(taskId)) return false;
  if (!commands.has(command)) return false;
  if (!taskId) throw new Error(`${command} requires a task ID`);
  const options = { root, id: taskId };
  if (command === 'validate') { api.readDefinition(root, taskId); print({ ok: true, taskId }); }
  else if (command === 'plan') print(api.planTask(options));
  else if (command === 'status') print(api.genericStatus(options));
  else if (command === 'verify') { const result = api.verifyGeneric(options); print(result); if (!result.ok) process.exitCode = 1; }
  else if (command === 'enable') print(await api.enableTask({ ...options, reason: flags.get('reason') }));
  else if (command === 'pause') print(await api.pauseTask({ ...options, reason: flags.get('reason') ?? 'User paused task' }));
  else if (command === 'resume') print(await api.resumeTask(options));
  else if (command === 'disable') print(await api.disableTask({ ...options, reason: flags.get('reason') ?? 'User disabled task' }));
  else if (command === 'round') print(await api.startRun({ ...options, client: client() }));
  else if (command === 'rereview') print(await api.startRun({ ...options, client: client(), kind: 'review', selectedKeys: (flags.get('ids') ?? '').split(',').map(id => id.trim()).filter(Boolean) }));
  else if (command === 'collect') print(await api.collectTask({ ...options, client: client() }));
  else if (command === 'tick') print(await api.recordManagedTick({ projectRoot: root,
    run: () => api.tickTask({ ...options, client: client(), open: process.env.LONGRUN_OPEN_ROUNDS === '1' }) }));
  else if (command === 'reply') {
    if (!flags.has('answers')) throw new Error('Generic review requires --answers JSON; text is not a decision');
    const service = client(); await api.collectTask({ ...options, client: service }); const state = api.loadState(root, taskId);
    if (state.running?.phase !== 'awaiting_input') throw new Error('No verified active review');
    const answers = readFlag('answers'); print({ attentionId: await service.answer(state.running.ticketId, answers.answers ?? answers) });
  } else if (command === 'trial') {
    if (!flags.has('result')) throw new Error('trial is an offline fixture rehearsal; provide --result JSON');
    print(await api.trialTask({ ...options, result: readFlag('result'), answers: flags.has('answers') ? readFlag('answers') : undefined, memory: flags.has('memory') ? fs.readFileSync(path.resolve(root, flags.get('memory')), 'utf8') : undefined }));
  } else if (command === 'watch') throw new Error('Use watch without a task ID (project-wide)');
  else return false;
  return true;
}

export async function runCli(argv = process.argv.slice(2)) {
  if (!argv.length || argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) { process.stdout.write(HELP); return; }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${manifest.version}\n`); return;
  }
  const options = parseArguments(argv);
  if (!await handleGenericCommand(options)) throw new Error(`Unknown command: ${options.command}`);
}
