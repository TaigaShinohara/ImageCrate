import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {createTransferBudget,reserveTransferAttempt} from '../extension/transfer-budget.js';
import {MEDIA_LIMITS} from '../extension/media-limits.js';
import {createImageResourceCoordinator} from '../extension/image-decoder.js';

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
  const previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let resourceQueue=Promise.resolve();
  const locks={request:(_name,_options,callback)=>{const result=resourceQueue.then(callback);resourceQueue=result.catch(()=>{});return result;}};
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
        if (Object.hasOwn(query,'id')) return downloads.has(query.id) ? [clone({id:query.id,byExtensionId:'test',
          startTime:new Date().toISOString(),...downloads.get(query.id)})] : [];
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
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else delete globalThis.chrome;
    if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else delete globalThis.navigator;
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

test('legacy native migration preserves the accepted file after close and refuses unbudgeted queued starts', async (t) => {
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
  await eventually(() => {
    const saved = h.store.get('workspace:work');
    return !saved || saved.jobs.every((job) => ['complete', 'interrupted'].includes(job.status));
  }, 'closed workspace must not leave a queued or in-progress batch after all downloads finish');
  assert.equal(h.requested.length, 0, 'legacy queued work requires an explicit new versioned batch');
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

async function nativeBatch(h,count=1) {
  const urls=imageItems(h).slice(0,count);
  const response=await h.send({type:'save',urls,settings:{destination:'downloads',format:'original'}});
  assert.equal(response.ok,true,response.error);return response.data;
}
function nativeLimits(h,{input=10,output=input,batchInput=40,batchOutput=batchInput,timeoutMs=900000}={}) {
  const state=h.store.get('workspace:work'),job=state.jobs[0],startedAt=job.transfer.startedAt;
  const budget=createTransferBudget({now:startedAt,maxBytes:batchInput,maxOutputBytes:batchOutput,timeoutMs});
  state.batch.transferBudget=reserveTransferAttempt(budget,{attemptId:job.id,logicalJobId:job.logicalJobId,
    maxBytes:input,maxOutputBytes:output,now:startedAt});
  job.transfer={...job.transfer,maxBytes:input,maxOutputBytes:output,deadline:Math.min(budget.deadline,startedAt+120000)};
  job.nativeObservation.deadline=job.transfer.deadline;h.store.set('workspace:work',state);return state;
}

test('native submission is preceded by durable source/output reservation and failed storage authorizes no API call',async t=>{
  const h=await browser(t);const urls=imageItems(h);const original=h.chrome.downloads.download;
  let starts=0;
  h.chrome.downloads.download=async options=>{
    starts++;const state=h.store.get('workspace:work'),job=state.jobs[0];
    assert.equal(state.batch.transferBudget.reservedBytes,MEDIA_LIMITS.original.maxBytes);
    assert.equal(state.batch.transferBudget.reservedOutputBytes,MEDIA_LIMITS.original.maxBytes);
    assert.equal(state.batch.transferBudget.logicalAttempts[job.logicalJobId],1);assert.ok(job.submission.token);
    return original(options);
  };
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{format:'original',destination:'downloads'}});
  assert.equal(saved.ok,true,saved.error);assert.equal(starts,1);
  await h.send({type:'cancel'});
  h.options.rejectStorage=true;
  const refused=await h.send({type:'save',urls:[urls[0]],settings:{format:'original',destination:'downloads'}});
  assert.equal(refused.ok,false);assert.equal(starts,1);
});

