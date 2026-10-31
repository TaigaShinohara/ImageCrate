import test from 'node:test';
import assert from 'node:assert/strict';

let fixtureNumber = 0;
async function fixture(initial = {}) {
  const records = new Map(Object.entries(initial));
  const control = {failWriteKey:null};
  const db = {close() {}, transaction(_name, mode) {
    const draft = new Map(records);
    let pending = 0; let aborted = false;
    const transaction = {objectStore:() => store};
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
