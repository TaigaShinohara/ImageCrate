import { collect } from './collector.js';
import { allowedURL, mediaType, mergeItems, downloadName, summarizeJobs, publicError, saveSettings, requiresWorkspace } from './utils.js';
import { pruneDirectories } from './directory-store.js';
import { extensionForMime } from './image-format.js';
import { sessionDefaults, selectableItems, applyUIPatch, applyJobCompletions, assertSessionBudget, serializedBytes, CANDIDATE_BYTE_LIMIT, SESSION_BYTE_LIMIT } from './session-state.js';
const KIND = 'images';
const PREFIX = 'workspace:';
const SUBMISSION_TIMEOUT = 30000;
const FILENAME_DECISION_TTL = 5 * 60 * 1000;
let operations = Promise.resolve();
// One mutation queue protects storage read/modify/write across concurrent events.
const serial = task => { const next = operations.then(task); operations = next.catch(() => {}); return next; };
const save = async state => {
  const candidate=sessionDefaults(state);
  applyJobCompletions(candidate);
  if(!candidate.closed) {
    const latest=new Map((candidate.history || []).map(job=>[job.url,job]));
    for(const job of candidate.jobs) latest.set(job.url,{...job});
    candidate.history=[...latest.values()].slice(-500);
  }
  candidate.revision++;
  await assertSessionBudget(candidate,await all());
  try { await chrome.storage.session.set({[PREFIX + candidate.id]:candidate}); }
  catch (error) {
    if (/quota|QUOTA_BYTES|storage.*limit/i.test(String(error?.message || error))) throw new Error('作業情報の容量上限に達しました。選択を減らすか、使い終わった作業タブを閉じてからもう一度操作してください。');
    throw error;
  }
  const jobs=state.jobs;
  for (let index=0;index<jobs.length;index++) Object.assign(jobs[index],candidate.jobs[index]);
  Object.assign(state,candidate,{jobs});
  for (const [id,entry] of submissions) {
    if (entry.state.id !== state.id) continue;
    const current=state.jobs.find(job=>job.id === id);
    if (!current || ['complete','interrupted'].includes(current.status)) forgetSubmission(id);
  }
};
const load = async id => { const state=(await chrome.storage.session.get(PREFIX + id))[PREFIX + id]; return state ? sessionDefaults(state) : undefined; };
const all = async () => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith(PREFIX)).map(([,v])=>sessionDefaults(v));
const active = state => summarizeJobs(state.jobs).active > 0;
const managed = state => requiresWorkspace(state.batch || {});
async function liveTab(id) { try { return await chrome.tabs.get(id); } catch { return null; } }

export async function openWorkspace(tab) {
  return serial(async () => {
    const existing = await all();
    for (const state of existing) {
      const manager=await liveTab(state.workspaceTabId);
      if (manager?.url !== chrome.runtime.getURL(`workspace.html?id=${state.id}`)) { await closeWorkspace(state); continue; }
      if (state.tabId === tab.id && state.url === tab.url) {
        await chrome.tabs.update(state.workspaceTabId, {active:true}); return state.id;
      }
    }
    if ((await all()).length >= 4) throw new Error('作業タブは4つまでです。使い終わった作業タブを閉じてください。');
    const id = crypto.randomUUID();
    const state = {id, tabId:tab.id, url:tab.url || '', title:(tab.title || 'ページ').slice(0,160), items:[], jobs:[], notices:[], scanned:false};
    // Open inactive first so messages cannot arrive before the session is persisted.
    const manager = await chrome.tabs.create({url:chrome.runtime.getURL(`workspace.html?id=${id}`), active:false});
    state.workspaceTabId = manager.id;
    await save(state);
    await chrome.tabs.update(manager.id,{active:true});
    return id;
  });
}
chrome.action.onClicked.addListener(tab => {
  openWorkspace(tab).then(() => chrome.action.setBadgeText({text:''})).catch(async error => {
    await chrome.action.setBadgeText({text:'!'});
    await chrome.action.setTitle({title:publicError(error)});
  });
});

