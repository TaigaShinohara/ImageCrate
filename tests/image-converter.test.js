import test from 'node:test';
import assert from 'node:assert/strict';
import {convertImage, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES} from '../extension/image-converter.js';

const deferred = () => {
  let resolve;let reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
const imageResponse = (body = new Uint8Array([1,2,3]), headers = {}) => new Response(body, {
  headers:{'content-type':'image/png',...headers}
});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function codecs(t, {width=4,height=3,decode,encode,svgWidth=200,svgHeight=150} = {}) {
  const events = [], bitmaps = [], canvases = [], images = [];
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
  const originalCanvas = Object.getOwnPropertyDescriptor(globalThis,'OffscreenCanvas');
  const originalImage = Object.getOwnPropertyDescriptor(globalThis,'Image');
  const bitmap = () => {
    const value={width,height,closeCount:0,close(){this.closeCount++;events.push(['close']);}};
    bitmaps.push(value);return value;
  };
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async (source,options) => {
    events.push(['decode',source,options]);
    return decode ? decode(source,options,bitmap) : bitmap();
  }});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,writable:true,value:class {
    constructor(w,h){this.width=w;this.height=h;canvases.push(this);events.push(['canvas',w,h]);}
    getContext(){return {set fillStyle(value){events.push(['fillStyle',value]);},fillRect(...args){events.push(['fillRect',...args]);},drawImage(...args){events.push(['draw',...args]);}};}
    async convertToBlob(options){events.push(['encode',options]);return encode ? encode(options) : new Blob(['encoded image'],{type:options.type});}
  }});
  Object.defineProperty(globalThis,'Image',{configurable:true,writable:true,value:class {
    constructor(){this.naturalWidth=svgWidth;this.naturalHeight=svgHeight;images.push(this);}
    async decode(){events.push(['image-decode',this.src]);}
  }});
  t.after(() => {
    for(const [name,value] of [['createImageBitmap',originalBitmap],['OffscreenCanvas',originalCanvas],['Image',originalImage]]) {
      if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];
    }
  });
  return {events,bitmaps,canvases,images,bitmap};
}

test('conversion requests the selected real codec, honors EXIF orientation and whites JPEG transparency', async t => {
  const h=codecs(t);
  const progress=[];let request;
  for(const [format,type] of [['jpg','image/jpeg'],['png','image/png'],['webp','image/webp']]) {
    const start=h.events.length;
    const result=await convertImage('https://images.test/photo.png',format,{
      fetchImpl:async (_url,options)=>{request=options;return imageResponse();},onProgress:value=>progress.push(value)
    });
    assert.equal(result.type,type);
    const events=h.events.slice(start),fill=events.findIndex(([name])=>name==='fillRect'),draw=events.findIndex(([name])=>name==='draw');
    if(format==='jpg'){assert.ok(fill>=0 && fill<draw);assert.deepEqual(events.find(([name])=>name==='fillStyle'),['fillStyle','#ffffff']);}
    else assert.equal(fill,-1,'alpha-preserving formats are not filled opaque');
    assert.deepEqual(events.find(([name])=>name==='decode')[2],{imageOrientation:'from-image'});
    assert.deepEqual(events.find(([name])=>name==='encode')[1],{type,quality:0.92});
  }
  assert.equal(request.credentials,'include');assert.equal(request.referrerPolicy,'no-referrer');
  assert.deepEqual(progress,[{bytesReceived:3,totalBytes:0},{bytesReceived:3,totalBytes:0},{bytesReceived:3,totalBytes:0}]);
  assert.ok(h.bitmaps.every(bitmap=>bitmap.closeCount===1));
  assert.ok(h.canvases.every(canvas=>canvas.width===1 && canvas.height===1));
});

test('unsupported selection and known oversized dimensions fail before any request', async () => {
  let requests=0;const fetchImpl=async()=>{requests++;return imageResponse();};
  for(const format of ['gif','constructor','__proto__']) {
    await assert.rejects(convertImage('https://images.test/a',format,{fetchImpl}),/対応していない/);
  }
  await assert.rejects(convertImage('https://images.test/a','png',{fetchImpl,knownWidth:16385}),/16384/);
  await assert.rejects(convertImage('https://images.test/a','png',{fetchImpl,knownWidth:6000,knownHeight:5000}),/2400/);
  assert.equal(requests,0);
});

test('HTTP errors, nonimage error responses, empty bodies and declared byte limits are refused before decode', async t => {
  const h=codecs(t);
  for(const response of [new Response('blocked',{status:403}),imageResponse('HTML',{'content-type':'text/html'}),
    imageResponse('{}',{'content-type':'application/problem+json'}),imageResponse('<error/>',{'content-type':'application/xml'}),
    imageResponse(new Uint8Array()),imageResponse('x',{'content-length':String(MAX_SOURCE_BYTES+1)})]) {
    await assert.rejects(convertImage('https://images.test/a','png',{fetchImpl:async()=>response}));
  }
  assert.equal(h.events.length,0);
});

test('streamed data is bounded even when the response does not declare its size', async t => {
  const h=codecs(t);let cancelled=false;
  const chunk=new Uint8Array(1024*1024);
  const body=new ReadableStream({pull(stream){stream.enqueue(chunk);},cancel(){cancelled=true;}});
  await assert.rejects(convertImage('https://images.test/a','png',{fetchImpl:async()=>imageResponse(body)}),/32MiB/);
  assert.equal(h.events.length,0);assert.equal(cancelled,true);
});

test('oversized decoded dimensions release the bitmap before a canvas can allocate', async t => {
  const h=codecs(t,{width:6000,height:5000});
  await assert.rejects(convertImage('https://images.test/a','png',{fetchImpl:async()=>imageResponse()}),/2400/);
  assert.equal(h.canvases.length,0);assert.equal(h.bitmaps[0].closeCount,1);
});

