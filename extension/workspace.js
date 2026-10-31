import { fileLabel, extensionOf, matchesImage, summarizeJobs, formatBytes, publicError, saveSettings, destinationLabel, permissionOrigins } from './utils.js';
import { getDirectory, putDirectory } from './directory-store.js';
import { writeImage } from './directory-writer.js';

const KIND = 'images';
const $ = id => document.getElementById(id);
const sessionId = new URL(location.href).searchParams.get('id');
const instance = crypto.randomUUID();
let state, selected = new Set(), visible = [], loading = false, requestPending = false, pollRunning = false;
let recorder = null;
let settings, directoryHandle = null, directoryPermission = 'prompt', directoryRunning = false, directoryController = null;
let batchDirectoryHandle = null, batchDirectoryPermission = 'prompt';
let settingsWrites = Promise.resolve();
let closingSettings = false;
const handledCompletions = new Set();
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
function isBusy() { return loading || requestPending || directoryRunning || closingSettings || (state && summarizeJobs(state.jobs).active > 0); }
function jobFor(url) { return state.jobs.find(job=>job.url===url) || state.history?.find(job=>job.url===url); }
function jobLabel(job) {
  if (!job) return '';
  if (job.status === 'complete') return '保存完了';
  if (job.status === 'interrupted') return `中断 · ${job.error || '再試行できます'}`;
  if (job.status === 'queued') return '順番待ち';
  return `保存中 · ${formatBytes(job.bytesReceived)}${job.totalBytes > 0 ? ' / '+formatBytes(job.totalBytes) : ''}`;
}
function statusElement(item) { const span = element('span','item-status',jobLabel(jobFor(item.url))); span.dataset.url=item.url;span.dataset.state=jobFor(item.url)?.status || '';  return span; }
function applyState(next) {
  state = next;
  for(const job of state.jobs) {
    const key=`${job.id || job.downloadId}:${job.url}`;
    if(job.status === 'complete' && !handledCompletions.has(key)) { selected.delete(job.url); handledCompletions.add(key); }
  }
  updateSummary();
  for(const el of document.querySelectorAll('.item-status')) { const job=jobFor(el.dataset.url);el.textContent=jobLabel(job);el.dataset.state=job?.status || ''; }
  for(const checkbox of document.querySelectorAll('.image-select')) checkbox.checked=selected.has(checkbox.dataset.url);
}
function updateSummary() {
  if(!state) return;
  const batch=summarizeJobs(state.jobs), busy=isBusy();
  $('scan').disabled=busy || Boolean(recorder?.busy);
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
  $('retry').disabled=requestPending;
  if(settings) renderDestination();
  if(KIND === 'images') {
    const visibleURLs=new Set(visible.map(i=>i.url));
    const hidden=[...selected].filter(url=>!visibleURLs.has(url)).length;
    $('selection').textContent=`選択${selected.size}件${hidden ? ` · 非表示${hidden}件を含む` : ''}`;
    $('footer').dataset.selected=String(selected.size > 0);
    $('selection-hint').textContent=hidden ? '非表示の画像も保存します' : selected.size ? '選んだ画像をまとめて保存' : '画像をクリックして選択';
    $('save-label').textContent=`選択${selected.size}件を保存`;
    $('save').disabled=!selected.size || busy;
    $('select-visible').disabled=busy || !visible.length;
    $('clear').disabled=busy || !selected.size;
    for(const el of document.querySelectorAll('.image-select')) el.disabled=busy;
  } else for(const el of document.querySelectorAll('.direct-save')) el.disabled=busy;
}
function renderImages() {
  const filters={query:$('query').value,width:Math.max(0,Number($('width').value)||0),height:Math.max(0,Number($('height').value)||0),type:$('type').value};
  visible=state.items.filter(item=>matchesImage(item,filters));
  renderFilterState(filters);
  $('count').textContent=`表示${visible.length} / 全${state.items.length}件`;
  $('grid').replaceChildren();
  for(const [index,item] of visible.entries()) {
    const card=element('label','card');
    const thumb=element('div','thumb');
    const image=new Image(); image.loading='lazy'; image.alt=''; image.referrerPolicy='no-referrer';
    image.addEventListener('error',()=>{ const fallback=element('span','preview-error');fallback.append(icon('image'),element('span','','プレビューなし'));thumb.replaceChildren(fallback); }); image.src=item.url; thumb.append(image);
    const body=element('div','card-body');
    const input=element('input','image-select'); input.type='checkbox';input.dataset.url=item.url; input.checked=selected.has(item.url);
    input.setAttribute('aria-label',`${fileLabel(item.url)}を選択`);
    input.setAttribute('aria-describedby',`image-meta-${index} image-status-${index}`);
    input.addEventListener('change',()=>{input.checked ? selected.add(item.url) : selected.delete(item.url);updateSummary();});
    const name=element('strong','file-name',fileLabel(item.url)); name.title=fileLabel(item.url);
    const meta=element('span','meta');meta.id=`image-meta-${index}`;
    meta.append(element('span','',item.width && item.height ? `${item.width} × ${item.height}` : '寸法不明'),element('span','file-type',extensionOf(item.url,'images').toUpperCase()));
    const status=statusElement(item);status.id=`image-status-${index}`;
    body.append(input,name,meta,status);
    card.append(thumb,body); $('grid').append(card);
  }
  $('empty').hidden=visible.length > 0;
  $('empty').replaceChildren(icon(state.items.length ? 'search' : 'image'),element('h3','',state.items.length ? '一致する画像がありません' : '画像が見つかりませんでした'),element('p','',state.items.length ? '条件を変えるか、リセットしてすべて表示。' : '元ページで画像を表示してから、再スキャンしてください。'));
  if(state.items.length && !visible.length) {
    const reset=element('button','secondary','条件をリセット');reset.addEventListener('click',()=>{resetFilters();$('query').focus();});$('empty').append(reset);
  } else if(!state.items.length) {
    const source=element('button','secondary','元ページを開く');source.prepend(icon('arrow'));source.addEventListener('click',()=>send('source').catch(error));$('empty').append(source);
  }
  updateSummary();
}
async function scan() {
  if(isBusy() || recorder?.busy) return;
  loading=true;clearError();updateSummary();$('message').textContent='画像を探しています…';
  try { applyState(await send('scan'));render();$('message').textContent=`${state.items.length}件の候補を取得`; }
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
  const permission = settings.destination === 'directory' ? requestImageAccess(urls) : Promise.resolve(true);
  requestPending=true;clearError();updateSummary();
  try {
    if(!await permission) throw new Error('画像の配信元へのアクセスが許可されませんでした。選択は残っています。許可して保存するか、保存先をChromeのダウンロード先に戻してください。');
    if(settings.destination === 'directory' && await directoryHandle.queryPermission({mode:'readwrite'}) !== 'granted') {
      directoryPermission='prompt';openSettings();throw new Error('フォルダへの書き込み許可を再確認してください。');
    }
    applyState(await send('save',{urls,settings}));
    if(state.batch.destination === 'directory') {
      batchDirectoryHandle=directoryHandle;batchDirectoryPermission=directoryPermission;
      await putDirectory(`batch:${state.batch.id}`,directoryHandle);
      // Do not block the request flag while the controller runs; Stop stays usable.
      requestPending=false;await runDirectoryBatch(directoryHandle);
    }
  } catch(e) {
    error(e);
    if(state?.batch?.destination === 'directory' && summarizeJobs(state.jobs).active && !directoryRunning) await interruptDirectoryJobs(publicError(e)).catch(()=>{});
  } finally {requestPending=false;updateSummary();}
}
async function jobAction(type) {
  if(requestPending) return;
  if(type === 'cancel' && directoryRunning) {directoryController?.abort();$('cancel').disabled=true;return;}
  const custom=type === 'retry' && state.batch?.destination === 'directory';
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
  const permission=custom ? requestImageAccess(state.jobs.filter(j=>j.status === 'interrupted').map(j=>j.url)) : Promise.resolve(true);
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
    if(custom) {requestPending=false;await runDirectoryBatch(handle);}
  } catch(e) {error(e);} finally {requestPending=false;updateSummary();}
}

