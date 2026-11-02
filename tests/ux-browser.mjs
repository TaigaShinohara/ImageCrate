// UX acceptance in an isolated Chrome profile, temporary extension and localhost.
// The native folder picker alone is replaced at its boundary; handles are real
// OPFS FileSystemDirectoryHandles. This does not test OS consent or human ease.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'imagecrate-ux-qa-'));
const extension = join(scratch, 'extension');
const output = process.env.QA_OUTPUT_DIR || join(scratch, 'screenshots');
const downloadFolder = join(scratch,'downloads');
await mkdir(join(scratch,'profile','Default'),{recursive:true});await mkdir(downloadFolder);
await writeFile(join(scratch,'profile','Default','Preferences'),JSON.stringify({download:{default_directory:downloadFolder,prompt_for_download:false}}));
await cp(join(repo, 'extension'), extension, { recursive: true });
await mkdir(output, { recursive: true });
const workerPath = join(extension, 'background.js');
await writeFile(workerPath, (await readFile(workerPath, 'utf8'))
  .replace('let finished=false;', 'globalThis.__qaFilenameEvents ||= [];globalThis.__qaFilenameEvents.push(item);let finished=false;')
  .replace('if (alarm.name !== RECOVERY_ALARM)', 'globalThis.__qaAlarmEvents ||= [];globalThis.__qaAlarmEvents.push(alarm.name);if (alarm.name !== RECOVERY_ALARM)')
  + '\nglobalThis.__qaOpenWorkspace=openWorkspace;globalThis.__qaCollect=collect;globalThis.__qaSerial=serial;globalThis.__qaBudget={createTransferBudget,reserveTransferAttempt};\n');
const manifestPath = join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(manifestPath, JSON.stringify(manifest));

let releaseHigh = false;
const held = new Set();
const svg = (width = 400, height = 300, color = '#6351d9') => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`;
const originalSVG = svg(640, 480, '#aa3377');
// Uniform, valid PNG pixels keep format detection independent of a misleading
// URL suffix. GIF has a 400×300 logical screen and a single 1×1 red frame.
const pngChunk = (type, data) => {
  const name = Buffer.from(type), body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
};
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(400); pngHeader.writeUInt32BE(300, 4); pngHeader[8] = 8; pngHeader[9] = 6;
const pngPixels = Buffer.alloc((400 * 4 + 1) * 300, 255);
for (let row = 0; row < 300; row++) pngPixels[row * (400 * 4 + 1)] = 0;
const adPNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', pngHeader), pngChunk('IDAT', deflateSync(pngPixels)), pngChunk('IEND', Buffer.alloc(0))]);
const adGIF = Buffer.from([...Buffer.from('GIF89a'), 144, 1, 44, 1, 128, 0, 0, 255, 0, 0, 0, 0, 255,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59]);
const doc = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const candidates = count => Array.from({ length: count }, (_, i) => `<img data-src="/tile.svg?i=${i}" alt="合成候補${i}">`).join('');
const fixture = doc('ImageCrate UX 合成ページ', `
  <h1>Local UX fixture</h1>
  <img src="/red.svg" alt="赤の画像">
  <img srcset="/density-high.svg 2x" alt="密度指定の高解像度">
  <picture><source srcset="/variant-small.svg 1x, /variant-large.svg 2x" type="image/svg+xml"><img src="/variant-small.svg" alt="同じ画像の別候補"></picture>
  <img data-src="/held-high.svg" alt="まだ寸法未確認の高解像度">
  <img src="/blue.svg" alt="青の画像">
