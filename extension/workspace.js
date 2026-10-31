import { fileLabel, extensionOf, matchesImage, summarizeJobs, formatBytes, publicError, saveSettings, destinationLabel, permissionOrigins, requiresWorkspace, formatLabel } from './utils.js';
import { getDirectory, putDirectory, deleteDirectory, getLastDestination, putLastDestination } from './directory-store.js';
import { Gallery, candidateCatalog } from './gallery.js';
import { writeImage, writeBlob } from './directory-writer.js';
import { convertImage } from './image-converter.js';
import { createMediaOperation } from './media-reader.js';
import { acquireMediaFetchLease, createPreviewController } from './preview-loader.js';

const KIND = 'images';
const $ = id => document.getElementById(id);
const sessionId = new URL(location.href).searchParams.get('id');
const instance = crypto.randomUUID();
const resourceOwner=`${sessionId}:${instance}:conversion`;
const previewOwner=`${sessionId}:${instance}:preview`;
const hasDownloadId=job=>Number.isSafeInteger(job?.downloadId)&&job.downloadId>=0;
let state, selected = new Set(), visible = [], loading = false, requestPending = false, pollRunning = false;
let recorder = null;
let draft=null, draftHandle=null, draftPermission='prompt', settingsGeneration=0;
let uiWrites=Promise.resolve(), pendingSelections=0, measureTimer, measureUpdates=new Map();
let settings, directoryHandle = null, directoryPermission = 'prompt', managedRunning = false, managedController = null;
let batchDirectoryHandle = null, batchDirectoryPermission = 'prompt';
let settingsWrites = Promise.resolve();
let closingSettings = false;