test('native accepted-ID history rejection stays unknown, reserves full capacity and cannot start queued work or retry',async t=>{
  const h=await browser(t);const search=h.chrome.downloads.search;
  h.chrome.downloads.search=async query=>{if(Object.hasOwn(query,'id'))throw new Error('accepted history query failed');return search(query);};
  const state=await nativeBatch(h,2),job=state.jobs[0];
  assert.ok(Number.isSafeInteger(job.downloadId));assert.equal(job.status,'in_progress');assert.equal(job.outcomeUnknown,true);
  assert.equal(state.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal(state.batch.transferBudget.outputBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal(state.jobs[1].status,'queued');assert.equal(h.requested.length,1);
  assert.equal((await h.send({type:'retry'})).ok,false);
  assert.equal((await h.send({type:'save',urls:[job.url],settings:{destination:'downloads'}})).ok,false);
  h.chrome.downloads.search=search;Object.assign(h.downloads.get(job.downloadId),{state:'complete',bytesReceived:3,totalBytes:3});
  const recovered=await h.send({type:'get'});
  assert.equal(recovered.data.jobs[0].status,'complete');assert.equal(recovered.data.jobs[0].downloadId,job.downloadId);
  assert.equal(recovered.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(recovered.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal(h.requested.length,2,'the next reserved job starts only after the real first terminal result');
  assert.notEqual(h.requested[1].url,job.url,'the first accepted image is never submitted again');
});

test('native accepted-ID storage failure preserves the ID and conservative accounting through worker restart',async t=>{
  const h=await browser(t,{withAlarms:true});let failed=false;
  h.options.beforeStorageSet=values=>{
    const candidate=values['workspace:work'],job=candidate?.jobs?.[0];
    if(!failed&&Number.isSafeInteger(job?.downloadId)&&!job.outcomeUnknown) {failed=true;throw new Error('accepted ID acknowledgement storage failure');}
  };
  const state=await nativeBatch(h),id=state.jobs[0].downloadId;
  assert.equal(failed,true);assert.ok(Number.isSafeInteger(id));assert.equal(state.jobs[0].status,'in_progress');
  assert.equal(state.jobs[0].outcomeUnknown,true);assert.equal(h.store.get('workspace:work').jobs[0].downloadId,id);
  assert.equal(state.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  h.chrome.downloads.cancel=async()=>{throw new Error('still in progress');};
  await h.restartWorker();const restored=await h.send({type:'get'});
  assert.equal(restored.data.jobs[0].downloadId,id);assert.equal(restored.data.jobs[0].status,'in_progress');
  assert.equal(h.requested.length,1);assert.equal(restored.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  Object.assign(h.downloads.get(id),{state:'complete',bytesReceived:3,totalBytes:3});
  const complete=await h.send({type:'get'});
  assert.equal(complete.data.jobs[0].status,'complete');assert.equal(complete.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(complete.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes,'a later terminal result cannot refund an unknown acceptance');
  assert.equal(h.requested.length,1);
});

test('native reservation-storage rejection before API dispatch remains a known unaccepted failure',async t=>{
  const h=await browser(t);const urls=imageItems(h);let failed=false,starts=0;
  const original=h.chrome.downloads.download;h.chrome.downloads.download=async options=>{starts++;return original(options);};
  h.options.beforeStorageSet=values=>{
    if(!failed&&values['workspace:work']?.jobs?.[0]?.submission) {failed=true;throw new Error('reservation storage rejected before dispatch');}
  };
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  assert.equal(saved.ok,true,saved.error);assert.equal(starts,0);assert.equal(saved.data.jobs[0].status,'interrupted');
  assert.equal(saved.data.jobs[0].submission,undefined);assert.equal(saved.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(saved.data.batch.transferBudget.consumedBytes,0);assert.equal(saved.data.batch.transferBudget.outputBytes,0);
  assert.equal((await h.send({type:'retry'})).ok,true);assert.equal(starts,1);
});

test('native observed overshoot saves cancel intent before cancellation and charges actual bytes once',async t=>{
  const h=await browser(t);await nativeBatch(h);const state=nativeLimits(h);const job=state.jobs[0],id=job.downloadId;
  const cancel=h.chrome.downloads.cancel;
  h.chrome.downloads.cancel=async downloadId=>{
    const stored=h.store.get('workspace:work');assert.equal(stored.jobs[0].cancelRequested,true);
    assert.match(stored.jobs[0].cancelReason,/観測容量/);assert.equal(downloadId,id);return cancel(downloadId);
  };
  Object.assign(h.downloads.get(id),{bytesReceived:11,totalBytes:-1});
  const stopped=await h.send({type:'get'});
  assert.equal(stopped.ok,true,stopped.error);assert.equal(stopped.data.jobs[0].status,'interrupted');
  assert.deepEqual(h.cancelled,[id]);assert.equal(stopped.data.batch.transferBudget.consumedBytes,11);
  assert.equal(stopped.data.batch.transferBudget.outputBytes,11);assert.equal(stopped.data.batch.transferBudget.reservedBytes,0);
  const again=await h.send({type:'get'});assert.equal(again.data.batch.transferBudget.consumedBytes,11);
});

test('native known total can cancel early without counting declared bytes as received',async t=>{
  const h=await browser(t);await nativeBatch(h);const state=nativeLimits(h);const id=state.jobs[0].downloadId;
  Object.assign(h.downloads.get(id),{bytesReceived:1,totalBytes:100});
  const stopped=await h.send({type:'get'});
  assert.equal(stopped.data.jobs[0].status,'interrupted');assert.deepEqual(h.cancelled,[id]);
  assert.equal(stopped.data.batch.transferBudget.consumedBytes,1);assert.equal(stopped.data.batch.transferBudget.outputBytes,1);
});

test('native monitoring refuses cancellation before its intent is durable when storage rejects the observation',async t=>{
  const h=await browser(t);await nativeBatch(h);const state=nativeLimits(h),id=state.jobs[0].downloadId;
  h.downloads.get(id).bytesReceived=11;h.options.rejectStorage=true;
  const refused=await h.send({type:'get'});assert.equal(refused.ok,false);assert.deepEqual(h.cancelled,[]);
  assert.equal(h.store.get('workspace:work').jobs[0].cancelRequested,undefined);
  h.options.rejectStorage=false;
  const stopped=await h.send({type:'get'});assert.equal(stopped.data.jobs[0].status,'interrupted');assert.deepEqual(h.cancelled,[id]);
});

test('native duplicate and regressing counters do not reduce usage or refresh the idle clock',async t=>{
  const h=await browser(t);await nativeBatch(h);const state=nativeLimits(h);const id=state.jobs[0].downloadId;
  let now=state.jobs[0].transfer.startedAt+1000;t.mock.method(Date,'now',()=>now);
  Object.assign(h.downloads.get(id),{bytesReceived:5,totalBytes:-1});await h.send({type:'get'});
  const progressAt=h.store.get('workspace:work').jobs[0].nativeObservation.lastProgressAt;
  for(const bytes of [5,3,-1,Number.MAX_SAFE_INTEGER+1]) {
    now+=1000;h.downloads.get(id).bytesReceived=bytes;
    const next=await h.send({type:'get'});
    assert.equal(next.data.jobs[0].nativeObservation.bytesReceived,5);
    assert.equal(next.data.jobs[0].nativeObservation.lastProgressAt,progressAt);
  }
  Object.assign(h.downloads.get(id),{state:'complete',bytesReceived:6,totalBytes:6,fileSize:6});
  const complete=await h.send({type:'get'});
  assert.equal(complete.data.jobs[0].status,'complete');assert.equal(complete.data.batch.transferBudget.consumedBytes,6);
  assert.equal(complete.data.batch.transferBudget.outputBytes,6);assert.deepEqual(h.cancelled,[]);
});

test('native idle timeout is observed at 30 seconds and positive progress cannot renew the 120 second deadline',async t=>{
  const h=await browser(t);let state=await nativeBatch(h);let job=state.jobs[0];
  let now=job.transfer.startedAt+29999;t.mock.method(Date,'now',()=>now);
  assert.equal((await h.send({type:'get'})).data.jobs[0].status,'in_progress');
  now++;assert.equal((await h.send({type:'get'})).data.jobs[0].status,'interrupted');assert.match(h.store.get('workspace:work').jobs[0].cancelReason,/30秒/);
  const retried=await h.send({type:'retry'});assert.equal(retried.ok,true,retried.error);state=retried.data;job=state.jobs[0];
  now=job.transfer.startedAt+90000;h.downloads.get(job.downloadId).bytesReceived=1;
  assert.equal((await h.send({type:'get'})).data.jobs[0].status,'in_progress');
  now=job.transfer.deadline+1;h.downloads.get(job.downloadId).bytesReceived=2;
  const expired=await h.send({type:'get'});assert.equal(expired.data.jobs[0].status,'interrupted');assert.match(expired.data.jobs[0].cancelReason,/制限時間/);
});

test('native clock rollback is failclosed and cannot create a fresh timeout window',async t=>{
  const h=await browser(t);const state=await nativeBatch(h);const job=state.jobs[0];
  let now=job.transfer.startedAt+1000;t.mock.method(Date,'now',()=>now);h.downloads.get(job.downloadId).bytesReceived=1;
  await h.send({type:'get'});now--;
  const stopped=await h.send({type:'get'});assert.equal(stopped.data.jobs[0].status,'interrupted');assert.match(stopped.data.jobs[0].cancelReason,/時計/);
  assert.equal(stopped.data.jobs[0].transfer.deadline,job.transfer.deadline);
  assert.equal((await h.send({type:'retry'})).ok,false,'clock rollback cannot authorize a fresh attempt window in the same batch');
});

test('native output observations exhaust their own batch budget without double-counting source bytes',async t=>{
  const h=await browser(t);await nativeBatch(h,2);const state=nativeLimits(h,{input:10,output:6,batchInput:40,batchOutput:7});
  const id=state.jobs[0].downloadId;Object.assign(h.downloads.get(id),{bytesReceived:2,totalBytes:-1,fileSize:8});
  const stopped=await h.send({type:'get'});
  assert.equal(stopped.data.batch.transferBudget.consumedBytes,2);assert.equal(stopped.data.batch.transferBudget.outputBytes,8);
  assert.equal(stopped.data.jobs[0].status,'interrupted');assert.equal(stopped.data.jobs[1].status,'interrupted');
  assert.equal(h.requested.length,1,'no second native start fits the observed output budget');
});

test('native batch deadline stops the active attempt and all later starts without resetting on retry',async t=>{
  const h=await browser(t);await nativeBatch(h,2);const state=nativeLimits(h,{timeoutMs:2000});
  const deadline=state.batch.transferBudget.deadline;t.mock.method(Date,'now',()=>deadline+1);
  h.downloads.get(state.jobs[0].downloadId).bytesReceived=1;
  const stopped=await h.send({type:'get'});assert.equal(stopped.data.jobs[0].status,'interrupted');
  assert.equal(stopped.data.jobs[1].status,'interrupted');assert.equal(h.requested.length,1);
  const retry=await h.send({type:'retry'});assert.equal(retry.ok,false);
  assert.equal(h.store.get('workspace:work').batch.transferBudget.deadline,deadline);
});

test('native versioned batches continue after workspace close and wake all owned active IDs on restart and alarm',async t=>{
  const h=await browser(t,{withAlarms:true});const state=await nativeBatch(h,2);const first=state.jobs[0].downloadId;
  assert.ok(h.alarms.has('imagecrate-pending-downloads'),'all active native IDs have a Chrome116 recovery alarm');
  h.closeWorkspace();await eventually(()=>h.store.get('workspace:work')?.closed,'workspace is positively closed');
  h.complete(first);await eventually(()=>h.requested.length===2,'next reserved native attempt starts without the page');
  const second=h.requested[1].id;const current=h.store.get('workspace:work');
  let now=current.jobs[1].transfer.deadline+1;t.mock.method(Date,'now',()=>now);
  await h.restartWorker();await eventually(()=>h.cancelled.includes(second),'startup observes the elapsed deadline after sleep');
  await eventually(()=>!h.store.has('workspace:work'),'the closed native batch retires after real terminal confirmation');
  assert.equal(h.requested.length,2);assert.equal(h.downloads.get(first).state,'complete');
  await eventually(()=>h.alarms.size===0,'no active native job remains');
});

test('native missing history stays unknown and conservative through restart and only a real terminal result permits retry',async t=>{
  const h=await browser(t,{withAlarms:true});const state=await nativeBatch(h);const job=state.jobs[0],id=job.downloadId;
  const actual=structuredClone(h.downloads.get(id));h.downloads.delete(id);
  const missing=await h.send({type:'get'});
  assert.equal(missing.data.jobs[0].status,'in_progress');assert.equal(missing.data.jobs[0].outcomeUnknown,true);
  assert.equal(missing.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal(missing.data.batch.transferBudget.outputBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal((await h.send({type:'retry'})).ok,false);await h.restartWorker();
  assert.equal((await h.send({type:'get'})).data.jobs[0].status,'in_progress');
  h.downloads.set(id,{...actual,state:'interrupted',error:'USER_CANCELED',bytesReceived:2,totalBytes:2});
  const terminal=await h.send({type:'get'});
  assert.equal(terminal.data.jobs[0].status,'interrupted');assert.equal(terminal.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(terminal.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes,'unknown charges are never refunded');
  const retry=await h.send({type:'retry'});assert.equal(retry.ok,true,retry.error);
  assert.equal(retry.data.jobs[0].logicalJobId,job.logicalJobId);assert.notEqual(retry.data.jobs[0].id,job.id);
  assert.equal(retry.data.batch.transferBudget.deadline,state.batch.transferBudget.deadline);
});

test('native monitoring never cancels a foreign extension ID or an unrelated event ID',async t=>{
  const h=await browser(t,{withAlarms:true});const state=await nativeBatch(h);const id=state.jobs[0].downloadId;
  Object.assign(h.downloads.get(id),{byExtensionId:'other-extension',bytesReceived:MEDIA_LIMITS.original.maxBytes+1});
  h.downloads.set(999,{id:999,byExtensionId:'other-extension',state:'in_progress',bytesReceived:999999});
  h.changed.emit({id:999,bytesReceived:{current:999999}});
  await eventually(()=>h.store.get('workspace:work').jobs[0].ownershipMismatch===true,'foreign ownership is preserved as unknown');
  assert.deepEqual(h.cancelled,[]);assert.equal(h.downloads.get(id).state,'in_progress');
  assert.equal(h.downloads.get(999).state,'in_progress');assert.equal((await h.send({type:'retry'})).ok,false);
});

test('native completion immediately before cancellation remains complete and charges its actual observed overshoot',async t=>{
  const h=await browser(t);await nativeBatch(h);const state=nativeLimits(h);const id=state.jobs[0].downloadId;
  Object.assign(h.downloads.get(id),{bytesReceived:11,totalBytes:11});
  h.chrome.downloads.cancel=async downloadId=>{
    h.cancelled.push(downloadId);Object.assign(h.downloads.get(downloadId),{state:'complete',fileSize:11});
    throw new Error('completed just before cancel');
  };
  const complete=await h.send({type:'get'});
  assert.equal(complete.data.jobs[0].status,'complete');assert.equal(complete.data.batch.transferBudget.consumedBytes,11);
  const retried=await h.send({type:'retry'});assert.equal(retried.data.jobs[0].id,state.jobs[0].id);assert.equal(h.requested.length,1);
});

test('native known API failures count actual attempts and retry cannot reset the deadline or exceed three starts',async t=>{
  const h=await browser(t);const urls=imageItems(h);let starts=0;
  h.chrome.downloads.download=async()=>{starts++;throw new Error('known API rejection');};
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  assert.equal(saved.ok,true,saved.error);const deadline=saved.data.batch.transferBudget.deadline,logical=saved.data.jobs[0].logicalJobId;
  for(let index=1;index<3;index++) {
    const retry=await h.send({type:'retry'});assert.equal(retry.ok,true,retry.error);
    assert.equal(retry.data.batch.transferBudget.deadline,deadline);assert.equal(retry.data.jobs[0].logicalJobId,logical);
    assert.equal(retry.data.batch.transferBudget.consumedBytes,0);assert.equal(retry.data.batch.transferBudget.outputBytes,0);
  }
  assert.equal(starts,3);assert.equal((await h.send({type:'retry'})).ok,false);
});

test('native API acceptance timeout frees the mutation queue and adopts a late exact ID even after the 30 second matching window',async t=>{
  const h=await browser(t,{withAlarms:true,messageTimeoutMs:120000});const urls=imageItems(h);
  let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});
  let accept,options;
  h.chrome.downloads.download=value=>{options=value;return new Promise(resolve=>{accept=resolve;});};
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>Boolean(accept),'native API is still pending');now+=31000;t.mock.timers.tick(30000);
  const unknown=await saving;assert.equal(unknown.ok,true,unknown.error);const job=unknown.data.jobs[0];
  assert.equal(job.status,'in_progress');assert.equal(job.outcomeUnknown,true);assert.ok(job.submission.apiPending);
  assert.equal(unknown.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{id:'other',workspaceTabId:200,items:[],jobs:[],notices:[]});
  assert.equal((await h.send({type:'ui',sessionId:'other',patch:{query:'responsive'}},200)).ok,true,'an unresolved API no longer owns the global queue');
  h.downloads.set(90,{id:90,url:options.url,filename:options.filename,byExtensionId:'test',
    startTime:new Date(now).toISOString(),state:'in_progress',mime:'image/png',bytesReceived:1,totalBytes:10});
  accept(90);
  await eventually(()=>h.store.get('workspace:work').jobs[0].chromeOutcomeKnown===true,'the exact late API ID is adopted and its durable cancel intent is executed');
  const terminal=h.store.get('workspace:work');
  assert.equal(terminal.jobs[0].downloadId,90);assert.equal(terminal.jobs[0].status,'interrupted');assert.deepEqual(h.cancelled,[90]);
  assert.equal(terminal.jobs[0].ownershipMismatch,undefined);assert.equal(terminal.batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
});

test('native alarm observes idle owned IDs without UI polling and retains durable cancel intent when cancellation fails',async t=>{
  const h=await browser(t,{withAlarms:true});const state=await nativeBatch(h),job=state.jobs[0],id=job.downloadId;
  let now=job.transfer.startedAt+30000;t.mock.method(Date,'now',()=>now);
  h.chrome.downloads.cancel=async downloadId=>{h.cancelled.push(downloadId);throw new Error('not stopped yet');};
  h.alarmEvent.emit({name:'imagecrate-pending-downloads'});
  await eventually(()=>h.store.get('workspace:work').jobs[0].cancelRequested===true,'alarm persists native idle cancellation before any page request');
  await eventually(()=>h.cancelled.includes(id),'owned ID receives best-effort cancellation');
  assert.equal(h.store.get('workspace:work').jobs[0].status,'in_progress');assert.ok(h.alarms.has('imagecrate-pending-downloads'));
  await h.restartWorker();await eventually(()=>h.cancelled.length>=2,'worker restart retries its durable cancel intent');
  Object.assign(h.downloads.get(id),{state:'complete',bytesReceived:3,totalBytes:3});
  h.alarmEvent.emit({name:'imagecrate-pending-downloads'});
  await eventually(()=>h.store.get('workspace:work').jobs[0].status==='complete','actual complete wins even after cancellation failure');
  assert.equal(h.store.get('workspace:work').batch.transferBudget.consumedBytes,3);
});

test('native acceptance that never resolves stays unknown with one start and still permits unrelated workspace work',async t=>{
  const h=await browser(t,{withAlarms:true,messageTimeoutMs:120000});const urls=imageItems(h);
  t.mock.timers.enable({apis:['setTimeout']});let starts=0;
  h.chrome.downloads.download=()=>{starts++;return new Promise(()=>{});};
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>starts===1,'one native API call started');t.mock.timers.tick(30000);
  const unknown=await saving;assert.equal(unknown.data.jobs[0].status,'in_progress');assert.equal(unknown.data.jobs[0].cancelRequested,true);
  assert.equal((await h.send({type:'retry'})).ok,false);
  assert.equal((await h.send({type:'ui',patch:{query:'remains responsive'}})).ok,true);
  assert.equal((await h.send({type:'get'})).data.jobs[0].outcomeUnknown,true);assert.equal(starts,1);
  assert.ok(h.alarms.has('imagecrate-pending-downloads'));assert.deepEqual(h.cancelled,[],'no unproven ID can be cancelled');
});

test('native late API rejection permits a fresh attempt without refunding previously unknown usage',async t=>{
  const h=await browser(t,{messageTimeoutMs:120000});const urls=imageItems(h);const original=h.chrome.downloads.download;
  t.mock.timers.enable({apis:['setTimeout']});let reject;
  h.chrome.downloads.download=()=>new Promise((_,no)=>{reject=no;});
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>Boolean(reject),'native API has not replied');t.mock.timers.tick(30000);
  const unknown=await saving,deadline=unknown.data.batch.transferBudget.deadline;
  reject(new Error('known rejection after delayed API response'));
  await eventually(()=>h.store.get('workspace:work').jobs[0].status==='interrupted','actual API rejection without acceptance evidence is known failure');
  assert.equal(h.store.get('workspace:work').jobs[0].outcomeUnknown,undefined);
  assert.equal(h.store.get('workspace:work').batch.transferBudget.consumedBytes,MEDIA_LIMITS.original.maxBytes);
  h.chrome.downloads.download=original;
  const retry=await h.send({type:'retry'});assert.equal(retry.ok,true,retry.error);
  assert.equal(retry.data.batch.transferBudget.deadline,deadline);assert.equal(retry.data.jobs[0].status,'in_progress');
});

for(const eventKind of ['created','filename'])test(`native ${eventKind} acceptance proof takes precedence over a contradictory API rejection`,async t=>{
  const h=await browser(t);const urls=imageItems(h);let reject,acceptedEvent=false;
  h.chrome.downloads.download=options=>{
    const item={id:95,url:options.url,filename:options.filename,byExtensionId:'test',startTime:new Date().toISOString(),
      state:'in_progress',mime:'image/png',bytesReceived:2,totalBytes:10};
    h.downloads.set(95,item);
    if(eventKind==='created'){h.created.emit(structuredClone(item));acceptedEvent=true;}
    else h.determining.emit(structuredClone(item),()=>{acceptedEvent=true;});
    return new Promise((_,no)=>{reject=no;});
  };
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>acceptedEvent&&Boolean(reject),'Chrome event reports actual owned acceptance');
  await nextTurn();await nextTurn();reject(new Error('contradictory API rejection'));
  const accepted=await saving;assert.equal(accepted.ok,true,accepted.error);assert.equal(accepted.data.jobs[0].downloadId,95);
  assert.equal(accepted.data.jobs[0].downloadBinding.apiAccepted,false,'event proof is not mislabeled as an API acknowledgement');
  assert.equal(accepted.data.jobs[0].status,'in_progress');assert.equal(accepted.data.jobs[0].submission,undefined);
  assert.equal(accepted.data.batch.transferBudget.reservedBytes,MEDIA_LIMITS.original.maxBytes);
  Object.assign(h.downloads.get(95),{state:'complete',bytesReceived:2,totalBytes:2});
  const complete=await h.send({type:'get'});assert.equal(complete.data.jobs[0].status,'complete');
  assert.equal(complete.data.batch.transferBudget.consumedBytes,2);assert.equal(complete.data.batch.transferBudget.outputBytes,2);
});

test('native delayed filename events from an older same-URL download cannot bind to a new submission',async t=>{
  const h=await browser(t);const urls=imageItems(h);let accept,options,suggestion;
  h.chrome.downloads.download=value=>{options=value;return new Promise(resolve=>{accept=resolve;});};
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>Boolean(accept),'new native submission is pending');
  const old={id:70,url:options.url,filename:options.filename,byExtensionId:'test',startTime:new Date(Date.now()-60000).toISOString(),
    state:'in_progress',bytesReceived:1,totalBytes:10,mime:'image/png'};
  h.downloads.set(70,old);
  h.determining.emit(structuredClone(old),value=>{suggestion={value};});
  await eventually(()=>Boolean(suggestion),'unrelated older filename event is answered');
  assert.equal(suggestion.value,undefined,'older event receives no new submission filename');
  h.downloads.set(71,{...old,id:71,startTime:new Date().toISOString()});accept(71);
  const saved=await saving;assert.equal(saved.data.jobs[0].downloadId,71);assert.equal(saved.data.jobs[0].acceptanceConflict,undefined);
  assert.deepEqual(h.cancelled,[]);assert.equal(h.downloads.get(70).state,'in_progress');
});

test('native API/event ID disagreement remains conservatively unknown without replacing evidence or cancelling either candidate',async t=>{
  const h=await browser(t);const urls=imageItems(h);let accept,eventAccepted=false;
  h.chrome.downloads.download=options=>{
    const item={id:80,url:options.url,filename:options.filename,byExtensionId:'test',startTime:new Date().toISOString(),
      state:'in_progress',bytesReceived:1,totalBytes:10,mime:'image/png'};
    h.downloads.set(80,item);h.downloads.set(81,{...item,id:81});
    h.determining.emit(structuredClone(item),()=>{eventAccepted=true;});
    return new Promise(resolve=>{accept=resolve;});
  };
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>eventAccepted,'one candidate was proven by a filename event');accept(81);
  const unknown=await saving;assert.equal(unknown.ok,true,unknown.error);
  assert.equal(unknown.data.jobs[0].acceptanceConflict,true);assert.equal(unknown.data.jobs[0].outcomeUnknown,true);
  assert.equal(unknown.data.jobs[0].status,'in_progress');assert.equal(unknown.data.jobs[0].submission.apiAcceptedId,81);
  assert.equal(unknown.data.jobs[0].submission.eventAcceptedId,80);assert.equal(unknown.data.jobs[0].downloadId,undefined);
  assert.deepEqual(h.cancelled,[]);assert.equal((await h.send({type:'retry'})).ok,false);
});

test('native API cannot reuse an ID already owned by another persisted job',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{id:'other',workspaceTabId:200,items:[],notices:[],jobs:[{id:'other-job',url:urls[0],downloadId:82,status:'in_progress'}]});
  h.chrome.downloads.download=async()=>82;
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  assert.equal(saved.data.jobs[0].acceptanceConflict,true);assert.equal(saved.data.jobs[0].downloadId,undefined);
  assert.equal(h.store.get('workspace:other').jobs[0].downloadId,82);assert.deepEqual(h.cancelled,[]);
});

test('native late exact API acknowledgement preserves a matching already-confirmed completion even if further history searches fail',async t=>{
  const h=await browser(t,{messageTimeoutMs:120000});const urls=imageItems(h);
  t.mock.timers.enable({apis:['setTimeout']});let accept,options;
  h.chrome.downloads.download=value=>{options=value;return new Promise(resolve=>{accept=resolve;});};
  const saving=h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  await eventually(()=>Boolean(accept),'API reply is pending');t.mock.timers.tick(30000);await saving;
  const pending=h.store.get('workspace:work').jobs[0].submission;
  const item={id:83,url:options.url,filename:options.filename,byExtensionId:'test',startTime:new Date(pending.startedAt).toISOString(),
    state:'complete',bytesReceived:3,totalBytes:3,mime:'image/png'};
  h.downloads.set(83,item);h.created.emit(structuredClone(item));
  await eventually(()=>h.store.get('workspace:work').jobs[0].status==='complete','event independently confirms the real completed file');
  h.chrome.downloads.search=async()=>{throw new Error('history temporarily unavailable');};accept(83);
  await nextTurn();await nextTurn();
  assert.equal(h.store.get('workspace:work').jobs[0].status,'complete');assert.equal(h.store.get('workspace:work').jobs[0].chromeOutcomeKnown,true);
  assert.equal(h.store.get('workspace:work').jobs[0].outcomeUnknown,undefined);assert.deepEqual(h.cancelled,[]);
});

test('native download ID zero participates in observation, alarms and Stop exactly like other valid IDs',async t=>{
  const h=await browser(t,{withAlarms:true});const urls=imageItems(h);
  h.chrome.downloads.download=async options=>{
    h.downloads.set(0,{id:0,url:options.url,filename:options.filename,byExtensionId:'test',startTime:new Date().toISOString(),
      state:'in_progress',bytesReceived:0,totalBytes:-1,mime:'image/png'});return 0;
  };
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'original'}});
  assert.equal(saved.ok,true,saved.error);assert.equal(saved.data.jobs[0].downloadId,0);assert.ok(h.alarms.has('imagecrate-pending-downloads'));
  const state=nativeLimits(h);h.downloads.get(0).bytesReceived=11;
  const stopped=await h.send({type:'get'});assert.equal(stopped.data.jobs[0].status,'interrupted');assert.deepEqual(h.cancelled,[0]);
  assert.equal(stopped.data.batch.transferBudget.consumedBytes,11);assert.equal(state.jobs[0].downloadId,0);
});

