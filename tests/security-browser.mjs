// Runtime boundaries in an isolated current Chrome profile and temporary
// extension copy. Every media/source URL belongs to this synthetic local server.
// Optional-permission native prompts remain a separate UI acceptance gate:
// this copy pregrants only its two local fixture hosts, records real requests,
// and explicitly reports initial-ungranted, denial/removal API-boundary fixtures.
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
const qaFixture=await chrome.storage.session.get(['imagecrate-security-qa.initiallyBlocked','imagecrate-security-qa.blockSourceAccess']);
const qaInitial=qaFixture['imagecrate-security-qa.initiallyBlocked']||[];
const qa={permissionRequests:[],sourceAccessRequests:0,blockSourceAccess:qaFixture['imagecrate-security-qa.blockSourceAccess']!==false,denyRequest:false,removedOrigins:new Set(qaInitial),removalListeners:new Set(),additionListeners:new Set(),urls:[],workersCreated:0,workersLive:0,imageSources:[],mainBitmapCalls:0};
globalThis.__securityQA=qa;
const qaSendMessage=chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.runtime.sendMessage=(message,...args)=>{if(message?.type==='preview-access'){qa.sourceAccessRequests++;if(qa.blockSourceAccess)return Promise.resolve({ok:true,data:false});}return qaSendMessage(message,...args);};
const qaRequest=chrome.permissions.request.bind(chrome.permissions),qaContains=chrome.permissions.contains.bind(chrome.permissions);
qa.nativeRemove=chrome.permissions.remove.bind(chrome.permissions);
chrome.permissions.request=options=>{qa.permissionRequests.push(options.origins||[]);if(qa.denyRequest)return Promise.resolve(false);return Promise.resolve(qaRequest(options)).then(allowed=>{if(allowed)for(const origin of options.origins||[])qa.removedOrigins.delete(origin);return allowed;});};
chrome.permissions.contains=options=>(options.origins||[]).some(origin=>qa.removedOrigins.has(origin))?Promise.resolve(false):qaContains(options);
const qaAddRemoval=chrome.permissions.onRemoved.addListener.bind(chrome.permissions.onRemoved),qaRemoveRemoval=chrome.permissions.onRemoved.removeListener.bind(chrome.permissions.onRemoved);
chrome.permissions.onRemoved.addListener=listener=>{qa.removalListeners.add(listener);qaAddRemoval(listener);};
chrome.permissions.onRemoved.removeListener=listener=>{qa.removalListeners.delete(listener);qaRemoveRemoval(listener);};
const qaAddAddition=chrome.permissions.onAdded.addListener.bind(chrome.permissions.onAdded),qaRemoveAddition=chrome.permissions.onAdded.removeListener.bind(chrome.permissions.onAdded);
chrome.permissions.onAdded.addListener=listener=>{qa.additionListeners.add(listener);qaAddAddition(listener);};
chrome.permissions.onAdded.removeListener=listener=>{qa.additionListeners.delete(listener);qaRemoveAddition(listener);};
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
    if(path==='/assets/fail-once.svg'&&hits(hostname,path)===1){response.statusCode=503;return response.end('synthetic first request failure');}
    if(path==='/assets/bad-request.bin'){response.statusCode=400;return response.end('synthetic 400 response');}
    if(path==='/assets/unrecognized.bin'){response.setHeader('Content-Type','application/octet-stream');return response.end('synthetic unrecognized bytes');}
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
  if(path==='/cdn')return response.end(documentFor(Array.from({length:5},(_,index)=>otherOrigin+`/assets/cdn-${index}.svg`)));
  if(path==='/data')return response.end(documentFor([dataURL]));
  if(path==='/queue'||path==='/close')return response.end(documentFor(Array.from({length:6},(_,index)=>origin+`/assets/held.svg?case=${path.slice(1)}&i=${index}`)));
  const resource=({'/refused':'refused.svg','/active-tab':'active-tab.svg','/retry':'fail-once.svg','/bad-request':'bad-request.bin','/unrecognized':'unrecognized.bin','/cache':'cache.svg','/redirect':'redirect','/stream':'stream.png','/declared':'declared.png','/huge':'huge.png'})[path];
  response.end(documentFor(resource?[origin+'/assets/'+resource]:[]));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${server.address().port}`;otherOrigin=`http://localhost:${server.address().port}`;
