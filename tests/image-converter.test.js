import test from 'node:test';
import assert from 'node:assert/strict';
import {convertImage,MAX_SOURCE_BYTES,MAX_OUTPUT_BYTES} from '../extension/image-converter.js';
import {createMediaOperation} from '../extension/media-reader.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const response=(body=new Uint8Array([1,2,3]),headers={})=>new Response(body,{headers:{'content-type':'image/png',...headers}});
function fixture(overrides={}){
  const events=[],leases=[],releasedOutputs=[];
  const coordinator={async reserve(owner,amounts){events.push(['reserve',amounts]);const lease={released:0,covers:()=>true,async release(){this.released++;}};leases.push(lease);return lease;}};
  const options={ownerId:'test-owner',coordinator,fetchImpl:async()=>{events.push(['fetch']);return response();},
    inspectImpl:async blob=>{events.push(['inspect',blob.size]);return {format:'png',width:4,height:3,decodedPixels:12,frameCount:1};},
    decodeImpl:async(blob,metadata,settings)=>{events.push(['decode',settings]);return {blob:new Blob(['output'],{type:({jpg:'image/jpeg',png:'image/png',webp:'image/webp'})[settings.format]}),
      width:metadata.width,height:metadata.height,displayWidth:metadata.width,displayHeight:metadata.height,release:async()=>releasedOutputs.push(settings.format)};},...overrides};
  return {events,leases,releasedOutputs,options};
}

test('conversion reserves source buffers before fetch and transfers output ownership through file lifetime',async()=>{
  for(const [format,mime] of [['jpg','image/jpeg'],['png','image/png'],['webp','image/webp']]){
    const h=fixture();let request;
    h.options.fetchImpl=async(_url,settings)=>{request=settings;h.events.push(['fetch']);return response();};
    const blob=await convertImage('https://images.test/a',format,h.options);
    assert.equal(h.events[0][0],'reserve');assert.equal(h.events[1][0],'fetch');
    assert.equal(request.credentials,'include');assert.equal(request.referrerPolicy,'no-referrer');assert.equal(request.redirect,'error');
    assert.equal(blob.type,mime);assert.equal(blob.sourceBytes,3);
    assert.equal(h.leases[0].released,1,'source accounting ends only after decode settles');
    assert.equal(h.releasedOutputs.length,0,'output lease remains owned after return');
    const settings=h.events.find(event=>event[0]==='decode')[1];
    assert.equal(settings.format,format);assert.equal(settings.sourceReservation,h.leases[0]);
    assert.equal(settings.maxInputBytes,MAX_SOURCE_BYTES);assert.equal(settings.maxOutputBytes,MAX_OUTPUT_BYTES);
    assert.equal(settings.ownerId,'test-owner');assert.equal(settings.quality,0.92);
    await blob.releaseResources();await blob.releaseResources();assert.deepEqual(h.releasedOutputs,[format]);
  }
});

test('unsupported formats and known oversized source dimensions refuse before any request or reservation',async()=>{
  const h=fixture();
  for(const format of ['gif','constructor','__proto__'])await assert.rejects(convertImage('https://images.test/a',format,h.options),/対応していない/);
  await assert.rejects(convertImage('https://images.test/a','png',{...h.options,knownWidth:16385}),/16384/);
  await assert.rejects(convertImage('https://images.test/a','png',{...h.options,knownWidth:6000,knownHeight:5000}),/2400/);
  assert.deepEqual(h.events,[]);
});

test('HTTP, nonimage responses, empty bodies and declared oversize never reach metadata or codec',async()=>{
  for(const value of [new Response('denied',{status:403}),response('html',{'content-type':'text/html'}),response('{}',{'content-type':'application/problem+json'}),response(new Uint8Array()),response(new Uint8Array([1]),{'content-length':String(MAX_SOURCE_BYTES+1)})]){
    const h=fixture({fetchImpl:async()=>value});
    await assert.rejects(convertImage('https://images.test/a','png',h.options));
    assert.equal(h.events.some(event=>event[0]==='inspect'),false);assert.equal(h.events.some(event=>event[0]==='decode'),false);
    assert.equal(h.leases[0].released,1);
  }
});

