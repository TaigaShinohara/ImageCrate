// A bounded structural preflight. Unknown containers never reach a native codec.
// This validates allocation dimensions, not image authenticity or decoder internals.
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = 8192;
const MAX_FRAMES = 64;
const MAX_FRAME_PIXELS = 64_000_000;
const MIME = {png:'image/png',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',ico:'image/x-icon',svg:'image/svg+xml'};
const failure = message => new Error(`画像を安全に確認できません（${message}）。元の形式での保存を試せます。`);
function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  throw failure('画像データが不明です');
}
function parser(value,limits) {
  const bytes=bytesOf(value), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const maxBytes=limits.maxBytes??MAX_BYTES,maxPixels=limits.maxPixels??24_000_000,maxDimension=limits.maxDimension??8192;
  if (!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>MAX_BYTES||!Number.isSafeInteger(maxPixels)||maxPixels<=0||maxPixels>24_000_000||!Number.isSafeInteger(maxDimension)||maxDimension<=0||maxDimension>16384||bytes.length===0||bytes.length>maxBytes) throw failure('ファイル容量の上限');
  let work=0,framePixels=0;
  const need=(offset,size)=>{if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset+size>bytes.length)throw failure('短い・不整合なヘッダー');};
  const step=()=>{if(++work>MAX_PARTS)throw failure('ヘッダー数の上限');};
  const u16=(o,le=false)=>{need(o,2);return view.getUint16(o,le);};
  const u32=(o,le=false)=>{need(o,4);return view.getUint32(o,le);};
  const text=(o,s)=>{need(o,s.length);return [...s].every((c,i)=>bytes[o+i]===c.charCodeAt(0));};
  const dims=(w,h)=>{if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<=0||h<=0||w>maxDimension||h>maxDimension||w*h>maxPixels)throw failure('寸法・画素数の上限');return {width:w,height:h};};
  const frame=(w,h)=>{dims(w,h);framePixels+=w*h;if(framePixels>MAX_FRAME_PIXELS)throw failure('合計フレーム画素数の上限');};
  const done=(format,w,h,extra={})=>{dims(w,h);const orientation=extra.orientation??1;return Object.freeze({format,mimeType:MIME[format],encodedWidth:w,encodedHeight:h,width:orientation>=5?h:w,height:orientation>=5?w:h,frameCount:1,decodedPixels:Math.max(w*h,framePixels),orientation,...extra});};
  return {bytes,view,need,step,u16,u32,text,dims,frame,done};
}
function exif(p,start,length) {
  const {need,u16,u32,bytes,step,dims}=p;need(start,length);
  const end=start+length;if(length<8)throw failure('EXIFヘッダー');
  const le=bytes[start]===73&&bytes[start+1]===73;
  if(!le&&!(bytes[start]===77&&bytes[start+1]===77)||u16(start+2,le)!==42)throw failure('EXIF形式');
  let orientation=1,ifd=u32(start+4,le),visited=new Set(),directories=0;
  const pending=[ifd];
  while(pending.length){
    ifd=pending.pop();if(!ifd)continue;
    if(visited.has(ifd)||++directories>8)throw failure('EXIF参照の循環・上限');visited.add(ifd);
    const base=start+ifd;if(base<start+8||base+2>end)throw failure('EXIF参照');
    const count=u16(base,le);if(count>256||base+2+count*12+4>end)throw failure('EXIF項目数');
    let thumbnailOffset=0,thumbnailLength=0,embeddedWidth=0,embeddedHeight=0;
    for(let i=0;i<count;i++){
      step();const pos=base+2+i*12,tag=u16(pos,le),type=u16(pos+2,le),countValue=u32(pos+4,le);
      const size=({1:1,2:1,3:2,4:4,5:8,7:1,9:4,10:8})[type];
      if(!size||countValue>65536)throw failure('EXIF項目');
      const lengthValue=size*countValue,at=lengthValue<=4?pos+8:start+u32(pos+8,le);
      if(at<start||at+lengthValue>end)throw failure('EXIF項目の範囲');
      const scalar=countValue===1&&(type===3||type===4)?(type===3?u16(at,le):u32(at,le)):0;
      if(tag===0x112){if(scalar<1||scalar>8)throw failure('EXIF回転');orientation=scalar;}
      if(tag===0x8769||tag===0x8825){if(type!==4||countValue!==1)throw failure('EXIF参照');pending.push(scalar);}
      // SubIFDs, strips, tiles and embedded JPEG thumbnails are not decoded.
      // Reject them rather than allow an unbounded second embedded image.
      if([0x14a,0x111,0x117,0x144,0x145].includes(tag))throw failure('未対応のEXIF埋め込み画像');
      if(tag===0x201)thumbnailOffset=scalar;if(tag===0x202)thumbnailLength=scalar;
      if(tag===0x100||tag===0xa002)embeddedWidth=scalar;if(tag===0x101||tag===0xa003)embeddedHeight=scalar;
    }
    if(embeddedWidth||embeddedHeight){if(!embeddedWidth||!embeddedHeight)throw failure('EXIF寸法');dims(embeddedWidth,embeddedHeight);}
    if(thumbnailOffset||thumbnailLength)throw failure('未対応のEXIF埋め込み画像');
    pending.push(u32(base+2+count*12,le));
  }
  return orientation;
}
function png(p,start=0,length=p.bytes.length) {
  const {bytes,need,u32,text,step,dims,frame,done}=p;need(start,length);
  if(length<33||!text(start,'\x89PNG\r\n\x1a\n'))throw failure('PNG署名');
  const end=start+length;let pos=start+8,width=0,height=0,frames=0,declared=0,idat=false,ended=false,orientation=1;
  while(pos<end){
    step();need(pos,12);const size=u32(pos),type=String.fromCharCode(...bytes.subarray(pos+4,pos+8));
    if(size>end-pos-12)throw failure('PNG chunk範囲');const data=pos+8;
    if(!width&&type!=='IHDR')throw failure('PNG IHDR順序');
    if(type==='IHDR'){
      if(width||size!==13)throw failure('PNG IHDR');width=u32(data);height=u32(data+4);dims(width,height);
      const depth=bytes[data+8],color=bytes[data+9];
      if(!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[color]?.includes(depth)||bytes[data+10]||bytes[data+11]||bytes[data+12]>1)throw failure('PNG画素形式');
    } else if(type==='acTL'){
      if(size!==8||declared||idat)throw failure('APNG構造');declared=u32(data);if(!declared||declared>MAX_FRAMES)throw failure('フレーム数の上限');
    } else if(type==='fcTL'){
      if(size!==26||!declared||++frames>MAX_FRAMES)throw failure('APNGフレーム');
      const w=u32(data+4),h=u32(data+8),x=u32(data+12),y=u32(data+16);
      if(x+w>width||y+h>height||bytes[data+24]>2||bytes[data+25]>1)throw failure('APNGフレーム寸法');frame(w,h);
    } else if(type==='IDAT'){if(!size)throw failure('PNG画素データ');idat=true;}
    else if(type==='fdAT'){if(!declared||!frames||size<4)throw failure('APNG画素データ');}
    else if(type==='eXIf'){orientation=exif(p,data,size);}
    else if(['iCCP','zTXt','iTXt'].includes(type))throw failure('未対応の圧縮metadata');
    else if(type==='IEND'){if(size||!idat||pos+12!==end)throw failure('PNG終端');ended=true;break;}
    else if(!/^[a-z][A-Za-z]{3}$/.test(type)&&!['PLTE'].includes(type))throw failure('未対応のPNG chunk');
    pos+=size+12;
  }
  if(!ended||declared&&frames!==declared)throw failure('PNGフレーム数・終端');
  if(!frames)frame(width,height);
  return done('png',width,height,{frameCount:frames||1,orientation});
}
function jpeg(p) {
  const {bytes,need,u16,text,step,dims,frame,done}=p;let pos=2,width=0,height=0,orientation=1,scan=false,ended=false;
  while(pos<bytes.length){
    step();if(bytes[pos++]!==255)throw failure('JPEG marker');while(bytes[pos]===255){step();pos++;}
    need(pos,1);const marker=bytes[pos++];
    if(marker===0xd9){ended=true;break;}
    if(marker===0||marker===0xd8||marker>=0xd0&&marker<=0xd7)throw failure('JPEG marker順序');
    if(!([0xc0,0xc1,0xc2,0xc4,0xda,0xdb,0xdd,0xfe].includes(marker)||marker>=0xe0&&marker<=0xef))throw failure('未対応のJPEG marker');
    const length=u16(pos);if(length<2)throw failure('JPEG marker長');need(pos,length);const data=pos+2,size=length-2;
    if([0xc0,0xc1,0xc2].includes(marker)){
      if(width||size<6||bytes[data]!==8)throw failure('JPEG SOF');height=u16(data+1);width=u16(data+3);dims(width,height);
      if(![1,3,4].includes(bytes[data+5])||size!==6+3*bytes[data+5])throw failure('JPEG色成分');
      let blocks=0;for(let i=0;i<bytes[data+5];i++){const sample=bytes[data+7+i*3],x=sample>>>4,y=sample&15;if(x<1||x>4||y<1||y>4)throw failure('JPEG sampling');blocks+=x*y;}if(blocks>10)throw failure('JPEG sampling上限');
    } else if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))throw failure('未対応のJPEG符号化');
    else if(marker===0xe1&&size>=6&&text(data,'Exif\0\0'))orientation=exif(p,data+6,size-6);
    else if(marker===0xe2&&size>=4&&text(data,'MPF\0'))throw failure('未対応のJPEG埋め込み画像');
    pos+=length;
    if(marker===0xda){
      if(!width||size<6)throw failure('JPEG scan順序');scan=true;
      // Linear pass through bounded encoded bytes; entropy bytes are never split.
      while(pos<bytes.length){if(bytes[pos++]!==255)continue;need(pos,1);if(bytes[pos]===0){pos++;continue;}if(bytes[pos]>=0xd0&&bytes[pos]<=0xd7){pos++;continue;}pos--;break;}
    }
  }
  if(!width||!scan||!ended||pos!==bytes.length)throw failure('JPEG終端');frame(width,height);return done('jpeg',width,height,{orientation});
}
function gif(p) {
  const {bytes,need,u16,step,frame,dims,done}=p;need(0,13);const width=u16(6,true),height=u16(8,true);dims(width,height);
  let pos=13+((bytes[10]&128)?3*(1<<((bytes[10]&7)+1)):0),frames=0,ended=false;need(0,pos);
  const blocks=()=>{while(true){step();need(pos,1);const size=bytes[pos++];if(!size)return;need(pos,size);pos+=size;}};
  while(pos<bytes.length){
    step();const type=bytes[pos++];if(type===0x3b){ended=true;break;}
    if(type===0x21){need(pos,1);const label=bytes[pos++];if(![0xf9,0xfe,0xff].includes(label))throw failure('未対応のGIF拡張');blocks();continue;}
    if(type!==0x2c)throw failure('GIF block');need(pos,9);
    const x=u16(pos,true),y=u16(pos+2,true),w=u16(pos+4,true),h=u16(pos+6,true),packed=bytes[pos+8];
    if(++frames>MAX_FRAMES||x+w>width||y+h>height)throw failure('GIFフレーム数・寸法');frame(w,h);pos+=9;
    if(packed&128){const size=3*(1<<((packed&7)+1));need(pos,size);pos+=size;}
    need(pos,1);if(bytes[pos]<2||bytes[pos]>8)throw failure('GIF LZW');pos++;blocks();
  }
  if(!frames||!ended||pos!==bytes.length)throw failure('GIF終端');return done('gif',width,height,{frameCount:frames});
}
function webp(p) {
  const {bytes,need,u32,text,step,dims,frame,done}=p;need(0,20);if(u32(4,true)+8!==bytes.length)throw failure('WebP RIFF長');
  const u24=o=>{need(o,3);return bytes[o]+bytes[o+1]*256+bytes[o+2]*65536;};
  const bitstream=(type,data,size)=>{
    if(type==='VP8 '){if(size<10||bytes[data]&1||!text(data+3,'\x9d\x01\x2a'))throw failure('WebP VP8');return dims(p.u16(data+6,true)&0x3fff,p.u16(data+8,true)&0x3fff);}
    if(type==='VP8L'){if(size<5||bytes[data]!==0x2f||bytes[data+4]>>5)throw failure('WebP VP8L');const bits=u32(data+1,true);return dims((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);}
    throw failure('WebP画素形式');
  };
  let pos=12,width=0,height=0,animated=false,frames=0,staticImage=null,animationHeader=false,orientation=1;
  while(pos<bytes.length){
    step();need(pos,8);const type=String.fromCharCode(...bytes.subarray(pos,pos+4)),size=u32(pos+4,true),data=pos+8;need(data,size+(size&1));
    if(type==='VP8X'){
      if(pos!==12||size!==10||bytes[data]&0xc1||bytes[data+1]||bytes[data+2]||bytes[data+3])throw failure('WebP VP8X');
      animated=Boolean(bytes[data]&2);width=u24(data+4)+1;height=u24(data+7)+1;dims(width,height);
    } else if(type==='ANIM'){if(!animated||animationHeader||size!==6)throw failure('WebP ANIM');animationHeader=true;}
    else if(type==='ANMF'){
      if(!animated||!animationHeader||size<24||++frames>MAX_FRAMES)throw failure('WebPフレーム');
      const x=u24(data)*2,y=u24(data+3)*2,w=u24(data+6)+1,h=u24(data+9)+1;
      if(x+w>width||y+h>height||bytes[data+15]&0xfc)throw failure('WebPフレーム寸法');frame(w,h);
      let inner=data+16,found=false;
      while(inner<data+size){step();need(inner,8);const t=String.fromCharCode(...bytes.subarray(inner,inner+4)),s=u32(inner+4,true);if(s>data+size-inner-8)throw failure('WebP内包範囲');
        if(t==='ALPH'){if(found)throw failure('WebP alpha順序');}
        else {if(found)throw failure('WebP複数画素');const actual=bitstream(t,inner+8,s);if(actual.width!==w||actual.height!==h)throw failure('WebP内包寸法');found=true;}
        inner+=8+s+(s&1);
      }
      if(!found||inner!==data+size)throw failure('WebP内包終端');
    } else if(type==='VP8 '||type==='VP8L'){
      if(animated||staticImage)throw failure('WebP複数画像');staticImage=bitstream(type,data,size);
    } else if(type==='EXIF'){orientation=exif(p,data,size);}
    else if(!['ALPH','ICCP','XMP '].includes(type))throw failure('未対応のWebP chunk');
    pos=data+size+(size&1);
  }
  if(animated){if(!frames||staticImage)throw failure('WebPアニメーション');}
  else {if(!staticImage)throw failure('WebP画素なし');if(width&&(width!==staticImage.width||height!==staticImage.height))throw failure('WebP宣言寸法');width=staticImage.width;height=staticImage.height;frame(width,height);}
  return done('webp',width,height,{frameCount:frames||1,orientation});
}
function dib(p,start,length,{icon=false}={}) {
  const {bytes,u16,u32,need,dims}=p;need(start,length);const header=u32(start,true);
  if(![12,40,108,124].includes(header)||header>length)throw failure('未対応のBMP header');
  let width,height,bits,compression=0;
  if(header===12){width=u16(start+4,true);height=u16(start+6,true);bits=u16(start+10,true);if(u16(start+8,true)!==1)throw failure('BMP plane');}
  else {width=p.view.getInt32(start+4,true);height=p.view.getInt32(start+8,true);bits=u16(start+14,true);compression=u32(start+16,true);if(u16(start+12,true)!==1||height===-2147483648)throw failure('BMP plane');height=Math.abs(height);
    if(header===124&&(u32(start+112,true)||u32(start+116,true)))throw failure('BMP埋め込みprofile');
  }
  if(icon){if(height%2)throw failure('ICO DIB寸法');height/=2;}
  dims(width,height);if(![1,4,8,16,24,32].includes(bits)||![0,3].includes(compression)||compression===3&&![16,32].includes(bits))throw failure('未対応のBMP圧縮');
  const colors=header===12?(bits<=8?1<<bits:0):u32(start+32,true);
  if(colors>256||bits<=8&&colors>(1<<bits))throw failure('BMP palette上限');
  const paletteColors=bits<=8?(colors||1<<bits):colors,paletteBytes=paletteColors*(header===12?3:4),masks=header===40&&compression===3?12:0;
  const row=Math.ceil(width*bits/32)*4,pixelBytes=row*height,minOffset=header+paletteBytes+masks;
  if(pixelBytes>length-minOffset)throw failure('BMP画素範囲');return {width,height,pixelBytes,minOffset};
}
function bmp(p) {
  const {u32,need,frame,done}=p;need(0,26);if(u32(2,true)!==p.bytes.length)throw failure('BMP file長');const offset=u32(10,true),size=u32(14,true);
  if(offset<14+size||offset>p.bytes.length)throw failure('BMP画素offset');const {width,height,pixelBytes,minOffset}=dib(p,14,p.bytes.length-14);if(offset<14+minOffset||pixelBytes>p.bytes.length-offset)throw failure('BMP画素範囲');frame(width,height);return done('bmp',width,height);
}
function ico(p) {
  const {bytes,u16,u32,need,step,frame,done}=p;need(0,6);const count=u16(4,true);if(!count||count>MAX_FRAMES)throw failure('ICO entry数');need(6,count*16);
  let width=0,height=0;
  for(let i=0;i<count;i++){
    step();const pos=6+i*16,w=bytes[pos]||256,h=bytes[pos+1]||256,size=u32(pos+8,true),offset=u32(pos+12,true);
    if(offset<6+count*16||!size)throw failure('ICO entry範囲');need(offset,size);
    const nested=bytes[offset]===137?png(p,offset,size):dib(p,offset,size,{icon:true});
    if(nested.encodedWidth&&nested.frameCount!==1)throw failure('ICOアニメーション');
    if((nested.encodedWidth??nested.width)!==w||(nested.encodedHeight??nested.height)!==h)throw failure('ICO内包寸法');frame(w,h);
    if(w*h>width*height){width=w;height=h;}
  }
  return done('ico',width,height,{embeddedImages:count});
}
function svg(p) {
  // Deliberately a tiny drawing language, not a sanitizer or a general SVG
  // renderer: root + at most 128 solid rectangles. Nothing is sent to SVG codecs.
  const {bytes,dims,frame,done}=p;if(bytes.length>65536)throw failure('SVG構文の上限');
  let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();}catch{throw failure('SVG文字コード');}
  if(/[&!?]|<!/.test(source))throw failure('未対応のSVG構文');
  const match=/^<svg\b([^>]*)>([\s\S]*)<\/svg\s*>$/.exec(source);if(!match)throw failure('未対応のSVG構造');
  const attributes=(text,allowed)=>{
    if(text.length>4096)throw failure('SVG属性の上限');const out={};let rest=text,count=0;
    while(rest.trim()){
      const m=/^\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if(!m||++count>12||!allowed.includes(m[1])||Object.hasOwn(out,m[1]))throw failure('未対応のSVG属性');out[m[1]]=m[2]??m[3];rest=rest.slice(m[0].length);
    }return out;
  };
  const root=attributes(match[1],['xmlns','width','height','viewBox']);if(root.xmlns&&root.xmlns!=='http://www.w3.org/2000/svg')throw failure('SVG namespace');
  const number=(value,fallback=0)=>{if(value==null)return fallback;if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||value.length>16)throw failure('SVG数値');const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>1e6)throw failure('SVG数値の上限');return n;};
  let box;if(root.viewBox){const values=root.viewBox.trim().split(/[ ,]+/);if(values.length!==4)throw failure('SVG viewBox');box=values.map(v=>number(v));if(box[2]<=0||box[3]<=0)throw failure('SVG viewBox');}
  const width=number(root.width,box?.[2]??0),height=number(root.height,box?.[3]??0);dims(width,height);box??=[0,0,width,height];
  let rest=match[2],rects=[];
  while(rest.trim()){
    const m=/^\s*<rect\b([^>]*)\/\s*>/.exec(rest);if(!m||rects.length>=128)throw failure('未対応のSVG要素');
    const a=attributes(m[1],['x','y','width','height','fill','opacity']);const size=(v,axis)=>v==='100%'?axis:number(v);
    const fill=a.fill??'black';if(!/^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|black|white|red|green|blue|yellow|gray|grey|transparent|none)$/.test(fill))throw failure('未対応のSVG色');
    const rect={x:number(a.x),y:number(a.y),width:size(a.width,box[2]),height:size(a.height,box[3]),fill,opacity:number(a.opacity,1)};
    if(rect.width<0||rect.height<0||rect.opacity<0||rect.opacity>1)throw failure('SVG矩形の範囲');rects.push(Object.freeze(rect));rest=rest.slice(m[0].length);
  }
  frame(width,height);return done('svg',width,height,{svgRects:Object.freeze(rects),viewBox:Object.freeze(box)});
}
export function inspectImageMetadata(value,limits={}) {
  const p=parser(value,limits),b=p.bytes;
  if(b.length>=8&&b[0]===137&&p.text(1,'PNG\r\n\x1a\n'))return png(p);
  if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return jpeg(p);
  if(b.length>=6&&(p.text(0,'GIF87a')||p.text(0,'GIF89a')))return gif(p);
  if(b.length>=12&&p.text(0,'RIFF')&&p.text(8,'WEBP'))return webp(p);
  if(b.length>=2&&p.text(0,'BM'))return bmp(p);
  if(b.length>=6&&p.u32(0,true)===65536)return ico(p);
  // BOM is accepted, while XML declarations/doctype and every general SVG
  // feature are deliberately unsupported by the static rectangle renderer.
  let i=0;if(b[0]===239&&b[1]===187&&b[2]===191)i=3;while(i<b.length&&[9,10,13,32].includes(b[i]))i++;
  if(b[i]===60&&b.length-i>=4&&p.text(i,'<svg'))return svg(p);
  throw failure('未知・未対応の画像形式');
}
export async function inspectImage(blob,limits={}) {
  if(!blob||!Number.isSafeInteger(blob.size)||blob.size<=0||blob.size>(limits.maxBytes??MAX_BYTES))throw failure('ファイル容量の上限');
  return inspectImageMetadata(await blob.arrayBuffer(),limits);
}