test('closed active native batches still occupy the four-workspace limit while inactive cleanup tombstones do not',async t=>{
  const h=await browser(t);h.store.delete('workspace:work');
  for(let index=0;index<4;index++)h.store.set(`workspace:busy-${index}`,{id:`busy-${index}`,closed:true,items:[],notices:[],
    jobs:[{id:`native-${index}`,downloadId:100+index,status:'in_progress'}]});
  await assert.rejects(h.openWorkspace({id:2,url:'https://source.test/new',title:'New'}),/4つ/);
  assert.equal(h.tabCreates.length,0);
  h.store.get('workspace:busy-0').jobs[0].status='complete';
  for(let index=0;index<4;index++)h.store.set(`workspace:tombstone-${index}`,{id:`tombstone-${index}`,closed:true,items:[],notices:[],jobs:[],
    retiredImageOwners:[{owner:`closed-${index}`,blocked:true}]});
  const created=await h.openWorkspace({id:2,url:'https://source.test/new',title:'New'});
  assert.ok(created);assert.equal(h.tabCreates.length,1);
});

test('converted Chrome output lease is handed off and retained through missing history until positive native terminal',async t=>{
  const h=await browser(t,{withAlarms:true});const urls=imageItems(h);
  await h.send({type:'hello'});
  const saved=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'png'}})).data;
  const batchId=saved.batch.id,jobId=saved.jobs[0].id,owner='work:current-page:conversion';
  await h.send({type:'managed-reserve',batchId,jobId});
  const coordinator=createImageResourceCoordinator();
  const output=await coordinator.reserve(owner,{encodedBytes:7});
  const source=await coordinator.reserve(owner,{encodedBytes:9});
  const preview=await coordinator.reserve('work:current-page:preview',{encodedBytes:3});
  const missing=await h.send({type:'converted-download',batchId,jobId,blobURL:'blob:chrome-extension://test/image'});
  assert.equal(missing.ok,false,'new real workspaces must provide output ownership');
  const wrong=await h.send({type:'converted-download',batchId,jobId,blobURL:'blob:chrome-extension://test/image',resourceLease:{id:output.id,owner:'other'}});
  assert.equal(wrong.ok,false);assert.equal(h.requested.length,0);
  const accepted=await h.send({type:'converted-download',batchId,jobId,blobURL:'blob:chrome-extension://test/image',resourceLease:{id:output.id,owner}});
  assert.equal(accepted.ok,true,accepted.error);const id=accepted.data.jobs[0].downloadId;
  h.chrome.downloads.cancel=async id=>{h.cancelled.push(id);};
  const native=h.downloads.get(id);h.downloads.delete(id);h.closeWorkspace();
  await eventually(()=>h.store.get('workspace:work')?.closed,'positive workspace closure recorded');
  await eventually(()=>!h.store.get('imagecrate.imageResources.v1')?.[preview.id],'dead preview owner reclaimed');
  assert.ok(h.store.get('imagecrate.imageResources.v1')[output.id]);
  assert.ok(h.store.get('imagecrate.imageResources.v1')[source.id],'retired conversion owner remains charged while accepted Chrome result is unknown');
  h.downloads.set(id,{...native,state:'complete',bytesReceived:7,totalBytes:7,mime:'image/png'});
  h.changed.emit({id,state:{current:'complete'}});
  await eventually(()=>!h.store.get('imagecrate.imageResources.v1')?.[output.id]&&!h.store.get('imagecrate.imageResources.v1')?.[source.id],'background terminal confirmation reclaims accepted output and retired owner without the page callback');
});

