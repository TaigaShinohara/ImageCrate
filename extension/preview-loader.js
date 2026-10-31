import {allowedURL} from './utils.js';
import {readMediaBlob,createMediaOperation} from './media-reader.js';
import {inspectImage} from './image-metadata.js';
import {decodeStaticImage,imageResourceCoordinator} from './image-decoder.js';

const MIB=1024*1024;
export const PREVIEW_LIMITS=Object.freeze({maxBytes:8*MIB,maxPixels:24_000_000,maxDimension:8192,timeoutMs:20000,queueEntries:64,cacheEntries:64,encodedCache:16*MIB,displayBytes:32*MIB,totalBytes:256*MIB});
const abortError=signal=>signal?.reason instanceof Error?signal.reason:new DOMException('プレビューを停止しました。','AbortError');
const unique=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`;
export function previewHost(value){
  if(typeof value!=='string'||value.length>131072)throw new Error('画像の取得先を確認できません。');
  if(/^data:/i.test(value)){if(!allowedURL(value,'images'))throw new Error('この埋め込み画像のプレビューには対応していません。');return {key:'data:embedded',label:'ページに埋め込まれた画像',pattern:null,isEmbedded:true};}
  let url;try{url=new URL(value);}catch{throw new Error('画像の取得先を確認できません。');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname||url.hostname.includes('*'))throw new Error('この取得先のプレビューには対応していません。');
  return {key:`${url.protocol}//${url.hostname}`,label:`${url.protocol}//${url.hostname}${url.port?`:${url.port}`:''}`,pattern:`${url.protocol}//${url.hostname}/*`,isEmbedded:false};
}
// Shared by managed source transfers and previews. Fulfillment establishes
// ownership before the cancellable wait checks its deadline; a late ledger
// result can therefore never orphan a fetch slot or authorize a late request.
export async function acquireMediaFetchLease(operation,ownerId,{coordinator=imageResourceCoordinator()}={}){
  let owned,claimed=false,finished=false;
  const releaseOwned=()=>{
    if(!owned)return Promise.resolve();const lease=owned;owned=null;
    try{return Promise.resolve(lease.release());}catch(error){return Promise.reject(error);}
  };
  try{
    operation.check();
    const acquiring=Promise.resolve().then(()=>{operation.check();return coordinator.reserve(ownerId,{fetches:1});}).then(lease=>{
      owned=lease;
      try{operation.check();if(finished)throw new DOMException('画像の取得を停止しました。','AbortError');}
      catch(error){void releaseOwned().catch(()=>{});throw error;}
      return lease;
    });
    await operation.wait(acquiring);operation.check();
    const lease=owned;let releasing;
    const result=Object.freeze({id:lease.id,owner:lease.owner,
      release(resourcesSettled){
        // An original writer can reject its UI result while native write/abort
        // still owns source chunks. Every release call shares that first tail.
        return releasing??=Promise.resolve(resourcesSettled).catch(()=>{}).then(()=>lease.release());
      }
    });
    claimed=true;return result;
  }finally{
    finished=true;if(!claimed)void releaseOwned().catch(()=>{});
  }
}
export function createPreviewController({ownerId=`preview-${unique()}`,permissions=globalThis.chrome?.permissions,
  fetchImpl=globalThis.fetch,decodeImpl=decodeStaticImage,inspectImpl=inspectImage,readerImpl=readMediaBlob,
  coordinator=imageResourceCoordinator(),onInvalidate=()=>{},createObjectURL=blob=>URL.createObjectURL(blob),revokeObjectURL=url=>URL.revokeObjectURL(url)
}={}){
  let generation=0,disposed=false,active=0,checking=0,totalBytes=0,cacheEncoded=0,cacheDisplay=0;
  const consent=new Set(),epochs=new Map(),queue=[],running=new Set(),cache=new Map(),failures=new Map(),pending=new Map(),lingeringResources=new Set();
  const hostEpoch=key=>epochs.get(key)??0;
  const forgetJob=job=>{if(pending.get(job.key)===job)pending.delete(job.key);};
  const current=job=>!disposed&&job.generation===generation&&job.epoch===hostEpoch(job.host.key)&&consent.has(job.host.key)&&!job.controller.signal.aborted;
  const notify=host=>{try{onInvalidate(host);}catch{}};
  const dropEntry=entry=>{
    if(entry.dropped)return;entry.dropped=true;cache.delete(entry.key);cacheEncoded-=entry.encodedBytes;cacheDisplay-=entry.displayBytes;
    if(entry.url){revokeObjectURL(entry.url);entry.url='';}entry.source=null;entry.output=null;entry.result=null;entry.metadata=null;
    // Any failure keeps conservative shared accounting; cleanup is retried by
    // dispose.releaseOwner after every active operation has settled.
    void Promise.allSettled(entry.reservations.map(r=>r.release()));
  };
  const trim=(encoded=0,display=0,entries=1)=>{
    for(const entry of cache.values()){
      if(cacheEncoded+encoded<=PREVIEW_LIMITS.encodedCache&&cacheDisplay+display<=PREVIEW_LIMITS.displayBytes&&cache.size+entries<=PREVIEW_LIMITS.cacheEntries)break;
      if(!entry.refs)dropEntry(entry);
    }
    if(cacheEncoded+encoded>PREVIEW_LIMITS.encodedCache||cacheDisplay+display>PREVIEW_LIMITS.displayBytes||cache.size+entries>PREVIEW_LIMITS.cacheEntries)throw new Error('表示中の画像が上限に達しました。画像を閉じてください。');
  };
  const handle=entry=>{
    if(entry.dropped)throw new DOMException('古いプレビューです。','AbortError');if(!entry.url)entry.url=createObjectURL(entry.output);entry.refs++;cache.delete(entry.key);cache.set(entry.key,entry);let released=false;
    return {url:entry.url,width:entry.metadata.width,height:entry.metadata.height,displayWidth:entry.result.displayWidth,displayHeight:entry.result.displayHeight,release(){if(released)return;released=true;entry.refs=Math.max(0,entry.refs-1);if(!entry.refs&&entry.url){revokeObjectURL(entry.url);entry.url='';}}};
  };
  const invalidateHost=(key,{clearConsent=true}={})=>{
    epochs.set(key,hostEpoch(key)+1);if(clearConsent)consent.delete(key);
    for(const job of [...queue,...running])if(job.host.key===key){
      job.controller.abort(new DOMException('配信元のプレビュー許可が取り消されました。','AbortError'));
      const index=queue.indexOf(job);if(index>=0){queue.splice(index,1);forgetJob(job);job.completed=true;job.reject(abortError(job.controller.signal));}
    }
    for(const entry of [...cache.values()])if(entry.host.key===key)dropEntry(entry);
    for(const [keyValue,value]of failures)if(value.host===key)failures.delete(keyValue);
    notify(key);
  };
  const verify=async job=>{
    if(!current(job))throw abortError(job.controller.signal);
    if(job.host.isEmbedded)return;
    if(!permissions?.contains||!await permissions.contains({origins:[job.host.pattern]})){
      invalidateHost(job.host.key);throw new Error('画像の配信元へのアクセス許可が必要です。');
    }
    if(!current(job))throw abortError(job.controller.signal);
  };
  async function execute(job){
    const operation=createMediaOperation({signal:job.controller.signal,deadline:job.deadline,timeoutMs:PREVIEW_LIMITS.timeoutMs,idleTimeoutMs:PREVIEW_LIMITS.timeoutMs});
    const reservations=[];let source,result,sourceLease,inspection,inspectionSettled=true,decoding,decodeSettled=true,finished=false,chargedBytes=0;
    const acquire=amounts=>operation.wait(coordinator.reserve(ownerId,amounts).then(lease=>{
      if(operation.signal.aborted){void lease.release().catch(()=>{});throw abortError(operation.signal);}
      reservations.push(lease);return lease;
    }));
    try {
      await operation.wait(verify(job));
      await acquire({fetches:1});
      await operation.wait(verify(job));operation.check();
      const budget=PREVIEW_LIMITS.totalBytes-totalBytes;if(budget<=0)throw new Error('この作業ページのプレビュー取得量が上限に達しました。');
      // Reserve worst-case source bytes before the network can retain chunks.
      const receiveLease=await acquire({encodedBytes:Math.min(PREVIEW_LIMITS.maxBytes,budget)*2});sourceLease=receiveLease;
      const sourceResult=await readerImpl(job.url,{fetchImpl,operation,maxBytes:Math.min(PREVIEW_LIMITS.maxBytes,budget),onBytes:({chunkBytes:bytes})=>{
        // Called by the reader only for bytes it is about to accept. Cumulative
        // accounting is never reset on a view change or a refused retry.
        if(!Number.isSafeInteger(bytes)||bytes<0||totalBytes+bytes>PREVIEW_LIMITS.totalBytes)throw new Error('この作業ページのプレビュー取得量が上限に達しました。');totalBytes+=bytes;chargedBytes+=bytes;
      }});
      source=sourceResult.blob;await operation.wait(verify(job));operation.check();
      inspectionSettled=false;
      inspection=Promise.resolve(inspectImpl(source,{maxBytes:PREVIEW_LIMITS.maxBytes,maxPixels:PREVIEW_LIMITS.maxPixels,maxDimension:PREVIEW_LIMITS.maxDimension})).then(value=>{inspectionSettled=true;return value;},error=>{inspectionSettled=true;throw error;});
      const metadata=await operation.wait(inspection);
      await operation.wait(verify(job));operation.check();
      const max=job.kind==='viewer'?2048:384,maxOutputBytes=job.kind==='viewer'?16*MIB:2*MIB;
      decodeSettled=false;
      decoding=Promise.resolve(decodeImpl(source,metadata,{format:'png',maxDimension:max,maxInputBytes:PREVIEW_LIMITS.maxBytes,maxOutputBytes,sourceMaxDimension:PREVIEW_LIMITS.maxDimension,signal:operation.signal,deadline:operation.deadline,ownerId,sourceReservation:receiveLease})).then(output=>{
        // Own fulfillment before the cancellable wait performs its own absolute
        // deadline check. Late output cannot outlive this job unaccounted.
        result=output;
        try{operation.check();if(finished||!current(job))throw abortError(job.controller.signal);return output;}
        catch(error){result=null;if(output?.release)void Promise.resolve(output.release()).catch(()=>{});throw error;}
      });
      decoding.finally(()=>{decodeSettled=true;}).catch(()=>{});
      await operation.wait(decoding);
      await operation.wait(verify(job));operation.check();
      if(!(result?.blob instanceof Blob)||result.blob.type!=='image/png'||!result.blob.size||result.blob.size>maxOutputBytes||result.width!==metadata.width||result.height!==metadata.height||!Number.isSafeInteger(result.displayWidth)||!Number.isSafeInteger(result.displayHeight)||result.displayWidth<1||result.displayHeight<1||result.displayWidth>max||result.displayHeight>max)throw new Error('プレビューの出力を確認できません。');
      const encodedBytes=source.size+result.blob.size,displayBytes=result.displayWidth*result.displayHeight*4;
      trim(encodedBytes,displayBytes);
      const cacheLease=await acquire({encodedCache:encodedBytes,displayBytes});
      await operation.wait(verify(job));operation.check();
      if(!current(job))throw abortError(job.controller.signal);
      const entry={key:job.key,host:job.host,generation,source,output:result.blob,result,metadata,url:'',encodedBytes,displayBytes,refs:0,dropped:false,reservations:[cacheLease]};
      cache.set(job.key,entry);cacheEncoded+=encodedBytes;cacheDisplay+=displayBytes;
      reservations.pop();return entry;
    } catch(error) {
      if(Number.isSafeInteger(error?.bytesReceived)&&error.bytesReceived>chargedBytes)totalBytes=Math.min(Number.MAX_SAFE_INTEGER,totalBytes+error.bytesReceived-chargedBytes);
      throw error;
    } finally {
      finished=true;operation.dispose();if(result?.release)void Promise.resolve(result.release()).catch(()=>{});source=null;result=null;
      const immediate=reservations.filter(reservation=>reservation!==sourceLease);
      void Promise.allSettled(immediate.map(reservation=>reservation.release()));
      if(sourceLease){
        const tails=[...(inspection&&!inspectionSettled?[inspection]:[]),...(decoding&&!decodeSettled?[decoding]:[])];
        if(tails.length){
          // ArrayBuffer inspection and a codec's ledger acquisition may remain
          // unsettled after UI cancellation. Their actual source ownership is
          // retained until both promises finish, including late output cleanup.
          const cleanup=Promise.allSettled(tails).then(()=>sourceLease.release()).catch(()=>{});
          lingeringResources.add(cleanup);cleanup.then(()=>lingeringResources.delete(cleanup));
        }else void sourceLease.release().catch(()=>{});
      }
    }
  }
  const pump=()=>{
    while(active<2&&queue.length){
      const job=queue.shift();if(!current(job)){forgetJob(job);job.completed=true;job.reject(abortError(job.controller.signal));continue;}
      active++;running.add(job);
      execute(job).then(entry=>{job.completed=true;job.resolve(entry);},error=>{job.completed=true;if(current(job)){if(failures.size>=64)failures.delete(failures.keys().next().value);failures.set(job.key,{host:job.host.key,error});}job.reject(error);}).finally(()=>{active--;running.delete(job);forgetJob(job);pump();});
    }
  };
  const cancelUnused=job=>{
    if(job.consumers||job.completed)return;
    job.controller.abort(new DOMException('表示する画像がなくなりました。','AbortError'));
    forgetJob(job);
    const index=queue.indexOf(job);
    if(index>=0){queue.splice(index,1);job.completed=true;job.reject(abortError(job.controller.signal));pump();}
  };
  const permissionRemoved=removed=>{
    if(!removed?.origins?.length)return;
    // Stop and clear display/cache synchronously with the removal event. A
    // permission query is asynchronous, so waiting for it would leave old
    // output visible and a queued operation eligible to start. Conservatively
    // invalidate every consented host, then query each concrete grant. This
    // also handles broad Chrome patterns without duplicating its matcher.
    for(const key of [...consent]){
      if(key==='data:embedded')continue;
      invalidateHost(key,{clearConsent:false});
      const epoch=hostEpoch(key),host=previewHost(key);
      Promise.resolve().then(()=>permissions.contains({origins:[host.pattern]})).then(allowed=>{
        if(!allowed&&hostEpoch(key)===epoch){consent.delete(key);notify(key);}
      },()=>{if(hostEpoch(key)===epoch){consent.delete(key);notify(key);}});
    }
  };
  permissions?.onRemoved?.addListener(permissionRemoved);
  const controller={
    // Called synchronously from the real user's button click. A saved Chrome
    // host grant never establishes this separate workspace consent on its own.
    grantHost(value){
      if(disposed)return Promise.reject(new DOMException('作業ページを閉じました。','AbortError'));
      let host;try{host=previewHost(value);}catch(error){return Promise.reject(error);}
      if(host.isEmbedded){consent.add(host.key);for(const [key,error]of failures)if(error.host===host.key)failures.delete(key);return Promise.resolve(true);}
      if(!permissions?.request)return Promise.reject(new Error('Chromeの配信元許可を利用できません。'));
      const epoch=hostEpoch(host.key);let requested;
      try{requested=permissions.request({origins:[host.pattern]});}catch{return Promise.reject(new Error('配信元へのアクセスを許可できませんでした。'));}
      return Promise.resolve(requested).then(allowed=>{
        if(disposed||epoch!==hostEpoch(host.key))return false;
        if(!allowed){invalidateHost(host.key);return false;}
        if(!consent.has(host.key)&&consent.size>=128)throw new Error('プレビュー配信元の数が上限に達しました。');consent.add(host.key);for(const [key,error]of failures)if(error.host===host.key)failures.delete(key);return true;
      });
    },
    load(url,{kind='thumbnail',signal}={}){
      if(disposed)return Promise.reject(new DOMException('作業ページを閉じました。','AbortError'));
      let host;try{host=previewHost(url);}catch(error){return Promise.reject(error);}
      if(!consent.has(host.key))return Promise.reject(new Error('「プレビューを表示」から許可してください。'));
      if(signal?.aborted)return Promise.reject(abortError(signal));
      if(!['thumbnail','viewer'].includes(kind))return Promise.reject(new Error('プレビュー種別が不正です。'));
      const key=`${generation}:${hostEpoch(host.key)}:${kind}:${url}`;
      if(failures.has(key))return Promise.reject(failures.get(key).error);
      // Permission is also checked for cache hits, and again before execution.
      if(checking>=PREVIEW_LIMITS.queueEntries)return Promise.reject(new Error('プレビューの待機数が上限に達しました。'));
      checking++;const permissionOperation=createMediaOperation({signal,timeoutMs:PREVIEW_LIMITS.timeoutMs});
      const permissionCheck=permissionOperation.wait(Promise.resolve().then(()=>host.isEmbedded||permissions?.contains?.({origins:[host.pattern]}))).finally(()=>{checking--;permissionOperation.dispose();});
      return permissionCheck.then(allowed=>{
        if(!allowed){invalidateHost(host.key);throw new Error('画像の配信元へのアクセス許可が必要です。');}
        if(disposed||!consent.has(host.key)||key!==`${generation}:${hostEpoch(host.key)}:${kind}:${url}`)throw new DOMException('古いプレビューです。','AbortError');
        if(signal?.aborted)throw abortError(signal);
        const cached=cache.get(key);if(cached)return handle(cached);
        let job=pending.get(key);
        if(!job){
          if(queue.length+running.size>=PREVIEW_LIMITS.queueEntries)throw new Error('プレビューの待機数が上限に達しました。');
          const controller=new AbortController();job={key,url,host,kind,generation,deadline:permissionOperation.deadline,epoch:hostEpoch(host.key),controller,consumers:0,completed:false};
          job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});pending.set(key,job);queue.push(job);
        }
        job.consumers++;
        const waiting=new Promise((resolve,reject)=>{
          let settled=false;
          const detach=()=>{job.consumers=Math.max(0,job.consumers-1);signal?.removeEventListener('abort',stop);};
          const stop=()=>{if(settled)return;settled=true;detach();reject(abortError(signal));cancelUnused(job);};
          signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
          job.promise.then(entry=>{
            if(settled)return;if(signal?.aborted)return stop();settled=true;detach();
            try{resolve(handle(entry));}catch(error){reject(error);}
          },error=>{if(settled)return;settled=true;detach();reject(error);});
        });
        pump();return waiting;
      });
    },
    revokeHost(value){let key;try{key=previewHost(value).key;}catch{return;}invalidateHost(key);},
    invalidate(){
      generation++;for(const job of [...queue,...running])job.controller.abort(new DOMException('表示対象が変わりました。','AbortError'));
      while(queue.length){const job=queue.shift();forgetJob(job);job.completed=true;job.reject(abortError(job.controller.signal));}
      for(const entry of [...cache.values()])dropEntry(entry);failures.clear();
    },
    async dispose(){
      if(disposed)return;disposed=true;controller.invalidate();consent.clear();permissions?.onRemoved?.removeListener(permissionRemoved);
      await Promise.allSettled([...new Set([...pending.values(),...running])].map(job=>job.promise));await Promise.allSettled([...lingeringResources]);await coordinator.releaseOwner(ownerId);
    },
    stats(){return {generation,queued:queue.length,active,cacheEntries:cache.size,encodedBytes:cacheEncoded,displayBytes:cacheDisplay,totalBytes,consentedHosts:consent.size};}
  };
  return controller;
}