test('observed body bounds are enforced before metadata including a false small length and compressed body',async()=>{
  for(const headers of [{},{'content-length':'1'},{'content-length':'1','content-encoding':'gzip'}]){
    const h=fixture({maxInputBytes:2,fetchImpl:async()=>response(new Uint8Array([1,2,3]),headers)});
    await assert.rejects(convertImage('https://images.test/a','png',h.options),error=>error.code==='byte-limit'&&error.bytesReceived===3);
    assert.equal(h.events.some(event=>event[0]==='inspect'),false);
  }
});

test('header refusal and untrusted decoded dimensions cannot fall back to page Image or original bytes',async()=>{
  for(const inspectImpl of [async()=>{throw new Error('unsupported input');},async()=>({width:0,height:0}),async()=>({width:6000,height:5000})]){
    const h=fixture({inspectImpl});
    await assert.rejects(convertImage('https://images.test/a','png',h.options));
    assert.equal(h.events.some(event=>event[0]==='decode'),false);
    assert.equal(h.releasedOutputs.length,0);
  }
});

test('incorrect codec MIME, empty/oversized output and changed dimensions are refused and released',async()=>{
  const bad=[
    {blob:new Blob(['x'],{type:'image/png'}),width:4,height:3},
    {blob:new Blob([],{type:'image/jpeg'}),width:4,height:3},
    {blob:new Blob(['x'],{type:'image/jpeg'}),width:5,height:3}
  ];
  const oversized=new Blob(['x'],{type:'image/jpeg'});Object.defineProperty(oversized,'size',{value:MAX_OUTPUT_BYTES+1});bad.push({blob:oversized,width:4,height:3});
  for(const value of bad){let releases=0;const h=fixture({decodeImpl:async()=>({...value,release:async()=>releases++})});
    await assert.rejects(convertImage('https://images.test/a','jpg',h.options));assert.equal(releases,1);}
});

test('aborted native metadata inspection keeps its reservation until actual inspection settles',async()=>{
  const inspection=deferred(),started=deferred(),controller=new AbortController();
  const h=fixture({signal:controller.signal,inspectImpl:()=>{started.resolve();return inspection.promise;}});
  const pending=convertImage('https://images.test/a','png',h.options);await started.promise;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(h.leases[0].released,0,'the source Blob/copy still belongs to pending inspection');
  inspection.resolve({width:4,height:3});await nextTurn();
  assert.equal(h.leases[0].released,1);assert.equal(h.events.some(event=>event[0]==='decode'),false);
});

test('aborted codec acquisition holds source accounting and releases a late generated output',async()=>{
  const decoding=deferred(),started=deferred(),controller=new AbortController();let outputReleases=0;
  const h=fixture({signal:controller.signal,decodeImpl:()=>{started.resolve();return decoding.promise;}});
  const pending=convertImage('https://images.test/a','png',h.options);await started.promise;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(h.leases[0].released,0);
  decoding.resolve({blob:new Blob(['late'],{type:'image/png'}),width:4,height:3,release:async()=>outputReleases++});await nextTurn();
  assert.equal(h.leases[0].released,1);assert.equal(outputReleases,1);
});

test('absolute operation deadline covers metadata and codec work, including timer throttling',async()=>{
  const started=deferred(),inspection=deferred();let now=Date.now();const deadline=now+120000;
  const operation=createMediaOperation({now:()=>now,deadline});
  const h=fixture({operation,inspectImpl:()=>{started.resolve();return inspection.promise;}});
  const pending=convertImage('https://images.test/a','png',h.options);await started.promise;
  now=deadline+1;inspection.resolve({width:4,height:3});
  try{await assert.rejects(pending,{name:'TimeoutError'});assert.equal(h.events.some(event=>event[0]==='decode'),false);}finally{operation.dispose();}
});

