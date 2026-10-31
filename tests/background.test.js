import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const supportsRecording = manifest.permissions.includes('tabCapture');
let moduleNumber = 0;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function eventually(predicate, description) {
  for (let attempts = 0; attempts < 50; attempts++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.ok(predicate(), description);
}

function event() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    clear: () => listeners.clear(),
    emit: (...args) => [...listeners].map((listener) => listener(...args)) };
}

async function browser(t, options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const store = new Map();
  const tabs = new Map([
    [1, { id: 1, url: 'https://source.test/', title: 'Source' }],
    [100, { id: 100, url: 'chrome-extension://test/workspace.html?id=work' }],
  ]);
  const downloads = new Map();
  const requested = [];
  const cancelled = [];
  let nextDownloadId = 8;
  const changed = event();
  const created=event();
  const alarmEvent=event();
  const alarms=new Map();
  const alarmCreates=[];
  const alarmClears=[];
  const determining = event();
  const updated = event();
  const scriptCalls=[];
  const contexts=[];
  const contextCalls=[];
  const tabCreates=[];
  const scriptResults=[];
  const removed = event();
  const messages = event();
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const chrome = {
    runtime: { id: 'test', getURL: (path) => `chrome-extension://test/${path}`, onMessage: messages,
      async getContexts(filter) { contextCalls.push(clone(filter)); return clone(contexts.filter(context=>(!filter.tabIds || filter.tabIds.includes(context.tabId)) && (!filter.documentUrls || filter.documentUrls.includes(context.documentUrl)))); },
    },
    action: { onClicked: event(), setBadgeText: async () => {}, setTitle: async () => {} },
    storage: { session: {
      async get(key) {
        if (key === null) return Object.fromEntries([...store].map(([name, value]) => [name, clone(value)]));
        return { [key]: clone(store.get(key)) };
      },
      async set(values) {
        if (options.rejectStorage) throw new Error('QUOTA_BYTES exceeded');
        if (options.beforeStorageSet) await options.beforeStorageSet(clone(values));
        for (const [key, value] of Object.entries(values)) store.set(key, clone(value));
      },
      async remove(key) { store.delete(key); },
    } },
    scripting: { async executeScript(request) { scriptCalls.push(request); return [{result:scriptResults.shift() || {items:[],notices:[]}}]; } },
    tabs: { onRemoved: removed,onUpdated:updated,
      async create(values) { const tab={id:500+tabCreates.length,...values};tabCreates.push(clone(tab));tabs.set(tab.id,tab);return clone(tab); },
      async get(id) { if (!tabs.has(id)) throw new Error('No such tab'); return clone(tabs.get(id)); },
      async update(id, values) { Object.assign(tabs.get(id), values); return clone(tabs.get(id)); },
    },
    downloads: { onChanged: changed,onCreated:created,onDeterminingFilename:determining,
      async download(options) {
        const id = nextDownloadId++;
        requested.push({ ...options, id });
        const item={ id,url:options.url,byExtensionId:'test',startTime:new Date().toISOString(),filename:options.filename,state: 'in_progress', bytesReceived: 0, totalBytes: -1, mime: 'video/mp4' };
        downloads.set(id,item);
        if (chrome.filenameBeforeResolve) await new Promise(resolve=>{
          item.mime=chrome.filenameMime || 'image/png';
          determining.emit(clone(item),suggestion=>{ if(suggestion) item.filename=suggestion.filename; resolve(); });
        });
        return id;
      },
      async search(query) {
        if (Object.hasOwn(query,'id')) return downloads.has(query.id) ? [clone(downloads.get(query.id))] : [];
        return [...downloads.values()].filter(item=>!query.startedAfter || Date.parse(item.startTime) >= Date.parse(query.startedAfter)).map(clone);
      },
      async cancel(id) {
        cancelled.push(id);
        const item = downloads.get(id);
        if (item?.state === 'complete') throw new Error('Download is already complete');
        if (!item) throw new Error('No such download');
        item.state = 'interrupted'; item.error = 'USER_CANCELED';
        changed.emit({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
      },
    },
    tabCapture: { getCapturedTabs: async () => [], getMediaStreamId: async () => 'one-use-stream' },
  };
  if (options.withAlarms) chrome.alarms={onAlarm:alarmEvent,
    async get(name) { return clone(alarms.get(name)); },
    async create(name,info) { alarmCreates.push({name,...info});alarms.set(name,{name,...info}); },
    async clear(name) { alarmClears.push(name);return alarms.delete(name); },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chrome });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else delete globalThis.chrome;
  });
  // Each test gets a new worker module and independent event registrations/storage.
  let worker=await import(`${new URL('../extension/background.js', import.meta.url).href}?test=${moduleNumber++}`);
  const state = {
    id: 'work', tabId: 1, workspaceTabId: 100, url: 'https://source.test/', title: 'Source',
    items: [], notices: [], scanned: true, jobs: [],
  };
  const persist = () => store.set('workspace:work', clone(state));
  persist();
  return {
    state, store, tabs, downloads, requested, cancelled, persist, options, chrome, determining, updated,removed,scriptCalls,scriptResults,created,changed,alarms,alarmEvent,alarmCreates,alarmClears,contexts,contextCalls,tabCreates,
    openWorkspace:tab=>worker.openWorkspace(tab),
    async restartWorker() {
      changed.clear();created.clear();alarmEvent.clear();removed.clear();messages.clear();determining.clear();updated.clear();
      worker=await import(`${new URL('../extension/background.js', import.meta.url).href}?test=${moduleNumber++}`);
    },
    closeWorkspace() { tabs.delete(100); removed.emit(100); },
    complete(id) {
      Object.assign(downloads.get(id), { state: 'complete', bytesReceived: 10, totalBytes: 10 });
      changed.emit({ id, state: { current: 'complete' } });
    },
    send(message,tabId = 100) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Background did not respond')), options.messageTimeoutMs || 1000);
        messages.emit({ sessionId: 'work', instance: 'current-page', ...message },
          { id: 'test', url: 'chrome-extension://test/workspace.html?id=work', tab: { id: tabId } },
          (response) => { clearTimeout(timeout); resolve(response); });
      });
    },
  };
}

test('a pending source injection does not block another workspace, UI persistence or download completion',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  let resolveScan;
  h.chrome.scripting.executeScript=request=>{
    h.scriptCalls.push(request);
    return new Promise(resolve=>{resolveScan=resolve;});
  };
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{...structuredClone(h.state),id:'other',workspaceTabId:200,jobs:[{id:'other-job',url:urls[0],filename:'other.png',downloadId:90,status:'in_progress'}]});
  h.downloads.set(90,{id:90,state:'complete',bytesReceived:12,totalBytes:12,mime:'image/png'});
  const pending=h.send({type:'scan'});
  await eventually(()=>Boolean(resolveScan),'source injection started');
  const selection=await h.send({type:'ui',patch:{selectedURLs:[urls[0]],query:'kept'}});
  assert.equal(selection.ok,true,selection.error);
  const other=await h.send({type:'get',sessionId:'other'},200);
  assert.equal(other.ok,true,other.error);assert.equal(other.data.jobs[0].status,'complete');
  resolveScan([{documentId:'doc-a',result:{items:[{url:'https://source.test/new.png'}],notices:[],scanId:'scan-a',cursor:'next',hasMore:true}}]);
  const result=await pending;
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(result.data.selectedURLs,[urls[0]]);
  assert.equal(result.data.ui.query,'kept');
  assert.deepEqual(result.data.selectedItems.map(item=>item.url),[urls[0]],'latest selection survives an in-flight scan');
  assert.equal(result.data.sourceDocumentId,'doc-a');
});

test('an empty work-limited continuation preserves candidates and selection while advancing the cursor',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  await h.send({type:'ui',patch:{selectedURLs:[urls[0]]}});
  const before=h.store.get('workspace:work');before.scan={cursor:'old',scanId:'scan-a',hasMore:true};h.store.set('workspace:work',before);
  h.scriptResults.push({items:[],workLimited:true,notices:['bounded'],cursor:'advanced',scanId:'scan-a',hasMore:true});
  const result=await h.send({type:'scan',continuation:true});
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(result.data.items,before.items);assert.deepEqual(result.data.selectedURLs,before.selectedURLs);
  assert.equal(result.data.scan.cursor,'advanced');assert.equal(result.data.scan.workLimited,true);
});

test('same-URL source reload invalidates an in-flight result without clearing retained selection',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  await h.send({type:'ui',patch:{selectedURLs:[urls[0]]}});
  let resolveScan;
  h.chrome.scripting.executeScript=()=>new Promise(resolve=>{resolveScan=resolve;});
  const pending=h.send({type:'scan'});
  await eventually(()=>Boolean(resolveScan),'injection started');
  h.updated.emit(1,{status:'loading'},h.tabs.get(1));
  await eventually(()=>h.store.get('workspace:work').sourceEpoch===1,'same URL reload advances source epoch');
  resolveScan([{documentId:'old-document',result:{items:[{url:'https://source.test/stale.png'}],notices:[]}}]);
  const result=await pending;assert.equal(result.ok,false);
  const saved=h.store.get('workspace:work');assert.deepEqual(saved.items.map(item=>item.url),urls);assert.deepEqual(saved.selectedURLs,[urls[0]]);
});

