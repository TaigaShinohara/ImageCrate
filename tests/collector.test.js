import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collect } from '../extension/collector.js';

function element(tagName, attributes = {}, children = []) {
  const node = { nodeType: 1, tagName: tagName.toUpperCase(), children, attributes, parentElement: null,
    currentSrc: '', naturalWidth: 0, naturalHeight: 0, alt: attributes.alt || '',
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) { return [...descendants(this)].find(child => child.tagName.toLowerCase() === selector) || null; } };
  for (const child of children) child.parentElement = node;
  return node;
}
function* descendants(root) {
  for (const child of root.children || []) { yield child; yield* descendants(child); }
}
function documentFor(children, baseURI = 'https://example.test/gallery/') {
  const observers = [], events = new Map();
  const eventMethods = () => ({
    addEventListener(type, listener) { const listeners = events.get(type) || new Set(); listeners.add(listener); events.set(type, listeners); },
    removeEventListener(type, listener) { events.get(type)?.delete(listener); },
  });
  const doc = { nodeType: 9, children, baseURI, observers, events, ...eventMethods(),
    // A whole-document querySelectorAll would defeat bounded traversal.
    querySelectorAll() { throw new Error('collector must use TreeWalker'); },
    createTreeWalker(root) { const iterator = descendants(root); return { nextNode: () => iterator.next().value || null }; },
    defaultView: { ...eventMethods(), getComputedStyle: node => ({ backgroundImage: node.background || 'none' }),
      MutationObserver: class {
        constructor(callback) { this.callback = callback; this.records = []; this.disconnected = false; observers.push(this); }
        observe(root, options) { this.root = root; this.options = options; }
        disconnect() { this.disconnected = true; this.root = null; this.records = []; }
        takeRecords() { return this.records.splice(0); }
      } },
  };
  const attach = root => {
    for (const child of root.children || []) {
      child.ownerDocument = doc; child.baseURI ||= baseURI;
      attach(child);
      if (child.shadowRoot) { child.shadowRoot.ownerDocument = doc; attach(child.shadowRoot); }
    }
  };
  attach(doc);
  return doc;
}
function withDocument(doc, callback) {
  const previous = globalThis.document;
  globalThis.document = doc;
  try { return callback(); }
  finally {
    collect({ dispose: true });
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
}
function collectSet(srcset) {
  const source = element('source', { srcset });
  return withDocument(documentFor([element('picture', {}, [source])]), () => collect().items.map(item => item.url));
}
const img = (name, extra = {}) => Object.assign(element('img', { src: name }), extra);
const chunks = first => {
  const pages = [first];
  while (pages.at(-1).hasMore) {
    assert.ok(pages.length < 100, 'continuation must make progress');
    pages.push(collect({ cursor: pages.at(-1).cursor }));
  }
  return pages;
};

test('srcset preserves internal CDN URL commas and signed queries', () => {
  assert.deepEqual(collectSet('https://cdn.test/upload/w_100,c_scale/photo.jpg 1x, https://cdn.test/upload/w_200,c_scale/photo.jpg?sig=1 2x'), [
    'https://cdn.test/upload/w_100,c_scale/photo.jpg', 'https://cdn.test/upload/w_200,c_scale/photo.jpg?sig=1',
  ]);
});
test('srcset separates trailing comma, width and density candidates', () => {
  assert.deepEqual(collectSet('a.png, b.png 400w, c.png 2x'), ['https://example.test/gallery/a.png', 'https://example.test/gallery/b.png', 'https://example.test/gallery/c.png']);
  assert.deepEqual(collectSet('bad.png 0x, good.png 1x, wrong.png nope'), ['https://example.test/gallery/good.png']);
});
test('candidate pages resume beyond 500 and each URL remains a candidate', () => {
  withDocument(documentFor(Array.from({ length: 1103 }, (_, i) => img(`${i}.png`))), () => {
    const first = collect();
    assert.equal(first.items.length, 500);
    assert.equal(first.hasMore, true);
    const pages = chunks(first);
    assert.deepEqual(pages.map(page => page.items.length), [500, 500, 103]);
    assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.url))).size, 1103);
    assert.ok(pages.every(page => page.scanId === first.scanId));
    assert.equal(pages.at(-1).cursor, null);
  });
});
test('one huge srcset resumes within an element without losing candidates', () => {
  const source = element('source', { srcset: Array.from({ length: 1203 }, (_, i) => `${i}.png ${i + 1}w`).join(', ') });
  withDocument(documentFor([element('picture', {}, [source])]), () => {
    const pages = chunks(collect());
    assert.deepEqual(pages.map(page => page.items.length), [500, 500, 203]);
    assert.equal(pages.at(-1).items.at(-1).descriptor, '1203w');
  });
});
test('12000-element boundary resumes rather than querying or stopping the document', () => {
  const nodes = Array.from({ length: 12001 }, () => element('div'));
  nodes.push(img('after-nodes.png'));
  withDocument(documentFor(nodes), () => {
    const first = collect();
    assert.deepEqual(first.items, []);
    assert.equal(first.hasMore, true);
    assert.match(first.notices.join(), /12000/);
    const next = collect({ cursor: first.cursor });
    assert.equal(next.items[0].url, 'https://example.test/gallery/after-nodes.png');
    assert.equal(next.hasMore, false);
  });
});
test('bounded LRU dedup does not halt traversal after its seen capacity', () => {
  withDocument(documentFor(Array.from({ length: 4503 }, (_, i) => img(`${i}.png`))), () => {
    const pages = chunks(collect());
    assert.equal(pages.flatMap(page => page.items).length, 4503);
    assert.equal(pages.at(-1).items.at(-1).url, 'https://example.test/gallery/4502.png');
  });
});
test('metadata keeps picture relationships, descriptors, media and density-corrected dimensions', () => {
  const image = img('fallback.jpg', { currentSrc: 'https://example.test/gallery/large.avif', naturalWidth: 800, naturalHeight: 600, alt: '山の写真' });
  const source = element('source', { srcset: 'small.avif 400w, large.avif 1600w', media: '(min-width: 600px)', type: 'image/avif' });
  const picture = element('picture', {}, [source, image]);
  withDocument(documentFor([picture]), () => {
    const first = collect();
    const large = first.items.find(item => item.url.endsWith('/large.avif'));
    const small = first.items.find(item => item.url.endsWith('/small.avif'));
    const fallback = first.items.find(item => item.url.endsWith('/fallback.jpg'));
    assert.equal(large.descriptor, '1600w');
    assert.equal(large.descriptorType, 'w');
    assert.equal(large.descriptorValue, 1600);
    assert.equal(large.media, '(min-width: 600px)');
    assert.equal(large.type, 'image/avif');
    assert.equal(large.alt, '山の写真');
    assert.equal(large.isCurrent, true);
    assert.equal(large.width, 800);
    assert.equal(large.dimensionSource, 'source');
    assert.equal(small.width, 0);
    assert.equal(small.dimensionSource, 'unknown');
    assert.equal(small.groupId, large.groupId);
    assert.equal(fallback.groupId, large.groupId);
    assert.ok(large.occurrences.some(value => value.attribute === 'currentSrc'));
    assert.ok(large.occurrences.some(value => value.attribute === 'srcset'));
    assert.equal(collect().items.find(item => item.url === large.url).groupId, large.groupId, 'stable across a fresh scan of the same element');
    assert.deepEqual(picture.attributes, {}, 'no page attribute is added');
    assert.deepEqual(source.attributes, { srcset: 'small.avif 400w, large.avif 1600w', media: '(min-width: 600px)', type: 'image/avif' });
  });
});
test('both native and lazy srcset candidates retain source density descriptors', () => {
  const image = element('img', { srcset: 'a.png 1x', 'data-srcset': 'b.png 2x' });
  withDocument(documentFor([image]), () => {
    const items = collect().items;
    assert.deepEqual(items.map(item => [item.descriptorType, item.descriptorValue, item.attribute]), [['x', 1, 'srcset'], ['x', 2, 'data-srcset']]);
  });
});
test('500th candidate still gains metadata from later attributes in its element', () => {
  const last = element('img', { src: 'last.png', srcset: 'last.png 2x' });
  withDocument(documentFor([...Array.from({ length: 499 }, (_, i) => img(`${i}.png`)), last]), () => {
    const first = collect();
    assert.equal(first.items.length, 500);
    assert.equal(first.items.at(-1).descriptor, '2x');
    assert.equal(first.items.at(-1).occurrences.length, 2);
    assert.equal(first.hasMore, false);
  });
});
test('metadata of a URL seen on an earlier page is emitted as an update', () => {
  const shared = img('0.png', { currentSrc: 'https://example.test/gallery/0.png', naturalWidth: 640, naturalHeight: 480, alt: '後の説明' });
  withDocument(documentFor([...Array.from({ length: 500 }, (_, i) => img(`${i}.png`)), shared]), () => {
    const first = collect();
    const next = collect({ cursor: first.cursor });
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].width, 640);
    assert.equal(next.items[0].alt, '後の説明');
    assert.ok(next.items[0].occurrences.length > first.items[0].occurrences.length);
  });
});
test('open shadow and same-origin frames remain in the continuation stack', () => {
  const shadow = element('section');
  shadow.shadowRoot = { nodeType: 11, children: [img('shadow.png')] };
  const frame = element('iframe'); frame.contentDocument = documentFor([img('frame.png')], 'https://example.test/frame/');
  const blocked = element('iframe'); blocked.contentDocument = null;
  withDocument(documentFor([...Array.from({ length: 500 }, (_, i) => img(`${i}.png`)), shadow, frame, blocked]), () => {
    const pages = chunks(collect());
    const urls = pages.flatMap(page => page.items.map(item => item.url));
    assert.ok(urls.includes('https://example.test/gallery/shadow.png'));
    assert.ok(urls.includes('https://example.test/frame/frame.png'));
    assert.match(pages.flatMap(page => page.notices).join(), /別ドメイン/);
    assert.ok(frame.contentDocument.observers.every(observer => observer.disconnected));
  });
});
test('DOM changes invalidate the continuation and never restart from the first element', () => {
  const doc = documentFor(Array.from({ length: 502 }, (_, i) => img(`${i}.png`)));
  withDocument(doc, () => {
    const first = collect();
    doc.observers[0].records.push({ type: 'attributes', attributeName: 'src', target: doc.children[501] });
    const next = collect({ cursor: first.cursor });
    assert.equal(next.invalidated, true);
    assert.deepEqual(next.items, []);
    assert.equal(next.hasMore, false);
    assert.ok(doc.observers.every(observer => observer.disconnected));
    assert.equal(collect().items[0].url, first.items[0].url, 'only an explicit restart scans from the beginning');
  });
});
test('text-only clock replacements do not invalidate delivered or queued mutation records', () => {
  for (const delivery of ['callback', 'queued']) {
    const doc = documentFor(Array.from({ length: 501 }, (_, i) => img(`${i}.png`)));
    withDocument(doc, () => {
      const first = collect();
      const records = [{ type: 'childList', addedNodes: [{ nodeType: 3, data: '12:01' }], removedNodes: [{ nodeType: 3, data: '12:00' }] }];
      if (delivery === 'callback') doc.observers[0].callback(records);
      else doc.observers[0].records.push(...records);
      const next = collect({ cursor: first.cursor });
      assert.equal(next.invalidated, undefined, delivery);
      assert.equal(next.items.length, 1, delivery);
      assert.ok(next.items[0].url.endsWith('/500.png'));
    });
  }
});
test('element child-list changes still invalidate continuation', () => {
  const doc = documentFor(Array.from({ length: 501 }, (_, i) => img(`${i}.png`)));
  withDocument(doc, () => {
    const first = collect();
    doc.observers[0].records.push({ type: 'childList', addedNodes: [element('img')], removedNodes: [] });
    assert.equal(collect({ cursor: first.cursor }).invalidated, true);
  });
});
test('load and resize invalidate responsive source information', () => {
  for (const type of ['load', 'resize']) {
    const doc = documentFor(Array.from({ length: 501 }, (_, i) => img(`${i}.png`)));
    withDocument(doc, () => {
      const first = collect();
      for (const listener of doc.events.get(type)) listener({ target: doc.children[0] });
      assert.equal(collect({ cursor: first.cursor }).invalidated, true);
    });
  }
});
test('dispose releases observers, listeners and continuation references', () => {
  const doc = documentFor(Array.from({ length: 501 }, (_, i) => img(`${i}.png`)));
  withDocument(doc, () => {
    const first = collect();
    assert.equal(collect({ dispose: true, cursor: first.cursor }).disposed, true);
    assert.ok(doc.observers.every(observer => observer.disconnected));
    assert.ok([...doc.events.values()].every(listeners => !listeners.size));
    assert.equal(collect({ cursor: first.cursor }).invalidated, true);
    assert.notEqual(collect().scanId, first.scanId);
  });
});
test('expired and foreign cursors fail without advancing the live scan', () => {
  withDocument(documentFor(Array.from({ length: 501 }, (_, i) => img(`${i}.png`))), () => {
    const first = collect();
    assert.equal(collect({ cursor: 'foreign-token' }).invalidated, true);
    assert.equal(collect({ cursor: first.cursor }).items.length, 1);
    const restarted = collect();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 5 * 60 * 1000 + 1;
    try { assert.equal(collect({ cursor: restarted.cursor }).invalidated, true); }
    finally { Date.now = originalNow; }
  });
});
test('the previous page can be replayed, including initial and terminal pages', () => {
  const doc = documentFor(Array.from({ length: 501 }, (_, i) => img(`${i}.png`)));
  withDocument(doc, () => {
    const first = collect();
    assert.deepEqual(collect({ cursor: first.retryCursor }), first);
    const last = collect({ cursor: first.cursor });
    assert.equal(last.hasMore, false);
    assert.ok(doc.observers.every(observer => observer.disconnected), 'terminal page releases DOM references before replay');
    assert.deepEqual(collect({ cursor: first.cursor }), last);
    assert.deepEqual(collect({ cursor: last.retryCursor }), last);
    assert.equal(collect({ cursor: first.retryCursor }).invalidated, true, 'only one serialized page is kept');
  });
});
test('serialized capacity splits a page and never discards its pending candidate', () => {
  withDocument(documentFor(Array.from({ length: 20 }, (_, i) => img(`${i}.png`))), () => {
    const pages = [collect({ maxSerializedBytes: 8000 })];
    while (pages.at(-1).hasMore) pages.push(collect({ cursor: pages.at(-1).cursor, maxSerializedBytes: 8000 }));
    assert.ok(pages.length > 1);
    assert.equal(pages.flatMap(page => page.items).length, 20);
    assert.ok(pages[0].capacityLimited);
  });
});
test('an empty capacity refusal retries its held candidate with a recovered byte budget', () => {
  withDocument(documentFor([img('first.png'), img('second.png')]), () => {
    const refused = collect({ maxSerializedBytes: 1024 });
    assert.deepEqual(refused.items, []);
    assert.equal(refused.capacityLimited, true);
    const recovered = collect({ cursor: refused.retryCursor, maxSerializedBytes: 8000 });
    assert.equal(recovered.scanId, refused.scanId);
    assert.deepEqual(recovered.items.map(item => item.url), ['https://example.test/gallery/first.png', 'https://example.test/gallery/second.png']);
    assert.equal(recovered.hasMore, false);
    assert.deepEqual(collect({ cursor: recovered.retryCursor }), recovered, 'an admitted page is replayable normally');
  });
});
test('data byte and long URL limits remain bounded while later HTTP candidates are scanned', () => {
  const data = 'data:image/png;base64,';
  const nodes = Array.from({ length: 6 }, (_, i) => img(data + String(i).repeat(110000)));
  nodes.push(img('https://cdn.test/' + 'x'.repeat(131073)), img('after-limits.png'), img('blob:https://example.test/value'));
  withDocument(documentFor(nodes), () => {
    const result = collect();
    assert.equal(result.items.filter(item => item.url.startsWith('data:')).length, 4);
    assert.ok(result.items.some(item => item.url.endsWith('/after-limits.png')));
    assert.match(result.notices.join(), /埋め込み画像/);
    assert.match(result.notices.join(), /blob/);
    assert.ok(result.items.every(item => item.url.length <= 131072));
  });
});
test('the injected function runs from its serialized source without module bindings', () => {
  const doc = documentFor([img('serialized.png')]);
  const context = { document: doc, URL, setTimeout, clearTimeout };
  const result = vm.runInNewContext(`(${collect.toString()})()`, context);
  assert.equal(result.items[0].url, 'https://example.test/gallery/serialized.png');
  vm.runInNewContext(`(${collect.toString()})({dispose:true})`, context);
});
