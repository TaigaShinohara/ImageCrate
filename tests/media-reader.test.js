import test from 'node:test';
import assert from 'node:assert/strict';
import {openMediaReader, readMediaBlob, createMediaOperation, mediaContentLength} from '../extension/media-reader.js';

function response(chunks, headers = {}, callbacks = {}) {
  return new Response(new ReadableStream({
    start(stream) { for (const chunk of chunks) stream.enqueue(Uint8Array.from(chunk)); stream.close(); },
    cancel:callbacks.cancel
  }), {headers:{'content-type':'image/png', ...headers}});
}

test('a false small Content-Length cannot expose the first oversized chunk to consumers', async () => {
  const progress = []; const authorized = [];
  const source = await openMediaReader('https://images.test/a', {maxBytes:4,
    fetchImpl:async () => response([[1,2], [3,4,5]], {'content-length':'1'}),
    onProgress:value => progress.push(value.bytesReceived), onBytes:value => authorized.push(value.bytesReceived)});
  try {
    assert.deepEqual([...(await source.read()).value], [1,2]);
    await assert.rejects(source.read(), error => error.code === 'byte-limit' && error.bytesReceived === 5 && error.acceptedBytes === 2);
    assert.deepEqual(progress, [2]); assert.deepEqual(authorized, [2]);
    assert.equal(source.bytesReceived, 2); assert.equal(source.observedBytes, 5);
  } finally { source.dispose(); }
});

test('compressed and absent lengths still count expanded bytes and an honest large length refuses without a read', async () => {
  for (const headers of [{}, {'content-length':'1','content-encoding':'gzip'}]) {
    await assert.rejects(readMediaBlob('https://images.test/a', {maxBytes:3,
      fetchImpl:async () => response([[1,2],[3,4]], headers)}), error => error.code === 'byte-limit');
  }
  let reads = 0; let cancelled = false;
  const res = {ok:true, headers:new Headers({'content-length':'5'}), body:{getReader() {
    return {read() { reads++; return Promise.resolve({done:false,value:new Uint8Array([1])}); },
      cancel() { cancelled = true; return new Promise(() => {}); }, releaseLock() {}};
  }}};
  await assert.rejects(openMediaReader('https://images.test/a', {maxBytes:4,fetchImpl:async () => res}), error => error.code === 'byte-limit');
  assert.equal(reads, 0); assert.equal(cancelled, true);
  assert.equal(mediaContentLength(new Response('', {headers:{'content-length':'9007199254740992'}})), 0);
});

test('bounded Blob accepts an exact boundary and managed requests fix credentials/referrer/redirect', async () => {
  let settings;
  const result = await readMediaBlob('https://images.test/a', {maxBytes:4,
    fetchImpl:async (_url, options) => { settings = options; return response([[1],[2,3,4]]); }});
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [1,2,3,4]);
  assert.equal(result.blob.type, 'image/png'); assert.equal(result.bytesReceived, 4);
  assert.equal(settings.credentials, 'include'); assert.equal(settings.referrerPolicy, 'no-referrer');
  assert.equal(settings.redirect, 'error');
});

test('absolute deadline survives progressing reads and counts time before fetch/queue acquisition', async () => {
  let now = 1000; let requests = 0;
  const operation = createMediaOperation({now:() => now,timeoutMs:10});
  now = 1011;
  await assert.rejects(openMediaReader('https://images.test/a', {operation,
    fetchImpl:async () => { requests++; return response([[1]]); }}), {name:'TimeoutError'});
  operation.dispose(); assert.equal(requests, 0);
  now = 2000;
  const active = createMediaOperation({now:() => now,timeoutMs:10});
  const source = await openMediaReader('https://images.test/a', {operation:active,fetchImpl:async () => response([[1],[2],[3]])});
  await source.read(); now += 6; await source.read(); now += 5;
  await assert.rejects(source.read(), {name:'TimeoutError'});
  source.dispose(); active.dispose();
});

test('an empty-chunk flood is bounded and does not count as progress', async () => {
  let reads = 0; let cancels = 0;
  await assert.rejects(readMediaBlob('https://images.test/a', {maxEmptyChunks:3,
    fetchImpl:async () => ({ok:true,headers:new Headers(),body:{getReader() { return {
      read:async () => { reads++; return {done:false,value:new Uint8Array()}; },
      cancel:async () => { cancels++; },releaseLock() {}
    }; }}})}), error => error.code === 'empty-chunk-limit');
  assert.equal(reads, 4); assert.equal(cancels, 1);
});

test('aborted readers return promptly even if reader.cancel never settles', async () => {
  const controller = new AbortController(); let cancelled = false;
  const source = await openMediaReader('https://images.test/a', {signal:controller.signal,
    fetchImpl:async () => ({ok:true,headers:new Headers(),body:{getReader() { return {
      read:() => new Promise(() => {}),cancel:() => { cancelled = true; return new Promise(() => {}); },releaseLock() {}
    }; }}})});
  const reading = source.read(); controller.abort();
  await assert.rejects(reading, {name:'AbortError'}); assert.equal(cancelled, true); source.dispose();
});

test('idle timeout covers a fetch that never resolves and late bodies are discarded', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let finish; let cancelled = false;
  const reading = readMediaBlob('https://images.test/a', {idleTimeoutMs:5,
    fetchImpl:() => new Promise(resolve => { finish = resolve; })});
  t.mock.timers.tick(5);
  await assert.rejects(reading, {name:'TimeoutError'});
  finish({body:{cancel() { cancelled = true; return Promise.resolve(); }}});
  await Promise.resolve(); assert.equal(cancelled, true);
});

test('byte authorization failure prevents retention and is not reported as progress', async () => {
  let progress = 0;
  await assert.rejects(readMediaBlob('https://images.test/a', {fetchImpl:async () => response([[1,2]]),
    onBytes:async () => { throw new Error('budget not persisted'); },onProgress:() => progress++}), /budget not persisted/);
  assert.equal(progress, 0);
});