function requestImageAccess(urls) {
  const origins=permissionOrigins(urls);
  return origins.length ? chrome.permissions.request({origins}) : Promise.resolve(true);
}
function settingsError(message) {$('settings-error').textContent=message;$('settings-error').hidden=false;}
function openSettings() {
  if(!settings || !state) return;
  if(!$('save-settings').open) $('save-settings').showModal();
  renderDestination();
}
async function closeSettings() {
  if(closingSettings) return;closingSettings=true;
  $('settings-done').disabled=true;$('settings-done').textContent='設定を保存中…';
  updateSummary();
  try {
    await settingsWrites.catch(()=>{});
    await send('settings',{settings:{...settings}});
    $('save-settings').close();
  } catch(e) {settingsError(publicError(e));}
  finally {
    closingSettings=false;$('settings-done').disabled=false;$('settings-done').textContent='この設定で戻る';updateSummary();
    if(!$('save-settings').open) $('destination-change').focus();
  }
}
function persistSettings() {
  const snapshot={...settings};
  settingsWrites=settingsWrites.catch(()=>{}).then(()=>send('settings',{settings:snapshot}));
  settingsWrites.catch(e=>settingsError(publicError(e)));
}
function renderDestination() {
  const resolved=saveSettings(settings,state.title), label=destinationLabel(resolved), custom=settings.destination === 'directory';
  $('destination-summary').textContent=label;$('destination-summary').title=label;
  $('destination-preview').textContent=label;
  $('destination-downloads').checked=!custom;$('destination-directory').checked=custom;
  $('chosen-directory').textContent=directoryHandle ? `選択した「${directoryHandle.name}」` : 'フォルダを選んで保存';
  $('directory-status').textContent=!directoryHandle ? '保存するフォルダを選んでください。' : directoryPermission === 'granted' ? 'このフォルダに保存できます。' : '保存前にフォルダへの書き込み許可を確認してください。';
  $('directory-reconnect').hidden=!custom || !directoryHandle || directoryPermission === 'granted';
  $('directory-details').hidden=!custom;
  $('directory-warning').hidden=!custom;
  $('folder-adjustment').hidden=!settings.folderName.trim() || resolved.folderName === settings.folderName;
  $('folder-adjustment').textContent=`使用できない文字や長さを調整します。作成する名前: ${resolved.folderName}`;
  const busy=isBusy();
  $('destination-change').disabled=busy;
  for(const control of $('save-settings').querySelectorAll('input,button')) {
    if(!['settings-close','settings-done'].includes(control.id)) control.disabled=busy;
  }
  $('destination-directory').disabled=busy || !directoryHandle;
  $('choose-directory').disabled=busy || !window.showDirectoryPicker;
  if(!window.showDirectoryPicker) $('directory-status').textContent='この環境ではフォルダ選択に対応していません。Chromeのダウンロード先を使用できます。';
  $('batch-destination').textContent=state.batch ? `今回の保存先: ${destinationLabel(state.batch)}` : '';
  $('batch-destination').title=$('batch-destination').textContent;
}
async function chooseDirectory() {
  if(isBusy()) return;
  // Native picker must be invoked before the first await.
  const picked=window.showDirectoryPicker({id:'imagecrate-destination',mode:'readwrite',startIn:directoryHandle || 'downloads'});
  requestPending=true;$('settings-error').hidden=true;updateSummary();
  try {
    const handle=await picked;
    // Persist before replacing the previous usable setting.
    await putDirectory(`session:${sessionId}`,handle);await putDirectory('last',handle);
    directoryHandle=handle;directoryPermission=await handle.queryPermission({mode:'readwrite'});
    settings.destination='directory';settings.directoryName=handle.name;
    await chrome.storage.local.set({saveDestination:'directory'});persistSettings();
  } catch(e) {if(e.name !== 'AbortError') settingsError(publicError(e));}
  finally {requestPending=false;updateSummary();}
}
async function reconnectDirectory() {
  if(isBusy() || !directoryHandle) return;
  const permission=directoryHandle.requestPermission({mode:'readwrite'});
  requestPending=true;updateSummary();
  try {directoryPermission=await permission;if(directoryPermission !== 'granted') settingsError('書き込みが許可されませんでした。選択したフォルダはそのまま残っています。');else $('settings-error').hidden=true;}
  catch(e) {settingsError(publicError(e));} finally {requestPending=false;updateSummary();}
}
async function interruptDirectoryJobs(reason) {
  const updates=state.jobs.filter(j=>['queued','in_progress'].includes(j.status)).map(j=>({id:j.id,status:'interrupted',error:reason}));
  if(updates.length) applyState(await send('directory-update',{batchId:state.batch.id,updates}));
}
async function runDirectoryBatch(handle) {
  directoryRunning=true;directoryController=new AbortController();$('cancel').disabled=false;updateSummary();
  const controller=directoryController,batchId=state.batch.id;
  let updates=Promise.resolve();
  const report=update=> {
    const result=updates.then(()=>send('directory-update',{batchId,updates:[update]})).then(applyState);
    updates=result.catch(()=>{});return result;
  };
  try {
    const folder=await handle.getDirectoryHandle(state.batch.folderName,{create:true});
    for(const job of [...state.jobs].filter(j=>j.status === 'queued')) {
      if(controller.signal.aborted) break;
      await report({id:job.id,status:'in_progress'});
      let lastProgress=0;
      try {
        const result=await writeImage(folder,job.filename,job.url,{signal:controller.signal,onProgress:progress=>{
          if(Date.now()-lastProgress < 300) return;lastProgress=Date.now();
          report({id:job.id,status:'in_progress',...progress}).catch(e=>{controller.abort();error(e);});
        }});
        await report({id:job.id,status:'complete',...result});
      } catch(e) {
        const reason=controller.signal.aborted ? '停止しました。中断分を再試行できます。' : e.name === 'TypeError' ? '画像を取得できません。接続・サイトの認証・配信元の制限を確認するか、Chromeのダウンロード先で新しく保存してください。' : publicError(e);
        await report({id:job.id,status:'interrupted',error:reason});
      }
    }
    await updates;
    if(controller.signal.aborted) await interruptDirectoryJobs('停止しました。中断分を再試行できます。');
  } catch(e) {error(e);await interruptDirectoryJobs(publicError(e)).catch(()=>{});}
  finally {directoryRunning=false;directoryController=null;$('cancel').disabled=false;updateSummary();}
}

