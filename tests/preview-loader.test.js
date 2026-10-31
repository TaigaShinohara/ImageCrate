import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireMediaFetchLease,createPreviewController,PREVIEW_LIMITS} from '../extension/preview-loader.js';
import {createImageResourceCoordinator,decodeStaticImage,IMAGE_RESOURCE_LIMITS} from '../extension/image-decoder.js';
import {inspectImage} from '../extension/image-metadata.js';
import {createMediaOperation} from '../extension/media-reader.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const svg='<svg width="40" height="30"><rect width="40" height="30" fill="red"/></svg>';
const response=()=>new Response(svg,{headers:{'content-type':'image/svg+xml'}});
function locks(){
  const tails=new Map();return {request(name,options,callback){
    const previous=tails.get(name)??Promise.resolve();const gate=deferred();tails.set(name,gate.promise);
    return previous.catch(()=>{}).then(async()=>{try{if(options?.signal?.aborted)throw options.signal.reason;return await callback();}finally{gate.resolve();}});
  }};
}
function resource(){const state={};const lock=locks();const storage={async get(key){return {[key]:structuredClone(state[key])};},async set(next){Object.assign(state,structuredClone(next));}};return{coordinator:createImageResourceCoordinator({storage,locks:lock}),locks:lock,state};}
function harness(options={}){
  const resources=options.resources??resource(),listeners=new Set(),allowed=new Set();let requests=0,fetches=0,decodes=0,created=0;
  const urls=[],revoked=[];
  const permissions={async request({origins}){requests++;if(options.deny)return false;for(const origin of origins)allowed.add(origin);return true;},async contains({origins}){return origins.every(origin=>allowed.has(origin));},onRemoved:{addListener(fn){listeners.add(fn);},removeListener(fn){listeners.delete(fn);}}};
  const controller=createPreviewController({ownerId:options.owner??'workspace-a',permissions,coordinator:resources.coordinator,
    inspectImpl:options.inspect,fetchImpl:async(url,opts)=>{fetches++;if(options.fetch)return options.fetch(url,opts);return response();},
    decodeImpl:async(blob,metadata,opts)=>{decodes++;if(options.decode)return options.decode(blob,metadata,opts);return{blob:new Blob(['static'],{type:'image/png'}),width:metadata.width,height:metadata.height,displayWidth:metadata.width,displayHeight:metadata.height};},
    createObjectURL(blob){const url=`blob:static-${++created}`;urls.push({url,blob});return url;},revokeObjectURL(url){revoked.push(url);},onInvalidate:options.onInvalidate});
  return{controller,permissions,allowed,resources,urls,revoked,get fetches(){return fetches;},get requests(){return requests;},get decodes(){return decodes;},remove(){allowed.clear();for(const listener of listeners)listener({origins:['https://images.test/*']});}};
}

test('new workspace and saved Chrome permission never fetch before its clicked app consent',async()=>{
  const h=harness();h.allowed.add('https://images.test/*');
  await assert.rejects(h.controller.load('https://images.test/a'),/許可/);assert.equal(h.fetches,0);assert.equal(h.decodes,0);
  await h.controller.grantHost('https://images.test/a');const result=await h.controller.load('https://images.test/a');
  assert.equal(h.requests,1);assert.equal(h.fetches,1);assert.equal(result.width,40);assert.match(result.url,/^blob:static/);assert.equal(h.urls[0].blob.type,'image/png');
  result.release();await h.controller.dispose();assert.deepEqual(h.revoked,['blob:static-1']);
});

test('refused consent and a different host make zero remote requests; native download remains independent',async()=>{
  const denied=harness({deny:true});assert.equal(await denied.controller.grantHost('https://images.test/a'),false);await assert.rejects(denied.controller.load('https://images.test/a'));assert.equal(denied.fetches,0);await denied.controller.dispose();
  const h=harness();await h.controller.grantHost('https://images.test/a');await assert.rejects(h.controller.load('https://other.test/a'));assert.equal(h.fetches,0);await h.controller.dispose();
});

test('permission is checked at execution and removal invalidates displayed/cache state and consent',async()=>{
  const h=harness();await h.controller.grantHost('https://images.test/a');const result=await h.controller.load('https://images.test/a');
  h.remove();await turn();assert.equal(h.controller.stats().cacheEntries,0);assert.equal(h.controller.stats().consentedHosts,0);assert.deepEqual(h.revoked,[result.url]);
  await assert.rejects(h.controller.load('https://images.test/a'));assert.equal(h.fetches,1);result.release();await h.controller.dispose();
});

