import {MEDIA_LIMITS, ResourceLimitError} from './media-limits.js';

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('保存を停止しました。', 'AbortError');
}
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function forget(promise) { Promise.resolve(promise).catch(() => {}); }

// Create this before requesting a queue/lock. Sharing the operation keeps that
// wait, fetch, reading and writing inside the same absolute deadline.
export function createMediaOperation({signal, deadline, timeoutMs = MEDIA_LIMITS.original.timeoutMs,
  idleTimeoutMs = MEDIA_LIMITS.idleTimeoutMs, now = Date.now} = {}) {
  const controller = new AbortController();
  const absoluteDeadline = Math.min(Number.isFinite(deadline) ? deadline : Infinity,
    now() + positive(timeoutMs, MEDIA_LIMITS.original.timeoutMs));
  let absoluteTimer; let idleTimer; let disposed = false;
  const timeout = () => controller.abort(new DOMException('処理の制限時間を超えました。', 'TimeoutError'));
  const stopped = () => controller.abort(signal.reason);
  if (signal?.aborted) stopped(); else signal?.addEventListener('abort', stopped, {once:true});
  const check = () => {
    if (now() >= absoluteDeadline && !controller.signal.aborted) timeout();
    if (controller.signal.aborted) throw abortReason(controller.signal);
  };
  const touch = () => {
    check(); clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new DOMException(
      '30秒間処理が進みませんでした。接続や保存先を確認してください。', 'TimeoutError')),
    positive(idleTimeoutMs, MEDIA_LIMITS.idleTimeoutMs));
  };
  absoluteTimer = setTimeout(timeout, Math.max(0, absoluteDeadline - now()));
  const wait = promise => {
    // Attach both handlers even when already aborted, including late native
    // results. The underlying operation may not support cancellation.
    const pending = Promise.resolve(promise);
    pending.catch(() => {});
    try { check(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const aborted = () => reject(abortReason(controller.signal));
      controller.signal.addEventListener('abort', aborted, {once:true});
      pending.then(value => {
        controller.signal.removeEventListener('abort', aborted);
        try { check(); resolve(value); } catch (error) { reject(error); }
      }, error => { controller.signal.removeEventListener('abort', aborted); reject(error); });
      if (controller.signal.aborted) aborted();
    });
  };
  return {signal:controller.signal, deadline:absoluteDeadline, check, wait, touch,
    abort(reason) { controller.abort(reason); },
    dispose() {
      if (disposed) return; disposed = true;
      clearTimeout(absoluteTimer); clearTimeout(idleTimer);
      signal?.removeEventListener('abort', stopped);
    }};
}

// Content-Length only allows an early refusal. A missing, false, compressed or
// understated length never bypasses observed expanded-body chunk accounting.
export function mediaContentLength(response) {
  const encoding = response.headers.get('content-encoding');
  const raw = response.headers.get('content-length') || '';
  if ((encoding && encoding.trim().toLowerCase() !== 'identity') || !/^\d+$/.test(raw)) return 0;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : 0;
}

export async function openMediaReader(url, options = {}) {
  const {fetchImpl = fetch, onProgress, onBytes} = options;
  const maxBytes = Math.floor(positive(options.maxBytes, MEDIA_LIMITS.original.maxBytes));
  const maxEmptyChunks = Math.floor(positive(options.maxEmptyChunks, 64));
  const operation = options.operation || createMediaOperation(options);
  const ownsOperation = !options.operation;
  let reader; let received = 0; let observed = 0; let finished = false; let cancelled = false;
  let totalBytes = 0;
  const cancel = reason => {
    if (cancelled) return; cancelled = true;
    try {
      if (reader) forget(Promise.resolve(reader.cancel(reason)).then(() => {
        try { reader.releaseLock(); } catch {}
      }, () => { try { reader.releaseLock(); } catch {} }));
    } catch {}
    try { reader?.releaseLock(); } catch {}
  };
  const dispose = () => { if (!finished) cancel(); if (ownsOperation) operation.dispose(); };
  const decorate = error => {
    try { error.bytesReceived = observed; error.acceptedBytes = received; } catch {}
    return error;
  };
  try {
    operation.check(); operation.touch();
    const fetching = Promise.resolve(fetchImpl(url, {credentials:'include', referrerPolicy:'no-referrer',
      redirect:'error', signal:operation.signal}));
    // A fetch implementation can settle after its caller timed out. Discard
    // the late response instead of keeping a body alive without a consumer.
    fetching.then(response => { if (operation.signal.aborted) { try { forget(response.body?.cancel()); } catch {} } }, () => {});
    const response = await operation.wait(fetching);
    if (!response.ok) {
      try { forget(response.body?.cancel()); } catch {}
      throw new Error(`画像の取得に失敗しました（HTTP ${response.status}）。`);
    }
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/^(?:text\/(?:html|xml)|application\/(?:[a-z0-9.+-]*\+)?(?:json|xml))$/.test(mime)) {
      try { forget(response.body?.cancel()); } catch {}
      throw new Error('画像ではない応答が返されました。サイトの認証・制限を確認してください。');
    }
    if (!response.body?.getReader) throw new Error('画像データを読み込めませんでした。');
    reader = response.body.getReader();
    totalBytes = mediaContentLength(response);
    if (totalBytes > maxBytes) throw new ResourceLimitError('画像データが容量の上限を超えています。', 'byte-limit');
    operation.touch();
    return {mime, totalBytes, operation,
      get bytesReceived() { return received; }, get observedBytes() { return observed; },
      async read() {
        try {
          if (finished) return {done:true, value:undefined};
          let emptyChunks = 0;
          while (true) {
            operation.check();
            const chunk = await operation.wait(reader.read());
            if (chunk.done) {
              finished = true;
              try { reader.releaseLock(); } catch {}
              return {done:true, value:undefined};
            }
            const value = chunk.value;
            if (!(value instanceof Uint8Array)) throw new Error('画像データを読み込めませんでした。');
            if (!value.byteLength) {
              if (++emptyChunks > maxEmptyChunks) throw new ResourceLimitError('空の画像データが続いたため中断しました。', 'empty-chunk-limit');
              continue;
            }
            observed += value.byteLength;
            if (!Number.isSafeInteger(observed) || observed > maxBytes) {
              throw new ResourceLimitError('画像データが容量の上限を超えています。', 'byte-limit');
            }
            // Authorization completes before the chunk can be retained by a
            // Blob consumer or handed to a writable stream.
            if (onBytes) await operation.wait(onBytes({bytesReceived:observed, chunkBytes:value.byteLength, totalBytes}));
            operation.check(); received = observed; operation.touch();
            try { forget(onProgress?.({bytesReceived:received, totalBytes})); } catch {}
            return {done:false, value};
          }
        } catch (error) { cancel(error); throw decorate(error); }
      }, cancel, dispose};
  } catch (error) { cancel(error); if (ownsOperation) operation.dispose(); throw decorate(error); }
}

// Only preview/conversion use this bounded accumulator. Original files stream
// directly to disk and never pass through an all-original Blob.
export async function readMediaBlob(url, options = {}) {
  const source = await openMediaReader(url, options);
  const chunks = [];
  try {
    while (true) {
      const chunk = await source.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
    source.operation.check();
    if (!source.bytesReceived) throw new Error('画像データが空です。元ページや接続を確認してください。');
    return {blob:new Blob(chunks, {type:source.mime}), bytesReceived:source.bytesReceived,
      totalBytes:source.totalBytes, mime:source.mime};
  } finally { chunks.length = 0; source.dispose(); }
}
