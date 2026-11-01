import test from 'node:test';
import assert from 'node:assert/strict';

let fixtureNumber = 0;
async function fixture(initial = {}) {
  const records = new Map(Object.entries(initial));
  const control = {failWriteKey:null};
  const db = {close() {}, transaction(_name, mode) {
    const draft = new Map(records);
    let pending = 0; let aborted = false;
    const transaction = {objectStore:() => store,abort() { aborted=true;queueMicrotask(()=>transaction.onabort?.()); }};
    const finish = () => {
      if (!pending && !aborted) {
        if (mode === 'readwrite') { records.clear(); for (const [key,value] of draft) records.set(key,value); }
        transaction.oncomplete?.();
      }
    };
    const operation = run => {
      const request = {}; pending++;
      queueMicrotask(() => {
        if (aborted) return;
        try { request.result = run(); request.onsuccess?.(); pending--; finish(); }
        catch { aborted = true; transaction.onabort?.(); }
      });
      return request;
    };
    const store = {
      get:key => operation(() => draft.get(key)),
      put:(value,key) => operation(() => {
        if (control.failWriteKey === key) throw new Error('storage failure');
        draft.set(key,value); return key;
      }),
      delete:key => operation(() => draft.delete(key)),
      openKeyCursor() {
        const request = {}; const keys = [...draft.keys()]; let index = 0; pending++;
        const next = () => queueMicrotask(() => {
          if (aborted) return;
          request.result = index < keys.length ? {key:keys[index++], continue:next} : null;
          request.onsuccess?.();
          if (!request.result) { pending--; finish(); }
        });
        next(); return request;
      }
    };
    return transaction;
  }};
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = {open() {
    const request = {};
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  }};
  const store = await import(`../extension/directory-store.js?fixture=${fixtureNumber++}`);
  // Open while this fixture owns indexedDB; the module then retains that DB.
  await store.getDirectory('initialize');
  globalThis.indexedDB = previous;
  return {records,control,...store};
}

test('last destination reads legacy handle data without writing a migration', async () => {
  const handle = {name:'Legacy directory'};
  const h = await fixture({last:handle});
  assert.deepEqual(await h.getLastDestination(), {handle,destination:'directory'});
  assert.equal(h.records.has('last-destination'), false);
  assert.equal(await h.getDirectory('last'), handle);
  assert.equal(await (await fixture()).getLastDestination(), null);
  assert.deepEqual(await h.getRememberDestination(), {remember:true,revision:0});
  assert.equal(h.records.has('remember-destination'), false);
});

test('remembered destination contains only its mode and handle, retaining a directory in downloads mode', async () => {
  const handle = {name:'Chosen directory'};
  const h = await fixture();
  await h.putLastDestination({handle,destination:'downloads',format:'webp',folderName:'Page-specific name'});
  assert.deepEqual(await h.getLastDestination(), {handle,destination:'downloads'});
  assert.deepEqual(h.records.get('last-destination'), {handle,destination:'downloads'});
  assert.equal(await h.getDirectory('last'), handle);
  await h.putLastDestination({destination:'downloads'});
  assert.deepEqual(await h.getLastDestination(), {handle:null,destination:'downloads'});
  assert.equal(await h.getDirectory('last'), null);
});

test('a failed destination commit preserves both prior mode and legacy handle', async () => {
  const oldHandle = {name:'Applied directory'}; const newHandle = {name:'Draft directory'};
  const h = await fixture();
  await h.putLastDestination({handle:oldHandle,destination:'directory'});
  h.control.failWriteKey = 'last-destination';
  await assert.rejects(h.putLastDestination({handle:newHandle,destination:'downloads'}), /記録できません/);
  assert.deepEqual(await h.getLastDestination(), {handle:oldHandle,destination:'directory'});
  assert.equal(await h.getDirectory('last'), oldHandle);
  await assert.rejects(h.putLastDestination({destination:'directory'}), /不正/);
  assert.deepEqual(await h.getLastDestination(), {handle:oldHandle,destination:'directory'});
});

