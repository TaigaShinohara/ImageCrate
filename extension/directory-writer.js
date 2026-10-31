import {extensionForMime, resolveImageFilename} from './image-format.js';

const encoder = new TextEncoder();
const LOCK = 'imagecrate-directory-write';
const IDLE_TIMEOUT = 30000;
let writes = Promise.resolve();

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('保存を停止しました。', 'AbortError');
}
function checkAbort(signal) { if (signal.aborted) throw abortReason(signal); }
function waitFor(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener('abort', aborted, {once:true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
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
async function reserve(directory, filename, signal) {
  for (let index = 0; index < 10000; index++) {
    checkAbort(signal);
    const name = uniqueName(filename, index);
    try { await directory.getFileHandle(name); }
    catch (error) {
      if (error.name === 'TypeMismatchError') continue;
      if (error.name !== 'NotFoundError') throw error;
      checkAbort(signal);
      // The origin-wide Web Lock excludes other ImageCrate writers between
      // checking this name and creating it. Existing files are never opened writable.
      const handle = await directory.getFileHandle(name, {create:true});
      // Another application can create an entry while the browser awaits disk I/O.
      // Do not replace its content if it is already nonempty.
      if ((await handle.getFile()).size > 0) continue;
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
function contentLength(response) {
  const encoding = response.headers.get('content-encoding');
  const raw = response.headers.get('content-length') || '';
  if ((encoding && encoding !== 'identity') || !/^\d+$/.test(raw)) return 0;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : 0;
}
async function transfer(directory, filename, url, {signal, onProgress, fetchImpl}) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', stop, {once:true});
  let timeout;
  const progress = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new DOMException(
      '30秒間保存が進みませんでした。接続や保存先を確認して再試行してください。', 'TimeoutError')), IDLE_TIMEOUT);
  };
  let reader;
  let writable;
  let entry;
  let committed = false;
  let bytesReceived = 0;
  progress();
  try {
    checkAbort(controller.signal);
    const response = await waitFor(fetchImpl(url, {
      credentials:'include', referrerPolicy:'no-referrer', signal:controller.signal
    }), controller.signal);
    if (!response.ok) throw new Error(`画像の取得に失敗しました（HTTP ${response.status}）。`);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/^(?:text\/(?:html|xml)|application\/(?:[a-z0-9.+-]*\+)?(?:json|xml))$/.test(mime)) {
      throw new Error('画像ではない応答が返されました。サイトの認証・制限を確認してください。');
    }
    if (!response.body?.getReader) throw new Error('画像データを読み込めませんでした。');
    progress();
    const totalBytes = contentLength(response);
    reader = response.body.getReader();
    // Verify that there is image data before creating even an empty file.
    let chunk = await waitFor(reader.read(), controller.signal);
    while (!chunk.done && !chunk.value?.byteLength) chunk = await waitFor(reader.read(), controller.signal);
    if (chunk.done) throw new Error('画像データが空です。元ページや接続を確認してください。');
    progress();
    const pending = [chunk.value];
    let prefix = chunk.value.subarray(0, 64);
    // Untyped responses may split a signature across small network chunks.
    // Retain only a short prefix and the current chunks, never the full body.
    while (!extensionForMime(mime) && prefix.byteLength < 64
      && !resolveImageFilename(filename, mime, prefix).known) {
      chunk = await waitFor(reader.read(), controller.signal);
      if (chunk.done) break;
      if (!chunk.value?.byteLength) continue;
      progress();
      pending.push(chunk.value);
      const next = new Uint8Array(Math.min(64, prefix.byteLength + chunk.value.byteLength));
      next.set(prefix); next.set(chunk.value.subarray(0, next.length - prefix.byteLength), prefix.byteLength);
      prefix = next;
    }
    const format = resolveImageFilename(filename, mime, prefix);
    entry = await reserve(directory, format.filename, controller.signal);
    checkAbort(controller.signal);
    writable = await entry.handle.createWritable();
    const write = async value => {
      checkAbort(controller.signal);
      if (value?.byteLength) {
        await waitFor(writable.write(value), controller.signal);
        bytesReceived += value.byteLength;
        progress();
        // Progress reporting must not turn an otherwise valid file into a failure.
        try { Promise.resolve(onProgress?.({bytesReceived, totalBytes})).catch(() => {}); } catch {}
      }
    };
    for (const value of pending) await write(value);
    while (!chunk.done) {
      chunk = await waitFor(reader.read(), controller.signal);
      if (!chunk.done) await write(chunk.value);
    }
    checkAbort(controller.signal);
    await waitFor(writable.close(), controller.signal);
    // close() is the point at which a successful write becomes a saved file.
    committed = true;
    return {filename:entry.name, bytesReceived, totalBytes:bytesReceived, formatKnown:format.known, mime:format.mime};
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stop);
    if (!committed) {
      controller.abort();
      let aborted = !writable;
      if (writable) { try { await writable.abort(); aborted = true; } catch {} }
      if (entry && aborted) await removeOwnEmptyFile(directory, entry.name, entry.handle);
      try { await reader?.cancel(); } catch {}
    }
    try { reader?.releaseLock(); } catch {}
  }
}

export async function writeImage(directory, filename, url, {signal, onProgress, fetchImpl = fetch} = {}) {
  if (!directory?.getFileHandle || typeof filename !== 'string' || !filename
    || filename === '.' || filename === '..' || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(filename)) {
    throw new Error('保存ファイル名または保存先が不正です。');
  }
  const options = {signal, onProgress, fetchImpl};
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(LOCK, signal ? {signal} : {}, () => transfer(directory, filename, url, options));
  }
  // Web Locks are available in supported Chrome. This also serializes callers
  // sharing a module instance in other environments and tests.
  const next = writes.then(() => transfer(directory, filename, url, options));
  writes = next.catch(() => {});
  return next;
}

export function writeBlob(directory, filename, blob, {signal, onProgress} = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('保存する画像データがありません。');
  // Reuse the same stream/close, collision and cancellation contract without
  // fetching the image again after a successful local conversion.
  return writeImage(directory, filename, '', {signal, onProgress,
    fetchImpl:async () => new Response(blob, {headers:{
      'content-type':blob.type || 'application/octet-stream', 'content-length':String(blob.size)
    }})});
}
