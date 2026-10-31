import { collect } from './collector.js';
import { allowedURL, mediaType, mergeItems, downloadName, summarizeJobs, publicError, saveSettings, requiresWorkspace } from './utils.js';
import { pruneDirectories } from './directory-store.js';
import { extensionForMime } from './image-format.js';
import { sessionDefaults, selectableItems, applyUIPatch, applyJobCompletions, assertSessionBudget, serializedBytes, CANDIDATE_BYTE_LIMIT, SESSION_BYTE_LIMIT } from './session-state.js';
import {MEDIA_LIMITS, MEDIA_POLICY_VERSION} from './media-limits.js';
import {createTransferBudget, reserveTransferAttempt, settleTransferAttempt, transferBudgetRemaining, transferOutputBudgetRemaining} from './transfer-budget.js';
const KIND = 'images';
const PREFIX = 'workspace:';
const SUBMISSION_TIMEOUT = 30000;
const FILENAME_DECISION_TTL = 5 * 60 * 1000;
const RECOVERY_ALARM = 'imagecrate-pending-downloads';
const SCAN_TIMEOUT = 5000;
const workerInstance = crypto.randomUUID();
const scanFlights = new Map();
const SOURCE_FLIGHTS_KEY = 'imagecrate.sourceFlights.v1';
let operations = Promise.resolve();
// One mutation queue protects storage read/modify/write across concurrent events.
const serial = task => { const next = operations.then(task); operations = next.catch(() => {}); return next; };
const save = async (state, extra = {}) => {
  const candidate=sessionDefaults(state);
  applyJobCompletions(candidate);
  if(!candidate.closed) {
    const latest=new Map((candidate.history || []).map(job=>[job.url,job]));
    for(const job of candidate.jobs) latest.set(job.url,{...job});
    candidate.history=[...latest.values()].slice(-500);
  }
  candidate.revision++;
  await assertSessionBudget(candidate,await all());
  try { await chrome.storage.session.set({[PREFIX + candidate.id]:candidate,...extra}); }
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
  await syncRecoveryAlarm().catch(()=>{});
};
const load = async id => { const state=(await chrome.storage.session.get(PREFIX + id))[PREFIX + id]; return state ? normalizeManagedChromeOwnership(sessionDefaults(state)) : undefined; };
const all = async () => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith(PREFIX)).map(([,v])=>normalizeManagedChromeOwnership(sessionDefaults(v)));
const hasPendingSubmission = state => state.jobs.some(job=>['queued','in_progress'].includes(job.status) && (job.submission && !job.downloadId || job.cancelRequested));
async function syncRecoveryAlarm() {
  if (!chrome.alarms?.create) return;
  const pending=(await all()).some(hasPendingSubmission);
  if (pending) {
    // Repeated UI messages must not postpone a closed workspace's wake-up.
    const current=await chrome.alarms.get(RECOVERY_ALARM);
    if (!current) await chrome.alarms.create(RECOVERY_ALARM,{delayInMinutes:1,periodInMinutes:1});
  } else await chrome.alarms.clear(RECOVERY_ALARM);
}
const active = state => summarizeJobs(state.jobs).active > 0;
const managed = state => requiresWorkspace(state.batch || {});
async function liveTab(id) { try { return await chrome.tabs.get(id); } catch { return null; } }
async function ownsWorkspaceTab(state, tab) {
  if (!tab) return false;
  const expected=chrome.runtime.getURL(`workspace.html?id=${state.id}`);
  const visibleURL=tab.url || tab.pendingUrl;
  if (visibleURL) return visibleURL === expected;
  // Chrome 116 can omit even our own tab URL without the broad tabs permission.
  // Extension-owned document contexts prove the exact owner without that grant.
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts=await chrome.runtime.getContexts({contextTypes:['TAB'],tabIds:[state.workspaceTabId],documentUrls:[expected]});
    return contexts.some(context=>context.tabId === state.workspaceTabId && context.frameId === 0 && context.documentUrl === expected);
  } catch { return false; }
}

