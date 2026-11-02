// A small stateless metadata probe, serialized into the source tab. It never
// touches collect()'s cursor, registry, observers, or image/codec resources.
export function previewPermissionHosts(expectedURL) {
  const MAX_URL=131072,started=performance.now(),origins=new Set();
  const sourceURL=document.URL||location.href;
  if(typeof expectedURL!=='string'||expectedURL.length>MAX_URL||sourceURL!==expectedURL)return null;
  let source;try{source=new URL(sourceURL);}catch{return null;}
  if(!['http:','https:'].includes(source.protocol)||source.username||source.password)return null;
  let nodes=0,attempts=0,chars=0,limited=false;
  const walker=document.createTreeWalker(document,1);
  while(nodes<12000&&attempts<500&&chars<131072&&origins.size<128){
    if(performance.now()-started>=25){limited=true;break;}
    const image=walker.nextNode();if(!image)break;nodes++;
    if(image.tagName!=='IMG')continue;
    const base=image.ownerDocument?.baseURI;
    if(typeof base!=='string'||base.length>MAX_URL)continue;
    for(const value of [image.currentSrc,...['src','data-src','data-original','data-lazy-src'].map(name=>image.getAttribute(name))]){
      if(typeof value!=='string'||!value)continue;
      if(attempts>=500||chars+value.length>131072||origins.size>=128){limited=true;break;}
      attempts++;chars+=value.length;
      if(value.length>MAX_URL)continue;
      try{
        const url=new URL(value,base);
        if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hostname.includes('*')&&url.origin!==source.origin)origins.add(url.origin);
      }catch{/* Ignore an invalid source attribute. */}
    }
  }
  if((document.URL||location.href)!==expectedURL)return null;
  return {sourceURL,origins:[...origins],limited:limited||nodes>=12000||attempts>=500||chars>=131072||origins.size>=128};
}

const concreteURL=value=>{
  if(typeof value!=='string'||value.length>131072)throw new Error('取得元を確認できません。');
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname||url.hostname.includes('*'))throw new Error('取得元を確認できません。');
  return url;
};
const covered=(pattern,url)=>{
  if(pattern==='<all_urls>')return true;
  const match=/^(https?|\*):\/\/([^/]+)\/.*$/.exec(pattern);
  return Boolean(match&&(match[1]==='*'||`${match[1]}:`===url.protocol)&&(match[2]==='*'||match[2]===url.hostname
    ||match[2].startsWith('*.')&&(url.hostname===match[2].slice(2)||url.hostname.endsWith(match[2].slice(1)))));
};
export function startupPreviewOrigins(result,sourceURL,granted){
  const source=concreteURL(sourceURL);
  if(result?.sourceURL!==sourceURL||!Array.isArray(result.origins)||result.origins.length>128||!Array.isArray(granted)||granted.length>4096)throw new Error('取得元を確認できません。');
  const patterns=new Set();
  for(const value of result.origins){
    const url=concreteURL(value);
    if(value!==url.origin)throw new Error('配信元を確認できません。');
    if(url.origin!==source.origin&&!granted.some(pattern=>typeof pattern==='string'&&covered(pattern,url)))patterns.add(`${url.protocol}//${url.hostname}/*`);
  }
  return [...patterns];
}

// Callback APIs here are intentional: Chrome 116 restores the action's gesture
// for the native callback, but not for a Promise/await continuation of that API.
export function createPreviewStartup({api=globalThis.chrome,onOpen,onError=()=>{},timeoutMs=5000}={}){
  const flights=new Map();let permissionPending=false;
  const open=tab=>{try{Promise.resolve(onOpen(tab)).catch(onError);}catch(error){onError(error);}};
  const invalidate=tabId=>{const entry=flights.get(tabId);if(entry){entry.stale=true;clearTimeout(entry.timer);}};
  api.tabs.onUpdated?.addListener((tabId,change)=>{if(change.url||change.status==='loading')invalidate(tabId);});
  api.tabs.onRemoved.addListener(tabId=>{invalidate(tabId);flights.delete(tabId);});
  return {
    open(tab){
      if(flights.has(tab.id))return;
      try{concreteURL(tab.url);}catch{open(tab);return;}
      if(tab.status==='loading'||flights.size>=4||permissionPending||!api.permissions?.getAll||!api.permissions?.request){open(tab);return;}
      const entry={tab,scriptDone:false,grantsDone:false,expired:false,stale:false,opened:false,failed:false};flights.set(tab.id,entry);
      const fallback=()=>{if(!entry.opened&&!entry.stale){entry.opened=true;open(tab);}};
      const release=()=>{if(flights.get(tab.id)===entry)flights.delete(tab.id);};
      const finish=()=>{
        if(!entry.scriptDone||!entry.grantsDone)return;
        clearTimeout(entry.timer);
        if(entry.stale||entry.expired||entry.failed||permissionPending){release();fallback();return;}
        let origins;try{origins=startupPreviewOrigins(entry.result,tab.url,entry.granted);}catch{release();fallback();return;}
        if(!origins.length){release();fallback();return;}
        permissionPending=true;
        // No await or further API hop before this permission request.
        try{api.permissions.request({origins},()=>{
          const error=api.runtime.lastError;permissionPending=false;
          if(error)entry.failed=true;
          release();fallback();
        });}catch{permissionPending=false;release();fallback();}
      };
      entry.timer=setTimeout(()=>{entry.expired=true;fallback();},timeoutMs);entry.timer.unref?.();
      try{api.permissions.getAll(grants=>{
        const error=api.runtime.lastError;entry.grantsDone=true;entry.failed||=Boolean(error);
        entry.granted=grants?.origins;finish();
      });}catch{entry.grantsDone=true;entry.failed=true;}
      try{api.scripting.executeScript({target:{tabId:tab.id},func:previewPermissionHosts,args:[tab.url]},results=>{
        const error=api.runtime.lastError;entry.scriptDone=true;entry.failed||=Boolean(error);
        const injection=results?.length===1&&results[0];
        if(injection?.frameId!==0||typeof injection.documentId!=='string'||!injection.documentId)entry.failed=true;
        entry.result=injection?.result;finish();
      });}catch{entry.scriptDone=true;entry.failed=true;finish();}
    },
    stats(){return {pendingProbes:flights.size,permissionPending};},
  };
}
