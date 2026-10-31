import test from 'node:test';
import assert from 'node:assert/strict';
import {writeImage,writeBlob} from '../extension/directory-writer.js';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const missing = () => new DOMException('missing', 'NotFoundError');
function directoryFixture({existing = {}, onWrite, onClose, onAbort} = {}) {
  const entries = new Map(Object.entries(existing).map(([name, data]) => [name, {data:Uint8Array.from(data)}]));
  const events = [];
  const directory = {
    name:'Selected folder',
    async getFileHandle(name, {create = false} = {}) {
      if (!entries.has(name)) {
        if (!create) throw missing();
        entries.set(name, {data:new Uint8Array()}); events.push(['create', name]);
      }
      const entry = entries.get(name);
      if (entry.directory) throw new DOMException('directory', 'TypeMismatchError');
      return {
        entry,
        async isSameEntry(other) { return entry === other.entry; },
        async getFile() { return {size:entry.data.length}; },
        async createWritable() {
          events.push(['open', name]);
          const chunks = [];
          return {
            async write(chunk) { await onWrite?.(chunk, name); chunks.push(Uint8Array.from(chunk)); events.push(['write', name]); },
            async close() {
              await onClose?.(name);
              entry.data = Uint8Array.from(chunks.flatMap(chunk => [...chunk]));
              events.push(['close', name]);
            },
            async abort() { await onAbort?.(name); events.push(['abort', name]); }
          };
        }
      };
    },
    async removeEntry(name) { entries.delete(name); events.push(['remove', name]); }
  };
  return {directory, entries, events};
}
const image = (body = Uint8Array.from([1, 2, 3]), extra = {}) => new Response(body, {
  headers:{'content-type':'image/png', 'content-length':'3'}, ...extra
});

test('converted blobs use the same nonoverwriting writer without a network request', async t => {
  const h=directoryFixture({existing:{'photo.webp':[9]}});
  let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('unexpected fetch');});
  const result=await writeBlob(h.directory,'photo.webp',new Blob([new Uint8Array([3,2,1])],{type:'image/webp'}));
  assert.equal(requests,0);assert.equal(result.filename,'photo (1).webp');
  assert.deepEqual([...h.entries.get('photo.webp').data],[9]);
  assert.deepEqual([...h.entries.get('photo (1).webp').data],[3,2,1]);
  assert.throws(()=>writeBlob(h.directory,'empty.png',new Blob()),/データがありません/);
});

test('directory writes choose a new name and never open existing files writable', async () => {
  const h = directoryFixture({existing:{'001_photo.png':[9], '001_photo (1).png':[8]}});
  h.entries.set('001_photo (2).png', {directory:true});
  let options;
  const progress = [];
  const result = await writeImage(h.directory, '001_photo.png', 'https://images.test/photo.png', {
    fetchImpl:async (_url, settings) => { options = settings; return image(); },
    onProgress:value => progress.push(value)
  });
  assert.deepEqual(result, {filename:'001_photo (3).png', bytesReceived:3, totalBytes:3, formatKnown:true, mime:'image/png'});
  assert.deepEqual([...h.entries.get('001_photo.png').data], [9]);
  assert.deepEqual([...h.entries.get('001_photo (1).png').data], [8]);
  assert.deepEqual(h.events.filter(([type]) => type === 'open'), [['open', '001_photo (3).png']]);
  assert.equal(options.credentials, 'include');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.deepEqual(progress, [{bytesReceived:3, totalBytes:3}]);
});

test('directory save resolves only after the file close has completed', async () => {
  const closing = deferred(); const finish = deferred();
  const h = directoryFixture({onClose:async () => { closing.resolve(); await finish.promise; }});
  let resolved = false;
  const saving = writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {fetchImpl:async () => image()})
    .then(result => { resolved = true; return result; });
  await closing.promise;
  assert.equal(resolved, false);
  assert.equal(h.entries.get('photo.png').data.length, 0);
  finish.resolve();
  await saving;
  assert.deepEqual([...h.entries.get('photo.png').data], [1, 2, 3]);
});

