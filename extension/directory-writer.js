import {extensionForBytes, resolveImageFilename} from './image-format.js';
import {MEDIA_LIMITS} from './media-limits.js';
import {createMediaOperation, openMediaReader} from './media-reader.js';

const encoder = new TextEncoder();
const LOCK = 'imagecrate-directory-write';
let writes = Promise.resolve();

function bytePrefix(value, limit) {
  let result = '';
  let size = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > limit) break;
    result += character; size += bytes;
  }
  return result;
}
function uniqueName(filename, index) {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 && filename.length - dot <= 20 ? filename.slice(dot) : '';
  const stem = extension ? filename.slice(0, dot) : filename;
  const suffix = index ? ` (${index})` : '';
  return `${bytePrefix(stem, 240 - encoder.encode(extension + suffix).length)}${suffix}${extension}`;
}
async function reserve(directory, filename, operation, fileIO) {
  for (let index = 0; index < 10000; index++) {
    operation.check();
    const name = uniqueName(filename, index);
    try { await fileIO(directory.getFileHandle(name), 'lookup'); }
    catch (error) {
      if (error.name === 'TypeMismatchError') continue;
      if (error.name !== 'NotFoundError') throw error;
      operation.check();
      // The origin-wide Web Lock excludes other ImageCrate writers between
      // checking this name and creating it. Existing files are never opened writable.
      const handle = await fileIO(directory.getFileHandle(name, {create:true}), 'create');
      // Another application can create an entry while the browser awaits disk I/O.
      // Do not replace its content if it is already nonempty.
      if ((await fileIO(handle.getFile(), 'lookup')).size > 0) continue;
      return {name, handle};
    }
  }
  throw new Error('同名のファイルが多すぎます。別の保存フォルダ名を指定してください。');
}
async function removeOwnEmptyFile(directory, name, handle) {
  try {
    const current = await directory.getFileHandle(name);
    if (await current.isSameEntry(handle) && (await current.getFile()).size === 0) {
      await directory.removeEntry(name);
    }
  } catch { /* A failed cleanup must not hide the original error or remove another file. */ }
}
function outcomeUnknown(error, entry, bytesReceived) {
  const result = new Error('書き込みの結果を確認できません。保存先を確認してから新しい保存を準備してください。', {cause:error});
  result.name = 'WriteOutcomeUnknownError'; result.code = 'outcome-unknown'; result.outcomeUnknown = true;
  result.filename = entry?.name || ''; result.bytesReceived = bytesReceived;
  return result;
}
function briefCleanup(promise, milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    Promise.resolve(promise).then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
  });
}
async function transfer(directory, filename, url, options, context) {
  const {operation, onProgress, fetchImpl, authorize} = options;
  const pendingIO = new Set();
  let source; let writable; let entry; let committed = false; let uncertain = false;
  let closeFulfilled = false;
  const fileIO = (promise, stage) => {
    const pending = {stage};
    pendingIO.add(pending);
    pending.promise = Promise.resolve(promise).then(async value => {
      if (stage === 'open') {
        writable = value;
        // createWritable itself can finish after our deadline. Its late stream
        // must also be aborted under the retained ownership, never orphaned.
        if (operation.signal.aborted) { try { await value.abort(); } catch {} }
      }
      pendingIO.delete(pending); if (stage === 'close') closeFulfilled = true; return value;
    }, error => { pendingIO.delete(pending); throw error; });
    pending.promise.catch(() => {});
    return operation.wait(pending.promise);
  };
  try {
    operation.check(); operation.touch();
    if (authorize) await operation.wait(authorize());
    source = await openMediaReader(url, {...options, operation, onProgress, fetchImpl});
    let chunk = await source.read();
    if (chunk.done) throw new Error('画像データが空です。元ページや接続を確認してください。');
    const pending = [chunk.value];
    let prefix = chunk.value.subarray(0, 64);
    // Retain at most the short signature prefix plus the current network
    // chunks. Every chunk has already passed the shared byte authorizer.
    while (prefix.byteLength < 64 && !extensionForBytes(prefix)) {
      chunk = await source.read();
      if (chunk.done) break;
      pending.push(chunk.value);
      const next = new Uint8Array(Math.min(64, prefix.byteLength + chunk.value.byteLength));
      next.set(prefix); next.set(chunk.value.subarray(0, next.length - prefix.byteLength), prefix.byteLength);
      prefix = next;
    }
    const format = resolveImageFilename(filename, source.mime, prefix);
    entry = await reserve(directory, format.filename, operation, fileIO);
    operation.check();
    writable = await fileIO(entry.handle.createWritable(), 'open');
    const write = async value => {
      operation.check();
      await fileIO(writable.write(value), 'write'); operation.touch();
    };
    for (const value of pending) await write(value);
    pending.length = 0;
    while (!chunk.done) {
      chunk = await source.read();
      if (!chunk.done) await write(chunk.value);
    }
    operation.check();
    await fileIO(writable.close(), 'close');
    committed = true;
    return {filename:entry.name, bytesReceived:source.bytesReceived, totalBytes:source.bytesReceived,
      formatKnown:format.known, mime:format.mime};
  } catch (error) {
    // A timeout/Stop only ends our wait; a native write/close may still commit.
    // Never present that result as a known absent file or permit auto-retry.
    uncertain = closeFulfilled || [...pendingIO].some(item => ['create', 'open', 'write', 'close'].includes(item.stage));
    if (uncertain) throw outcomeUnknown(error, entry, source?.observedBytes || 0);
    try { error.bytesReceived = Math.max(error.bytesReceived || 0, source?.observedBytes || 0); } catch {}
    throw error;
  } finally {
    if (!committed) {
      operation.abort();
      source?.cancel();
      // Start abort promptly, without trusting it to settle. Ownership remains
      // held by context.cleanup until every outstanding native operation and
      // abort has settled, even though the UI receives its result promptly.
      let abortPromise = Promise.resolve(true);
      if (writable) {
        try { abortPromise = Promise.resolve(writable.abort()).then(() => true, () => false); }
        catch { abortPromise = Promise.resolve(false); }
      }
      const outstanding = [...pendingIO].map(item => item.promise);
      context.cleanup = (async () => {
        const [, aborted] = await Promise.all([Promise.allSettled(outstanding), abortPromise]);
        if (entry && aborted && !uncertain) await removeOwnEmptyFile(directory, entry.name, entry.handle);
      })();
      // Successful cleanup is normally synchronous disk bookkeeping. A hung
      // abort/cancel must never keep the user waiting without a terminal state.
      await briefCleanup(context.cleanup, options.cleanupGraceMs ?? 100);
    }
    source?.dispose();
  }
}

