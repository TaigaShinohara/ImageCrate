// Session-only UI and selection data. No page addresses are written to local storage.
export const SESSION_BYTE_LIMIT = 8 * 1024 * 1024;
export const CANDIDATE_BYTE_LIMIT = 6 * 1024 * 1024;
export const SELECTION_LIMIT = 500;
const encoder = new TextEncoder();
export const serializedBytes = value => encoder.encode(JSON.stringify(value)).byteLength;
export const defaultUI = () => ({view:'all',query:'',width:0,height:0,type:'',excludeAdLike:false,onlySelected:false,scrollY:0,focusAnchor:'',saveScope:'selection',failedBatchId:null});
export function sessionDefaults(input) {
  const state = {...input,revision:Number.isSafeInteger(input.revision) ? input.revision : 0,
    selectionRevision:Number.isSafeInteger(input.selectionRevision) ? input.selectionRevision : 0,
    items:[...(input.items || [])],selectedItems:[...(input.selectedItems || [])],selectedURLs:[...new Set(input.selectedURLs || [])],
    ui:{...defaultUI(),...(input.ui || {}),excludeAdLike:input.ui?.excludeAdLike===true},jobs:(input.jobs || []).map(job=>({...job,
      // Retries replace the attempt id, never the identity used by the durable
      // batch transfer ledger. Old job IDs are stable migration identities.
      logicalJobId:job.logicalJobId || job.id,
      // An old completed job has already been shown. It cannot deselect a later deliberate selection.
      completionApplied:job.completionApplied ?? job.status === 'complete'}))};
  if (state.ui.saveScope === 'failed' && (state.ui.failedBatchId !== state.batch?.id || !state.jobs.some(job=>job.status === 'interrupted'))) { state.ui.saveScope='selection'; state.ui.failedBatchId=null; }
  state.selectedItems = state.selectedItems.filter(item=>state.selectedURLs.includes(item.url) && !state.items.some(current=>current.url === item.url));
  return state;
}
export function selectableItems(state) {
  return [...new Map([...(state.selectedItems || []),...(state.items || [])].map(item=>[item.url,item])).values()];
}
export function applyUIPatch(state, patch = {}, baseRevision) {
  const next = sessionDefaults(state);
  if (Object.hasOwn(patch,'selectedURLs')) {
    if (!Array.isArray(patch.selectedURLs) || patch.selectedURLs.some(url=>typeof url !== 'string')) throw new Error('選択情報が正しくありません。');
    if (Number.isSafeInteger(baseRevision) && baseRevision < next.selectionRevision) throw new Error('選択が更新されました。最新の状態でもう一度選択してください。');
    const selected = [...new Set(patch.selectedURLs)];
    if (selected.length > SELECTION_LIMIT) throw new Error('選択できる画像は500件までです。選択を減らしてからもう一度操作してください。');
    const records = new Map(selectableItems(next).map(item=>[item.url,item]));
    if (selected.some(url=>!records.has(url))) throw new Error('選択した画像が見つかりません。最新の候補を確認してください。');
    next.selectedURLs = selected;
    next.selectedItems = selected.filter(url=>!next.items.some(item=>item.url === url)).map(url=>records.get(url));
    next.selectionRevision = next.revision + 1;
  }
  const ui = {...next.ui};
  if (['all','selected','added'].includes(patch.view)) ui.view = patch.view;
  if (typeof patch.query === 'string') ui.query = patch.query.slice(0,500);
  if (typeof patch.type === 'string') ui.type = patch.type.slice(0,30);
  for (const key of ['width','height']) if (Number.isFinite(Number(patch[key])) && Object.hasOwn(patch,key)) ui[key] = Math.max(0,Math.min(100000,Math.floor(Number(patch[key]))));
  for (const key of ['onlySelected','filtersOpen','helpOpen','excludeAdLike']) if (typeof patch[key] === 'boolean') ui[key] = patch[key];
  if (Number.isFinite(patch.scrollY)) ui.scrollY = Math.max(0,Math.min(1e9,patch.scrollY));
  if (typeof patch.focusAnchor === 'string') ui.focusAnchor = patch.focusAnchor.slice(0,131072);
  if (['selection','failed'].includes(patch.saveScope)) ui.saveScope=patch.saveScope;
  if (patch.failedBatchId === null || typeof patch.failedBatchId === 'string' && patch.failedBatchId.length <= 100) ui.failedBatchId=patch.failedBatchId;
  if (ui.saveScope === 'failed' && (ui.failedBatchId !== next.batch?.id || !next.jobs.some(job=>job.status === 'interrupted'))) throw new Error('中断した保存処理が変更されました。最新の保存結果を確認してください。');
  if (ui.saveScope === 'selection') ui.failedBatchId=null;
  next.ui = ui;
  return next;
}
export function applyJobCompletions(state) {
  const completed = new Set();
  for (const job of state.jobs || []) {
    if (job.status === 'complete' && !job.completionApplied) { completed.add(job.url); job.completionApplied = true; }
  }
  if (completed.size) {
    state.selectedURLs = (state.selectedURLs || []).filter(url=>!completed.has(url));
    state.selectedItems = (state.selectedItems || []).filter(item=>!completed.has(item.url));
    state.selectionRevision = state.revision + 1;
  }
  return state;
}
export function assertSessionBudget(state, sessions) {
  const current = sessions.filter(other=>other.id !== state.id).concat(state);
  // Reserve two MiB for selection, jobs and UI across the four workspaces.
  if (current.reduce((bytes,session)=>bytes + serializedBytes(session.items || []),0) > CANDIDATE_BYTE_LIMIT
    || serializedBytes(Object.fromEntries(current.map(session=>[`workspace:${session.id}`,session]))) > SESSION_BYTE_LIMIT) {
    throw new Error('作業情報の容量上限に達しました。選択を減らすか、使い終わった作業タブを閉じてからもう一度操作してください。');
  }
}
