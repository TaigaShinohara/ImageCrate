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

async function browser(t) {
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
  const removed = event();
  const messages = event();
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const chrome = {
    runtime: { id: 'test', getURL: (path) => `chrome-extension://test/${path}`, onMessage: messages },
    action: { onClicked: event(), setBadgeText: async () => {}, setTitle: async () => {} },
    storage: { session: {
      async get(key) {
        if (key === null) return Object.fromEntries([...store].map(([name, value]) => [name, clone(value)]));
        return { [key]: clone(store.get(key)) };
      },
      async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, clone(value)); },
      async remove(key) { store.delete(key); },
    } },
    tabs: { onRemoved: removed,
      async get(id) { if (!tabs.has(id)) throw new Error('No such tab'); return clone(tabs.get(id)); },
      async update(id, values) { Object.assign(tabs.get(id), values); return clone(tabs.get(id)); },
    },
    downloads: { onChanged: changed,
      async download(options) {
        const id = nextDownloadId++;
        requested.push({ ...options, id });
        downloads.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: -1, mime: 'video/mp4' });
        return id;
      },
      async search({ id }) { return downloads.has(id) ? [clone(downloads.get(id))] : []; },
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
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chrome });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else delete globalThis.chrome;
  });
  // Each test gets a new worker module and independent event registrations/storage.
  await import(`${new URL('../extension/background.js', import.meta.url).href}?test=${moduleNumber++}`);
  const state = {
    id: 'work', tabId: 1, workspaceTabId: 100, url: 'https://source.test/', title: 'Source',
    items: [], notices: [], scanned: true, jobs: [],
  };
  const persist = () => store.set('workspace:work', clone(state));
  persist();
  return {
    state, store, tabs, downloads, requested, cancelled, persist,
    async restartWorker() {
      changed.clear();removed.clear();messages.clear();
      await import(`${new URL('../extension/background.js', import.meta.url).href}?test=${moduleNumber++}`);
    },
    closeWorkspace() { tabs.delete(100); removed.emit(100); },
    complete(id) {
      Object.assign(downloads.get(id), { state: 'complete', bytesReceived: 10, totalBytes: 10 });
      changed.emit({ id, state: { current: 'complete' } });
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Background did not respond')), 1000);
        messages.emit({ sessionId: 'work', instance: 'current-page', ...message },
          { id: 'test', url: 'chrome-extension://test/workspace.html?id=work', tab: { id: 100 } },
          (response) => { clearTimeout(timeout); resolve(response); });
      });
    },
  };
}

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