test('closing a workspace is not held by a pending disposal and cannot adopt a late source result',async t=>{
  const h=await browser(t);imageItems(h);
  const before=h.store.get('workspace:work');before.scan={cursor:'existing',scanId:'scan-a',hasMore:true};h.store.set('workspace:work',before);
  let resolveScan;let disposals=0;
  h.chrome.scripting.executeScript=request=>{
    if(request.args[0].dispose){disposals++;return new Promise(()=>{});}
    return new Promise(resolve=>{resolveScan=resolve;});
  };
  const pending=h.send({type:'scan'});
  await eventually(()=>Boolean(resolveScan),'scan proceeds even while prior disposal is pending');
  h.closeWorkspace();
  await eventually(()=>!h.store.has('workspace:work'),'close removes an inactive session without waiting for dispose');
  resolveScan([{result:{items:[{url:'https://source.test/stale.png'}],notices:[]}}]);
  assert.equal((await pending).ok,false);assert.equal(disposals,0,'no overlapping cleanup is injected into an unsettled source');assert.equal(h.store.has('workspace:work'),false);
});

test('loading source tabs and persisted unresolved injections cannot start a second injection',async t=>{
  const h=await browser(t);imageItems(h);
  h.tabs.get(1).status='loading';
  assert.equal((await h.send({type:'scan'})).ok,false);assert.equal(h.scriptCalls.length,0);
  h.tabs.get(1).status='complete';
  let resolveScan;
  h.chrome.scripting.executeScript=()=>new Promise(resolve=>{resolveScan=resolve;});
  const pending=h.send({type:'scan'});await eventually(()=>Boolean(resolveScan),'first injection started');
  await h.restartWorker();
  assert.equal((await h.send({type:'scan'})).ok,false,'worker restart cannot forget a pending source reservation');
  resolveScan([{result:{items:[],notices:[]}}]);await pending;
});

test('closing source tabs releases persisted four-call reservations after a worker restart',async t=>{
  const h=await browser(t);imageItems(h);
  const flights={};
  for(let index=10;index<14;index++){h.tabs.set(index,{id:index,url:'https://source.test/'});flights[`pending-${index}`]={id:`pending-${index}`,tabId:index,sessionId:`old-${index}`,workerInstance:'old-worker'};}
  h.store.set('imagecrate.sourceFlights.v1',flights);await h.restartWorker();
  assert.equal((await h.send({type:'scan'})).ok,false);assert.equal(h.scriptCalls.length,0);
  for(let index=10;index<14;index++){h.tabs.delete(index);h.removed.emit(index);}
  await eventually(()=>Object.keys(h.store.get('imagecrate.sourceFlights.v1') || {}).length===0,'source close reclaims old pending calls');
  assert.equal((await h.send({type:'scan'})).ok,true);
});

test('fresh rescans do not accumulate disposal calls and disposal cannot hold workspace closure',async t=>{
  const h=await browser(t);imageItems(h);let disposals=0;
  h.chrome.scripting.executeScript=async request=>{
    h.scriptCalls.push(request);
    if(request.args[0].dispose){disposals++;return new Promise(()=>{});}
    return [{result:{items:[],notices:[],scanId:'scan',retryCursor:'replay'}}];
  };
  for(let index=0;index<6;index++)assert.equal((await h.send({type:'scan'})).ok,true);
  assert.equal(disposals,0);
  h.closeWorkspace();
  await eventually(()=>!h.store.has('workspace:work'),'workspace closure finishes');
  await eventually(()=>disposals===1,'one bounded best-effort cleanup is admitted');
  assert.equal(Object.keys(h.store.get('imagecrate.sourceFlights.v1')).length,1);
  h.tabs.delete(1);h.removed.emit(1);
  await eventually(()=>Object.keys(h.store.get('imagecrate.sourceFlights.v1')).length===0,'source close also releases pending cleanup');
});

test('a response after the absolute scan deadline cannot win before a throttled timer callback',async t=>{
  const h=await browser(t);const urls=imageItems(h);let resolveScan;
  h.chrome.scripting.executeScript=()=>new Promise(resolve=>{resolveScan=resolve;});
  const pending=h.send({type:'scan'});await eventually(()=>Boolean(resolveScan),'scan started');
  const request=h.store.get('workspace:work').scanRequest;t.mock.method(Date,'now',()=>request.deadline+1);
  resolveScan([{result:{items:[{url:'https://source.test/too-late.png'}],notices:[]}}]);
  assert.equal((await pending).ok,false);assert.deepEqual(h.store.get('workspace:work').items.map(item=>item.url),urls);
});

test('BG-01: closing the workspace preserves and completes the already accepted download batch', async (t) => {
  const h = await browser(t);
  h.state.jobs = [
    { url: 'https://source.test/first.mp4', filename: 'first.mp4', downloadId: 7, status: 'in_progress' },
    { url: 'https://source.test/second.mp4', filename: 'second.mp4', status: 'queued' },
  ];
  h.downloads.set(7, { id: 7, state: 'in_progress', mime: 'video/mp4', bytesReceived: 1, totalBytes: 10 });
  h.persist();
  h.closeWorkspace();
  await nextTurn();
  await nextTurn();
  assert.ok(h.store.has('workspace:work'), 'pending batch must survive the workspace closing');
  assert.equal(h.requested.length, 0, 'downloads remain sequential while the first file is active');
  h.complete(7);
  await eventually(() => h.requested.length === 1, 'second file starts after first completes, without a live workspace');
  assert.equal(h.requested[0].url, 'https://source.test/second.mp4');
  h.complete(h.requested[0].id);
  await eventually(() => {
    const saved = h.store.get('workspace:work');
    return !saved || saved.jobs.every((job) => ['complete', 'interrupted'].includes(job.status));
  }, 'closed workspace must not leave a queued or in-progress batch after all downloads finish');
  assert.equal(h.requested.length, 1, 'neither completed file is downloaded a second time');
});

test('BG-02: a capture owner that navigated away cannot keep another workspace locked',
  { skip: !supportsRecording }, async (t) => {
    const h = await browser(t);
    h.tabs.set(999, { id: 999, url: 'https://another-page.test/' });
    h.store.set('captureLock', { tabId: 999, instance: 'departed-page', mode: 'display' });
    const response = await h.send({ type: 'capture', mode: 'display' });
    assert.equal(response.ok, true, response.error);
    const lock = h.store.get('captureLock');
    assert.equal(lock.tabId, 100, 'the new workspace owns the granted capture');
    assert.equal(lock.instance, 'current-page');
    const release = await h.send({ type: 'release' });
    assert.equal(release.ok, true);
    assert.equal(h.store.has('captureLock'), false);
  });

test('BG-03: a download completing just before cancel remains complete and is never retried', async (t) => {
  const h = await browser(t);
  h.state.jobs = [{ url: 'https://source.test/already-saved.mp4', filename: 'saved.mp4', downloadId: 7, status: 'in_progress' }];
  // Chrome has completed the file, but its event has not reached the worker's cached state yet.
  h.downloads.set(7, { id: 7, state: 'complete', mime: 'video/mp4', bytesReceived: 10, totalBytes: 10 });
  h.persist();
  const response = await h.send({ type: 'cancel' });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.jobs[0].status, 'complete', 'cancel rejection must reconcile the actual Chrome state');
  const retried = await h.send({ type: 'retry' });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.data.jobs[0].status, 'complete');
  assert.deepEqual(h.requested, [], 'retry must never duplicate a completed file');
});

function imageItems(h) {
  h.state.items = [
    { url: 'https://source.test/first.png', width: 20, height: 20 },
    { url: 'https://source.test/second.png', width: 20, height: 20 },
  ];
  h.persist();
  return h.state.items.map((item) => item.url);
}

test('saving to Chrome downloads uses the chosen folder name safely and keeps the existing default', async (t) => {
  const h = await browser(t);
  const urls = imageItems(h);
  const customName = await h.send({ type: 'save', urls, settings: { destination: 'downloads', folderName: '旅/行:*' } });
  assert.equal(customName.ok, true, customName.error);
  assert.equal(h.requested[0].filename, 'ImageCrate/旅_行__/001_first.png');
  assert.equal(h.requested[0].saveAs, false, 'a folder name must not add one native dialog per image');
  assert.equal(customName.data.batch.destination, 'downloads');
  assert.equal(customName.data.batch.folderName, '旅_行__');
  assert.equal(customName.data.jobs[1].status, 'queued', 'saving stays sequential');
  await h.send({ type: 'cancel' });
  const fallback = await h.send({ type: 'save', urls, settings: { destination: 'downloads', folderName: '' } });
  assert.equal(fallback.ok, true, fallback.error);
  assert.equal(h.requested.at(-1).filename, 'ImageCrate/Source/001_first.png', 'an empty name uses the page title');
});

test('a selected directory queues an owned batch without starting Chrome downloads', async (t) => {
  const h = await browser(t);
  const urls = imageItems(h);
  const response = await h.send({ type: 'save', urls, settings: {
    destination: 'directory', folderName: '旅行', directoryName: 'Pictures',
  } });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(h.requested, [], 'the custom destination must not silently fall back to Downloads');
  assert.equal(response.data.batch.destination, 'directory');
  assert.equal(response.data.batch.folderName, '旅行');
  assert.equal(response.data.batch.directoryName, 'Pictures');
  assert.equal(response.data.batch.owner, 'current-page');
  assert.ok(response.data.batch.id);
  assert.equal(new Set(response.data.jobs.map((job) => job.id)).size, 2, 'each writer operation has its own identifier');
  assert.ok(response.data.jobs.every((job) => job.id && job.status === 'queued'));
  const changed = await h.send({ type: 'settings', settings: { destination: 'downloads', folderName: 'different' } });
  assert.equal(changed.ok, false, 'changing a destination cannot alter an active save');
  const stored = h.store.get('workspace:work');
  assert.equal(stored.batch.folderName, '旅行');
  assert.equal(stored.batch.destination, 'directory');
});

