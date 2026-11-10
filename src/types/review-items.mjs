import { OPTIONS, DECISION_OPTIONS, plain, nonempty, keysOnly, equal, json, sha256, outputPaths, evidenceErrors, memoryErrors, instructions, initScript, validatedValue } from './common.mjs';

export const itemKey = item => `${item.runId}:${item.id}`;
const decisionId = (item, kind) => kind === 'review' ? itemKey(item) : item.id;
const content = row => plain(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => !['status', 'reason'].includes(key))) : row;
const normalizeTitle = title => String(title).trim().toLowerCase().replace(/\s+/g, ' ');

function checkItems(ctx, result, { initial = false, allowPending = false } = {}) {
  const errors = [], rows = result?.items, review = ctx.kind === 'review';
  if (!keysOnly(result, ['schemaVersion', 'items']) || result?.schemaVersion !== 1 || !Array.isArray(rows)) return ['候选结果必须为 schemaVersion:1 和 items 数组'];
  const max = Math.min(10, ctx.definition.parameters?.maxItems ?? 5);
  if (rows.length > max) errors.push(`候选超过上限 ${max}`);
  if (review && (!rows.length || rows.length !== ctx.selectedItems?.length)) errors.push('重新审核项目集合被增加或删除');
  const ids = new Set(), titles = new Set();
  for (const [index, row] of rows.entries()) {
    const allowed = review ? ['runId', 'id', 'title', 'summary', 'evidence', 'status', 'reason'] : ['id', 'title', 'summary', 'evidence', 'status', 'reason'];
    if (!keysOnly(row, allowed)) { errors.push('候选包含不支持的字段'); continue; }
    if (!/^I\d{4}$/.test(row.id ?? '') || !review && row.id !== `I${String(index + 1).padStart(4, '0')}`) errors.push('候选编号应从 I0001 连续递增');
    if (review && !/^R\d{4,}$/.test(row.runId ?? '')) errors.push('重新审核缺少原始回合编号');
    const id = decisionId(row, ctx.kind);
    if (ids.has(id)) errors.push(`重复候选编号：${id}`);
    ids.add(id);
    if (!nonempty(row.title) || row.title.length > 200 || row.title !== row.title.trim()
      || !nonempty(row.summary) || row.summary.length > 500 || row.summary !== row.summary.trim()) errors.push(`${id} 标题或摘要为空、超长或带首尾空白`);
    errors.push(...evidenceErrors(row.evidence, review ? ctx.sourceInputs?.[row.runId] ?? ctx.inputs : ctx.inputs, { required: true }).map(error => `${id} ${error}`));
    if (!['pending', ...OPTIONS].includes(row.status)) errors.push(`${id} 状态无效`);
    if ((initial || !allowPending) && (initial ? row.status !== 'pending' : !OPTIONS.includes(row.status))) errors.push(`${id} ${initial ? '首次快照必须为 pending' : '仍然待审'}`);
    if (row.status === 'pending' && row.reason !== undefined) errors.push(`${id} 待审项目不能带决定理由`);
    if (OPTIONS.includes(row.status) && (!nonempty(row.reason) || row.reason.length > 500)) errors.push(`${id} 缺少有效决定理由`);
    if (review) {
      const original = ctx.selectedItems?.[index];
      if (!original || !equal(content(row), content(original))) errors.push(`${id} 重新审核不能改变原编号、顺序或内容`);
    } else {
      const title = normalizeTitle(row.title);
      if (titles.has(title) || (ctx.previousItems ?? []).some(previous => normalizeTitle(previous.title) === title)) errors.push(`${id} 与已有项目标题重复`);
      titles.add(title);
    }
  }
  return errors;
}

