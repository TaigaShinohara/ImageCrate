// Runtime boundaries in an isolated current Chrome profile and temporary
// extension copy. Every media/source URL belongs to this synthetic local server.
// Optional-permission native prompts remain a separate UI acceptance gate:
// this copy pregrants only its two local fixture hosts, records real requests,
// and explicitly reports any denial/removal API-boundary simulation.
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'imagecrate-security-qa-'));
const extension=join(scratch,'extension'),profile=join(scratch,'profile'),downloads=join(scratch,'downloads');
const output=process.env.QA_OUTPUT_DIR||scratch;
await Promise.all([cp(join(repo,'extension'),extension,{recursive:true}),mkdir(join(profile,'Default'),{recursive:true}),mkdir(downloads),mkdir(output,{recursive:true})]);
await writeFile(join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloads,prompt_for_download:false}}));
const manifestPath=join(extension,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
manifest.host_permissions=['http://127.0.0.1/*','http://localhost/*'];
await writeFile(manifestPath,JSON.stringify(manifest));
const workerPath=join(extension,'background.js');
await writeFile(workerPath,await readFile(workerPath,'utf8')+'\nglobalThis.__securityOpenWorkspace=openWorkspace;\n');
const workspacePath=join(extension,'workspace.js');
const instrumentation=`
// Test copy only: observe resource lifetimes and isolate permission decisions.
const qa={permissionRequests:[],denyRequest:false,removedOrigins:new Set(),removalListeners:new Set(),urls:[],workersCreated:0,workersLive:0,imageSources:[],mainBitmapCalls:0};
globalThis.__securityQA=qa;
const qaRequest=chrome.permissions.request.bind(chrome.permissions),qaContains=chrome.permissions.contains.bind(chrome.permissions);
qa.nativeRemove=chrome.permissions.remove.bind(chrome.permissions);
chrome.permissions.request=options=>{qa.permissionRequests.push(options.origins||[]);return qa.denyRequest?Promise.resolve(false):qaRequest(options);};
chrome.permissions.contains=options=>(options.origins||[]).some(origin=>qa.removedOrigins.has(origin))?Promise.resolve(false):qaContains(options);
const qaAddRemoval=chrome.permissions.onRemoved.addListener.bind(chrome.permissions.onRemoved),qaRemoveRemoval=chrome.permissions.onRemoved.removeListener.bind(chrome.permissions.onRemoved);
chrome.permissions.onRemoved.addListener=listener=>{qa.removalListeners.add(listener);qaAddRemoval(listener);};
chrome.permissions.onRemoved.removeListener=listener=>{qa.removalListeners.delete(listener);qaRemoveRemoval(listener);};
const qaCreateURL=URL.createObjectURL.bind(URL),qaRevokeURL=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=qaCreateURL(blob);qa.urls.push({url,type:blob.type,size:blob.size,revoked:false});return url;};
URL.revokeObjectURL=url=>{for(const record of qa.urls)if(record.url===url)record.revoked=true;return qaRevokeURL(url);};
const qaImageSource=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
Object.defineProperty(HTMLImageElement.prototype,'src',{...qaImageSource,set(value){const text=String(value);qa.imageSources.push({scheme:text?( /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]||'relative'):'empty'});return qaImageSource.set.call(this,value);}});
const qaBitmap=globalThis.createImageBitmap?.bind(globalThis);if(qaBitmap)globalThis.createImageBitmap=(...args)=>{qa.mainBitmapCalls++;return qaBitmap(...args);};
const QAWorker=globalThis.Worker;
globalThis.Worker=class extends QAWorker{constructor(...args){super(...args);qa.workersCreated++;qa.workersLive++;let terminated=false;const terminate=this.terminate.bind(this);this.terminate=()=>{if(!terminated){terminated=true;qa.workersLive--;}return terminate();};}};
`;
await writeFile(workspacePath,instrumentation+await readFile(workspacePath,'utf8'));

const svg=(width=600,height=400)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#336699"/></svg>`;
const dataURL='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg(3000,2000));
const pngHeader=()=>{const bytes=Buffer.alloc(57);bytes.set([137,80,78,71,13,10,26,10]);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(6000,16);bytes.writeUInt32BE(5000,20);bytes.set([8,6,0,0,0],24);bytes.writeUInt32BE(0,33);bytes.write('IDAT',37);bytes.writeUInt32BE(0,45);bytes.write('IEND',49);return bytes;};
const counters=new Map(),held=[],streams=[],requestObservations=[];
let origin,otherOrigin;
const assetKey=(hostname,path)=>hostname+path;
const hits=(hostname,path)=>counters.get(assetKey(hostname,path))||0;
const assetHits=()=>[...counters.values()].reduce((sum,value)=>sum+value,0);
const documentFor=paths=>`<!doctype html><html lang="ja"><meta charset="utf-8"><title>ImageCrate security fixture</title><body>${paths.map((path,index)=>`<img data-src="${path}" alt="合成画像${index}">`).join('')}</body></html>`;
const server=createServer((request,response)=>{
  const parsed=new URL(request.url,'http://localhost'),path=parsed.pathname;
  const hostname=(request.headers.host||'').split(':')[0];
  if(path.startsWith('/assets/')){
    counters.set(assetKey(hostname,path),hits(hostname,path)+1);
    const expectedCookie=hostname==='127.0.0.1'?'imagecrate_qa_scope_a=synthetic-a-only':'imagecrate_qa_scope_b=synthetic-b-only';
    requestObservations.push({host:hostname,path,syntheticCookieReceived:Boolean(request.headers.cookie?.split(';').some(part=>part.trim()===expectedCookie)),refererPresent:Boolean(request.headers.referer)});
    if(path==='/assets/redirect'){
      response.writeHead(302,{Location:otherOrigin+'/assets/redirect-target.svg'});return response.end();
    }
    if(path==='/assets/huge.png'){response.setHeader('Content-Type','image/png');return response.end(pngHeader());}
    if(path==='/assets/declared.png'){
      const record={kind:'declared',closed:false,producedBytes:0};streams.push(record);response.writeHead(200,{'Content-Type':'image/png','Content-Length':8*1024*1024+1});response.flushHeaders();response.on('close',()=>{record.closed=true;});return;
    }
    if(path==='/assets/stream.png'){
      const record={kind:'stream',closed:false,producedBytes:0,plannedBytes:20*1024*1024};streams.push(record);
      response.writeHead(200,{'Content-Type':'image/png'});const chunk=Buffer.alloc(64*1024,65);
      const timer=setInterval(()=>{if(record.producedBytes>=record.plannedBytes){clearInterval(timer);response.end();return;}record.producedBytes+=chunk.length;response.write(chunk);},2);
      response.on('close',()=>{record.closed=true;clearInterval(timer);});return;
    }
    if(path==='/assets/held.svg'){
      response.setHeader('Content-Type','image/svg+xml');const record={response,closed:false,query:parsed.search};held.push(record);response.on('close',()=>{record.closed=true;});return;
    }
    response.setHeader('Content-Type','image/svg+xml');return response.end(svg());
  }
  response.setHeader('Content-Type','text/html; charset=utf-8');
  if(path==='/scope')return response.end(documentFor([origin+'/assets/a.svg',otherOrigin+'/assets/b.svg']));
  if(path==='/data')return response.end(documentFor([dataURL]));
  if(path==='/queue'||path==='/close')return response.end(documentFor(Array.from({length:6},(_,index)=>origin+`/assets/held.svg?case=${path.slice(1)}&i=${index}`)));
  const resource=({'/refused':'refused.svg','/cache':'cache.svg','/redirect':'redirect','/stream':'stream.png','/declared':'declared.png','/huge':'huge.png'})[path];
  response.end(documentFor(resource?[origin+'/assets/'+resource]:[]));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${server.address().port}`;otherOrigin=`http://localhost:${server.address().port}`;
const report={browser:'',chromiumSandbox:true,checks:[],permissionRemoval:null,cookieObservation:null,streams:[],limits:[
  'Only synthetic localhost media, a temporary extension copy/profile, and a temporary download folder are used.',
  'The test copy pregrants its two local fixture hosts. Workspace app consent is exercised through actual UI clicks.',
  'Only two synthetic HttpOnly SameSite=Lax cookies are seeded in the temporary profile. The server retains cookie-match and Referer-presence booleans only; values and Cookie headers are not logged. Cookie delivery is reported as observed, not guaranteed across browser policies.',
  'Permission rejection is simulated at chrome.permissions.request. A required-host removal that Chrome refuses is explicitly simulated at the contains/onRemoved boundary; native optional permission allow/deny/revoke remains manual acceptance.',
  'Stream counters are bytes produced by this HTTP fixture, not observed network wire bytes. No exact wire-byte cap, immediate cancellation time, browser RSS cap, or native decoder internal allocation cap is claimed.',
  'Noncancellable decoder late results and duplicate-consumer races are covered by deterministic unit tests; this browser suite checks real UI cancellation, real HTTP abort, workers and generated Object URL lifetimes.',
]};
const checked=label=>{report.checks.push(label);console.log('PASS '+label);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await pause(20);}throw new Error('Timed out: '+label);}
let context,worker,source;
const errors=[];
try{
  context=await chromium.launchPersistentContext(profile,{channel:process.env.CHROME_CHANNEL||'chrome',headless:true,chromiumSandbox:true,acceptDownloads:true,viewport:{width:1280,height:1000},ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--no-first-run']});
  report.browser=context.browser().version();const cdp=await context.browser().newBrowserCDPSession();
  const {id}=await cdp.send('Extensions.loadUnpacked',{path:extension});
  worker=context.serviceWorkers().find(value=>value.url().includes(id));if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:value=>value.url().includes(id)});
  await context.addCookies([
    {url:origin+'/',name:'imagecrate_qa_scope_a',value:'synthetic-a-only',httpOnly:true,sameSite:'Lax',secure:false},
    {url:otherOrigin+'/',name:'imagecrate_qa_scope_b',value:'synthetic-b-only',httpOnly:true,sameSite:'Lax',secure:false}
  ]);
  source=await context.newPage();
  const stateFor=manager=>worker.evaluate(async url=>{const key='workspace:'+new URL(url).searchParams.get('id');return(await chrome.storage.session.get(key))[key];},manager.url());
  const ledgerFor=id=>worker.evaluate(async id=>Object.values((await chrome.storage.session.get('imagecrate.imageResources.v1'))['imagecrate.imageResources.v1']||{}).filter(entry=>entry.owner.startsWith(id+':')),id);
  const opened=async path=>{
    await source.goto(origin+path);const tab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url),source.url());
    const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__securityOpenWorkspace(tab),tab)]);
    manager.on('pageerror',error=>errors.push(error.message));await manager.waitForLoadState('domcontentloaded');await manager.waitForFunction(()=>document.querySelector('#message')?.textContent.includes('候補を取得'));
    assert.equal(await manager.locator('.thumb img').count(),0,'new workspace must start with placeholders');
    return manager;
  };
  const qa=async manager=>{
    const observed=await manager.evaluate(()=>({requests:__securityQA.permissionRequests,urls:__securityQA.urls,workersCreated:__securityQA.workersCreated,workersLive:__securityQA.workersLive,imageSources:__securityQA.imageSources,mainBitmapCalls:__securityQA.mainBitmapCalls}));
    assert.ok(observed.imageSources.every(source=>source.scheme==='blob'||source.scheme==='empty'),'including detached images, only generated Blob URLs reach HTMLImageElement.src');
    assert.equal(observed.mainBitmapCalls,0,'source bitmap decoding never runs on the workspace main thread');
    return observed;
  };
  const preview=async(manager,index=0,{keyboard=false}={})=>{
    const button=manager.locator('.card').nth(index).locator('.preview-permission');
    if(keyboard){await button.focus();await button.press('Enter');assert.equal(await manager.evaluate(index=>document.activeElement===document.querySelectorAll('.card')[index]?.querySelector('.image-select'),index),true,'Enter transfers focus to the same card selection control before hiding its consent button');}
    else await button.click();
    await manager.waitForFunction(index=>{const image=document.querySelectorAll('.card')[index]?.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0&&image.src.startsWith('blob:');},index);
  };
  const refused=await opened('/refused');const noConsentBefore=assetHits();
  for(const url of [origin+'/assets/csp-probe.svg',dataURL]){
    const blocked=await refused.evaluate(async url=>{
      const image=document.createElement('img');image.hidden=true;let policy;
      const result=await new Promise(resolve=>{
        let failed=false;const finish=()=>{if(failed&&policy){clearTimeout(timer);document.removeEventListener('securitypolicyviolation',violation);resolve({failed,policy,width:image.naturalWidth});}};
        const violation=event=>{if(event.effectiveDirective==='img-src'){policy={directive:event.effectiveDirective,blocked:event.blockedURI.startsWith('data')?'data':new URL(event.blockedURI).protocol};finish();}};
        document.addEventListener('securitypolicyviolation',violation);
        const timer=setTimeout(()=>{document.removeEventListener('securitypolicyviolation',violation);resolve({failed,policy,timedOut:true});},3000);
        image.onerror=()=>{failed=true;finish();};image.onload=()=>{clearTimeout(timer);document.removeEventListener('securitypolicyviolation',violation);resolve({loaded:true,width:image.naturalWidth});};
        // Exercise the HTML attribute path as well as application Image.src.
        image.setAttribute('src',url);document.body.append(image);
      });image.remove();return result;
    },url);
    assert.equal(blocked.failed,true);assert.equal(blocked.timedOut,undefined);assert.equal(blocked.width,0);assert.equal(blocked.policy.directive,'img-src');
  }
  assert.equal(assetHits(),noConsentBefore,'CSP refuses remote attribute images before sending a request');
  checked('extension CSP blocks remote and data image attributes with a real img-src violation and no remote request');
  await pause(80);
  assert.equal(assetHits(),noConsentBefore);assert.equal((await qa(refused)).workersCreated,0);
  await refused.evaluate(()=>{__securityQA.denyRequest=true;});await refused.locator('.preview-permission').focus();await refused.locator('.preview-permission').press('Enter');
  assert.equal(await refused.evaluate(()=>document.activeElement===document.querySelector('.image-select')),true,'permission refusal preserves keyboard focus at the image selection control');
  await refused.waitForFunction(()=>document.querySelector('.preview-error')?.textContent.includes('許可されませんでした'));
  assert.equal(assetHits(),noConsentBefore);assert.equal((await qa(refused)).urls.length,0);assert.equal((await qa(refused)).workersCreated,0);
  await refused.locator('.image-select').check();const beforeBatch=(await stateFor(refused)).batch?.id;await refused.locator('#save').click();
  await until(async()=>{const state=await stateFor(refused);return state.batch?.id!==beforeBatch&&state.jobs[0]?.status==='complete';},'native original save after refused preview');
  const job=(await stateFor(refused)).jobs[0];const [download]=await worker.evaluate(id=>chrome.downloads.search({id}),job.downloadId);
  assert.equal(download.state,'complete');assert.equal(await readFile(download.filename,'utf8'),svg());assert.equal((await qa(refused)).workersCreated,0);
  checked('no preview request before consent or after rejected permission; selection and explicit native original saving still work');await refused.close();

  const scoped=await opened('/scope'),aBefore=hits('127.0.0.1','/assets/a.svg'),bBefore=hits('localhost','/assets/b.svg');
  assert.equal(await scoped.locator('.card').nth(0).locator('.preview-permission > span').innerText(),origin+' のプレビューを許可');
  assert.equal(await scoped.locator('.card').nth(1).locator('.preview-permission > span').innerText(),otherOrigin+' のプレビューを許可');
  const visibleScope=scoped.locator('.card').first().locator('.preview-scope');assert.equal(await visibleScope.isVisible(),true);assert.match(await visibleScope.innerText(),/全パス.*全ポート/);assert.match(await visibleScope.innerText(),/ログイン状態/);
  await preview(scoped,0,{keyboard:true});assert.equal(hits('127.0.0.1','/assets/a.svg'),aBefore+1);assert.equal(hits('localhost','/assets/b.svg'),bBefore);assert.equal(await scoped.locator('.card').nth(1).locator('img').count(),0);
  const [crossOriginResponse]=await Promise.all([scoped.waitForResponse(response=>response.url()===otherOrigin+'/assets/b.svg'),preview(scoped,1)]);assert.equal(hits('localhost','/assets/b.svg'),bBefore+1);
  assert.equal(crossOriginResponse.status(),200);assert.equal(crossOriginResponse.headers()['access-control-allow-origin'],undefined,'optional-host extension fetch succeeds without a permissive CORS response header');
  assert.equal(await source.evaluate(()=>document.cookie.includes('imagecrate_qa_scope_a')),false,'the synthetic authentication cookie is HttpOnly');
  const aRequest=requestObservations.find(record=>record.host==='127.0.0.1'&&record.path==='/assets/a.svg'),bRequest=requestObservations.find(record=>record.host==='localhost'&&record.path==='/assets/b.svg');
  assert.ok(aRequest&&bRequest);assert.equal(aRequest.refererPresent,false);assert.equal(bRequest.refererPresent,false);
  report.cookieObservation={httpOnly:true,sameSite:'Lax',hostAReceived:aRequest.syntheticCookieReceived,hostBReceived:bRequest.syntheticCookieReceived,hostAReferer:aRequest.refererPresent,hostBReferer:bRequest.refererPresent,crossHostResponseCORSPermission:false};
  if(!aRequest.syntheticCookieReceived||!bRequest.syntheticCookieReceived)report.limits.push('At least one synthetic SameSite=Lax cookie was not sent by this browser configuration; authenticated preview availability is not established for that host.');
  checked(`cross-host extension fetch succeeds without ACAO; synthetic HttpOnly Lax cookies observed A=${aRequest.syntheticCookieReceived}, B=${bRequest.syntheticCookieReceived}; Referer absent`);
  assert.deepEqual((await qa(scoped)).requests,[['http://127.0.0.1/*'],['http://localhost/*']]);
  assert.equal(await scoped.locator('.thumb img').evaluateAll(images=>images.every(image=>image.src.startsWith('blob:')&&image.naturalWidth<=384)),true);
  checked('visible host/scope explanation, Enter focus transfer, separate host consent and generated-only bounded thumbnails');await scoped.close();

  const cached=await opened('/cache'),cacheBefore=hits('127.0.0.1','/assets/cache.svg');await preview(cached);
  for(const query of ['cache.svg','','cache']){await cached.locator('#query').fill(query);await cached.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0;});}
  assert.equal(hits('127.0.0.1','/assets/cache.svg'),cacheBefore+1,'filter rerenders reuse encoded/static cache');
  const shown=await cached.locator('.thumb img').getAttribute('src');
  report.permissionRemoval=await cached.evaluate(async()=>{
    const origin='http://127.0.0.1/*';let native=false,nativeError='';try{native=await __securityQA.nativeRemove({origins:[origin]});}catch(error){nativeError=error.name;}
    if(!native){__securityQA.removedOrigins.add(origin);for(const listener of __securityQA.removalListeners)listener({origins:[origin]});}
    return {nativeSucceeded:native,nativeError,mode:native?'native optional removal':'required-grant contains/onRemoved boundary fixture'};
  });
  await cached.waitForFunction(shown=>!document.querySelector('.thumb img')&&__securityQA.urls.some(record=>record.url===shown&&record.revoked),shown);
  const afterRemoval=hits('127.0.0.1','/assets/cache.svg');await cached.locator('#query').fill('');await pause(80);assert.equal(hits('127.0.0.1','/assets/cache.svg'),afterRemoval);
  const cacheSession=(await stateFor(cached)).id;await until(async()=>(await ledgerFor(cacheSession)).length===0,'revoked cache reservations');
  checked('permission removal boundary invalidates displayed URL/cache and does not automatically reacquire consent');await cached.close();

  const embedded=await opened('/data'),networkBefore=assetHits();
  assert.match(await embedded.locator('.preview-permission > span').innerText(),/埋め込み画像/);assert.equal(await embedded.locator('.preview-scope').count(),0);
  await embedded.locator('.preview-open').click();assert.equal(await embedded.locator('#preview-stage img').count(),0);
  const embeddedConsent=embedded.locator('#preview-stage .preview-permission');await embeddedConsent.focus();await embeddedConsent.press('Enter');
  assert.equal(await embedded.evaluate(()=>document.activeElement?.id),'preview-select','viewer consent Enter transfers focus to its selection control');
  await embedded.waitForFunction(()=>{const image=document.querySelector('#preview-stage img');return image?.complete&&image.naturalWidth===2048&&image.src.startsWith('blob:');});
  await embedded.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth===384;});
  assert.equal(assetHits(),networkBefore);assert.deepEqual((await qa(embedded)).requests,[],'local embedded preview does not request a Chrome host permission');
  assert.match(await embedded.locator('[data-dimensions]').textContent(),/3000 × 2000/);
  assert.match(await embedded.locator('#preview-meta').textContent(),/3000 × 2000/);assert.equal(await embedded.locator('#preview-zoom').textContent(),'プレビューを等倍で表示');await embedded.locator('#preview-zoom').click();
  assert.equal(await embedded.locator('#preview-stage img').evaluate(image=>Math.round(image.getBoundingClientRect().width)),2048);assert.equal(assetHits(),networkBefore);
  const viewerURL=await embedded.locator('#preview-stage img').getAttribute('src');await embedded.keyboard.press('Escape');await embedded.waitForFunction(url=>__securityQA.urls.some(record=>record.url===url&&record.revoked),viewerURL);
  checked('explicit data-image consent is local; source dimensions and thumbnail/viewer sizes remain distinct with viewer URL release');await embedded.close();

  const redirected=await opened('/redirect'),targetBefore=hits('localhost','/assets/redirect-target.svg');await redirected.locator('.preview-permission').click();
  await redirected.waitForFunction(()=>/取得できません|取得に失敗|Failed to fetch/.test(document.querySelector('.preview-error')?.textContent||''));
  assert.equal(hits('localhost','/assets/redirect-target.svg'),targetBefore);assert.equal((await qa(redirected)).workersCreated,0);assert.equal((await qa(redirected)).urls.length,0);
  checked('cross-host redirects are refused before following the target or invoking a codec');await redirected.close();

  for(const path of ['/declared','/stream']){
    const manager=await opened(path);await manager.locator('.preview-permission').click();await manager.waitForFunction(()=>/容量|上限/.test(document.querySelector('.preview-error')?.textContent||''));
    const kind=path.slice(1);await until(()=>streams.some(record=>record.kind===kind&&record.closed),kind+' response cancellation');
    const record=streams.find(record=>record.kind===kind);if(kind==='stream')assert.ok(record.producedBytes<record.plannedBytes,'reader aborts this slow fixture before its entire planned body is produced');
    assert.equal((await qa(manager)).workersCreated,0);assert.equal((await qa(manager)).urls.length,0);
    checked(kind==='stream'?'unknown-length expanded response bytes stop before Blob/codec admission and cancel the stream':'oversized Content-Length refuses input and cancels the body without a codec');await manager.close();
  }
  const enormous=await opened('/huge');await enormous.locator('.preview-permission').click();await enormous.waitForFunction(()=>/寸法|画素数/.test(document.querySelector('.preview-error')?.textContent||''));
  assert.equal((await qa(enormous)).workersCreated,0);assert.equal((await qa(enormous)).urls.length,0);assert.equal(await enormous.locator('img').count(),0);
  checked('30MP declared source dimensions are rejected before a native decoder worker or displayed image');await enormous.close();

  const queued=await opened('/queue'),queueStart=held.length;await queued.locator('.preview-permission').first().click();
  await until(()=>held.slice(queueStart).length>=2,'two held preview fetches');assert.equal(held.slice(queueStart).filter(record=>!record.closed).length,2,'workspace fetch concurrency is two');
  await queued.locator('#query').fill('no-synthetic-match');await until(()=>held.slice(queueStart).every(record=>record.closed),'last-consumer HTTP abort after filter change');
  const urlsBeforeLate=(await qa(queued)).urls.length;for(const record of held.slice(queueStart)){try{record.response.end(svg());}catch{}}
  await pause(80);assert.equal((await qa(queued)).urls.length,urlsBeforeLate);assert.equal(urlsBeforeLate,0);assert.equal((await qa(queued)).workersCreated,0);assert.equal(await queued.locator('.card').count(),0);
  checked('filtering away queued/inflight cards aborts their last consumer and never adopts a late HTTP result');await queued.close();

  const closing=await opened('/close'),closeStart=held.length;await closing.locator('.preview-permission').first().click();await until(()=>held.slice(closeStart).length>=2,'close-case held fetches');
  const closingID=(await stateFor(closing)).id;await closing.close();await until(()=>held.slice(closeStart).every(record=>record.closed),'workspace close HTTP cancellation');
  for(const record of held.slice(closeStart)){try{record.response.end(svg());}catch{}}
  await until(async()=>(await ledgerFor(closingID)).length===0,'closed workspace reservation cleanup');
  checked('closing a workspace aborts pending HTTP work and clears its owned shared resource reservations');
  assert.deepEqual(errors,[],'no uncaught extension page errors');report.streams=streams.map(({kind,closed,producedBytes,plannedBytes})=>({kind,closed,producedBytes,plannedBytes}));
  console.log(`ImageCrate security browser PASS (${report.checks.length} checks; permission removal mode: ${report.permissionRemoval.mode}).`);
}catch(error){report.failure={name:error.name,message:error.message};throw error;}
finally{
  report.streams=streams.map(({kind,closed,producedBytes,plannedBytes})=>({kind,closed,producedBytes,plannedBytes}));
  await writeFile(join(output,'security-report.json'),JSON.stringify(report,null,2));
  await context?.close();for(const record of held){try{record.response.destroy();}catch{}}
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
  if(process.env.QA_KEEP||process.env.QA_OUTPUT_DIR)console.log('Security QA report: '+join(output,'security-report.json'));
  if(!process.env.QA_KEEP&&!process.env.QA_OUTPUT_DIR)await rm(scratch,{recursive:true,force:true});
}