test('directory retry keeps its original destination after settings change and never repeats completed files', async (t) => {
  const h = await browser(t);
  const urls = imageItems(h);
  const saved = await h.send({ type: 'save', urls, settings: { destination: 'directory', folderName: '元の名前', directoryName: 'Original' } });
  assert.equal(saved.ok, true, saved.error);
  const original = saved.data;
  const updated = await h.send({ type: 'directory-update', batchId: original.batch.id, updates: [
    { id: original.jobs[0].id, status: 'complete', bytesReceived: 100, totalBytes: 100, filename: '001_first (1).png' },
    { id: original.jobs[1].id, status: 'interrupted', bytesReceived: 0, error: '書き込みできませんでした' },
  ] });
  assert.equal(updated.ok, true, updated.error);
  const settings = await h.send({ type: 'settings', settings: { destination: 'downloads', folderName: '次回の名前' } });
  assert.equal(settings.ok, true, settings.error);
  const retry = await h.send({ type: 'retry' });
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.data.batch.destination, 'directory');
  assert.equal(retry.data.batch.directoryName, 'Original');
  assert.equal(retry.data.batch.folderName, '元の名前');
  assert.equal(retry.data.jobs[0].status, 'complete');
  assert.equal(retry.data.jobs[0].id, original.jobs[0].id, 'the completed operation is unchanged');
  assert.equal(retry.data.jobs[0].filename, '001_first (1).png', 'the actual unique filename is retained');
  assert.equal(retry.data.jobs[1].status, 'queued');
  assert.notEqual(retry.data.jobs[1].id, original.jobs[1].id, 'a retried operation cannot accept late results from its previous attempt');
  await h.send({ type: 'directory-update', batchId: retry.data.batch.id,
    updates: [{ id: original.jobs[1].id, status: 'complete', bytesReceived: 100, totalBytes: 100 }] });
  assert.equal(h.store.get('workspace:work').jobs[1].status, 'queued', 'a late result cannot mark the retried file complete');
  assert.deepEqual(h.requested, [], 'retry must keep using the selected directory');
});

test('directory updates require the current batch owner and reload recovers unfinished work as interrupted', async (t) => {
  const h = await browser(t);
  const urls = imageItems(h);
  const saved = await h.send({ type: 'save', urls, settings: { destination: 'directory', folderName: '旅行', directoryName: 'Pictures' } });
  assert.equal(saved.ok, true, saved.error);
  const { batch, jobs } = saved.data;
  const otherOwner = await h.send({ type: 'directory-update', instance: 'other-page', batchId: batch.id,
    updates: [{ id: jobs[0].id, status: 'complete', bytesReceived: 10 }] });
  assert.equal(otherOwner.ok, false);
  assert.equal(h.store.get('workspace:work').jobs[0].status, 'queued');
  const wrongBatch = await h.send({ type: 'directory-update', batchId: 'old-batch',
    updates: [{ id: jobs[0].id, status: 'complete', bytesReceived: 10 }] });
  assert.equal(wrongBatch.ok, false);
  const progress = await h.send({ type: 'directory-update', batchId: batch.id,
    updates: [{ id: jobs[0].id, status: 'in_progress', bytesReceived: 5, totalBytes: 10 }] });
  assert.equal(progress.ok, true, progress.error);
  const reload = await h.send({ type: 'hello', instance: 'reloaded-page' });
  assert.equal(reload.ok, true, reload.error);
  assert.equal(reload.data.batch.owner, 'reloaded-page');
  assert.ok(reload.data.jobs.every((job) => job.status === 'interrupted'), 'both writing and queued work need an explicit retry after reload');
  const late = await h.send({ type: 'directory-update', batchId: batch.id,
    updates: [{ id: jobs[0].id, status: 'complete', bytesReceived: 10 }] });
  assert.equal(late.ok, false, 'the page before reload can no longer declare a file saved');
  assert.ok(h.store.get('workspace:work').jobs.every((job) => job.status === 'interrupted'));
  assert.deepEqual(h.requested, []);
});

test('cancelling a directory batch interrupts unfinished jobs without touching Chrome downloads', async (t) => {
  const h = await browser(t);
  const urls = imageItems(h);
  const saved = await h.send({ type: 'save', urls, settings: { destination: 'directory', folderName: '旅行', directoryName: 'Pictures' } });
  assert.equal(saved.ok, true, saved.error);
  const { batch, jobs } = saved.data;
  const progress = await h.send({ type: 'directory-update', batchId: batch.id, updates: [
    { id: jobs[0].id, status: 'complete', bytesReceived: 10, totalBytes: 10 },
    { id: jobs[1].id, status: 'in_progress', bytesReceived: 5, totalBytes: 10 },
  ] });
  assert.equal(progress.ok, true, progress.error);
  const cancelled = await h.send({ type: 'cancel' });
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.data.jobs[0].status, 'complete');
  assert.equal(cancelled.data.jobs[1].status, 'interrupted');
  assert.deepEqual(h.cancelled, [], 'custom file writes are not Chrome download IDs');
  assert.deepEqual(h.requested, []);
});

test('closing a directory workspace never starts queued files in the default downloads folder', async (t) => {
  const h = await browser(t);
  const urls = imageItems(h);
  const saved = await h.send({ type: 'save', urls, settings: { destination: 'directory', folderName: '旅行', directoryName: 'Pictures' } });
  assert.equal(saved.ok, true, saved.error);
  const { batch, jobs } = saved.data;
  await h.send({ type: 'directory-update', batchId: batch.id,
    updates: [{ id: jobs[0].id, status: 'in_progress', bytesReceived: 5, totalBytes: 10 }] });
  h.closeWorkspace();
  await eventually(() => {
    const current = h.store.get('workspace:work');
    return !current || current.jobs.every((job) => ['complete', 'interrupted'].includes(job.status));
  }, 'closed directory workspaces must not retain jobs that appear to be writing');
  assert.deepEqual(h.requested, []);
  assert.deepEqual(h.cancelled, []);
});

async function convertedBatch(h, format = 'jpg', destination = 'downloads') {
  const urls=imageItems(h);
  const response=await h.send({type:'save',urls,settings:{destination,format,folderName:'変換',directoryName:destination === 'directory' ? 'Pictures' : ''}});
  assert.equal(response.ok,true,response.error);
  return response.data;
}
async function beginConverted(h, state, index = 0, blobURL = 'blob:chrome-extension://test/converted-image') {
  const job=state.jobs[index];
  const progress=await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:job.id,status:'in_progress'}]});
  assert.equal(progress.ok,true,progress.error);
  return h.send({type:'converted-download',batchId:state.batch.id,jobId:job.id,blobURL});
}

test('converted Chrome batches freeze their format and never download original URLs through the worker pump', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h,'webp');
  assert.equal(state.batch.format,'webp');
  assert.equal(state.jobs[0].filename,'ImageCrate/変換/001_first.webp');
  assert.ok(state.jobs.every(job=>job.status === 'queued'));
  assert.deepEqual(h.requested,[]);
  await h.send({type:'get'});
  assert.deepEqual(h.requested,[],'polling must not start unconverted source files');
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const id=accepted.data.jobs[0].downloadId;
  assert.equal(h.requested[0].url,'blob:chrome-extension://test/converted-image');
  assert.equal(h.requested[0].filename,'ImageCrate/変換/001_first.webp');
  h.complete(id);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','Chrome completion is tracked');
  assert.equal(h.requested.length,1,'the next source remains queued for conversion in the workspace');
  assert.equal(h.store.get('workspace:work').jobs[1].status,'queued');
});

test('converted downloads reject foreign data, owners and jobs, and ignore page-declared download completion', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h);
  const first=state.jobs[0];
  const fakeComplete=await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:first.id,status:'complete'}]});
  assert.equal(fakeComplete.ok,true,fakeComplete.error);
  assert.equal(fakeComplete.data.jobs[0].status,'queued','only Chrome can confirm a converted download is saved');
  const queued=await h.send({type:'converted-download',batchId:state.batch.id,jobId:first.id,blobURL:'blob:chrome-extension://test/converted'});
  assert.equal(queued.ok,false,'an unstarted conversion cannot directly create a download');
  await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:first.id,status:'in_progress'}]});
  for (const message of [
    {instance:'other-page'}, {batchId:'previous-batch'}, {jobId:'previous-job'},
    {blobURL:'https://source.test/original.jpg'}, {blobURL:'blob:chrome-extension://other-extension/converted'},
    {blobURL:'blob:chrome-extension://test.attacker/converted'},
  ]) {
    const response=await h.send({type:'converted-download',batchId:state.batch.id,jobId:first.id,blobURL:'blob:chrome-extension://test/converted',...message});
    assert.equal(response.ok,false);
  }
  assert.deepEqual(h.requested,[]);
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const update=await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:first.id,status:'complete',bytesReceived:999999}]});
  assert.equal(update.ok,true,update.error);
  assert.equal(update.data.jobs[0].status,'in_progress');
  assert.equal(update.data.jobs[0].bytesReceived,0,'the page cannot replace Chrome progress');
  const duplicate=await h.send({type:'converted-download',batchId:state.batch.id,jobId:first.id,blobURL:'blob:chrome-extension://test/duplicate'});
  assert.equal(duplicate.ok,false);
  assert.equal(h.requested.length,1);
});

