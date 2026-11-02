// Minimum-version acceptance. Set CHROME_EXECUTABLE to the official Chrome for
// Testing 116 executable. Only a temp copy/profile and localhost fixture are used.
// Uses --load-extension (available in 116), never CDP Extensions.loadUnpacked.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {tagPrivacyMetadata,readPrivacyMetadata,SYNTHETIC_METADATA} from './helpers/privacy-metadata.mjs';

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
const workspacePath=join(extension,'workspace.js');
await writeFile(workspacePath,await readFile(workspacePath,'utf8')+`
globalThis.__compatClosePreviews=async()=>{
  const {imageResourceCoordinator}=await import('./image-decoder.js');
  const before=Object.values(await imageResourceCoordinator().snapshot());
  gallery.suspendPreviews();await previews.dispose();
  return {before,after:Object.values(await imageResourceCoordinator().snapshot())};
};
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
    executablePath, headless: true, chromiumSandbox:true, acceptDownloads: false, viewport: { width: 1200, height: 900 },
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
    manager.__previewRequests=[];manager.on('request',request=>{if(request.url().startsWith(origin))manager.__previewRequests.push(request.url());});
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
  // The width filter can remove already-decoded smaller images. Observe the
  // unknown image's real automatic request before releasing its held body.
  const heldDeadline=Date.now()+10000;
  while(!held.size&&Date.now()<heldDeadline)await manager.waitForTimeout(25);
  assert.ok(held.size>0,'Chrome 116 automatically requests the unknown visible image');
  assert.ok(manager.__previewRequests.some(url=>url===origin+'/held.svg'),'the held request starts without a preview-permission click');
  releaseHigh = true;
  for (const response of held) response.end(svg(1800, 1200));
  held.clear();
  await manager.waitForFunction(origin => [...document.querySelectorAll('[data-dimensions]')].some(node => node.dataset.dimensions === `${origin}/held.svg` && node.textContent.includes('1800')), origin);
  const thumbnail=manager.locator(`.card[data-url="${origin}/held.svg"] .thumb img`);
  await thumbnail.waitFor();await thumbnail.evaluate(image=>image.decode());assert.equal(await thumbnail.evaluate(image=>image.src.startsWith('blob:')&&image.naturalWidth>0&&image.naturalWidth<=384),true,'validated source dimensions are separate from the generated thumbnail');
  await manager.locator('#reset-filters').click();
  checked('Chrome 116 unknown dimensions remain available under minimum-width filtering');
  const preview = manager.locator(`.card[data-url="${origin}/held.svg"] .preview-open`);
  await preview.click();
  await manager.waitForFunction(() => { const image = document.querySelector('#preview-stage img'); return document.querySelector('#image-preview').open && image?.complete && image.naturalWidth === 1800; });
  assert.ok(await manager.locator('#preview-stage img').evaluate(image => image.getBoundingClientRect().width <= image.parentElement.clientWidth + 1));
  assert.equal(await manager.locator('#preview-zoom').textContent(),'プレビューを等倍で表示');
  assert.equal(await manager.locator('#preview-stage img').evaluate(image=>image.src.startsWith('blob:')),true,'viewer displays only a generated static Blob');
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

  const remember = await manager.evaluate(async()=>{
    const {getDirectory,putDirectory,deleteDirectory,getLastDestination,getRememberDestination,putLastDestination}=await import('./directory-store.js');
    const keys=['last','last-destination','remember-destination'],snapshot=[];
    for(const key of keys)snapshot.push([key,await getDirectory(key)]);
    const handle=await (await navigator.storage.getDirectory()).getDirectoryHandle('compat-policy-probe',{create:true});
    const suffix=crypto.randomUUID(),liveKeys=[`session:compat-policy:${suffix}`,`batch:compat-policy:${suffix}`];
    try {
      for(const key of liveKeys)await putDirectory(key,handle);
      const initial=await getRememberDestination();
      const on=await putLastDestination({handle,destination:'directory'},{remember:true,expectedRevision:initial.revision});
      const off=await putLastDestination({handle,destination:'directory'},{remember:false,expectedRevision:on.revision});
      const forgotten=await getLastDestination()===null && await getDirectory('last')===null && await getDirectory('last-destination')===null;
      const ordinary=await putLastDestination({handle,destination:'directory'});
      const ordinaryPreservesOff=!ordinary.remember && ordinary.revision===off.revision && await getLastDestination()===null;
      let staleRejected=false;
      try {await putLastDestination({handle,destination:'directory'},{remember:true,expectedRevision:on.revision});}
      catch(error){staleRejected=error.constructor?.name==='DestinationPolicyError' && /別の作業/.test(error.message);}
      const pinnedHandles=await getDirectory(liveKeys[0])!==null && await getDirectory(liveKeys[1])!==null;
      const final=await getRememberDestination();
      return {forgotten,ordinaryPreservesOff,staleRejected,pinnedHandles,stillOff:!final.remember,revisionAdvanced:off.revision===on.revision+1};
    } finally {
      for(const [key,value]of snapshot){if(value===null)await deleteDirectory(key);else await putDirectory(key,value);}
      for(const key of liveKeys)await deleteDirectory(key);
    }
  });
  assert.deepEqual(remember,{forgotten:true,ordinaryPreservesOff:true,staleRejected:true,pinnedHandles:true,stillOff:true,revisionAdvanced:true});
  report.rememberDestination=remember;
  checked('Chrome 116 real IndexedDB: remember OFF, format-only persistence, stale CAS rejection and pinned recovery handles');

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
    assert.equal(job.actualFilename, download.filename.split(/[\\/]/).pop(),'session retains only the actual basename while raw Chrome filename still proves the complete requested path');
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

  // The SVG fixture uses the bounded rectangle renderer. Exercise actual
  // createImageBitmap source decoding inside the dedicated worker as well.
  // End the real preview lifecycle (the same suspend/dispose operations as
  // pagehide) so later visibility events cannot recreate a legitimate cache
  // during the direct-conversion ledger-zero checks. Never erase ledger data.
  await source.bringToFront();
  report.previewLifecycle=await manager.evaluate(()=>globalThis.__compatClosePreviews());
  await manager.waitForFunction(async()=>Object.keys((await chrome.storage.session.get('imagecrate.imageResources.v1'))['imagecrate.imageResources.v1']||{}).length===0,null,{polling:50});
  const rasterInputs=await manager.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=16;canvas.height=12;
    const context=canvas.getContext('2d');context.fillStyle='#ff0000';context.fillRect(0,0,6,12);
    return {png:canvas.toDataURL('image/png'),jpg:canvas.toDataURL('image/jpeg',1),webp:canvas.toDataURL('image/webp',1)};
  });
  const baseJpeg=Buffer.from(rasterInputs.jpg.split(',')[1],'base64');
  for(const format of ['png','jpg','webp']) {
    const bytes=tagPrivacyMetadata(Buffer.from(rasterInputs[format].split(',')[1],'base64'),format);
    const metadata=readPrivacyMetadata(bytes,format);
    assert.equal(metadata.exif[0].artist,SYNTHETIC_METADATA.artist);
    assert.deepEqual(metadata.exif[0].gps.latitude,[0,0,0]);assert.deepEqual(metadata.exif[0].gps.longitude,[0,0,0]);
    if(format==='png')assert.deepEqual(metadata.text,[{keyword:SYNTHETIC_METADATA.keyword,value:SYNTHETIC_METADATA.marker}]);
    else assert.deepEqual(metadata.xmp,[{creators:[SYNTHETIC_METADATA.artist],descriptions:[SYNTHETIC_METADATA.marker]}]);
    if(format==='jpg')assert.deepEqual(metadata.iptc.map(value=>value.dataset),[80,120]);
    rasterInputs[format]=`data:${{png:'image/png',jpg:'image/jpeg',webp:'image/webp'}[format]};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  const orientedJpeg=`data:image/jpeg;base64,${Buffer.from(tagPrivacyMetadata(baseJpeg,'jpg',{orientation:6})).toString('base64')}`;
  const raster=await manager.evaluate(async({inputs,orientedJpeg})=>{
    const {convertImage}=await import('./image-converter.js');
    const {imageResourceCoordinator}=await import('./image-decoder.js');
    const coordinator=imageResourceCoordinator(),NativeWorker=globalThis.Worker;
    const trace={created:0,terminated:0,requests:[]};
    globalThis.Worker=class extends NativeWorker{
      constructor(...args){super(...args);trace.created++;this.__compatTerminated=false;}
      postMessage(message,...rest){trace.requests.push({source:message.metadata?.format,width:message.metadata?.width,height:message.metadata?.height,frameCount:message.metadata?.frameCount,output:message.options?.format});return super.postMessage(message,...rest);}
      terminate(){if(!this.__compatTerminated){this.__compatTerminated=true;trace.terminated++;}return super.terminate();}
    };
    const decode=async blob=>{
      const image=await createImageBitmap(blob);let canvas;
      try{
        canvas=new OffscreenCanvas(image.width,image.height);const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
        const pixel=(x,y)=>[...context.getImageData(Math.min(x,image.width-1),Math.min(y,image.height-1),1,1).data];
        return {width:image.width,height:image.height,red:pixel(2,8),transparent:pixel(14,8),first:pixel(0,0),top:pixel(6,2),bottom:pixel(6,13)};
      }finally{image.close();if(canvas){canvas.width=1;canvas.height=1;}}
    };
    const conversion=async(url,format)=>{
      const ownerId='compat-raster:'+crypto.randomUUID();let blob;
      try{
        const before=trace.requests.length;blob=await convertImage(url,format,{ownerId});
        if(typeof blob.releaseResources!=='function')throw new Error('Converted raster has no releaseResources owner.');
        const held=Object.values(await coordinator.snapshot()).filter(entry=>entry.owner===ownerId);
        if(held.reduce((sum,entry)=>sum+(entry.encodedBytes||0),0)!==blob.size||held.some(entry=>entry.pixels||entry.fetches))throw new Error('Raster output ownership does not match its retained Blob.');
        return {format,type:blob.type,magic:[...new Uint8Array(await blob.slice(0,12).arrayBuffer())],bytes:[...new Uint8Array(await blob.arrayBuffer())],pixels:await decode(blob),worker:trace.requests.slice(before)};
      }finally{
        await blob?.releaseResources?.();
        if(Object.values(await coordinator.snapshot()).some(entry=>entry.owner===ownerId))throw new Error('Raster resources remained after releasing the converted output.');
      }
    };
    try{
      const matrix=[];
      for(const [source,url]of Object.entries(inputs))for(const format of ['jpg','png','webp'])matrix.push({source,...await conversion(url,format)});
      const oriented=[];
      for(const format of ['jpg','png','webp'])oriented.push(await conversion(orientedJpeg,format));
      // Two one-pixel frames use a global red/blue palette and distinct LZW
      // payloads. The output must be a single static image of the red first frame.
      const text=value=>new TextEncoder().encode(value);
      const gifBytes=[...text('GIF89a'),1,0,1,0,128,0,0,255,0,0,0,0,255,
        33,255,11,...text('NETSCAPE2.0'),3,1,0,0,0,
        33,249,4,0,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,
        33,249,4,0,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,76,1,0,59];
      const gif=await conversion('data:image/gif;base64,'+btoa(String.fromCharCode(...gifBytes)),'png');
      const remainingRecords=Object.values(await coordinator.snapshot());
      return {matrix,oriented,gif,workersCreated:trace.created,workersTerminated:trace.terminated,remaining:remainingRecords.length,remainingRecords,documentHidden:document.hidden};
    }finally{globalThis.Worker=NativeWorker;}
  },{inputs:rasterInputs,orientedJpeg});
  const magic=(entry,label)=>{
    const expected={jpg:'image/jpeg',png:'image/png',webp:'image/webp'}[entry.format];assert.equal(entry.type,expected,`${label}: encoded MIME`);
    if(entry.format==='jpg')assert.deepEqual(entry.magic.slice(0,3),[255,216,255],`${label}: JPEG signature`);
    if(entry.format==='png')assert.deepEqual(entry.magic.slice(0,8),[137,80,78,71,13,10,26,10],`${label}: PNG signature`);
    if(entry.format==='webp'){assert.equal(String.fromCharCode(...entry.magic.slice(0,4)),'RIFF');assert.equal(String.fromCharCode(...entry.magic.slice(8,12)),'WEBP');}
  };
  const near=(actual,expected,tolerance,label)=>expected.forEach((value,index)=>assert.ok(Math.abs(actual[index]-value)<=tolerance,`${label}: pixel ${actual} differs from ${expected}`));
  const privacy=entry=>{
    const metadata=readPrivacyMetadata(entry.bytes,entry.format);
    assert.equal(metadata.exif.some(value=>Object.hasOwn(value,'artist')||Object.hasOwn(value,'gps')),false,'tested EXIF Artist/GPS fields are absent');
    assert.equal(metadata.iptc.some(value=>value.record===2 && [80,120].includes(value.dataset)),false,'tested IPTC fields are absent');
    assert.equal(metadata.xmp.some(value=>value.creators.length||value.descriptions.length),false,'tested XMP fields are absent');
    assert.equal(metadata.text.some(value=>value.keyword===SYNTHETIC_METADATA.keyword),false,'tested PNG text field is absent');
    assert.equal(Buffer.from(entry.bytes).includes(Buffer.from(SYNTHETIC_METADATA.marker)),false,'synthetic marker is absent');
  };
  for(const entry of raster.matrix){
    const label=`Chrome116 ${entry.source}→${entry.format}`;magic(entry,label);
    privacy(entry);
    assert.deepEqual([entry.pixels.width,entry.pixels.height],[16,12],`${label}: decoded output dimensions`);
    assert.deepEqual(entry.worker,[{source:entry.source==='jpg'?'jpeg':entry.source,width:16,height:12,frameCount:1,output:entry.format}],`${label}: the real worker receives validated source dimensions and raster format`);
    near(entry.pixels.red,[255,0,0,255],30,label+' red');
    if(entry.source==='jpg')near(entry.pixels.transparent,[0,0,0,255],15,label+' opaque JPEG source');
    else if(entry.format==='jpg')near(entry.pixels.transparent,[255,255,255,255],10,label+' white transparency background');
    else assert.equal(entry.pixels.transparent[3],0,`${label}: alpha survives`);
  }
  const withoutBytes=({bytes,...entry})=>entry;
  report.raster={matrix:raster.matrix.map(withoutBytes),workersCreated:raster.workersCreated,workersTerminated:raster.workersTerminated,immediateRemaining:raster.remaining,immediateRecords:raster.remainingRecords,documentHidden:raster.documentHidden};
  checked('Chrome 116 native raster worker: PNG/JPEG/WebP source × three encoders, MIME/magic/dimensions/pixels and output ownership');
  checked('Chrome 116 valid synthetic EXIF/IPTC/XMP/PNG text fields absent after all nine source/encoder conversions');
  for(const entry of raster.oriented){
    const label=`Chrome116 EXIF6→${entry.format}`;magic(entry,label);privacy(entry);
    assert.deepEqual([entry.pixels.width,entry.pixels.height],[12,16],`${label}: clockwise dimensions`);
    near(entry.pixels.top,[255,0,0,255],30,`${label}: red band rotates to the top`);
    near(entry.pixels.bottom,[0,0,0,255],20,`${label}: opaque source rotates with pixels`);
    assert.deepEqual(entry.worker,[{source:'jpeg',width:12,height:16,frameCount:1,output:entry.format}],`${label}: worker receives oriented preflight dimensions`);
  }
  report.oriented=raster.oriented.map(withoutBytes);
  checked('Chrome 116 EXIF orientation 6: clockwise dimensions, pixels and tested metadata fields');
  magic(raster.gif,'Chrome116 GIF→PNG');assert.deepEqual([raster.gif.pixels.width,raster.gif.pixels.height],[1,1]);assert.deepEqual(raster.gif.pixels.first,[255,0,0,255]);
  assert.deepEqual(raster.gif.worker,[{source:'gif',width:1,height:1,frameCount:2,output:'png'}]);
  assert.equal(raster.workersCreated,13);assert.equal(raster.workersTerminated,13);
  // Per-owner release is already checked after each conversion. Preview
  // disposal above prevents any new cache ownership during final retirement.
  await manager.waitForFunction(async()=>Object.keys((await chrome.storage.session.get('imagecrate.imageResources.v1'))['imagecrate.imageResources.v1']||{}).length===0,null,{polling:50});
  const finalRemaining=await worker.evaluate(async()=>Object.keys((await chrome.storage.session.get('imagecrate.imageResources.v1'))['imagecrate.imageResources.v1']||{}).length);
  assert.equal(finalRemaining,0,'all direct-conversion and preview reservations return to zero');report.raster.remaining=finalRemaining;
  report.gif=withoutBytes(raster.gif);checked('Chrome 116 animated GIF first-frame static output, worker termination and zero remaining shared ledger');
  await manager.bringToFront();
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
