import { collect } from './collector.js';
import { allowedURL, mediaType, mergeItems, downloadName, summarizeJobs, publicError, saveSettings } from './utils.js';
import { pruneDirectories } from './directory-store.js';
const KIND = 'images';
const PREFIX = 'workspace:';
let operations = Promise.resolve();
// One mutation queue protects storage read/modify/write across concurrent events.
const serial = task => { const next = operations.then(task); operations = next.catch(() => {}); return next; };
const save = state => {
  if(!state.closed) {
    const latest=new Map((state.history || []).map(job=>[job.url,job]));
    for(const job of state.jobs) latest.set(job.url,{...job});
    state.history=[...latest.values()].slice(-500);
  }
  return chrome.storage.session.set({[PREFIX + state.id]:state});
};
const load = async id => (await chrome.storage.session.get(PREFIX + id))[PREFIX + id];
const all = async () => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith(PREFIX)).map(([,v])=>v);
const active = state => summarizeJobs(state.jobs).active > 0;
async function liveTab(id) { try { return await chrome.tabs.get(id); } catch { return null; } }

export async function openWorkspace(tab) {
  return serial(async () => {
    const existing = await all();
    for (const state of existing) {
      const manager=await liveTab(state.workspaceTabId);
      if (manager?.url !== chrome.runtime.getURL(`workspace.html?id=${state.id}`)) { state.closed=true;state.items=[];state.history=[];if(active(state) && state.batch?.destination !== 'directory') await pump(state); if(!active(state) || state.batch?.destination === 'directory') await chrome.storage.session.remove(PREFIX + state.id); continue; }
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

async function scan(state) {
  if (active(state)) throw new Error('保存処理が終わってから再スキャンしてください。');
  const tab = await liveTab(state.tabId);
  if (!tab || tab.url !== state.url) throw new Error('元ページが閉じられたか移動しました。そのページで拡張アイコンを押し直してください。');
  if (!/^https?:\/\//.test(tab.url)) throw new Error('通常のHTTP/HTTPSページで拡張アイコンを押してください。Chromeの設定・ストア等は取得できません。');
  const results = await chrome.scripting.executeScript({target:{tabId:state.tabId},func:collect});
  const result = results[0]?.result;
  if (!result) throw new Error('ページの画像・動画を取得できませんでした。元ページからやり直してください。');
  const incoming = result.items.map(item => ({...item, type:KIND === 'videos' ? mediaType(item.url,item.mime) : 'image'}));
  state.items = mergeItems(state.items,incoming).slice(0,500);
  state.notices = result.notices;
  if (state.items.length === 500) state.notices = [...new Set([...state.notices,'候補は500件まで表示します。'])];
  state.scanned = true;
  await save(state); return state;
}
async function refreshJob(job) {
  if (!job.downloadId || job.status !== 'in_progress') return;
  const [item] = await chrome.downloads.search({id:job.downloadId});
  if (!item) { job.status='interrupted'; job.error='ダウンロード履歴から見つかりません。再試行できます。'; return; }
  job.bytesReceived = item.bytesReceived; job.totalBytes = item.totalBytes;
  job.status = item.state;
  if (item.error) job.error = item.error;
  if (item.state === 'complete' && /^(text\/html|application\/(json|xml))/i.test(item.mime || '')) {
    job.status='interrupted'; job.error='メディアではない応答が保存されました。サイトの認証・制限を確認してください。';
  }
}
async function pump(state) {
  if (state.batch?.destination === 'directory') return state;
  for (const job of state.jobs) await refreshJob(job);
  if (!state.jobs.some(j=>j.status === 'in_progress')) {
    for (const job of state.jobs.filter(j=>j.status === 'queued')) {
      try {
        job.downloadId = await chrome.downloads.download({url:job.url,filename:job.filename,conflictAction:'uniquify',saveAs:false});
        job.status='in_progress'; await save(state); await refreshJob(job);
        if (job.status === 'in_progress') break;
      } catch (error) { job.status='interrupted'; job.error=publicError(error); }
    }
  }
  await save(state); return state;
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
        await pruneDirectories(['last',...sessions.flatMap(s=>[`session:${s.id}`,...(s.batch?.id ? [`batch:${s.batch.id}`] : [])])]);
        return {};
      }
      case 'scan': return scan(state);
      case 'source': { const tab = await liveTab(state.tabId); if(!tab) throw new Error('元ページは閉じられています。'); await chrome.tabs.update(state.tabId,{active:true}); return {}; }
      case 'save': {
        if (active(state)) throw new Error('保存処理中です。');
        const chosen = new Set(message.urls);
        const items = state.items.filter(item=>chosen.has(item.url) && allowedURL(item.url,KIND) && (KIND !== 'videos' || item.type === 'direct'));
        if (!items.length) throw new Error('保存する対象を選んでください。');
        const settings = saveSettings(message.settings || state.saveSettings, state.title);
        if (settings.destination === 'directory' && !settings.directoryName) throw new Error('保存先フォルダを選んでください。');
        state.batch = {...settings,id:crypto.randomUUID(),owner:message.instance};
        state.jobs = items.map((item,i)=>({id:crypto.randomUUID(),url:item.url,status:'queued',filename:settings.destination === 'directory' ? downloadName(item,settings.folderName,i,KIND).split('/').pop() : downloadName(item,settings.folderName,i,KIND)}));
        if (settings.destination === 'directory') { await save(state); return state; }
        return pump(state);
      }
      case 'settings': {
        if (active(state)) throw new Error('保存処理が終わってから設定を変更してください。');
        const input = message.settings || {};
        state.saveSettings = {...saveSettings(input,state.title),folderName:String(input.folderName ?? state.title).slice(0,300)};
        await save(state); return state;
      }
      case 'directory-update': {
        if (state.batch?.destination !== 'directory' || state.batch.id !== message.batchId || state.batch.owner !== message.instance) throw new Error('この保存処理は終了したか、別の作業ページに引き継がれました。');
        for (const update of (message.updates || []).slice(0,500)) {
          const job = state.jobs.find(job=>job.id === update.id);
          if (!job || !['queued','in_progress'].includes(job.status) || !['in_progress','complete','interrupted'].includes(update.status)) continue;
          job.status = update.status;
          for (const key of ['bytesReceived','totalBytes']) if (Number.isFinite(update[key]) && update[key] >= 0) job[key] = update[key];
          if (typeof update.filename === 'string' && !/[\\/]/.test(update.filename)) job.filename = update.filename.slice(0,240);
          if (update.error) job.error = publicError(update.error).slice(0,500);
        }
        await save(state); return state;
      }
      case 'cancel': {
        for(const job of state.jobs) {
          if(job.status==='queued') { job.status='interrupted'; job.error='停止しました。'; }
          if(job.status==='in_progress') {
            if(state.batch?.destination === 'directory') {job.status='interrupted';job.error='停止しました。';}
            else {try { await chrome.downloads.cancel(job.downloadId); } catch {} await refreshJob(job); if(job.status==='interrupted') job.error='停止しました。';}
          }
        }
        await save(state); return state;
      }
      case 'retry': {
        if(active(state)) throw new Error('保存処理中です。');
        if(state.batch?.destination === 'directory') state.batch.owner = message.instance;
        for(const job of state.jobs.filter(j=>j.status==='interrupted')) { job.id=crypto.randomUUID();job.status='queued';delete job.bytesReceived;delete job.totalBytes; delete job.downloadId; delete job.error; }
        if(state.batch?.destination === 'directory') {await save(state);return state;}
        return pump(state);
      }
      case 'capture': return claim(state,message.instance,message.mode);
      case 'hello': {
        if(state.batch?.destination === 'directory') {
          if(state.batch.owner !== message.instance) for(const job of state.jobs.filter(j=>['queued','in_progress'].includes(j.status))) {
            job.status='interrupted';job.error='作業ページが再読み込みされ、保存が中断しました。保存済みの画像はそのままに、中断分を再試行できます。';
          }
          state.batch.owner=message.instance;await save(state);
        }
        // Reload gets a new instance token; the old page no longer owns a live recorder.
        const lock = (await chrome.storage.session.get('captureLock')).captureLock;
        if(lock?.tabId === state.workspaceTabId && lock.instance !== message.instance) await chrome.storage.session.remove('captureLock');
        const sessions=await all();
        return {...state,activeDirectoryKeys:sessions.flatMap(s=>[`session:${s.id}`,...(s.batch?.id ? [`batch:${s.batch.id}`] : [])])};
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
    for(const state of await all()) if(state.workspaceTabId === tabId) {
      if(active(state) && state.batch?.destination !== 'directory') { state.closed=true;state.items=[];state.notices=[];state.history=[];await save(state); }
      else await chrome.storage.session.remove(PREFIX + state.id);
    }
  }).catch(()=>{});
});