test('reload reclaims old preview ownership but retains an uncertain directory output owner',async t=>{
  const h=await browser(t);const urls=imageItems(h);await h.send({type:'hello'});
  const saved=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures',format:'png'}})).data;
  await h.send({type:'managed-reserve',batchId:saved.batch.id,jobId:saved.jobs[0].id});
  const coordinator=createImageResourceCoordinator();
  const output=await coordinator.reserve('work:current-page:conversion',{encodedBytes:8});
  const preview=await coordinator.reserve('work:current-page:preview',{encodedBytes:4});
  const reloaded=await h.send({type:'hello',instance:'new-page'});
  assert.equal(reloaded.ok,true,reloaded.error);assert.equal(reloaded.data.jobs[0].outcomeUnknown,true);
  await eventually(()=>!h.store.get('imagecrate.imageResources.v1')?.[preview.id],'old preview reclaimed');
  assert.ok(h.store.get('imagecrate.imageResources.v1')[output.id],'owner transfer cannot free unresolved native writes');
});

test('an unavailable image cleanup lock does not hold the worker mutation queue',async t=>{
  const h=await browser(t);imageItems(h);await h.send({type:'hello'});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:()=>new Promise(()=>{})}}});
  const hello=await h.send({type:'hello',instance:'replacement'});
  assert.equal(hello.ok,true,hello.error);
  const next=await h.send({type:'get'});assert.equal(next.ok,true,next.error);
});

