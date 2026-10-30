// Runs an isolated Chrome profile. Test copy grants ONLY the local fixture origin.
// Real activeTab toolbar invocation and native macOS pickers remain manual QA.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'media-extension-qa-'));
const extension=join(scratch,'extension');await cp(join(repo,'extension'),extension,{recursive:true});
const workerPath=join(extension,'background.js');await writeFile(workerPath,(await readFile(workerPath,'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;globalThis.__workerBoot=crypto.randomUUID();\n');
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
let clip=Buffer.alloc(0), failedOnce=true;
const fixture=`<!doctype html><html lang="ja"><title>Synthetic media fixture</title><body><h1>Local fixture</h1><img src="/red.svg" alt="赤" width="320" height="200"><img src="/blue.svg" alt="青" width="400" height="300"><img src="/red.svg"><div style="background-image:url('/green.svg');width:100px;height:100px"></div><picture><source srcset="/red.svg 1x, /blue.svg 2x"><img src="/red.svg"></picture><div id="shadow"></div><iframe src="/frame"></iframe><video controls src="/clip.webm" width="320" height="180"></video><a href="/stream.m3u8">stream</a><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<img src="/shadow.svg">';</script></body></html>`;
const server=createServer((req,res)=>{
  if(req.url==='/frame') {res.setHeader('Content-Type','text/html');return res.end('<img src="/frame.svg">');}
  if(req.url.startsWith('/clip.webm')) {res.setHeader('Content-Type','video/webm');return res.end(clip);}
  if(req.url.startsWith('/stream.m3u8')) {res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end('#EXTM3U\n');}
  if(req.url.startsWith('/fail.svg') && failedOnce) {res.statusCode=403;return res.end('blocked');}
  if(req.url.endsWith('.svg')) {res.setHeader('Content-Type','image/svg+xml');return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${req.url.includes('blue')?'#566ac4':req.url.includes('green')?'#58a884':'#e8987e'}"/></svg>`);}
  res.setHeader('Content-Type','text/html');res.end(fixture);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let context;
try {
  context=await chromium.launchPersistentContext(join(scratch,'profile'),{channel:process.env.CHROME_CHANNEL || 'chrome',headless:true,acceptDownloads:true,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required','--no-first-run']});
  const browserSession=await context.browser().newBrowserCDPSession();
  const {id}=await browserSession.send('Extensions.loadUnpacked',{path:extension});
  let worker=context.serviceWorkers().find(w=>w.url().includes(id));
  if(!worker) worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes(id)});
  const page=await context.newPage();await page.goto(origin);
  // Generate a small synthetic video locally; no remote media or personal pages.
  clip=Buffer.from(await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[];
    const rec=new MediaRecorder(stream,{mimeType:'video/webm'});
    const ready=new Promise(resolve=>{rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer())]);});
    rec.start(100);let n=0;const timer=setInterval(()=>{ctx.fillStyle=`hsl(${n++*15} 70% 50%)`;ctx.fillRect(0,0,320,180);},40);
    await new Promise(r=>setTimeout(r,400));rec.stop();clearInterval(timer);stream.getTracks().forEach(t=>t.stop());return ready;
  }));
  await page.reload();
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url?.startsWith(origin)),origin);
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  await manager.waitForLoadState();
  const errors=[];manager.on('pageerror',e=>errors.push(e.message));
  await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('候補を取得'));
  const downloadFolder=join(scratch,'downloads');await mkdir(downloadFolder);
  const session=await context.newCDPSession(manager);await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadFolder,eventsEnabled:true});
  if(manifest.name==='ImageCrate') {
    assert.ok(await manager.locator('.card').count()>=5,'DOM, background, shadow and frame collection');
    assert.equal(await manager.locator('.image-select:checked').count(),0,'initial selection is empty');
    const boxes=manager.locator('.image-select');await boxes.nth(0).check();await boxes.nth(1).check();
    await manager.locator('#query').fill('red.svg');assert.match(await manager.locator('#selection').textContent(),/非表示1件/);
    await manager.locator('#save').click();
    await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('2件保存完了'));
    assert.equal(await manager.locator('#selection').textContent(),'選択0件');
    await manager.locator('#query').fill('');
    await page.evaluate(origin=>{const image=new Image();image.src=origin+'/added.svg';document.body.append(image);},origin);
    await manager.locator('#scan').click();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全6件'));
    assert.equal(await manager.locator('.image-select:checked').count(),0,'rescan never reselects completed/new images');
    assert.match(await manager.locator('.card').filter({hasText:'red.svg'}).first().locator('.item-status').textContent(),/保存完了/);
    // Failed download keeps selection; retry only that item, with a fresh ID.
    await page.evaluate(origin=>{const image=new Image();image.dataset.src=origin+'/fail.svg';document.body.append(image);},origin);
    await manager.locator('#scan').click();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全7件'));
    await manager.locator('.card').filter({hasText:'fail.svg'}).locator('input').check();await manager.locator('#save').click();
    await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件中断'));
    assert.match(await manager.locator('#selection').textContent(),/選択1件/);
    failedOnce=false;
    await manager.locator('#retry').click();await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
  } else {
    assert.ok(await manager.locator('.direct-save').count()>=1);assert.ok(await manager.locator('#unsupported-count').textContent());
    await manager.locator('.direct-save').first().click();await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
    await manager.locator('#record-tab').click();
    // Inject synthetic capture at the native API boundary; exercise actual MediaRecorder lifecycle.
    await manager.evaluate(()=>{
      window.__captureTracks=[];
      Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#258d79';ctx.fillRect(0,0,320,180);
        const stream=canvas.captureStream(12);window.__captureTracks.push(...stream.getTracks());
        const timer=setInterval(()=>{ctx.fillStyle=`hsl(${Date.now()%360} 60% 50%)`;ctx.fillRect(0,0,320,180);},80);
        stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
      }});
    });
    await manager.locator('#record-mode').selectOption('display');await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-state').textContent==='録画中');
    assert.equal(await manager.locator('#download-tab').isDisabled(),true);
    await manager.locator('#pause-record').click();assert.equal(await manager.locator('#record-state').textContent(),'一時停止中');
    await manager.locator('#pause-record').click();
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-state').textContent.includes('保存してください'));
    assert.ok(await manager.evaluate(()=>window.__captureTracks.every(t=>t.readyState==='ended')),'all capture tracks stopped');
    assert.equal(await manager.locator('#start-record').isDisabled(),true,'unsaved capture blocks replacement');
    assert.match(await manager.locator('#record-description').textContent(),/音声なし/);
    // SaveAs is a native picker: mock only saveAs option for automated download destination.
    await manager.evaluate(()=>{const original=chrome.downloads.download.bind(chrome.downloads);chrome.downloads.download=options=>original({...options,saveAs:false});});
    await manager.locator('#save-record').click();await manager.waitForFunction(()=>document.querySelector('#record-state').textContent==='ファイル保存完了');
    assert.equal(await manager.locator('#download-tab').isDisabled(),false);
    const [savedCapture]=await manager.evaluate(()=>chrome.downloads.search({urlRegex:'^blob:'}));
    const captureBytes=await readFile(savedCapture.filename);assert.ok(captureBytes.length>100);
    clip=captureBytes;
    await page.evaluate(async origin=>{const v=document.querySelector('video');v.src=origin+'/clip.webm?recorded=1';await v.play();},origin);
    await page.waitForFunction(()=>document.querySelector('video').videoWidth===320 && document.querySelector('video').currentTime>0);
    // Cancel does not replace the previously completed recording.
    await manager.evaluate(()=>{Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{throw new DOMException('cancel','NotAllowedError');}});});
    await manager.locator('#start-record').click();await manager.waitForFunction(()=>!document.querySelector('#start-record').disabled);
    assert.ok(!await manager.locator('#stop-record').isVisible());
  }
  // A real extension service worker stop/restart must retain session-scoped result state.
  const bootBefore=await worker.evaluate(()=>globalThis.__workerBoot);
  await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
  await manager.reload();
  await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
  await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
  const restartedWorker=context.serviceWorkers().find(w=>w.url().includes(id));
  assert.ok(restartedWorker,'worker is available after page reconnects');
  assert.notEqual(await restartedWorker.evaluate(()=>globalThis.__workerBoot),bootBefore,'service worker actually restarted');
  if(manifest.name==='VideoHarbor')await manager.locator('#record-tab').click();
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-desktop.png'),fullPage:true});
  await manager.setViewportSize({width:360,height:900});
  assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'360px layout does not overflow');
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors,[],'no uncaught page errors');
  console.log(`${manifest.name} browser smoke PASS (isolated Chrome, local fixture). Native activeTab invocation, tabCapture consent and macOS display/audio remain manual.`);
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {await context?.close();await new Promise(resolve=>server.close(resolve));if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});}
