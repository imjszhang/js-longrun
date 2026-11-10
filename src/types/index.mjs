import { changeReport } from './change-report.mjs';
import { reviewItems } from './review-items.mjs';

const TYPES = new Map([changeReport, reviewItems].map(type => [type.id, Object.freeze(type)]));
export function getType(id) {
  const type = TYPES.get(id);
  if (!type) throw new Error(`未注册通用任务类型：${id}`);
  return type;
}
export function listTypes() { return [...TYPES.values()].map(type => ({ id: type.id })); }
export { itemKey } from './review-items.mjs';

/** Type-owned persisted context: the scheduler does not interpret item states or schemas. */
export function prepareTypeContext({type,definition,kind,files,selectedKeys,readInputs,readOriginalRun}) {
  const memory=files['memory.md']??'# Memory\n';
  if(type==='change-report@1') {
    if(kind!=='round')throw new Error('报告类型不支持重新审核');
    return {memory,inputs:readInputs(definition.inputs)};
  }
  const previousItems=JSON.parse(files['items.json']??'[]');
  if(!Array.isArray(previousItems))throw new Error('Invalid persisted review items');
  const selectedItems=kind==='review'?previousItems.filter(item=>selectedKeys.includes(`${item.runId}:${item.id}`)):[];
  if(kind==='review'&&(!definition.review.allowReReview||!selectedItems.length||selectedItems.length!==new Set(selectedKeys).size||selectedItems.some(i=>i.status!=='later')))throw new Error('Re-review requires existing deferred items and an enabled review capability');
  const sourceInputs=kind==='review'?Object.fromEntries([...new Set(selectedItems.map(i=>i.runId))].map(runId=>[runId,readOriginalRun(runId).inputs])):{};
  return {memory,previousItems,selectedItems,sourceInputs,inputs:kind==='review'?Object.values(sourceInputs).flat():readInputs(definition.inputs)};
}