test('stopping conversion rejects a late Blob and retry keeps the frozen format after settings change', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h,'png');
  const oldId=state.jobs[0].id;
  await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:oldId,status:'in_progress'}]});
  const stopped=await h.send({type:'cancel'});
  assert.equal(stopped.ok,true,stopped.error);
  assert.ok(stopped.data.jobs.every(job=>job.status === 'interrupted'));
  assert.deepEqual(h.cancelled,[],'decoding has not created a Chrome download');
  const late=await h.send({type:'converted-download',batchId:state.batch.id,jobId:oldId,blobURL:'blob:chrome-extension://test/late'});
  assert.equal(late.ok,false);
  await h.send({type:'settings',settings:{format:'webp',destination:'directory',directoryName:'Other',folderName:'次回'}});
  const retry=await h.send({type:'retry'});
  assert.equal(retry.ok,true,retry.error);
  assert.equal(retry.data.batch.format,'png');
  assert.equal(retry.data.batch.destination,'downloads');
  assert.equal(retry.data.batch.folderName,'変換');
  assert.notEqual(retry.data.jobs[0].id,oldId);
  assert.equal(retry.data.jobs[0].filename,'ImageCrate/変換/001_first.png');
  const stale=await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:oldId,status:'in_progress'}]});
  assert.equal(stale.data.jobs[0].status,'queued');
  assert.deepEqual(h.requested,[]);
});

test('cancel reconciles converted downloads and preserves files completed just before stopping', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h);
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const id=accepted.data.jobs[0].downloadId;
  Object.assign(h.downloads.get(id),{state:'complete',bytesReceived:10,totalBytes:10});
  const stopped=await h.send({type:'cancel'});
  assert.equal(stopped.ok,true,stopped.error);
  assert.equal(stopped.data.jobs[0].status,'complete');
  assert.equal(stopped.data.jobs[1].status,'interrupted');
  const retry=await h.send({type:'retry'});
  assert.equal(retry.data.jobs[0].status,'complete');
  assert.equal(retry.data.jobs[1].status,'queued');
  assert.equal(h.requested.length,1);
});

test('worker restart follows accepted converted IDs without downloading the queued original', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h);
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const id=accepted.data.jobs[0].downloadId;
  await h.restartWorker();
  const restored=await h.send({type:'get'});
  assert.equal(restored.ok,true,restored.error);
  assert.equal(restored.data.jobs[0].downloadId,id);
  assert.equal(restored.data.jobs[0].status,'in_progress');
  assert.equal(h.requested.length,1);
  h.complete(id);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','restarted worker observes the same download');
  assert.equal(h.requested.length,1);
});

test('reload cancels an accepted converted download, interrupts unstarted work and rejects the old owner', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h);
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const id=accepted.data.jobs[0].downloadId;
  const reload=await h.send({type:'hello',instance:'reloaded-page'});
  assert.equal(reload.ok,true,reload.error);
  assert.equal(reload.data.batch.owner,'reloaded-page');
  assert.deepEqual(h.cancelled,[id]);
  assert.ok(reload.data.jobs.every(job=>job.status === 'interrupted'));
  const late=await h.send({type:'converted-download',batchId:state.batch.id,jobId:state.jobs[1].id,blobURL:'blob:chrome-extension://test/late'});
  assert.equal(late.ok,false);
  const stolen=await h.send({type:'retry'});
  assert.equal(stolen.ok,false,'a departed page cannot take back batch ownership');
  const retry=await h.send({type:'retry',instance:'reloaded-page'});
  assert.equal(retry.ok,true,retry.error);
  assert.equal(retry.data.batch.format,'jpg');
  assert.equal(h.requested.length,1);
});

test('a converted download still active after cancel cannot be retried until Chrome confirms its result', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h);
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const id=accepted.data.jobs[0].downloadId;
  const originalCancel=chrome.downloads.cancel;
  chrome.downloads.cancel=async ()=>{throw new Error('Chrome has not stopped this download yet');};
  const reload=await h.send({type:'hello',instance:'reloaded-page'});
  assert.equal(reload.ok,true,reload.error);
  assert.equal(reload.data.jobs[0].status,'in_progress');
  const retry=await h.send({type:'retry',instance:'reloaded-page'});
  assert.equal(retry.ok,false,'an active accepted ID must not be duplicated');
  h.complete(id);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','terminal state arrives after reload');
  chrome.downloads.cancel=originalCancel;
  const retried=await h.send({type:'retry',instance:'reloaded-page'});
  assert.equal(retried.ok,true,retried.error);
  assert.equal(retried.data.jobs[0].status,'complete');
  assert.equal(h.requested.length,1);
});

test('closing a converted workspace cancels its active Blob download and never starts queued sources', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h);
  const accepted=await beginConverted(h,state);
  assert.equal(accepted.ok,true,accepted.error);
  const id=accepted.data.jobs[0].downloadId;
  h.closeWorkspace();
  await eventually(()=>!h.store.has('workspace:work'),'terminated converted session is removed');
  assert.deepEqual(h.cancelled,[id]);
  assert.equal(h.requested.length,1);
});

test('selected folders receive converted extensions without starting Chrome downloads', async (t) => {
  const h=await browser(t);
  const state=await convertedBatch(h,'webp','directory');
  assert.equal(state.jobs[0].filename,'001_first.webp');
  const updated=await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:state.jobs[0].id,status:'complete',filename:'001_first (1).webp',bytesReceived:100,totalBytes:100}]});
  assert.equal(updated.ok,true,updated.error);
  assert.equal(updated.data.jobs[0].status,'complete');
  assert.equal(updated.data.jobs[0].filename,'001_first (1).webp');
  assert.deepEqual(h.requested,[]);
});

test('session UI and selection survive worker restart and completion deselects only once', async t=>{
  const h=await browser(t);
  const urls=imageItems(h);
  const selected=await h.send({type:'ui',patch:{selectedURLs:urls,query:'first',width:12,view:'selected',scrollY:350,focusAnchor:urls[0]}});
  assert.equal(selected.ok,true,selected.error);
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{format:'original'}});
  assert.equal(saved.ok,true,saved.error);
  h.complete(saved.data.jobs[0].downloadId);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','completion reaches session storage');
  assert.deepEqual(h.store.get('workspace:work').selectedURLs,[urls[1]]);
  const reselected=await h.send({type:'ui',patch:{selectedURLs:urls}});
  assert.equal(reselected.ok,true,reselected.error);
  await h.restartWorker();
  const restored=await h.send({type:'get'});
  assert.deepEqual(restored.data.selectedURLs,urls);
  assert.equal(restored.data.ui.query,'first');
  assert.equal(restored.data.ui.scrollY,350);
  assert.equal(restored.data.ui.view,'selected');
  assert.ok(restored.data.revision > selected.data.revision);
  const hello=await h.send({type:'hello',instance:'reload'});
  assert.deepEqual(hello.data.selectedURLs,urls,'old complete results cannot remove a deliberate reselection');
});

test('a rejected storage write preserves the prior selection and all other UI fields',async t=>{
  const h=await browser(t);
  const urls=imageItems(h);
  const selected=await h.send({type:'ui',patch:{selectedURLs:[urls[0]],query:'previous'}});
  assert.equal(selected.ok,true,selected.error);
  const before=structuredClone(h.store.get('workspace:work'));
  h.options.rejectStorage=true;
  const rejected=await h.send({type:'ui',patch:{selectedURLs:urls,query:'new'}});
  assert.equal(rejected.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),before);
});

test('continuation replaces the page, preserves off-page selection and can save that selection',async t=>{
  const h=await browser(t);
  const urls=imageItems(h);
  await h.send({type:'ui',patch:{selectedURLs:[urls[0]]}});
  const next={url:'https://source.test/next.png',width:30,height:20};
  h.state.scan={cursor:'first-cursor',hasMore:true};
  const current=h.store.get('workspace:work');current.scan=h.state.scan;h.store.set('workspace:work',current);
  h.scriptResults.push({items:[next],notices:[],cursor:'next-cursor',hasMore:true,scanId:'scan1'});
  const scanned=await h.send({type:'scan',continuation:true});
  assert.equal(scanned.ok,true,scanned.error);
  assert.deepEqual(scanned.data.items.map(item=>item.url),[next.url]);
  assert.deepEqual(scanned.data.selectedItems.map(item=>item.url),[urls[0]]);
  assert.deepEqual(scanned.data.scan.addedURLs,[next.url]);
  assert.equal(h.scriptCalls.at(-1).args[0].cursor,'first-cursor');
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{format:'original'}});
  assert.equal(saved.ok,true,saved.error);
  assert.equal(saved.data.jobs[0].url,urls[0]);
});

test('invalidated continuation and changed source keep the previous page and selection',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  await h.send({type:'ui',patch:{selectedURLs:[urls[0]]}});
  const state=h.store.get('workspace:work');state.scan={cursor:'old',hasMore:true};h.store.set('workspace:work',state);
  h.scriptResults.push({items:[],notices:[],invalidated:true,hasMore:false});
  const rejected=await h.send({type:'scan',continuation:true});
  assert.equal(rejected.ok,false);
  assert.match(rejected.error,/先頭/);
  assert.deepEqual(h.store.get('workspace:work').items,state.items);
  assert.deepEqual(h.store.get('workspace:work').selectedURLs,[urls[0]]);
  h.tabs.get(1).url='https://source.test/moved';
  const moved=await h.send({type:'scan'});
  assert.equal(moved.ok,false);
  assert.deepEqual(h.store.get('workspace:work').selectedURLs,[urls[0]]);
});