test('permission removal cancels queued/inflight fetch and suppresses every old worker result',async()=>{
  const started=deferred(),decoding=deferred();let decoderSignal;
  const h=harness({decode:async(_blob,metadata,options)=>{decoderSignal=options.signal;started.resolve();await decoding.promise;return{blob:new Blob(['late'],{type:'image/png'}),width:metadata.width,height:metadata.height,displayWidth:40,displayHeight:30};}});
  await h.controller.grantHost('https://images.test/a');const loading=h.controller.load('https://images.test/a');loading.catch(()=>{});await started.promise;h.remove();
  await assert.rejects(loading,{name:'AbortError'});assert.equal(decoderSignal.aborted,true);decoding.resolve();await turn();assert.equal(h.urls.length,0);await h.controller.dispose();
});

test('view generation aborts old result, preserves consent, and source dimensions stay separate',async()=>{
  const started=deferred(),pending=deferred();let first=true;
  const h=harness({decode:async(_blob,metadata)=>{if(first){first=false;started.resolve();await pending.promise;}return{blob:new Blob(['static'],{type:'image/png'}),width:metadata.width,height:metadata.height,displayWidth:4,displayHeight:3};}});
  await h.controller.grantHost('https://images.test/a');const old=h.controller.load('https://images.test/a');old.catch(()=>{});await started.promise;h.controller.invalidate();await assert.rejects(old,{name:'AbortError'});pending.resolve();await turn();
  const current=await h.controller.load('https://images.test/a');assert.equal(current.width,40);assert.equal(current.displayWidth,4);assert.equal(h.urls.length,1);current.release();await h.controller.dispose();
});

test('same visible image shares fetch/cache while each returned URL handle has independent release',async()=>{
  const h=harness();await h.controller.grantHost('https://images.test/a');const [a,b]=await Promise.all([h.controller.load('https://images.test/a'),h.controller.load('https://images.test/a')]);
  assert.equal(a.url,b.url);assert.equal(h.fetches,1);a.release();a.release();b.release();const c=await h.controller.load('https://images.test/a');assert.notEqual(c.url,a.url);assert.equal(h.fetches,1);c.release();await h.controller.dispose();
});

test('failed source preflight does not invoke codec or repeatedly refetch on rendering',async()=>{
  const h=harness({fetch:async()=>new Response('AVIF unknown',{headers:{'content-type':'image/avif'}})});await h.controller.grantHost('https://images.test/a');
  await assert.rejects(h.controller.load('https://images.test/a'));await assert.rejects(h.controller.load('https://images.test/a'));assert.equal(h.fetches,1);assert.equal(h.decodes,0);assert.equal(h.urls.length,0);
  await h.controller.grantHost('https://images.test/a');await assert.rejects(h.controller.load('https://images.test/a'));assert.equal(h.fetches,2);await h.controller.dispose();
});

test('workspace queue is finite at 500 candidate demand and invalidation cancels every waiter',async()=>{
  const fetching=deferred();const h=harness({fetch:async()=>fetching.promise});await h.controller.grantHost('https://images.test/a');
  const jobs=Array.from({length:500},(_,i)=>h.controller.load(`https://images.test/${i}`).catch(error=>error));await turn();
  assert.equal(h.fetches,2);assert.ok(h.controller.stats().queued+h.controller.stats().active<=PREVIEW_LIMITS.queueEntries);
  h.controller.invalidate();const results=await Promise.all(jobs);assert.equal(results.length,500);assert.equal(h.controller.stats().queued,0);fetching.resolve(response());await h.controller.dispose();
});

