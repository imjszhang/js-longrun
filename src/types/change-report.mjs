import { outputPaths, instructions, keysOnly, nonempty, evidenceErrors, memoryErrors, json, validatedValue } from './common.mjs';

export const changeReport = {
  id: 'change-report@1',
  validateDefinition(definition) {
    const errors = [];
    if (definition.review?.mode !== 'none') errors.push('change-report@1 只支持无需人工审核的报告');
    if (definition.review?.allowReReview) errors.push('报告类型不支持候选重新审核');
    return { ok: !errors.length, errors };
  },
  prepareRun(ctx) {
    if (ctx.kind === 'review') throw new Error('报告类型不支持重新审核');
    const paths = outputPaths(ctx);
    return {
      allowedPaths: [paths.result, paths.memory], attentionSnapshotPaths: [],
      text: [instructions(ctx),
        `只允许写 ${paths.result} 与 ${paths.memory}。不要改 task.json、state.json 或 artifacts。`,
        `分析输入和既有记忆，生成 JSON 文件 ${paths.result}，严格格式：` +
          '{"schemaVersion":1,"summary":"本轮摘要","report":"完整 Markdown 报告","evidence":[{"path":"冻结输入路径","quote":"可选原文片段"}],"changed":true}。',
        '有实质变化时 changed=true，必须提供至少一项冻结输入证据；没有资料或未发现变化时 changed=false，仍记录检查范围及限制。quote 若提供，必须逐字出自对应冻结原文。不要把推断写成已核实事实。',
        `在 ${paths.memory} 写下一轮可复用的非空记忆，区分事实、推断和待解决事项；保留仍有效的旧事实。`,
        '本类型无需人工审核，不发出 attention 或卡片；完成后以 version:2,state:ready 报告“本地报告已写入工作区，等待 longrun 核对”，不提前声称正式归档。',
      ].join('\n\n'),
    };
  },
  validateResult(ctx) {
    const result = ctx.result, errors = memoryErrors(ctx);
    if (!keysOnly(result, ['schemaVersion', 'summary', 'report', 'evidence', 'changed']) || result?.schemaVersion !== 1) errors.push('报告结果结构或版本无效');
    if (!nonempty(result?.summary) || !nonempty(result?.report) || typeof result?.changed !== 'boolean') errors.push('报告需要 summary、report 和布尔 changed');
    errors.push(...evidenceErrors(result?.evidence, ctx.inputs, { required: result?.changed === true }));
    if (ctx.snapshot?.status === 'waiting' || ctx.allowPending) errors.push('报告类型不能等待人工审核');
    if (ctx.kind === 'review') errors.push('报告类型不支持重新审核');
    return { ok: !errors.length, errors, value: { result, memory: ctx.memoryOutput } };
  },
  planSettlement(ctx) {
    const { result, memory } = validatedValue(ctx); outputPaths(ctx);
    return { summary: result.summary, artifacts: [
      { path: `reports/${ctx.runId}.md`, content: result.report + (result.report.endsWith('\n') ? '' : '\n') },
      { path: `reports/${ctx.runId}.json`, content: json(result) },
      { path: 'latest-report.json', content: json({ runId: ctx.runId, ...result }) },
      { path: 'memory.md', content: memory },
    ] };
  },
};