test('extensionless original downloads use MIME before download() resolves without deadlocking the queue',async t=>{
  const h=await browser(t);
  h.state.items=[{url:'https://source.test/image?id=1',width:20,height:10}];h.persist();
  h.chrome.filenameBeforeResolve=true;h.chrome.filenameMime='image/png';
  const saved=await h.send({type:'save',urls:h.state.items.map(item=>item.url),settings:{folderName:'Safe',format:'original'}});
  assert.equal(saved.ok,true,saved.error);
  assert.equal(saved.data.jobs[0].filename,'ImageCrate/Safe/001_image.png');
  assert.equal(saved.data.jobs[0].actualFilename,'ImageCrate/Safe/001_image.png');
  assert.equal(saved.data.jobs[0].typeKnown,true);
  assert.equal(h.requested[0].url,h.state.items[0].url,'no image conversion or alternate fetch is used');
  h.complete(saved.data.jobs[0].downloadId);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','first same-URL batch completes');
  const next=await h.send({type:'save',urls:h.state.items.map(item=>item.url),settings:{folderName:'Other',format:'original'}});
  assert.equal(next.ok,true,next.error);
  assert.equal(next.data.jobs[0].filename,'ImageCrate/Other/001_image.png','the same URL in another batch keeps its new path');
  assert.notEqual(next.data.jobs[0].downloadId,saved.data.jobs[0].downloadId);
});

test('filename decisions touch only owned jobs and invoke suggest exactly once for unrelated downloads',async t=>{
  const h=await browser(t);
  for(const item of [
    {id:500,url:'https://source.test/image',byExtensionId:'another-extension',mime:'image/png'},
    {id:501,url:'https://source.test/image',byExtensionId:'test',mime:'image/png'},
    {id:502,url:'https://source.test/image',mime:'image/png'},
  ]) {
    const calls=[];
    h.determining.emit(item,(...args)=>calls.push(args));
    await eventually(()=>calls.length > 0,'every filename event gets a decision');
    assert.deepEqual(calls,[[]]);
  }
});

test('filename event after worker restart recovers the persisted job by download ID',async t=>{
  const h=await browser(t);
  h.state.items=[{url:'https://source.test/image',width:10,height:10}];h.persist();
  const saved=await h.send({type:'save',urls:h.state.items.map(item=>item.url),settings:{folderName:'Kept'}});
  await h.restartWorker();
  const calls=[];
  h.determining.emit({id:saved.data.jobs[0].downloadId,url:h.state.items[0].url,byExtensionId:'test',mime:'image/webp'},(...args)=>calls.push(args));
  await eventually(()=>calls.length > 0,'restarted worker responds without relying on in-memory submissions');
  assert.equal(calls[0][0].filename,'ImageCrate/Kept/001_image.webp');
  await eventually(()=>h.store.get('workspace:work').jobs[0].filename.endsWith('.webp'),'resolved name is persisted');
});

test('a quota-rejected continuation keeps its old page and can replay the uncommitted page',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  await h.send({type:'ui',patch:{selectedURLs:[urls[0]]}});
  const previous=h.store.get('workspace:work');previous.scan={cursor:'before',hasMore:true};h.store.set('workspace:work',previous);
  const page={items:[{url:'https://source.test/new.png',width:40,height:30,type:'image/png',groupId:'g1'}],notices:[],cursor:'after',retryCursor:'before',hasMore:true,scanId:'scan'};
  h.scriptResults.push(page);
  h.options.rejectStorage=true;
  const refused=await h.send({type:'scan',continuation:true});
  assert.equal(refused.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),previous);
  h.options.rejectStorage=false;
  h.scriptResults.push(page);
  const replayed=await h.send({type:'scan',continuation:true});
  assert.equal(replayed.ok,true,replayed.error);
  assert.equal(h.scriptCalls.at(-1).args[0].cursor,'before');
  assert.equal(replayed.data.items[0].url,page.items[0].url);
  assert.equal(replayed.data.items[0].type,'image/png','responsive source metadata is preserved');
  assert.equal(replayed.data.items[0].groupId,'g1');
  assert.deepEqual(replayed.data.selectedItems.map(item=>item.url),[urls[0]]);
});

test('unknown MIME retains the neutral extension and cannot suggest paths outside the frozen batch',async t=>{
  const h=await browser(t);
  h.state.items=[{url:'https://source.test/image',width:10,height:10}];h.persist();
  h.chrome.filenameBeforeResolve=true;h.chrome.filenameMime='application/octet-stream';
  const saved=await h.send({type:'save',urls:h.state.items.map(item=>item.url),settings:{folderName:'Safe'}});
  assert.equal(saved.ok,true,saved.error);
  assert.equal(saved.data.jobs[0].filename,'ImageCrate/Safe/001_image.img');
  assert.equal(saved.data.jobs[0].typeKnown,false);
  const state=h.store.get('workspace:work');state.jobs[0].filename='../outside.img';h.store.set('workspace:work',state);
  const calls=[];
  h.determining.emit({id:saved.data.jobs[0].downloadId,url:h.state.items[0].url,byExtensionId:'test',mime:'image/png'},(...args)=>calls.push(args));
  await eventually(()=>calls.length > 0,'unsafe persisted paths get a neutral filename decision');
  assert.deepEqual(calls,[[]]);
});

test('a filename decision still uses the frozen original path after its workspace closes',async t=>{
  const h=await browser(t);
  h.state.items=[{url:'https://source.test/image',width:10,height:10}];h.persist();
  const saved=await h.send({type:'save',urls:h.state.items.map(item=>item.url),settings:{folderName:'Background'}});
  h.closeWorkspace();
  await eventually(()=>h.store.get('workspace:work')?.closed,'worker retains the unfinished background batch');
  const calls=[];
  h.determining.emit({id:saved.data.jobs[0].downloadId,url:h.state.items[0].url,byExtensionId:'test',mime:'image/jpeg'},(...args)=>calls.push(args));
  await eventually(()=>calls.length > 0,'closed workspace does not own the naming decision');
  assert.equal(calls[0][0].filename,'ImageCrate/Background/001_image.jpg');
});

test('source navigation releases continuation state without clearing retained candidates or selection',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  await h.send({type:'ui',patch:{selectedURLs:[urls[0]]}});
  const state=h.store.get('workspace:work');state.scan={cursor:'old',hasMore:true};h.store.set('workspace:work',state);
  h.tabs.get(1).url='https://source.test/moved';
  h.updated.emit(1,{url:'https://source.test/moved'},h.tabs.get(1));
  await eventually(()=>h.store.get('workspace:work').scan.invalidated,'source navigation is recorded');
  const next=h.store.get('workspace:work');
  assert.equal(next.scan.cursor,null);
  assert.deepEqual(next.items,state.items);
  assert.deepEqual(next.selectedURLs,[urls[0]]);
  assert.equal(h.scriptCalls.at(-1).args[0].dispose,true);
});

test('starting a new failed-only batch preserves ordinary selection and records its source batch',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const selected=await h.send({type:'ui',patch:{selectedURLs:[urls[1]]}});
  assert.equal(selected.ok,true,selected.error);
  const old=await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Old',folderName:'Old',format:'png'}});
  const stopped=await h.send({type:'cancel'});
  assert.equal(stopped.data.jobs[0].status,'interrupted');
  const scoped=await h.send({type:'ui',patch:{saveScope:'failed',failedBatchId:old.data.batch.id}});
  assert.equal(scoped.ok,true,scoped.error);
  await h.restartWorker();
  const restored=await h.send({type:'get'});
  assert.equal(restored.data.ui.saveScope,'failed');
  assert.deepEqual(restored.data.selectedURLs,[urls[1]]);
  // The failed file can be off the current scan page and unselected.
  const state=h.store.get('workspace:work');state.items=state.items.filter(item=>item.url !== urls[0]);h.store.set('workspace:work',state);
  const next=await h.send({type:'save',sourceBatchId:old.data.batch.id,urls:[urls[0]],settings:{destination:'directory',directoryName:'New',folderName:'New',format:'webp'}});
  assert.equal(next.ok,true,next.error);
  assert.equal(next.data.batch.sourceBatchId,old.data.batch.id);
  assert.equal(next.data.batch.format,'webp');
  assert.equal(next.data.jobs[0].url,urls[0]);
  assert.deepEqual(next.data.selectedURLs,[urls[1]],'changing the pending save scope never replaces another selection');
  assert.equal(next.data.ui.saveScope,'selection');
  assert.equal(next.data.ui.failedBatchId,null);
  assert.notEqual(next.data.batch.id,old.data.batch.id);
});

test('failed-only save scope rejects stale batch IDs and URLs outside its interrupted jobs',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const old=await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Old'}});
  await h.send({type:'cancel'});
  const invalid=await h.send({type:'ui',patch:{saveScope:'failed',failedBatchId:'old-batch'}});
  assert.equal(invalid.ok,false);
  for(const request of [{sourceBatchId:'old-batch',urls:[urls[0]]},{sourceBatchId:old.data.batch.id,urls:[urls[1]]}]) {
    const result=await h.send({type:'save',...request,settings:{destination:'directory',directoryName:'New'}});
    assert.equal(result.ok,false);
  }
  assert.equal(h.store.get('workspace:work').batch.id,old.data.batch.id);
});

