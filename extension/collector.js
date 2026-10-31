// Injected as a self-contained function into the authorized source document.
// All helpers stay inside this function: executeScript serializes its source.
export function collect(options = {}) {
  const KEY = Symbol.for('imagecrate.collector.v2');
  const LIMIT = 500, NODE_LIMIT = 12000, TTL = 5 * 60 * 1000;
  const SEEN_LIMIT = 4096, SEEN_BYTES = 2 * 1024 * 1024, DATA_LIMIT = 524288;
  const registry = globalThis[KEY] ||= { controller: null, replay: null, groups: new WeakMap(), nextGroup: 0 };
  const empty = (scanId = null, extra = {}) => ({ items: [], notices: [], cursor: null, retryCursor: null, hasMore: false, scanId, ...extra });
  const token = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const relevantMutation = record => record.type === 'attributes' || record.type === 'childList' &&
    [...(record.addedNodes || []), ...(record.removedNodes || [])].some(node => node.nodeType === 1);
  const cleanup = state => {
    if (!state) return;
    clearTimeout(state.timer);
    for (const observer of state.observers) observer.disconnect();
    for (const [target, type, listener] of state.listeners) target.removeEventListener(type, listener, true);
    state.observers.length = 0; state.listeners.length = 0; state.walkers.length = 0;
    state.active?.return?.(); state.active = null; state.pending = null; state.nextElement = null;
    state.docs.clear(); state.roots.clear(); state.seen.clear(); state.dataUrls.clear(); state.seenBytes = 0;
  };
  const invalidate = state => {
    state.invalidated = true;
    cleanup(state);
  };
  const clearReplay = () => { clearTimeout(registry.replay?.timer); registry.replay = null; };
  let state = registry.controller;
  if (options.dispose) {
    if (!options.cursor || state?.cursor === options.cursor || registry.replay?.requestCursor === options.cursor || registry.replay?.nextCursor === options.cursor) {
      const scanId = state?.scanId || registry.replay?.scanId;
      cleanup(state); registry.controller = null; clearReplay();
      return empty(scanId, { disposed: true });
    }
    return empty(state?.scanId, { disposed: false });
  }
  if (registry.replay?.expiresAt <= Date.now()) clearReplay();
  // Only serialized page data survives a terminal page. Replaying it does not
  // traverse the DOM or require references to the source elements.
  const retryEmptyPage = options.cursor && registry.replay?.requestCursor === options.cursor && registry.replay.capacityEmpty;
  if (options.cursor && registry.replay?.requestCursor === options.cursor && !retryEmptyPage) return JSON.parse(registry.replay.json);
  // A page with no admitted candidate is a capacity refusal, not an accepted
  // snapshot. Retry its held candidate using the caller's current byte budget.
  const continuationCursor = retryEmptyPage ? state?.cursor : options.cursor;
  if (options.cursor) {
    if (!state || state.cursor !== continuationCursor || state.expiresAt <= Date.now() || state.invalidated) {
      if (state && state.expiresAt <= Date.now()) { cleanup(state); registry.controller = null; }
      return empty(state?.scanId, { invalidated: true, notices: ['続きの取得位置が無効になりました。取得済み候補は残っています。元ページから取り直してください。'] });
    }
    // Deliver queued mutation records even when calls happen in one JS task.
    if (state.observers.some(observer => observer.takeRecords().some(relevantMutation))) invalidate(state);
    if (state.invalidated) return empty(state.scanId, { invalidated: true, notices: ['元ページが変わったため続きは取得できません。取得済み候補を確認するか、取り直してください。'] });
  } else {
    cleanup(state); clearReplay();
    state = { scanId: token(), cursor: null, invalidated: false, expiresAt: 0, timer: null,
      walkers: [], active: null, pending: null, nextElement: null, docs: new Set(), roots: new Set(),
      observers: [], listeners: [], seen: new Map(), seenBytes: 0, dataUrls: new Set(), dataBytes: 0 };
    registry.controller = state;
  }
  const requestCursor = options.cursor || `${state.scanId}:page:${token()}`;
  const notices = new Set();
  const groupFor = element => {
    let id = registry.groups.get(element);
    if (!id) { id = `imagecrate-${++registry.nextGroup}`; registry.groups.set(element, id); }
    return id;
  };
  const observeRoot = root => {
    if (state.roots.has(root)) return;
    state.roots.add(root);
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const Observer = doc?.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (Observer) {
      const observer = new Observer(records => { if (records.some(relevantMutation)) invalidate(state); });
      observer.observe(root, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'sizes', 'media', 'type', 'style', 'class', 'width', 'height', 'alt', 'href'] });
      state.observers.push(observer);
    }
  };
  const pushRoot = (root, doc) => {
    observeRoot(root);
    state.walkers.push({ walker: doc.createTreeWalker(root, 1), doc });
  };
  const pushDocument = doc => {
    if (state.docs.has(doc)) return;
    state.docs.add(doc);
    pushRoot(doc, doc);
    const onLoad = event => {
      if (['IMG', 'IFRAME', 'FRAME', 'SOURCE', 'LINK'].includes(event.target?.tagName)) invalidate(state);
    };
    const onResize = () => invalidate(state);
    if (doc.addEventListener) { doc.addEventListener('load', onLoad, true); state.listeners.push([doc, 'load', onLoad]); }
    if (doc.defaultView?.addEventListener) { doc.defaultView.addEventListener('resize', onResize, true); state.listeners.push([doc.defaultView, 'resize', onResize]); }
  };
  if (!options.cursor) pushDocument(document);
  const nextElement = () => {
    while (state.walkers.length) {
      const frame = state.walkers.at(-1);
      const element = frame.walker.nextNode();
      if (element) return { element, doc: frame.doc };
      state.walkers.pop();
    }
    return null;
  };
  const normalize = (raw, base) => {
    if (!raw) return null;
    try {
      const parsed = new URL(raw, base); parsed.hash = '';
      const url = parsed.href;
      if (parsed.username || parsed.password || url.length > 131072) return null;
      if (!/^https?:$/.test(parsed.protocol) && !/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);/i.test(url)) {
        if (parsed.protocol === 'blob:') notices.add('ページ内blob画像は今回の直接保存に未対応です。');
        return null;
      }
      return url;
    } catch { return null; }
  };
  function* srcsetCandidates(set) {
    // Commas inside a URL token (including signed CDN paths) are preserved.
    let pos = 0;
    while (pos < set.length) {
      while (pos < set.length && /[\t\n\f\r ,]/.test(set[pos])) pos++;
      const start = pos;
      while (pos < set.length && !/[\t\n\f\r ]/.test(set[pos])) pos++;
      let raw = set.slice(start, pos), descriptors = '';
      if (!raw) break;
      if (raw.endsWith(',')) raw = raw.replace(/,+$/, '');
      else {
        let depth = 0;
        while (pos < set.length) {
          const ch = set[pos++];
          if (ch === ',' && !depth) break;
          if (ch === '(') depth++;
          if (ch === ')') depth = Math.max(0, depth - 1);
          descriptors += ch;
        }
      }
      const parts = descriptors.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || parts.length === 1 && (/^[1-9]\d*w$/.test(parts[0]) || /^(?:\d+(?:\.\d+)?|\.\d+)x$/.test(parts[0]) && Number.parseFloat(parts[0]) > 0)) {
        yield { raw, descriptor: parts[0] || '' };
      }
    }
  }
  function* candidates({ element: el, doc }) {
    const base = el.baseURI || doc.baseURI;
    const picture = el.parentElement?.tagName === 'PICTURE' ? el.parentElement : null;
    const image = el.tagName === 'IMG' ? el : picture?.querySelector?.('img');
    const current = normalize(image?.currentSrc, base);
    const metaFor = (source, attribute, url, descriptor = '') => {
      const isCurrent = !!current && url === current;
      const width = isCurrent ? image?.naturalWidth || 0 : 0;
      const height = isCurrent ? image?.naturalHeight || 0 : 0;
      return { source, attribute, groupId: groupFor(picture || el), descriptor,
        descriptorType: descriptor ? descriptor.slice(-1) : '', descriptorValue: descriptor ? Number.parseFloat(descriptor) : 0,
        media: (el.getAttribute('media') || '').slice(0, 256), type: (el.getAttribute('type') || '').slice(0, 80),
        alt: (image?.alt || '').slice(0, 160), isCurrent, width, height,
        // naturalWidth is density-corrected source information, not a fetched file measurement.
        dimensionSource: width && height ? 'source' : 'unknown' };
    };
    if (el.tagName === 'IMG') {
      for (const [attribute, raw] of [['currentSrc', el.currentSrc], ...['src', 'data-src', 'data-original', 'data-lazy-src'].map(name => [name, el.getAttribute(name)])]) {
        const url = normalize(raw, base);
        if (url) yield { url, meta: metaFor('img', attribute, url) };
      }
    }
    if (el.tagName === 'IMG' || el.tagName === 'SOURCE' && picture) {
      for (const attribute of ['srcset', 'data-srcset']) {
        for (const { raw, descriptor } of srcsetCandidates(el.getAttribute(attribute) || '')) {
          const url = normalize(raw, base);
          if (url) yield { url, meta: metaFor('srcset', attribute, url, descriptor) };
        }
      }
    }
    let background = '';
    try { background = doc.defaultView.getComputedStyle(el).backgroundImage || ''; } catch { /* inaccessible or detached element */ }
    for (const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
      const url = normalize(match[1] || match[2] || match[3], base);
      if (url) yield { url, meta: { source: 'background', attribute: 'background-image', groupId: `${groupFor(el)}-background`,
        descriptor: '', descriptorType: '', descriptorValue: 0, media: '', type: '', alt: '', isCurrent: false,
        width: 0, height: 0, dimensionSource: 'unknown' } };
    }
    if (el.shadowRoot) pushRoot(el.shadowRoot, doc);
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try {
        const child = el.contentDocument;
        if (child) pushDocument(child);
        else notices.add('別ドメインの埋め込み内は取得できません。');
      } catch { notices.add('別ドメインの埋め込み内は取得できません。'); }
    }
  }
  const remember = (url, item) => {
    const memorySize = value => (JSON.stringify(value).length + value.url.length) * 2;
    if (state.seen.has(url)) { state.seenBytes -= memorySize(state.seen.get(url)); state.seen.delete(url); }
    state.seen.set(url, item); state.seenBytes += memorySize(item);
    while (state.seen.size > SEEN_LIMIT || state.seenBytes > SEEN_BYTES) {
      const key = state.seen.keys().next().value;
      state.seenBytes -= memorySize(state.seen.get(key)); state.seen.delete(key);
    }
  };
  const merge = (old, url, meta) => {
    if (!old) return { url, ...meta, occurrences: [meta] };
    const occurrences = old.occurrences.slice();
    const key = value => JSON.stringify([value.groupId, value.source, value.attribute, value.descriptor, value.media, value.type]);
    const index = occurrences.findIndex(value => key(value) === key(meta));
    if (index >= 0) occurrences[index] = meta;
    else if (occurrences.length < 64) occurrences.push(meta);
    else notices.add('同じ画像の由来情報は64件まで保持します。');
    return { ...old, alt: old.alt || meta.alt, descriptor: old.descriptor || meta.descriptor,
      descriptorType: old.descriptorType || meta.descriptorType, descriptorValue: old.descriptorValue || meta.descriptorValue,
      media: old.media || meta.media, type: old.type || meta.type, isCurrent: old.isCurrent || meta.isCurrent,
      width: Math.max(old.width || 0, meta.width || 0), height: Math.max(old.height || 0, meta.height || 0),
      dimensionSource: old.dimensionSource === 'source' || meta.dimensionSource === 'source' ? 'source' : 'unknown', occurrences };
  };
  const items = new Map();
  const requestedBytes = Number(options.maxSerializedBytes);
  const maxBytes = Number.isFinite(requestedBytes) && requestedBytes > 0 ? Math.min(1572864, Math.max(1024, requestedBytes)) : 1572864;
  let visited = 0, serializedBytes = 1024, capacityLimited = false;
  while (true) {
    if (!state.active && !state.pending) {
      if (visited >= NODE_LIMIT || items.size >= LIMIT) {
        state.nextElement ||= nextElement();
        if (state.nextElement) notices.add(visited >= NODE_LIMIT ? '12000要素を取得しました。続きの取得で残りを確認できます。' : '500候補を取得しました。続きの取得で残りを確認できます。');
        break;
      }
      const next = state.nextElement || nextElement(); state.nextElement = null;
      if (!next) break;
      visited++;
      state.active = candidates(next);
    }
    const candidate = state.pending || state.active.next().value;
    state.pending = null;
    if (!candidate) { state.active = null; continue; }
    const { url, meta } = candidate;
    if (url.startsWith('data:') && !state.dataUrls.has(url) && state.dataBytes + url.length > DATA_LIMIT) {
      notices.add('埋め込み画像の取得量を制限しました。'); continue;
    }
    const old = items.get(url) || state.seen.get(url);
    const item = merge(old, url, meta);
    if (old && JSON.stringify(old) === JSON.stringify(item)) { remember(url, old); continue; }
    // At the boundary, already-emitted URLs can still acquire metadata. A new
    // URL is held for the next page instead of being silently discarded.
    if (items.size >= LIMIT && !items.has(url)) {
      state.pending = candidate;
      notices.add('500候補を取得しました。続きの取得で残りを確認できます。');
      break;
    }
    const byteDelta = JSON.stringify(item).length * 2 - (items.has(url) ? JSON.stringify(items.get(url)).length * 2 : 0);
    if (serializedBytes + byteDelta > maxBytes) {
      state.pending = candidate;
      capacityLimited = true;
      notices.add(items.size ? '取得量の上限で区切りました。続きの取得で残りを確認できます。' : 'この候補の情報が取得量の上限を超えています。取得済み候補は残っています。');
      break;
    }
    serializedBytes += byteDelta;
    if (url.startsWith('data:') && !state.dataUrls.has(url)) { state.dataUrls.add(url); state.dataBytes += url.length; }
    items.set(url, item); remember(url, item);
  }
  const hasMore = !!(state.active || state.pending || state.nextElement || state.walkers.length);
  const result = { items: [...items.values()], notices: [...notices], cursor: null, retryCursor: requestCursor, hasMore, scanId: state.scanId, ...(capacityLimited ? { capacityLimited: true } : {}) };
  if (hasMore) {
    state.cursor = `${state.scanId}:${token()}`;
    state.expiresAt = Date.now() + TTL;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { cleanup(state); if (registry.controller === state) registry.controller = null; }, TTL);
    state.timer?.unref?.();
    result.cursor = state.cursor;
  } else { cleanup(state); registry.controller = null; }
  clearReplay();
  const replay = { requestCursor, nextCursor: result.cursor, scanId: state.scanId, capacityEmpty: capacityLimited && !items.size,
    json: JSON.stringify(result), expiresAt: Date.now() + TTL, timer: null };
  replay.timer = setTimeout(() => { if (registry.replay === replay) registry.replay = null; }, TTL);
  replay.timer?.unref?.();
  registry.replay = replay;
  return result;
}