export async function openWorkspace(tab) {
  return serial(async () => {
    const existing = await all();
    for (const state of existing) {
      const manager=await liveTab(state.workspaceTabId);
      if (!await ownsWorkspaceTab(state,manager)) { await closeWorkspace(state); continue; }
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

const sourceFlights = async () => (await chrome.storage.session.get(SOURCE_FLIGHTS_KEY))[SOURCE_FLIGHTS_KEY] || {};
async function releaseSourceFlight(request) {
  const flights=await sourceFlights();delete flights[request.id];
  const state=await load(request.sessionId);
  if (state?.scanRequest?.id===request.id && state.scanRequest.expired) {
    delete state.scanRequest;await save(state,{[SOURCE_FLIGHTS_KEY]:flights});
  } else await chrome.storage.session.set({[SOURCE_FLIGHTS_KEY]:flights});
}
function disposeScan(state) {
  const cursor=state.scan?.pendingCursor || state.scan?.cursor || state.scan?.retryCursor;
  if (!cursor) return;
  // Disposal is best effort. A nonresponsive source must not hold the global
  // mutation queue, and a late dispose may touch only this cursor/document.
  const target=state.sourceDocumentId ? {tabId:state.tabId,documentIds:[state.sourceDocumentId]} : {tabId:state.tabId};
  const request={id:crypto.randomUUID(),tabId:state.tabId,sessionId:state.id,workerInstance,kind:'dispose'};
  serial(async()=>{
    const flights=await sourceFlights();
    // Cleanup shares the same persistent four-call pool. If a scan already
    // owns the document, its bounded collector/TTL will perform the cleanup.
    if (Object.keys(flights).length>=4 || Object.values(flights).some(f=>f.tabId===state.tabId)) return;
    if (!await liveTab(state.tabId)) return;
    flights[request.id]=request;await chrome.storage.session.set({[SOURCE_FLIGHTS_KEY]:flights});
    Promise.resolve().then(()=>chrome.scripting.executeScript({target,func:collect,args:[{dispose:true,cursor,scanId:state.scan?.scanId}]}))
      .finally(()=>serial(()=>releaseSourceFlight(request))).catch(()=>{});
  }).catch(()=>{});
}
async function beginScan(state, continuation = false) {
  if (active(state)) throw new Error('保存処理が終わってから再スキャンしてください。');
  const tab = await liveTab(state.tabId);
  if (!tab || tab.url !== state.url) { disposeScan(state); throw new Error('元ページが閉じられたか移動しました。そのページで拡張アイコンを押し直してください。'); }
  if (!/^https?:\/\//.test(tab.url)) throw new Error('通常のHTTP/HTTPSページで拡張アイコンを押してください。Chromeの設定・ストア等は取得できません。');
  if (tab.status==='loading') throw new Error('元ページを読み込み中です。読み込みが終わってから取得してください。');
  const sourceEpoch=state.sourceEpoch || 0;
  const key=`${state.tabId}:${sourceEpoch}`;
  const flights=await sourceFlights();
  if (Object.values(flights).some(f=>f.tabId===state.tabId) || scanFlights.has(key) || state.scanRequest?.sourceEpoch === sourceEpoch) throw new Error('元ページの取得が終了していません。しばらく待つか、元ページを閉じて開き直してください。');
  if (Object.keys(flights).length >= 4) throw new Error('応答を待っているページが多すぎます。取得元のタブを閉じてからやり直してください。');
  if (continuation && !state.scan?.cursor) throw new Error('続きの取得情報がありません。先頭から再スキャンしてください。');
  const pending=state.scan?.pendingContinuation === continuation ? state.scan.pendingCursor : null;
  // A fresh collect replaces its old controller itself. Do not inject an
  // additional asynchronous disposal into the same document before starting.
  const sessions=await all();
  const otherCandidates=sessions.filter(other=>other.id !== state.id).reduce((bytes,other)=>bytes+serializedBytes(other.items),0);
  const allBytes=serializedBytes(Object.fromEntries(sessions.map(other=>[PREFIX+other.id,other])));
  const maxSerializedBytes=Math.min(1572864,CANDIDATE_BYTE_LIMIT-otherCandidates,SESSION_BYTE_LIMIT-allBytes+serializedBytes(state.items)-65536);
  if (maxSerializedBytes < 65536) throw new Error('次の候補を取得する容量が足りません。使い終わった作業タブを閉じてからもう一度取得してください。');
  const options={maxSerializedBytes,...(pending ? {cursor:pending} : continuation ? {cursor:state.scan.cursor} : {})};
  const request={id:crypto.randomUUID(),sessionId:state.id,workerInstance,sourceEpoch,url:state.url,tabId:state.tabId,workspaceTabId:state.workspaceTabId,
    documentId:state.sourceDocumentId || null,expectedCursor:options.cursor || null,continuation,deadline:Date.now()+SCAN_TIMEOUT};
  state.scanRequest=request;
  flights[request.id]={id:request.id,tabId:request.tabId,sessionId:request.sessionId,workerInstance,kind:'scan'};
  await save(state,{[SOURCE_FLIGHTS_KEY]:flights});
  const flight={request,key,sessionId:state.id};
  scanFlights.set(key,flight);
  return {request,options,flight};
}
async function finishScan(sessionId, request, results) {
  const state=await load(sessionId);
  if (!state || state.closed || state.scanRequest?.id !== request.id || state.sourceEpoch !== undefined && state.sourceEpoch !== request.sourceEpoch) throw new Error('取得元が変わったため、古い取得結果を破棄しました。元ページからやり直してください。');
  const tab=await liveTab(state.tabId);
  if (!tab || tab.url !== request.url || state.workspaceTabId !== request.workspaceTabId || !await ownsWorkspaceTab(state,await liveTab(state.workspaceTabId))) {
    delete state.scanRequest;await save(state);
    throw new Error('元ページか作業ページが変わりました。元ページからやり直してください。');
  }
  delete state.scanRequest;
  if (Date.now() >= request.deadline) {await save(state);throw new Error('元ページの取得期限を超えました。先頭から取り直してください。');}
  const injection=results[0];
  if (request.documentId && injection?.documentId && request.documentId !== injection.documentId) { await save(state);throw new Error('取得したページが再読み込みされました。先頭から取り直してください。'); }
  if (injection?.documentId) state.sourceDocumentId=injection.documentId;
  const result = results[0]?.result;
  if (result?.sourceURL && result.sourceURL !== state.url) {await save(state);throw new Error('元ページが移動しました。拡張を開き直してください。');}
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
  // A work slice can consume only rejected/duplicate tokens. It has made
  // progress, but it must not erase the previous candidate page or selection.
  if (!((result.workLimited || result.scanLimited) && !incoming.length)) state.items = incoming.slice(0,500);
  for (const item of incoming) records.set(item.url,item);
  state.selectedItems = state.selectedURLs.filter(url=>!state.items.some(item=>item.url === url)).map(url=>records.get(url)).filter(Boolean);
  state.notices = result.notices || [];
  state.scan = {cursor:result.cursor || null,retryCursor:result.retryCursor || null,hasMore:Boolean(result.hasMore),scanId:result.scanId || null,
    workLimited:Boolean(result.workLimited),scanLimited:Boolean(result.scanLimited),
    addedURLs:incoming.filter(item=>!before.has(item.url)).map(item=>item.url)};
  state.scanned = true;
  try { await save(state); } catch (error) {
    // Keep the previous page and selection, together with a bounded replay token.
    // The source retains this serialized page until the next page is accepted.
    if (result.retryCursor) {
      const previous=await load(state.id);
      delete previous.scanRequest;
      previous.scan={...(previous.scan || {}),pendingCursor:result.retryCursor,pendingContinuation:request.continuation};
      try { await save(previous); } catch {}
    }
    throw error;
  }
  return state;
}
async function scanWorkspace(message,sender) {
  const prepared=await serial(async()=>{
    const state=await load(message.sessionId);
    if (!state || state.closed || sender.tab?.id !== state.workspaceTabId) throw new Error('作業情報が見つかりません。元ページから拡張を押し直してください。');
    return beginScan(state,Boolean(message.continuation));
  });
  const {request,options,flight}=prepared;
  const target=request.documentId ? {tabId:request.tabId,documentIds:[request.documentId]} : {tabId:request.tabId};
  let timer;
  const execution=Promise.resolve().then(()=>chrome.scripting.executeScript({target,func:collect,args:[options]}));
  execution.finally(()=>{
    if(scanFlights.get(flight.key)===flight)scanFlights.delete(flight.key);
    serial(()=>releaseSourceFlight(request)).catch(()=>{});
  }).catch(()=>{});
  try {
    const results=await Promise.race([execution,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('元ページの取得が5秒以内に応答しませんでした。他の作業は続けられます。元ページを再読み込みしてからやり直してください。')),SCAN_TIMEOUT);timer.unref?.();})]);
    return await serial(()=>finishScan(message.sessionId,request,results));
  } catch (error) {
    await serial(async()=>{
      const state=await load(message.sessionId);
      if (!state || state.scanRequest?.id !== request.id) return;
      // A timed-out injection can still be running. Keep its reservation until
      // it settles or the source changes; never reinject into the same document.
      if (scanFlights.get(flight.key)===flight) state.scanRequest.expired=true;
      else delete state.scanRequest;
      await save(state);
    }).catch(()=>{});
    throw error;
  } finally {clearTimeout(timer);}
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
      if (managed(state)) {
        // A missing/ambiguous acceptance result does not prove that Chrome
        // stopped consuming the Blob. Retain the bounded matching evidence and
        // durable cancel intent until an actual owned terminal item is found.
        job.status='in_progress';job.outcomeUnknown=true;delete job.chromeOutcomeKnown;
        job.error='Chromeの保存受付と結果を確認できません。照合が終わるまで再試行できません。';
        return;
      }
      job.status='interrupted';
      job.error='保存結果を確認できませんでした。Chromeのダウンロード履歴を確認してから再試行してください。同名ファイルは上書きしません。';
      delete job.submission;
      return;
    } else { job.status='in_progress'; job.error='Chromeで保存の開始を確認しています。30秒以内に確認できない場合は中断として表示します。'; return; }
  }
  if (!job.downloadId || !['queued','in_progress'].includes(job.status)) return;
  const [item] = await chrome.downloads.search({id:job.downloadId});
  applyChromeDownload(job,item,state);
  if (job.cancelRequested && job.status === 'in_progress') {
    try { await chrome.downloads.cancel(job.downloadId); } catch {}
    // Cancellation races completion and can settle asynchronously. Keep the
    // durable intent until Chrome reports the real terminal state.
    const [current]=await chrome.downloads.search({id:job.downloadId});
    applyChromeDownload(job,current,state);
    if (job.status === 'interrupted') job.error=job.cancelReason || '停止しました。';
  }
}
function applyChromeDownload(job,item,state) {
  if (!item) {
    job.status='interrupted';job.error='ダウンロード履歴から見つかりません。再試行できます。';
    if (managed(state)) {
      job.status='in_progress';job.outcomeUnknown=true;
      job.error='Chromeのダウンロード履歴から保存結果を照合しています。確定するまで再試行できません。';
    }
    delete job.chromeOutcomeKnown;
    return;
  }
  job.bytesReceived = item.bytesReceived; job.totalBytes = item.totalBytes;
  if (item.filename) job.actualFilename = String(item.filename).slice(0,2048);
  if (item.mime) { job.mime=item.mime; job.typeKnown=Boolean(extensionForMime(item.mime)); }
  job.status = item.state;
  job.chromeOutcomeKnown=['complete','interrupted'].includes(item.state);
  if (item.error) job.error = item.error;
  if (item.state === 'complete' && /^(text\/html|application\/(json|xml))/i.test(item.mime || '')) {
    job.status='interrupted'; job.error='メディアではない応答が保存されました。サイトの認証・制限を確認してください。';
  }
  recoverKnownChromeTransfer(state,job);
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
  // actualFilename belongs to Chrome search: its absolute path and conflict
  // suffix must survive this later, relative requested-name decision.
  const decision={filename,typeKnown:Boolean(extensionForMime(item.mime)) || !original,...(item.mime ? {mime:item.mime} : {})};
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
    if (job.cancelRequested && job.downloadId && job.status === 'in_progress') await refreshJob(job,state);
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
  for (const job of state.jobs) {
    if (job.cancelRequested && !job.downloadId && !job.submission && ['queued','in_progress'].includes(job.status)) { job.status='interrupted'; job.error=job.cancelReason || '停止しました。'; }
    else await refreshJob(job,state);
  }
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
  const unfinished=state.jobs.filter(job=>['queued','in_progress'].includes(job.status));
  for (const job of unfinished) { job.cancelRequested=true; job.cancelReason=reason; }
  // Persist Stop before any Chrome API call. A restart or late acceptance must
  // observe the same request even when its download ID is not available yet.
  if (unfinished.length) await save(state);
  for (const job of unfinished) {
    if (job.downloadId || job.submission) {
      await refreshJob(job,state);
      if (!job.downloadId && job.submission) job.error='停止を受け付けました。Chromeで保存開始を確認でき次第停止します。30秒以内の照合が終わるまで再試行できません。';
    } else { job.status='interrupted'; job.error=reason; }
  }
}
async function closeWorkspace(state) {
  disposeScan(state);
  if (managed(state)) abandonManagedTransfers(state);
  delete state.scanRequest;
  state.closed=true;state.items=[];state.selectedItems=[];state.selectedURLs=[];state.ui={};state.notices=[];state.history=[];state.scan=null;
  await save(state);
  if (managed(state)) await stopJobs(state,'作業ページが閉じられ、保存が中断しました。');
  if (active(state)) await pump(state);
  if (!active(state)) { await chrome.storage.session.remove(PREFIX + state.id); await syncRecoveryAlarm().catch(()=>{}); }
}
function requireOwner(state, message) {
  if (!managed(state) || state.batch.id !== message.batchId || state.batch.owner !== message.instance) {
    throw new Error('この保存処理は終了したか、別の作業ページに引き継がれました。');
  }
}
function normalizeManagedChromeOwnership(state) {
  if (managed(state) && state.batch.destination === 'downloads') for (const job of state.jobs) {
    if (job.status === 'interrupted' && (job.downloadId || job.submission) && !job.chromeOutcomeKnown) {
      // Earlier versions could mark a missing lookup as interrupted. That is
      // not proof that an accepted Blob has stopped being consumed by Chrome.
      job.status='in_progress';job.outcomeUnknown=true;
      job.error='Chromeの保存受付と結果を照合しています。確定するまで再試行できません。';
    }
  }
  return state;
}
function requireTransferBudget(state) {
  const budget=state.batch?.transferBudget;
  if (budget?.version !== MEDIA_POLICY_VERSION || state.batch.transferPolicyLegacy) {
    throw new Error('以前の保存処理には容量・時間の記録がありません。保存先を確認してから新しい保存として準備してください。');
  }
  transferBudgetRemaining(budget); // Validate a persisted policy before use.
  return budget;
}
function transferAttempt(state,job) {
  const attempts=state.batch?.transferBudget?.attempts;
  return attempts && Object.hasOwn(attempts,job.id) ? attempts[job.id] : undefined;
}
function knownTransferOutcome(state,job,status) {
  const budget=state.batch?.transferBudget,attempt=transferAttempt(state,job);
  if (!budget || attempt?.status !== 'unknown') return;
  // We still charge the full source reservation: learning a real file outcome
  // cannot reconstruct how many source bytes the departed owner consumed.
  state.batch.transferBudget={...budget,attempts:{...budget.attempts,[job.id]:{...attempt,status,usageUnknown:Boolean(job.transfer?.usageUnknown)}}};
}
function recoverKnownChromeTransfer(state,job) {
  if (!state || state.batch?.destination !== 'downloads' || !(job.outcomeUnknown || job.transfer?.usageUnknown || job.transfer?.outputUnknown)
    || !job.chromeOutcomeKnown || !['complete','interrupted'].includes(job.status)) return;
  knownTransferOutcome(state,job,job.status);
  delete job.outcomeUnknown;
}
function markManagedOutcomeUnknown(state,job) {
  job.outcomeUnknown=true;
  if (state.batch.destination === 'downloads' && (job.downloadId || job.submission)) {
    // Only an actual Chrome terminal result can resolve a Blob ownership doubt.
    recoverKnownChromeTransfer(state,job);
  } else if (job.status !== 'complete') {
    // A confirmed completed file stays complete. Otherwise stop this job and
    // reject same-batch retry without claiming that its file is absent.
    job.status='interrupted';
    job.error='書き込みの結果を確認できません。保存先のファイルを確認してから新しい保存として準備してください。';
  }
}
function abandonManagedTransfers(state) {
  const budget=state.batch?.transferBudget;
  if (budget?.version !== MEDIA_POLICY_VERSION) {
    state.batch.transferPolicyLegacy=true;
    for (const job of state.jobs) {
      if (state.batch.destination === 'directory' && job.status === 'in_progress') job.outcomeUnknown=true;
    }
    return;
  }
  for (const job of state.jobs) {
    if (transferAttempt(state,job)?.status !== 'reserved') continue;
    const outputKnown=job.status==='complete' && (state.batch.destination === 'directory' || job.chromeOutcomeKnown);
    const noFileAccepted=state.batch.destination === 'downloads' && !job.downloadId && !job.submission;
    const outputUnknown=!(outputKnown || noFileAccepted);
    const outputBytes=outputKnown && Number.isSafeInteger(job.bytesReceived) && job.bytesReceived>=0 ? job.bytesReceived : 0;
    state.batch.transferBudget=settleTransferAttempt(state.batch.transferBudget,{attemptId:job.id,outcome:'unknown',outputBytes,outputUnknown});
    job.transfer={...job.transfer,settledAt:Date.now(),settlement:'unknown',usageUnknown:true,outputUnknown,outputBytes};
    if (state.batch.destination === 'directory') {
      if (job.status === 'complete') knownTransferOutcome(state,job,'complete');
      else {
        job.status='interrupted';job.outcomeUnknown=true;
        job.error='書き込みの結果を確認できません。保存先のファイルを確認してから新しい保存として準備してください。';
      }
    } else if (!job.downloadId && !job.submission) {
      // No Blob was accepted by Chrome. There is no OS file operation to retry
      // concurrently; source usage alone remains conservatively unknown.
      knownTransferOutcome(state,job,'interrupted');
    } else { job.outcomeUnknown=true;recoverKnownChromeTransfer(state,job); }
  }
}
function managedReservation(state,message) {
  requireOwner(state,message);
  const budget=requireTransferBudget(state);
  const job=state.jobs.find(job=>job.id===message.jobId);
  if (!job || !['queued','in_progress'].includes(job.status) || job.cancelRequested || job.outcomeUnknown) {
    throw new Error('この画像の保存は終了したか、停止しました。');
  }
  const existing=transferAttempt(state,job);
  if (existing?.status === 'reserved') {
    if (!job.transfer || Date.now() >= job.transfer.deadline || Date.now() >= budget.deadline) throw new Error('この保存試行の制限時間を超えました。');
    return;
  }
  const original=(state.batch.format || 'original') === 'original';
  let maxBytes=Math.min(original
    ? MEDIA_LIMITS.original.maxBytes : MEDIA_LIMITS.converter.maxInputBytes,transferBudgetRemaining(budget));
  if (!maxBytes) throw new Error('今回の保存の容量予算が不足しています。新しい保存として準備してください。');
  const maxOutputBytes=Math.min(original ? maxBytes : MEDIA_LIMITS.converter.maxOutputBytes,transferOutputBudgetRemaining(budget));
  if (!maxOutputBytes) throw new Error('今回の保存の出力容量予算が不足しています。新しい保存として準備してください。');
  if (original) maxBytes=Math.min(maxBytes,maxOutputBytes);
  const startedAt=Date.now();
  state.batch.transferBudget=reserveTransferAttempt(budget,{attemptId:job.id,logicalJobId:job.logicalJobId,maxBytes,maxOutputBytes,now:startedAt});
  job.transfer={maxBytes,maxOutputBytes,deadline:Math.min(budget.deadline,startedAt+MEDIA_LIMITS.original.timeoutMs),startedAt};
  job.status='in_progress';
}
function managedSettlement(state,message) {
  requireOwner(state,message);requireTransferBudget(state);
  const job=state.jobs.find(job=>job.id===message.jobId);
  const attempt=job && transferAttempt(state,job);
  if (!job || !attempt || attempt.logicalJobId !== job.logicalJobId
    || !['complete','interrupted','unknown'].includes(message.outcome)
    || !Number.isSafeInteger(message.outputBytes ?? 0) || (message.outputBytes ?? 0) < 0
    || message.outputUnknown !== undefined && typeof message.outputUnknown !== 'boolean'
    || message.bytesReceived !== undefined && (!Number.isSafeInteger(message.bytesReceived) || message.bytesReceived < 0)
    || message.outcome !== 'unknown' && message.bytesReceived === undefined) {
    throw new Error('保存試行の結果が正しくありません。');
  }
  if (attempt.status !== 'reserved') {
    if (message.outcome === 'unknown' || message.outputUnknown) {
      // A lost terminal acknowledgement can follow a successful accounting
      // write. Strengthen the outcome monotonically without undoing completed
      // accounting or allowing the file to become freely retriable.
      job.transfer={...job.transfer,acknowledgementUnknown:true};
      const budget=state.batch.transferBudget;
      state.batch.transferBudget={...budget,attempts:{...budget.attempts,[job.id]:{...attempt,outcomeUnknown:true}}};
      markManagedOutcomeUnknown(state,job);
    }
    return;
  }
  state.batch.transferBudget=settleTransferAttempt(state.batch.transferBudget,{attemptId:job.id,
    bytesReceived:message.bytesReceived,outcome:message.outcome,outputBytes:message.outputBytes ?? 0,
    outputUnknown:message.outputUnknown ?? message.outcome==='unknown'});
  job.transfer={...job.transfer,settledAt:Date.now(),settlement:message.outcome,
    bytesReceived:message.bytesReceived ?? attempt.maxBytes,outputBytes:message.outputBytes ?? 0,
    outputUnknown:message.outputUnknown ?? message.outcome==='unknown'};
  if (message.outcome === 'unknown' || job.transfer.outputUnknown) {
    job.transfer.usageUnknown=message.outcome === 'unknown';markManagedOutcomeUnknown(state,job);
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
  if (message.type==='scan') {
    scanWorkspace(message,sender).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:publicError(error)}));
    return true;
  }
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
        state.batch = {...settings,id:crypto.randomUUID(),owner:message.instance,
          transferBudget:createTransferBudget(),...(sourceBatchId ? {sourceBatchId} : {})};
        state.ui={...state.ui,saveScope:'selection',failedBatchId:null};
        state.jobs = items.map((item,i)=>({id:crypto.randomUUID(),logicalJobId:crypto.randomUUID(),url:item.url,status:'queued',completionApplied:false,filename:settings.destination === 'directory' ? downloadName(item,settings.folderName,i,KIND,settings.format).split('/').pop() : downloadName(item,settings.folderName,i,KIND,settings.format)}));
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
      case 'managed-reserve': {
        managedReservation(state,message);await save(state);return state;
      }
      case 'managed-settle': {
        managedSettlement(state,message);await save(state);return state;
      }
      case 'converted-download': {
        requireOwner(state,message);
        if (state.batch.destination !== 'downloads' || !['jpg','png','webp'].includes(state.batch.format)) throw new Error('この保存形式では変換後のダウンロードを開始できません。');
        const job=state.jobs.find(job=>job.id === message.jobId);
        if (!job || job.status !== 'in_progress' || job.downloadId || job.cancelRequested) throw new Error('この画像の保存は終了したか、停止しました。');
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
        if (managed(state)) {
          const budget=requireTransferBudget(state);
          if (Date.now() >= budget.deadline) throw new Error('今回の保存の制限時間を超えました。新しい保存として準備してください。');
          if (!transferBudgetRemaining(budget)) throw new Error('今回の保存の容量予算を使い切りました。新しい保存として準備してください。');
          if (!transferOutputBudgetRemaining(budget)) throw new Error('今回の保存の出力容量予算を使い切りました。新しい保存として準備してください。');
          for (const job of state.jobs.filter(job=>job.status==='interrupted')) {
            if (job.outcomeUnknown || ['reserved','unknown'].includes(transferAttempt(state,job)?.status)) throw new Error('前の書き込みの結果を確認できません。保存先を確認してから新しい保存として準備してください。');
            if ((Object.hasOwn(budget.logicalAttempts,job.logicalJobId) ? budget.logicalAttempts[job.logicalJobId] : 0) >= budget.maxAttempts) throw new Error('この画像の再試行回数の上限に達しました。新しい保存として準備してください。');
          }
        }
        for(const job of state.jobs.filter(j=>j.status==='interrupted')) { job.id=crypto.randomUUID();job.status='queued';job.completionApplied=false;delete job.transfer;delete job.chromeOutcomeKnown;delete job.bytesReceived;delete job.totalBytes; delete job.downloadId; delete job.error; delete job.cancelRequested; delete job.cancelReason; delete job.submission; }
        if(managed(state)) {await save(state);return state;}
        return pump(state);
      }
      case 'capture': return claim(state,message.instance,message.mode);
      case 'hello': {
        if(managed(state)) {
          if(state.batch.owner !== message.instance || state.batch.transferBudget?.version !== MEDIA_POLICY_VERSION) {
            abandonManagedTransfers(state);
            await stopJobs(state,'作業ページが再読み込みされ、保存が中断しました。保存済みの画像はそのままに、結果が確定した中断分を再試行できます。');
          }
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
// Downloads and a persistent alarm can wake a suspended worker after its last
// workspace has closed. The 30-second acceptance deadline is checked on wake;
// Chrome may deliver the alarm later (at least one minute on Chrome 116).
async function reconcilePendingStates(downloadId, includeKnown = false) {
  for (const state of await all()) {
    if (!hasPendingSubmission(state) && !(includeKnown && state.jobs.some(job=>job.downloadId === downloadId))) continue;
    if (!state.closed) {
      const owner=await liveTab(state.workspaceTabId);
      if (!await ownsWorkspaceTab(state,owner)) { await closeWorkspace(state); continue; }
    }
    await pump(state);
    if (state.closed && !active(state)) await chrome.storage.session.remove(PREFIX + state.id);
  }
  await syncRecoveryAlarm();
}
chrome.downloads.onChanged.addListener(delta => {
  serial(()=>reconcilePendingStates(delta.id,true)).catch(()=>{});
});
chrome.downloads.onCreated?.addListener(item=>{
  serial(()=>reconcilePendingStates(item.id,true)).catch(()=>{});
});
chrome.alarms?.onAlarm.addListener(alarm=>{
  if (alarm.name !== RECOVERY_ALARM) return;
  serial(()=>reconcilePendingStates()).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(async()=> {
    const flights=await sourceFlights();
    for(const [id,flight] of Object.entries(flights)) if(flight.tabId===tabId)delete flights[id];
    await chrome.storage.session.set({[SOURCE_FLIGHTS_KEY]:flights});
    for(const [key,flight] of scanFlights)if(flight.request.tabId===tabId)scanFlights.delete(key);
    const lock = (await chrome.storage.session.get('captureLock')).captureLock;
    if(lock?.tabId === tabId) await chrome.storage.session.remove('captureLock');
    for(const state of await all()) {
      if(state.workspaceTabId === tabId) await closeWorkspace(state);
      else if (state.tabId === tabId) {
        disposeScan(state);state.sourceEpoch=(state.sourceEpoch || 0)+1;delete state.sourceDocumentId;delete state.scanRequest;
        state.scan={cursor:null,hasMore:false,invalidated:true};await save(state);
      }
    }
  }).catch(()=>{});
});

chrome.tabs.onUpdated?.addListener((tabId,changeInfo,tab)=>{
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  serial(async()=>{
    for (const state of await all()) {
      if (state.workspaceTabId === tabId && (tab.url || changeInfo.url) && (tab.url || changeInfo.url) !== chrome.runtime.getURL(`workspace.html?id=${state.id}`)) await closeWorkspace(state);
      else if (state.tabId === tabId) {
        disposeScan(state);
        state.sourceEpoch=(state.sourceEpoch || 0)+1;delete state.sourceDocumentId;delete state.scanRequest;
        state.scan={cursor:null,hasMore:false,invalidated:true};
        await save(state);
      }
    }
  }).catch(()=>{});
});

// A worker can be restarted without a matching download event. Reconcile its
// persisted pending submissions and restore their alarm on every startup.
serial(()=>reconcilePendingStates()).catch(()=>{});
