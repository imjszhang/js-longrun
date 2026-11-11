import fs from 'node:fs';
import { createProjectAgent } from 'js-superagent';

function explicitRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new Error('projectRoot is required; js-longrun never infers a project from its installation directory');
  }
  const root = fs.realpathSync(projectRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('projectRoot must be a directory');
  return root;
}

/**
 * Client for an existing js-superagent project. It submits and reads work; it
 * never runs a worker, configures an executor, or starts another channel listener.
 * `open` is a host/test integration seam, not a task-definition option.
 */
export function serviceClient({ projectRoot, open } = {}) {
  const root = explicitRoot(projectRoot);
  const opener = open ?? (projectRoot => createProjectAgent({ projectRoot }).init());
  async function withProject(fn) {
    const runtime = opener(root);
    try { return await fn(runtime); }
    finally {
      try { await runtime.stop(); }
      finally { runtime.close(); }
    }
  }
  return {
    materialCapabilities: () => withProject(runtime => {
      if (typeof runtime.materialCapabilities !== 'function') throw Object.assign(new Error('js-superagent does not support the frozen material contract'), { code: 'LONGRUN_MATERIAL_UNSUPPORTED' });
      return runtime.materialCapabilities();
    }),
    createMaterialSnapshot: options => withProject(runtime => {
      if (typeof runtime.createMaterialSnapshot !== 'function') throw Object.assign(new Error('js-superagent cannot freeze project materials'), { code: 'LONGRUN_MATERIAL_UNSUPPORTED' });
      return runtime.createMaterialSnapshot(options);
    }),
    submit: (text, options = {}) => withProject(runtime => runtime.submit({ text,
      ...(options.operatorNotifications === undefined ? {} : { operatorNotifications: options.operatorNotifications }),
      ...(options.managedJobs === undefined ? {} : { managedJobs: options.managedJobs }),
      ...(options.attentionSnapshotPaths?.length ? { attentionSnapshotPaths: options.attentionSnapshotPaths } : {}),
      ...(options.materials === undefined ? {} : { materials: structuredClone(options.materials) }),
    }).id),
    snapshot: (id, options = {}) => withProject(runtime => {
      const view = runtime.get(id);
      const report = runtime.getDomainTicket(id).assignments.at(-1)?.report ?? null;
      const detail = typeof runtime.getDetailed === 'function' ? runtime.getDetailed(id) : null;
      const workspace = runtime.getWorkspace(id), strict = !!(options.contractHash || detail?.materialBinding);
      const inspection = strict && workspace ? runtime.inspectWorkspace(id) : null;
      if (inspection?.workspace && inspection.workspace.provisionId !== workspace.provisionId) throw new Error('Workspace changed during material evidence collection');
      return { status: view.status, report: report?.state ?? null, summary: report?.summary ?? null,
        workspacePath: workspace?.path ?? (strict ? null : root),
        ...(strict ? { workspace: workspace ?? null, materialBinding: detail?.materialBinding ?? null,
          workspacePreparation: detail?.workspacePreparation ?? null, workspaceHistory: detail?.workspaceHistory ?? [],
          materialObservations: detail?.materialObservations ?? [], workerChanges: inspection?.changes ?? null } : {}),
        answers: runtime.listAnswers(id), attentionSnapshots: runtime.listAttentionSnapshots(id) };
    }),
    changes: id => withProject(runtime => runtime.inspectWorkspace(id).changes),
    jobs: id => withProject(runtime => runtime.listJobs(id).map(job => ({ id: job.id, profileId: job.profileId, status: job.status }))),
    reply: (id, text) => withProject(runtime => runtime.reply(id, text).status),
    answer: (id, answers) => withProject(runtime => runtime.answer(id, { answers }).attentionId),
    cancel: id => withProject(runtime => runtime.cancel(id).status),
  };
}

/** One read observer for the project; channel delivery remains owned by its service. */
export function watchServiceClient({ projectRoot, open } = {}) {
  const root = explicitRoot(projectRoot);
  const client = serviceClient({ projectRoot: root, open });
  const runtime = open ? open(root) : createProjectAgent({ projectRoot: root }).init();
  let closed = false;
  return {
    ...client,
    observe: id => ({ status: runtime.get(id).status, attentionId: runtime.getDomainTicket(id).attention?.id ?? null }),
    watchChanges: (listener, options) => runtime.watchChanges(listener, options),
    close: async () => {
      if (closed) return;
      closed = true;
      try { await runtime.stop(); }
      finally { runtime.close(); }
    },
  };
}