const report={browser:'',chromiumSandbox:true,checks:[],permissionRemoval:null,cookieObservation:null,streams:[],limits:[
  'Only synthetic localhost media, a temporary extension copy/profile, and a temporary download folder are used.',
  'The test copy pregrants only two fixture hosts. Automatic previews use those existing grants; initially-ungranted fixtures simulate contains=false and deny only the read-only source-access message before workspace initialization. Grants use actual UI clicks.',
  'The activeTab fallback case simulates contains=false while exercising the real background source/session validation and real permitted-host fetch. Actual toolbar activeTab authorization remains manual.',
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
  const opened=async(path,{blockedOrigins=[],blockSourceAccess=blockedOrigins.length>0,expectBlocked=blockedOrigins.length>0}={})=>{
    await worker.evaluate(({blockedOrigins,blockSourceAccess})=>chrome.storage.session.set({'imagecrate-security-qa.initiallyBlocked':blockedOrigins,'imagecrate-security-qa.blockSourceAccess':blockSourceAccess}),{blockedOrigins,blockSourceAccess});
    await source.goto(origin+path);const tab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url),source.url());
    const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__securityOpenWorkspace(tab),tab)]);
    manager.on('pageerror',error=>errors.push(error.message));await manager.waitForLoadState('domcontentloaded');await manager.waitForFunction(()=>document.querySelector('#message')?.textContent.includes('候補を取得'));
    if(expectBlocked){
      await manager.waitForFunction(()=>[...document.querySelectorAll('.preview-error')].some(node=>/許可/.test(node.textContent)));
      assert.equal(await manager.locator('.thumb img').count(),0,'an initially ungranted host remains a placeholder');
      assert.deepEqual(await manager.evaluate(()=>__securityQA.permissionRequests),[],'startup never opens a Chrome permission prompt automatically');
    }
    return manager;
  };
  const qa=async manager=>{
    const observed=await manager.evaluate(()=>({requests:__securityQA.permissionRequests,sourceAccessRequests:__securityQA.sourceAccessRequests,urls:__securityQA.urls,workersCreated:__securityQA.workersCreated,workersLive:__securityQA.workersLive,imageSources:__securityQA.imageSources,mainBitmapCalls:__securityQA.mainBitmapCalls}));
    assert.ok(observed.imageSources.every(source=>source.scheme==='blob'||source.scheme==='empty'),'including detached images, only generated Blob URLs reach HTMLImageElement.src');
    assert.equal(observed.mainBitmapCalls,0,'source bitmap decoding never runs on the workspace main thread');
    return observed;
  };
  const preview=async(manager,index=0,{keyboard=false}={})=>{
    const button=manager.locator('.card').nth(index).locator('.preview-permission');
    if(keyboard){await button.focus();await button.press('Enter');assert.equal(await manager.evaluate(index=>document.activeElement===document.querySelectorAll('.card')[index]?.querySelector('.image-select'),index),true,'Enter transfers focus to the same card selection control before hiding its permission button');}
    else await button.click();
    await manager.waitForFunction(index=>{const image=document.querySelectorAll('.card')[index]?.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0&&image.src.startsWith('blob:');},index);
  };
  const refused=await opened('/refused',{blockedOrigins:['http://127.0.0.1/*']});const noPermissionBefore=assetHits();
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
  assert.equal(assetHits(),noPermissionBefore,'CSP refuses remote attribute images before sending a request');
  checked('extension CSP blocks remote and data image attributes with a real img-src violation and no remote request');
  await pause(80);
  assert.equal(assetHits(),noPermissionBefore);assert.equal((await qa(refused)).workersCreated,0);
  await refused.evaluate(()=>{__securityQA.denyRequest=true;});await refused.locator('.preview-permission').focus();await refused.locator('.preview-permission').press('Enter');
  assert.equal(await refused.evaluate(()=>document.activeElement===document.querySelector('.image-select')),true,'permission refusal preserves keyboard focus at the image selection control');
  await refused.waitForFunction(()=>document.querySelector('.preview-error')?.textContent.includes('許可')&&!document.querySelector('.preview-permission')?.disabled);
  assert.deepEqual((await qa(refused)).requests,[['http://127.0.0.1/*']],'the explicit permission click made exactly one denied concrete-host request');
  assert.equal(assetHits(),noPermissionBefore);assert.equal((await qa(refused)).urls.length,0);assert.equal((await qa(refused)).workersCreated,0);
  await refused.locator('.image-select').check();const beforeBatch=(await stateFor(refused)).batch?.id;await refused.locator('#save').click();
  await until(async()=>{const state=await stateFor(refused);return state.batch?.id!==beforeBatch&&state.jobs[0]?.status==='complete';},'native original save after refused preview');
  const job=(await stateFor(refused)).jobs[0];const [download]=await worker.evaluate(id=>chrome.downloads.search({id}),job.downloadId);
  assert.equal(download.state,'complete');assert.equal(await readFile(download.filename,'utf8'),svg());assert.equal((await qa(refused)).workersCreated,0);
  checked('ungranted hosts and rejected permission make no preview requests; selection and explicit native original saving still work');await refused.close();

  const aBefore=hits('127.0.0.1','/assets/a.svg'),bBefore=hits('localhost','/assets/b.svg');
  const scoped=await opened('/scope',{blockedOrigins:['http://127.0.0.1/*','http://localhost/*']});
  assert.equal(await scoped.locator('.card').nth(0).locator('.preview-source').innerText(),'配信元: '+origin);
  assert.equal(await scoped.locator('.card').nth(1).locator('.preview-source').innerText(),'配信元: '+otherOrigin);
  for(const width of [1280,640,360]) {
    await scoped.setViewportSize({width,height:width===360?800:900});
    const geometry=await scoped.locator('.card').first().evaluate(card=>{
      const rect=selector=>{const r=card.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      return {thumb:rect('.thumb'),button:rect('.preview-permission'),checkbox:rect('.image-select'),source:rect('.preview-source'),scope:rect('.preview-scope'),labelledButton:!!card.querySelector('label .preview-permission'),described:card.querySelector('.preview-permission').getAttribute('aria-describedby')===card.querySelector('.preview-details').id,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.equal(geometry.labelledButton,false,'preview action stays outside checkbox labels');assert.equal(geometry.described,true,'the action is linked to its full source and scope explanation');
    assert.ok(geometry.button.top>=geometry.thumb.top&&geometry.button.bottom<=geometry.thumb.bottom&&geometry.button.left>=geometry.thumb.left&&geometry.button.right<=geometry.thumb.right,'the preview action is inside the empty thumbnail');
    assert.ok(geometry.button.top>=geometry.checkbox.bottom&&geometry.button.height>=44,'the preview action is usable without overlapping selection');
    assert.ok(geometry.scope.top>=geometry.source.bottom,'source and scope are stacked rather than squeezed side by side');assert.equal(geometry.overflow,false);
    await scoped.locator('.card').first().evaluate(card=>card.scrollIntoView({block:'start'}));
    await scoped.screenshot({path:join(output,`preview-after-${width}.png`)});
    const longSource=await scoped.locator('.preview-source').first().evaluate(element=>{
      const original=element.textContent;element.textContent='配信元: https://images.from-a-long-subdomain.example.test:8443';
      const result={overflow:element.scrollWidth>element.clientWidth,clipped:getComputedStyle(element).overflowY==='hidden'};element.textContent=original;return result;
    });
    assert.deepEqual(longSource,{overflow:false,clipped:false},'long hosts wrap without horizontal overflow or clipping');
  }
  await scoped.setViewportSize({width:1280,height:900});
  const visibleScope=scoped.locator('.card').first().locator('.preview-scope');assert.equal(await visibleScope.isVisible(),true);assert.match(await visibleScope.innerText(),/全パス.*全ポート/);assert.match(await visibleScope.innerText(),/ログイン状態/);assert.match(await visibleScope.innerText(),/同じ配信元のプレビューも表示/);
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
  checked('visible host/scope explanation, Enter focus transfer, separate concrete-host permissions and generated-only bounded thumbnails');await scoped.close();

  const cdnHits=()=>Array.from({length:5},(_,index)=>hits('localhost',`/assets/cdn-${index}.svg`)).reduce((sum,count)=>sum+count,0);
  const cdnBefore=cdnHits(),cdn=await opened('/cdn',{blockedOrigins:['http://localhost/*']});
  const waitForCDNPermission=()=>cdn.waitForFunction(()=>document.querySelectorAll('.card').length===5&&[...document.querySelectorAll('.card')].every(card=>card.querySelector('.preview-error')?.textContent.includes('許可')));
  await waitForCDNPermission();
  const summary=cdn.locator('#preview-access'),cdnGrant=summary.locator('.preview-access-grant');
  assert.equal(await summary.isVisible(),true);assert.equal(await cdnGrant.count(),1,'five blocked CDN cards share one top-level permission action');
  assert.match(await summary.locator('h3').innerText(),/プレビューのアクセス許可が必要/);
  assert.equal(await summary.locator('.preview-access-source').innerText(),`配信元: ${otherOrigin}（プレビュー待ち5件）`);
  assert.match(await summary.locator('.preview-access-scope').innerText(),/全パス.*全ポート/);assert.match(await summary.locator('.preview-access-scope').innerText(),/ログイン状態/);
  for(const width of [1280,360]){
    await cdn.setViewportSize({width,height:width===360?800:1000});
    if(width===360)await summary.evaluate(panel=>panel.scrollIntoView({block:'start'}));else await summary.scrollIntoViewIfNeeded();
    await cdn.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await summary.evaluate(panel=>{const button=panel.querySelector('button').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,height:button.height,left:button.left,right:button.right,top:button.top,bottom:button.bottom,footerTop:document.querySelector('#footer').getBoundingClientRect().top,width:innerWidth,beforeGrid:panel.getBoundingClientRect().top<document.querySelector('#grid').getBoundingClientRect().top};});
    assert.equal(geometry.overflow,false);assert.ok(geometry.height>=44&&geometry.left>=0&&geometry.right<=geometry.width);
    assert.ok(geometry.top>=0&&geometry.bottom<=geometry.footerTop,'the shared permission action can be reached above the sticky save footer');assert.equal(geometry.beforeGrid,true);
    await cdn.screenshot({path:join(output,`cdn-permission-${width}.png`)});
  }
  await cdn.setViewportSize({width:1280,height:1000});await cdn.locator('#query').fill('cdn-');await waitForCDNPermission();
  assert.equal(await cdnGrant.count(),1,'filter rerender does not duplicate the host action');assert.equal(cdnHits(),cdnBefore);assert.deepEqual((await qa(cdn)).requests,[]);
  await cdn.evaluate(()=>{__securityQA.denyRequest=true;});await cdnGrant.focus();await cdnGrant.press('Enter');
  await cdn.waitForFunction(()=>document.querySelector('.preview-access-message')?.textContent.includes('許可されませんでした')&&!document.querySelector('.preview-access-grant').disabled);
  assert.equal(await cdn.evaluate(()=>document.activeElement?.id),'gallery-heading','the shared action preserves focus at the gallery heading');
  assert.equal(cdnHits(),cdnBefore);assert.deepEqual((await qa(cdn)).requests,[['http://localhost/*']],'denying the shared action makes one request and no media fetch');
  await cdn.evaluate(()=>{
    __securityQA.denyRequest=false;const original=chrome.permissions.request;globalThis.__cdnOriginalRequest=original;
    chrome.permissions.request=options=>{const result=original(options);return new Promise((resolve,reject)=>{globalThis.__cdnResolvePermission=()=>Promise.resolve(result).then(resolve,reject);});};
  });
  await cdnGrant.click();
  assert.equal(await cdn.locator('.card .preview-permission').evaluateAll(buttons=>buttons.every(button=>button.disabled)),true,'the shared pending request disables every equivalent card permission action');
  await cdn.locator('.card .preview-permission').first().evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.deepEqual((await qa(cdn)).requests,[['http://localhost/*'],['http://localhost/*']],'a duplicate card event cannot issue another host request while the shared request is pending');
  await cdn.evaluate(()=>{chrome.permissions.request=globalThis.__cdnOriginalRequest;globalThis.__cdnResolvePermission();});
  await cdn.waitForFunction(()=>document.querySelectorAll('.thumb img').length===5&&[...document.querySelectorAll('.thumb img')].every(image=>image.complete&&image.naturalWidth>0&&image.src.startsWith('blob:')));
  assert.equal(cdnHits(),cdnBefore+5);assert.equal(await summary.isVisible(),false);assert.equal(await cdn.locator('.image-select:checked').count(),0);
  assert.deepEqual((await qa(cdn)).requests,[['http://localhost/*'],['http://localhost/*']]);
  checked('five blocked CDN cards share one accessible host action; denial sends no media, duplicate card actions are suppressed, and one grant loads all five without selecting');await cdn.close();

  const fallbackBefore=hits('127.0.0.1','/assets/active-tab.svg');
  const fallback=await opened('/active-tab',{blockedOrigins:['http://127.0.0.1/*'],blockSourceAccess:false,expectBlocked:false});
  await fallback.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0;});
  assert.equal(hits('127.0.0.1','/assets/active-tab.svg'),fallbackBefore+1);
  const fallbackQA=await qa(fallback);assert.ok(fallbackQA.sourceAccessRequests>0,'the real background validates the same-origin candidate when contains is false');
  assert.deepEqual(fallbackQA.requests,[],'the source access fallback does not request a persistent host grant');
  checked('same-origin source-access fallback starts previews with contains=false and real background session validation');await fallback.close();

  const cacheBefore=hits('127.0.0.1','/assets/cache.svg'),cached=await opened('/cache');
  await cached.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0&&image.src.startsWith('blob:');});
  assert.deepEqual((await qa(cached)).requests,[],'an existing Chrome host grant starts previews without an extra permission request');
  assert.equal(await cached.locator('.image-select:checked').count(),0,'automatic previews do not select images');
  checked('permitted visible images start generated previews automatically with no extra prompt');
  for(const query of ['cache.svg','','cache']){await cached.locator('#query').fill(query);await cached.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0;});}
  assert.equal(hits('127.0.0.1','/assets/cache.svg'),cacheBefore+1,'filter rerenders reuse encoded/static cache');
  const shown=await cached.locator('.thumb img').getAttribute('src');
  report.permissionRemoval=await cached.evaluate(async()=>{
    const origin='http://127.0.0.1/*';let native=false,nativeError='';try{native=await __securityQA.nativeRemove({origins:[origin]});}catch(error){nativeError=error.name;}
    if(!native){__securityQA.removedOrigins.add(origin);for(const listener of __securityQA.removalListeners)listener({origins:[origin]});}
    const synchronouslyCleared=!document.querySelector('.thumb img')&&__securityQA.urls.every(record=>record.revoked);
    return {nativeSucceeded:native,nativeError,synchronouslyCleared,mode:native?'native optional removal':'required-grant contains/onRemoved boundary fixture'};
  });
  await cached.waitForFunction(shown=>!document.querySelector('.thumb img')&&__securityQA.urls.some(record=>record.url===shown&&record.revoked),shown);
  const afterRemoval=hits('127.0.0.1','/assets/cache.svg');await cached.locator('#query').fill('');await pause(80);assert.equal(hits('127.0.0.1','/assets/cache.svg'),afterRemoval);
  const cacheSession=(await stateFor(cached)).id;await until(async()=>(await ledgerFor(cacheSession)).length===0,'revoked cache reservations');
  if(!report.permissionRemoval.nativeSucceeded)assert.equal(report.permissionRemoval.synchronouslyCleared,true,'the removal event invalidates displayed URLs synchronously');
  assert.deepEqual((await qa(cached)).requests,[],'revocation never requests permission again automatically');
  await cached.evaluate(()=>{const origin='http://127.0.0.1/*';__securityQA.removedOrigins.delete(origin);for(const listener of __securityQA.additionListeners)listener({origins:[origin]});});
  await cached.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0;});
  assert.equal(hits('127.0.0.1','/assets/cache.svg'),afterRemoval+1,'adding the host permission restores visible previews automatically');
  assert.deepEqual((await qa(cached)).requests,[],'a permission-added event does not issue another permission request');
  checked('permission removal invalidates display/cache synchronously, prevents further fetches, and regrant automatically restores previews');await cached.close();

  const networkBefore=assetHits(),embedded=await opened('/data');
  assert.match(await embedded.locator('.preview-source').innerText(),/埋め込まれた画像/);assert.equal(await embedded.locator('.preview-scope').count(),0);
  await embedded.locator('.preview-open').click();
  await embedded.waitForFunction(()=>{const image=document.querySelector('#preview-stage img');return image?.complete&&image.naturalWidth===2048&&image.src.startsWith('blob:');});
  await embedded.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth===384;});
  assert.equal(assetHits(),networkBefore);assert.deepEqual((await qa(embedded)).requests,[],'local embedded preview does not request a Chrome host permission');
  assert.match(await embedded.locator('[data-dimensions]').textContent(),/3000 × 2000/);
  assert.match(await embedded.locator('#preview-meta').textContent(),/3000 × 2000/);assert.equal(await embedded.locator('#preview-zoom').textContent(),'プレビューを等倍で表示');await embedded.locator('#preview-zoom').click();
  assert.equal(await embedded.locator('#preview-stage img').evaluate(image=>Math.round(image.getBoundingClientRect().width)),2048);assert.equal(assetHits(),networkBefore);
  const viewerURL=await embedded.locator('#preview-stage img').getAttribute('src');await embedded.keyboard.press('Escape');await embedded.waitForFunction(url=>__securityQA.urls.some(record=>record.url===url&&record.revoked),viewerURL);
  checked('automatic data-image preview is local; source dimensions and thumbnail/viewer sizes remain distinct with viewer URL release');await embedded.close();

  const retryBefore=hits('127.0.0.1','/assets/fail-once.svg'),retried=await opened('/retry');
  await retried.waitForFunction(()=>document.querySelector('.preview-error')?.textContent.includes('取得'));
  const retryButton=retried.locator('.preview-permission');await retryButton.waitFor({state:'visible'});assert.equal(await retryButton.innerText(),'再試行');
  assert.equal(await retried.locator('.preview-details').isVisible(),false,'HTTP errors do not display host permission scope');
  assert.equal(await retryButton.getAttribute('aria-describedby'),null,'hidden permission scope is not retained as the retry description');
  assert.doesNotMatch(await retryButton.getAttribute('title'),/全パス|全ポート|サイトの許可/);
  assert.deepEqual((await qa(retried)).requests,[],'a failed permitted preview never requests host access');
  await retryButton.click();await retried.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0;});
  assert.equal(hits('127.0.0.1','/assets/fail-once.svg'),retryBefore+2);assert.deepEqual((await qa(retried)).requests,[],'retry reuses existing access without a permission prompt');
  checked('a failed automatic preview can retry with existing access and no new Chrome permission request');await retried.close();

  for(const [path,pattern]of [['/bad-request',/HTTP 400/],['/unrecognized',/未知・未対応/]]){
    const failed=await opened(path);await failed.waitForFunction(pattern=>new RegExp(pattern).test(document.querySelector('.preview-error')?.textContent||''),pattern.source);
    const retry=failed.locator('.preview-permission');await retry.waitFor({state:'visible'});assert.equal(await retry.innerText(),'再試行');assert.equal(await retry.isEnabled(),true);
    assert.equal(await failed.locator('.preview-details').isVisible(),false);assert.equal(await retry.getAttribute('aria-describedby'),null);assert.doesNotMatch(await retry.getAttribute('title'),/全パス|全ポート|サイトの許可/);
    assert.equal(await failed.locator('.card').count(),1,'a failed candidate is retained rather than classified as advertising or removed');
    assert.deepEqual((await qa(failed)).requests,[]);assert.equal((await qa(failed)).workersCreated,0);
    await failed.locator('.image-select').check();assert.equal(await failed.locator('.image-select').isChecked(),true);
    if(path==='/unrecognized'){
      assert.match(await failed.locator('.preview-error').innerText(),/保存を試せます/);
      await failed.screenshot({path:join(output,'unrecognized-preview.png')});
    }
    checked(`${path}: retrieval/format failures retain selection and retry without permission guidance or new host requests`);await failed.close();
  }

  const targetBefore=hits('localhost','/assets/redirect-target.svg'),redirected=await opened('/redirect');
  await redirected.waitForFunction(()=>/取得できません|取得に失敗|Failed to fetch/.test(document.querySelector('.preview-error')?.textContent||''));
  assert.equal(hits('localhost','/assets/redirect-target.svg'),targetBefore);assert.equal((await qa(redirected)).workersCreated,0);assert.equal((await qa(redirected)).urls.length,0);
  checked('cross-host redirects are refused before following the target or invoking a codec');await redirected.close();

  for(const path of ['/declared','/stream']){
    const manager=await opened(path);await manager.waitForFunction(()=>/容量|上限/.test(document.querySelector('.preview-error')?.textContent||''));
    const kind=path.slice(1);await until(()=>streams.some(record=>record.kind===kind&&record.closed),kind+' response cancellation');
    const record=streams.find(record=>record.kind===kind);if(kind==='stream')assert.ok(record.producedBytes<record.plannedBytes,'reader aborts this slow fixture before its entire planned body is produced');
    assert.equal((await qa(manager)).workersCreated,0);assert.equal((await qa(manager)).urls.length,0);
    checked(kind==='stream'?'unknown-length expanded response bytes stop before Blob/codec admission and cancel the stream':'oversized Content-Length refuses input and cancels the body without a codec');await manager.close();
  }
  const enormous=await opened('/huge');await enormous.waitForFunction(()=>/寸法|画素数/.test(document.querySelector('.preview-error')?.textContent||''));
  assert.equal((await qa(enormous)).workersCreated,0);assert.equal((await qa(enormous)).urls.length,0);assert.equal(await enormous.locator('img').count(),0);
  checked('30MP declared source dimensions are rejected before a native decoder worker or displayed image');await enormous.close();

  const queueStart=held.length,queued=await opened('/queue');
  await until(()=>held.slice(queueStart).length>=2,'two held preview fetches');assert.equal(held.slice(queueStart).filter(record=>!record.closed).length,2,'workspace fetch concurrency is two');
  await queued.locator('#query').fill('no-synthetic-match');await until(()=>held.slice(queueStart).every(record=>record.closed),'last-consumer HTTP abort after filter change');
  const urlsBeforeLate=(await qa(queued)).urls.length;for(const record of held.slice(queueStart)){try{record.response.end(svg());}catch{}}
  await pause(80);assert.equal((await qa(queued)).urls.length,urlsBeforeLate);assert.equal(urlsBeforeLate,0);assert.equal((await qa(queued)).workersCreated,0);assert.equal(await queued.locator('.card').count(),0);
  checked('filtering away queued/inflight cards aborts their last consumer and never adopts a late HTTP result');await queued.close();

  const closeStart=held.length,closing=await opened('/close');await until(()=>held.slice(closeStart).length>=2,'close-case held fetches');
  const closingID=(await stateFor(closing)).id;await closing.close();await until(()=>held.slice(closeStart).every(record=>record.closed),'workspace close HTTP cancellation');
  for(const record of held.slice(closeStart)){try{record.response.end(svg());}catch{}}
  await until(async()=>(await ledgerFor(closingID)).length===0,'closed workspace reservation cleanup');
  checked('closing a workspace aborts pending HTTP work and clears its owned shared resource reservations');
  assert.deepEqual(errors,[],'no uncaught extension page errors');report.streams=streams.map(({kind,closed,producedBytes,plannedBytes})=>({kind,closed,producedBytes,plannedBytes}));
  console.log(`ImageCrate security browser PASS (${report.checks.length} checks; permission removal mode: ${report.permissionRemoval.mode}).`);
}catch(error){
  report.failure={name:error.name,message:error.message};
  report.failurePages=await Promise.all((context?.pages()||[]).filter(page=>page.url().startsWith('chrome-extension:')).map(async(page,index)=>{
    const state=await page.evaluate(()=>({errors:[...document.querySelectorAll('.preview-error')].map(node=>node.textContent),buttons:[...document.querySelectorAll('.preview-permission')].map(node=>({text:node.textContent,hidden:node.hidden,disabled:node.disabled})),requests:globalThis.__securityQA?.permissionRequests})).catch(()=>null);
    await page.screenshot({path:join(output,`security-failure-${index}.png`)}).catch(()=>{});return state;
  }));
  throw error;
}
finally{
  report.streams=streams.map(({kind,closed,producedBytes,plannedBytes})=>({kind,closed,producedBytes,plannedBytes}));
  await writeFile(join(output,'security-report.json'),JSON.stringify(report,null,2));
  await context?.close();for(const record of held){try{record.response.destroy();}catch{}}
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
  if(process.env.QA_KEEP||process.env.QA_OUTPUT_DIR)console.log('Security QA report: '+join(output,'security-report.json'));
  if(!process.env.QA_KEEP&&!process.env.QA_OUTPUT_DIR)await rm(scratch,{recursive:true,force:true});
}