test('Back navigation cannot revive a closed cleanup tombstone or reuse its context-gone proof',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=h.store.get('workspace:work');state.closed=true;state.imageContextGone=true;state.imageInstance='old-page';
  state.retiredImageOwners=[{owner:'work:old-page:conversion',blocked:true}];h.store.set('workspace:work',state);
  for(const message of [{type:'hello'},{type:'save',urls,settings:{destination:'downloads'}},{type:'managed-reserve',batchId:'stale',jobId:'stale'}]){
    const result=await h.send(message);assert.equal(result.ok,false);assert.match(result.error,/元ページ/);
  }
  assert.equal(h.requested.length,0);assert.equal(h.store.get('workspace:work').imageInstance,'old-page');
});

test('closed image cleanup retains its tombstone after storage failure and reclaims the owner after worker restart',async t=>{
  const h=await browser(t,{withAlarms:true});imageItems(h);await h.send({type:'hello'});
  const coordinator=createImageResourceCoordinator();
  const preview=await coordinator.reserve('work:current-page:preview',{encodedBytes:11});
  let cleanupFailures=0;
  h.options.beforeStorageSet=values=>{
    if(Object.hasOwn(values,'imagecrate.imageResources.v1')) {cleanupFailures++;throw new Error('temporary image ledger storage failure');}
  };
  h.closeWorkspace();
  await eventually(()=>cleanupFailures>=2,'both retired owner cleanup attempts reached the failing storage boundary');
  await nextTurn();
  const closed=h.store.get('workspace:work');
  assert.equal(closed.closed,true);assert.ok(closed.retiredImageOwners.length>0,'durable cleanup evidence survives');
  assert.ok(h.store.get('imagecrate.imageResources.v1')[preview.id]);
  assert.ok(h.alarms.has('imagecrate-pending-downloads'),'failed cleanup remains eligible for recovery');
  delete h.options.beforeStorageSet;
  await h.restartWorker();
  await eventually(()=>!h.store.get('imagecrate.imageResources.v1')?.[preview.id],'restarted worker reclaims the positively closed preview owner');
  await eventually(()=>!h.store.has('workspace:work'),'successful cleanup removes its closed tombstone');
});

test('a live frozen workspace retains its converted output lease after actual Chrome completion',async t=>{
  const h=await browser(t,{withAlarms:true});const urls=imageItems(h);await h.send({type:'hello'});
  const saved=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'png'}})).data;
  const batchId=saved.batch.id,jobId=saved.jobs[0].id,owner='work:current-page:conversion';
  await h.send({type:'managed-reserve',batchId,jobId});
  const output=await createImageResourceCoordinator().reserve(owner,{encodedBytes:17});
  const accepted=await h.send({type:'converted-download',batchId,jobId,blobURL:'blob:chrome-extension://test/live-image',resourceLease:{id:output.id,owner}});
  assert.equal(accepted.ok,true,accepted.error);h.complete(accepted.data.jobs[0].downloadId);
  await eventually(()=>h.store.get('workspace:work').jobs[0].chromeOutcomeKnown===true,'actual Chrome terminal state is persisted');
  await nextTurn();await nextTurn();
  assert.ok(h.store.get('imagecrate.imageResources.v1')[output.id],'background cannot free bytes still retained by a live Object URL owner');
  assert.equal(h.store.get('workspace:work').jobs[0].resourceLease.id,output.id);
  await output.release(); // The page has now revoked its URL and dropped Blob references.
  await h.send({type:'get'});
  await eventually(()=>!h.store.get('workspace:work').jobs[0].resourceLease,'background drops only the already-released handoff record');
  assert.equal(h.store.get('imagecrate.imageResources.v1')[output.id],undefined);
});

test('converted output handoff does not wait for a pending resource lock or block another workspace state mutation',async t=>{
  const h=await browser(t);const urls=imageItems(h);await h.send({type:'hello'});
  const saved=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'png'}})).data;
  const batchId=saved.batch.id,jobId=saved.jobs[0].id,owner='work:current-page:conversion';
  await h.send({type:'managed-reserve',batchId,jobId});
  const coordinator=createImageResourceCoordinator();const output=await coordinator.reserve(owner,{encodedBytes:13});
  h.tabs.set(200,{id:200,url:'chrome-extension://test/workspace.html?id=other'});
  h.store.set('workspace:other',{...structuredClone(h.state),id:'other',workspaceTabId:200,jobs:[]});
  let releaseLock,entered=false;
  const holding=navigator.locks.request('imagecrate.imageResources.v1',{mode:'exclusive'},()=>{
    entered=true;return new Promise(resolve=>{releaseLock=resolve;});
  });
  await eventually(()=>entered,'test holds the image resource lock');
  const queued=coordinator.reserve('other:owner:preview',{encodedBytes:1});
  try {
    const accepted=await h.send({type:'converted-download',batchId,jobId,blobURL:'blob:chrome-extension://test/image',resourceLease:{id:output.id,owner}});
    assert.equal(accepted.ok,true,accepted.error);assert.ok(accepted.data.jobs[0].downloadId);
    const changed=await h.send({type:'ui',sessionId:'other',patch:{query:'still responsive'}},200);
    assert.equal(changed.ok,true,changed.error);assert.equal(changed.data.ui.query,'still responsive');
    assert.equal((await h.send({type:'get',sessionId:'other'},200)).ok,true);
  } finally {
    releaseLock();await holding;const extra=await queued;await extra.release();
  }
});

test('positive close clears an already-released output handoff and its tombstone during concurrent owner cleanup',async t=>{
  const h=await browser(t,{withAlarms:true});const urls=imageItems(h);await h.send({type:'hello'});
  const saved=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'png'}})).data;
  const batchId=saved.batch.id,jobId=saved.jobs[0].id,owner='work:current-page:conversion';
  await h.send({type:'managed-reserve',batchId,jobId});
  const output=await createImageResourceCoordinator().reserve(owner,{encodedBytes:19});
  const accepted=await h.send({type:'converted-download',batchId,jobId,blobURL:'blob:chrome-extension://test/image',resourceLease:{id:output.id,owner}});
  h.complete(accepted.data.jobs[0].downloadId);
  await eventually(()=>h.store.get('workspace:work').jobs[0].chromeOutcomeKnown===true,'Chrome is actually complete');
  await nextTurn();await nextTurn();
  await output.release(); // Handoff metadata remains until background next reconciles.
  assert.ok(h.store.get('workspace:work').jobs[0].resourceLease);
  h.closeWorkspace();
  await eventually(()=>!h.store.has('workspace:work'),'missing lease is a successful cleanup, not an unrecoverable tombstone');
  assert.equal(h.store.get('imagecrate.imageResources.v1')?.[output.id],undefined);
});

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

test('managed reservation is durably acknowledged before fetch authorization and idempotently keeps its deadline',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}});
  assert.equal(saved.ok,true,saved.error);
  const batchId=saved.data.batch.id,job=saved.data.jobs[0];
  assert.ok(job.logicalJobId);assert.notEqual(job.logicalJobId,job.id);
  assert.equal(saved.data.batch.transferBudget.reservedBytes,0);
  h.options.rejectStorage=true;
  const rejected=await h.send({type:'managed-reserve',batchId,jobId:job.id});
  assert.equal(rejected.ok,false);assert.equal(h.store.get('workspace:work').jobs[0].status,'queued');
  assert.equal(h.store.get('workspace:work').batch.transferBudget.reservedBytes,0);
  h.options.rejectStorage=false;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId:job.id});
  assert.equal(reserved.ok,true,reserved.error);
  const transfer=reserved.data.jobs[0].transfer;
  assert.equal(transfer.maxBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal(transfer.maxOutputBytes,MEDIA_LIMITS.original.maxBytes);
  assert.equal(transfer.deadline,Math.min(reserved.data.batch.transferBudget.deadline,transfer.startedAt+120000));
  assert.equal(h.store.get('workspace:work').batch.transferBudget.reservedBytes,transfer.maxBytes);
  const twice=await h.send({type:'managed-reserve',batchId,jobId:job.id});
  assert.equal(twice.ok,true,twice.error);assert.deepEqual(twice.data.jobs[0].transfer,transfer);
  assert.equal(twice.data.batch.transferBudget.logicalAttempts[job.logicalJobId],1);
  assert.equal(h.requested.length,0,'managed reservations never start a native original download');
});

