// Local browser image codecs only. No format conversion service or dependency.
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PIXELS = 24_000_000;
export const MAX_DIMENSION = 16384;
const IDLE_TIMEOUT = 30000;
const MIME = {jpg:'image/jpeg', png:'image/png', webp:'image/webp'};

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('変換を停止しました。', 'AbortError');
}
function checkAbort(signal) { if (signal.aborted) throw abortReason(signal); }
function waitFor(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const stopped = () => reject(abortReason(signal));
    signal.addEventListener('abort', stopped, {once:true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped));
  });
}
function checkDimensions(width, height, requireBoth = true) {
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width > 0 && height > 0 && width * height > MAX_PIXELS) {
    throw new Error('変換できる画像は2400万画素以下、縦横それぞれ16384px以下です。元の形式で保存してください。');
  }
  if (requireBoth && (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)) {
    throw new Error('画像の寸法を読み取れませんでした。元の形式で保存してください。');
  }
}
function bitmapResult(promise, signal) {
  // A browser decoder cannot be cancelled. If it finishes after Stop, close
  // its late result instead of keeping a bitmap alive or permitting a write.
  const guarded = Promise.resolve(promise).then(bitmap => {
    if (signal.aborted) { bitmap.close(); throw abortReason(signal); }
    return bitmap;
  });
  return waitFor(guarded, signal);
}

export async function convertImage(url, format, {
  signal, onProgress, knownWidth, knownHeight, fetchImpl = fetch
} = {}) {
  const type = Object.hasOwn(MIME,format) ? MIME[format] : null;
  if (!type) throw new Error('対応していない保存形式です。JPEG・PNG・WebPから選んでください。');
  checkDimensions(knownWidth, knownHeight, false);
  const controller = new AbortController();
  const stopped = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', stopped, {once:true});
  let timer, response, reader, bitmap, canvas, image, imageURL;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException(
      '30秒間画像の取得・変換が進みませんでした。接続を確認して再試行してください。', 'TimeoutError')), IDLE_TIMEOUT);
  };
  progress();
  try {
    checkAbort(controller.signal);
    try {
      response = await waitFor(fetchImpl(url, {
        credentials:'include', referrerPolicy:'no-referrer', signal:controller.signal
      }), controller.signal);
    } catch {
      checkAbort(controller.signal);
      throw new Error('画像を取得できませんでした。接続・サイトの認証・配信元へのアクセス許可を確認してください。');
    }
    if (!response.ok) throw new Error(`画像の取得に失敗しました（HTTP ${response.status}）。`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/^(?:text\/(?:html|xml)|application\/(?:[a-z0-9.+-]*\+)?(?:json|xml))$/.test(contentType)) {
      throw new Error('画像ではない応答が返されました。サイトの認証・制限を確認してください。');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    const encoding = response.headers.get('content-encoding');
    const length = (!encoding || encoding === 'identity') && Number.isSafeInteger(declaredLength) && declaredLength > 0 ? declaredLength : 0;
    if (length > MAX_SOURCE_BYTES) {
      throw new Error('変換できる画像ファイルは32MiB以下です。元の形式で保存してください。');
    }
    if (!response.body?.getReader) throw new Error('画像データを読み込めませんでした。');
    reader = response.body.getReader();
    const chunks = [];
    let bytesReceived = 0;
    while (true) {
      let chunk;
      try { chunk = await waitFor(reader.read(), controller.signal); }
      catch {
        checkAbort(controller.signal);
        throw new Error('画像の読み込みが中断しました。接続を確認して再試行してください。');
      }
      if (chunk.done) break;
      if (!chunk.value?.byteLength) continue;
      bytesReceived += chunk.value.byteLength;
      if (bytesReceived > MAX_SOURCE_BYTES) {
        throw new Error('変換できる画像ファイルは32MiB以下です。元の形式で保存してください。');
      }
      chunks.push(chunk.value);progress();
      try { Promise.resolve(onProgress?.({bytesReceived,totalBytes:length > 0 ? length : 0})).catch(() => {}); } catch {}
    }
    if (!bytesReceived) throw new Error('画像データが空です。元ページや接続を確認してください。');
    checkAbort(controller.signal);
    const source = new Blob(chunks, {type:contentType});
    chunks.length = 0;
    progress();
    try {
      bitmap = await bitmapResult(createImageBitmap(source, {imageOrientation:'from-image'}), controller.signal);
    } catch (error) {
      checkAbort(controller.signal);
      if (contentType !== 'image/svg+xml') {
        throw new Error('この画像を変換できませんでした。元の形式で保存してください。');
      }
      // Chromium may reject an SVG Blob even when it has natural dimensions.
      // An inert image element supplies its intrinsic/viewBox-derived size;
      // explicit resize dimensions also cover viewBox-only SVGs.
      image = new Image();
      imageURL = URL.createObjectURL(source);
      image.src = imageURL;
      try {
        await waitFor(image.decode(), controller.signal);
        checkDimensions(image.naturalWidth, image.naturalHeight);
        bitmap = await bitmapResult(createImageBitmap(image, {
          imageOrientation:'from-image', resizeWidth:image.naturalWidth, resizeHeight:image.naturalHeight
        }), controller.signal);
      } catch (fallbackError) {
        checkAbort(controller.signal);
        if (fallbackError.message?.includes('元の形式で保存')) throw fallbackError;
        throw new Error('このSVG画像を変換できませんでした。元の形式で保存してください。');
      }
    }
    checkAbort(controller.signal);
    checkDimensions(bitmap.width, bitmap.height);
    // Limits bound our retained input/canvas, not the browser decoder's
    // transient allocations before its dimensions become available.
    try {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No image context');
      if (format === 'jpg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, bitmap.width, bitmap.height);
      }
      context.drawImage(bitmap, 0, 0);
    } catch {
      throw new Error('画像の変換処理を開始できませんでした。ほかの作業タブを閉じるか、元の形式で保存してください。');
    }
    bitmap.close();bitmap = null;
    checkAbort(controller.signal);progress();
    let output;
    try { output = await waitFor(canvas.convertToBlob({type,quality:0.92}), controller.signal); }
    catch {
      checkAbort(controller.signal);
      throw new Error('選んだ形式への変換に失敗しました。別の形式を選ぶか、元の形式で保存してください。');
    }
    checkAbort(controller.signal);
    if (!output || output.type !== type || !output.size) {
      // Canvas silently returns PNG if the requested encoder is unsupported.
      // Never label that result with a JPEG/WebP extension.
      throw new Error('選んだ形式で画像を作成できませんでした。別の形式を選ぶか、元の形式で保存してください。');
    }
    if (output.size > MAX_OUTPUT_BYTES) {
      throw new Error('変換後の画像が64MiBを超えました。別の形式を選ぶか、元の形式で保存してください。');
    }
    return output;
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort', stopped);
    controller.abort();
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
    bitmap?.close();
    if (image) image.src = '';
    if (imageURL) URL.revokeObjectURL(imageURL);
    if (canvas) { canvas.width = 1;canvas.height = 1; }
  }
}