async function disposeScan(state) {
  const cursor=state.scan?.pendingCursor || state.scan?.cursor || state.scan?.retryCursor;
  if (!cursor) return;
  try { await chrome.scripting.executeScript({target:{tabId:state.tabId},func:collect,args:[{dispose:true,cursor}]}); } catch {}
}
async function scan(state, continuation = false) {
  if (active(state)) throw new Error('保存処理が終わってから再スキャンしてください。');
  const tab = await liveTab(state.tabId);
  if (!tab || tab.url !== state.url) { await disposeScan(state); throw new Error('元ページが閉じられたか移動しました。そのページで拡張アイコンを押し直してください。'); }
  if (!/^https?:\/\//.test(tab.url)) throw new Error('通常のHTTP/HTTPSページで拡張アイコンを押してください。Chromeの設定・ストア等は取得できません。');
  if (continuation && !state.scan?.cursor) throw new Error('続きの取得情報がありません。先頭から再スキャンしてください。');
  const pending=state.scan?.pendingContinuation === continuation ? state.scan.pendingCursor : null;
  if (!continuation && !pending) await disposeScan(state);
  const sessions=await all();
  const otherCandidates=sessions.filter(other=>other.id !== state.id).reduce((bytes,other)=>bytes+serializedBytes(other.items),0);
  const allBytes=serializedBytes(Object.fromEntries(sessions.map(other=>[PREFIX+other.id,other])));
  const maxSerializedBytes=Math.min(1572864,CANDIDATE_BYTE_LIMIT-otherCandidates,SESSION_BYTE_LIMIT-allBytes+serializedBytes(state.items)-65536);
  if (maxSerializedBytes < 65536) throw new Error('次の候補を取得する容量が足りません。使い終わった作業タブを閉じてからもう一度取得してください。');
  const options={maxSerializedBytes,...(pending ? {cursor:pending} : continuation ? {cursor:state.scan.cursor} : {})};
  const results = await chrome.scripting.executeScript({target:{tabId:state.tabId},func:collect,args:[options]});
  const result = results[0]?.result;
  if (!result) throw new Error('ページの画像を取得できませんでした。元ページからやり直してください。');
  if (result.capacityLimited && !result.items?.length) throw new Error('次の候補を取得する容量が足りません。使い終わった作業タブを閉じてからもう一度取得してください。');
  if (result.invalidated) {
    state.scan={cursor:null,hasMore:false,scanId:state.scan?.scanId || null,invalidated:true,addedURLs:state.scan?.addedURLs || []};
    await save(state);
    throw new Error('ページ内容が変更されたか、続きの取得期限が切れました。先頭から再スキャンしてください。選択した画像は保持しています。');
  }
  const incoming = (result.items || []).map(item => ({...item, type:KIND === 'videos' ? mediaType(item.url,item.mime) : item.type || 'image'}));
  const before = new Set(selectableItems(state).map(item=>item.url));
  const records = new Map(selectableItems(state).map(item=>[item.url,item]));
  state.items = incoming.slice(0,500);
  for (const item of incoming) records.set(item.url,item);
  state.selectedItems = state.selectedURLs.filter(url=>!state.items.some(item=>item.url === url)).map(url=>records.get(url)).filter(Boolean);
  state.notices = result.notices || [];
  state.scan = {cursor:result.cursor || null,retryCursor:result.retryCursor || null,hasMore:Boolean(result.hasMore),scanId:result.scanId || null,
    addedURLs:incoming.filter(item=>!before.has(item.url)).map(item=>item.url)};
  state.scanned = true;
  try { await save(state); } catch (error) {
    // Keep the previous page and selection, together with a bounded replay token.
    // The source retains this serialized page until the next page is accepted.
    if (result.retryCursor) {
      const previous=await load(state.id);
      previous.scan={...(previous.scan || {}),pendingCursor:result.retryCursor,pendingContinuation:continuation};
      try { await save(previous); } catch {}
    }
    throw error;
  }
  return state;
}
function matchesSubmissionPath(job,item) {
  const requested=job.submission?.filename || job.filename;
  if (typeof requested !== 'string' || typeof item.filename !== 'string') return false;
  const paths=new Set([requested,suggestedOriginalName({...job,filename:requested},item.mime)].filter(Boolean));
  const actual=item.filename.replace(/\\/g,'/');
  return [...paths].some(path=>{
    const normalized=path.replace(/\\/g,'/');
    const dot=normalized.lastIndexOf('.');
    const stem=dot > normalized.lastIndexOf('/') ? normalized.slice(0,dot) : normalized;
    const suffix=dot > normalized.lastIndexOf('/') ? normalized.slice(dot) : '';
    const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?:^|/)${escape(stem)}(?: \\(\\d+\\))?${escape(suffix)}$`).test(actual);
  });
}
function submissionMatches(job,item,usedIds = new Set()) {
  const start=job.submission?.startedAt;
  const when=Date.parse(item.startTime);
  return Number.isFinite(start) && item.byExtensionId === chrome.runtime.id && item.url === job.submission.url
    && when >= start && when <= start+SUBMISSION_TIMEOUT && !usedIds.has(item.id) && matchesSubmissionPath(job,item);
}
function usedDownloadIds(states,owner,job) {
  return new Set(states.flatMap(state=>[...(state.jobs || []),...(state.history || [])]
    .filter(other=>other.downloadId && !(state.id === owner.id && other.id === job.id)).map(other=>other.downloadId)));
}
async function refreshJob(job,state) {
  if (!job.downloadId && job.submission) {
    const startedAt=job.submission.startedAt;
    let recent=[];
    if (Number.isFinite(startedAt)) {
      try { recent=await chrome.downloads.search({startedAfter:new Date(startedAt).toISOString()}); } catch {}
    }
    const usedIds=usedDownloadIds(await all(),state,job);
    const matches=recent.filter(item=>submissionMatches(job,item,usedIds));
    if (matches.length === 1) { job.downloadId=matches[0].id; delete job.submission; delete job.error; }
    else if (!Number.isFinite(startedAt) || Date.now()-startedAt >= SUBMISSION_TIMEOUT) {
      job.status='interrupted';
      job.error='保存結果を確認できませんでした。Chromeのダウンロード履歴を確認してから再試行してください。同名ファイルは上書きしません。';
      delete job.submission;
      return;
    } else { job.status='in_progress'; job.error='Chromeで保存の開始を確認しています。30秒以内に確認できない場合は中断として表示します。'; return; }
  }
  if (!job.downloadId || job.status !== 'in_progress') return;
  const [item] = await chrome.downloads.search({id:job.downloadId});
  if (!item) { job.status='interrupted'; job.error='ダウンロード履歴から見つかりません。再試行できます。'; return; }
  job.bytesReceived = item.bytesReceived; job.totalBytes = item.totalBytes;
  if (item.filename) job.actualFilename = String(item.filename).slice(0,2048);
  if (item.mime) { job.mime=item.mime; job.typeKnown=Boolean(extensionForMime(item.mime)); }
  job.status = item.state;
  if (item.error) job.error = item.error;
  if (item.state === 'complete' && /^(text\/html|application\/(json|xml))/i.test(item.mime || '')) {
    job.status='interrupted'; job.error='メディアではない応答が保存されました。サイトの認証・制限を確認してください。';
  }
}
// onDeterminingFilename can fire before download() resolves. It must never wait
// for the mutation queue that is currently awaiting Chrome's filename decision.
const submissions = new Map();
function forgetSubmission(id) {
  const entry=submissions.get(id);
  if (entry) clearTimeout(entry.timer);
  submissions.delete(id);
}
async function submitDownload(state,job,url) {
  job.status='in_progress';
  job.submission={url,filename:job.filename,startedAt:Date.now()};
  await save(state);
  const entry={state,job,url,downloadId:null,timer:null};
  entry.timer=setTimeout(()=>{if (submissions.get(job.id) === entry) forgetSubmission(job.id);},FILENAME_DECISION_TTL);
  entry.timer?.unref?.();
  submissions.set(job.id,entry);
  try {
    const id=await chrome.downloads.download({url,filename:job.filename,conflictAction:'uniquify',saveAs:false});
    // Chrome may resolve this API before dispatching its filename event. Keep
    // the accepted ID even while the surrounding save() still has an old clone.
    entry.downloadId=id;
    return id;
  } catch (error) { forgetSubmission(job.id); throw error; }
  finally { delete job.submission; }
}
function safeDownloadPath(filename) {
  return typeof filename === 'string' && filename.length <= 2048 && !/[\\\x00-\x1f<>:"|?*]/.test(filename)
    && filename.split('/').every(part=>part && part !== '.' && part !== '..');
}
function suggestedOriginalName(job, mime) {
  const extension=extensionForMime(mime);
  // A generated safe path stays fixed. Only replace its neutral final suffix.
  if (!extension || !/\.img$/i.test(job.filename || '') || !safeDownloadPath(job.filename)) return '';
  return job.filename.replace(/\.img$/i,`.${extension}`);
}
function nameDecision(item,match,suggest) {
  if (!match || match.state.batch?.destination === 'directory' || !safeDownloadPath(match.job.filename)) { suggest(); return null; }
  const original=(match.state.batch?.format || 'original') === 'original';
  const filename=(original && suggestedOriginalName(match.job,item.mime)) || match.job.filename;
  const decision={filename,actualFilename:filename,typeKnown:Boolean(extensionForMime(item.mime)) || !original,...(item.mime ? {mime:item.mime} : {})};
  Object.assign(match.job,decision);
  // Even known and converted files need an explicit suggestion. Chrome can
  // otherwise replace our batch path with a server-provided default basename.
  suggest({filename,conflictAction:'uniquify'});
  return decision;
}
function persistNameDecision(match,item,decision) {
  if (!match || !decision) return;
  const sessionId=match.state.id,jobId=match.job.id;
  // Capture the values, rather than a mutable job reference: an in-flight
  // storage candidate can overwrite that reference before this task runs.
  const patch={...decision};
  serial(async()=>{
    const state=await load(sessionId);
    const job=state?.jobs.find(job=>job.id === jobId);
    if (!job || job.downloadId && job.downloadId !== item.id) return;
    if (!job.downloadId && ['queued','in_progress'].includes(job.status)) job.downloadId=item.id;
    Object.assign(job,patch);
    delete job.submission;
    await save(state);
  }).catch(()=>{});
}
chrome.downloads.onDeterminingFilename?.addListener((item,suggestCallback)=>{
  let finished=false;
  const suggest=value=>{ if (finished) return; finished=true; if (value) suggestCallback(value); else suggestCallback(); };
  if (item.byExtensionId !== chrome.runtime.id) { suggest(); return false; }
  const entries=[...submissions.values()];
  const accepted=entries.filter(entry=>entry.downloadId === item.id);
  const unresolved=entries.filter(entry=>!entry.downloadId && entry.url === item.url);
  const pending=accepted.length === 1 ? accepted[0] : !accepted.length && unresolved.length === 1 ? unresolved[0] : null;
  if (pending) {
    const decision=nameDecision(item,pending,suggest);
    persistNameDecision(pending,item,decision);
    forgetSubmission(pending.job.id);
    return false;
  }
  // Recovery uses storage independently of serial(). A restarted worker may see
  // a filename event for a submission whose accepted ID has not been saved yet.
  all().then(states=>{
    let found;
    const known=states.flatMap(state=>state.jobs.filter(job=>job.downloadId === item.id).map(job=>({state,job})));
    if (known.length === 1) found=known[0];
    else if (!known.length) {
      const pending=states.flatMap(state=>state.jobs.filter(job=>!job.downloadId && job.submission && submissionMatches(job,item,usedDownloadIds(states,state,job))).map(job=>({state,job})));
      if (pending.length === 1) found=pending[0];
    }
    const decision=nameDecision(item,found,suggest);
    persistNameDecision(found,item,decision);
  }).catch(()=>suggest());
  return true;
});
async function pump(state) {
  for (const job of state.jobs) await refreshJob(job,state);
  // A workspace prepares converted images and owns custom-folder writes. The
  // worker only follows their accepted download IDs; it must not fetch originals.
  if (managed(state)) { await save(state); return state; }
  if (!state.jobs.some(j=>j.status === 'in_progress')) {
    for (const job of state.jobs.filter(j=>j.status === 'queued')) {
      try {
        job.downloadId = await submitDownload(state,job,job.url);
        job.status='in_progress'; await save(state); await refreshJob(job,state);
        if (job.status === 'in_progress') break;
      } catch (error) { job.status='interrupted'; job.error=publicError(error); }
    }
  }
  await save(state); return state;
}
async function stopJobs(state, reason) {
  for (const job of state.jobs) {
    if (!['queued','in_progress'].includes(job.status)) continue;
    if (!job.downloadId && job.submission) {
      await refreshJob(job,state);
      if (job.status === 'interrupted') continue;
      if (!job.downloadId) { job.error='Chromeで保存の開始を確認しています。30秒以内の照合が終わるまで再試行できません。'; continue; }
    }
    if (job.downloadId) {
      await refreshJob(job,state);
      if (job.status === 'in_progress') {
        try { await chrome.downloads.cancel(job.downloadId); } catch {}
        // Chrome may have completed before cancel, or cancel may still be
        // settling. Keep an active ID until Chrome confirms a terminal state.
        await refreshJob(job,state);
      }
      if (job.status === 'interrupted') job.error=reason;
    } else { job.status='interrupted';job.error=reason; }
  }
}
async function closeWorkspace(state) {
  await disposeScan(state);
  state.closed=true;state.items=[];state.selectedItems=[];state.selectedURLs=[];state.ui={};state.notices=[];state.history=[];state.scan=null;
  if (managed(state)) await stopJobs(state,'作業ページが閉じられ、保存が中断しました。');
  if (active(state)) await pump(state);
  if (!active(state)) await chrome.storage.session.remove(PREFIX + state.id);
}
function requireOwner(state, message) {
  if (!managed(state) || state.batch.id !== message.batchId || state.batch.owner !== message.instance) {
    throw new Error('この保存処理は終了したか、別の作業ページに引き継がれました。');
  }
}
async function claim(state, instance, mode, wantStream = true) {
  if (KIND !== 'videos') throw new Error('未対応の操作です。');
  const current = (await chrome.storage.session.get('captureLock')).captureLock;
  const owner=current && await liveTab(current.tabId);
  const ownerLive=owner?.url?.startsWith(chrome.runtime.getURL('workspace.html?id='));
  if(current && !ownerLive) await chrome.storage.session.remove('captureLock');
  if (current && ownerLive && (current.tabId !== state.workspaceTabId || current.instance !== instance)) {
    throw new Error('別の作業タブで録画中です。停止してから開始してください。');
  }
  // Same owner may not start another capture while one is active.
  if (ownerLive && current?.instance === instance) throw new Error('録画はすでに開始されています。');
  await chrome.storage.session.set({captureLock:{tabId:state.workspaceTabId,instance,mode}});
  try {
    if (mode !== 'tab' || !wantStream) return {};
    const tab = await liveTab(state.tabId);
    if (!tab || tab.url !== state.url) throw new Error('元ページが閉じられたか移動しました。拡張を押し直してください。');
    const captured = await chrome.tabCapture.getCapturedTabs();
    if (captured.some(t=>t.tabId === state.tabId && t.status !== 'stopped' && t.status !== 'error')) throw new Error('このタブはすでに録画されています。');
    return {streamId:await chrome.tabCapture.getMediaStreamId({targetTabId:state.tabId,consumerTabId:state.workspaceTabId})};
  } catch(error) { await chrome.storage.session.remove('captureLock'); throw error; }
}
function requireDirectoryKey(state,key) {
  if (typeof key !== 'string' || key.length > 180 || !(key === `session:${state.id}` || key.startsWith(`session:${state.id}:`) && key.length > `session:${state.id}:`.length)) throw new Error('保存先の参照が正しくありません。フォルダを選び直してください。');
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL('workspace.html')) || sender.id !== chrome.runtime.id) return;
  serial(async () => {
    const state = await load(message.sessionId);
    if (!state || sender.tab?.id !== state.workspaceTabId) throw new Error('作業情報が見つかりません。元ページから拡張を押し直してください。');
    switch(message.type) {
      case 'get': return pump(state);
      case 'prune-directories': {
        // Keep the live batch/session set under the same mutation queue as save.
        // A page's startup snapshot may already be stale when another tab saves.
        const sessions=await all();
        await pruneDirectories(['last',...sessions.flatMap(s=>[`session:${s.id}`,...(s.saveSettings?.directoryKey ? [s.saveSettings.directoryKey] : []),...(s.pendingDirectoryKey ? [s.pendingDirectoryKey] : []),...(s.batch?.id ? [`batch:${s.batch.id}`] : [])])]);
        return {};
      }
      case 'ui': { const updated=applyUIPatch(state,message.patch,message.baseRevision); await save(updated); return updated; }
      case 'dimensions': {
        for (const update of (message.updates || []).slice(0,500)) {
          if (!Number.isFinite(update.width) || !Number.isFinite(update.height) || update.width <= 0 || update.height <= 0 || update.width > 100000 || update.height > 100000) continue;
          for (const item of [...state.items,...state.selectedItems]) if (item.url === update.url) Object.assign(item,{width:update.width,height:update.height,dimensionSource:'decoded'});
        }
        await save(state); return state;
      }
      case 'scan': return scan(state,Boolean(message.continuation));
      case 'source': { const tab = await liveTab(state.tabId); if(!tab) throw new Error('元ページは閉じられています。'); await chrome.tabs.update(state.tabId,{active:true}); return {}; }
      case 'save': {
        if (active(state)) throw new Error('保存処理中です。');
        if (!Array.isArray(message.urls) || message.urls.length > 500) throw new Error('保存できる画像は一度に500件までです。');
        const chosen = new Set(message.urls);
        const sourceBatchId=message.sourceBatchId;
        if (sourceBatchId && (sourceBatchId !== state.batch?.id || [...chosen].some(url=>!state.jobs.some(job=>job.url === url && job.status === 'interrupted')))) throw new Error('中断した保存処理が変更されました。最新の保存結果を確認してください。');
        const candidates=sourceBatchId ? mergeItems(state.jobs.filter(job=>job.status === 'interrupted').map(job=>({url:job.url})),selectableItems(state)) : selectableItems(state);
        const items = candidates.filter(item=>chosen.has(item.url) && allowedURL(item.url,KIND) && (KIND !== 'videos' || item.type === 'direct'));
        if (items.length !== chosen.size) throw new Error('保存する画像が変更されました。選択を確認してからもう一度保存してください。');
        if (!items.length) throw new Error('保存する対象を選んでください。');
        const settings = saveSettings(message.settings || state.saveSettings, state.title);
        if (settings.destination === 'directory' && !settings.directoryName) throw new Error('保存先フォルダを選んでください。');
        state.batch = {...settings,id:crypto.randomUUID(),owner:message.instance,...(sourceBatchId ? {sourceBatchId} : {})};
        state.ui={...state.ui,saveScope:'selection',failedBatchId:null};
        state.jobs = items.map((item,i)=>({id:crypto.randomUUID(),url:item.url,status:'queued',completionApplied:false,filename:settings.destination === 'directory' ? downloadName(item,settings.folderName,i,KIND,settings.format).split('/').pop() : downloadName(item,settings.folderName,i,KIND,settings.format)}));
        if (managed(state)) { await save(state); return state; }
        return pump(state);
      }
      case 'settings-prepare': {
        if (active(state)) throw new Error('保存処理が終わってから設定を変更してください。');
        requireDirectoryKey(state,message.directoryKey);
        if (message.directoryKey === `session:${state.id}` || message.directoryKey === state.saveSettings?.directoryKey) throw new Error('現在の保存先とは別の参照を用意してください。フォルダを選び直してください。');
        state.pendingDirectoryKey=message.directoryKey;
        await save(state); return state;
      }
      case 'settings-abort': {
        requireDirectoryKey(state,message.directoryKey);
        if (state.pendingDirectoryKey === message.directoryKey) delete state.pendingDirectoryKey;
        await save(state); return state;
      }
      case 'settings': {
        if (active(state)) throw new Error('保存処理が終わってから設定を変更してください。');
        const input = message.settings || {};
        if (input.directoryKey) {
          requireDirectoryKey(state,input.directoryKey);
          if (input.directoryKey !== state.saveSettings?.directoryKey && input.directoryKey !== `session:${state.id}` && input.directoryKey !== state.pendingDirectoryKey) throw new Error('保存先の準備が変更されました。フォルダを選び直してください。');
        }
        state.saveSettings = {...saveSettings(input,state.title),folderName:String(input.folderName ?? state.title).slice(0,300),...(input.directoryKey ? {directoryKey:input.directoryKey} : {})};
        delete state.pendingDirectoryKey;
        await save(state); return state;
      }
      case 'directory-update':
      case 'managed-update': {
        requireOwner(state,message);
        for (const update of (message.updates || []).slice(0,500)) {
          const job = state.jobs.find(job=>job.id === update.id);
          if (!job || !['queued','in_progress'].includes(job.status) || !['in_progress','complete','interrupted'].includes(update.status)) continue;
          if (job.downloadId) { await refreshJob(job,state); continue; }
          // Converted Chrome downloads are saved only after Chrome confirms
          // completion. The page can report preparation or a conversion error.
          if (state.batch.destination === 'downloads' && update.status === 'complete') continue;
          job.status = update.status;
          for (const key of ['bytesReceived','totalBytes']) if (Number.isFinite(update[key]) && update[key] >= 0) job[key] = update[key];
          if (typeof update.filename === 'string' && !/[\\/]/.test(update.filename)) job.filename = update.filename.slice(0,240);
          if (typeof update.typeKnown === 'boolean') job.typeKnown=update.typeKnown;
          if (typeof update.mime === 'string' && update.mime.length < 120) job.mime=update.mime;
          if (typeof update.filename === 'string' && !/[\\/]/.test(update.filename)) job.actualFilename=update.filename.slice(0,240);
          if (update.error) job.error = publicError(update.error).slice(0,500);
        }
        await save(state); return state;
      }
      case 'converted-download': {
        requireOwner(state,message);
        if (state.batch.destination !== 'downloads' || !['jpg','png','webp'].includes(state.batch.format)) throw new Error('この保存形式では変換後のダウンロードを開始できません。');
        const job=state.jobs.find(job=>job.id === message.jobId);
        if (!job || job.status !== 'in_progress' || job.downloadId) throw new Error('この画像の保存は終了したか、停止しました。');
        if (typeof message.blobURL !== 'string' || !message.blobURL.startsWith(`blob:${chrome.runtime.getURL('')}`) || message.blobURL.length > 2048) throw new Error('変換後の画像データが不正です。');
        if (state.jobs.some(other=>other !== job && other.downloadId && other.status === 'in_progress')) throw new Error('前の画像の保存が終わってから開始してください。');
        try {
          job.downloadId=await submitDownload(state,job,message.blobURL);
        } catch (error) { job.status='interrupted';job.error=publicError(error);await save(state);return state; }
        // Persist the accepted ID before querying Chrome so an unrelated query
        // failure cannot turn a live download into a freely retriable job.
        await save(state);
        await refreshJob(job,state);
        await save(state);return state;
      }
      case 'cancel': {
        if (managed(state) && state.batch.owner !== message.instance) throw new Error('この保存処理は別の作業ページに引き継がれました。');
        await stopJobs(state,'停止しました。');
        await save(state); return state;
      }
      case 'retry': {
        if(active(state)) throw new Error('保存処理中です。');
        if(managed(state) && state.batch.owner !== message.instance) throw new Error('この保存処理は別の作業ページに引き継がれました。');
        for(const job of state.jobs.filter(j=>j.status==='interrupted')) { job.id=crypto.randomUUID();job.status='queued';job.completionApplied=false;delete job.bytesReceived;delete job.totalBytes; delete job.downloadId; delete job.error; }
        if(managed(state)) {await save(state);return state;}
        return pump(state);
      }
      case 'capture': return claim(state,message.instance,message.mode);
      case 'hello': {
        if(managed(state)) {
          if(state.batch.owner !== message.instance) await stopJobs(state,'作業ページが再読み込みされ、保存が中断しました。保存済みの画像はそのままに、中断分を再試行できます。');
          state.batch.owner=message.instance;await save(state);
        }
        // Reload gets a new instance token; the old page no longer owns a live recorder.
        const lock = (await chrome.storage.session.get('captureLock')).captureLock;
        if(lock?.tabId === state.workspaceTabId && lock.instance !== message.instance) await chrome.storage.session.remove('captureLock');
        const sessions=await all();
        return {...state,activeDirectoryKeys:sessions.flatMap(s=>[`session:${s.id}`,...(s.saveSettings?.directoryKey ? [s.saveSettings.directoryKey] : []),...(s.pendingDirectoryKey ? [s.pendingDirectoryKey] : []),...(s.batch?.id ? [`batch:${s.batch.id}`] : [])])};
      }
      case 'release': {
        const lock = (await chrome.storage.session.get('captureLock')).captureLock;
        if(lock?.tabId === state.workspaceTabId && lock.instance === message.instance) await chrome.storage.session.remove('captureLock');
        return {};
      }
      default: throw new Error('未対応の操作です。');
    }
  }).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:publicError(error)}));
  return true;
});
// Register listeners at worker startup; storage keeps download IDs across suspension.
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state && !delta.error) return;
  serial(async()=> {for(const state of await all()) if(state.jobs.some(j=>j.downloadId === delta.id)) { await pump(state); if(state.closed && !active(state)) await chrome.storage.session.remove(PREFIX + state.id); }}).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(async()=> {
    const lock = (await chrome.storage.session.get('captureLock')).captureLock;
    if(lock?.tabId === tabId) await chrome.storage.session.remove('captureLock');
    for(const state of await all()) {
      if(state.workspaceTabId === tabId) await closeWorkspace(state);
      else if (state.tabId === tabId && state.scan) { await disposeScan(state); state.scan={cursor:null,hasMore:false,invalidated:true}; await save(state); }
    }
  }).catch(()=>{});
});

chrome.tabs.onUpdated?.addListener((tabId,changeInfo,tab)=>{
  if (!changeInfo.url) return;
  serial(async()=>{
    for (const state of await all()) {
      if (state.workspaceTabId === tabId && tab.url !== chrome.runtime.getURL(`workspace.html?id=${state.id}`)) await closeWorkspace(state);
      else if (state.tabId === tabId && tab.url !== state.url && state.scan) {
        await disposeScan(state);
        state.scan={cursor:null,hasMore:false,invalidated:true};
        await save(state);
      }
    }
  }).catch(()=>{});
});