test('global fetch reservations cap competing workspaces at four active requests',async()=>{
  const resources=resource(),fetching=deferred();const workspaces=Array.from({length:3},(_,i)=>harness({resources,owner:`workspace-${i}`,fetch:async()=>fetching.promise}));
  for(const h of workspaces)await h.controller.grantHost('https://images.test/a');
  const jobs=workspaces.flatMap(h=>[h.controller.load('https://images.test/a').catch(error=>error),h.controller.load('https://images.test/b').catch(error=>error)]);await turn();await turn();
  assert.equal(workspaces.reduce((n,h)=>n+h.fetches,0),4);
  for(const h of workspaces)h.controller.invalidate();await Promise.all(jobs);fetching.resolve(response());for(const h of workspaces)await h.controller.dispose();assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('LRU cache drops unused generated URLs and disposal releases global reservations',async()=>{
  const h=harness();await h.controller.grantHost('https://images.test/a');for(let i=0;i<70;i++){const result=await h.controller.load(`https://images.test/${i}`);result.release();}
  assert.equal(h.controller.stats().cacheEntries,64);assert.equal(h.revoked.length,70);assert.equal(h.controller.stats().totalBytes,70*new TextEncoder().encode(svg).length);
  await h.controller.dispose();assert.equal(h.revoked.length,70);assert.deepEqual(await h.resources.coordinator.snapshot(),{});
});

test('shared resource budget refuses excessive cache/pixels before side effects and release permits retry',async()=>{
  const {coordinator}=resource();const lease=await coordinator.reserve('a',{encodedCache:16*1024*1024,pixels:40_000_000});
  await assert.rejects(coordinator.reserve('a',{encodedCache:1}),/上限/);await assert.rejects(coordinator.reserve('b',{pixels:24_000_001}),/上限/);
  const other=await coordinator.reserve('b',{encodedCache:16*1024*1024});await assert.rejects(coordinator.reserve('c',{encodedCache:1}),/上限/);
  assert.equal(lease.covers('a','pixels',40_000_000),true);await lease.release();assert.equal(lease.covers('a','pixels',1),false);const recovered=await coordinator.reserve('c',{pixels:IMAGE_RESOURCE_LIMITS.pixels});await recovered.release();await other.release();assert.deepEqual(await coordinator.snapshot(),{});
});

test('decode uses one global codec slot, terminates every worker and credits held source reservation',async()=>{
  const resources=resource(),blob=new Blob([svg]),metadata=await inspectImage(blob),workers=[],gates=[];let active=0,maxActive=0;
  const workerFactory=()=>{
    const gate=deferred();gates.push(gate);const worker={terminateCount:0,postMessage(){active++;maxActive=Math.max(maxActive,active);gate.promise.then(()=>this.onmessage?.({data:{result:{blob:new Blob(['out'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30}}}));},terminate(){this.terminateCount++;active--;}};workers.push(worker);return worker;
  };
  const input=await resources.coordinator.reserve('a',{encodedBytes:64*1024*1024});
  const first=decodeStaticImage(blob,metadata,{coordinator:resources.coordinator,locks:resources.locks,workerFactory,maxOutputBytes:8*1024*1024,ownerId:'a',sourceReservation:input});
  const second=decodeStaticImage(blob,metadata,{coordinator:resources.coordinator,locks:resources.locks,workerFactory,maxOutputBytes:8*1024*1024,ownerId:'b'});
  await turn();assert.equal(workers.length,1);assert.equal(maxActive,1);gates[0].resolve();const firstOutput=await first;await firstOutput.release();await input.release();await turn();assert.equal(workers.length,2);gates[1].resolve();const secondOutput=await second;await secondOutput.release();await turn();
  assert.equal(maxActive,1);assert.ok(workers.every(worker=>worker.terminateCount===1));assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('abort during decode terminates worker promptly; late messages are detached and resources released',async()=>{
  const resources=resource(),blob=new Blob([svg]),metadata=await inspectImage(blob),started=deferred();let worker;
  const controller=new AbortController();const decoding=decodeStaticImage(blob,metadata,{signal:controller.signal,coordinator:resources.coordinator,locks:resources.locks,workerFactory:()=>worker={terminateCount:0,postMessage(){started.resolve();},terminate(){this.terminateCount++;}}});
  await started.promise;controller.abort();await assert.rejects(decoding,{name:'AbortError'});assert.equal(worker.terminateCount,1);assert.equal(worker.onmessage,null);await turn();assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('permission removal invalidates visible URL immediately before async permission query resolves',async()=>{
  const h=harness();await h.controller.grantHost('https://images.test/a');const shown=await h.controller.load('https://images.test/a');const checking=deferred();
  h.permissions.contains=()=>checking.promise;h.remove();assert.deepEqual(h.revoked,[shown.url]);assert.equal(h.controller.stats().cacheEntries,0);
  checking.resolve(false);await turn();await h.controller.dispose();
});

test('absolute preview deadline stops stalled fetch, cancels queued work, and retains attempted traffic',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const started=deferred();let signal;
  const h=harness({fetch:async(_url,options)=>{signal=options.signal;started.resolve();return new Promise(()=>{});}});
  await h.controller.grantHost('https://images.test/a');const loading=h.controller.load('https://images.test/a');loading.catch(()=>{});await started.promise;t.mock.timers.tick(20000);
  await assert.rejects(loading,{name:'TimeoutError'});assert.equal(signal.aborted,true);assert.equal(h.urls.length,0);await h.controller.dispose();
});

test('excessive streamed chunk is never decoded and observed failure traffic still consumes workspace budget',async()=>{
  const large=new Uint8Array(PREVIEW_LIMITS.maxBytes+1);const h=harness({fetch:async()=>new Response(new ReadableStream({start(stream){stream.enqueue(large);stream.close();}}))});
  await h.controller.grantHost('https://images.test/a');await assert.rejects(h.controller.load('https://images.test/a'),/容量/);assert.equal(h.decodes,0);assert.equal(h.controller.stats().totalBytes,large.byteLength);await h.controller.dispose();
});

test('codec deadline terminates worker and abort during queued lock never starts a second worker',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const resources=resource(),blob=new Blob([svg]),metadata=await inspectImage(blob),started=deferred();let workers=0,terminated=0;
  const workerFactory=()=>{workers++;return{postMessage(){started.resolve();},terminate(){terminated++;}};};
  const first=decodeStaticImage(blob,metadata,{coordinator:resources.coordinator,locks:resources.locks,workerFactory,deadline:Date.now()+1000});first.catch(()=>{});await started.promise;
  const controller=new AbortController(),second=decodeStaticImage(blob,metadata,{coordinator:resources.coordinator,locks:resources.locks,workerFactory,signal:controller.signal});second.catch(()=>{});controller.abort();t.mock.timers.tick(1000);
  await assert.rejects(first,{name:'TimeoutError'});await assert.rejects(second,{name:'AbortError'});assert.equal(workers,1);assert.equal(terminated,1);await turn();assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('abort retains source reservation until actual noncancellable inspection settles, including dispose',async()=>{
  const inspection=deferred(),started=deferred();const metadata=await inspectImage(new Blob([svg]));
  const h=harness({inspect:async()=>{started.resolve();return inspection.promise;}});await h.controller.grantHost('https://images.test/a');
  const loading=h.controller.load('https://images.test/a');loading.catch(()=>{});await started.promise;h.controller.invalidate();await assert.rejects(loading,{name:'AbortError'});await turn();
  let ledger=Object.values(await h.resources.coordinator.snapshot());assert.equal(ledger.reduce((sum,entry)=>sum+(entry.encodedBytes??0),0),PREVIEW_LIMITS.maxBytes*2);assert.equal(ledger.reduce((sum,entry)=>sum+(entry.fetches??0),0),0);
  let disposed=false;const disposing=h.controller.dispose().then(()=>{disposed=true;});await turn();assert.equal(disposed,false);assert.equal(h.urls.length,0);
  inspection.resolve(metadata);await disposing;assert.deepEqual(await h.resources.coordinator.snapshot(),{});
});

test('codec returns an owned output reservation until its consumer explicitly releases',async()=>{
  const resources=resource(),blob=new Blob([svg]),metadata=await inspectImage(blob);
  const output=await decodeStaticImage(blob,metadata,{coordinator:resources.coordinator,locks:resources.locks,workerFactory:()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{result:{blob:new Blob(['output'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30}}}));},terminate(){}})});
  const entries=Object.values(await resources.coordinator.snapshot());assert.equal(entries.length,1);assert.equal(entries[0].encodedBytes,6);assert.equal(entries[0].pixels??0,0);
  await output.release();await output.release();assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('last queued consumer abort removes its real job without fetching it',async()=>{
  const pendingFetch=deferred();const h=harness({fetch:async()=>pendingFetch.promise});await h.controller.grantHost('https://images.test/a');
  const first=h.controller.load('https://images.test/a').catch(error=>error),second=h.controller.load('https://images.test/b').catch(error=>error),controller=new AbortController();
  const queued=h.controller.load('https://images.test/c',{signal:controller.signal});queued.catch(()=>{});await turn();assert.equal(h.controller.stats().queued,1);controller.abort();await assert.rejects(queued,{name:'AbortError'});assert.equal(h.controller.stats().queued,0);assert.equal(h.fetches,2);
  h.controller.invalidate();await Promise.all([first,second]);pendingFetch.resolve(response());await h.controller.dispose();
});

test('last running consumer abort cancels fetch and permits a replacement for the same URL',async()=>{
  const started=deferred();let oldSignal,calls=0;
  const h=harness({fetch:async(_url,options)=>{if(++calls===1){oldSignal=options.signal;started.resolve();return new Promise(()=>{});}return response();}});await h.controller.grantHost('https://images.test/a');
  const controller=new AbortController(),first=h.controller.load('https://images.test/a',{signal:controller.signal});first.catch(()=>{});await started.promise;controller.abort();
  const replacement=h.controller.load('https://images.test/a');await assert.rejects(first,{name:'AbortError'});assert.equal(oldSignal.aborted,true);const result=await replacement;assert.equal(h.fetches,2);result.release();await h.controller.dispose();
});

test('aborting one of two consumers keeps shared fetch alive for its remaining consumer',async()=>{
  const started=deferred(),fetching=deferred();let sharedSignal;
  const h=harness({fetch:async(_url,options)=>{sharedSignal=options.signal;started.resolve();return fetching.promise;}});await h.controller.grantHost('https://images.test/a');
  const controller=new AbortController(),first=h.controller.load('https://images.test/a',{signal:controller.signal}),second=h.controller.load('https://images.test/a');first.catch(()=>{});await started.promise;controller.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(sharedSignal.aborted,false);
  fetching.resolve(response());const result=await second;assert.equal(h.fetches,1);result.release();await h.controller.dispose();
});

test('cache survives repeated view consumer releases, while cached async permission query still honors abort',async()=>{
  const h=harness();await h.controller.grantHost('https://images.test/a');for(let i=0;i<20;i++){const handle=await h.controller.load('https://images.test/a');handle.release();}
  assert.equal(h.fetches,1);assert.equal(h.controller.stats().cacheEntries,1);assert.equal(h.revoked.length,20);
  const checking=deferred();h.permissions.contains=()=>checking.promise;const controller=new AbortController(),loading=h.controller.load('https://images.test/a',{signal:controller.signal});loading.catch(()=>{});await turn();controller.abort();checking.resolve(true);await assert.rejects(loading,{name:'AbortError'});assert.equal(h.urls.length,20);await h.controller.dispose();
});

test('bounded embedded image consent is local and never requests Chrome host permission',async()=>{
  const h=harness({fetch:async url=>{assert.match(url,/^data:image\/svg\+xml;/);return response();}}),url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  await assert.rejects(h.controller.load(url),/許可/);assert.equal(h.fetches,0);assert.equal(await h.controller.grantHost(url),true);const result=await h.controller.load(url);assert.equal(h.requests,0);assert.equal(h.fetches,1);assert.equal(h.decodes,1);result.release();
  await assert.rejects(h.controller.grantHost('data:text/html,<img>'));await assert.rejects(h.controller.grantHost('data:image/png;base64,'+'A'.repeat(131072)));await h.controller.dispose();
});

test('codec absolute deadline after queued lock acquisition refuses reservation and worker startup',async t=>{
  let now=Date.now(),reservations=0,workers=0;const gate=deferred(),blob=new Blob([svg]),metadata=await inspectImage(blob);
  t.mock.method(Date,'now',()=>now);const deadline=now+1000;
  const decoding=decodeStaticImage(blob,metadata,{deadline,locks:{request:(_name,_options,run)=>gate.promise.then(run)},coordinator:{reserve:async()=>{reservations++;throw new Error('unexpected reservation');}},workerFactory:()=>{workers++;throw new Error('unexpected worker');}});
  now=deadline+1;gate.resolve();await assert.rejects(decoding,{name:'TimeoutError'});assert.equal(reservations,0);assert.equal(workers,0);
});

test('late fulfilled codec reservation after absolute deadline is released before native decode',async t=>{
  let now=Date.now(),releases=0,workers=0;const reserved=deferred(),started=deferred(),blob=new Blob([svg]),metadata=await inspectImage(blob);
  t.mock.method(Date,'now',()=>now);const deadline=now+1000;
  const decoding=decodeStaticImage(blob,metadata,{deadline,locks:locks(),coordinator:{reserve:()=>{started.resolve();return reserved.promise;}},workerFactory:()=>{workers++;throw new Error('unexpected worker');}});
  await started.promise;now=deadline+1;reserved.resolve({id:'late',owner:'owner',release:async()=>releases++});
  await assert.rejects(decoding,{name:'TimeoutError'});await turn();assert.equal(releases,1);assert.equal(workers,0);
});

test('worker result after absolute deadline terminates before output lease transfer despite throttled timers',async t=>{
  const resources=resource(),started=deferred(),blob=new Blob([svg]),metadata=await inspectImage(blob);let now=Date.now(),worker,terminated=0;
  t.mock.method(Date,'now',()=>now);const deadline=now+1000;
  const decoding=decodeStaticImage(blob,metadata,{deadline,coordinator:resources.coordinator,locks:resources.locks,workerFactory:()=>worker={postMessage(){started.resolve();},terminate(){terminated++;}}});
  await started.promise;now=deadline+1;worker.onmessage({data:{result:{blob:new Blob(['out'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30}}});
  await assert.rejects(decoding,{name:'TimeoutError'});await turn();assert.equal(terminated,1);assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('absolute deadline after output shrink releases the fulfilled reservation instead of returning it',async t=>{
  const resources=resource(),shrinking=deferred(),finish=deferred(),blob=new Blob([svg]),metadata=await inspectImage(blob);let now=Date.now(),terminated=0;
  t.mock.method(Date,'now',()=>now);const deadline=now+1000;
  const coordinator={reserve:async(...args)=>{const lease=await resources.coordinator.reserve(...args);return {...lease,shrink:async next=>{shrinking.resolve();await finish.promise;await lease.shrink(next);}};}};
  const decoding=decodeStaticImage(blob,metadata,{deadline,coordinator,locks:resources.locks,workerFactory:()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{result:{blob:new Blob(['out'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30}}}));},terminate(){terminated++;}})});
  await shrinking.promise;now=deadline+1;finish.resolve();await assert.rejects(decoding,{name:'TimeoutError'});await turn();assert.equal(terminated,1);assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('abort while persistent shrink is unsettled queues release behind it and never recreates the record',async()=>{
  const state={},lock=locks(),shrinking=deferred(),finish=deferred();let gated=false;
  const storage={async get(key){return {[key]:structuredClone(state[key])};},async set(next){
    const records=Object.values(Object.values(next)[0]);
    if(!gated&&records.some(record=>record.encodedBytes===6&&!record.pixels)){gated=true;shrinking.resolve();await finish.promise;}
    Object.assign(state,structuredClone(next));
  }};
  const coordinator=createImageResourceCoordinator({storage,locks:lock}),controller=new AbortController(),blob=new Blob([svg]),metadata=await inspectImage(blob);
  const decoding=decodeStaticImage(blob,metadata,{signal:controller.signal,coordinator,locks:lock,workerFactory:()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{result:{blob:new Blob(['output'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30}}}));},terminate(){}})});
  await shrinking.promise;controller.abort();await assert.rejects(decoding,{name:'AbortError'});
  assert.equal(Object.values(Object.values(state)[0]).length,1,'pending native ledger write retains its reservation');
  finish.resolve();await turn();assert.deepEqual(await coordinator.snapshot(),{});
});

test('lease shrinking serializes with other shrink/release operations and cannot expand or resurrect',async()=>{
  const {coordinator}=resource();const lease=await coordinator.reserve('owner',{encodedBytes:100});
  const first=lease.shrink({encodedBytes:50}),second=lease.shrink({encodedBytes:75});await first;await assert.rejects(second,/縮小/);
  assert.equal(Object.values(await coordinator.snapshot())[0].encodedBytes,50);
  const shrinking=lease.shrink({encodedBytes:25});const removed=coordinator.releaseLease(lease.id,'owner');
  assert.equal(await removed,true);await assert.rejects(shrinking,/失効/);await lease.release();assert.deepEqual(await coordinator.snapshot(),{});
});

test('output lease identity enables only its matching owner to release persisted Chrome resources',async()=>{
  const {coordinator}=resource(),lease=await coordinator.reserve('workspace:conversion',{encodedBytes:20});
  assert.equal(await coordinator.releaseLease(lease.id,'other-owner'),false);assert.equal(Object.values(await coordinator.snapshot()).length,1);
  for(const args of [[null,'workspace:conversion'],[lease.id,''],['x'.repeat(257),'workspace:conversion']])await assert.rejects(coordinator.releaseLease(...args),/所有者/);
  assert.equal(await coordinator.releaseLease(lease.id,'workspace:conversion'),true);assert.equal(await coordinator.releaseLease(lease.id,'workspace:conversion'),false);await lease.release();assert.deepEqual(await coordinator.snapshot(),{});
});


test('preview owns fulfilled output before a throttled deadline wins its cancellable wait',async t=>{
  const decoding=deferred(),started=deferred();let deadline=0,armed=false,checks=0,releases=0;const initial=Date.now();
  t.mock.method(Date,'now',()=>armed&&++checks>=2?deadline+1:initial);
  const h=harness({decode:(_blob,metadata,options)=>{deadline=options.deadline;started.resolve();return decoding.promise;}});await h.controller.grantHost('https://images.test/a');
  const loading=h.controller.load('https://images.test/a');loading.catch(()=>{});await started.promise;armed=true;
  decoding.resolve({blob:new Blob(['output'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30,release:async()=>releases++});
  await assert.rejects(loading,{name:'TimeoutError'});await turn();assert.equal(releases,1);assert.equal(h.urls.length,0);await h.controller.dispose();assert.deepEqual(await h.resources.coordinator.snapshot(),{});
});

test('preview source accounting and disposal await actual codec settlement after its consumer aborts',async()=>{
  const decoding=deferred(),started=deferred();let releases=0;
  const h=harness({decode:()=>{started.resolve();return decoding.promise;}});await h.controller.grantHost('https://images.test/a');
  const controller=new AbortController(),loading=h.controller.load('https://images.test/a',{signal:controller.signal});loading.catch(()=>{});await started.promise;controller.abort();await assert.rejects(loading,{name:'AbortError'});await turn();
  const held=Object.values(await h.resources.coordinator.snapshot());assert.equal(held.reduce((sum,entry)=>sum+(entry.encodedBytes??0),0),PREVIEW_LIMITS.maxBytes*2);assert.equal(held.reduce((sum,entry)=>sum+(entry.fetches??0),0),0);
  let disposed=false;const disposing=h.controller.dispose().then(()=>{disposed=true;});await turn();assert.equal(disposed,false);
  decoding.resolve({blob:new Blob(['late'],{type:'image/png'}),width:40,height:30,displayWidth:40,displayHeight:30,release:async()=>releases++});
  await disposing;assert.equal(releases,1);assert.equal(h.urls.length,0);assert.deepEqual(await h.resources.coordinator.snapshot(),{});
});

test('wildcard and credentialed host input never reaches a permission request or fetch',async()=>{
  const h=harness();
  for(const url of ['https://*.example.test/a.png','https://*/a.png','https://foo*bar.example.test/a.png','https://user:synthetic-password@images.test/a','http://user@images.test/a']){
    await assert.rejects(h.controller.grantHost(url),/対応していません/);await assert.rejects(h.controller.load(url),/対応していません/);
  }
  assert.equal(h.requests,0);assert.equal(h.fetches,0);assert.equal(h.decodes,0);
  await h.controller.grantHost('https://images.test/a*pattern');assert.equal(h.requests,1,'wildcard path characters do not widen the concrete host permission');await h.controller.dispose();
});

test('managed fetch lease fulfilled before a failed wait is still released and cannot authorize fetch',async()=>{
  const resources=resource();let requests=0;
  const timeout=new DOMException('deadline elapsed after fulfillment','TimeoutError');
  const operation={signal:new AbortController().signal,check(){},wait:promise=>Promise.resolve(promise).then(()=>{throw timeout;})};
  await assert.rejects(acquireMediaFetchLease(operation,'managed-fulfilled',{coordinator:resources.coordinator}).then(()=>{requests++;}),{name:'TimeoutError'});
  await turn();assert.equal(requests,0);assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('abort during delayed shared fetch reservation returns promptly and releases its late acquisition',async()=>{
  const reservation=deferred(),started=deferred(),resources=resource(),controller=new AbortController();let requests=0;
  const operation=createMediaOperation({signal:controller.signal,timeoutMs:20000});
  const coordinator={reserve(owner,amounts){started.resolve();return reservation.promise.then(()=>resources.coordinator.reserve(owner,amounts));}};
  const pending=acquireMediaFetchLease(operation,'managed-late',{coordinator}).then(()=>{requests++;});pending.catch(()=>{});await started.promise;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  reservation.resolve();await turn();assert.equal(requests,0);assert.deepEqual(await resources.coordinator.snapshot(),{});operation.dispose();
});

test('managed input and preview fetches share four global slots and recover after source release',async()=>{
  const resources=resource(),fetching=deferred(),owner=role=>`${crypto.randomUUID()}:${crypto.randomUUID()}:${role}`,h=harness({resources,owner:owner('preview'),fetch:async()=>fetching.promise});
  await h.controller.grantHost('https://images.test/a');const first=h.controller.load('https://images.test/a').catch(error=>error),second=h.controller.load('https://images.test/b').catch(error=>error);await turn();assert.equal(h.fetches,2);
  const operations=Array.from({length:3},()=>createMediaOperation({timeoutMs:20000}));
  const managedA=await acquireMediaFetchLease(operations[0],owner('conversion'),{coordinator:resources.coordinator}),managedB=await acquireMediaFetchLease(operations[1],owner('conversion'),{coordinator:resources.coordinator});
  assert.equal(Object.values(await resources.coordinator.snapshot()).reduce((sum,entry)=>sum+(entry.fetches||0),0),4);
  let rejectedRequests=0;await assert.rejects(acquireMediaFetchLease(operations[2],owner('conversion'),{coordinator:resources.coordinator}).then(()=>{rejectedRequests++;}),/上限/);assert.equal(rejectedRequests,0);
  const extra=harness({resources,owner:owner('preview')});await extra.controller.grantHost('https://images.test/a');await assert.rejects(extra.controller.load('https://images.test/a'),/上限/);assert.equal(extra.fetches,0);
  await managedA.release();await extra.controller.grantHost('https://images.test/a');const recovered=await extra.controller.load('https://images.test/a');assert.equal(extra.fetches,1);recovered.release();
  h.controller.invalidate();await Promise.all([first,second]);fetching.resolve(response());await managedB.release();for(const operation of operations)operation.dispose();await h.controller.dispose();await extra.controller.dispose();assert.deepEqual(await resources.coordinator.snapshot(),{});
});

test('original writer UI failure keeps its shared fetch slot until actual native ownership settles',async()=>{
  const resources=resource(),operation=createMediaOperation({timeoutMs:20000}),nativeOwnership=deferred();
  const lease=await acquireMediaFetchLease(operation,'managed-original',{coordinator:resources.coordinator});
  const releasing=lease.release(nativeOwnership.promise);const duplicate=lease.release();assert.equal(releasing,duplicate,'a second cleanup cannot bypass outstanding native ownership');
  await turn();assert.equal(Object.values(await resources.coordinator.snapshot()).reduce((sum,entry)=>sum+(entry.fetches||0),0),1);
  nativeOwnership.resolve();await releasing;assert.deepEqual(await resources.coordinator.snapshot(),{});operation.dispose();
});

test('production workspace shares two fetch slots across preview, managed input and old document instances',async()=>{
  const {coordinator}=resource(),session=crypto.randomUUID(),oldInstance=crypto.randomUUID(),newInstance=crypto.randomUUID();
  const previewOwner=`${session}:${oldInstance}:preview`,oldManagedOwner=`${session}:${oldInstance}:conversion`,newManagedOwner=`${session}:${newInstance}:conversion`;
  const previewA=await coordinator.reserve(previewOwner,{fetches:1}),previewB=await coordinator.reserve(previewOwner,{fetches:1});
  const operation=createMediaOperation({timeoutMs:20000});let fetches=0;
  for(const owner of [oldManagedOwner,newManagedOwner])await assert.rejects(acquireMediaFetchLease(operation,owner,{coordinator}).then(()=>{fetches++;}),/上限/);
  assert.equal(fetches,0);await previewA.release();const managed=await acquireMediaFetchLease(operation,newManagedOwner,{coordinator});
  assert.equal(Object.values(await coordinator.snapshot()).reduce((sum,entry)=>sum+(entry.fetches||0),0),2);
  await coordinator.releaseOwner(previewOwner);let records=Object.values(await coordinator.snapshot());assert.equal(records.length,1);assert.equal(records[0].owner,newManagedOwner,'cleanup is still tied to the exact role/document owner');
  await managed.release();await previewB.release();assert.deepEqual(await coordinator.snapshot(),{});operation.dispose();
});

test('production cache/display budgets include old document instances while injected owners remain exact',async()=>{
  const {coordinator}=resource(),session=crypto.randomUUID(),owner=role=>`${session}:${crypto.randomUUID()}:${role}`;
  const first=await coordinator.reserve(owner('preview'),{encodedCache:16*1024*1024,displayBytes:32*1024*1024});
  await assert.rejects(coordinator.reserve(owner('preview'),{encodedCache:1}),/上限/);await assert.rejects(coordinator.reserve(owner('conversion'),{displayBytes:1}),/上限/);
  await first.release();
  const injectedA=await coordinator.reserve('synthetic:old:preview',{fetches:2}),injectedB=await coordinator.reserve('synthetic:new:conversion',{fetches:2});
  assert.equal(Object.values(await coordinator.snapshot()).reduce((sum,entry)=>sum+(entry.fetches||0),0),4,'unknown injected owner shapes retain exact-owner budgeting');
  await injectedA.release();await injectedB.release();assert.deepEqual(await coordinator.snapshot(),{});
});