test('a prepared directory survives another workspace pruning before settings commit and abort releases it',async t=>{
  const h=await browser(t);
  const records=new Map([['session:work:old',{name:'Old'}],['session:stale:old',{name:'Stale'}]]);
  const previous=globalThis.indexedDB;
  globalThis.indexedDB={open(){
    const request={};
    queueMicrotask(()=>{request.result={close(){},transaction(){
      const transaction={};
      transaction.objectStore=()=>({delete:key=>records.delete(key),openKeyCursor(){
        const request={};const keys=[...records.keys()];let index=0;
        const next=()=>queueMicrotask(()=>{
          request.result=index < keys.length ? {key:keys[index++],continue:next} : null;
          request.onsuccess?.();
          if (!request.result) transaction.oncomplete?.();
        });
        next();return request;
      }});
      return transaction;
    }};request.onsuccess?.();});
    return request;
  }};
  t.after(()=>{if(previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB=previous;});
  h.state.saveSettings={destination:'directory',directoryName:'Old',directoryKey:'session:work:old'};h.persist();
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{...h.state,id:'other',workspaceTabId:200,saveSettings:{destination:'downloads'}});
  const draft='session:work:draft';
  const prepared=await h.send({type:'settings-prepare',directoryKey:draft});
  assert.equal(prepared.ok,true,prepared.error);
  assert.equal(prepared.data.saveSettings.directoryKey,'session:work:old','preparation does not apply a draft setting');
  records.set(draft,{name:'Draft'});
  const pruned=await h.send({sessionId:'other',type:'prune-directories'},200);
  assert.equal(pruned.ok,true,pruned.error);
  assert.equal(records.has(draft),true,'the prepared draft is reserved before its handle is written');
  assert.equal(records.has('session:work:old'),true);
  assert.equal(records.has('session:stale:old'),false);
  const hello=await h.send({type:'hello'});
  assert.ok(hello.data.activeDirectoryKeys.includes(draft));
  h.options.rejectStorage=true;
  const failedCommit=await h.send({type:'settings',settings:{destination:'directory',directoryName:'Draft',directoryKey:draft}});
  assert.equal(failedCommit.ok,false);
  assert.equal(h.store.get('workspace:work').saveSettings.directoryKey,'session:work:old');
  h.options.rejectStorage=false;
  const aborted=await h.send({type:'settings-abort',directoryKey:draft});
  assert.equal(aborted.ok,true,aborted.error);
  await h.send({sessionId:'other',type:'prune-directories'},200);
  assert.equal(records.has(draft),false);
  assert.equal(records.has('session:work:old'),true);
  const first='session:work:first',last='session:work:last';
  await h.send({type:'settings-prepare',directoryKey:first});records.set(first,{name:'First'});
  await h.send({type:'settings-prepare',directoryKey:last});records.set(last,{name:'Last'});
  await h.send({type:'settings-abort',directoryKey:first});
  await h.send({sessionId:'other',type:'prune-directories'},200);
  assert.equal(records.has(first),false);
  assert.equal(records.has(last),true,'an abort for an old draft cannot clear its replacement');
  const committed=await h.send({type:'settings',settings:{destination:'directory',directoryName:'Last',directoryKey:last}});
  assert.equal(committed.ok,true,committed.error);
  assert.equal(committed.data.pendingDirectoryKey,undefined);
  assert.equal(committed.data.saveSettings.directoryKey,last);
  await h.send({sessionId:'other',type:'prune-directories'},200);
  assert.equal(records.has(last),true);
  assert.equal(records.has('session:work:old'),false);
  const foreign=await h.send({type:'settings-prepare',directoryKey:'session:other:foreign'});
  assert.equal(foreign.ok,false);
  const unprepared=await h.send({type:'settings',settings:{destination:'directory',directoryName:'Missing',directoryKey:'session:work:unprepared'}});
  assert.equal(unprepared.ok,false);
  assert.equal(h.store.get('workspace:work').saveSettings.directoryKey,last);
});

test('explicit restart replaces a full old page with new candidates and retains only selected old records',async t=>{
  const h=await browser(t);
  h.state.items=Array.from({length:500},(_,index)=>({url:`https://source.test/old-${index}.png`,width:10,height:10}));
  h.state.selectedURLs=[h.state.items[0].url];h.persist();
  const incoming={url:'https://source.test/new.png',width:20,height:20};
  h.scriptResults.push({items:[incoming],notices:[],cursor:null,retryCursor:'restart-first',hasMore:false,scanId:'restart'});
  const result=await h.send({type:'scan'});
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(result.data.items.map(item=>item.url),[incoming.url]);
  assert.deepEqual(result.data.scan.addedURLs,[incoming.url]);
  assert.equal(result.data.scan.hasMore,false);
  assert.deepEqual(result.data.selectedItems.map(item=>item.url),[h.state.items[0].url]);
  assert.deepEqual(result.data.selectedURLs,h.state.selectedURLs);
});

function pendingSubmission(h,age = 0) {
  const url='https://source.test/pending';
  const filename='ImageCrate/Frozen/001_pending.img';
  const startedAt=Date.now()-age;
  h.state.items=[{url,width:20,height:20}];h.state.selectedURLs=[url];
  h.state.batch={id:'batch',format:'original',destination:'downloads',folderName:'Frozen'};
  h.state.jobs=[{id:'pending-job',url,filename,status:'in_progress',completionApplied:false,submission:{url,filename,startedAt}}];
  h.persist();
  return {url,filename,startedAt};
}
function acceptedSubmission(source,id,patch = {}) {
  return {id,url:source.url,filename:`/Downloads/${source.filename.replace(/\.img$/,'.png')}`,byExtensionId:'test',startTime:new Date(source.startedAt+1).toISOString(),state:'in_progress',mime:'image/png',bytesReceived:1,totalBytes:10,...patch};
}

test('a worker stopped before Chrome acceptance recovers an expired submission as interrupted and permits explicit retry',async t=>{
  const h=await browser(t);const source=pendingSubmission(h,60000);
  await h.restartWorker();
  const restored=await h.send({type:'get'});
  assert.equal(restored.ok,true,restored.error);
  assert.equal(restored.data.jobs[0].status,'interrupted');
  assert.match(restored.data.jobs[0].error,/保存結果を確認できませんでした/);
  assert.equal(restored.data.jobs[0].submission,undefined);
  assert.deepEqual(restored.data.selectedURLs,[source.url]);
  assert.deepEqual(h.requested,[],'uncertain acceptance never starts another download automatically');
  const retry=await h.send({type:'retry'});
  assert.equal(retry.ok,true,retry.error);
  assert.equal(h.requested.length,1);
  assert.equal(h.requested[0].url,source.url);
  assert.equal(h.requested[0].conflictAction,'uniquify','a delayed old file or an existing completed file is never overwritten');
});

test('cancel waits for recent unresolved acceptance but recovers it after the bounded reconciliation period',async t=>{
  const h=await browser(t);pendingSubmission(h);
  const waiting=await h.send({type:'cancel'});
  assert.equal(waiting.ok,true,waiting.error);
  assert.equal(waiting.data.jobs[0].status,'in_progress');
  assert.match(waiting.data.jobs[0].error,/30秒/);
  const state=h.store.get('workspace:work');state.jobs[0].submission.startedAt=Date.now()-31000;h.store.set('workspace:work',state);
  const expired=await h.send({type:'cancel'});
  assert.equal(expired.data.jobs[0].status,'interrupted');
  assert.match(expired.data.jobs[0].error,/保存結果を確認できませんでした/);
  assert.deepEqual(h.cancelled,[]);
});

test('submission recovery requires unique owned URL, start time and frozen path, excluding IDs used by another job',async t=>{
  const h=await browser(t);const source=pendingSubmission(h);
  h.downloads.set(21,acceptedSubmission(source,21,{filename:'/Downloads/ImageCrate/Other/001_pending.png'}));
  h.downloads.set(22,acceptedSubmission(source,22,{byExtensionId:'other-extension'}));
  h.downloads.set(23,acceptedSubmission(source,23,{startTime:new Date(source.startedAt-1).toISOString()}));
  h.downloads.set(24,acceptedSubmission(source,24));
  h.downloads.set(25,acceptedSubmission(source,25,{filename:'/Downloads/ImageCrate/Frozen/001_pending (1).png'}));
  h.store.set('workspace:other',{id:'other',items:[],jobs:[{id:'other-job',url:source.url,downloadId:24,status:'in_progress'}],notices:[]});
  const recovered=await h.send({type:'get'});
  assert.equal(recovered.ok,true,recovered.error);
  assert.equal(recovered.data.jobs[0].downloadId,25);
  assert.equal(recovered.data.jobs[0].status,'in_progress');
  assert.equal(recovered.data.jobs[0].submission,undefined);
  assert.deepEqual(h.requested,[]);
});

test('ambiguous submission candidates stay unresolved until the deadline and no existing download is cancelled',async t=>{
  const h=await browser(t);const source=pendingSubmission(h);
  h.downloads.set(31,acceptedSubmission(source,31));
  h.downloads.set(32,acceptedSubmission(source,32,{filename:'/Downloads/ImageCrate/Frozen/001_pending (1).png'}));
  const unresolved=await h.send({type:'get'});
  assert.equal(unresolved.data.jobs[0].downloadId,undefined);
  assert.equal(unresolved.data.jobs[0].status,'in_progress');
  const state=h.store.get('workspace:work');state.jobs[0].submission.startedAt-=31000;h.store.set('workspace:work',state);
  const expired=await h.send({type:'get'});
  assert.equal(expired.data.jobs[0].status,'interrupted');
  assert.match(expired.data.jobs[0].error,/保存結果を確認できませんでした/);
  assert.deepEqual(h.cancelled,[]);
  assert.equal(h.downloads.get(31).state,'in_progress');
  assert.equal(h.downloads.get(32).state,'in_progress');
});