// A converted download owns its Blob URL until Chrome reports a terminal state.
const convertedURLs = new Map();
function releaseConverted(jobId){
  const owned=convertedURLs.get(jobId);if(!owned)return;
  URL.revokeObjectURL(owned.url);convertedURLs.delete(jobId);
  try{Promise.resolve(owned.release?.()).catch(()=>{});}catch{}
}
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({type, sessionId, instance, ...extra});
  if (!response?.ok) throw new Error(response?.error || '拡張の接続が切れました。作業タブを開き直してください。');
  return response.data;
}
function error(error) { $('error').textContent=publicError(error); $('error').hidden=false; }
function clearError() { $('error').hidden=true; }
function element(tag, cls, text) { const e = document.createElement(tag); if(cls)e.className=cls; if(text !== undefined)e.textContent=text; return e; }
function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.classList.add('icon');svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href',`#icon-${name}`);svg.append(use);return svg;
}
function resetFilters() {
  $('query').value='';$('width').value=0;$('height').value=0;$('type').value='';
  renderImages();
}
function renderFilterState(filters) {
  const conditions=[];
  if(filters.width)conditions.push({id:'width',label:`幅 ${filters.width}px以上`});
  if(filters.height)conditions.push({id:'height',label:`高さ ${filters.height}px以上`});
  if(filters.type)conditions.push({id:'type',label:filters.type.toUpperCase()});
  $('filter-count').textContent=conditions.length;$('filter-count').hidden=!conditions.length;
  $('reset-filters').hidden=!conditions.length && !filters.query;
  $('active-filters').hidden=!conditions.length;
  const previousChip=document.activeElement?.closest('.filter-chip');
  const focusedCondition=previousChip?.dataset.filter;
  $('active-filters').replaceChildren();
  for(const condition of conditions) {
    const chip=element('button','filter-chip');chip.type='button';chip.dataset.filter=condition.id;
    chip.append(element('span','',condition.label),icon('close'));chip.setAttribute('aria-label',`${condition.label}の条件を解除`);
    chip.addEventListener('click',()=>{$(condition.id).value=condition.id==='type' ? '' : 0;renderImages();});
    $('active-filters').append(chip);
  }
  if(focusedCondition) {
    const replacement=[...$('active-filters').children].find(chip=>chip.dataset.filter===focusedCondition);
    (replacement || $('active-filters').firstElementChild || $('filters').querySelector('summary')).focus();
  }
}
function isBusy() { return loading || requestPending || managedRunning || closingSettings || (state && summarizeJobs(state.jobs).active > 0); }
function jobFor(url) { return state.jobs.find(job=>job.url===url) || state.history?.find(job=>job.url===url); }
function jobLabel(job) {
  if (!job) return '';
  if (job.status === 'complete') return `保存完了${job.typeKnown===false?' · 形式不明':''}${job.actualFilename?' · '+job.actualFilename.split(/[\\/]/).pop():''}`;
  if (job.status === 'interrupted') return `中断 · ${job.error || '再試行できます'}`;
  if (job.status === 'queued') return '順番待ち';
  if(state.batch?.format && state.batch.format !== 'original' && !hasDownloadId(job)) return `変換・保存中 · ${formatBytes(job.bytesReceived)}`;
  return `保存中 · ${formatBytes(job.bytesReceived)}${job.totalBytes > 0 ? ' / '+formatBytes(job.totalBytes) : ''}`;
}
function statusElement(item) { const span = element('span','item-status',jobLabel(jobFor(item.url))); span.dataset.url=item.url;span.dataset.state=jobFor(item.url)?.status || '';  return span; }
function applyState(next) {
  if(state && (next.revision || 0) < (state.revision || 0)) return;
  const selectionBefore=[...selected].join('\n');
  state=next;if(!pendingSelections)selected=new Set(state.selectedURLs || []);
  for(const job of state.jobs) if(['complete','interrupted'].includes(job.status) && (!hasDownloadId(job) || job.chromeOutcomeKnown) && !job.outcomeUnknown && convertedURLs.has(job.id)) {
    releaseConverted(job.id);
  }
  updateSummary();
  for(const el of document.querySelectorAll('.item-status')) {const job=jobFor(el.dataset.url);el.textContent=jobLabel(job);el.dataset.state=job?.status || '';}
  if(gallery.mode==='selected' && selectionBefore!==[...selected].join('\n')){gallery.render();visible=gallery.visible;}
  gallery.sync();
}
function persistUI(patch) {
  const selecting=Array.isArray(patch.selectedURLs);
  if(selecting && new Set(patch.selectedURLs).size>500)return Promise.reject(new Error('選択できる画像は500件までです。選択を保存するか、減らしてから操作してください。'));
  if(selecting){pendingSelections++;selected=new Set(patch.selectedURLs);updateSummary();gallery.sync();}
  const task=uiWrites.catch(()=>{}).then(async()=> {
    try {const next=await send('ui',{patch,baseRevision:state.revision || 0});if(selecting)pendingSelections--;applyState(next);return next;}
    catch(e){if(selecting){pendingSelections--;if(!pendingSelections)selected=new Set(state.selectedURLs || []);updateSummary();gallery.sync();}throw e;}
  });
  uiWrites=task;return task;
}
const previews=createPreviewController({ownerId:previewOwner,onInvalidate:()=>gallery.refreshPreviews()});
const gallery=new Gallery({getState:()=>state,getSelected:()=>selected,previews,
  onSelect:urls=>persistUI({selectedURLs:urls}),onView:patch=>persistUI(patch).catch(error),onError:error,
  onRender:items=>{visible=items;updateSummary();},
  onMeasure:update=>{measureUpdates.set(update.url,update);clearTimeout(measureTimer);measureTimer=setTimeout(()=> {
    const updates=[...measureUpdates.values()];measureUpdates.clear();
    send('dimensions',{updates}).then(next=>{applyState(next);}).catch(error);
  },250);},status:url=>jobLabel(jobFor(url))});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)gallery.suspendPreviews();else if(state){gallery.render();if($('image-preview').open&&gallery.viewerURL)gallery.showViewer(gallery.viewerURL);}
});
window.addEventListener('pagehide',()=>{gallery.suspendPreviews();void previews.dispose().catch(()=>{});});
function updateSummary() {
  if(!state) return;
  const batch=summarizeJobs(state.jobs), busy=isBusy();
  $('scan').disabled=busy || Boolean(recorder?.busy);$('next-page').disabled=busy;$('continuation-hint').hidden=!state.scan?.hasMore;
  document.body.dataset.loading=String(loading);
  $('grid').setAttribute('aria-busy',String(loading));
  $('batch').textContent=batch.total ? `今回 ${batch.total}件中 ${batch.complete}件保存完了 · ${batch.interrupted}件中断${batch.active ? ` · ${batch.active}件処理中` : ''}` : '';
  $('batch-panel').hidden=!batch.total;
  $('batch-progress').max=batch.total || 1;
  $('batch-progress').value=batch.complete + batch.interrupted;
  $('batch-progress').setAttribute('aria-valuetext',`${batch.total}件中 ${batch.complete}件保存完了、${batch.interrupted}件中断`);
  $('footer').dataset.batchState=batch.active ? 'active' : batch.interrupted ? 'interrupted' : batch.total ? 'complete' : '';
  $('cancel').hidden=!batch.active;
  $('retry').hidden=!batch.interrupted || batch.active > 0;
  $('retry').disabled=requestPending || managedRunning || state.jobs.some(job=>job.outcomeUnknown);
  const reconnect=state.batch?.destination==='directory' && batchDirectoryHandle && batchDirectoryPermission!=='granted';
  $('retry').textContent=reconnect?'今回の保存先へ再接続':`中断${batch.interrupted}件を再試行`;
  $('prepare-failed').hidden=!batch.interrupted || !!batch.active;
  gallery.setBusy(busy);
  if(settings) renderDestination();
  if(KIND === 'images') {
    const visibleURLs=new Set(gallery.visible.map(i=>i.url));
    const hidden=[...selected].filter(url=>!visibleURLs.has(url)).length;
    $('selection').textContent=`選択${selected.size}件${hidden ? ` · 非表示${hidden}件を含む` : ''}`;
    $('footer').dataset.selected=String(selected.size > 0);
    $('selection-hint').textContent=hidden ? '非表示の画像も保存します' : selected.size ? '選んだ画像をまとめて保存' : '画像をクリックして選択';
    const failedScope=state.ui?.saveScope==='failed' && state.ui.failedBatchId===state.batch?.id;
    $('recovery-summary').hidden=!failedScope;$('recovery-cancel').hidden=!failedScope;
    $('recovery-summary').textContent=`中断した${batch.interrupted}件を新しい保存先・形式で保存します。通常の選択${selected.size}件は保持します。`;
    $('save-label').textContent=failedScope?`中断${batch.interrupted}件を新しく保存`:`選択${selected.size}件を保存`;
    $('save').disabled=!(failedScope?batch.interrupted:selected.size) || busy;
    $('select-visible').disabled=busy || !gallery.visible.length;
    $('clear').disabled=busy || !selected.size;
    for(const el of document.querySelectorAll('.image-select')) el.disabled=busy;
  } else for(const el of document.querySelectorAll('.direct-save')) el.disabled=busy;
}
function renderImages() {
  if(!state)return;
  const filters={query:$('query').value,width:Math.max(0,Number($('width').value)||0),height:Math.max(0,Number($('height').value)||0),type:$('type').value};
  renderFilterState(filters);gallery.render();visible=gallery.visible;updateSummary();
}
async function scan(continuation=false) {
  if(isBusy() || recorder?.busy) return;
  loading=true;clearError();updateSummary();$('message').textContent='画像を探しています…';
  try { await uiWrites.catch(()=>{});applyState(await send('scan',{continuation}));render();const added=state.scan?.addedURLs?.length || 0;
    $('message').textContent=state.scan?.workLimited ? '処理量で区切りました。「続きの候補」で再開できます。選択した画像は保持しています。'
      : state.scan?.scanLimited ? '取得の上限に達しました。取得済みの画像を確認してください。'
      : continuation?`次の${state.items.length}件の候補を取得`:`${state.items.length}件の候補を取得 · 今回追加${added}件`; }
  catch(e){error(e);$('message').textContent='取得できませんでした。元ページからやり直せます。';}
  finally {loading=false;updateSummary();}
}
function render() {
  $('notices').textContent=state.notices.join(' ');$('notices').hidden=!state.notices.length;
  renderImages();
}
async function saveURLs(urls) {
  if(isBusy()) return;
  if(settings.destination === 'directory' && (!directoryHandle || directoryPermission !== 'granted')) {
    openSettings(); settingsError('保存先フォルダの選択・書き込み許可を確認してください。');return;
  }
  // Request only concrete hosts, directly from the save click (user gesture).
  const permission = requiresWorkspace(settings) ? requestImageAccess(urls) : Promise.resolve(true);
  requestPending=true;clearError();updateSummary();
  try {
    if(!await permission) throw new Error('画像の配信元へのアクセスが許可されませんでした。選択は残っています。再度許可するか、Chromeのダウンロード先・元の形式で保存できます。');
    if(settings.destination === 'directory' && await directoryHandle.queryPermission({mode:'readwrite'}) !== 'granted') {
      directoryPermission='prompt';openSettings();throw new Error('フォルダへの書き込み許可を再確認してください。');
    }
    await uiWrites;applyState(await send('save',{urls,settings,sourceBatchId:state.ui?.saveScope==='failed'?state.batch?.id:undefined}));
    if(requiresWorkspace(state.batch)) {
      if(state.batch.destination === 'directory') {
        batchDirectoryHandle=directoryHandle;batchDirectoryPermission=directoryPermission;
        await putDirectory(`batch:${state.batch.id}`,directoryHandle);
      }
      // Do not block the request flag while the controller runs; Stop stays usable.
      requestPending=false;await runManagedBatch(state.batch.destination === 'directory' ? directoryHandle : null);
    }
  } catch(e) {
    error(e);
    if(requiresWorkspace(state?.batch) && summarizeJobs(state.jobs).active && !managedRunning) await interruptManagedJobs(publicError(e)).catch(()=>{});
  } finally {requestPending=false;updateSummary();}
}
async function jobAction(type) {
  if(requestPending) return;
  if(type === 'retry' && managedRunning) return;
  if(type === 'cancel' && managedRunning) {managedController?.abort();$('cancel').disabled=true;return;}
  const custom=type === 'retry' && state.batch?.destination === 'directory';
  const managed=type === 'retry' && requiresWorkspace(state.batch);
  // Reconnect the original batch folder in its own click. A second click can
  // then request site access without stacking two native permission dialogs.
  if(custom && batchDirectoryHandle && batchDirectoryPermission !== 'granted') {
    const permission=batchDirectoryHandle.requestPermission({mode:'readwrite'});
    requestPending=true;clearError();updateSummary();
    try {
      batchDirectoryPermission=await permission;
      if(batchDirectoryPermission !== 'granted') throw new Error('今回の保存先への書き込みが許可されませんでした。中断分はそのまま残っています。');
      $('message').textContent='今回の保存先への書き込みを許可しました。「中断分を再試行」で保存を再開できます。';
    } catch(e) {error(e);} finally {requestPending=false;updateSummary();}
    return;
  }
  const permission=managed ? requestImageAccess(state.jobs.filter(j=>j.status === 'interrupted').map(j=>j.url)) : Promise.resolve(true);
  requestPending=true;clearError();updateSummary();
  try {
    if(!await permission) throw new Error('画像の配信元へのアクセスが許可されませんでした。中断分はそのまま残っています。');
    let handle;
    if(custom) {
      handle=batchDirectoryHandle;
      if(!handle) throw new Error('今回の保存先を復元できません。保存先を選び直し、画像を選択して新しく保存してください。');
      batchDirectoryPermission=await handle.queryPermission({mode:'readwrite'});
      if(batchDirectoryPermission !== 'granted') throw new Error('今回の保存先への書き込み許可が必要です。もう一度「中断分を再試行」を押して許可を確認してください。');
    }
    applyState(await send(type));
    if(managed) {requestPending=false;await runManagedBatch(handle);}
  } catch(e) {error(e);} finally {requestPending=false;updateSummary();}
}