test('an encoder PNG fallback or empty result is never mislabeled as the selected extension', async t => {
  let output=new Blob(['PNG'],{type:'image/png'});
  const h=codecs(t,{encode:async()=>output});
  await assert.rejects(convertImage('https://images.test/a','webp',{fetchImpl:async()=>imageResponse()}),/選んだ形式/);
  output=new Blob([],{type:'image/webp'});
  await assert.rejects(convertImage('https://images.test/a','webp',{fetchImpl:async()=>imageResponse()}),/選んだ形式/);
  assert.ok(h.bitmaps.every(bitmap=>bitmap.closeCount===1));
});

test('native fetch and encoder errors have actionable local explanations without source URLs', async t => {
  const h=codecs(t,{encode:async()=>{throw new DOMException('encode failed','EncodingError');}});
  await assert.rejects(convertImage('https://images.test/a?secret=value','png',{fetchImpl:async()=>{throw new TypeError('https://images.test/a?secret=value');}}),/配信元へのアクセス許可/);
  await assert.rejects(convertImage('https://images.test/a?secret=value','png',{fetchImpl:async()=>imageResponse()}),/別の形式/);
  assert.equal(h.bitmaps[0].closeCount,1);assert.equal(h.canvases[0].width,1);
});

test('oversized encoded output is refused and the canvas is released', async t => {
  const h=codecs(t,{encode:async()=>({type:'image/png',size:MAX_OUTPUT_BYTES+1})});
  await assert.rejects(convertImage('https://images.test/a','png',{fetchImpl:async()=>imageResponse()}),/64MiB/);
  assert.equal(h.canvases[0].width,1);assert.equal(h.canvases[0].height,1);
});

test('SVG fallback uses inert image natural dimensions and releases its object URL and image', async t => {
  const h=codecs(t,{decode:async(source,_options,bitmap)=>{
    if(source instanceof Blob)throw new DOMException('SVG Blob not decoded','InvalidStateError');
    return bitmap();
  }});
  const created=[],revoked=[];
  t.mock.method(URL,'createObjectURL',blob=>{created.push(blob);return 'blob:synthetic-svg';});
  t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
  const result=await convertImage('https://images.test/a.svg','png',{fetchImpl:async()=>imageResponse('<svg/>',{'content-type':'image/svg+xml'})});
  assert.equal(result.type,'image/png');
  const decodes=h.events.filter(([name])=>name==='decode');
  assert.deepEqual(decodes[1][2],{imageOrientation:'from-image',resizeWidth:200,resizeHeight:150});
  assert.equal(created.length,1);assert.deepEqual(revoked,['blob:synthetic-svg']);assert.equal(h.images[0].src,'');
});

test('SVG without usable natural dimensions fails without inventing a render size', async t => {
  const h=codecs(t,{svgWidth:0,svgHeight:0,decode:async()=>{throw new DOMException('no image','InvalidStateError');}});
  await assert.rejects(convertImage('https://images.test/a.svg','png',{fetchImpl:async()=>imageResponse('<svg/>',{'content-type':'image/svg+xml'})}),/寸法/);
  assert.equal(h.canvases.length,0);assert.equal(h.images[0].src,'');
});

test('corrupt raster decode fails with a local explanation, without a format fallback', async t => {
  const h=codecs(t,{decode:async()=>{throw new DOMException('bad file','InvalidStateError');}});
  await assert.rejects(convertImage('https://images.test/a','jpg',{fetchImpl:async()=>imageResponse()}),/元の形式/);
  assert.equal(h.canvases.length,0);assert.equal(h.images.length,0);
});

test('Stop during a native decoder promptly rejects and closes its late bitmap result', async t => {
  const decoding=deferred(),started=deferred();
  const h=codecs(t,{decode:async()=>{started.resolve();return decoding.promise;}});
  const controller=new AbortController();
  const saving=convertImage('https://images.test/a','png',{signal:controller.signal,fetchImpl:async()=>imageResponse()});
  await started.promise;controller.abort();
  await assert.rejects(saving,{name:'AbortError'});
  const late=h.bitmap();decoding.resolve(late);await nextTurn();
  assert.equal(late.closeCount,1);assert.equal(h.canvases.length,0);
});

test('Stop during encode discards its late result and releases canvas pixels', async t => {
  const encoding=deferred(),started=deferred();
  const h=codecs(t,{encode:async()=>{started.resolve();return encoding.promise;}});
  const controller=new AbortController();
  const saving=convertImage('https://images.test/a','png',{signal:controller.signal,fetchImpl:async()=>imageResponse()});
  await started.promise;controller.abort();await assert.rejects(saving,{name:'AbortError'});
  encoding.resolve(new Blob(['encoded'],{type:'image/png'}));await nextTurn();
  assert.equal(h.bitmaps[0].closeCount,1);assert.equal(h.canvases[0].width,1);
});

test('stalled image bytes time out and cancel their stream', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const received=deferred();let cancelled=false;
  const body=new ReadableStream({start(stream){stream.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
  const saving=convertImage('https://images.test/a','png',{fetchImpl:async()=>imageResponse(body),onProgress:()=>received.resolve()});
  await received.promise;t.mock.timers.tick(30000);
  await assert.rejects(saving,{name:'TimeoutError'});assert.equal(cancelled,true);
});

test('a cancelled conversion never fetches image bytes', async () => {
  const controller=new AbortController();controller.abort();let requests=0;
  await assert.rejects(convertImage('https://images.test/a','png',{signal:controller.signal,fetchImpl:async()=>{requests++;return imageResponse();}}),{name:'AbortError'});
  assert.equal(requests,0);
});