test('a completed unique accepted submission is recovered after the deadline and is not retried',async t=>{
  const h=await browser(t);const source=pendingSubmission(h,60000);
  h.downloads.set(41,acceptedSubmission(source,41,{state:'complete',bytesReceived:10}));
  const stopped=await h.send({type:'cancel'});
  assert.equal(stopped.ok,true,stopped.error);
  assert.equal(stopped.data.jobs[0].downloadId,41);
  assert.equal(stopped.data.jobs[0].status,'complete');
  assert.deepEqual(stopped.data.selectedURLs,[]);
  const retried=await h.send({type:'retry'});
  assert.equal(retried.data.jobs[0].status,'complete');
  assert.deepEqual(h.requested,[]);
  assert.deepEqual(h.cancelled,[]);
});

test('a filename event after download() resolves retains its accepted ID while a stale storage candidate is being saved',async t=>{
  const h=await browser(t);
  const url='https://source.test/image';
  h.state.items=[{url,width:20,height:10}];h.persist();
  const suggestions=[];let emitted=false;
  h.options.beforeStorageSet=async values=>{
    const job=values['workspace:work']?.jobs[0];
    if (!job?.downloadId || emitted) return;
    emitted=true;
    const item=h.downloads.get(job.downloadId);
    Object.assign(item,{filename:'original-image.svg',mime:'image/svg+xml'});
    h.determining.emit(structuredClone(item),(...args)=>{
      suggestions.push(args);
      if (args[0]) item.filename=args[0].filename;
    });
    assert.equal(suggestions.length,1,'the ID cache answers immediately without waiting for the blocked storage queue');
    assert.equal(suggestions[0][0].filename,'ImageCrate/Frozen/001_image.svg');
    // The caller is about to persist the candidate captured before this event.
    assert.equal(job.filename,'ImageCrate/Frozen/001_image.img');
    await nextTurn();
  };
  const saved=await h.send({type:'save',urls:[url],settings:{folderName:'Frozen'}});
  assert.equal(saved.ok,true,saved.error);
  assert.equal(emitted,true);
  await eventually(()=>h.store.get('workspace:work').jobs[0].filename === 'ImageCrate/Frozen/001_image.svg','the immutable filename decision survives the older candidate overwriting its mutable job');
  const persisted=h.store.get('workspace:work').jobs[0];
  assert.equal(persisted.actualFilename,'ImageCrate/Frozen/001_image.svg');
  assert.equal(persisted.typeKnown,true);
  assert.equal(persisted.mime,'image/svg+xml');
  assert.deepEqual(suggestions,[[{filename:'ImageCrate/Frozen/001_image.svg',conflictAction:'uniquify'}]]);
});

test('known originals and converted downloads explicitly suggest their fixed batch paths after download() resolves',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const original=await h.send({type:'save',urls:[urls[0]],settings:{folderName:'Known'}});
  const first=original.data.jobs[0];
  const originalCalls=[];
  h.determining.emit({id:first.downloadId,url:first.url,byExtensionId:'test',filename:'server-default.png',mime:'image/png'},(...args)=>originalCalls.push(args));
  assert.deepEqual(originalCalls,[[{filename:'ImageCrate/Known/001_first.png',conflictAction:'uniquify'}]]);
  h.complete(first.downloadId);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','original batch completes');
  const converted=await h.send({type:'save',urls:[urls[1]],settings:{folderName:'Converted',format:'jpg'}});
  const accepted=await beginConverted(h,converted.data);
  assert.equal(accepted.ok,true,accepted.error);
  const second=accepted.data.jobs[0];
  const convertedCalls=[];
  h.determining.emit({id:second.downloadId,url:'blob:chrome-extension://test/converted-image',byExtensionId:'test',filename:'browser-default.jpg',mime:'image/jpeg'},(...args)=>convertedCalls.push(args));
  assert.deepEqual(convertedCalls,[[{filename:'ImageCrate/Converted/001_second.jpg',conflictAction:'uniquify'}]]);
  await eventually(()=>h.store.get('workspace:work').jobs[0].actualFilename === 'ImageCrate/Converted/001_second.jpg','converted filenames are persisted through the same decision path');
});

test('late filename events for the same URL in two workspaces match accepted IDs before URL',async t=>{
  const h=await browser(t);
  const url='https://source.test/shared-image';
  h.state.items=[{url,width:20,height:10}];h.persist();
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{...structuredClone(h.state),id:'other',workspaceTabId:200});
  const first=await h.send({type:'save',urls:[url],settings:{folderName:'First'}});
  const second=await h.send({sessionId:'other',type:'save',urls:[url],settings:{folderName:'Second'}},200);
  for (const [response,folder] of [[first,'First'],[second,'Second']]) {
    assert.equal(response.ok,true,response.error);
    const calls=[];
    h.determining.emit({id:response.data.jobs[0].downloadId,url,byExtensionId:'test',filename:'server.svg',mime:'image/svg+xml'},(...args)=>calls.push(args));
    assert.deepEqual(calls,[[{filename:`ImageCrate/${folder}/001_shared-image.svg`,conflictAction:'uniquify'}]]);
  }
  await eventually(()=>h.store.get('workspace:work').jobs[0].filename.endsWith('.svg') && h.store.get('workspace:other').jobs[0].filename.endsWith('.svg'),'both ID-specific filename decisions are stored');
  assert.equal(h.store.get('workspace:work').jobs[0].filename,'ImageCrate/First/001_shared-image.svg');
  assert.equal(h.store.get('workspace:other').jobs[0].filename,'ImageCrate/Second/001_shared-image.svg');
});

test('an alarm reconciles a closed pending submission without UI polling and unrelated saves do not postpone it',async t=>{
  const h=await browser(t,{withAlarms:true});pendingSubmission(h);
  const first=await h.send({type:'get'});
  assert.equal(first.ok,true,first.error);
  assert.equal(h.alarmCreates.length,1);
  const alarm=h.alarmCreates[0];
  assert.equal(alarm.delayInMinutes,1);
  assert.equal(alarm.periodInMinutes,1);
  h.closeWorkspace();
  await eventually(()=>h.store.get('workspace:work')?.closed,'the workspace closes while acceptance is unresolved');
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{id:'other',workspaceTabId:200,items:[],jobs:[],notices:[]});
  const other=await h.send({sessionId:'other',type:'ui',patch:{query:'other tab'}},200);
  assert.equal(other.ok,true,other.error);
  assert.equal(h.alarmCreates.length,1,'existing alarms keep their original wake-up time through all state writes');
  const state=h.store.get('workspace:work');state.jobs[0].submission.startedAt=Date.now()-31000;h.store.set('workspace:work',state);
  h.alarmEvent.emit({name:alarm.name});
  await eventually(()=>!h.store.has('workspace:work'),'the alarm expires and removes the closed unresolved session');
  await eventually(()=>!h.alarms.has(alarm.name),'the last pending submission clears its recovery alarm');
  assert.deepEqual(h.requested,[]);
  assert.deepEqual(h.cancelled,[]);
});

test('worker startup recreates a missing pending alarm and expires a closed submission without a UI message',async t=>{
  const h=await browser(t,{withAlarms:true});pendingSubmission(h);
  await h.restartWorker();
  await eventually(()=>h.alarms.size === 1,'startup schedules the pending reconciliation even without get/polling');
  const state=h.store.get('workspace:work');state.closed=true;state.jobs[0].submission.startedAt=Date.now()-31000;h.store.set('workspace:work',state);
  h.tabs.delete(100);
  await h.restartWorker();
  await eventually(()=>!h.store.has('workspace:work'),'startup reconciles the expired closed submission');
  await eventually(()=>h.alarms.size === 0,'startup removes a no-longer-needed alarm');
  assert.deepEqual(h.requested,[]);
});

test('onCreated reconciles an unknown accepted ID after its workspace closes and preserves the completed file',async t=>{
  const h=await browser(t,{withAlarms:true});const source=pendingSubmission(h);
  await h.send({type:'get'});h.closeWorkspace();
  await eventually(()=>h.store.get('workspace:work')?.closed,'closed pending work remains for recovery');
  const item=acceptedSubmission(source,81,{state:'complete',bytesReceived:10});
  h.downloads.set(item.id,item);
  h.created.emit(structuredClone(item));
  await eventually(()=>!h.store.has('workspace:work'),'an event with the unpersisted ID recovers and retires the completed batch');
  await eventually(()=>h.alarms.size === 0,'recovered acceptance clears its pending alarm');
  assert.equal(h.downloads.get(item.id).state,'complete');
  assert.deepEqual(h.requested,[]);
  assert.deepEqual(h.cancelled,[]);
});

test('onChanged for an unknown download ID wakes pending sessions after their polling workspace has closed',async t=>{
  const h=await browser(t,{withAlarms:true});pendingSubmission(h);
  await h.send({type:'get'});h.closeWorkspace();
  await eventually(()=>h.store.get('workspace:work')?.closed,'the original page no longer polls');
  const state=h.store.get('workspace:work');state.jobs[0].submission.startedAt=Date.now()-31000;h.store.set('workspace:work',state);
  h.changed.emit({id:999,filename:{current:'unrelated-file.png'}});
  await eventually(()=>!h.store.has('workspace:work'),'even an unknown ID causes the persisted pending submission to be reconciled');
  assert.deepEqual(h.requested,[]);
  assert.deepEqual(h.cancelled,[]);
});