function requestImageAccess(urls) {
  const origins=permissionOrigins(urls);
  return origins.length ? chrome.permissions.request({origins}) : Promise.resolve(true);
}
function settingsError(message) {$('settings-error').textContent=message;$('settings-error').hidden=false;}
function openSettings() {
  if(!settings || !state || isBusy()) return;
  draft={...settings};draftHandle=directoryHandle;draftPermission=directoryPermission;settingsGeneration++;
  $('settings-description').textContent='保存する場所・まとめるフォルダ名・保存形式を指定できます。適用後に保存ボタンを押してください。';
  $('folder-name').value=draft.folderName;$('output-format').value=draft.format || 'original';$('settings-error').hidden=true;
  $('save-settings').showModal();renderDestination();
}
function cancelSettings() {
  if(closingSettings)return;
  settingsGeneration++;draft=null;draftHandle=null;$('save-settings').close();renderDestination();$('destination-change').focus();
}
async function commitSettings(input,handle) {
  const candidate={...input};let preparedKey;
  try {
    if(handle){preparedKey=`session:${sessionId}:${crypto.randomUUID()}`;await send('settings-prepare',{directoryKey:preparedKey});await putDirectory(preparedKey,handle);candidate.directoryKey=preparedKey;}
    return await send('settings',{settings:candidate});
  } catch(e) {
    let current;try{current=await send('get');}catch{}
    const committed=current?.saveSettings && (!preparedKey||current.saveSettings.directoryKey===preparedKey)
      && ['destination','folderName','format'].every(key=>(current.saveSettings[key] || (key==='format'?'original':''))===(candidate[key] || (key==='format'?'original':'')));
    if(committed)return current;
    // An unacknowledged commit may already own the handle. Only remove it once
    // a worker snapshot confirms that it belongs to no applied settings.
    if(preparedKey && current && current.saveSettings?.directoryKey!==preparedKey){await send('settings-abort',{directoryKey:preparedKey}).catch(()=>{});await deleteDirectory(preparedKey).catch(()=>{});}
    throw current?e:new Error('設定の適用結果を確認できません。接続が戻ってから「設定を適用」で確認してください。');
  }
}
async function closeSettings() {
  if(closingSettings || !draft)return;
  const candidate={...draft},handle=draftHandle,permission=draftPermission;
  if(candidate.destination==='directory' && !handle){settingsError('保存するフォルダを選んでください。');return;}
  closingSettings=true;renderDestination();$('settings-done').disabled=true;$('settings-done').textContent='設定を保存中…';
  const accept=async next=>{
    settings={...next.saveSettings};directoryHandle=handle;directoryPermission=permission;applyState(next);
    try {await putLastDestination({handle,destination:settings.destination});}
    catch {error(new Error('今回の設定は適用しましたが、次回の保存先を記憶できませんでした。'));}
    draft=null;draftHandle=null;settingsGeneration++;$('save-settings').close();
  };
  try {
    await accept(await commitSettings(candidate,handle));
  } catch(e) {
    settingsError(publicError(e));
  }
  finally {closingSettings=false;$('settings-done').disabled=false;$('settings-done').textContent='設定を適用';renderDestination();updateSummary();if(!$('save-settings').open)$('destination-change').focus();}
}
function persistSettings() {return send('settings',{settings:{...settings}});}
function renderDestination() {
  if(!settings || !state)return;
  const applied=saveSettings(settings,state.title);$('destination-summary').textContent=destinationLabel(applied);$('destination-summary').title=destinationLabel(applied);
  $('format-summary').textContent=formatLabel(applied.format);
  $('directory-warning').hidden=!requiresWorkspace(applied);
  $('directory-warning').textContent=applied.format!=='original'?'画像を変換して保存します。処理中はこのタブを開いたままにしてください。':'選択したフォルダへ保存します。保存中はこのタブを開いたままにしてください。';
  $('destination-change').disabled=isBusy();
  $('batch-destination').textContent=state.batch?`今回の保存先: ${destinationLabel(state.batch)}`:'';
  $('batch-destination').title=$('batch-destination').textContent;
  $('batch-format').textContent=state.batch?`今回の形式: ${formatLabel(state.batch.format)}`:'';
  if(!draft)return;
  const resolved=saveSettings(draft,state.title),custom=draft.destination==='directory',converting=resolved.format!=='original';
  $('destination-preview').textContent=destinationLabel(resolved);
  $('destination-downloads').checked=!custom;$('destination-directory').checked=custom;
  $('chosen-directory').textContent=draftHandle?`選択した「${draftHandle.name}」`:'フォルダを選んで保存';
  $('directory-status').textContent=!draftHandle?'保存するフォルダを選んでください。':draftPermission==='granted'?'このフォルダに保存できます。':'保存前にフォルダへの書き込み許可を確認してください。';
  $('directory-reconnect').hidden=!custom || !draftHandle || draftPermission==='granted';$('directory-details').hidden=!custom || converting;
  $('format-details').hidden=!converting;$('format-help').hidden=converting;
  $('format-details').textContent=`アニメーションは最初の1コマの静止画になります。複雑なSVG・AVIFなど、安全に検査できない画像は変換せず、元形式で保存できます。${resolved.format==='jpg'?'JPEGの透明部分は白背景です。':'透明部分は保持します。'}画像の配信元へのアクセス許可を確認する場合があります。処理中はこのタブを開いたままにしてください。`;
  $('folder-adjustment').hidden=!draft.folderName.trim() || resolved.folderName===draft.folderName;
  $('folder-adjustment').textContent=`作成する名前: ${resolved.folderName}`;
  const busy=closingSettings || requestPending;
  for(const control of $('save-settings').querySelectorAll('input,select,button'))control.disabled=busy;
  $('destination-directory').disabled=busy || !draftHandle;$('choose-directory').disabled=busy || !window.showDirectoryPicker;
}
async function chooseDirectory() {
  if(closingSettings || requestPending || !draft)return;
  const generation=settingsGeneration;
  const picked=window.showDirectoryPicker({id:'imagecrate-destination',mode:'readwrite',startIn:draftHandle || 'downloads'});
  requestPending=true;$('settings-error').hidden=true;renderDestination();
  try {
    const handle=await picked;if(generation!==settingsGeneration || !draft)return;
    const permission=await handle.queryPermission({mode:'readwrite'});if(generation!==settingsGeneration || !draft)return;
    draftHandle=handle;draftPermission=permission;draft.destination='directory';draft.directoryName=handle.name;
  } catch(e){if(e.name!=='AbortError' && generation===settingsGeneration)settingsError(publicError(e));}
  finally {requestPending=false;renderDestination();}
}
async function reconnectDirectory() {
  if(closingSettings || requestPending || !draftHandle)return;
  const handle=draftHandle,generation=settingsGeneration,permission=handle.requestPermission({mode:'readwrite'});
  requestPending=true;renderDestination();
  try {const result=await permission;if(generation===settingsGeneration && draft){draftPermission=result;if(result!=='granted')settingsError('書き込みが許可されませんでした。選択は残っています。');else $('settings-error').hidden=true;}}
  catch(e){settingsError(publicError(e));}finally{requestPending=false;renderDestination();}
}
async function interruptManagedJobs(reason) {
  // Downloads already handed to Chrome must settle there before a retry.
  if(state.jobs.some(j=>(hasDownloadId(j) || j.submission) && j.status === 'in_progress')) await managedState('cancel');
  const updates=state.jobs.filter(j=>['queued','in_progress'].includes(j.status) && !hasDownloadId(j) && !j.submission).map(j=>({id:j.id,status:'interrupted',error:reason}));
  if(updates.length) await managedState('managed-update',{batchId:state.batch.id,updates});
}
async function managedState(type,extra={},operation) {
  const owned=!operation;
  operation??=createMediaOperation({timeoutMs:20000,idleTimeoutMs:20000});
  // A timed-out RPC may still commit. Always apply its eventual snapshot, but
  // never let that late acknowledgement authorize another fetch or file write.
  const pending=send(type,extra).then(next=>{applyState(next);return next;});
  try{return await operation.wait(pending);}finally{if(owned)operation.dispose();}
}
async function runManagedBatch(handle) {
  managedRunning=true;managedController=new AbortController();$('cancel').disabled=false;updateSummary();
  const controller=managedController,batchId=state.batch.id;
  let updates=Promise.resolve(),progressQueued=null,progressTask=null;
  const report=update=> {
    progressQueued=null;
    const result=updates.then(()=>managedState('managed-update',{batchId,updates:[update]}));
    updates=result.catch(()=>{});return result;
  };
  const reportProgress=update=>{
    progressQueued=update;if(progressTask)return;
    progressTask=(async()=>{
      while(progressQueued&&!controller.signal.aborted){
        const latest=progressQueued;progressQueued=null;
        await managedState('managed-update',{batchId,updates:[latest]});
      }
    })();
    updates=progressTask.catch(e=>{progressQueued=null;controller.abort();error(e);}).finally(()=>{progressTask=null;});
  };
  try {
    const batch={...state.batch};
    let folder=null;
    if(handle){
      const preparation=createMediaOperation({signal:controller.signal,deadline:batch.transferBudget?.deadline});
      try{folder=await preparation.wait(handle.getDirectoryHandle(batch.folderName,{create:true}));}finally{preparation.dispose();}
    }
    for(const job of [...state.jobs].filter(j=>j.status === 'queued')) {
      if(controller.signal.aborted) break;
      let lastProgress=0,sourceBytes=0,operation,blob,reserved=false,reservationKnown=false,fileCommitted=false,resourcesSettled,fetchLease;
      try {
        // The worker persists a conservative reservation before any fetch.
        operation=createMediaOperation({signal:controller.signal,deadline:Math.min(batch.transferBudget?.deadline??Infinity,Date.now()+120000)});
        await operation.wait(updates);reserved=true;
        await managedState('managed-reserve',{batchId,jobId:job.id},operation);reservationKnown=true;
        const transfer=state.jobs.find(current=>current.id===job.id)?.transfer;
        if(!transfer)throw new Error('保存予算を確認できません。新しい保存として準備してください。');
        const attemptDeadline=Math.min(operation.deadline,transfer.deadline);operation.dispose();
        operation=createMediaOperation({signal:controller.signal,deadline:attemptDeadline});
        const progressUpdate=progress=>{
          if(Date.now()-lastProgress < 300) return;lastProgress=Date.now();
          reportProgress({id:job.id,status:'in_progress',...progress});
        };
        fetchLease=await acquireMediaFetchLease(operation,resourceOwner);operation.check();
        const options={signal:operation.signal,operation,maxBytes:transfer.maxBytes,deadline:transfer.deadline,
          onBytes:progress=>{sourceBytes=progress.bytesReceived;},onProgress:progress=>{sourceBytes=Math.max(sourceBytes,progress.bytesReceived||0);progressUpdate(progress);}};
        const settle=async(outcome,outputBytes=0)=>{
          await updates;
          await managedState('managed-settle',{batchId,jobId:job.id,bytesReceived:sourceBytes,outcome,outputBytes});
        };
        if(batch.format && batch.format !== 'original') {
          const item=candidateCatalog(state).find(item=>item.url===job.url);
          blob=await convertImage(job.url,batch.format,{...options,maxInputBytes:transfer.maxBytes,maxOutputBytes:transfer.maxOutputBytes,ownerId:resourceOwner,knownWidth:item?.width,knownHeight:item?.height});
          // Conversion has finished receiving its source. Local encoding output
          // and file writing retain their own byte/pixel ownership, not a fetch slot.
          const completedFetch=fetchLease;fetchLease=null;
          await operation.wait(completedFetch.release());operation.check();
          sourceBytes=Math.max(sourceBytes,blob.sourceBytes||0);
          if(controller.signal.aborted) throw new DOMException('停止しました。','AbortError');
          if(folder) {
            // Local output is a separate accounting unit, not a second network
            // transfer of the original source bytes.
            const result=await writeBlob(folder,job.filename,blob,{signal:operation.signal,operation,maxBytes:transfer.maxOutputBytes,onProgress:progressUpdate});
            fileCommitted=true;await settle('complete',result.bytesReceived);
            await report({id:job.id,status:'complete',...result,typeKnown:result.formatKnown,actualFilename:result.filename});
          } else {
            operation.check();
            const outputBytes=blob.size,outputLease=blob.resourceLease;
            const blobURL=URL.createObjectURL(blob);convertedURLs.set(job.id,{url:blobURL,release:blob.releaseResources});blob=null;
            try {
              // Ownership is checked again in the worker before starting a file.
              await managedState('converted-download',{batchId,jobId:job.id,blobURL,resourceLease:outputLease},operation);
            } catch(e) {
              // A response can be lost after Chrome accepted the download.
              // Recover its ID before releasing data or offering another try.
              let recovered=false;
              try {await managedState('get');recovered=true;} catch {}
              const current=state.jobs.find(j=>j.id===job.id);
              if(recovered && !hasDownloadId(current) && !current?.submission)releaseConverted(job.id);
              throw e;
            }
            while(state.jobs.find(j=>j.id === job.id)?.status === 'in_progress') {
              if(operation.signal.aborted) {await managedState('cancel');break;}
              await operation.wait(new Promise(resolve=>setTimeout(resolve,150)));
              await managedState('get',{},operation);
            }
            const current=state.jobs.find(j=>j.id===job.id);
            await settle(current?.status==='complete'?'complete':current?.status==='interrupted'?'interrupted':'unknown',current?.status==='complete'?outputBytes:0);
            if(current?.status==='in_progress'){controller.abort();break;}
            // An accepted Blob remains alive until Chrome's real terminal state.
          }
        } else {
          const result=await writeImage(folder,job.filename,job.url,options);
          sourceBytes=result.bytesReceived;fileCommitted=true;await settle('complete',result.bytesReceived);
          await report({id:job.id,status:'complete',...result,typeKnown:result.formatKnown,actualFilename:result.filename});
        }
      } catch(e) {
        resourcesSettled=e.resourcesSettled;
        sourceBytes=Math.max(sourceBytes,Number.isSafeInteger(e.bytesReceived)?e.bytesReceived:0);
        const uncertain=Boolean(e.outcomeUnknown || fileCommitted || reserved&&!reservationKnown);
        if(uncertain)controller.abort();
        const reason=uncertain?'書き込みの結果を確認できません。保存先のファイルを確認してから新しい保存として準備してください。'
          :controller.signal.aborted?'停止しました。中断分を再試行できます。':e.name==='NotFoundError'?'保存先が見つかりません。保存先を選び直して、中断分を新しい保存として準備してください。':publicError(e);
        if(reserved){
          await updates;
          const current=state.jobs.find(j=>j.id===job.id);
          await managedState('managed-settle',{batchId,jobId:job.id,bytesReceived:sourceBytes,outcome:uncertain||(hasDownloadId(current)||current?.submission)&&current.status==='in_progress'?'unknown':'interrupted'});
        }
        const current=state.jobs.find(j=>j.id===job.id);
        if(current?.status==='in_progress' && (hasDownloadId(current) || current.submission))controller.abort();
        else await report({id:job.id,status:'interrupted',error:reason});
      } finally {
        operation?.dispose();
        if(fetchLease){
          const ownedFetch=fetchLease;fetchLease=null;
          // On failure the writer may still own a native write/abort. Its
          // resourcesSettled promise, rather than UI rejection, ends this lease.
          void ownedFetch.release(resourcesSettled).catch(()=>{});
        }
        if(blob&&!convertedURLs.has(job.id)){
          const output=blob;
          Promise.resolve(resourcesSettled).then(()=>output.releaseResources?.()).catch(()=>{});
        }
      }
    }
    await updates;
    if(controller.signal.aborted) await interruptManagedJobs('停止しました。中断分を再試行できます。');
  } catch(e) {const reason=e.name==='NotFoundError'?'保存先フォルダが見つかりません。保存先を選び直して、中断分を新しい保存として準備してください。':publicError(e);error(new Error(reason));await interruptManagedJobs(reason).catch(()=>{});}
  finally {managedRunning=false;managedController=null;$('cancel').disabled=false;updateSummary();}
}