test('managed reserve and settlement reject stale owners, batches and attempts without changing the ledger',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const saved=await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}});
  const batchId=saved.data.batch.id,jobId=saved.data.jobs[0].id;
  assert.equal((await h.send({type:'managed-reserve',batchId,jobId})).ok,true);
  const ledger=structuredClone(h.store.get('workspace:work').batch.transferBudget);
  for(const type of ['managed-reserve','managed-settle'])for(const wrong of [{instance:'old-owner'},{batchId:'old-batch'},{jobId:'old-attempt'}]) {
    const response=await h.send({type,batchId,jobId,bytesReceived:1,outcome:'interrupted',outputBytes:0,...wrong});
    assert.equal(response.ok,false);assert.deepEqual(h.store.get('workspace:work').batch.transferBudget,ledger);
  }
});

test('managed source settlement still accounts bytes after Chrome has already completed the converted download',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const job=state.jobs[0];
  const reserved=await h.send({type:'managed-reserve',batchId:state.batch.id,jobId:job.id});
  assert.equal(reserved.ok,true,reserved.error);assert.equal(reserved.data.jobs[0].transfer.maxBytes,MEDIA_LIMITS.converter.maxInputBytes);
  const accepted=await beginConverted(h,reserved.data);
  const downloadId=accepted.data.jobs[0].downloadId;h.complete(downloadId);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status==='complete','Chrome completed first');
  const settled=await h.send({type:'managed-settle',batchId:state.batch.id,jobId:job.id,bytesReceived:11,outcome:'complete',outputBytes:23});
  assert.equal(settled.ok,true,settled.error);assert.equal(settled.data.jobs[0].status,'complete');
  assert.equal(settled.data.batch.transferBudget.consumedBytes,11);
  assert.equal(settled.data.batch.transferBudget.outputBytes,23);assert.equal(settled.data.batch.transferBudget.reservedBytes,0);
  const twice=await h.send({type:'managed-settle',batchId:state.batch.id,jobId:job.id,bytesReceived:11,outcome:'complete',outputBytes:23});
  assert.equal(twice.data.batch.transferBudget.consumedBytes,11);assert.equal(twice.data.batch.transferBudget.outputBytes,23);
  assert.equal(h.requested.length,1);
});

test('a lost terminal report after complete settlement monotonically blocks retry of the committed directory file',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  const batchId=state.batch.id,jobId=state.jobs[0].id;
  await h.send({type:'managed-reserve',batchId,jobId});
  await h.send({type:'managed-settle',batchId,jobId,bytesReceived:3,outcome:'complete',outputBytes:3});
  const uncertain=await h.send({type:'managed-settle',batchId,jobId,bytesReceived:3,outcome:'unknown',outputUnknown:true});
  assert.equal(uncertain.ok,true,uncertain.error);assert.equal(uncertain.data.jobs[0].outcomeUnknown,true);
  assert.equal(uncertain.data.jobs[0].status,'interrupted');
  assert.equal(uncertain.data.batch.transferBudget.consumedBytes,3);assert.equal(uncertain.data.batch.transferBudget.outputBytes,3);
  assert.equal(uncertain.data.batch.transferBudget.attempts[jobId].status,'complete','known accounting remains committed');
  const later=await h.send({type:'managed-settle',batchId,jobId,bytesReceived:3,outcome:'complete',outputBytes:3});
  assert.equal(later.data.jobs[0].outcomeUnknown,true,'a repeated known notification cannot erase uncertainty');
  await h.send({type:'managed-update',batchId,updates:[{id:jobId,status:'interrupted'}]});
  assert.equal((await h.send({type:'retry'})).ok,false);
});

test('a complete directory terminal record stays complete after a later unknown acknowledgement',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  const batchId=state.batch.id,jobId=state.jobs[0].id;
  await h.send({type:'managed-reserve',batchId,jobId});
  await h.send({type:'managed-settle',batchId,jobId,bytesReceived:3,outcome:'complete',outputBytes:3});
  await h.send({type:'managed-update',batchId,updates:[{id:jobId,status:'complete',bytesReceived:3}]});
  const unknown=await h.send({type:'managed-settle',batchId,jobId,outcome:'unknown'});
  assert.equal(unknown.data.jobs[0].status,'complete');assert.equal(unknown.data.jobs[0].outcomeUnknown,true);
  await h.send({type:'managed-update',batchId,updates:[{id:jobId,status:'interrupted'}]});
  const retry=await h.send({type:'retry'});
  assert.equal(retry.data.jobs[0].status,'complete');assert.equal(retry.data.jobs[0].id,jobId);
});

test('managed retry retains logical identity, consumed bytes and batch deadline and stops after three real attempts',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  let state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  state.batch.transferBudget=createTransferBudget({now:Date.now(),maxBytes:1000,timeoutMs:10000});
  h.store.set('workspace:work',structuredClone(state));
  const deadline=state.batch.transferBudget.deadline,logicalJobId=state.jobs[0].logicalJobId;
  const ids=[];
  for(let index=0;index<3;index++) {
    const jobId=state.jobs[0].id;ids.push(jobId);
    const reserved=await h.send({type:'managed-reserve',batchId:state.batch.id,jobId});
    assert.equal(reserved.ok,true,reserved.error);assert.equal(reserved.data.jobs[0].transfer.maxBytes,1000-index*10);
    const settled=await h.send({type:'managed-settle',batchId:state.batch.id,jobId,bytesReceived:10,outcome:'interrupted'});
    assert.equal(settled.ok,true,settled.error);
    await h.send({type:'managed-update',batchId:state.batch.id,updates:[{id:jobId,status:'interrupted'}]});
    if(index<2) {
      await h.restartWorker();const retry=await h.send({type:'retry'});
      assert.equal(retry.ok,true,retry.error);state=retry.data;
      assert.equal(state.jobs[0].logicalJobId,logicalJobId);assert.equal(state.jobs[0].transfer,undefined);
      assert.equal(state.batch.transferBudget.deadline,deadline);assert.equal(state.batch.transferBudget.consumedBytes,(index+1)*10);
    }
  }
  assert.equal(new Set(ids).size,3);
  const refused=await h.send({type:'retry'});assert.equal(refused.ok,false);assert.match(refused.error,/回数/);
  assert.equal(h.store.get('workspace:work').batch.transferBudget.logicalAttempts[logicalJobId],3);
});

test('retry and idempotent reserve cannot renew an expired absolute batch or attempt deadline',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  const jobId=state.jobs[0].id,batchId=state.batch.id;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId});
  const deadline=reserved.data.jobs[0].transfer.deadline;
  t.mock.method(Date,'now',()=>deadline+1);
  assert.equal((await h.send({type:'managed-reserve',batchId,jobId})).ok,false);
  await h.send({type:'managed-settle',batchId,jobId,bytesReceived:1,outcome:'interrupted'});
  await h.send({type:'managed-update',batchId,updates:[{id:jobId,status:'interrupted'}]});
  Date.now.mock.mockImplementation(()=>state.batch.transferBudget.deadline+1);
  const retry=await h.send({type:'retry'});assert.equal(retry.ok,false);assert.match(retry.error,/制限時間/);
  assert.equal(h.store.get('workspace:work').batch.transferBudget.deadline,state.batch.transferBudget.deadline);
});

test('reload conservatively charges an abandoned directory reservation and blocks uncertain-file retry',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  const jobId=state.jobs[0].id,batchId=state.batch.id;
  const reservation=await h.send({type:'managed-reserve',batchId,jobId});
  const before=reservation.data.batch.transferBudget;
  const reloaded=await h.send({type:'hello',instance:'new-owner'});
  assert.equal(reloaded.ok,true,reloaded.error);assert.equal(reloaded.data.jobs[0].status,'interrupted');
  assert.equal(reloaded.data.jobs[0].outcomeUnknown,true);
  assert.equal(reloaded.data.batch.transferBudget.consumedBytes,before.reservedBytes);
  assert.equal(reloaded.data.batch.transferBudget.reservedBytes,0);
  assert.equal(reloaded.data.batch.transferBudget.deadline,before.deadline);
  assert.equal((await h.send({type:'retry',instance:'new-owner'})).ok,false);
  assert.equal((await h.send({type:'managed-settle',batchId,jobId,bytesReceived:0,outcome:'interrupted'})).ok,false,'departed owner cannot refund');
  const same=await h.send({type:'managed-settle',batchId,jobId,instance:'new-owner',bytesReceived:0,outcome:'interrupted'});
  assert.equal(same.data.batch.transferBudget.consumedBytes,before.reservedBytes,'a late known claim cannot refund an already unknown result');
});