`);
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/ad-known.gif' || path === '/ad-opaque') { response.setHeader('Content-Type', 'image/gif'); return response.end(adGIF); }
  if (path === '/ad-disguised.gif') { response.setHeader('Content-Type', 'image/png'); return response.end(adPNG); }
  if (path === '/ad-unknown') { response.setHeader('Content-Type', 'image/svg+xml'); return response.end(svg()); }
  if (path === '/original-image' || path === '/retry-image') {
    response.setHeader('Content-Type', 'image/svg+xml');
    return response.end(originalSVG);
  }
  if (path.endsWith('.svg')) {
    response.setHeader('Content-Type', 'image/svg+xml');
    if (path === '/held-high.svg' && !releaseHigh) {
      held.add(response); response.on('close', () => held.delete(response)); return;
    }
    return response.end(svg(path === '/ad-banner.svg' ? 900 : path.includes('high') || path.includes('large') ? 1800 : 400, path === '/ad-small.svg' ? 199 : path.includes('high') || path.includes('large') ? 1200 : 300, path.includes('blue') ? '#56a4bf' : '#6351d9'));
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (path === '/ad-filter') return response.end(doc('広告候補の除外テスト', '<img src="/ad-normal.svg"><img src="/ad-banner.svg"><img src="/ad-small.svg"><img data-src="/ad-known.gif"><img data-src="/ad-opaque"><img data-src="/ad-disguised.gif"><img data-src="/ad-unknown">'));
  if (path === '/candidates' || path === '/mutation') return response.end(doc(path, candidates(501)));
  // html/head/meta/title/body = five elements, plus 11995 divs and the final img.
  if (path === '/nodes') return response.end(doc('12001 elements', '<div></div>'.repeat(11995) + '<img data-src="/after-nodes.svg">'));
  if (path === '/frame') return response.end(doc('frame', '<img data-src="/frame.svg">'));
  if (path === '/nested') return response.end(doc('nested', candidates(500) + '<div id="host"></div><iframe src="/frame"></iframe><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML=\'<img data-src="/shadow.svg">\';</script>'));
  response.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { browser: '', checks: [], geometry: [], screenshots: [], limits: [
  'Local synthetic data and a temporary Chrome profile only.',
  'Native picker cancellation is simulated at the API boundary with real OPFS handles.',
  'No claim of native OS picker, real activeTab toolbar consent, screen reader or human usability verification.',
] };
const checked = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const screenshot = async (page, name) => { const path = join(output, `${name}.png`); await page.screenshot({ path }); report.screenshots.push(path); };
let context, worker;
const errors = [];
try {
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    chromiumSandbox:true,
    channel: process.env.CHROME_CHANNEL || 'chrome', headless: true, acceptDownloads: false,
    viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run'],
  });
  report.browser = context.browser().version();
  const browserSession = await context.browser().newBrowserCDPSession();
  const { id } = await browserSession.send('Extensions.loadUnpacked', { path: extension });
  worker = context.serviceWorkers().find(value => value.url().includes(id));
  if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: value => value.url().includes(id) });
  const tabFor = page => worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const collectPage = (tabId, options = {}) => worker.evaluate(async ({ tabId, options }) => {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: globalThis.__qaCollect, args: [options] });
    return results[0].result;
  }, { tabId, options });
  const openWorkspace = async page => {
    const tab = await tabFor(page);
    const [manager] = await Promise.all([context.waitForEvent('page'), worker.evaluate(tab => globalThis.__qaOpenWorkspace(tab), tab)]);
    manager.on('pageerror', error => errors.push(error.message));
    manager.__previewRequests=[];manager.on('request',request=>{if(request.url().startsWith(origin))manager.__previewRequests.push(request.url());});
    await manager.waitForLoadState('domcontentloaded');
    await manager.waitForFunction(() => document.querySelector('#message')?.textContent.includes('候補を取得'));
    return manager;
  };
  const stateFor = manager => worker.evaluate(async url => {
    const key = `workspace:${new URL(url).searchParams.get('id')}`;
    return (await chrome.storage.session.get(key))[key];
  }, manager.url());
  const waitState = async (manager, expected) => {
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      const state=await stateFor(manager);
      if(Object.entries(expected).every(([key,value])=>JSON.stringify(key.startsWith('ui.')?state.ui?.[key.slice(3)]:state[key])===JSON.stringify(value)))return;
      await manager.waitForTimeout(25);
    }
    throw new Error('Timed out waiting for persisted UX state');
  };
  const selectedCount = async (manager, count) => {
    await manager.waitForFunction(count => document.querySelector('#selection').textContent.startsWith(`選択${count}件`), count);
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){if((await stateFor(manager)).selectedURLs?.length===count)return;await manager.waitForTimeout(25);}
    throw new Error('Selection display was not committed to the session');
  };
  const pollSession=async(manager,predicate)=>{
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){const state=await stateFor(manager);if(predicate(state))return state;await manager.waitForTimeout(25);}
    throw new Error('Timed out waiting for the actual persisted download result');
  };
  const closeSettings = async (manager, selector = '#settings-cancel') => {
    await manager.locator(selector).click();
    await manager.waitForFunction(() => !document.querySelector('#save-settings').open);
    assert.equal(await manager.evaluate(() => document.activeElement.id), 'destination-change');
  };
  const readyRemember = page => page.waitForFunction(()=>{
    const input=document.querySelector('#remember-destination');
    return input && !input.disabled && input.getAttribute('aria-busy')==='false'
      && document.querySelector('#remember-destination-help').textContent.includes('現在の次回用設定:');
  });
  const setRemember = async (page, remember) => {
    // setChecked also samples before waiting for enabled. Wait for the actual
    // policy first so a disabled loading placeholder cannot invert the click.
    await readyRemember(page);
    await page.locator('#remember-destination').setChecked(remember);
  };

  // Actual DOM/TreeWalker boundaries; no querySelectorAll stand-in for collection.
  const source = await context.newPage();
  await source.goto(`${origin}/candidates`);
  let tab = await tabFor(source), first = await collectPage(tab.id);
  assert.equal(first.items.length, 500); assert.equal(first.hasMore, true);
  assert.deepEqual(await collectPage(tab.id, { cursor: first.retryCursor }), first, 'initial page replay is identical');
  const second = await collectPage(tab.id, { cursor: first.cursor });
  assert.equal(second.items.length, 1); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.url)).size, 501);
  checked('real DOM: 501 candidates continue 500 + 1 with replay');

  await source.goto(`${origin}/nodes`);
  assert.equal(await source.locator('*').count(), 12001);
  tab = await tabFor(source); first = await collectPage(tab.id);
  assert.equal(first.items.length, 0); assert.equal(first.hasMore, true);
  assert.match(first.notices.join(), /12000/);
  const afterNodes = await collectPage(tab.id, { cursor: first.cursor });
  assert.equal(afterNodes.items.length, 1); assert.equal(afterNodes.hasMore, false);
  assert.ok(afterNodes.items[0].url.endsWith('/after-nodes.svg'));
  checked('real DOM: 12001 elements continue after the 12000-element boundary');

  await source.goto(`${origin}/nested`);
  tab = await tabFor(source); first = await collectPage(tab.id);
  const nested = await collectPage(tab.id, { cursor: first.cursor });
  assert.ok(nested.items.some(item => item.url.endsWith('/shadow.svg')));
  assert.ok(nested.items.some(item => item.url.endsWith('/frame.svg')));
  checked('real DOM: shadow root and same-origin frame survive continuation');

  await source.goto(`${origin}/mutation`);
  const pagedManager = await openWorkspace(source);
  const before = await stateFor(pagedManager);
  assert.equal(before.items.length, 500);
  await pagedManager.locator('.image-select').first().check(); await selectedCount(pagedManager, 1);
  const selectedBefore = await stateFor(pagedManager);
  await source.evaluate(() => document.querySelector('img').setAttribute('data-src', '/changed.svg'));
  await pagedManager.locator('#next-page').click();
  await pagedManager.waitForFunction(() => !document.querySelector('#error').hidden && /変更|期限|再スキャン/.test(document.querySelector('#error').textContent));
  const rejected = await stateFor(pagedManager);
  assert.deepEqual(rejected.items.map(item => item.url), before.items.map(item => item.url));
  assert.deepEqual(rejected.selectedURLs, selectedBefore.selectedURLs);
  checked('DOM mutation invalidates continuation while preserving the old page and selection');
  await pagedManager.close();

  // Hold only synthetic ad-preview fetch responses so source-only heuristic
  // decisions can be checked before automatic preview inspection completes.
  let releaseAdPreviews;const adPreviewGate=new Promise(resolve=>{releaseAdPreviews=resolve;});
  let adPreviewsHeld=true;
  const holdAdPreviews=async route=>{
    if(route.request().resourceType()==='fetch'&&adPreviewsHeld)await adPreviewGate;
    try{await route.continue();}catch(error){if(!/already handled|closed|canceled|Invalid InterceptionId/i.test(error.message))throw error;}
  };
  await context.route(url=>url.origin===origin&&url.pathname.startsWith('/ad-'),holdAdPreviews);
  report.limits.push('Synthetic advertising-preview responses are temporarily held at the route boundary to test source-only heuristic decisions before automatic inspection.');
  await source.goto(`${origin}/ad-filter`);
  await source.waitForFunction(() => [...document.images].filter(image => image.currentSrc).every(image => image.complete && image.naturalWidth));
  const adManager = await openWorkspace(source);
  const adCard = name => adManager.locator(`.card[data-url="${origin}/${name}"]`);
  assert.equal(await adManager.locator('#exclude-ad-like').isChecked(), false);
  assert.equal(await adManager.locator('.card').count(), 7);
  await adCard('ad-banner.svg').locator('.image-select').check();
  await adCard('ad-disguised.gif').locator('.image-select').check();
  await selectedCount(adManager, 2);
  await adManager.locator('#filters > summary').click();
  await adManager.locator('#exclude-ad-like').focus(); await adManager.keyboard.press('Space');
  await waitState(adManager, { 'ui.excludeAdLike': true });
  assert.equal(await adManager.locator('.card').count(), 3, 'source banner/small dimensions and a GIF suffix exclude candidates without a preview');
  assert.equal(await adCard('ad-opaque').count(), 1, 'unknown format and dimensions remain available');
  assert.equal(await adCard('ad-unknown').count(), 1);
  assert.equal(await adManager.locator('[data-filter="exclude-ad-like"]').count(), 1);
  assert.equal(await adManager.locator('#filter-count').textContent(), '1');
  assert.match(await adManager.locator('#selection').textContent(), /非表示2件/);
  assert.match(await adManager.locator('#selection-hint').textContent(), /非表示の画像も保存/);
  assert.equal((await stateFor(adManager)).items.some(item=>item.detectedFormat),false,'source-only heuristic decisions do not depend on completed automatic previews');
  await adManager.locator('#view-selected').click();
  assert.equal(await adManager.locator('.card').count(), 2, 'selected view exposes both excluded selections');
  await waitState(adManager, { 'ui.view': 'selected', 'ui.excludeAdLike': true });
  const adSelection = (await stateFor(adManager)).selectedURLs;
  await adManager.reload();
  await adManager.waitForFunction(() => document.querySelector('#message').textContent.includes('前回'));
  assert.equal(await adManager.locator('#exclude-ad-like').isChecked(), true);
  assert.equal(await adManager.locator('.image-select:checked').count(), 2);
  assert.deepEqual((await stateFor(adManager)).selectedURLs, adSelection);
  const freshAdSource = await context.newPage(); await freshAdSource.goto(`${origin}/ad-filter?new-workspace=1`);
  const freshAdManager = await openWorkspace(freshAdSource);
  assert.equal(await freshAdManager.locator('#exclude-ad-like').isChecked(), false, 'a new workspace starts OFF even while another is ON');
  await freshAdManager.close(); await freshAdSource.close();
  checked('advertising heuristic toggles with Space, groups one chip, retains hidden selections and restores only the current workspace');

  adPreviewsHeld=false;releaseAdPreviews();
  await pollSession(adManager, state => state.items.some(item => item.url.endsWith('/ad-disguised.gif') && item.detectedFormat === 'png'));
  await adManager.locator('#view-all').click();
  assert.equal(await adCard('ad-disguised.gif').count(), 1, 'verified PNG overrides the GIF URL hint');
  await pollSession(adManager, state => state.items.some(item => item.url.endsWith('/ad-opaque') && item.detectedFormat === 'gif'));
  assert.equal(await adCard('ad-opaque').count(), 1, 'newly inspected GIF stays in place until the user updates conditions');
  await adManager.locator('#measure-refresh').waitFor({ state: 'visible' });
  await adManager.locator('#measure-refresh').click();
  assert.equal(await adCard('ad-opaque').count(), 0, 'explicit refresh excludes an extensionless GIF');
  assert.equal(await adCard('ad-disguised.gif').count(), 1);
  assert.equal(await adManager.locator('.card').count(), 3);
  await adManager.locator('[data-filter="exclude-ad-like"]').click();
  assert.equal(await adManager.locator('#exclude-ad-like').isChecked(), false);
  assert.equal(await adManager.locator('.card').count(), 7);
  if (!(await adManager.locator('#filters').evaluate(node => node.open))) await adManager.locator('#filters > summary').click();
  await adManager.locator('#exclude-ad-like').check();
  await adManager.locator('#query').fill('no-ad-filter-match');
  assert.equal(await adManager.locator('.card').count(), 0);
  await adManager.locator('#empty button').click();
  assert.equal(await adManager.locator('#exclude-ad-like').isChecked(), false);
  assert.equal(await adManager.locator('#active-filters .filter-chip').count(), 0);
  assert.equal(await adManager.locator('#filter-count').isVisible(), false);
  await waitState(adManager, { 'ui.excludeAdLike': false, 'ui.query': '' });
  assert.equal(await adManager.locator('.card').count(), 7, 'reset recovers an empty list and clears the grouped setting');
  checked('verified PNG/GIF format overrides URL hints; explicit information refresh, chip removal and reset recover the list');

  if (!(await adManager.locator('#filters').evaluate(node => node.open))) await adManager.locator('#filters > summary').click();
  await adManager.locator('#exclude-ad-like').check();
  assert.equal(await adCard('ad-banner.svg').count(), 0);
  assert.deepEqual((await stateFor(adManager)).selectedURLs, adSelection);
  const adDownloadSession = await context.newCDPSession(adManager);
  await adDownloadSession.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  await adManager.locator('#save').click();
  const adSaved = await pollSession(adManager, state => state.jobs.length === 2 && state.jobs.every(job => job.status === 'complete'));
  assert.deepEqual(adSaved.jobs.map(job => job.url).sort(), [...adSelection].sort(), 'saving includes the excluded selected banner');
  const hiddenBannerJob = adSaved.jobs.find(job => job.url.endsWith('/ad-banner.svg'));
  const hiddenBannerDownload = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], hiddenBannerJob.downloadId);
  assert.equal(await readFile(hiddenBannerDownload.filename, 'utf8'), svg(900, 300));
  checked('a filtered-out selected banner is saved through Chrome with its original bytes');
  await adManager.close();

  // Main UI fixture: source dimensions from a 2x descriptor are not file pixels.
  await source.goto(`${origin}/ux`);
  await source.waitForFunction(() => [...document.images].filter(image => image.currentSrc).every(image => image.complete));
  tab = await tabFor(source);
  const metadata = await collectPage(tab.id);
  const density = metadata.items.find(item => item.url.endsWith('/density-high.svg'));
  assert.equal(density.dimensionSource, 'source');
  assert.equal(density.width, 900, 'source naturalWidth is density-corrected');
  const manager = await openWorkspace(source);
  assert.equal(await manager.locator('.image-select:checked').count(), 0);
  assert.equal(await manager.locator('#help').getAttribute('open'), null);
  await manager.locator('#filters > summary').click();
  await manager.locator('#width').fill('1000');
  assert.equal(await manager.locator(`.card[data-url="${origin}/held-high.svg"]`).count(), 1, 'unknown dimensions remain visible under a minimum width');
  assert.equal(await manager.locator('#dimension-note').isVisible(), true);
  await manager.waitForFunction(()=>document.querySelector('.thumb img')?.src.startsWith('blob:'));
  assert.ok(manager.__previewRequests.length>0,'permitted visible images load automatically in a new workspace');
  releaseHigh = true;
  for (const response of held) response.end(svg(1800, 1200));
  held.clear();
  await manager.waitForFunction(origin => [...document.querySelectorAll('[data-dimensions]')].some(node => node.dataset.dimensions === `${origin}/held-high.svg` && node.textContent.includes('1800')), origin);
  await manager.waitForFunction(origin => [...document.querySelectorAll('[data-dimensions]')].some(node => node.dataset.dimensions === `${origin}/density-high.svg` && node.textContent.includes('1800')), origin);
  assert.equal(await manager.locator(`.card[data-url="${origin}/held-high.svg"]`).count(), 1);
  const thumbnail=manager.locator(`.card[data-url="${origin}/held-high.svg"] .thumb img`);
  await thumbnail.waitFor();await thumbnail.evaluate(image=>image.decode());assert.equal(await thumbnail.evaluate(image=>image.src.startsWith('blob:')&&image.naturalWidth>0&&image.naturalWidth<=384),true,'1800px source metadata is independent of the resized generated thumbnail');
  checked('minimum dimensions keep unknown candidates, then report decoded file pixels for high-resolution images');
  await manager.locator('#reset-filters').click();

  // Responsive URLs remain separately inspectable and explicitly selectable.
  const variantCard = manager.locator('.card').filter({ has: manager.locator('.preview-open').filter({ hasText: /他\d+候補/ }) }).first();
  const returnURL = await variantCard.getAttribute('data-url');
  await variantCard.locator('.preview-open').click();
  await manager.waitForFunction(() => document.querySelector('#image-preview').open);
  assert.equal(await manager.locator('#preview-variants button').count(), 2);
  await manager.locator('#preview-variants button').filter({ hasText: 'variant-large.svg' }).click();
  await manager.waitForFunction(() => { const image = document.querySelector('#preview-stage img'); return image?.complete && image.naturalWidth === 1800; });
  const fitted = await manager.locator('#preview-stage img').evaluate(image => ({ width: image.getBoundingClientRect().width, available: image.parentElement.clientWidth }));
  assert.ok(fitted.width <= fitted.available + 1);
  assert.equal(await manager.locator('#preview-zoom').textContent(),'プレビューを等倍で表示');
  assert.equal(await manager.locator('#preview-stage img').evaluate(image=>image.src.startsWith('blob:')),true);
  await manager.locator('#preview-zoom').click();
  assert.equal(await manager.locator('#preview-zoom').getAttribute('aria-pressed'), 'true');
  assert.equal(await manager.locator('#preview-stage img').evaluate(image => Math.round(image.getBoundingClientRect().width)), 1800);
  await manager.locator('#preview-select').check(); await selectedCount(manager, 1);
  assert.ok((await stateFor(manager)).selectedURLs.some(url => url.endsWith('/variant-large.svg')), 'chosen variant, rather than an automatically substituted maximum, is selected');
  const titleBeforeNext = await manager.locator('#preview-title').textContent();
  await manager.locator('#preview-next').click();
  assert.notEqual(await manager.locator('#preview-title').textContent(), titleBeforeNext);
  await manager.keyboard.press('Escape');
  assert.equal(await manager.evaluate(() => document.activeElement?.closest('.card')?.dataset.url), returnURL, 'Escape returns focus to the originating card control');
  checked('group alternatives, explicit variant selection, fit/100%, next and Escape focus');

  await manager.locator('#view-selected').click();
  await manager.locator('.card .preview-open').click();
  await manager.locator('#preview-variants button').filter({ hasText: 'variant-small.svg' }).click();
  await manager.locator('#preview-select').check(); await selectedCount(manager, 2);
  await manager.waitForFunction(() => document.querySelectorAll('.card').length === 2);
  assert.equal(await manager.evaluate(() => document.activeElement?.id), 'preview-select', 'updating the selected gallery keeps dialog focus');
  await manager.keyboard.press('Escape');
  await manager.waitForFunction(url => document.activeElement?.closest('.card')?.dataset.url === url, `${origin}/variant-large.svg`);
  assert.equal(await manager.locator('.card').count(), 2, 'a newly selected alternative appears immediately in the selected gallery');
  assert.equal(await manager.locator(`.card[data-url="${origin}/variant-small.svg"] .image-select`).isChecked(), true);
  assert.equal(await manager.locator('#selection').textContent(), '選択2件', 'the summary counts both newly rendered selections as visible');
  assert.equal(await manager.evaluate(() => document.activeElement?.closest('.card')?.dataset.url), `${origin}/variant-large.svg`);
  await manager.locator('#view-all').click();
  checked('selecting an alternative from selected-only preview immediately updates the gallery and restores focus');

  await manager.locator('#clear').click(); await selectedCount(manager, 0);
  const firstCheckbox = manager.locator('.image-select').first();
  const firstURL = await firstCheckbox.getAttribute('data-url');
  await firstCheckbox.focus(); await manager.keyboard.press('Space'); await selectedCount(manager, 1);
  await manager.keyboard.press('Tab');
  assert.equal(await manager.evaluate(() => document.activeElement?.classList.contains('card-save-jump')), true);
  await manager.keyboard.press('Enter');
  assert.equal(await manager.evaluate(() => document.activeElement.id), 'save');
  await manager.locator('#return-gallery').click();
  assert.equal(await manager.evaluate(() => document.activeElement?.dataset.url), firstURL);
  await manager.locator('#skip-save').focus(); await manager.keyboard.press('Enter');
  assert.equal(await manager.evaluate(() => document.activeElement.id), 'save');
  checked('keyboard Space, Tab to save jump, save focus and return-to-card');

  await manager.locator('.image-select').nth(1).check(); await selectedCount(manager, 2);
  await manager.locator('#query').fill('no-result-synthetic-filter');
  if (!(await manager.locator('#filters').evaluate(node => node.open))) await manager.locator('#filters > summary').click();
  await manager.locator('#width').fill('1000');
  assert.equal(await manager.locator('.card').count(), 0);
  await manager.locator('#view-selected').click();
  assert.equal(await manager.locator('.card').count(), 2);
  assert.equal(await manager.locator('#search-tools').isVisible(), false, 'selected view suspends filters and exposes every selected URL');
  await waitState(manager, { 'ui.view': 'selected', 'ui.query': 'no-result-synthetic-filter', 'ui.width': 1000 });
  const selectedURLs = (await stateFor(manager)).selectedURLs;
  await manager.reload();
  await manager.waitForFunction(() => document.querySelector('#message').textContent.includes('前回'));
  assert.equal(await manager.locator('#view-selected').getAttribute('aria-pressed'), 'true');
  assert.equal(await manager.locator('.image-select:checked').count(), 2);
  assert.equal(await manager.locator('#query').inputValue(), 'no-result-synthetic-filter');
  assert.equal(await manager.locator('#width').inputValue(), '1000');
  assert.deepEqual((await stateFor(manager)).selectedURLs, selectedURLs);
  await manager.locator('#view-all').click();
  assert.equal(await manager.locator('.card').count(), 0, 'all view restores the suspended filters');
  await manager.locator('#reset-filters').click();
  checked('selection and view survive reload; selected view suspends and restores filters');

  await source.evaluate(() => { const image = new Image(); image.dataset.src = '/new.svg'; image.alt = '今回追加の画像'; document.body.append(image); });
  await manager.locator('#scan').click();
  await manager.waitForFunction(() => document.querySelector('#message').textContent.includes('今回追加1件'));
  await manager.locator('#view-added').click();
  assert.equal(await manager.locator('.card').count(), 1);
  assert.ok((await manager.locator('.card').getAttribute('data-url')).endsWith('/new.svg'));
  assert.equal(await manager.locator('.image-select:checked').count(), 0);
  await manager.locator('#view-all').click();
  checked('rescan exposes only new unselected candidates in the added view');

  // Draft changes must not write settings or the remembered handle before Apply.
  const appliedSnapshot = async () => {
    const state = await stateFor(manager);
    const last = await manager.evaluate(async () => {
      const { getLastDestination } = await import('./directory-store.js');
      const remembered = await getLastDestination();
      return remembered && { destination: remembered.destination, name: remembered.handle?.name || null };
    });
    const policy = await manager.evaluate(async () => (await import('./directory-store.js')).getRememberDestination());
    return { saveSettings: state.saveSettings || null, last, policy };
  };
  const originalSettings = await appliedSnapshot();
  const installPicker = () => manager.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    window.__qaDirectories = {
      A: await root.getDirectoryHandle('UX 保存先 A', { create: true }),
      B: await root.getDirectoryHandle('UX 保存先 B', { create: true }),
    };
    window.__qaPickerChoice = 'A'; window.__qaPickerCalls = 0;
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => {
      window.__qaPickerCalls++;
      if (window.__qaPickerChoice === 'cancel') throw new DOMException('Synthetic picker cancel', 'AbortError');
      return window.__qaDirectories[window.__qaPickerChoice];
    } });
  });
  await installPicker();
  for (const [index, format] of ['original', 'jpg', 'png', 'webp'].entries()) {
    await manager.locator('#destination-change').click();
    await manager.locator('#folder-name').fill(`未適用の名前 ${format}`);
    await manager.locator('#output-format').selectOption(format);
    await setRemember(manager,false);
    await manager.locator('#choose-directory').click();
    await manager.waitForFunction(() => document.querySelector('#destination-directory').checked && !document.querySelector('#choose-directory').disabled);
    if (index === 0) {
      await manager.keyboard.press('Escape');
      await manager.waitForFunction(() => !document.querySelector('#save-settings').open);
      assert.equal(await manager.evaluate(() => document.activeElement.id), 'destination-change');
    } else await closeSettings(manager, index === 1 ? '#settings-close' : '#settings-cancel');
    assert.deepEqual(await appliedSnapshot(), originalSettings, `cancel discards ${format}, folder name and picked handle`);
  }
  checked('all four formats, names and picked handles remain drafts on Escape/Close/Cancel');

  await manager.locator('#destination-change').click();
  await manager.locator('#folder-name').fill('適用した保存先 A');
  await manager.locator('#output-format').selectOption('png');
  await manager.locator('#choose-directory').click();
  await manager.waitForFunction(() => document.querySelector('#destination-directory').checked && !document.querySelector('#choose-directory').disabled);
  await closeSettings(manager, '#settings-done');
  const appliedA = await appliedSnapshot();
  assert.equal(appliedA.saveSettings.destination, 'directory'); assert.equal(appliedA.saveSettings.format, 'png');
  assert.deepEqual(appliedA.last, { destination: 'directory', name: 'UX 保存先 A' });
  const inheritedSource = await context.newPage(); await inheritedSource.goto(`${origin}/?snapshot=A`);
  const inheritedManager = await openWorkspace(inheritedSource);
  const inheritedA = (await stateFor(inheritedManager)).saveSettings;
  assert.equal(inheritedA.destination, 'directory'); assert.equal(inheritedA.format, 'original');
  assert.ok(inheritedA.directoryKey, 'the inherited destination owns a session-specific handle before opening settings');
  await manager.locator('#destination-change').click();
  await manager.evaluate(() => { window.__qaPickerChoice = 'B'; });
  await manager.locator('#choose-directory').click();
  await manager.waitForFunction(() => document.querySelector('#chosen-directory').textContent.includes('UX 保存先 B') && !document.querySelector('#choose-directory').disabled);
  await manager.locator('#folder-name').fill('取り消す保存先 B'); await manager.locator('#output-format').selectOption('webp');
  await closeSettings(manager);
  assert.deepEqual(await appliedSnapshot(), appliedA, 'picking B then cancelling preserves the applied A handle');
  await manager.locator('#destination-change').click();
  assert.match(await manager.locator('#chosen-directory').textContent(), /UX 保存先 A/);
  await manager.evaluate(() => { window.__qaPickerChoice = 'cancel'; });
  const calls = await manager.evaluate(() => window.__qaPickerCalls);
  await manager.locator('#choose-directory').click();
  await manager.waitForFunction(calls => window.__qaPickerCalls === calls + 1 && !document.querySelector('#choose-directory').disabled, calls);
  assert.match(await manager.locator('#chosen-directory').textContent(), /UX 保存先 A/);
  await manager.evaluate(() => { window.__qaPickerChoice = 'B'; });
  await manager.locator('#choose-directory').click();
  await manager.waitForFunction(() => document.querySelector('#chosen-directory').textContent.includes('UX 保存先 B') && !document.querySelector('#choose-directory').disabled);
  await manager.locator('#folder-name').fill('適用した保存先 B'); await manager.locator('#output-format').selectOption('webp');
  await closeSettings(manager, '#settings-done');
  const appliedB = await appliedSnapshot();
  assert.equal(appliedB.saveSettings.format, 'webp'); assert.equal(appliedB.saveSettings.folderName, '適用した保存先 B');
  assert.deepEqual(appliedB.last, { destination: 'directory', name: 'UX 保存先 B' });
  assert.equal(await manager.evaluate(async key => {
    const { getDirectory } = await import('./directory-store.js'); return (await getDirectory(key)).name;
  }, appliedB.saveSettings.directoryKey), 'UX 保存先 B');
  await manager.reload();
  await manager.waitForFunction(() => document.querySelector('#message').textContent.includes('前回'));
  await manager.locator('#destination-change').click();
  assert.equal(await manager.locator('#folder-name').inputValue(), '適用した保存先 B');
  assert.equal(await manager.locator('#output-format').inputValue(), 'webp');
  assert.match(await manager.locator('#chosen-directory').textContent(), /UX 保存先 B/);
  await closeSettings(manager);
  checked('Apply commits settings and a cloneable OPFS handle; picker cancel and reload retain the applied destination');
  const assertInheritedA = async () => {
    await inheritedManager.reload();
    await inheritedManager.waitForFunction(() => document.querySelector('#message').textContent.includes('前回'));
    assert.deepEqual((await stateFor(inheritedManager)).saveSettings, inheritedA);
    assert.equal(await inheritedManager.evaluate(async key => {
      const { getDirectory } = await import('./directory-store.js'); return (await getDirectory(key)).name;
    }, inheritedA.directoryKey), 'UX 保存先 A');
    assert.match(await inheritedManager.locator('#destination-summary').textContent(), /UX 保存先 A/);
  };
  await assertInheritedA();
  const changerSource = await context.newPage(); await changerSource.goto(`${origin}/?snapshot=chrome`);
  const changer = await openWorkspace(changerSource);
  await changer.locator('#destination-change').click(); await changer.locator('#destination-downloads').check();
  await closeSettings(changer, '#settings-done');
  await assertInheritedA();
  await inheritedManager.close(); await inheritedSource.close(); await changer.close(); await changerSource.close();
  checked('new workspaces snapshot inherited folders; other tabs changing folder or Chrome destination cannot redirect them');
  await manager.evaluate(()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);let drop=true;
    chrome.runtime.sendMessage=async message=>{const response=await send(message);if(drop&&message.type==='settings'&&response?.ok){drop=false;throw new Error('Synthetic acknowledgement loss after commit');}return response;};
  });
  await manager.locator('#destination-change').click();await manager.locator('#folder-name').fill('応答喪失後も保持');
  await closeSettings(manager,'#settings-done');
  assert.equal((await stateFor(manager)).saveSettings.folderName,'応答喪失後も保持');
  await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回'));
  await manager.locator('#destination-change').click();assert.match(await manager.locator('#chosen-directory').textContent(),/UX 保存先 B/);await closeSettings(manager);
  checked('a lost settings acknowledgement preserves the committed handle and restores it after reload');

  // The next-use memo is separate from pinned session/batch handles. Use a
  // second real extension page to exercise stale drafts across IDB transactions.
  const rememberSnapshot = page => page.evaluate(async () => {
    const {getRememberDestination,getLastDestination,getDirectory}=await import('./directory-store.js');
    const policy=await getRememberDestination(),last=await getLastDestination();
    return {policy,last:last&&{destination:last.destination,name:last.handle?.name || null},
      rawLast:Boolean(await getDirectory('last')),rawDestination:Boolean(await getDirectory('last-destination'))};
  });
  const assertRememberSetting = async (page, expected, message) => {
    // Opening the dialog starts a real async IndexedDB policy read. Its
    // disabled checkbox is a loading placeholder, not the applied policy.
    await readyRemember(page);
    assert.equal(await page.locator('#remember-destination').isChecked(),expected,message);
  };
  const staleSource=await context.newPage();await staleSource.goto(`${origin}/?remember=stale`);
  const staleManager=await openWorkspace(staleSource);
  await staleManager.locator('#destination-change').click();
  await assertRememberSetting(staleManager,true);
  await manager.locator('#destination-change').click();await setRemember(manager,false);
  await closeSettings(manager,'#settings-done');
  const forgotten=await rememberSnapshot(manager);
  assert.equal(forgotten.policy.remember,false);assert.equal(forgotten.last,null);
  assert.equal(forgotten.rawLast,false);assert.equal(forgotten.rawDestination,false);
  assert.equal((await stateFor(manager)).saveSettings.destination,'directory','forgetting next-use leaves this workspace at its chosen directory');
  await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回'));
  assert.match(await manager.locator('#destination-summary').textContent(),/UX 保存先 B/,'same-workspace reload keeps its pinned handle after OFF');
  await manager.locator('#destination-change').click();
  await assertRememberSetting(manager,false);
  await setRemember(manager,true);await closeSettings(manager);
  assert.deepEqual(await rememberSnapshot(manager),forgotten,'cancelling ON leaves OFF and its memo unchanged');
  await staleManager.evaluate(()=>{
    const remove=IDBObjectStore.prototype.delete;window.__qaPolicyDelete=remove;let fail=true;
    IDBObjectStore.prototype.delete=function(key){if(fail&&key==='last'){fail=false;throw new Error('Synthetic stale-apply failure');}return remove.call(this,key);};
  });
  await staleManager.locator('#output-format').selectOption('jpg');await staleManager.locator('#settings-done').click();
  await staleManager.waitForFunction(()=>!document.querySelector('#settings-done').disabled && !document.querySelector('#settings-error').hidden);
  assert.equal(await staleManager.locator('#save-settings').evaluate(dialog=>dialog.open),true);
  await assertRememberSetting(staleManager,false,'failed format-only stale draft follows the refreshed OFF policy');
  assert.deepEqual(await rememberSnapshot(manager),forgotten,'failed stale Apply preserves OFF and memo');
  await staleManager.evaluate(()=>{IDBObjectStore.prototype.delete=window.__qaPolicyDelete;delete window.__qaPolicyDelete;});
  await closeSettings(staleManager,'#settings-done');
  assert.deepEqual(await rememberSnapshot(manager),forgotten,'format-only Apply from an old ON draft cannot resurrect OFF');
  const offSource=await context.newPage();await offSource.goto(`${origin}/?remember=off`);
  const offManager=await openWorkspace(offSource),offSettings=(await stateFor(offManager)).saveSettings;
  assert.equal(offSettings.destination,'downloads');assert.equal(offSettings.directoryKey,undefined,'new workspace cannot inherit a forgotten folder');
  await offManager.close();await offSource.close();
  report.limits.push('Stale format-only Apply injects one IDB delete rejection before retry; real IDB transactions remain in use.');
  checked('next-use OFF clears both memo entries, preserves reload, and survives failed stale format-only Apply plus retry');

  await staleManager.locator('#destination-change').click();await setRemember(staleManager,true);
  // Change the policy twice elsewhere. Its latest boolean is again OFF, but its
  // revision proves that the first page's explicit ON draft is out of date.
  await manager.locator('#destination-change').click();await setRemember(manager,true);await closeSettings(manager,'#settings-done');
  await manager.locator('#destination-change').click();await setRemember(manager,false);await closeSettings(manager,'#settings-done');
  const latestOff=await rememberSnapshot(manager);
  await staleManager.locator('#settings-done').click();
  await staleManager.waitForFunction(()=>!document.querySelector('#settings-done').disabled && !document.querySelector('#settings-error').hidden);
  assert.equal(await staleManager.locator('#save-settings').evaluate(dialog=>dialog.open),true,'conflicting policy is not reported as applied');
  assert.match(await staleManager.locator('#settings-error').textContent(),/別の作業で変更/);
  assert.match(await staleManager.locator('#remember-destination-help').textContent(),/現在の次回用設定: OFF/);
  assert.deepEqual(await rememberSnapshot(manager),latestOff,'explicit stale policy change preserves the latest OFF transaction');
  await closeSettings(staleManager);await staleManager.close();await staleSource.close();
  await manager.locator('#destination-change').click();await setRemember(manager,true);await closeSettings(manager,'#settings-done');
  const rememberedAgain=await rememberSnapshot(manager);assert.equal(rememberedAgain.policy.remember,true);
  assert.deepEqual(rememberedAgain.last,{destination:'directory',name:'UX 保存先 B'});
  checked('explicit stale policy changes conflict even after an ON/OFF round trip; explicit latest ON remembers again');

  await manager.evaluate(()=>{
    const put=IDBObjectStore.prototype.put;window.__qaPolicyPut=put;
    IDBObjectStore.prototype.put=function(value,key){if(key==='remember-destination')throw new Error('Synthetic policy write failure');return put.call(this,value,key);};
  });
  await manager.locator('#destination-change').click();await setRemember(manager,false);await manager.locator('#settings-done').click();
  await manager.waitForFunction(()=>!document.querySelector('#settings-done').disabled && !document.querySelector('#settings-error').hidden);
  assert.equal(await manager.locator('#save-settings').evaluate(dialog=>dialog.open),true);
  assert.match(await manager.locator('#settings-error').textContent(),/記憶設定は適用できません/);
  assert.deepEqual(await rememberSnapshot(manager),rememberedAgain,'failed OFF transaction preserves policy and both memo entries');
  await manager.evaluate(()=>{IDBObjectStore.prototype.put=window.__qaPolicyPut;delete window.__qaPolicyPut;});await closeSettings(manager);
  report.limits.push('The remember-policy failure case injects one IDB put rejection; real IndexedDB transactions and OPFS handles remain in use.');
  checked('failed next-use policy persistence keeps the modal open and cannot claim the folder was forgotten');

  const semantics = await manager.locator('.image-select').evaluateAll(inputs => inputs.every(input => {
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    return input.getAttribute('aria-label')?.endsWith('を選択') && ids.length >= 2 && ids.every(id => document.getElementById(id));
  }));
  assert.equal(semantics, true);
  assert.equal(await manager.getByRole('button', { name: '保存設定を変更', exact: true }).count(), 1);
  assert.equal(await manager.getByRole('searchbox', { name: '画像を検索', exact: true }).count(), 1);
  assert.equal(await manager.locator('#grid').getAttribute('aria-busy'), 'false');
  checked('native selection controls retain names, dimensions/status descriptions and labeled dialogs');

  await manager.locator('.card').first().scrollIntoViewIfNeeded();
  await manager.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.src.startsWith('blob:');});

  // Geometry is objective coverage. Screenshots are retained for separate visual review.
  for (const width of [360, 640, 1280]) {
    await manager.setViewportSize({ width, height: 900 });
    await manager.evaluate(() => window.scrollTo(0, 0));
    await screenshot(manager, `gallery-${width}`);
    const geometry = await manager.evaluate(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
        shellPadding: getComputedStyle(document.querySelector('.shell')).padding,
        footer: rect(document.querySelector('#footer')), save: rect(document.querySelector('#save')),
        cards: [...document.querySelectorAll('.card')].map(card => ({ box: rect(card), padding: getComputedStyle(card.querySelector('.card-body')).padding, font: getComputedStyle(card.querySelector('.file-name')).fontSize })),
      };
    });
    assert.ok(geometry.documentWidth <= width + 1, `${width}px gallery has no horizontal overflow`);
    assert.ok(geometry.save.x >= 0 && geometry.save.right <= width + 1 && geometry.save.bottom <= 901, `${width}px save action remains in the viewport`);
    assert.ok(geometry.cards.every(card => card.box.x >= 0 && card.box.right <= width + 1 && Number.parseFloat(card.font) >= 12));
    report.geometry.push(geometry);
    if (!(await manager.locator('#filters').evaluate(node => node.open))) await manager.locator('#filters > summary').click();
    await manager.locator('#width').fill('100');
    await manager.locator('#height').fill('100');
    await manager.locator('#type').selectOption('svg');
    await screenshot(manager, `filters-${width}`);
    const fields = await manager.locator('#filter-panel input:not([type="checkbox"]), #filter-panel select').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; }));
    assert.ok(fields.every(field => field.left >= 0 && field.right <= width + 1 && field.height >= 44));
    for (let i = 0; i < fields.length; i++) for (let j = i + 1; j < fields.length; j++) assert.equal(Math.min(fields[i].right, fields[j].right) - Math.max(fields[i].left, fields[j].left) > 1 && Math.min(fields[i].bottom, fields[j].bottom) - Math.max(fields[i].top, fields[j].top) > 1, false, 'filter controls do not overlap');
    const adControl = await manager.locator('#exclude-ad-like').evaluate(input => {
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
      return { label: rect(input.closest('label')), help: rect(document.getElementById(input.getAttribute('aria-describedby'))) };
    });
    assert.ok(adControl.label.left >= 0 && adControl.label.right <= width + 1 && adControl.label.height >= 44, 'advertising checkbox retains a full-height labeled hit area');
    assert.ok(adControl.help.left >= 0 && adControl.help.right <= width + 1 && adControl.help.top >= adControl.label.bottom - 1, 'advertising criteria wrap below the control without overflow or overlap');
    await manager.locator('#reset-filters').click();
    await manager.locator('#width').press('Escape');
    await manager.locator('#destination-change').click();
    await manager.locator('#folder-name').fill('長い日本語のまとめるフォルダ名と絵文字📷'.repeat(8));
    await screenshot(manager, `settings-${width}`);
    const dialog = await manager.locator('#save-settings').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
    assert.ok(dialog.scroll <= dialog.width + 1 && dialog.left >= 0 && dialog.right <= width + 1, `${width}px settings contain long text`);
    await closeSettings(manager);
    await manager.locator('.preview-open').first().click();
    await manager.waitForFunction(() => {const image=document.querySelector('#preview-stage img');return document.querySelector('#image-preview').open&&image?.complete&&image.src.startsWith('blob:');});
    await screenshot(manager, `preview-${width}`);
    await manager.keyboard.press('Escape');
    checked(`${width}px geometry, filter controls, long settings draft and preview screenshots`);
  }

  await manager.setViewportSize({width:1280,height:900});
  const zoomTab=(await stateFor(manager)).workspaceTabId;
  await worker.evaluate(tabId=>chrome.tabs.setZoom(tabId,2),zoomTab);
  assert.equal(await worker.evaluate(tabId=>chrome.tabs.getZoom(tabId),zoomTab),2);
  await manager.waitForFunction(()=>innerWidth<=650);
  await manager.evaluate(()=>document.querySelector('#filters').open=false);
  const zoomGeometry=await manager.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,save:document.querySelector('#save').getBoundingClientRect().bottom,height:innerHeight}));
  assert.equal(zoomGeometry.overflow,false);assert.ok(zoomGeometry.save<=zoomGeometry.height+1);
  await screenshot(manager,'actual-zoom-200');
  await worker.evaluate(tabId=>chrome.tabs.setZoom(tabId,1),zoomTab);
  report.actualZoom={factor:2,...zoomGeometry};checked('real Chrome 200% tab zoom keeps the interface and save action usable');

  // P14: preserve the actual response bytes while resolving an extensionless
  // original download from Chrome's MIME information. CDP controls only this
  // profile's physical output path; the worker's requested path is checked too.
  const downloadSession = await context.newCDPSession(manager);
  // Default browser downloads use this isolated profile's Preferences. CDP's
  // allow override bypasses onDeterminingFilename and cannot test naming.
  await downloadSession.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  await source.evaluate(() => { const image = new Image(); image.dataset.src = '/original-image'; image.alt = '拡張子のない元画像'; document.body.append(image); });
  await manager.locator('#scan').click();
  await manager.waitForFunction(origin => [...document.querySelectorAll('.image-select')].some(input => input.dataset.url === `${origin}/original-image`), origin);
  if (await manager.locator('#clear').isEnabled()) { await manager.locator('#clear').click(); await selectedCount(manager, 0); }
  await manager.locator('#destination-change').click();
  await manager.locator('#destination-downloads').check();
  await manager.locator('#folder-name').fill('拡張子なしの元画像');
  await manager.locator('#output-format').selectOption('original');
  await closeSettings(manager, '#settings-done');
  await manager.locator(`.card[data-url="${origin}/original-image"] .image-select`).check();
  await selectedCount(manager, 1);
  await manager.locator('#save').click();
  await pollSession(manager,state=>state.jobs.some(job=>job.url===`${origin}/original-image`&&job.status==='complete'));
  const originalState = await stateFor(manager);
  const originalJob = originalState.jobs.find(job => job.url === `${origin}/original-image`);
  assert.equal(originalState.batch.destination, 'downloads'); assert.equal(originalState.batch.format, 'original');
  report.filenameEvents=await worker.evaluate(()=>globalThis.__qaFilenameEvents||[]);
  assert.ok(originalJob.filename.endsWith('.svg'), `owned filename decision replaces the neutral .img suffix: ${JSON.stringify({job:originalJob,events:report.filenameEvents})}`);
  assert.equal(originalJob.typeKnown, true);
  assert.equal(originalJob.mime, 'image/svg+xml');
  const originalDownload = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], originalJob.downloadId);
  assert.equal(originalDownload.state, 'complete');
  assert.equal(originalJob.actualFilename, originalDownload.filename.split(/[\\/]/).pop(), 'the job records Chrome\'s actual finalized basename');
  assert.deepEqual(await readFile(originalDownload.filename), Buffer.from(originalSVG), 'original download preserves the complete SVG response bytes');
  report.downloads = [{ requested: originalJob.filename, actual: originalJob.actualFilename, typeKnown: originalJob.typeKnown, bytes: Buffer.byteLength(originalSVG) }];
  checked('P14: extensionless original Chrome download resolves SVG filename/MIME and preserves real saved bytes');

  // P13: reject exactly one API submission in this temporary extension. The
  // recovery UI and subsequent download remain real; another ordinary selection
  // must survive both preparing and completing the failed-only replacement.
  await source.evaluate(() => { const image = new Image(); image.dataset.src = '/retry-image'; image.alt = '一度だけ中断する合成画像'; document.body.append(image); });
  await manager.locator('#scan').click();
  await manager.waitForFunction(origin => [...document.querySelectorAll('.image-select')].some(input => input.dataset.url === `${origin}/retry-image`), origin);
  await worker.evaluate(url => {
    globalThis.__qaNativeDownload = chrome.downloads.download.bind(chrome.downloads);
    globalThis.__qaRejectDownloadOnce = url;
    chrome.downloads.download = async options => {
      if (options.url === globalThis.__qaRejectDownloadOnce) {
        globalThis.__qaRejectDownloadOnce = null;
        throw new Error('Synthetic one-time download API rejection');
      }
      return globalThis.__qaNativeDownload(options);
    };
  }, `${origin}/retry-image`);
  await manager.locator(`.card[data-url="${origin}/retry-image"] .image-select`).check();
  await selectedCount(manager, 1);
  await manager.locator('#save').click();
  await pollSession(manager,state=>state.jobs.some(job=>job.url===`${origin}/retry-image`&&job.status==='interrupted'));
  await manager.locator('#prepare-failed').waitFor({state:'visible'});
  const interruptedBatch = (await stateFor(manager)).batch.id;
  await manager.locator('#clear').click(); await selectedCount(manager, 0);
  await manager.locator(`.card[data-url="${origin}/red.svg"] .image-select`).check(); await selectedCount(manager, 1);
  const ordinarySelection = (await stateFor(manager)).selectedURLs;
  assert.deepEqual(ordinarySelection, [`${origin}/red.svg`]);
  await manager.locator('#prepare-failed').click();
  await manager.waitForFunction(() => document.querySelector('#save-settings').open);
  assert.deepEqual((await stateFor(manager)).selectedURLs, ordinarySelection);
  assert.match(await manager.locator('#settings-description').textContent(), /他の選択は保持/);
  await manager.locator('#folder-name').fill('中断分だけを新しく保存');
  await closeSettings(manager, '#settings-done');
  assert.equal(await manager.locator('#recovery-summary').isVisible(), true);
  assert.match(await manager.locator('#save-label').textContent(), /中断1件を新しく保存/);
  await manager.locator('#recovery-cancel').click();
  await waitState(manager, { 'ui.saveScope': 'selection' });
  assert.deepEqual((await stateFor(manager)).selectedURLs, ordinarySelection, 'returning to ordinary selection does not replace it');
  await manager.locator('#prepare-failed').click();
  await manager.waitForFunction(() => document.querySelector('#save-settings').open);
  await closeSettings(manager, '#settings-done');
  await manager.locator('#save').click();
  await pollSession(manager,state=>state.batch.sourceBatchId===interruptedBatch&&state.jobs.every(job=>job.status==='complete'));
  const replacement = await stateFor(manager);
  assert.notEqual(replacement.batch.id, interruptedBatch);
  assert.equal(replacement.batch.sourceBatchId, interruptedBatch);
  assert.equal(replacement.batch.folderName, '中断分だけを新しく保存');
  assert.deepEqual(replacement.jobs.map(job => job.url), [`${origin}/retry-image`]);
  assert.deepEqual(replacement.selectedURLs, ordinarySelection, 'failed-only completion leaves unrelated ordinary selections intact');
  assert.equal(replacement.ui.saveScope, 'selection');
  await worker.evaluate(() => { chrome.downloads.download = globalThis.__qaNativeDownload; delete globalThis.__qaNativeDownload; });
  report.limits.push('P13 injects one chrome.downloads.download rejection at the API boundary; failed-only preparation and the replacement download use the real UI and worker.');
  checked('P13: failed-only preparation/cancel/new batch preserve ordinary selection and submit only interrupted URLs with sourceBatchId');

  await manager.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  assert.equal(await manager.locator('.image-select').first().evaluate(element => getComputedStyle(element).appearance), 'auto');
  assert.equal(await manager.locator('.card').first().evaluate(element => getComputedStyle(element).animationName), 'none');
  await manager.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  assert.deepEqual(errors, [], 'no uncaught workspace errors');
  checked('reduced motion and forced-colors native checkbox regression');
  // Exercise Chrome's real alarm event with no workspace polling. The separate
  // smoke test covers an explicit worker stop/restart. DevTools stopAllWorkers
  // is not a reliable way to model natural alarm wake in this test harness.
  await manager.close();
  const alarmStateId='ux-alarm-owned';
  await source.waitForTimeout(500);
  const alarmAcceptedId=await worker.evaluate(origin=>chrome.downloads.download({url:origin+'/red.svg',filename:'ImageCrate/Alarm recovery/001_owned.svg',conflictAction:'uniquify',saveAs:false}),origin);
  // Drain the setup download's real events before creating the closed fixture;
  // only the scheduled alarm should trigger its first reconciliation.
  for(let attempt=0;attempt<100;attempt++){
    if(await worker.evaluate(async id=>(await chrome.downloads.search({id}))[0]?.state==='complete',alarmAcceptedId))break;
    await source.waitForTimeout(20);
  }
  await worker.evaluate(()=>globalThis.__qaSerial(async()=>{}));
  await worker.evaluate(async({origin,id,downloadId})=>globalThis.__qaSerial(async()=>{
    const {createTransferBudget,reserveTransferAttempt}=globalThis.__qaBudget;
    const now=Date.now(),url=origin+'/red.svg',filename='ImageCrate/Alarm recovery/001_owned.svg';
    // A positive API return supplies the owned ID. Expired unknown acceptance
    // is deliberately retained by current policy, never invented as failed to
    // unblock a queue. That failure boundary is covered by background tests.
    let transferBudget=createTransferBudget({now});
    transferBudget=reserveTransferAttempt(transferBudget,{attemptId:'owned-accepted',logicalJobId:'owned-accepted',maxBytes:128*1024*1024,maxOutputBytes:128*1024*1024,now});
    await chrome.storage.session.set({[`workspace:${id}`]:{
      id,tabId:-2,workspaceTabId:-1,url:origin,title:'Alarm recovery',closed:true,items:[],selectedItems:[],selectedURLs:[],history:[],notices:[],ui:{},revision:1,
      batch:{id:'alarm-batch',destination:'downloads',format:'original',folderName:'Alarm recovery',transferBudget},
      jobs:[{id:'owned-accepted',logicalJobId:'owned-accepted',url,filename,status:'in_progress',downloadId,transfer:{maxBytes:128*1024*1024,maxOutputBytes:128*1024*1024,startedAt:now,deadline:now+120000}},
        {id:'queued-after-owned',logicalJobId:'queued-after-owned',url:origin+'/red.svg',filename:'ImageCrate/Alarm recovery/002_red.svg',status:'queued'}]
    }});
    await chrome.alarms.create('imagecrate-pending-downloads',{when:now+3000,periodInMinutes:1});
  }),{origin,id:alarmStateId,downloadId:alarmAcceptedId});
  const awakened=worker;
  const wakeDeadline=Date.now()+90000;let recovered=false;
  while(Date.now()<wakeDeadline){
    recovered=await awakened.evaluate(async id=>!(await chrome.storage.session.get(`workspace:${id}`))[`workspace:${id}`] && globalThis.__qaAlarmEvents?.includes('imagecrate-pending-downloads'),alarmStateId);
    if(recovered)break;await source.waitForTimeout(50);
  }
  assert.equal(recovered,true,'the real alarm event confirms the owned native download and completes budgeted queued files without a workspace');
  const recoveredDownloads=await awakened.evaluate(()=>chrome.downloads.search({filenameRegex:'Alarm recovery'}));
  assert.equal(recoveredDownloads.length,1);assert.ok(recoveredDownloads.every(download=>download.state==='complete'));
  const [confirmedSetup]=await awakened.evaluate(id=>chrome.downloads.search({id}),alarmAcceptedId);
  assert.equal(confirmedSetup.state,'complete');assert.match(await readFile(confirmedSetup.filename,'utf8'),/<svg/);
  assert.match(await readFile(recoveredDownloads[0].filename,'utf8'),/<svg/);
  assert.equal(await awakened.evaluate(()=>chrome.alarms.get('imagecrate-pending-downloads')),undefined,'the recovery alarm is removed after reconciliation');
  report.limits.push('The real Chrome alarm wake test moves only the alarm scheduled time to 3 seconds; production uses a one-minute delay.');
  checked('real Chrome alarm after workspace closure confirms owned native results, completes the budgeted queue and clears the alarm');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`ImageCrate UX browser PASS: ${report.checks.length} checks. Screenshots/report: ${output}`);
  console.log('OS picker, real toolbar consent, screen reader and human experience remain unverified.');
  if (process.env.QA_KEEP) console.log(`Temporary profile retained: ${scratch}`);
} catch (error) {
  report.failure = error.stack || String(error);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  for (const response of held) response.destroy();
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  if (!process.env.QA_KEEP) await rm(scratch, { recursive: true, force: true });
}
