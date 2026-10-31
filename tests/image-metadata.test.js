import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectImageMetadata,inspectImage} from '../extension/image-metadata.js';
import {renderStaticImage} from '../extension/image-decode-worker.js';
const ascii=s=>new TextEncoder().encode(s);
const concat=(...parts)=>Uint8Array.from(parts.flatMap(part=>[...part]));
const be32=n=>Uint8Array.of(n>>>24,n>>>16,n>>>8,n);
const le32=n=>Uint8Array.of(n,n>>>8,n>>>16,n>>>24);
const chunk=(type,data)=>concat(be32(data.length),ascii(type),data,new Uint8Array(4));
const ihdr=(w,h)=>concat(be32(w),be32(h),[8,6,0,0,0]);
const png=(w=4,h=3,...chunks)=>concat([137,80,78,71,13,10,26,10],chunk('IHDR',ihdr(w,h)),...chunks,chunk('IDAT',[1]),chunk('IEND',[]));
const gif=(w=4,h=3,frames=1)=>concat(ascii('GIF89a'),[w,0,h,0,0,0,0],...Array.from({length:frames},()=>concat([0x2c,0,0,0,0,w,0,h,0,0,2,1,0,0])),[0x3b]);
const jpeg=(orientation=1)=>{
  const exif=concat(ascii('Exif\0\0II'),[42,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0]);
  return concat([255,216,255,225,0,exif.length+2],exif,[255,192,0,11,8,0,3,0,4,1,1,0x11,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
};
const webpChunk=(type,data)=>concat(ascii(type),le32(data.length),data,data.length%2?[0]:[]);
const webp=(w=4,h=3)=>{const body=concat(ascii('WEBP'),webpChunk('VP8L',concat([0x2f],le32((w-1)|((h-1)<<14)))));return concat(ascii('RIFF'),le32(body.length),body);};

test('raster headers expose source dimensions and EXIF orientation separately',()=>{
  for(const [bytes,format]of [[png(),'png'],[gif(),'gif'],[jpeg(),'jpeg'],[webp(),'webp']]){
    const result=inspectImageMetadata(bytes);assert.equal(result.format,format);assert.equal(result.width,4);assert.equal(result.height,3);
  }
  const rotated=inspectImageMetadata(jpeg(6));assert.equal(rotated.width,3);assert.equal(rotated.height,4);assert.equal(rotated.encodedWidth,4);assert.equal(rotated.orientation,6);
});

test('short and unknown input, AVIF boxes and huge declarations fail before any codec',async()=>{
  for(const bytes of [[1],png().slice(0,24),png(8193,1),png(6000,5000),jpeg().slice(0,-2),concat(be32(24),ascii('ftypavif'),new Uint8Array(12))])assert.throws(()=>inspectImageMetadata(Uint8Array.from(bytes)),/安全に確認/);
  await assert.rejects(inspectImage(new Blob([png()]),{maxBytes:8}),/容量/);
});

test('all GIF and APNG frames are bounded, counted and require coherent termination',()=>{
  assert.equal(inspectImageMetadata(gif(4,3,2)).frameCount,2);
  assert.throws(()=>inspectImageMetadata(gif(4,3,65)),/フレーム数/);
  const control=concat(be32(0),be32(4),be32(3),be32(0),be32(0),[0,1,0,1,0,0]);
  const animated=png(4,3,chunk('acTL',concat(be32(1),be32(0))),chunk('fcTL',control));
  assert.equal(inspectImageMetadata(animated).frameCount,1);
  assert.throws(()=>inspectImageMetadata(png(4,3,chunk('acTL',concat(be32(2),be32(0))),chunk('fcTL',control))),/フレーム数/);
  assert.throws(()=>inspectImageMetadata(png(4,3,chunk('acTL',concat(be32(1),be32(0))),chunk('fcTL',concat(be32(0),be32(8193),control.slice(8))))),/寸法/);
  assert.throws(()=>inspectImageMetadata(png(4,3,chunk('iCCP',[1]))),/圧縮metadata/);
});

test('bounded structural work refuses thousands of inert PNG chunks',()=>{
  assert.throws(()=>inspectImageMetadata(png(1,1,...Array.from({length:8200},()=>chunk('tEXt',[])))),/ヘッダー数/);
});

test('WebP validates nested frame headers rather than only the canvas dimensions',()=>{
  const vp8x=concat([2,0,0,0,3,0,0,2,0,0]);
  const frameHeader=[0,0,0,0,0,0,3,0,0,2,0,0,1,0,0,0];
  const body=concat(ascii('WEBP'),webpChunk('VP8X',vp8x),webpChunk('ANIM',new Uint8Array(6)),webpChunk('ANMF',concat(frameHeader,webp(4,3).slice(12))));
  const bytes=concat(ascii('RIFF'),le32(body.length),body);assert.equal(inspectImageMetadata(bytes).frameCount,1);
  const corrupt=bytes.slice();corrupt[74]=0xff;assert.throws(()=>inspectImageMetadata(corrupt));
});

test('ICO bounds every embedded resource, not only the chosen largest image',()=>{
  const nested=png(4,3),entry=concat([4,3,0,0,1,0,32,0],le32(nested.length),le32(22));
  const valid=concat([0,0,1,0,1,0],entry,nested);assert.equal(inspectImageMetadata(valid).embeddedImages,1);
  const bad=valid.slice();bad[6]=3;assert.throws(()=>inspectImageMetadata(bad),/内包寸法/);
  assert.throws(()=>inspectImageMetadata(concat([0,0,1,0,65,0],new Uint8Array(65*16))),/entry数/);
});

test('tiny SVG rectangle language is rendered directly; general SVG features fail closed',()=>{
  const safe=ascii('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="100%" height="100%" fill="#123456"/></svg>');
  const result=inspectImageMetadata(safe);assert.equal(result.format,'svg');assert.equal(result.svgRects[0].width,16);
  for(const source of ['<svg/>','<svg width="1" height="1"><image href="https://a.test/x"/></svg>','<svg width="1" height="1"><rect width="1" height="1" fill="url(#x)"/></svg>',
    '<!DOCTYPE svg><svg width="1" height="1"></svg>','<svg width="1" height="1"><rect onload="x"/></svg>','<svg width="1" height="1">&amp;</svg>',
    '<svg width="1" height="1"><g><rect/></g></svg>'])assert.throws(()=>inspectImageMetadata(ascii(source)),/安全に確認/);
});

test('worker preflight rejects unknown data with zero native codec calls and closes valid bitmap/canvas',async()=>{
  let calls=0,closed=0,canvas;
  const environment={createImageBitmap:async()=>{calls++;return{width:4,height:3,close(){closed++;}};},OffscreenCanvas:class{
    constructor(w,h){this.width=w;this.height=h;canvas=this;}
    getContext(){return{drawImage(){},fillRect(){},scale(){},translate(){}};}
    async convertToBlob({type}){return new Blob(['out'],{type});}
  }};
  await assert.rejects(renderStaticImage(new Blob(['unknown']),{format:'png',width:4,height:3,frameCount:1},{},environment));assert.equal(calls,0);
  const blob=new Blob([png()]);const result=await renderStaticImage(blob,await inspectImage(blob),{maxDimension:2},environment);
  assert.equal(result.width,4);assert.equal(result.displayWidth,2);assert.equal(calls,1);assert.equal(closed,1);assert.equal(canvas.width,1);
  const svg=new Blob(['<svg width="4" height="3"><rect width="4" height="3" fill="red"/></svg>']);await renderStaticImage(svg,await inspectImage(svg),{},environment);assert.equal(calls,1,'SVG never enters native decode');
});

test('worker releases resources when actual native dimensions disagree or encode fails',async()=>{
  let closed=0,canvases=[];
  const environment={createImageBitmap:async()=>({width:9000,height:9000,close(){closed++;}}),OffscreenCanvas:class{
    constructor(w,h){this.width=w;this.height=h;canvases.push(this);}getContext(){return{drawImage(){}};}
  }};
  const blob=new Blob([png()]);await assert.rejects(renderStaticImage(blob,await inspectImage(blob),{},environment),/寸法/);assert.equal(closed,1);assert.equal(canvases[0].width,1);
});

test('JPEG EXIF cycles, embedded thumbnails and excessive sampling are rejected before codec',()=>{
  const cyclic=jpeg();cyclic[34]=8;assert.throws(()=>inspectImageMetadata(cyclic),/循環/);
  const thumbnail=jpeg();thumbnail[22]=1;thumbnail[23]=2;assert.throws(()=>inspectImageMetadata(thumbnail),/埋め込み/);
  const sampling=jpeg();const sof=sampling.findIndex((value,i)=>value===255&&sampling[i+1]===192);sampling[sof+11]=0xff;assert.throws(()=>inspectImageMetadata(sampling),/sampling/);
});

test('BMP bounds declared dimensions, palette and embedded compression before native decode',()=>{
  const bytes=new Uint8Array(70),view=new DataView(bytes.buffer);bytes.set([66,77]);view.setUint32(2,70,true);view.setUint32(10,54,true);view.setUint32(14,40,true);view.setInt32(18,2,true);view.setInt32(22,2,true);view.setUint16(26,1,true);view.setUint16(28,24,true);
  assert.equal(inspectImageMetadata(bytes).format,'bmp');
  const compression=bytes.slice();new DataView(compression.buffer).setUint32(30,5,true);assert.throws(()=>inspectImageMetadata(compression),/圧縮/);
  const palette=bytes.slice();new DataView(palette.buffer).setUint32(46,0x7fffffff,true);assert.throws(()=>inspectImageMetadata(palette),/palette/);
  const dimensions=bytes.slice();new DataView(dimensions.buffer).setUint32(18,9000,true);assert.throws(()=>inspectImageMetadata(dimensions),/寸法/);
});

test('JPEG white background and alpha preserving outputs use exact requested encoders',async()=>{
  const blob=new Blob(['<svg width="4" height="3"><rect width="4" height="3" fill="none"/></svg>']),metadata=await inspectImage(blob),events=[];
  const environment={OffscreenCanvas:class{
    constructor(w,h){this.width=w;this.height=h;}
    getContext(){return{set fillStyle(value){events.push(['fillStyle',value]);},fillRect(...values){events.push(['fillRect',...values]);},scale(){},translate(){}};}
    async convertToBlob(options){events.push(['encode',options]);return new Blob(['out'],{type:options.type});}
  }};
  for(const format of ['jpg','png','webp']){events.length=0;const output=await renderStaticImage(blob,metadata,{format},environment);assert.equal(output.blob.type,`image/${format==='jpg'?'jpeg':format}`);assert.equal(events.some(([event])=>event==='fillRect'),format==='jpg');}
  environment.OffscreenCanvas.prototype.convertToBlob=async()=>new Blob(['fallback'],{type:'image/png'});
  await assert.rejects(renderStaticImage(blob,metadata,{format:'webp'},environment),/形式/);
});