test('abandoned converter source is fully charged while a known Chrome outcome remains authoritative',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const jobId=state.jobs[0].id,batchId=state.batch.id;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId});
  const accepted=await beginConverted(h,reserved.data);const id=accepted.data.jobs[0].downloadId;
  h.chrome.downloads.cancel=async()=>{throw new Error('still pending');};
  const reload=await h.send({type:'hello',instance:'new-owner'});
  assert.equal(reload.data.jobs[0].status,'in_progress');assert.equal(reload.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
  assert.equal((await h.send({type:'retry',instance:'new-owner'})).ok,false);
  h.complete(id);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status==='complete','real Chrome terminal state observed');
  const stored=h.store.get('workspace:work');
  assert.equal(stored.batch.transferBudget.attempts[jobId].status,'complete');
  assert.equal(stored.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
  assert.equal(stored.jobs[0].outcomeUnknown,undefined);
  assert.equal((await h.send({type:'retry',instance:'new-owner'})).ok,true);
});

test('unknown managed settlement cannot turn an active Chrome download into an interrupted retry or new batch',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const jobId=state.jobs[0].id,batchId=state.batch.id;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId});
  const accepted=await beginConverted(h,reserved.data);const id=accepted.data.jobs[0].downloadId;
  const unknown=await h.send({type:'managed-settle',batchId,jobId,bytesReceived:10,outcome:'unknown',outputBytes:20});
  assert.equal(unknown.ok,true,unknown.error);assert.equal(unknown.data.jobs[0].status,'in_progress');
  assert.equal(unknown.data.jobs[0].downloadId,id);assert.equal(unknown.data.jobs[0].outcomeUnknown,true);
  assert.equal(unknown.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
  assert.equal((await h.send({type:'retry'})).ok,false);
  assert.equal((await h.send({type:'save',urls:[state.jobs[0].url]})).ok,false);
  h.complete(id);
  await eventually(()=>h.store.get('workspace:work').jobs[0].status==='complete','actual terminal Chrome event arrives');
  const stored=h.store.get('workspace:work');
  assert.equal(stored.jobs[0].outcomeUnknown,undefined);assert.equal(stored.batch.transferBudget.attempts[jobId].status,'complete');
  assert.equal(stored.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
  assert.equal(stored.batch.transferBudget.outputBytes,MEDIA_LIMITS.converter.maxOutputBytes);
});

test('missing Chrome history cannot resolve unknown usage, and a later real terminal result still recovers',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const jobId=state.jobs[0].id,batchId=state.batch.id;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId});
  const accepted=await beginConverted(h,reserved.data);const id=accepted.data.jobs[0].downloadId;
  await h.send({type:'managed-settle',batchId,jobId,bytesReceived:1,outcome:'unknown'});
  const item=structuredClone(h.downloads.get(id));h.downloads.delete(id);
  const absent=await h.send({type:'get'});
  assert.equal(absent.data.jobs[0].status,'in_progress');assert.equal(absent.data.jobs[0].outcomeUnknown,true);
  assert.equal(absent.data.batch.transferBudget.attempts[jobId].status,'unknown');
  assert.equal((await h.send({type:'retry'})).ok,false);
  h.downloads.set(id,{...item,state:'interrupted',error:'USER_CANCELED'});
  const terminal=await h.send({type:'get'});
  assert.equal(terminal.data.jobs[0].status,'interrupted');assert.equal(terminal.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(terminal.data.batch.transferBudget.attempts[jobId].status,'interrupted');
  await h.send({type:'cancel'}); // Stop the separate, still-queued second image.
  assert.equal((await h.send({type:'retry'})).ok,true);
});

test('managed accepted Chrome history stays unresolved even when source accounting was previously known',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const batchId=state.batch.id,jobId=state.jobs[0].id;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId});
  const accepted=await beginConverted(h,reserved.data);const id=accepted.data.jobs[0].downloadId;
  await h.send({type:'managed-settle',batchId,jobId,bytesReceived:3,outcome:'complete',outputBytes:20});
  const actual=structuredClone(h.downloads.get(id));h.downloads.delete(id);
  const missing=await h.send({type:'get'});
  assert.equal(missing.data.jobs[0].status,'in_progress');assert.equal(missing.data.jobs[0].downloadId,id);
  assert.equal(missing.data.jobs[0].outcomeUnknown,true);assert.equal(missing.data.jobs[0].chromeOutcomeKnown,undefined);
  assert.equal((await h.send({type:'retry'})).ok,false);
  assert.equal((await h.send({type:'save',urls:[state.jobs[0].url]})).ok,false);
  await h.restartWorker();const restored=await h.send({type:'get'});
  assert.equal(restored.data.jobs[0].status,'in_progress');assert.equal(restored.data.jobs[0].outcomeUnknown,true);
  h.downloads.set(id,{...actual,state:'complete',bytesReceived:20,totalBytes:20});
  const completed=await h.send({type:'get'});
  assert.equal(completed.data.jobs[0].status,'complete');assert.equal(completed.data.jobs[0].chromeOutcomeKnown,true);
  assert.equal(completed.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(completed.data.batch.transferBudget.consumedBytes,3);assert.equal(completed.data.batch.transferBudget.outputBytes,20);
});

test('expired managed Chrome acceptance retains matching evidence and Blob ownership until a real terminal match',async t=>{
  const h=await browser(t,{withAlarms:true});const state=await convertedBatch(h);
  const batchId=state.batch.id,jobId=state.jobs[0].id;
  await h.send({type:'managed-reserve',batchId,jobId});
  const stored=h.store.get('workspace:work');const startedAt=Date.now()-31000;
  const submission={url:'blob:chrome-extension://test/unresolved',filename:stored.jobs[0].filename,startedAt};
  stored.jobs[0].submission=submission;stored.jobs[0].status='in_progress';h.store.set('workspace:work',stored);
  const expired=await h.send({type:'get'});
  assert.equal(expired.data.jobs[0].status,'in_progress');assert.equal(expired.data.jobs[0].outcomeUnknown,true);
  assert.deepEqual(expired.data.jobs[0].submission,submission);
  assert.ok(h.alarms.has('imagecrate-pending-downloads'));
  assert.equal((await h.send({type:'retry'})).ok,false);
  await h.restartWorker();const resumed=await h.send({type:'get'});
  assert.equal(resumed.data.jobs[0].status,'in_progress');assert.deepEqual(resumed.data.jobs[0].submission,submission);
  h.downloads.set(90,{id:90,url:submission.url,filename:submission.filename,byExtensionId:'test',
    startTime:new Date(startedAt+1).toISOString(),state:'complete',bytesReceived:20,totalBytes:20,mime:'image/jpeg'});
  const completed=await h.send({type:'get'});
  assert.equal(completed.data.jobs[0].downloadId,90);assert.equal(completed.data.jobs[0].status,'complete');
  assert.equal(completed.data.jobs[0].chromeOutcomeKnown,true);assert.equal(completed.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(completed.data.jobs[0].submission,undefined);assert.equal(h.requested.length,0);
});

test('an older interrupted managed Chrome ID without terminal proof is normalized before returning a workspace snapshot',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const accepted=await beginConverted(h,state);const id=accepted.data.jobs[0].downloadId;
  const actual=structuredClone(h.downloads.get(id));h.downloads.delete(id);
  const stored=h.store.get('workspace:work');
  stored.jobs[0].status='interrupted';delete stored.jobs[0].chromeOutcomeKnown;delete stored.jobs[0].outcomeUnknown;
  h.store.set('workspace:work',stored);
  const resumed=await h.send({type:'get'});
  assert.equal(resumed.data.jobs[0].status,'in_progress');assert.equal(resumed.data.jobs[0].outcomeUnknown,true);
  assert.equal(resumed.data.jobs[0].downloadId,id);assert.equal((await h.send({type:'retry'})).ok,false);
  assert.equal((await h.send({type:'save',urls:[state.jobs[0].url]})).ok,false);
  h.downloads.set(id,{...actual,state:'interrupted',error:'USER_CANCELED'});
  const terminal=await h.send({type:'get'});
  assert.equal(terminal.data.jobs[0].status,'interrupted');assert.equal(terminal.data.jobs[0].chromeOutcomeKnown,true);
  assert.equal(terminal.data.jobs[0].outcomeUnknown,undefined);
});