test('HTTP errors, nonimage responses and empty bodies create no files', async () => {
  for (const response of [
    new Response('denied', {status:403}),
    new Response('<html>sign in</html>', {headers:{'content-type':'text/html; charset=utf-8'}}),
    new Response('{}', {headers:{'content-type':'application/problem+json'}}),
    new Response('<error/>', {headers:{'content-type':'application/xml'}}),
    image(new Uint8Array())
  ]) {
    const h = directoryFixture();
    await assert.rejects(writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {fetchImpl:async () => response}));
    assert.equal(h.entries.size, 0);
  }
  const svg = directoryFixture();
  await writeImage(svg.directory, 'drawing.svg', 'https://images.test/drawing.svg', {
    fetchImpl:async () => new Response('<svg/>', {headers:{'content-type':'image/svg+xml'}})
  });
  assert.ok(svg.entries.get('drawing.svg').data.length > 0);
});

test('cancel aborts an active stream and removes only its own empty file', async () => {
  const controller = new AbortController();
  const h = directoryFixture({existing:{'photo.png':[7]}});
  let cancelled = false;
  const body = new ReadableStream({
    start(stream) { stream.enqueue(Uint8Array.from([1, 2])); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {
    signal:controller.signal,
    fetchImpl:async () => image(body),
    onProgress:() => controller.abort()
  }), {name:'AbortError'});
  assert.equal(cancelled, true);
  assert.deepEqual([...h.entries.get('photo.png').data], [7]);
  assert.equal(h.entries.has('photo (1).png'), false);
  assert.equal(h.events.some(([event]) => event === 'close'), false);
});

test('a write failure aborts the temporary write without altering old files', async () => {
  const h = directoryFixture({existing:{'photo.png':[7]}, onWrite:async () => { throw new Error('disk full'); }});
  await assert.rejects(writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {
    fetchImpl:async () => image()
  }), /disk full/);
  assert.deepEqual([...h.entries.get('photo.png').data], [7]);
  assert.equal(h.entries.has('photo (1).png'), false);
  assert.deepEqual(h.events.slice(-2), [['abort', 'photo (1).png'], ['remove', 'photo (1).png']]);
});

test('a failed close is never reported as a saved file', async () => {
  const h = directoryFixture({onClose:async () => { throw new Error('close failed'); }});
  await assert.rejects(writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {
    fetchImpl:async () => image()
  }), /close failed/);
  assert.equal(h.events.some(([event]) => event === 'close'), false);
  assert.equal(h.entries.size, 0);
});

test('30 seconds without more stream data stops the write and permits retry', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const written = deferred();
  let cancelled = false;
  const h = directoryFixture();
  const body = new ReadableStream({
    start(stream) { stream.enqueue(Uint8Array.from([1])); },
    cancel() { cancelled = true; }
  });
  const saving = writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {
    fetchImpl:async () => image(body), onProgress:() => written.resolve()
  });
  await written.promise;
  t.mock.timers.tick(30000);
  await assert.rejects(saving, {name:'TimeoutError'});
  assert.equal(cancelled, true);
  assert.equal(h.entries.size, 0);
  const retried = await writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {fetchImpl:async () => image()});
  assert.equal(retried.filename, 'photo.png');
});

test('failed cleanup preserves a nonempty or replaced entry', async () => {
  let h;
  h = directoryFixture({onWrite:async () => { throw new Error('write failed'); }, onAbort:async name => {
    h.entries.set(name, {data:Uint8Array.from([9, 9])});
  }});
  await assert.rejects(writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {fetchImpl:async () => image()}));
  assert.deepEqual([...h.entries.get('photo.png').data], [9, 9]);
  assert.equal(h.events.some(([event]) => event === 'remove'), false);
});

test('concurrent writers do not choose the same name', async () => {
  const closing = deferred(); const finish = deferred();
  let first = true;
  const h = directoryFixture({onClose:async () => {
    if (first) { first = false; closing.resolve(); await finish.promise; }
  }});
  const one = writeImage(h.directory, 'photo.png', 'https://images.test/one.png', {fetchImpl:async () => image()});
  await closing.promise;
  const two = writeImage(h.directory, 'photo.png', 'https://images.test/two.png', {fetchImpl:async () => image()});
  finish.resolve();
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map(result => result.filename), ['photo.png', 'photo (1).png']);
});

