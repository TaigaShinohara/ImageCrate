// Minimum-version acceptance. Set CHROME_EXECUTABLE to the official Chrome for
// Testing 116 executable. Only a temp copy/profile and localhost fixture are used.
// Uses --load-extension (available in 116), never CDP Extensions.loadUnpacked.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executablePath = process.env.CHROME_EXECUTABLE;
if (!executablePath) throw new Error('Set CHROME_EXECUTABLE to the official Chrome for Testing 116 executable.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'imagecrate-compat-qa-'));
const extension = join(scratch, 'extension');
const output = process.env.QA_OUTPUT_DIR || scratch;
const profile = join(scratch, 'profile');
const downloads = join(scratch, 'downloads');
await cp(join(repo, 'extension'), extension, { recursive: true });
await mkdir(output, { recursive: true });
await mkdir(downloads);
await mkdir(join(profile, 'Default'), { recursive: true });
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
const workerPath = join(extension, 'background.js');
await writeFile(workerPath, await readFile(workerPath, 'utf8') + `
globalThis.__openWorkspace=openWorkspace;
globalThis.__compatEvents=[];
chrome.tabs.onRemoved.addListener(id=>globalThis.__compatEvents.push({event:'tab-removed',id}));
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session')globalThis.__compatEvents.push({event:'session-change',changes:Object.entries(changes).map(([key,value])=>({key,removed:!value.newValue,closed:value.newValue?.closed}))});});
`);
const manifestPath = join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(manifestPath, JSON.stringify(manifest));
const svg = (width, height, color = '#cc3366') => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`;
const originalSVG = svg(640, 480);
const held = new Set();
let releaseHigh = false;
const html = body => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Chrome 116 合成試験</title></head><body>${body}</body></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.endsWith('.svg') || path === '/original-image') {
    response.setHeader('Content-Type', 'image/svg+xml');
    if (path === '/held.svg' && !releaseHigh) { held.add(response); response.on('close', () => held.delete(response)); return; }
    return response.end(path === '/original-image' ? originalSVG : svg(path === '/held.svg' ? 1800 : 640, path === '/held.svg' ? 1200 : 480));
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (path === '/many') return response.end(html(Array.from({ length: 501 }, (_, index) => `<img data-src="/candidate.svg?i=${index}" alt="候補${index}">`).join('')));
  response.end(html('<img src="/normal.svg" alt="既知の画像"><img data-src="/held.svg" alt="寸法未確認"><img data-src="/original-image" alt="拡張子なしの画像">'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { browser: '', checks: [], alarms: null, downloads: [], limits: [
  'Official Chrome for Testing executable with an isolated temporary profile and extension copy.',
  'Localhost synthetic images only. No personal browser profile, native picker or human usability verification.',
  'Only the temporary profile Preferences select the download directory; normal Chrome filename decisions remain active.',
] };
const checked = label => { report.checks.push(label); console.log(`PASS ${label}`); };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, acceptDownloads: false, viewport: { width: 1200, height: 900 },
    // Chrome 116's plain --headless is the older mode without extension support.
    ignoreDefaultArgs: ['--headless', '--disable-extensions'],
    args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
  });
  report.browser = context.browser().version();
  assert.match(report.browser, /^116\./, 'this acceptance must run the declared minimum major version');
  let worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: value => value.url().startsWith('chrome-extension://') });
  // The serviceworker target can be reported before the extension module and
  // privileged API bindings finish starting on older Chrome versions.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await worker.evaluate(() => typeof globalThis.__openWorkspace === 'function')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  report.environment = await worker.evaluate(() => ({ url: location.href, id: chrome.runtime?.id, chromeAPIs: Object.keys(chrome), openWorkspace: typeof globalThis.__openWorkspace }));
  assert.equal(report.environment.openWorkspace, 'function');
  assert.equal(report.environment.id, new URL(worker.url()).host);
  checked('Chrome 116 MV3 module worker and unpacked extension startup');
  report.alarms = await worker.evaluate(async () => {
    const name = 'imagecrate-compat-api-probe';
    const creation = chrome.alarms.create(name, { delayInMinutes: 1, periodInMinutes: 1 });
    const thenable = typeof creation?.then === 'function';
    await creation;
    const created = await chrome.alarms.get(name);
    const cleared = await chrome.alarms.clear(name);
    const remaining = await chrome.alarms.get(name);
    return { thenable, created: { name: created.name, periodInMinutes: created.periodInMinutes }, cleared, absent: remaining === undefined };
  });
  assert.equal(report.alarms.thenable, true);
  assert.equal(report.alarms.created.periodInMinutes, 1);
  assert.equal(report.alarms.cleared, true); assert.equal(report.alarms.absent, true);
  checked('Chrome 116 alarms Promise create/get/clear with a one-minute period');

  const errors = [];
  const stateFor = async manager => {
    const state = await worker.evaluate(async url => {
    const key = `workspace:${new URL(url).searchParams.get('id')}`;
    return (await chrome.storage.session.get(key))[key];
    }, manager.url());
    if (!state) report.sessionDiagnostics = await worker.evaluate(async url => ({
      managerURL: url, tabs: (await chrome.tabs.query({})).map(tab => ({ id: tab.id, url: tab.url })),
      contexts: await chrome.runtime.getContexts({ contextTypes: ['TAB'] }),
      sessions: Object.entries(await chrome.storage.session.get(null)).map(([key, state]) => ({ key, closed: state.closed, workspaceTabId: state.workspaceTabId, jobs: state.jobs })),
      events: globalThis.__compatEvents,
    }), manager.url());
    return state;
  };
  const poll = async (manager, predicate, label) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await stateFor(manager);
      if (!state) throw new Error('Workspace session disappeared while its page remained open; see sessionDiagnostics in compat-report.json.');
      if (predicate(state)) return state;
      await manager.waitForTimeout(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const open = async source => {
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(value => value.url === url), source.url());
    const [manager] = await Promise.all([context.waitForEvent('page'), worker.evaluate(tab => globalThis.__openWorkspace(tab), tab)]);
    manager.on('pageerror', error => errors.push(error.message));
    await manager.waitForLoadState('domcontentloaded');
    await manager.waitForFunction(() => document.querySelector('#message')?.textContent.includes('候補を取得'));
    return manager;
  };
  const source = await context.newPage();
  await source.goto(`${origin}/many`);
  const many = await open(source);
  let state = await stateFor(many);
  assert.equal(state.items.length, 500); assert.equal(state.scan.hasMore, true);
  const kept = state.items[0].url;
  await many.locator('.image-select').first().check();
  await poll(many, state => state.selectedURLs.includes(kept), 'persisted selection');
  await many.reload();
  await many.waitForFunction(() => document.querySelector('#message').textContent.includes('前回'));
  assert.equal(await many.locator('.image-select:checked').count(), 1);
  await many.locator('#next-page').click();
  state = await poll(many, state => state.items.length === 1 && !state.scan.hasMore, '501st candidate');
  assert.ok(state.items[0].url.endsWith('?i=500'));
  assert.deepEqual(state.selectedURLs, [kept]);
  assert.equal(state.selectedItems[0].url, kept);
  await many.locator('#view-selected').click();
  assert.equal(await many.locator('.card').count(), 1);
  assert.equal(await many.locator('.image-select').getAttribute('data-url'), kept);
  checked('Chrome 116 collection, 501 continuation and selected item retention/reload');
  await many.close();

  await source.goto(`${origin}/fixture`);
  const manager = await open(source);
  report.ownerProbe = await worker.evaluate(async url => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const own = contexts.find(context => context.documentUrl === url);
    return { contexts, owner: own ? await chrome.tabs.get(own.tabId) : null };
  }, manager.url());
  await manager.locator('#filters > summary').click(); await manager.locator('#width').fill('1000');
  assert.equal(await manager.locator(`.card[data-url="${origin}/held.svg"]`).count(), 1);
  assert.equal(await manager.locator('#dimension-note').isVisible(), true);
  releaseHigh = true;
  for (const response of held) response.end(svg(1800, 1200));
  held.clear();
  await manager.waitForFunction(origin => [...document.querySelectorAll('[data-dimensions]')].some(node => node.dataset.dimensions === `${origin}/held.svg` && node.textContent.includes('1800')), origin);
  await manager.locator('#reset-filters').click();
  checked('Chrome 116 unknown dimensions remain available under minimum-width filtering');
  const preview = manager.locator(`.card[data-url="${origin}/held.svg"] .preview-open`);
  await preview.click();
  await manager.waitForFunction(() => { const image = document.querySelector('#preview-stage img'); return document.querySelector('#image-preview').open && image?.complete && image.naturalWidth === 1800; });
  assert.ok(await manager.locator('#preview-stage img').evaluate(image => image.getBoundingClientRect().width <= image.parentElement.clientWidth + 1));
  await manager.locator('#preview-zoom').click();
  assert.equal(await manager.locator('#preview-stage img').evaluate(image => Math.round(image.getBoundingClientRect().width)), 1800);
  await manager.keyboard.press('Escape');
  assert.equal(await manager.evaluate(() => document.activeElement.classList.contains('preview-open')), true);
  checked('Chrome 116 modal preview fit/100% and Escape focus restoration');

  const before = (await stateFor(manager)).saveSettings || null;
  const footerBefore = await manager.locator('#destination-summary').textContent();
  await manager.locator('#destination-change').click();
  await manager.locator('#folder-name').fill('取り消す名前'); await manager.locator('#output-format').selectOption('png');
  await manager.keyboard.press('Escape');
  await manager.waitForFunction(() => !document.querySelector('#save-settings').open);
  assert.deepEqual((await stateFor(manager)).saveSettings || null, before);
  assert.equal(await manager.locator('#destination-summary').textContent(), footerBefore);
  checked('Chrome 116 settings cancel preserves the applied name/format');

  const session = await context.newCDPSession(manager);
  // Playwright interception/behavior:allow can bypass onDeterminingFilename.
  // Restore Chrome's normal path so MIME-derived naming is actually exercised.
  await session.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  const settings = async format => {
    await manager.locator('#destination-change').click();
    await manager.locator('#destination-downloads').check();
    await manager.locator('#folder-name').fill(`Chrome116_${format}`);
    await manager.locator('#output-format').selectOption(format);
    await manager.locator('#settings-done').click();
    await manager.waitForFunction(() => !document.querySelector('#save-settings').open);
    await poll(manager, state => state.saveSettings?.format === format, 'applied output format');
  };
  const save = async format => {
    await settings(format);
    if (await manager.locator('#clear').isEnabled()) { await manager.locator('#clear').click(); await poll(manager, state => !state.selectedURLs.length, 'cleared selection'); }
    await manager.locator(`.card[data-url="${origin}/original-image"] .image-select`).check();
    await poll(manager, state => state.selectedURLs.includes(`${origin}/original-image`), 'selected original image');
    const previous = (await stateFor(manager)).batch?.id;
    await manager.locator('#save').click();
    const result = await poll(manager, state => state.batch?.id !== previous && state.jobs.length === 1 && ['complete', 'interrupted'].includes(state.jobs[0].status), 'actual saved file');
    assert.equal(result.jobs[0].status, 'complete', result.jobs[0].error);
    const job = result.jobs[0];
    const download = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
    assert.equal(download.state, 'complete');
    assert.equal(download.filename, join(downloads, job.filename), 'normal Chrome uses the extension\'s requested MIME-resolved path');
    assert.equal(job.actualFilename, download.filename);
    const bytes = await readFile(download.filename);
    report.downloads.push({ format, requested: job.filename, actual: download.filename, bytes: bytes.length, mime: download.mime });
    return { job, bytes };
  };
  const original = await save('original');
  assert.equal(original.job.typeKnown, true); assert.ok(original.job.filename.endsWith('.svg'));
  assert.deepEqual(original.bytes, Buffer.from(originalSVG));
  checked('Chrome 116 extensionless original download MIME naming and actual SVG bytes');
  const png = await save('png');
  assert.ok(png.job.filename.endsWith('.png'));
  assert.deepEqual([...png.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const decoded = await manager.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    try {
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, rgba: [...context.getImageData(1, 1, 1, 1).data] };
    } finally { image.close(); }
  }, [...png.bytes]);
  assert.deepEqual(decoded, { width: 640, height: 480, rgba: [204, 51, 102, 255] });
  checked('Chrome 116 SVG to real PNG conversion/download, signature, dimensions and decoded pixels');
  assert.deepEqual(errors, []);
  await manager.screenshot({ path: join(output, 'chrome116-workspace.png') });
  await writeFile(join(output, 'compat-report.json'), JSON.stringify(report, null, 2));
  console.log(`Chrome ${report.browser} compatibility PASS (${report.checks.length} checks). Results: ${output}`);
  if (process.env.QA_KEEP) console.log(`Temporary profile retained: ${scratch}`);
} catch (error) {
  report.failure = error.stack || String(error);
  await writeFile(join(output, 'compat-report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  for (const response of held) response.destroy();
  await context?.close(); await new Promise(resolve => server.close(resolve));
  if (!process.env.QA_KEEP) await rm(scratch, { recursive: true, force: true });
}
