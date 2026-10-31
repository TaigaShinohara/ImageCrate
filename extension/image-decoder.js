// Every workspace and converter uses the same origin-wide Web Lock and ledger.
// Entries are conservative: a crashed owner can retain a reservation until its
// workspace is explicitly cleaned up. We never expire live work by wall clock.
const LEDGER_KEY='imagecrate.imageResources.v1';
export const IMAGE_RESOURCE_LIMITS=Object.freeze({encodedBytes:128*1024*1024,pixels:64_000_000,encodedCache:32*1024*1024,displayBytes:64*1024*1024,fetches:4});
const WORKSPACE_LIMITS=Object.freeze({encodedCache:16*1024*1024,displayBytes:32*1024*1024,fetches:2});
const FIELDS=Object.keys(IMAGE_RESOURCE_LIMITS);
const OWNER_UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PRODUCTION_OWNER=new RegExp(`^(${OWNER_UUID}):${OWNER_UUID}:(?:preview|conversion)$`,'i');
function workspaceScope(owner){
  // Production cleanup owners stay distinct per document/role. Only the known
  // session UUID : document UUID : preview|conversion shape shares a workspace
  // budget, including live reservations from an older document instance.
  const production=PRODUCTION_OWNER.exec(owner);
  return production?'workspace:'+production[1].toLowerCase():'owner:'+owner;
}
const abortError=signal=>signal?.reason instanceof Error?signal.reason:new DOMException('画像処理を停止しました。','AbortError');
function waitAbort(promise,signal){
  const pending=Promise.resolve(promise);pending.catch(()=>{});
  if(signal.aborted)return Promise.reject(abortError(signal));
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(abortError(signal));signal.addEventListener('abort',aborted,{once:true});
    pending.then(value=>{signal.removeEventListener('abort',aborted);signal.aborted?reject(abortError(signal)):resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
    if(signal.aborted)aborted();
  });
}
const unique=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`;
export function createImageResourceCoordinator({storage=globalThis.chrome?.storage?.session,locks=globalThis.navigator?.locks}={}){
  const transact=async change=>{
    if(!storage?.get||!storage?.set||!locks?.request)throw new Error('画像の共有リソース管理を利用できません。');
    return locks.request('imagecrate.imageResources.v1',{mode:'exclusive'},async()=>{
      const result=await storage.get(LEDGER_KEY),ledger=result?.[LEDGER_KEY]??{};
      if(!ledger||Array.isArray(ledger)||typeof ledger!=='object'||Object.keys(ledger).length>4096)throw new Error('画像リソース記録が不正です。');
      for(const record of Object.values(ledger)){
        if(!record||typeof record.owner!=='string'||FIELDS.some(key=>!Number.isSafeInteger(record[key]??0)||(record[key]??0)<0))throw new Error('画像リソース記録が不正です。');
      }
      const value=change(ledger);await storage.set({[LEDGER_KEY]:ledger});return value;
    });
  };
  return {
    async reserve(owner,amounts={}){
      if(typeof owner!=='string'||!owner||owner.length>256)throw new Error('画像処理の所有者が不明です。');
      for(const key of Object.keys(amounts))if(!FIELDS.includes(key)||!Number.isSafeInteger(amounts[key])||amounts[key]<0)throw new Error('画像リソース要求が不正です。');
      const id=unique(),scope=workspaceScope(owner);await transact(ledger=>{
        if(Object.hasOwn(ledger,id)||Object.keys(ledger).length>=2048)throw new Error('画像の処理数が上限に達しました。');
        for(const key of FIELDS){const global=Object.values(ledger).reduce((n,r)=>n+(r[key]??0),0),own=Object.values(ledger).reduce((n,r)=>n+(workspaceScope(r.owner)===scope?(r[key]??0):0),0),value=amounts[key]??0;
          if(global+value>IMAGE_RESOURCE_LIMITS[key]||WORKSPACE_LIMITS[key]!=null&&own+value>WORKSPACE_LIMITS[key])throw new Error('画像の共有リソース上限に達しました。ほかの画像を閉じてください。');
        }
        ledger[id]={owner,...amounts};
      });
      let released=false,held={...amounts},changing=0,operations=Promise.resolve();
      const mutate=task=>{
        changing++;const pending=operations.then(task);operations=pending.catch(()=>{});
        pending.then(()=>{changing--;},()=>{changing--;});return pending;
      };
      return {id,owner,get amounts(){return Object.freeze({...held});},covers(expectedOwner,field,bytes){return !released&&!changing&&owner===expectedOwner&&(held[field]??0)>=bytes;},
        shrink(next){
          if(!next||Array.isArray(next)||typeof next!=='object'||Object.keys(next).some(key=>!FIELDS.includes(key)||!Number.isSafeInteger(next[key])||next[key]<0))return Promise.reject(new Error('画像リソースの縮小が不正です。'));
          const target={...next};
          return mutate(async()=>{
            if(released)throw new Error('画像リソースの所有権が失効しました。');
            await transact(ledger=>{
              const current=ledger[id];
              if(!current||current.owner!==owner)throw new Error('画像リソースの所有権が失効しました。');
              if(Object.keys(target).some(key=>target[key]>(current[key]??0)))throw new Error('画像リソースの縮小が不正です。');
              ledger[id]={owner,...target};
            });held=target;
          });
        },
        release(){return mutate(async()=>{
          if(released)return;
          await transact(ledger=>{if(ledger[id]?.owner===owner)delete ledger[id];});
          held={};released=true;
        });}
      };
    },
    releaseLease(id,owner){
      if(typeof id!=='string'||!id||id.length>256||typeof owner!=='string'||!owner||owner.length>256)return Promise.reject(new Error('画像リソースの所有者が不明です。'));
      return transact(ledger=>{if(!Object.hasOwn(ledger,id)||ledger[id].owner!==owner)return false;delete ledger[id];return true;});
    },
    releaseOwner(owner){return transact(ledger=>{for(const [id,record]of Object.entries(ledger))if(record.owner===owner)delete ledger[id];});},
    snapshot(){return transact(ledger=>structuredClone(ledger));}
  };
}
let sharedCoordinator;
export const imageResourceCoordinator=()=>sharedCoordinator??=createImageResourceCoordinator();
export async function withImageCodecLock(callback,{signal,locks=globalThis.navigator?.locks}={}){
  if(signal?.aborted)throw abortError(signal);
  if(!locks?.request)throw new Error('このブラウザは安全な画像処理に対応していません。');
  return locks.request('imagecrate.imageCodec.v1',{mode:'exclusive',...(signal?{signal}:{})},async()=>{if(signal?.aborted)throw abortError(signal);return callback();});
}
export async function decodeStaticImage(blob,metadata,{
  format='png',maxDimension=16384,signal,deadline=Date.now()+20000,quality=0.92,ownerId=`codec-${unique()}`,
  maxInputBytes=32*1024*1024,maxOutputBytes=64*1024*1024,sourceMaxDimension=16384,sourceReservation,
  coordinator=imageResourceCoordinator(),locks=globalThis.navigator?.locks,
  workerFactory=()=>new Worker(new URL('./image-decode-worker.js',import.meta.url),{type:'module'})
}={}){
  if(signal?.aborted)throw abortError(signal);
  if(!(blob instanceof Blob)||!blob.size||blob.size>maxInputBytes||!metadata||!Number.isSafeInteger(metadata.width)||!Number.isSafeInteger(metadata.height)||metadata.width<1||metadata.height<1||metadata.width*metadata.height>24_000_000||!Number.isSafeInteger(metadata.decodedPixels)||metadata.decodedPixels<metadata.width*metadata.height||metadata.decodedPixels>64_000_000||metadata.width>sourceMaxDimension||metadata.height>sourceMaxDimension)throw new Error('画像の事前検査が必要です。');
  const controller=new AbortController(),stopped=()=>controller.abort(abortError(signal));signal?.addEventListener('abort',stopped,{once:true});
  const check=()=>{
    if(!Number.isFinite(deadline)||Date.now()>=deadline){if(!controller.signal.aborted)controller.abort(new DOMException('画像処理の期限を超えました。','TimeoutError'));}
    if(controller.signal.aborted)throw abortError(controller.signal);
  };
  let timer,reservation,transferred=false,finished=false;
  const releaseReservation=()=>{if(reservation){const owned=reservation;reservation=null;void Promise.resolve(owned.release()).catch(()=>{});}};
  try {
    check();
    timer=setTimeout(()=>controller.abort(new DOMException('画像処理の期限を超えました。','TimeoutError')),Math.min(deadline-Date.now(),2147483647));
    const result=await withImageCodecLock(async()=>{
      check();
      // Count source Blob + validation ArrayBuffer and output allowance and
      // source/canvas pixels. Browser native copies are outside this application
      // accounting; it is not an RSS guarantee.
      const target=Math.min(1,maxDimension/metadata.width,maxDimension/metadata.height);
      const targetPixels=Math.max(1,Math.round(metadata.width*target))*Math.max(1,Math.round(metadata.height*target));
      const credited=sourceReservation?.covers?.(ownerId,'encodedBytes',blob.size*2)?blob.size*2:0;
      const acquiring=Promise.resolve().then(()=>{
        check();return coordinator.reserve(ownerId,{encodedBytes:blob.size*2-credited+maxOutputBytes,pixels:metadata.decodedPixels+targetPixels});
      }).then(value=>{
        // Fulfillment establishes ownership before the cancellable wait checks
        // its signal/deadline. A late reservation is released by this handler.
        reservation=value;
        try {check();if(finished)throw new DOMException('画像処理を停止しました。','AbortError');}
        catch(error){releaseReservation();throw error;}
        return value;
      });
      await waitAbort(acquiring,controller.signal);check();
      return new Promise((resolve,reject)=>{
        let worker,settled=false;
        const finish=(error,result)=>{
          if(settled)return;settled=true;controller.signal.removeEventListener('abort',aborted);
          if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
          error?reject(error):resolve(result);
        };
        const aborted=()=>finish(abortError(controller.signal));controller.signal.addEventListener('abort',aborted,{once:true});
        try {
          check();worker=workerFactory();
          worker.onerror=()=>finish(new Error('画像処理を開始できませんでした。'));
          worker.onmessageerror=()=>finish(new Error('画像処理の応答を確認できませんでした。'));
          worker.onmessage=event=>{
            try {
              check();
              const {result,error}=event.data??{};if(error)return finish(new Error('この画像を安全に処理できませんでした。元の形式で保存できます。'));
              const mime=({png:'image/png',jpg:'image/jpeg',webp:'image/webp'})[format];
              const scale=Math.min(1,maxDimension/metadata.width,maxDimension/metadata.height);
              if(!(result?.blob instanceof Blob)||result.blob.type!==mime||!result.blob.size||result.blob.size>maxOutputBytes||result.width!==metadata.width||result.height!==metadata.height||result.displayWidth!==Math.max(1,Math.round(metadata.width*scale))||result.displayHeight!==Math.max(1,Math.round(metadata.height*scale)))return finish(new Error('画像処理の出力が不正です。'));
              check();finish(null,result);
            }catch(error){finish(error);}
          };
          check();worker.postMessage({id:unique(),blob,metadata,options:{format,maxDimension,quality,maxInputBytes,maxOutputBytes,sourceMaxDimension}});
          check();
        } catch(error){finish(controller.signal.aborted?abortError(controller.signal):new Error('このブラウザは安全な画像処理に対応していません。'));}
      });
    },{signal:controller.signal,locks});
    check();
    await waitAbort(reservation.shrink({encodedBytes:result.blob.size}),controller.signal);
    check();
    const outputReservation=reservation;
    transferred=true;
    return {...result,resourceLease:Object.freeze({id:outputReservation.id,owner:outputReservation.owner}),release:()=>outputReservation.release()};
  } finally {
    finished=true;clearTimeout(timer);signal?.removeEventListener('abort',stopped);
    // Shrink/release serialize on each lease. A pending ledger operation cannot
    // recreate a released record; a failed cleanup keeps conservative accounting.
    if(!transferred)releaseReservation();
  }
}