test('fetch errors have local explanations and preserve source byte accounting without signed URLs',async()=>{
  const h=fixture({fetchImpl:async()=>{throw new TypeError('https://images.test/a?signature=synthetic');}});
  await assert.rejects(convertImage('https://images.test/a','png',h.options),error=>!error.message.includes('signature')&&error.bytesReceived===0);
  assert.equal(h.leases[0].released,1);
});

test('source byte callback failure prevents the chunk from reaching inspection and keeps observed bytes',async()=>{
  const h=fixture({onBytes:async()=>{throw new Error('budget refused');}});
  await assert.rejects(convertImage('https://images.test/a','png',h.options),error=>error.message==='budget refused'&&error.bytesReceived===3);
  assert.equal(h.events.some(event=>event[0]==='inspect'),false);
});

test('a cancelled conversion does not reserve or fetch',async()=>{
  const controller=new AbortController();controller.abort();const h=fixture({signal:controller.signal});
  await assert.rejects(convertImage('https://images.test/a','png',h.options),{name:'AbortError'});assert.deepEqual(h.events,[]);
});

test('a late source reservation is released when cancellation wins acquisition',async()=>{
  const reservation=deferred(),controller=new AbortController();let releases=0;
  const h=fixture({signal:controller.signal,coordinator:{reserve:()=>reservation.promise}});
  const pending=convertImage('https://images.test/a','png',h.options);controller.abort();await assert.rejects(pending,{name:'AbortError'});
  reservation.resolve({release:async()=>releases++});await nextTurn();assert.equal(releases,1);assert.equal(h.events.some(event=>event[0]==='fetch'),false);
});


test('absolute deadline winning a fulfilled reservation releases the lease without starting fetch',async()=>{
  const reservation=deferred();let now=Date.now(),releases=0;
  const operation=createMediaOperation({now:()=>now,deadline:now+120000});
  const h=fixture({operation,coordinator:{reserve:()=>reservation.promise}});
  const converting=convertImage('https://images.test/a','png',h.options);now+=120001;
  reservation.resolve({release:async()=>releases++});
  try{await assert.rejects(converting,{name:'TimeoutError'});await nextTurn();assert.equal(releases,1);assert.equal(h.events.some(event=>event[0]==='fetch'),false);}
  finally{operation.dispose();}
});

test('absolute deadline winning a fulfilled codec result releases its output and source ownership',async()=>{
  const decoding=deferred(),started=deferred();let now=Date.now(),releases=0;
  const operation=createMediaOperation({now:()=>now,deadline:now+120000});
  const h=fixture({operation,decodeImpl:()=>{started.resolve();return decoding.promise;}});
  const converting=convertImage('https://images.test/a','png',h.options);await started.promise;now+=120001;
  decoding.resolve({blob:new Blob(['late'],{type:'image/png'}),width:4,height:3,release:async()=>releases++});
  try{await assert.rejects(converting,{name:'TimeoutError'});await nextTurn();assert.equal(releases,1);assert.equal(h.leases[0].released,1);}
  finally{operation.dispose();}
});

test('converted Blob carries an immutable output lease identity for Chrome ownership handoff',async()=>{
  const identity=Object.freeze({id:'output-lease',owner:'test-owner'});let releases=0;
  const h=fixture({decodeImpl:async()=>({blob:new Blob(['out'],{type:'image/png'}),width:4,height:3,resourceLease:identity,release:async()=>releases++})});
  const blob=await convertImage('https://images.test/a','png',h.options);assert.equal(blob.resourceLease,identity);assert.equal(Object.getOwnPropertyDescriptor(blob,'resourceLease').writable,false);
  await blob.releaseResources();assert.equal(releases,1);
});
