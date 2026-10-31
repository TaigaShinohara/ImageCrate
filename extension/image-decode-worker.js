import {inspectImage} from './image-metadata.js';

// A fresh dedicated worker owns one job and is terminated on every terminal
// path by its caller. Original network Blobs never become HTMLImageElement src.
export async function renderStaticImage(blob, expected, options={}, environment=globalThis) {
  const metadata=await inspectImage(blob,{maxBytes:options.maxInputBytes??32*1024*1024,maxPixels:24_000_000,maxDimension:options.sourceMaxDimension??16384});
  if(metadata.format!==expected?.format||metadata.width!==expected.width||metadata.height!==expected.height||metadata.frameCount!==expected.frameCount||metadata.decodedPixels!==expected.decodedPixels)throw new Error('画像metadataが一致しません。');
  const type=({png:'image/png',jpg:'image/jpeg',webp:'image/webp'})[options.format??'png'];
  if(!type)throw new Error('対応していない出力形式です。');
  const max=options.maxDimension??16384;
  if(!Number.isSafeInteger(max)||max<1||max>16384)throw new Error('出力寸法が不正です。');
  const scale=Math.min(1,max/metadata.width,max/metadata.height),width=Math.max(1,Math.round(metadata.width*scale)),height=Math.max(1,Math.round(metadata.height*scale));
  let bitmap,canvas;
  try {
    if(typeof environment.OffscreenCanvas!=='function')throw new Error('このブラウザは安全な画像処理に対応していません。');
    canvas=new environment.OffscreenCanvas(width,height);const context=canvas.getContext('2d');if(!context)throw new Error('画像処理を開始できません。');
    if(type==='image/jpeg'){context.fillStyle='#ffffff';context.fillRect(0,0,width,height);}
    if(metadata.format==='svg'){
      const [x,y,w,h]=metadata.viewBox;context.scale(width/w,height/h);context.translate(-x,-y);
      for(const rect of metadata.svgRects){if(rect.fill==='none')continue;context.fillStyle=rect.fill;context.globalAlpha=rect.opacity;context.fillRect(rect.x,rect.y,rect.width,rect.height);}
      context.globalAlpha=1;
    } else {
      if(typeof environment.createImageBitmap!=='function')throw new Error('このブラウザは安全な画像処理に対応していません。');
      bitmap=await environment.createImageBitmap(blob,{imageOrientation:'from-image'});
      if(bitmap.width!==metadata.width||bitmap.height!==metadata.height)throw new Error('デコード寸法が一致しません。');
      context.drawImage(bitmap,0,0,width,height);bitmap.close();bitmap=null;
    }
    const output=await canvas.convertToBlob({type,quality:options.quality??0.92});
    if(!output||output.type!==type||!output.size||output.size>(options.maxOutputBytes??64*1024*1024))throw new Error('選んだ形式・容量で画像を作成できません。');
    return {blob:output,width:metadata.width,height:metadata.height,displayWidth:width,displayHeight:height};
  } finally {
    bitmap?.close();if(canvas){canvas.width=1;canvas.height=1;}
  }
}
if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope){
  self.onmessage=async event=>{
    const {id,blob,metadata,options}=event.data??{};
    try {self.postMessage({id,result:await renderStaticImage(blob,metadata,options)});}
    catch {self.postMessage({id,error:'この画像を安全に処理できませんでした。元の形式で保存できます。'});}
  };
}
