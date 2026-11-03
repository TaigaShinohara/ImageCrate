import test from 'node:test';
import assert from 'node:assert/strict';
import { canShareFiles, downloadBlob, shareOrDownloadZip } from '../extension/web-share.js';

test('canShareFiles returns false in headless node environment without navigator.share', () => {
  assert.equal(canShareFiles(), false);
});

test('shareOrDownloadZip falls back to downloadBlob when Web Share API is unavailable', async () => {
  const previousDocument = globalThis.document;
  const previousURL = globalThis.URL;
  let clicked = false, downloadedName = '', revoked = false;

  const fakeAnchor = {
    href: '',
    download: '',
    rel: '',
    click() { clicked = true; },
    remove() {}
  };

  globalThis.document = {
    body: {
      appendChild(node) { assert.equal(node, fakeAnchor); }
    },
    createElement(tag) {
      if (tag === 'a') return fakeAnchor;
      return {};
    }
  };

  globalThis.URL = {
    createObjectURL(blob) { return 'blob:https://test/123'; },
    revokeObjectURL(url) { revoked = true; }
  };

  try {
    const blob = new Blob(['sample-zip-bytes'], { type: 'application/zip' });
    const result = await shareOrDownloadZip(blob, 'my-archive.zip');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'download');
    assert.equal(clicked, true);
    assert.equal(fakeAnchor.download, 'my-archive.zip');
    assert.equal(fakeAnchor.href, 'blob:https://test/123');
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousURL === undefined) delete globalThis.URL; else globalThis.URL = previousURL;
  }
});

test('shareOrDownloadZip uses navigator.share when available and handles user cancellation', async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let shareCalledWith = null;
  let shouldAbort = false;

  const fakeNavigator = {
    share: async (data) => {
      shareCalledWith = data;
      if (shouldAbort) {
        const err = new Error('User cancelled');
        err.name = 'AbortError';
        throw err;
      }
    },
    canShare: (data) => Array.isArray(data?.files) && data.files.length > 0
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: fakeNavigator,
    configurable: true,
    writable: true
  });

  try {
    assert.equal(canShareFiles(), true);
    const blob = new Blob(['zip-content'], { type: 'application/zip' });

    // Successful share
    const successResult = await shareOrDownloadZip(blob, 'success.zip');
    assert.equal(successResult.ok, true);
    assert.equal(successResult.method, 'share');
    assert.equal(shareCalledWith.title, 'success.zip');
    assert.equal(shareCalledWith.files.length, 1);
    assert.equal(shareCalledWith.files[0].name, 'success.zip');

    // Aborted share
    shouldAbort = true;
    const abortResult = await shareOrDownloadZip(blob, 'abort.zip');
    assert.equal(abortResult.ok, false);
    assert.equal(abortResult.aborted, true);
    assert.equal(abortResult.method, 'share');
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  }
});