export async function writeImage(directory, filename, url, options = {}) {
  if (!directory?.getFileHandle || typeof filename !== 'string' || !filename
    || filename === '.' || filename === '..' || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(filename)) {
    throw new Error('保存ファイル名または保存先が不正です。');
  }
  const operation = options.operation || createMediaOperation({...options,
    timeoutMs:options.timeoutMs ?? MEDIA_LIMITS.original.timeoutMs});
  const context = {};
  let started = false;
  let resolveResources;
  const resourcesSettled = new Promise(resolve => { resolveResources = resolve; });
  let resolveResult; let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const fail = error => {
    // The caller can stop waiting promptly while retaining a converted Blob's
    // lease until the real writer/abort ownership has ended. This Promise is
    // local metadata and is never serialized into the session record.
    try { Object.defineProperty(error, 'resourcesSettled', {value:resourcesSettled, configurable:true}); }
    catch {
      const wrapped = new Error(error?.message || '画像の書き込みに失敗しました。', {cause:error});
      for (const key of ['name', 'code', 'outcomeUnknown', 'bytesReceived', 'filename']) if (error?.[key] !== undefined) wrapped[key] = error[key];
      Object.defineProperty(wrapped, 'resourcesSettled', {value:resourcesSettled}); error = wrapped;
    }
    rejectResult(error);
  };
  const abortedInQueue = () => {
    if (!started) {
      try { operation.check(); } catch (error) { fail(error); }
      if (!options.operation) operation.dispose();
    }
  };
  operation.signal.addEventListener('abort', abortedInQueue, {once:true});
  const run = async () => {
    started = true;
    try {
      operation.check();
      resolveResult(await transfer(directory, filename, url, {...options, fetchImpl:options.fetchImpl || fetch,
        maxBytes:options.maxBytes ?? MEDIA_LIMITS.original.maxBytes, operation}, context));
    } catch (error) { fail(error); }
    finally {
      operation.signal.removeEventListener('abort', abortedInQueue);
      if (!options.operation) operation.dispose();
      await context.cleanup;
    }
  };
  let ownership;
  try {
    if (globalThis.navigator?.locks?.request) {
      ownership = navigator.locks.request(LOCK, {signal:operation.signal}, run);
    } else {
      // Supported Chrome uses Web Locks. The fallback also retains ownership
      // while native I/O remains unresolved, including in deterministic tests.
      ownership = writes.then(run); writes = ownership.catch(() => {});
    }
  } catch (error) {
    operation.signal.removeEventListener('abort', abortedInQueue);
    if (!options.operation) operation.dispose(); fail(error); resolveResources();
    return result;
  }
  Promise.resolve(ownership).then(resolveResources, resolveResources);
  ownership.catch(error => {
    operation.signal.removeEventListener('abort', abortedInQueue);
    if (!options.operation) operation.dispose(); fail(error);
  });
  if (operation.signal.aborted) abortedInQueue();
  return result;
}

export function writeBlob(directory, filename, blob, options = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('保存する画像データがありません。');
  // Conversion output accounting is distinct from source transfer accounting.
  // This reuses streaming/close/nonoverwrite without another network request.
  return writeImage(directory, filename, '', {...options,
    maxBytes:options.maxBytes ?? MEDIA_LIMITS.converter.maxOutputBytes,
    fetchImpl:async () => new Response(blob, {headers:{
      'content-type':blob.type || 'application/octet-stream', 'content-length':String(blob.size)
    }})});
}