test('UTF-8 filenames and duplicate suffixes stay within portable byte limits', async () => {
  const h = directoryFixture();
  const filename = `${'写真🌸'.repeat(50)}.png`;
  const one = await writeImage(h.directory, filename, 'https://images.test/one.png', {fetchImpl:async () => image()});
  const two = await writeImage(h.directory, filename, 'https://images.test/two.png', {fetchImpl:async () => image()});
  const encoder = new TextEncoder();
  assert.ok(encoder.encode(one.filename).length <= 240);
  assert.ok(encoder.encode(two.filename).length <= 240);
  assert.ok(one.filename.endsWith('.png'));
  assert.ok(two.filename.endsWith(' (1).png'));
  assert.equal(one.filename.includes('\ufffd'), false);
  assert.notEqual(one.filename, two.filename);
});

test('an already cancelled write performs no request and invalid leaf paths are rejected', async () => {
  const h = directoryFixture(); const controller = new AbortController(); controller.abort();
  let fetched = false;
  await assert.rejects(writeImage(h.directory, 'photo.png', 'https://images.test/photo.png', {
    signal:controller.signal,
    fetchImpl:async () => { fetched = true; return image(); }
  }), {name:'AbortError'});
  assert.equal(fetched, false);
  for (const name of ['../photo.png', 'folder/photo.png', 'folder\\photo.png', '.', '..', '']) {
    await assert.rejects(writeImage(h.directory, name, 'https://images.test/photo.png'), /不正/);
  }
  assert.equal(h.entries.size, 0);
});

test('original image names use the received MIME before collision reservation', async () => {
  const h = directoryFixture({existing:{'photo.png':[9]}});
  const result = await writeImage(h.directory, 'photo.img', 'https://images.test/render', {
    fetchImpl:async () => image()
  });
  assert.equal(result.filename, 'photo (1).png');
  assert.equal(result.formatKnown, true); assert.equal(result.mime, 'image/png');
  assert.equal(h.entries.has('photo.img'), false);
  assert.deepEqual([...h.entries.get('photo.png').data], [9]);
});

test('unknown MIME sniffs split prefixes and streams all original bytes before completion', async () => {
  const h = directoryFixture(); const written = deferred();
  const prefix = Uint8Array.from([137,80,78,71,13,10,26,10]);
  let stream;
  const body = new ReadableStream({start(controller) {
    stream = controller; controller.enqueue(prefix.subarray(0, 3)); controller.enqueue(prefix.subarray(3));
  }});
  const saving = writeImage(h.directory, 'photo.img', 'https://images.test/render', {
    fetchImpl:async () => new Response(body, {headers:{'content-type':'application/octet-stream'}}),
    onProgress:({bytesReceived}) => { if (bytesReceived === 8) written.resolve(); }
  });
  await written.promise;
  assert.ok(h.events.some(([event]) => event === 'write'), 'writes begin before the body ends');
  assert.equal(h.events.some(([event]) => event === 'close'), false);
  stream.enqueue(Uint8Array.from([2,3,4])); stream.close();
  const result = await saving;
  assert.equal(result.filename, 'photo.png'); assert.equal(result.formatKnown, true);
  assert.equal(result.bytesReceived, 11);
  assert.deepEqual([...h.entries.get('photo.png').data], [...prefix,2,3,4]);
});

test('unrecognized content keeps a neutral suffix and reports that the format is unknown', async () => {
  const h = directoryFixture(); const contents = Uint8Array.from([1,2,3,4]);
  const result = await writeImage(h.directory, 'photo.jpg', 'https://images.test/render', {
    fetchImpl:async () => new Response(contents)
  });
  assert.deepEqual(result, {filename:'photo.img', bytesReceived:4, totalBytes:4, formatKnown:false, mime:''});
  assert.deepEqual([...h.entries.get('photo.img').data], [...contents]);
});

test('cancel while waiting for an unknown signature creates no file', async () => {
  const h = directoryFixture(); const controller = new AbortController(); const reading = deferred();
  let cancelled = false;
  const body = new ReadableStream({
    start(stream) { stream.enqueue(Uint8Array.from([137,80,78])); },
    pull() { reading.resolve(); },
    cancel() { cancelled = true; }
  });
  const saving = writeImage(h.directory, 'photo.img', 'https://images.test/render', {
    signal:controller.signal, fetchImpl:async () => new Response(body)
  });
  await reading.promise; controller.abort();
  await assert.rejects(saving, {name:'AbortError'});
  assert.equal(cancelled, true); assert.equal(h.entries.size, 0);
});
