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
async function assertFilterGeometry(workspace,label) {
  const geometry=await workspace.evaluate(()=>{
    const rect=element=>{const box=element.getBoundingClientRect();return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height};};
    return {
      panel:rect(document.querySelector('#filter-panel')),query:rect(document.querySelector('#query')),
      summary:rect(document.querySelector('#filters > summary')),tools:rect(document.querySelector('.search-tools')),
      fields:['width','height','type'].map(id=>({id,...rect(document.getElementById(id))})),
      width:innerWidth,height:innerHeight,footerTop:document.querySelector('#footer').getBoundingClientRect().top
    };
  });
  const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
  for(const field of geometry.fields) {
    assert.ok(field.width>0 && field.height>=44,`${label}: ${field.id} has a usable field rectangle`);
    assert.ok(field.left>=0 && field.right<=geometry.width+1 && field.top>=0 && field.bottom<=Math.min(geometry.height,geometry.footerTop)+1,`${label}: ${field.id} stays in the viewport above the footer`);
    assert.ok(field.left>=geometry.panel.left-1 && field.right<=geometry.panel.right+1 && field.top>=geometry.panel.top-1 && field.bottom<=geometry.panel.bottom+1,`${label}: ${field.id} stays inside its panel`);
  }
  for(let i=0;i<geometry.fields.length;i++)for(let j=i+1;j<geometry.fields.length;j++) {
    assert.equal(overlaps(geometry.fields[i],geometry.fields[j]),false,`${label}: filter fields do not overlap`);
  }
  assert.equal(overlaps(geometry.panel,geometry.query),false,`${label}: the open panel does not cover search`);
  assert.equal(overlaps(geometry.panel,geometry.summary),false,`${label}: the open panel does not cover its summary`);
  if(geometry.width>=640)assert.ok(geometry.query.width>=geometry.tools.width/2,`${label}: search retains the main row width when filters open`);
}
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
    // Native disclosures must remain keyboard-operable and return focus on Escape.
    for(const disclosureId of ['filters','help']) {
      const summary=manager.locator(`#${disclosureId} > summary`);
      assert.equal(await summary.getAttribute('aria-expanded'),'false');
      await summary.focus();await summary.press('Enter');
      await manager.waitForFunction(id=>document.querySelector(`#${id}`).open && document.querySelector(`#${id} > summary`).getAttribute('aria-expanded')==='true',disclosureId);
      assert.ok(await manager.locator(`#${disclosureId} .disclosure-panel`).isVisible());
      if(disclosureId==='filters')await manager.locator('#width').focus();
      await manager.keyboard.press('Escape');
      await manager.waitForFunction(id=>!document.querySelector(`#${id}`).open && document.querySelector(`#${id} > summary`).getAttribute('aria-expanded')==='false',disclosureId);
      assert.equal(await manager.evaluate(id=>document.activeElement===document.querySelector(`#${id} > summary`),disclosureId),true,'Escape restores the disclosure summary focus');
      assert.equal(await manager.locator(`#${disclosureId} .disclosure-panel`).isVisible(),false);
    }
    await manager.locator('#filters > summary').click();
    await manager.locator('#width').fill('100');await manager.locator('#height').fill('100');await manager.locator('#type').selectOption('svg');
    await assertFilterGeometry(manager,'desktop filters');
    await manager.locator('#height').press('Escape');
    assert.equal(await manager.locator('#filter-count').textContent(),'3');
    assert.equal(await manager.locator('.filter-chip').count(),3,'closed filters expose every active dimension/type condition');
    assert.ok(await manager.locator('#active-filters').isVisible());
    const widthChip=manager.getByRole('button',{name:'幅 100px以上の条件を解除',exact:true});
    await widthChip.focus();await widthChip.press('Enter');
    assert.equal(await manager.locator('#width').inputValue(),'0');
    assert.equal(await manager.locator('.filter-chip').count(),2);
    assert.equal(await manager.evaluate(()=>document.activeElement?.classList.contains('filter-chip')),true,'removing a focused chip preserves a useful keyboard focus');
    await manager.locator('#reset-filters').click();
    assert.equal(await manager.locator('#height').inputValue(),'0');assert.equal(await manager.locator('#type').inputValue(),'');
    assert.equal(await manager.locator('#active-filters').isVisible(),false);assert.equal(await manager.locator('#filter-count').isVisible(),false);
    assert.equal(await manager.evaluate(()=>document.activeElement?.id),'query');
    await manager.locator('#query').fill('no-such-image-for-qa');
    assert.ok(await manager.locator('#empty').isVisible());assert.equal(await manager.locator('.card').count(),0);
    await manager.locator('#empty').getByRole('button',{name:'条件をリセット',exact:true}).click();
    assert.ok(await manager.locator('.card').count()>=5);assert.equal(await manager.locator('#query').inputValue(),'');
    assert.equal(await manager.evaluate(()=>document.activeElement?.id),'query');
    const cardSemantics=await manager.locator('.card').evaluateAll(cards=>cards.every(card=>{
      const checkbox=card.querySelector('input[type="checkbox"]'),meta=card.querySelector('.meta'),format=card.querySelector('.file-type');
      const descriptions=checkbox.getAttribute('aria-describedby')?.split(/\s+/).map(id=>document.getElementById(id));
      return checkbox.getAttribute('aria-label')?.endsWith('を選択') && descriptions?.length===2 && descriptions.every(Boolean)
        && /×|寸法不明/.test(meta.textContent) && !!format.textContent && getComputedStyle(meta).display!=='none' && getComputedStyle(format).display!=='none';
    }));
    assert.equal(cardSemantics,true,'every checkbox names its image and describes always-present dimensions/type and save state');
    await manager.locator('.image-select').first().focus();await manager.keyboard.press('Space');
    assert.equal(await manager.locator('.image-select').first().isChecked(),true,'native checkbox supports Space');
    await manager.keyboard.press('Space');
    assert.equal(await manager.locator('.image-select').first().isChecked(),false);
    const boxes=manager.locator('.image-select');await boxes.nth(0).check();await boxes.nth(1).check();
    await manager.locator('#query').fill('red.svg');assert.match(await manager.locator('#selection').textContent(),/非表示1件/);
    assert.match(await manager.locator('#selection-hint').textContent(),/非表示の画像も保存/);
    assert.equal(await manager.getByRole('button',{name:'選択2件を保存',exact:true}).count(),1,'save action retains its count and accessible label');
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
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-desktop.png'),fullPage:true,animations:'disabled'});
  if(manifest.name==='ImageCrate') {
    // A second representative visual state includes open filters, chips and hidden selections.
    await manager.locator('.image-select').nth(0).check();await manager.locator('.image-select').nth(1).check();
    await manager.locator('#filters > summary').click();
    await manager.locator('#width').fill('100');await manager.locator('#type').selectOption('svg');await manager.locator('#query').fill('red.svg');
    await assertFilterGeometry(manager,'selected desktop filters');
    if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-filters-desktop.png'),fullPage:false,animations:'disabled'});
    await manager.locator('#reset-filters').click();await manager.locator('#clear').click();
    await manager.locator('#filters > summary').focus();await manager.keyboard.press('Escape');
    // A 640 CSS-pixel viewport exercises the reflow used by 200% zoom on a 1280px window.
    // This checks layout only; it does not claim actual browser-zoom or screen-reader QA.
    await manager.setViewportSize({width:640,height:900});
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'640px zoom-equivalent layout does not overflow');
    await manager.locator('#filters > summary').click();
    assert.ok(await manager.locator('#width').isVisible());assert.ok(await manager.locator('#type').isVisible());
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'expanded filters reflow at 640px');
    await assertFilterGeometry(manager,'640px filters');
    await manager.locator('#width').press('Escape');
  }
  await manager.setViewportSize({width:360,height:900});
  assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'360px layout does not overflow');
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT,fullPage:true,animations:'disabled'});
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-viewport.png'),fullPage:false,animations:'disabled'});
  if(manifest.name==='ImageCrate') {
    assert.equal(await manager.locator('.grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2,'360px keeps two image columns');
    await manager.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    const mobileGeometry=await manager.evaluate(()=>{
      const footer=document.querySelector('#footer').getBoundingClientRect(),save=document.querySelector('#save').getBoundingClientRect(),last=document.querySelector('.card:last-child').getBoundingClientRect();
      return {footerTop:footer.top,footerBottom:footer.bottom,saveTop:save.top,saveBottom:save.bottom,lastBottom:last.bottom,height:innerHeight};
    });
    assert.ok(mobileGeometry.footerTop>=0 && mobileGeometry.footerBottom<=mobileGeometry.height+1,'mobile footer remains inside the viewport');
    assert.ok(mobileGeometry.saveTop>=0 && mobileGeometry.saveBottom<=mobileGeometry.height+1,'mobile save action remains inside the viewport');
    assert.ok(mobileGeometry.lastBottom<=mobileGeometry.footerTop+1,'scrolling to the end exposes the last card above the sticky footer');
    await manager.emulateMedia({reducedMotion:'reduce'});
    await manager.locator('#filters > summary').click();
    await assertFilterGeometry(manager,'360px filters');
    const reducedStyles=await manager.locator('#filter-panel').evaluate(el=>({animation:getComputedStyle(el).animationName,transition:getComputedStyle(document.querySelector('.card')).transitionDuration}));
    assert.equal(reducedStyles.animation,'none');assert.equal(reducedStyles.transition,'0s');
    await manager.locator('#width').press('Escape');
    await manager.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
    await manager.locator('.image-select').first().check();
    const forcedStyles=await manager.locator('.image-select').first().evaluate(el=>({appearance:getComputedStyle(el).appearance,outline:getComputedStyle(el.closest('.card')).outlineStyle}));
    assert.equal(forcedStyles.appearance,'auto','forced colors restore the native checkbox');assert.notEqual(forcedStyles.outline,'none','selected card has a forced-colors outline');
    assert.ok(await manager.getByRole('checkbox').first().isChecked());
    await manager.locator('#clear').click();await manager.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
    await manager.setViewportSize({width:1280,height:900});
    // The synthetic session belongs only to this temporary Chrome profile. Restore it afterward.
    const stressState=await restartedWorker.evaluate(async ({managerUrl,origin})=>{
      const key=`workspace:${new URL(managerUrl).searchParams.get('id')}`,original=(await chrome.storage.session.get(key))[key];
      const items=Array.from({length:500},(_,index)=>({url:`${origin}/stress-${String(index).padStart(3,'0')}.svg`,width:640,height:480,alt:`Synthetic image ${index}`,type:'image'}));
      await chrome.storage.session.set({[key]:{...original,items,notices:[],scanned:true}});return {key,original};
    },{managerUrl:manager.url(),origin});
    try {
      await manager.reload();await manager.waitForFunction(()=>document.querySelectorAll('.card').length===500);
      await manager.locator('#query').focus();
      const stressResults=await manager.evaluate(()=>{
        const input=document.querySelector('#query'),results=[];
        for(const [query,expected] of [['stress-1',100],['stress-2',100],['stress-49',10],['no-stress-match',0],['',500]]) {
          const start=performance.now();input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));
          results.push({query,expected,count:document.querySelectorAll('.card').length,elapsedMs:Math.round(performance.now()-start),entryAnimation:[...document.querySelectorAll('.card')].some(card=>getComputedStyle(card).animationName!=='none'),queryFocused:document.activeElement===input});
        }
        return results;
      });
      for(const result of stressResults) {
        assert.equal(result.count,result.expected,`500-candidate query ${result.query || '(all)'} returns current results`);
        assert.equal(result.entryAnimation,false,'filter rebuilds do not replay card entry animations');assert.equal(result.queryFocused,true,'repeated filtering keeps search focus');
      }
      console.log(`ImageCrate 500-candidate synchronous filter timings (ms): ${stressResults.map(result=>result.elapsedMs).join(', ')}. These are local measurements, not human usability results.`);
    } finally {
      await restartedWorker.evaluate(async ({key,original})=>chrome.storage.session.set({[key]:original}),stressState);
      await manager.reload();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全7件'));
    }
  }
  assert.deepEqual(errors,[],'no uncaught page errors');
  console.log(`${manifest.name} browser smoke PASS (isolated Chrome, local fixture). Native activeTab invocation, tabCapture consent and macOS display/audio remain manual.`);
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {await context?.close();await new Promise(resolve=>server.close(resolve));if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});}
