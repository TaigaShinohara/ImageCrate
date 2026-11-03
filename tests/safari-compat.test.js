import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings, destinationLabel } from '../extension/utils.js';

test('safari environment without chrome.downloads loads background module safely', async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const store = new Map();
  const tabs = new Map([
    [1, { id: 1, url: 'https://example.com/', title: 'Example' }],
    [10, { id: 10, url: 'chrome-extension://safari-test/workspace.html?id=safari-work' }],
  ]);

  // Safari Web Extension simulation: chrome.downloads is completely undefined
  const fakeChrome = {
    runtime: {
      id: 'safari-extension-id',
      getURL: (path) => `safari-web-extension://safari-extension-id/${path}`,
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => {} },
    },
    tabs: {
      get: async (id) => tabs.get(id) || null,
      query: async () => [...tabs.values()],
      create: async (params) => {
        const id = tabs.size + 1;
        const tab = { id, ...params };
        tabs.set(id, tab);
        return tab;
      },
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
    storage: {
      session: {
        get: async (keys) => {
          if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
          if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)]));
          return Object.fromEntries(store);
        },
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
        },
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    alarms: {
      create: () => {},
      clear: () => {},
      onAlarm: { addListener: () => {} },
    },
    // Notice: chrome.downloads is intentionally omitted / undefined
  };

  Object.defineProperty(globalThis, 'chrome', {
    value: fakeChrome,
    configurable: true,
    writable: true,
  });

  try {
    // Dynamic import to verify module evaluation succeeds without throwing on missing downloads listeners
    const bg = await import(`../extension/background.js?safari-test=${Date.now()}`);
    assert.ok(bg, 'background.js evaluates successfully without chrome.downloads');
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else delete globalThis.chrome;
  }
});

test('mobile environment or missing chrome.downloads resolves default destination to zip', () => {
  const isMobileClient = (nav) => (typeof nav !== 'undefined' && (nav.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android/i.test(nav.userAgent || '')));
  const hasChromeDownloads = (ch) => Boolean(ch?.downloads?.download);

  // Case 1: Desktop Chrome with downloads API -> default 'downloads'
  const desktopChromeNav = { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
  const desktopChromeObj = { downloads: { download: () => {} } };
  const desktopDefault = (!isMobileClient(desktopChromeNav) && hasChromeDownloads(desktopChromeObj)) ? 'downloads' : 'zip';
  assert.equal(desktopDefault, 'downloads', 'Desktop Chrome defaults to downloads folder');

  // Case 2: Mobile Safari (iPhone) -> default 'zip'
  const iphoneNav = { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' };
  const iphoneChromeObj = {}; // No downloads API in mobile Safari
  const iphoneDefault = (!isMobileClient(iphoneNav) && hasChromeDownloads(iphoneChromeObj)) ? 'downloads' : 'zip';
  assert.equal(iphoneDefault, 'zip', 'iPhone Safari defaults to ZIP for Share Sheet integration');

  // Case 3: Android Chrome (touch enabled) -> default 'zip'
  const androidNav = { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' };
  const androidDefault = (!isMobileClient(androidNav) && hasChromeDownloads(desktopChromeObj)) ? 'downloads' : 'zip';
  assert.equal(androidDefault, 'zip', 'Mobile touch device defaults to ZIP for easy one-tap sharing');

  // Case 4: Any browser without downloads API -> default 'zip'
  const fallbackDefault = (!isMobileClient(desktopChromeNav) && hasChromeDownloads({})) ? 'downloads' : 'zip';
  assert.equal(fallbackDefault, 'zip', 'Missing downloads API falls back to zip');
});

test('saveSettings and destinationLabel correctly format mobile zip batches', () => {
  const settings = saveSettings({ destination: 'zip', folderName: 'iPhone画像まとめ' }, 'デフォルト');
  assert.equal(settings.destination, 'zip');
  assert.equal(settings.folderName, 'iPhone画像まとめ');
  assert.equal(destinationLabel(settings), 'ZIP保存 / iPhone画像まとめ.zip');
});