test('pruning removes expired session and batch handles while keeping the remembered selection', async () => {
  const handle = {name:'Remembered directory'}; const h = await fixture();
  await h.putLastDestination({handle,destination:'downloads'});
  for (const key of ['session:keep','session:expired','batch:expired','unrelated']) await h.putDirectory(key,handle);
  await h.pruneDirectories(['session:keep']);
  assert.deepEqual([...h.records.keys()].sort(), ['last','last-destination','session:keep','unrelated']);
  assert.deepEqual(await h.getLastDestination(), {handle,destination:'downloads'});
});

test('OFF atomically forgets only next-use memo and remains OFF through ordinary settings applies', async () => {
  const handle={name:'Active directory'}, other={name:'Other directory'};
  const h=await fixture();
  await h.putLastDestination({handle,destination:'directory'});
  await h.putDirectory('session:active',handle);await h.putDirectory('batch:pending',handle);
  assert.deepEqual(await h.putLastDestination({handle,destination:'directory'},{remember:false,expectedRevision:0}), {remember:false,revision:1});
  assert.equal(await h.getLastDestination(),null);
  assert.equal(h.records.has('last'),false);assert.equal(h.records.has('last-destination'),false);
  assert.equal(await h.getDirectory('session:active'),handle);assert.equal(await h.getDirectory('batch:pending'),handle);
  // A pre-policy/older tab could leave a legacy value. Reads must not use it,
  // and applying a format/location from a stale tab must not turn OFF back on.
  await h.putDirectory('last',other);await h.putDirectory('last-destination',{handle:other,destination:'directory'});
  assert.equal(await h.getLastDestination(),null);
  assert.deepEqual(await h.putLastDestination({handle:other,destination:'directory'}),{remember:false,revision:1});
  assert.equal(h.records.has('last'),false);assert.equal(h.records.has('last-destination'),false);
  await h.pruneDirectories(['session:active','batch:pending']);
  assert.deepEqual(await h.getRememberDestination(),{remember:false,revision:1});
  assert.equal(await h.getDirectory('session:active'),handle);assert.equal(await h.getDirectory('batch:pending'),handle);
});

test('explicit policy changes require the latest revision and ON can remember again', async () => {
  const handle={name:'Chosen directory'}, stale={name:'Stale draft'};
  const h=await fixture();await h.putLastDestination({handle,destination:'directory'},{remember:false,expectedRevision:0});
  await assert.rejects(h.putLastDestination({handle:stale,destination:'directory'},{remember:true,expectedRevision:0}),/別の作業で変更/);
  assert.deepEqual(await h.getRememberDestination(),{remember:false,revision:1});assert.equal(await h.getLastDestination(),null);
  assert.deepEqual(await h.putLastDestination({handle,destination:'directory'},{remember:true,expectedRevision:1}),{remember:true,revision:2});
  assert.deepEqual(await h.getLastDestination(),{handle,destination:'directory'});
});

test('failed OFF and ON transactions preserve policy and both memo entries', async () => {
  const handle={name:'Applied directory'};const h=await fixture();await h.putLastDestination({handle,destination:'directory'});
  h.control.failWriteKey='remember-destination';
  await assert.rejects(h.putLastDestination({handle,destination:'directory'},{remember:false,expectedRevision:0}),/記録できません/);
  assert.deepEqual(await h.getRememberDestination(),{remember:true,revision:0});
  assert.deepEqual(await h.getLastDestination(),{handle,destination:'directory'});assert.equal(await h.getDirectory('last'),handle);
  h.control.failWriteKey=null;await h.putLastDestination({handle,destination:'directory'},{remember:false,expectedRevision:0});
  h.control.failWriteKey='last-destination';
  await assert.rejects(h.putLastDestination({handle,destination:'directory'},{remember:true,expectedRevision:1}),/記録できません/);
  assert.deepEqual(await h.getRememberDestination(),{remember:false,revision:1});assert.equal(await h.getLastDestination(),null);
  assert.equal(h.records.has('last'),false);assert.equal(h.records.has('last-destination'),false);
});

test('malformed existing policy fails without remembering a destination', async () => {
  const handle={name:'Directory'},h=await fixture({'remember-destination':{remember:'false',revision:1}});
  await assert.rejects(h.getRememberDestination(),/読み込めません/);
  await assert.rejects(h.getLastDestination(),/読み込めません/);
  await assert.rejects(h.putLastDestination({handle,destination:'directory'}),/読み込めません/);
  assert.equal(h.records.has('last'),false);assert.equal(h.records.has('last-destination'),false);
});
