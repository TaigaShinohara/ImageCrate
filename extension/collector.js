// Injected as a self-contained function into the authorized source document.
// All helpers stay inside this function: executeScript serializes its source.
export function collect(options = {}) {
  const KEY = Symbol.for('imagecrate.collector.v2');
  const LIMIT = 500, NODE_LIMIT = 12000, TTL = 5 * 60 * 1000;
  const SEEN_LIMIT = 4096, SEEN_BYTES = 2 * 1024 * 1024, DATA_LIMIT = 524288;
  const registry = globalThis[KEY] ||= { controller: null, replay: null, groups: new WeakMap(), nextGroup: 0 };
  const empty = (scanId = null, extra = {}) => ({ items: [], notices: [], cursor: null, retryCursor: null, hasMore: false, scanId, ...extra });
  const token = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // These are cooperative application work limits. DOM/style/URL native calls
  // remain browser operations; this does not impose a native execution deadline.
  const DEFAULT_WORK = { attributeChars: 1048576, urlChars: 131072, descriptorChars: 64,
    callChars: 131072, callAttempts: 4096, callMillis: 25,
    scanChars: 16777216, scanAttempts: 65536, scanNodes: 100000,
    mutationRecords: 512, mutationNodes: 2048, roots: 256, documents: 32 };
  const boundedLimits = supplied => Object.fromEntries(Object.entries(DEFAULT_WORK).map(([name, maximum]) => {
    const value = Number(supplied?.[name]);
    return [name, Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.max(1, Math.floor(value))) : maximum];
  }));
  const mutationsMatter = (records, limits, used = { records: 0, nodes: 0 }) => {
    // Never copy a page-sized NodeList or flatten a mutation batch. If checking
    // it would exceed the budget, conservatively invalidate the continuation.
    if (records.length > limits.mutationRecords - used.records) return true;
    for (let index = 0; index < records.length; index++) {
      used.records++;
      const record = records[index];
      if (record.type === 'attributes') return true;
      if (record.type !== 'childList') continue;
      for (const list of [record.addedNodes, record.removedNodes]) {
        if (!list) continue;
        if (list.length > limits.mutationNodes - used.nodes) return true;
        for (let node = 0; node < list.length; node++) {
          used.nodes++;
          if (list[node].nodeType === 1) return true;
        }
      }
    }
    return false;
  };
  const cleanup = state => {
    if (!state) return;
    clearTimeout(state.timer);
    for (const observer of state.observers) { try { observer.disconnect(); } catch { /* release the remaining roots too */ } }
    for (const [target, type, listener] of state.listeners) {
      try { target.removeEventListener(type, listener, true); } catch { /* detached frame */ }
    }
    state.observers.length = 0; state.listeners.length = 0; state.walkers.length = 0;
    state.active = null; state.pending = null; state.nextElement = null;
    state.docs.clear(); state.roots.clear(); state.seen.clear(); state.dataUrls.clear(); state.seenBytes = 0;
  };
  const invalidate = state => {
    state.invalidated = true;
    cleanup(state);
  };
  const clearReplay = () => { clearTimeout(registry.replay?.timer); registry.replay = null; };
  let state = registry.controller;
  if (options.dispose) {
    if (options.cursor && (state?.cursor === options.cursor || registry.replay?.requestCursor === options.cursor || registry.replay?.nextCursor === options.cursor) ||
        options.scanId && (state?.scanId === options.scanId || registry.replay?.scanId === options.scanId)) {
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
    const mutations = { records: 0, nodes: 0 };
    for (const observer of state.observers) {
      if (mutationsMatter(observer.takeRecords(), state.limits, mutations)) { invalidate(state); break; }
    }
    if (state.invalidated) return empty(state.scanId, { invalidated: true, notices: ['元ページが変わったため続きは取得できません。取得済み候補を確認するか、取り直してください。'] });
  } else {
    cleanup(state); clearReplay();
    state = { scanId: token(), cursor: null, invalidated: false, expiresAt: 0, timer: null,
      walkers: [], active: null, pending: null, nextElement: null, docs: new Set(), roots: new Set(),
      observers: [], listeners: [], seen: new Map(), seenBytes: 0, dataUrls: new Set(), dataBytes: 0,
      limits: boundedLimits(options.workLimits), work: { chars: 0, attempts: 0, nodes: 0 } };
    const sourceURL = document.URL || document.location?.href || document.baseURI || '';
    state.sourceURL = typeof sourceURL === 'string' && sourceURL.length <= DEFAULT_WORK.urlChars ? sourceURL : '';
    registry.controller = state;
  }
  const requestCursor = options.cursor || `${state.scanId}:page:${token()}`;
  const notices = new Set();
  const limits = state.limits;
  const work = { chars: 0, attempts: 0, nodes: 0 };
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = now();
  let workLimited = false, scanLimited = false;
  const timeAvailable = () => {
    if (now() - startedAt >= limits.callMillis) { workLimited = true; return false; }
    return true;
  };
  const charge = (kind, amount = 1) => {
    const scanLimit = kind === 'chars' ? limits.scanChars : limits.scanAttempts;
    const callLimit = kind === 'chars' ? limits.callChars : limits.callAttempts;
    if (state.work[kind] + amount > scanLimit) { scanLimited = true; return false; }
    if (work[kind] + amount > callLimit) { workLimited = true; return false; }
    work[kind] += amount; state.work[kind] += amount;
    return true;
  };
  const groupFor = element => {
    let id = registry.groups.get(element);
    if (!id) { id = `imagecrate-${++registry.nextGroup}`; registry.groups.set(element, id); }
    return id;
  };
  const observeRoot = (root, doc) => {
    const Observer = doc?.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (Observer) {
      const observer = new Observer(records => { if (mutationsMatter(records, limits)) invalidate(state); });
      try {
        observer.observe(root, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'sizes', 'media', 'type', 'style', 'class', 'width', 'height', 'alt', 'href'] });
        state.observers.push(observer);
      } catch { try { observer.disconnect(); } catch { /* detached root */ } }
    }
  };
  const pushRoot = (root, doc) => {
    if (state.roots.has(root)) return false;
    if (state.roots.size >= limits.roots) { notices.add('取得対象のDOMルート数を制限しました。'); return false; }
    try {
      const walker = doc.createTreeWalker(root, 1);
      state.roots.add(root);
      observeRoot(root, doc);
      state.walkers.push({ walker, doc });
      return true;
    } catch { notices.add('取得できないDOMルートがありました。'); return false; }
  };
  const pushDocument = doc => {
    if (state.docs.has(doc)) return;
    if (state.docs.size >= limits.documents) { notices.add('取得対象の埋め込み文書数を制限しました。'); return; }
    if (!pushRoot(doc, doc)) return;
    state.docs.add(doc);
    const onLoad = event => {
      if (['IMG', 'IFRAME', 'FRAME', 'SOURCE', 'LINK'].includes(event.target?.tagName)) invalidate(state);
    };
    const onResize = () => invalidate(state);
    try { if (doc.addEventListener) { doc.addEventListener('load', onLoad, true); state.listeners.push([doc, 'load', onLoad]); } } catch { /* detached frame */ }
    try { if (doc.defaultView?.addEventListener) { doc.defaultView.addEventListener('resize', onResize, true); state.listeners.push([doc.defaultView, 'resize', onResize]); } } catch { /* detached frame */ }
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
    // The length guards precede URL construction, including the base URL.
    if (!raw || raw.length > limits.urlChars || base.length > limits.urlChars) return null;
    try {
      const parsed = new URL(raw, base); parsed.hash = '';
      const url = parsed.href;
      if (parsed.username || parsed.password || url.length > limits.urlChars) return null;
      if (!/^https?:$/.test(parsed.protocol) && !/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);/i.test(url)) {
        if (parsed.protocol === 'blob:') notices.add('ページ内blob画像は今回の直接保存に未対応です。');
        return null;
      }
      return url;
    } catch { return null; }
  };
  const whitespace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
  const validDescriptor = descriptor => {
    if (!descriptor) return true;
    // The regex and split only ever receive at most 64 code units.
    if (descriptor.length > limits.descriptorChars) return false;
    const parts = descriptor.trim().split(/\s+/).filter(Boolean);
    return !parts.length || parts.length === 1 && (/^[1-9]\d*w$/.test(parts[0]) || /^(?:\d+(?:\.\d+)?|\.\d+)x$/.test(parts[0]) && Number.parseFloat(parts[0]) > 0);
  };
  const readChar = parser => {
    if (!charge('chars')) return null;
    // Check elapsed time during long tokens too. The parser position is stored
    // before yielding and no generator retains an earlier call's budget.
    if ((work.chars & 127) === 0 && !timeAvailable()) { work.chars--; state.work.chars--; return null; }
    return parser.text[parser.pos++];
  };
  const parseSrcset = parser => {
    while (true) {
      if (parser.phase === 'skip') {
        if (parser.pos >= parser.text.length) return { done: true };
        const ch = parser.text[parser.pos];
        if (whitespace(ch) || ch === ',') { if (readChar(parser) === null) return null; continue; }
        if (!charge('attempts')) return null;
        parser.start = parser.pos; parser.trailingCommas = 0; parser.phase = 'url';
      }
      if (parser.phase === 'url') {
        if (parser.pos < parser.text.length && !whitespace(parser.text[parser.pos])) {
          const ch = readChar(parser); if (ch === null) return null;
          parser.trailingCommas = ch === ',' ? parser.trailingCommas + 1 : 0;
          continue;
        }
        parser.end = parser.pos - parser.trailingCommas;
        parser.descriptorStart = parser.pos; parser.descriptorFirst = null; parser.descriptorEnd = parser.pos; parser.depth = 0;
        parser.phase = parser.trailingCommas ? 'emit' : 'descriptor';
      }
      if (parser.phase === 'descriptor') {
        if (parser.pos >= parser.text.length) parser.phase = 'emit';
        else {
          const ch = readChar(parser); if (ch === null) return null;
          if (ch === ',' && !parser.depth) parser.phase = 'emit';
          else {
            if (!whitespace(ch)) { parser.descriptorFirst ??= parser.pos - 1; parser.descriptorEnd = parser.pos; }
            if (ch === '(') parser.depth++;
            if (ch === ')') parser.depth = Math.max(0, parser.depth - 1);
            continue;
          }
        }
      }
      if (parser.phase === 'emit') {
        const descriptorStart = parser.descriptorFirst ?? parser.descriptorStart;
        const descriptorEnd = parser.trailingCommas ? descriptorStart : parser.descriptorEnd;
        const rawLength = parser.end - parser.start;
        const descriptorLength = descriptorEnd - descriptorStart;
        parser.phase = 'skip';
        if (!rawLength || rawLength > limits.urlChars || descriptorLength > limits.descriptorChars) continue;
        const descriptor = parser.text.slice(descriptorStart, descriptorEnd);
        if (!validDescriptor(descriptor)) continue;
        return { raw: parser.text.slice(parser.start, parser.end), descriptor };
      }
    }
  };
  const parseBackground = parser => {
    // A forward-only CSS url() recognizer. Malformed quote/parenthesis runs are
    // consumed once; there is no backtracking regex over page-controlled text.
    while (true) {
      if (parser.phase === 'search') {
        if (parser.pos >= parser.text.length) return { done: true };
        const ch = readChar(parser); if (ch === null) return null;
        const lower = ch.toLowerCase();
        parser.match = lower === 'url('[parser.match] ? parser.match + 1 : lower === 'u' ? 1 : 0;
        if (parser.match === 4) { parser.phase = 'begin'; parser.match = 0; }
        continue;
      }
      if (parser.phase === 'begin') {
        if (!charge('attempts')) return null;
        parser.phase = 'leading'; parser.escape = false; parser.invalid = false;
      }
      if (parser.pos >= parser.text.length) return { done: true };
      const index = parser.pos;
      const ch = readChar(parser); if (ch === null) return null;
      if (parser.phase === 'leading') {
        if (whitespace(ch)) continue;
        parser.quote = ch === '"' || ch === "'" ? ch : '';
        parser.start = parser.quote ? parser.pos : index;
        parser.phase = parser.quote ? 'quoted' : 'unquoted';
        if (parser.quote) continue;
      }
      if (parser.phase === 'quoted') {
        if (parser.escape) { parser.escape = false; continue; }
        if (ch === '\\') { parser.escape = true; continue; }
        if (ch === parser.quote) { parser.end = index; parser.phase = 'after'; }
        continue;
      }
      if (parser.phase === 'after') {
        if (whitespace(ch)) continue;
        if (ch !== ')') { parser.invalid = true; parser.phase = 'unquoted'; continue; }
      } else if (parser.phase === 'unquoted') {
        if (parser.escape) { parser.escape = false; continue; }
        if (ch === '\\') { parser.escape = true; continue; }
        if (ch !== ')') continue;
        parser.end = index;
      }
      if (ch === ')') {
        parser.phase = 'search';
        if (parser.invalid || parser.end - parser.start > limits.urlChars) continue;
        const raw = parser.text.slice(parser.start, parser.end).trim();
        if (raw) return { raw, descriptor: '' };
      }
    }
  };
  const newElement = ({ element: el, doc }) => {
    const picture = el.parentElement?.tagName === 'PICTURE' ? el.parentElement : null;
    const image = el.tagName === 'IMG' ? el : picture?.querySelector?.('img');
    const base = el.baseURI || doc.baseURI || '';
    return { el, doc, picture, image, base: typeof base === 'string' ? base : '',
      current: null, stage: 'current', index: 0, parser: null, normalization: null };
  };
  const metaFor = (active, source, attribute, url, descriptor = '') => {
    const { el, image, picture } = active;
    const isCurrent = !!active.current && url === active.current;
    const width = isCurrent ? image?.naturalWidth || 0 : 0;
    const height = isCurrent ? image?.naturalHeight || 0 : 0;
    return { source, attribute, groupId: source === 'background' ? `${groupFor(el)}-background` : groupFor(picture || el), descriptor,
      descriptorType: descriptor ? descriptor.slice(-1) : '', descriptorValue: descriptor ? Number.parseFloat(descriptor) : 0,
      media: source === 'background' ? '' : (el.getAttribute('media') || '').slice(0, 256),
      type: source === 'background' ? '' : (el.getAttribute('type') || '').slice(0, 80),
      alt: source === 'background' ? '' : (image?.alt || '').slice(0, 160), isCurrent: source === 'background' ? false : isCurrent,
      width: source === 'background' ? 0 : width, height: source === 'background' ? 0 : height,
      dimensionSource: source !== 'background' && width && height ? 'source' : 'unknown' };
  };
  const prepareRaw = (active, raw, source, attribute, descriptor = '', counted = false) => {
    if (typeof raw !== 'string' || !raw) return true;
    if (!counted && !charge('attempts')) return false;
    if (raw.length > limits.attributeChars || raw.length > limits.urlChars || active.base.length > limits.urlChars) {
      notices.add('長すぎる画像URL・属性または基準URLを除外しました。'); return true;
    }
    active.normalization = { raw, source, attribute, descriptor, remaining: raw.length + active.base.length };
    return true;
  };
  const prepareParser = (active, text, type, attribute) => {
    if (typeof text !== 'string' || !text) return true;
    if (text.length > limits.attributeChars) {
      if (!charge('attempts')) return false;
      notices.add('長すぎる画像属性を除外しました。'); return true;
    }
    active.parser = { text, type, attribute, pos: 0, phase: type === 'srcset' ? 'skip' : 'search', match: 0 };
    return true;
  };
  const advanceElement = active => {
    while (timeAvailable()) {
      if (active.normalization) {
        const job = active.normalization;
        // Account for URL/base input before invoking the bounded native parser.
        while (job.remaining) {
          const available = Math.min(job.remaining, limits.callChars - work.chars, limits.scanChars - state.work.chars, 128);
          if (!available) { charge('chars'); return null; }
          if (!charge('chars', available)) return null;
          job.remaining -= available;
          if (!timeAvailable()) return null;
        }
        active.normalization = null;
        const url = normalize(job.raw, active.base);
        if (job.attribute === 'currentSrc') active.current = url;
        if (url && (job.attribute !== 'currentSrc' || active.el.tagName === 'IMG')) return { url, meta: metaFor(active, job.source, job.attribute, url, job.descriptor) };
        continue;
      }
      if (active.parser) {
        const parser = active.parser;
        const candidate = parser.type === 'srcset' ? parseSrcset(parser) : parseBackground(parser);
        if (!candidate) return null;
        if (candidate.done) { active.parser = null; continue; }
        prepareRaw(active, candidate.raw, parser.type === 'srcset' ? 'srcset' : 'background', parser.attribute, candidate.descriptor, true);
        continue;
      }
      if (active.stage === 'current') {
        if (!prepareRaw(active, active.image?.currentSrc, 'img', 'currentSrc')) return null;
        active.stage = 'direct';
      } else if (active.stage === 'direct') {
        const attributes = ['src', 'data-src', 'data-original', 'data-lazy-src'];
        if (active.el.tagName === 'IMG' && active.index < attributes.length) {
          const attribute = attributes[active.index];
          if (!prepareRaw(active, active.el.getAttribute(attribute), 'img', attribute)) return null;
          active.index++;
        } else { active.stage = 'sets'; active.index = 0; }
      } else if (active.stage === 'sets') {
        const attributes = ['srcset', 'data-srcset'];
        if ((active.el.tagName === 'IMG' || active.el.tagName === 'SOURCE' && active.picture) && active.index < attributes.length) {
          const attribute = attributes[active.index];
          if (!prepareParser(active, active.el.getAttribute(attribute), 'srcset', attribute)) return null;
          active.index++;
        } else active.stage = 'background';
      } else if (active.stage === 'background') {
        let background = '';
        try { background = active.doc.defaultView.getComputedStyle(active.el).backgroundImage || ''; } catch { /* inaccessible or detached element */ }
        if (!prepareParser(active, background, 'background', 'background-image')) return null;
        active.stage = 'roots';
      } else {
        if (active.el.shadowRoot) pushRoot(active.el.shadowRoot, active.doc);
        if (active.el.tagName === 'IFRAME' || active.el.tagName === 'FRAME') {
          try {
            const child = active.el.contentDocument;
            if (child) pushDocument(child);
            else notices.add('別ドメインの埋め込み内は取得できません。');
          } catch { notices.add('別ドメインの埋め込み内は取得できません。'); }
        }
        return { done: true };
      }
    }
    return null;
  };
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
  let visited = 0, serializedBytes = 1024 + state.sourceURL.length * 2, capacityLimited = false;
  while (timeAvailable()) {
    if (!state.active && !state.pending) {
      if (state.work.nodes >= limits.scanNodes) { scanLimited = true; break; }
      if (visited >= NODE_LIMIT || items.size >= LIMIT) {
        state.nextElement ||= nextElement();
        if (state.nextElement) notices.add(visited >= NODE_LIMIT ? '12000要素を取得しました。続きの取得で残りを確認できます。' : '500候補を取得しました。続きの取得で残りを確認できます。');
        break;
      }
      const next = state.nextElement || nextElement(); state.nextElement = null;
      if (!next) break;
      visited++; work.nodes++; state.work.nodes++;
      state.active = newElement(next);
    }
    const candidate = state.pending || advanceElement(state.active);
    state.pending = null;
    if (!candidate) break;
    if (candidate.done) { state.active = null; continue; }
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
  if (scanLimited) notices.add('このスキャン全体の処理量の上限で取得を終了しました。取得済み候補は残っています。');
  else if (workLimited) notices.add('処理量の上限で区切りました。続きの取得で残りを確認できます。');
  const hasMore = !scanLimited && !!(state.active || state.pending || state.nextElement || state.walkers.length);
  const result = { items: [...items.values()], notices: [...notices], cursor: null, retryCursor: requestCursor, hasMore, scanId: state.scanId, sourceURL: state.sourceURL,
    work: { ...work, scanChars: state.work.chars, scanAttempts: state.work.attempts, scanNodes: state.work.nodes },
    ...(capacityLimited ? { capacityLimited: true } : {}), ...(workLimited && !scanLimited ? { workLimited: true } : {}), ...(scanLimited ? { scanLimited: true } : {}) };
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