$('destination-change').addEventListener('click',openSettings);
$('settings-done').addEventListener('click',closeSettings);
for(const id of ['settings-close','settings-cancel'])$(id).addEventListener('click',cancelSettings);
$('save-settings').addEventListener('cancel',event=>{event.preventDefault();cancelSettings();});
$('choose-directory').addEventListener('click',()=>chooseDirectory().catch(settingsError));
$('directory-reconnect').addEventListener('click',reconnectDirectory);
for(const mode of ['downloads','directory'])$(`destination-${mode}`).addEventListener('change',()=>{if(!draft)return;draft.destination=mode;draft.directoryName=draftHandle?.name || '';renderDestination();});
$('folder-name').addEventListener('input',()=>{if(draft){draft.folderName=$('folder-name').value;renderDestination();}});
$('output-format').addEventListener('change',()=>{if(draft){draft.format=$('output-format').value;renderDestination();}});
$('folder-reset').addEventListener('click',()=>{if(draft){draft.folderName=state.title;$('folder-name').value=draft.folderName;renderDestination();$('folder-name').focus();}});
window.addEventListener('beforeunload',event=>{if(managedRunning || requiresWorkspace(state?.batch) && summarizeJobs(state.jobs).active){event.preventDefault();event.returnValue='';}});
$('source').addEventListener('click',()=>send('source').catch(error));$('scan').addEventListener('click',()=>scan(false));$('next-page').addEventListener('click',()=>scan(true));
$('retry').addEventListener('click',()=>jobAction('retry'));$('cancel').addEventListener('click',()=>jobAction('cancel'));
$('prepare-failed').addEventListener('click',async()=>{
  if(isBusy())return;
  const urls=state.jobs.filter(j=>j.status==='interrupted').map(j=>j.url);
  try {await persistUI({saveScope:'failed',failedBatchId:state.batch.id});openSettings();$('settings-description').textContent=`中断した${urls.length}件を、新しい保存先・形式で保存する設定です。他の選択は保持します。適用後に「中断${urls.length}件を新しく保存」を押してください。`;}
  catch(e){error(e);}
});
$('reset-filters').addEventListener('click',()=>{resetFilters();persistUI(gallery.viewPatch()).catch(error);$('query').focus();});
for(const id of ['filters','help']) {
  const details=$(id),summary=details.querySelector('summary');
  details.addEventListener('toggle',()=>{
    summary.setAttribute('aria-expanded',String(details.open));if(state)persistUI(gallery.viewPatch()).catch(error);
    if(id==='filters' && details.open)requestAnimationFrame(()=>{
      const panel=$('filter-panel').getBoundingClientRect(),footer=$('footer').getBoundingClientRect();
      if(panel.bottom>footer.top || panel.top<0)window.scrollBy({top:panel.top-Math.max(8,(innerHeight-footer.height-panel.height)/2),behavior:'instant'});
    });
  });
  details.addEventListener('keydown',event=>{if(event.key==='Escape'&&details.open){details.open=false;summary.focus();event.preventDefault();}});
}
for(const id of ['query','width','height','type'])$(id).addEventListener('input',()=>{if(state){renderImages();persistUI(gallery.viewPatch()).catch(error);}});
$('select-visible').addEventListener('click',()=>{const urls=[...new Set([...selected,...gallery.visible.map(i=>i.url)])];persistUI({selectedURLs:urls}).then(()=>gallery.sync()).catch(error);});
$('clear').addEventListener('click',()=>persistUI({selectedURLs:[]}).then(()=>renderImages()).catch(error));
$('recovery-cancel').addEventListener('click',()=>persistUI({saveScope:'selection',failedBatchId:null}).catch(error));
$('save').addEventListener('click',()=>saveURLs(state.ui?.saveScope==='failed'&&state.ui.failedBatchId===state.batch?.id?state.jobs.filter(j=>j.status==='interrupted').map(j=>j.url):[...selected]));
let scrollTimer;window.addEventListener('scroll',()=>{if(!state)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>persistUI(gallery.viewPatch()).catch(error),200);},{passive:true});
try {
  state=await send('hello');selected=new Set(state.selectedURLs || []);$('source-title').textContent=state.title;$('source-title').title=state.title;
  let remembered;
  try {
    await send('prune-directories');
    if(!state.saveSettings&&!state.batch)remembered=await getLastDestination();
    if(state.batch?.destination==='directory'){batchDirectoryHandle=await getDirectory(`batch:${state.batch.id}`);if(batchDirectoryHandle)batchDirectoryPermission=await batchDirectoryHandle.queryPermission({mode:'readwrite'});}
    if(state.saveSettings)directoryHandle=await getDirectory(state.saveSettings.directoryKey || `session:${sessionId}`);
    else if(state.batch)directoryHandle=state.batch.destination==='directory'?(batchDirectoryHandle || await getDirectory(`session:${sessionId}`)):null;
    else directoryHandle=await getDirectory(`session:${sessionId}`) || remembered?.handle;
    if(directoryHandle)directoryPermission=await directoryHandle.queryPermission({mode:'readwrite'});
  } catch(e){error(e);if(!state.saveSettings)throw e;}
  let sessionSettings=state.saveSettings;
  if(!sessionSettings) {
    // Inherit the last location once. Pin its handle and defaults to this
    // session before any interaction; another workspace may change "last".
    const initial=state.batch?saveSettings(state.batch,state.title):{destination:remembered?.destination==='directory'&&directoryHandle?'directory':'downloads',
      folderName:state.title,directoryName:directoryHandle?.name || '',format:'original'};
    // Older sessions could start a batch before recording settings. Its fixed
    // snapshot is authoritative while active; commit it on a later reload.
    if(state.batch&&summarizeJobs(state.jobs).active)sessionSettings=initial;
    else {state=await commitSettings(initial,directoryHandle);sessionSettings=state.saveSettings;}
  }
  settings={format:'original',...sessionSettings};
  if(settings.destination==='directory'&&directoryHandle)settings.directoryName=directoryHandle.name;
  $('folder-name').value=settings.folderName;$('output-format').value=settings.format;renderDestination();
  try{$('source-domain').textContent=new URL(state.url).hostname;}catch{}
  gallery.restore(state.ui);render();
  if(!state.scanned)await scan();else{$('message').textContent='前回の取得結果を表示';applyState(await send('get'));}
  requestAnimationFrame(()=>window.scrollTo(0,state.ui?.scrollY || 0));
  setInterval(async()=>{if(pollRunning||loading||requestPending||!state)return;pollRunning=true;try{if(summarizeJobs(state.jobs).active)applyState(await send('get'));}catch(e){error(e);}finally{pollRunning=false;}},1000);
} catch(e){error(e);$('message').textContent='元ページで拡張アイコンを押し直してください。';$('scan').disabled=true;}