$('destination-change').addEventListener('click',openSettings);
for(const id of ['settings-close','settings-done']) $(id).addEventListener('click',closeSettings);
$('save-settings').addEventListener('cancel',event=>{event.preventDefault();closeSettings();});
$('choose-directory').addEventListener('click',()=>chooseDirectory().catch(settingsError));
$('directory-reconnect').addEventListener('click',reconnectDirectory);
for(const mode of ['downloads','directory']) $(`destination-${mode}`).addEventListener('change',()=>{
  if(isBusy()) return;settings.destination=mode;settings.directoryName=directoryHandle?.name || '';
  chrome.storage.local.set({saveDestination:mode}).catch(e=>settingsError(publicError(e)));persistSettings();renderDestination();
});
$('folder-name').addEventListener('input',()=>{settings.folderName=$('folder-name').value;persistSettings();renderDestination();});
$('folder-reset').addEventListener('click',()=>{settings.folderName=state.title;$('folder-name').value=settings.folderName;persistSettings();renderDestination();$('folder-name').focus();});
window.addEventListener('beforeunload',event=>{if(directoryRunning || state?.batch?.destination === 'directory' && summarizeJobs(state.jobs).active) {event.preventDefault();event.returnValue='';}});
$('source').addEventListener('click',()=>send('source').catch(error));$('scan').addEventListener('click',scan);
$('retry').addEventListener('click',()=>jobAction('retry'));$('cancel').addEventListener('click',()=>jobAction('cancel'));
$('reset-filters').addEventListener('click',()=>{resetFilters();$('query').focus();});
for(const id of ['filters','help']) {
  const details=$(id), summary=details.querySelector('summary');
  details.addEventListener('toggle',()=>summary.setAttribute('aria-expanded',String(details.open)));
  details.addEventListener('keydown',event=>{if(event.key==='Escape' && details.open){details.open=false;summary.focus();event.preventDefault();}});
}
if(KIND === 'images') {
  for(const id of ['query','width','height','type']) $(id).addEventListener('input',()=>{if(state)renderImages();});
  $('select-visible').addEventListener('click',()=>{for(const i of visible)selected.add(i.url);applyState(state);});
  $('clear').addEventListener('click',()=>{selected.clear();applyState(state);});
  $('save').addEventListener('click',()=>saveURLs([...selected]));
}
try {
  state=await send('hello');$('source-title').textContent=state.title;$('source-title').title=state.title;
  try {
    await send('prune-directories');
    directoryHandle=await getDirectory(`session:${sessionId}`) || await getDirectory('last');
    if(directoryHandle) {
      await putDirectory(`session:${sessionId}`,directoryHandle);
      directoryPermission=await directoryHandle.queryPermission({mode:'readwrite'});
    }
    if(state.batch?.destination === 'directory') {
      batchDirectoryHandle=await getDirectory(`batch:${state.batch.id}`);
      if(batchDirectoryHandle) batchDirectoryPermission=await batchDirectoryHandle.queryPermission({mode:'readwrite'});
    }
  } catch(e) {error(e);}
  const remembered=(await chrome.storage.local.get('saveDestination')).saveDestination;
  settings=state.saveSettings || {destination:remembered === 'directory' && directoryHandle ? 'directory' : 'downloads',folderName:state.title,directoryName:directoryHandle?.name || ''};
  if(settings.destination === 'directory' && directoryHandle) settings.directoryName=directoryHandle.name;
  $('folder-name').value=settings.folderName;persistSettings();renderDestination();
  try{$('source-domain').textContent=new URL(state.url).hostname;}catch{}
  render();
  if(!state.scanned)await scan();else{$('message').textContent='前回の取得結果を表示';applyState(await send('get'));}
  setInterval(async()=> {
    if(pollRunning || loading || requestPending || !state) return;
    pollRunning=true;
    try{if(summarizeJobs(state.jobs).active)applyState(await send('get'));}catch(e){error(e);}finally{pollRunning=false;}
  },1000);
} catch(e){error(e);$('message').textContent='元ページで拡張アイコンを押し直してください。';$('scan').disabled=true;}