function checkReview(ctx) {
  const { result, snapshot = {} } = ctx, rows = result.items, captures = snapshot.attentionSnapshots ?? [], errors = [];
  const expectedTicket = ctx.ticketId ?? snapshot.ticketId;
  if (!captures.length) return { errors: ['缺少发卡前的宿主内容快照'] };
  const resultPath = outputPaths(ctx).result, captureMap = new Map();
  let original;
  for (const [index, capture] of captures.entries()) {
    if (!plain(capture) || !nonempty(expectedTicket) || capture.ticketId !== expectedTicket || !nonempty(capture.attentionId)
      || !Number.isFinite(Date.parse(capture.at)) || captureMap.has(capture.attentionId)) { errors.push('宿主快照的工单、提问编号或时间无效'); continue; }
    const file = Array.isArray(capture.files) ? capture.files.find(file => file?.path === resultPath) : null;
    if (!file || typeof file.content !== 'string' || sha256(file.content) !== file.sha256) { errors.push('宿主结果快照缺失或哈希校验失败'); continue; }
    let frozen;
    try { frozen = JSON.parse(file.content); } catch { errors.push('宿主快照不是有效 JSON'); continue; }
    const frozenErrors = checkItems(ctx, frozen, { initial: index === 0, allowPending: true });
    if (frozenErrors.length) { errors.push(...frozenErrors); continue; }
    const contents = frozen.items.map(content);
    if (original && !equal(original, contents)) errors.push('重复提问修改了已冻结的候选内容');
    original ??= contents;
    if (!equal(contents, rows.map(content))) errors.push('候选内容与发卡前快照不一致');
    const decision = capture.decision, ids = frozen.items.map(row => decisionId(row, ctx.kind));
    if (!decision || decision.reason !== 'required' || !Array.isArray(decision.items) || !Array.isArray(decision.options)
      || !decision.items.every(plain) || !decision.options.every(plain)
      || !equal(decision.items.map(row => row.id).sort(), [...ids].sort())
      || !equal([...decision.options].sort((a,b) => String(a.id).localeCompare(String(b.id))), [...DECISION_OPTIONS].sort((a,b) => a.id.localeCompare(b.id)))
      || decision.items.some(shown => {
        const row = frozen.items.find(item => decisionId(item, ctx.kind) === shown.id);
        return !row || shown.title !== row.title || shown.summary !== row.summary || shown.url !== undefined;
      })) errors.push('卡片显示内容、项目范围或选项与冻结结果不一致');
    captureMap.set(capture.attentionId, capture);
  }
  const chosen = new Map(), ids = rows.map(row => decisionId(row, ctx.kind));
  for (const answer of snapshot.answers ?? []) {
    const capture = answer && captureMap.get(answer.attentionId);
    if (!plain(answer) || !capture || answer.ticketId !== expectedTicket || !Number.isFinite(Date.parse(answer.at)) || Date.parse(answer.at) < Date.parse(capture.at)) {
      errors.push('回答与宿主快照的工单、问题或时间不一致'); continue;
    }
    if (answer.kind !== 'structured') continue;
    if (!plain(answer.answers) || !equal(Object.keys(answer.answers).sort(), [...ids].sort())) { errors.push('结构化回答必须覆盖全部且仅覆盖本轮项目'); continue; }
    for (const [id, value] of Object.entries(answer.answers)) {
      if (!keysOnly(value, ['option', 'reason']) || !OPTIONS.includes(value.option) || !nonempty(value.reason)) { errors.push(`${id} 缺少有效选项或理由`); continue; }
      if (chosen.has(id) && !equal(chosen.get(id), value)) errors.push(`${id} 多次回答的决定冲突`);
      chosen.set(id, value);
    }
  }
  for (const row of rows) {
    const id = decisionId(row, ctx.kind), answer = chosen.get(id);
    if (row.status !== 'pending' && (!answer || row.status !== answer.option || row.reason !== answer.reason)) errors.push(`${id} 决定或理由与结构化回答不一致`);
    if (!ctx.allowPending && !answer) errors.push(`${id} 缺少完整结构化答案`);
  }
  const first = captures[0];
  return { errors, review: { attentionId: first?.attentionId, since: first?.at, itemIds: ids, source: 'host-attention-snapshot' } };
}