test('reload before converter Chrome acceptance preserves the full source charge but allows a safe new attempt',async t=>{
  const h=await browser(t);const state=await convertedBatch(h);
  const jobId=state.jobs[0].id,batchId=state.batch.id;
  await h.send({type:'managed-reserve',batchId,jobId});
  const hello=await h.send({type:'hello',instance:'new-owner'});
  assert.equal(hello.data.jobs[0].status,'interrupted');assert.equal(hello.data.jobs[0].outcomeUnknown,undefined);
  assert.equal(hello.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
  const retry=await h.send({type:'retry',instance:'new-owner'});
  assert.equal(retry.ok,true,retry.error);assert.notEqual(retry.data.jobs[0].id,jobId);
  assert.equal(retry.data.jobs[0].logicalJobId,state.jobs[0].logicalJobId);
  const next=await h.send({type:'managed-reserve',instance:'new-owner',batchId,jobId:retry.data.jobs[0].id});
  assert.equal(next.ok,true,next.error);
  assert.equal(next.data.batch.transferBudget.logicalAttempts[state.jobs[0].logicalJobId],2);
  assert.equal(next.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
});

test('legacy active managed batches are interrupted and cannot resume without a versioned transfer ledger',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  delete state.batch.transferBudget;state.jobs[0].status='in_progress';h.store.set('workspace:work',state);
  const hello=await h.send({type:'hello'});
  assert.equal(hello.ok,true,hello.error);assert.equal(hello.data.jobs[0].status,'interrupted');
  assert.equal(hello.data.batch.transferPolicyLegacy,true);assert.equal(hello.data.jobs[0].outcomeUnknown,true);
  assert.equal((await h.send({type:'retry'})).ok,false);
  assert.equal((await h.send({type:'managed-reserve',batchId:state.batch.id,jobId:state.jobs[0].id})).ok,false);
});

test('small converter inputs cannot bypass the independent cumulative output allowance',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls,settings:{destination:'directory',directoryName:'Pictures',format:'png'}})).data;
  state.batch.transferBudget=createTransferBudget({now:Date.now(),maxBytes:1000,maxOutputBytes:100});
  h.store.set('workspace:work',structuredClone(state));
  const batchId=state.batch.id;
  for(const [index,outputBytes] of [80,20].entries()) {
    const jobId=state.jobs[index].id;
    const reserved=await h.send({type:'managed-reserve',batchId,jobId});
    assert.equal(reserved.ok,true,reserved.error);
    assert.equal(reserved.data.jobs[index].transfer.maxOutputBytes,index===0?100:20);
    assert.equal(reserved.data.batch.transferBudget.reservedOutputBytes,index===0?100:20);
    const settled=await h.send({type:'managed-settle',batchId,jobId,bytesReceived:1,outcome:'interrupted',outputBytes});
    assert.equal(settled.ok,true,settled.error);
    await h.send({type:'managed-update',batchId,updates:[{id:jobId,status:'interrupted'}]});
  }
  const ledger=h.store.get('workspace:work').batch.transferBudget;
  assert.equal(ledger.consumedBytes,2);assert.equal(ledger.outputBytes,100);assert.equal(ledger.reservedOutputBytes,0);
  const retry=await h.send({type:'retry'});assert.equal(retry.ok,false);assert.match(retry.error,/出力容量/);
});

test('original managed input limit also fits the output remainder and failure before write releases output',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures'}})).data;
  state.batch.transferBudget=createTransferBudget({now:Date.now(),maxBytes:1000,maxOutputBytes:3});
  h.store.set('workspace:work',structuredClone(state));
  const batchId=state.batch.id,jobId=state.jobs[0].id;
  const reserved=await h.send({type:'managed-reserve',batchId,jobId});
  assert.equal(reserved.data.jobs[0].transfer.maxBytes,3);assert.equal(reserved.data.jobs[0].transfer.maxOutputBytes,3);
  const settled=await h.send({type:'managed-settle',batchId,jobId,bytesReceived:2,outcome:'interrupted',outputBytes:0});
  assert.equal(settled.data.batch.transferBudget.outputBytes,0);assert.equal(settled.data.batch.transferBudget.reservedOutputBytes,0);
});

test('unknown committed output is charged conservatively and source-only unknown recovery does not charge nonexistent output',async t=>{
  const h=await browser(t);const urls=imageItems(h);
  const state=(await h.send({type:'save',urls:[urls[0]],settings:{destination:'directory',directoryName:'Pictures',format:'png'}})).data;
  state.batch.transferBudget=createTransferBudget({now:Date.now(),maxBytes:1000,maxOutputBytes:100});
  h.store.set('workspace:work',structuredClone(state));
  const batchId=state.batch.id,jobId=state.jobs[0].id;
  await h.send({type:'managed-reserve',batchId,jobId});
  const unknown=await h.send({type:'managed-settle',batchId,jobId,bytesReceived:2,outcome:'unknown',outputUnknown:true});
  assert.equal(unknown.data.batch.transferBudget.outputBytes,100);
  assert.equal(unknown.data.batch.transferBudget.reservedOutputBytes,0);assert.equal(unknown.data.jobs[0].outcomeUnknown,true);
  const converted=await h.send({type:'save',urls:[urls[0]],settings:{destination:'downloads',format:'png'}});
  const next=converted.data;
  await h.send({type:'managed-reserve',batchId:next.batch.id,jobId:next.jobs[0].id});
  const reloaded=await h.send({type:'hello',instance:'new-owner'});
  assert.equal(reloaded.data.batch.transferBudget.consumedBytes,MEDIA_LIMITS.converter.maxInputBytes);
  assert.equal(reloaded.data.batch.transferBudget.outputBytes,0,'no Blob was accepted by Chrome before reload');
  assert.equal(reloaded.data.batch.transferBudget.reservedOutputBytes,0);
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
  return {id,url:source.url,filename:`/Downloads/${source.filename.replace(/\.img$/,'.png')}`,byExtensionId:'test',startTime:new Date(Math.min(source.startedAt+1,Date.now())).toISOString(),state:'in_progress',mime:'image/png',bytesReceived:1,totalBytes:10,...patch};
}

test('legacy expired native acceptance remains unknown after restart and cannot authorize a duplicate retry',async t=>{
  const h=await browser(t);const source=pendingSubmission(h,60000);
  await h.restartWorker();
  const restored=await h.send({type:'get'});
  assert.equal(restored.ok,true,restored.error);
  assert.equal(restored.data.jobs[0].status,'in_progress');
  assert.equal(restored.data.jobs[0].outcomeUnknown,true);
  assert.ok(restored.data.jobs[0].submission);
  assert.deepEqual(restored.data.selectedURLs,[source.url]);
  assert.deepEqual(h.requested,[],'uncertain acceptance never starts another download automatically');
  const retry=await h.send({type:'retry'});
  assert.equal(retry.ok,false);assert.equal(h.requested.length,0);
});

test('native cancel preserves unknown acceptance beyond the reconciliation deadline instead of claiming it absent',async t=>{
  const h=await browser(t);pendingSubmission(h);
  const waiting=await h.send({type:'cancel'});
  assert.equal(waiting.ok,true,waiting.error);
  assert.equal(waiting.data.jobs[0].status,'in_progress');
  assert.match(waiting.data.jobs[0].error,/30秒/);
  const state=h.store.get('workspace:work');state.jobs[0].submission.startedAt=Date.now()-31000;h.store.set('workspace:work',state);
  const expired=await h.send({type:'cancel'});
  assert.equal(expired.data.jobs[0].status,'in_progress');assert.equal(expired.data.jobs[0].outcomeUnknown,true);
  assert.ok(expired.data.jobs[0].submission);
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

test('ambiguous native submission candidates stay unresolved after the deadline and no existing download is cancelled',async t=>{
  const h=await browser(t);const source=pendingSubmission(h);
  h.downloads.set(31,acceptedSubmission(source,31));
  h.downloads.set(32,acceptedSubmission(source,32,{filename:'/Downloads/ImageCrate/Frozen/001_pending (1).png'}));
  const unresolved=await h.send({type:'get'});
  assert.equal(unresolved.data.jobs[0].downloadId,undefined);
  assert.equal(unresolved.data.jobs[0].status,'in_progress');
  const state=h.store.get('workspace:work');state.jobs[0].submission.startedAt-=31000;h.store.set('workspace:work',state);
  const expired=await h.send({type:'get'});
  assert.equal(expired.data.jobs[0].status,'in_progress');assert.equal(expired.data.jobs[0].outcomeUnknown,true);
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
  await eventually(()=>h.store.get('workspace:work').jobs[0].outcomeUnknown===true,'the alarm records unknown acceptance without discarding evidence');
  assert.ok(h.alarms.has(alarm.name),'unconfirmed native acceptance keeps its recovery alarm');
  assert.deepEqual(h.requested,[]);
  assert.deepEqual(h.cancelled,[]);
});

test('worker startup keeps a closed unknown native submission and its alarm without authorizing a resend',async t=>{
  const h=await browser(t,{withAlarms:true});pendingSubmission(h);
  await h.restartWorker();
  await eventually(()=>h.alarms.size === 1,'startup schedules the pending reconciliation even without get/polling');
  const state=h.store.get('workspace:work');state.closed=true;state.jobs[0].submission.startedAt=Date.now()-31000;h.store.set('workspace:work',state);
  h.tabs.delete(100);
  await h.restartWorker();
  await eventually(()=>h.store.get('workspace:work').jobs[0].outcomeUnknown===true,'startup preserves the expired closed submission as unknown');
  assert.equal(h.alarms.size,1,'unknown acceptance remains recoverable');
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
  await eventually(()=>h.store.get('workspace:work').jobs[0].outcomeUnknown===true,'an unrelated event reconciles the pending submission without deleting unknown evidence');
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

test('legacy Stop cancels a late accepted ID but unversioned retry requires a new explicit batch',async t=>{
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
  assert.equal(retried.ok,false);assert.equal(h.requested.length,0);
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
