import {MEDIA_LIMITS} from './media-limits.js';
import {createMediaOperation,readMediaBlob} from './media-reader.js';
import {inspectImage} from './image-metadata.js';
import {decodeStaticImage,imageResourceCoordinator} from './image-decoder.js';

export const MAX_SOURCE_BYTES=MEDIA_LIMITS.converter.maxInputBytes;
export const MAX_OUTPUT_BYTES=MEDIA_LIMITS.converter.maxOutputBytes;
export const MAX_PIXELS=MEDIA_LIMITS.converter.maxPixels;
export const MAX_DIMENSION=MEDIA_LIMITS.converter.maxDimension;
const MIME={jpg:'image/jpeg',png:'image/png',webp:'image/webp'};
const forget=promise=>{try{Promise.resolve(promise).catch(()=>{});}catch{}};
function checkDimensions(width,height,required=false){
  if(width>MAX_DIMENSION||height>MAX_DIMENSION||width>0&&height>0&&width*height>MAX_PIXELS)throw new Error('変換できる画像は2400万画素以下、縦横それぞれ16384px以下です。元の形式で保存してください。');
  if(required&&(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0))throw new Error('画像の寸法を読み取れませんでした。元の形式で保存してください。');
}

// The result owns its encoded-output lease until the caller finishes its file
// write or Chrome reports the Blob download terminal. Never decode the original
// Blob into a page Image element, including SVG and animation fallback paths.
export async function convertImage(url,format,{
  signal,onProgress,onBytes,knownWidth,knownHeight,fetchImpl=fetch,operation,deadline,
  maxInputBytes=MAX_SOURCE_BYTES,maxOutputBytes=MAX_OUTPUT_BYTES,ownerId='conversion-'+crypto.randomUUID(),
  coordinator=imageResourceCoordinator(),inspectImpl=inspectImage,decodeImpl=decodeStaticImage
}={}){
  const mime=Object.hasOwn(MIME,format)?MIME[format]:null;
  if(!mime)throw new Error('対応していない保存形式です。JPEG・PNG・WebPから選んでください。');
  checkDimensions(knownWidth,knownHeight);
  const inputLimit=Math.min(MAX_SOURCE_BYTES,Math.floor(maxInputBytes));
  const outputLimit=Math.min(MAX_OUTPUT_BYTES,Math.floor(maxOutputBytes));
  if(!Number.isSafeInteger(inputLimit)||inputLimit<1)throw new Error('画像の受信量の上限が不正です。');
  if(!Number.isSafeInteger(outputLimit)||outputLimit<1)throw new Error('変換画像の容量上限が不正です。');
  const ownOperation=!operation;
  operation??=createMediaOperation({signal,deadline,timeoutMs:MEDIA_LIMITS.converter.timeoutMs});
  let sourceLease,inspection,inspectionPending=false,decoding,decodePending=false,result,transferred=false,finished=false,received=0;
  const releaseSource=()=>{if(sourceLease){const lease=sourceLease;sourceLease=null;forget(lease.release());}};
  try{
    operation.check();
    const acquiring=Promise.resolve(coordinator.reserve(ownerId,{encodedBytes:inputLimit*2})).then(lease=>{
      // Own a fulfilled lease before operation.wait performs its deadline
      // check. The UI may already have stopped waiting for this reservation.
      sourceLease=lease;
      try { operation.check(); if(finished)throw new DOMException('変換を停止しました。','AbortError'); }
      catch(error){releaseSource();throw error;}
      return lease;
    });
    await operation.wait(acquiring);operation.check();
    const source=await readMediaBlob(url,{fetchImpl,operation,maxBytes:inputLimit,onProgress,onBytes:async progress=>{
      received=progress.bytesReceived;
      if(onBytes)await onBytes(progress);
    }});
    received=source.bytesReceived;operation.check();
    await operation.wait(sourceLease.shrink?.({encodedBytes:source.blob.size*2}));
    inspectionPending=true;
    inspection=Promise.resolve().then(()=>inspectImpl(source.blob,{maxBytes:inputLimit,maxPixels:MAX_PIXELS,maxDimension:MAX_DIMENSION}));
    inspection.finally(()=>{inspectionPending=false;if(operation.signal.aborted)releaseSource();}).catch(()=>{});
    const metadata=await operation.wait(inspection);
    checkDimensions(metadata.width,metadata.height,true);operation.check();
    decodePending=true;
    decoding=Promise.resolve(decodeImpl(source.blob,metadata,{format,maxDimension:MAX_DIMENSION,
      sourceMaxDimension:MAX_DIMENSION,maxInputBytes:inputLimit,maxOutputBytes:outputLimit,
      quality:0.92,signal:operation.signal,deadline:operation.deadline,ownerId,sourceReservation:sourceLease})).then(output=>{
      result=output;
      try { operation.check(); if(finished)throw new DOMException('変換を停止しました。','AbortError'); }
      catch(error){result=null;forget(output?.release?.());throw error;}
      return output;
    });
    decoding.finally(()=>{decodePending=false;}).catch(()=>{});
    await operation.wait(decoding);
    operation.check();
    if(!(result?.blob instanceof Blob)||result.blob.type!==mime||!result.blob.size||result.blob.size>outputLimit
      ||result.width!==metadata.width||result.height!==metadata.height)throw new Error('選んだ形式で画像を作成できませんでした。元の形式で保存できます。');
    const outputResult=result,output=result.blob;let released=false;
    Object.defineProperties(output,{
      sourceBytes:{value:received},
      resourceLease:{value:outputResult.resourceLease},
      releaseResources:{value:()=>{if(released)return;released=true;return outputResult.release?.();}}
    });
    transferred=true;return output;
  }catch(error){
    if(error instanceof TypeError){const safe=new Error('画像を取得できませんでした。接続・サイトの認証・配信元へのアクセス許可を確認してください。');safe.bytesReceived=error.bytesReceived??received;throw safe;}
    try{error.bytesReceived=Math.max(error.bytesReceived||0,received);}catch{}
    throw error;
  }finally{
    finished=true;
    // A native ArrayBuffer read has no cancellation API. Its lease remains
    // charged until actual inspection settles, even after UI cancellation.
    const pending=[...(inspectionPending?[inspection]:[]),...(decodePending?[decoding]:[])];
    if(!pending.length)releaseSource();
    else Promise.allSettled(pending).then(releaseSource);
    if(!transferred&&result)forget(result.release?.());
    if(ownOperation)operation.dispose();
  }
}
