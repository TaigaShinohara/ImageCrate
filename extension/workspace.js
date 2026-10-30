import { fileLabel, extensionOf, matchesImage, summarizeJobs, formatBytes, publicError } from './utils.js';

const KIND = 'images';
const $ = id => document.getElementById(id);
const sessionId = new URL(location.href).searchParams.get('id');
const instance = crypto.randomUUID();
let state, selected = new Set(), visible = [], loading = false, requestPending = false, pollRunning = false;
let recorder = null;
const handledCompletions = new Set();
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({type, sessionId, instance, ...extra});
  if (!response?.ok) throw new Error(response?.error || '拡張の接続が切れました。作業タブを開き直してください。');
  return response.data;
}
function error(error) { $('error').textContent=publicError(error); $('error').hidden=false; }
function clearError() { $('error').hidden=true; }
function element(tag, cls, text) { const e = document.createElement(tag); if(cls)e.className=cls; if(text !== undefined)e.textContent=text; return e; }
function isBusy() { return loading || requestPending || (state && summarizeJobs(state.jobs).active > 0); }
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
    const key=`${job.downloadId}:${job.url}`;
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
  $('batch').textContent=batch.total ? `今回 ${batch.total}件中 ${batch.complete}件保存完了 · ${batch.interrupted}件中断${batch.active ? ` · ${batch.active}件処理中` : ''}` : '';
  $('cancel').hidden=!batch.active;
  $('retry').hidden=!batch.interrupted || batch.active > 0;
  $('retry').disabled=requestPending;
  if(KIND === 'images') {
    const visibleURLs=new Set(visible.map(i=>i.url));
    const hidden=[...selected].filter(url=>!visibleURLs.has(url)).length;
    $('selection').textContent=`選択${selected.size}件${hidden ? ` · 非表示${hidden}件を含む` : ''}`;
    $('save').textContent=`選択${selected.size}件を保存`;
    $('save').disabled=!selected.size || busy;
    $('select-visible').disabled=busy || !visible.length;
    $('clear').disabled=busy || !selected.size;
    for(const el of document.querySelectorAll('.image-select')) el.disabled=busy;
  } else for(const el of document.querySelectorAll('.direct-save')) el.disabled=busy;
}
function renderImages() {
  const filters={query:$('query').value,width:Math.max(0,Number($('width').value)||0),height:Math.max(0,Number($('height').value)||0),type:$('type').value};
  visible=state.items.filter(item=>matchesImage(item,filters));
  $('count').textContent=`表示${visible.length} / 全${state.items.length}件`;
  $('grid').replaceChildren();
  for(const item of visible) {
    const card=element('label','card');
    const thumb=element('div','thumb');
    const image=new Image(); image.loading='lazy'; image.alt=''; image.referrerPolicy='no-referrer';
    image.addEventListener('error',()=>{ thumb.replaceChildren(element('span','meta','プレビューを表示できません')); }); image.src=item.url; thumb.append(image);
    const body=element('div','card-body');
    const input=element('input','image-select'); input.type='checkbox';input.dataset.url=item.url; input.checked=selected.has(item.url);
    input.setAttribute('aria-label',`${fileLabel(item.url)}を選択`);
    input.addEventListener('change',()=>{input.checked ? selected.add(item.url) : selected.delete(item.url);updateSummary();});
    const name=element('strong','file-name',fileLabel(item.url)); name.title=fileLabel(item.url);
    body.append(input,name,element('span','meta',`${item.width && item.height ? `${item.width} × ${item.height}` : '寸法不明'} · ${extensionOf(item.url,'images').toUpperCase()}`),statusElement(item));
    card.append(thumb,body); $('grid').append(card);
  }
  $('empty').hidden=visible.length > 0;
  $('empty').replaceChildren(element('h3','',state.items.length ? 'フィルターに一致しません' : '取得できる画像がありません'),element('p','',state.items.length ? '検索・最小寸法・種類を変更してください。' : '元ページで画像を表示し、スクロールしてから再スキャンしてください。'));
  if(state.items.length && !visible.length) {
    const reset=element('button','secondary','フィルターを解除');reset.addEventListener('click',()=>{$('query').value='';$('width').value=0;$('height').value=0;$('type').value='';renderImages();});$('empty').append(reset);
  }
  updateSummary();
}
async function scan() {
  if(isBusy() || recorder?.busy) return;
  loading=true;clearError();updateSummary();$('message').textContent='ページから候補を探しています…';
  try { applyState(await send('scan'));render();$('message').textContent=`${state.items.length}件の候補を取得しました。保存前に対象を確認してください。`; }
  catch(e){error(e);$('message').textContent='取得できませんでした。元ページからやり直せます。';}
  finally {loading=false;updateSummary();}
}
function render() {
  $('notices').textContent=state.notices.join(' ');$('notices').hidden=!state.notices.length;
  renderImages();
}
async function saveURLs(urls) {
  if(isBusy()) return;
  requestPending=true;clearError();updateSummary();
  try{applyState(await send('save',{urls}));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
async function jobAction(type) {
  if(requestPending) return;requestPending=true;clearError();updateSummary();
  try{applyState(await send(type));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
$('source').addEventListener('click',()=>send('source').catch(error));$('scan').addEventListener('click',scan);
$('retry').addEventListener('click',()=>jobAction('retry'));$('cancel').addEventListener('click',()=>jobAction('cancel'));
if(KIND === 'images') {
  for(const id of ['query','width','height','type']) $(id).addEventListener('input',()=>{if(state)renderImages();});
  $('select-visible').addEventListener('click',()=>{for(const i of visible)selected.add(i.url);renderImages();});
  $('clear').addEventListener('click',()=>{selected.clear();renderImages();});
  $('save').addEventListener('click',()=>saveURLs([...selected]));
}
try {
  state=await send('hello');$('source-title').textContent=state.title;
  try{$('source-domain').textContent=new URL(state.url).hostname;}catch{}
  render();
  if(!state.scanned)await scan();else{$('message').textContent='前回の取得結果を表示しています。再スキャンで追加できます。';applyState(await send('get'));}
  setInterval(async()=> {
    if(pollRunning || loading || requestPending || !state) return;
    pollRunning=true;
    try{if(summarizeJobs(state.jobs).active)applyState(await send('get'));}catch(e){error(e);}finally{pollRunning=false;}
  },1000);
} catch(e){error(e);$('message').textContent='元ページで拡張アイコンを押し直してください。';$('scan').disabled=true;}