export const reviewItems = {
  id: 'review-items@1',
  validateDefinition(definition) {
    const errors = [];
    if (definition.review?.mode !== 'items') errors.push('review-items@1 需要逐项审核');
    if (!Number.isInteger(definition.parameters?.maxItems) || definition.parameters.maxItems < 1 || definition.parameters.maxItems > 10) errors.push('maxItems 必须在 1 至 10 之间');
    return { ok: !errors.length, errors };
  },
  prepareRun(ctx) {
    const paths = outputPaths(ctx), isReview = ctx.kind === 'review';
    if (isReview && (!ctx.definition.review?.allowReReview || !ctx.selectedItems?.length || ctx.selectedItems.some(row => row.status !== 'later'))) throw new Error('只能重新审核允许重审的稍后项目');
    const initialFiles = [];
    let reviewText;
    if (isReview) {
      const pending = ctx.selectedItems.map(row => { const { reason, ...rest } = row; return { ...rest, status: 'pending' }; });
      initialFiles.push({ path: paths.result, content: json({ schemaVersion: 1, items: pending }) }, { path: paths.memory, content: ctx.memory || '# 长期记忆\n' });
      const decision = { items: pending.map(row => ({ id: itemKey(row), title: row.title, summary: row.summary })), options: DECISION_OPTIONS, reason: 'required' };
      reviewText = [
        '这是既有项目重新审核，不新增项目。证据按原始 runId 读取其冻结来源版本；不要用今天同名文件的内容替换：\n' + json(ctx.sourceInputs ?? {}),
        '先执行下列初始化脚本，逐字保留原内容：',
        '```javascript\n' + initScript(initialFiles) + '\n```',
        `然后以 version:2,state:waiting 报告，attention.question 请求重新审核，attention.decision 必须为 ${json(decision)}。`,
        '收到答案后，用 runId:id 对应每项，只更新 status 和 reason；memory.md 只能在原文末尾追加真实新决定。',
      ].join('\n\n');
    } else reviewText = [
      `在本地冻结输入中提出至多 ${ctx.definition.parameters.maxItems} 个有证据的项目；避免重复下列历史项目：\n${json(ctx.previousItems ?? [])}`,
      `写入 ${paths.result}，严格格式：{"schemaVersion":1,"items":[{"id":"I0001","title":"标题","summary":"摘要","evidence":[{"path":"冻结输入路径","quote":"可选原文片段"}],"status":"pending"}]}。编号从 I0001 连续递增，标题至多 200 字符，摘要至多 500 字符，无首尾空白；每项至少一条证据，quote 必须逐字出自冻结原文。`,
      `同时写入非空 ${paths.memory}，区分事实、推断、测试信号与人工决定。等待时不能把尚未批准的项目写成已采纳。`,
      '有项目时以 version:2,state:waiting 报告，attention.question 请求逐项审核；attention.decision.items 必须列出所有项目，id/title/summary 与文件完全一致，不填 url；' +
        `options 固定为 ${json(DECISION_OPTIONS)}，reason 为 required。没有新项目时写空 items，以 ready 结束。`,
      '收到结构化回答后只改每项 status 和 reason，逐字等于答案 option/reason；不得修改项目内容、编号或集合。仅收到文字时保持 pending 并重新提供同样结构化审核，不代替用户作决定。',
    ].join('\n\n');
    return { allowedPaths: [paths.result, paths.memory], attentionSnapshotPaths: [paths.result], initialFiles,
      text: [instructions(ctx), `只允许写 ${paths.result} 和 ${paths.memory}；不要直接写 artifacts、state 或其他文件。`, reviewText,
        '最终完成以 version:2,state:ready 报告“决定已写入工作区，等待 longrun 核对”，不提前声称正式入库。'].join('\n\n') };
  },
  validateResult(ctx) {
    const itemErrors = checkItems(ctx, ctx.result, { allowPending: ctx.allowPending });
    const errors = [...memoryErrors(ctx), ...itemErrors];
    let review;
    if (!itemErrors.length && Array.isArray(ctx.result?.items) && ctx.result.items.length) {
      const checked = checkReview(ctx); errors.push(...checked.errors); review = checked.review;
    } else if (!itemErrors.length && (ctx.snapshot?.status === 'waiting' || (ctx.snapshot?.answers ?? []).length || (ctx.snapshot?.attentionSnapshots ?? []).length)) errors.push('空项目结果不能包含审核或答案记录');
    return { ok: !errors.length, errors, value: { result: ctx.result, memory: ctx.memoryOutput }, ...(review ? { review } : {}) };
  },
  planSettlement(ctx) {
    const { result, memory } = validatedValue(ctx); outputPaths(ctx);
    let items = structuredClone(ctx.previousItems ?? []), next = result.items;
    if (ctx.kind === 'review') {
      if (!ctx.expired) {
        const updates = new Map(next.map(row => [itemKey(row), row]));
        items = items.map(row => updates.has(itemKey(row)) ? structuredClone(updates.get(itemKey(row))) : row);
      }
    } else {
      next = next.map(row => ({ runId: ctx.runId, ...row, ...(ctx.expired && row.status === 'pending' ? { status: 'later', reason: '审核超时，保留稍后' } : {}) }));
      const existing = new Set(items.map(itemKey));
      if (next.some(row => existing.has(itemKey(row)))) throw new Error('该运行的项目已入库，不能重复追加');
      items.push(...next);
    }
    return { summary: ctx.expired ? '审核超时，保留稍后项目' : `已核对 ${result.items.length} 项决定`, artifacts: [
      { path: 'items.json', content: json(items) },
      { path: 'memory.md', content: ctx.expired ? ctx.memory || '# 长期记忆\n' : memory },
    ] };
  },
};