test('a delayed filename decision preserves the completed Chrome absolute actual filename',async t=>{
  const h=await browser(t);
  const url='https://source.test/image';
  h.state.items=[{url,width:20,height:10}];h.persist();
  const saved=await h.send({type:'save',urls:[url],settings:{folderName:'Frozen'}});
  assert.equal(saved.ok,true,saved.error);
  const id=saved.data.jobs[0].downloadId;
  const actual='/Users/synthetic/Downloads/ImageCrate/Frozen/001_image (1).svg';
  Object.assign(h.downloads.get(id),{filename:actual,mime:'image/svg+xml'});
  let emitted=false;const calls=[];
  h.options.beforeStorageSet=async values=>{
    const job=values['workspace:work']?.jobs[0];
    if (emitted || job?.status !== 'complete') return;
    emitted=true;
    assert.equal(job.actualFilename,actual,'Chrome search already reported its completed absolute path');
    h.determining.emit(structuredClone(h.downloads.get(id)),(...args)=>calls.push(args));
    assert.equal(calls[0][0].filename,'ImageCrate/Frozen/001_image.svg');
    await nextTurn();
  };
  h.complete(id);
  await eventually(()=>emitted && h.store.get('workspace:work').jobs[0].filename.endsWith('.svg'),'the late filename patch is persisted after completion');
  const final=h.store.get('workspace:work').jobs[0];
  assert.equal(final.status,'complete');
  assert.equal(final.filename,'ImageCrate/Frozen/001_image.svg','requested path remains relative');
  assert.equal(final.actualFilename,actual,'the late requested-path decision cannot replace Chrome actual path or its conflict suffix');
  assert.deepEqual(calls,[[{filename:'ImageCrate/Frozen/001_image.svg',conflictAction:'uniquify'}]]);
});

test('Stop persists cancellation before a late accepted ID is found, cancels progress and retry clears the intent',async t=>{
  const h=await browser(t,{withAlarms:true});const source=pendingSubmission(h);
  const stopped=await h.send({type:'cancel'});
  assert.equal(stopped.ok,true,stopped.error);
  assert.equal(stopped.data.jobs[0].status,'in_progress');
  assert.equal(stopped.data.jobs[0].cancelRequested,true);
  assert.equal(stopped.data.jobs[0].cancelReason,'停止しました。');
  const cancel=h.chrome.downloads.cancel;
  h.chrome.downloads.cancel=async id=>{
    assert.equal(h.store.get('workspace:work').jobs[0].cancelRequested,true,'the Stop intent is durable before Chrome cancellation');
    return cancel(id);
  };
  const item=acceptedSubmission(source,91);
  h.downloads.set(item.id,item);h.created.emit(item);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'interrupted','late acceptance is cancelled rather than allowed to continue');
  assert.deepEqual(h.cancelled,[91]);
  assert.equal(h.store.get('workspace:work').jobs[0].downloadId,91);
  assert.equal(h.downloads.get(91).state,'interrupted');
  assert.deepEqual(h.store.get('workspace:work').selectedURLs,[source.url]);
  const retried=await h.send({type:'retry'});
  assert.equal(retried.ok,true,retried.error);
  assert.equal(retried.data.jobs[0].cancelRequested,undefined);
  assert.equal(retried.data.jobs[0].cancelReason,undefined);
  assert.equal(retried.data.jobs[0].status,'in_progress');
});

test('Stop preserves a late accepted file that Chrome has already completed',async t=>{
  const h=await browser(t);const source=pendingSubmission(h);
  await h.send({type:'cancel'});
  const item=acceptedSubmission(source,92,{state:'complete',bytesReceived:10});
  h.downloads.set(item.id,item);h.created.emit(item);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'complete','completion wins the race with Stop');
  assert.equal(h.store.get('workspace:work').jobs[0].downloadId,92);
  assert.deepEqual(h.cancelled,[]);
  assert.equal(h.downloads.get(92).state,'complete');
  assert.deepEqual(h.store.get('workspace:work').selectedURLs,[]);
});

test('Stop cancellation survives worker restart and applies when its accepted ID arrives later',async t=>{
  const h=await browser(t,{withAlarms:true});const source=pendingSubmission(h);
  await h.send({type:'cancel'});
  await h.restartWorker();
  await eventually(()=>h.alarms.size === 1,'the restarted pending cancellation retains its persistent wake');
  assert.equal(h.store.get('workspace:work').jobs[0].cancelRequested,true);
  const item=acceptedSubmission(source,93);
  h.downloads.set(item.id,item);h.changed.emit({id:93,filename:{current:item.filename}});
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'interrupted','the restarted worker cancels newly reconciled progress');
  assert.deepEqual(h.cancelled,[93]);
  assert.equal(h.downloads.get(93).state,'interrupted');
});

test('startup honors a Stop saved before queued jobs were marked interrupted and never starts their Chrome APIs',async t=>{
  const h=await browser(t,{withAlarms:true});const urls=imageItems(h);
  h.state.batch={id:'prepared-stop',format:'original',destination:'downloads'};
  h.state.jobs=urls.map((url,index)=>({id:`prepared-${index}`,url,filename:`ImageCrate/Frozen/${index}.png`,status:'queued',cancelRequested:true,cancelReason:'停止しました。'}));
  h.persist();
  await h.restartWorker();
  await eventually(()=>h.store.get('workspace:work').jobs.every(job=>job.status === 'interrupted'),'the prepared Stop reaches terminal state after startup');
  assert.deepEqual(h.requested,[]);
  assert.deepEqual(h.cancelled,[]);
  assert.equal(h.alarms.size,0);
});

test('known IDs whose cancellation has not settled remain recoverable by alarm after worker restart',async t=>{
  const h=await browser(t,{withAlarms:true});const urls=imageItems(h);
  const saved=await h.send({type:'save',urls:[urls[0]]});
  const id=saved.data.jobs[0].downloadId;
  const cancel=h.chrome.downloads.cancel;
  h.chrome.downloads.cancel=async()=>{throw new Error('Chrome has not settled cancellation');};
  const stopped=await h.send({type:'cancel'});
  assert.equal(stopped.data.jobs[0].status,'in_progress');
  assert.equal(stopped.data.jobs[0].cancelRequested,true);
  await h.restartWorker();
  await eventually(()=>h.alarms.size === 1,'known-ID cancellation is still background recovery work');
  h.chrome.downloads.cancel=cancel;
  h.alarmEvent.emit({name:[...h.alarms.keys()][0]});
  await eventually(()=>h.store.get('workspace:work').jobs[0].status === 'interrupted','the alarm retries a durable Chrome cancellation');
  assert.deepEqual(h.cancelled,[id]);
  await eventually(()=>h.alarms.size === 0,'terminal cancellation clears the recovery alarm');
});

test('Chrome 116 URL-less workspace tabs stay alive through a matching main-frame extension context',async t=>{
  const h=await browser(t,{withAlarms:true});const source=pendingSubmission(h);
  h.tabs.set(100,{id:100});
  h.contexts.push({contextType:'TAB',tabId:100,frameId:0,documentUrl:'chrome-extension://test/workspace.html?id=work'});
  await h.restartWorker();
  await eventually(()=>h.alarms.size === 1 && h.contextCalls.length > 0,'startup confirms the otherwise URL-less owner through getContexts');
  const state=h.store.get('workspace:work');
  assert.notEqual(state.closed,true);
  assert.deepEqual(state.selectedURLs,[source.url]);
  const existing=await h.openWorkspace(h.tabs.get(1));
  assert.equal(existing,'work','opening the source focuses its existing workspace');
  assert.equal(h.tabCreates.length,0);
  assert.deepEqual(h.contextCalls[0],{contextTypes:['TAB'],tabIds:[100],documentUrls:['chrome-extension://test/workspace.html?id=work']});
});

test('a URL-less workspace is rejected when contexts do not contain its exact main-frame document',async t=>{
  const h=await browser(t,{withAlarms:true});pendingSubmission(h);
  h.tabs.set(100,{id:100});
  h.contexts.push({contextType:'TAB',tabId:100,frameId:1,documentUrl:'chrome-extension://test/workspace.html?id=work'},
    {contextType:'TAB',tabId:100,frameId:0,documentUrl:'chrome-extension://test/workspace.html?id=other'});
  await h.restartWorker();
  await eventually(()=>h.store.get('workspace:work')?.closed,'a mismatched context cannot own this session');
  const next=await h.openWorkspace(h.tabs.get(1));
  assert.notEqual(next,'work');
  assert.equal(h.tabCreates.length,1);
});

test('an explicit foreign workspace URL and a genuinely missing tab cannot be rescued by stale contexts',async t=>{
  const h=await browser(t,{withAlarms:true});pendingSubmission(h);
  h.tabs.set(100,{id:100,url:'https://unrelated.test/'});
  h.contexts.push({contextType:'TAB',tabId:100,frameId:0,documentUrl:'chrome-extension://test/workspace.html?id=work'});
  await h.restartWorker();
  await eventually(()=>h.store.get('workspace:work')?.closed,'an explicit foreign URL is rejected directly');
  assert.equal(h.contextCalls.length,0);
  const state=h.store.get('workspace:work');delete state.closed;h.store.set('workspace:work',state);h.tabs.delete(100);
  await h.restartWorker();
  await eventually(()=>h.store.get('workspace:work')?.closed,'a missing tab is closed even when a stale context is listed');
  assert.equal(h.contextCalls.length,0);
});
