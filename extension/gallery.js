import {fileLabel, extensionOf, matchesImage, publicError, isDetectedImageFormat} from './utils.js';
import {previewHost} from './preview-loader.js';

const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
function icon(name) {
  const svg=typeof document.createElementNS==='function'
    ? document.createElementNS('http://www.w3.org/2000/svg','svg')
    : document.createElement('svg');
  if(svg.classList)svg.classList.add('icon');else svg.className='icon';
  svg.setAttribute?.('aria-hidden','true');
  const use=typeof document.createElementNS==='function'
    ? document.createElementNS('http://www.w3.org/2000/svg','use')
    : document.createElement('use');
  use.setAttribute?.('href',`#icon-${name}`);
  svg.append?.(use);
  return svg;
}
function isAdBeaconOrTracker(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const label = fileLabel(url).toLowerCase();
    const base = label.replace(/\.[a-z0-9]{1,8}$/i, '');
    if (base === 'imp' || /^imp(\.[a-z0-9]{1,8})?$/i.test(label) || label.startsWith('imp_') || label.startsWith('imp-')
      || ['pixel', 'beacon', 'tracker', 'track', '1x1', 'blank', 'spacer', 'clear', 'infomark'].includes(base)
      || label.includes('ad-banner') || label.includes('sp-banner') || label.includes('ad_banner')) return true;

    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    const host = u.hostname.toLowerCase();
    if (/\b(?:dsp|adserver|adsystem|adnxs|doubleclick|googlesyndication|googleads|pagead|criteo|adroll|popads|trafficjunky|exoclick|juicyads|i-mobile|microad|ad-stir|geniee|amoad|nend|bance\.jp)\b/i.test(host)
      || /^(?:ad|ads|adtech|advert|advertising|beacon|pixel|track|tracker)\./i.test(host)) return true;

    const segments = u.pathname.toLowerCase().split('/').filter(Boolean);
    if (segments.some(s => ['imp', 'impression', 'pixel', 'beacon', 'track', 'tracker', 'ad-banner', 'sp-banner', 'infomark'].includes(s)
      || /^imp(\.[a-z0-9]{1,8})?$/i.test(s))) return true;

    if (/[?&](?:ad_id|advertiser_id|banner_id|bid|placement_id|click_id)=/i.test(u.search)) return true;

    return false;
  } catch {
    return false;
  }
}

export function candidateCatalog(state) {
  return [...new Map([...(state.selectedItems || []),...(state.items || [])].map(item=>[item.url,item])).values()];
}
export function candidateMatches(item,filters,sourceURL='') {
  const known=item.dimensionSource==='decoded' || item.dimensionSource==='measured';
  const format=isDetectedImageFormat(item.detectedFormat)?item.detectedFormat:extensionOf(item.url,'images').toLowerCase();
  const dimensionsValid=Number.isFinite(item.width)&&Number.isFinite(item.height)&&item.width>0&&item.height>0;
  const short=dimensionsValid?Math.min(item.width,item.height):0;
  const long=dimensionsValid?Math.max(item.width,item.height):0;
  const ratio=dimensionsValid?long/short:0;

  let adLike = isAdBeaconOrTracker(item.url);
  if (!adLike && dimensionsValid) {
    if (item.width <= 2 && item.height <= 2) adLike = true;
    else {
      const isStandardAdSize = (
        (item.width === 728 && item.height === 90) || (item.width === 90 && item.height === 728) ||
        (item.width === 468 && item.height === 60) || (item.width === 60 && item.height === 468) ||
        (item.width === 320 && item.height === 50) || (item.width === 50 && item.height === 320) ||
        (item.width === 300 && item.height === 250) || (item.width === 250 && item.height === 300) ||
        (item.width === 160 && item.height === 600) || (item.width === 600 && item.height === 160)
      );
      if (isStandardAdSize) adLike = true;
      else {
        // コンテンツ画像の保護:
        // 縦スクロール漫画（Webtoon: 縦長かつ十分な幅・高さ）や超高解像度パノラマはバナーとみなさない
        const isProtectedContent = (
          (item.height > item.width && item.width >= 400 && item.height >= 1200) ||
          (short >= 500 && item.width * item.height >= 800_000)
        );
        if (!isProtectedContent) {
          if (format === 'gif' || short < 200 || ratio >= 3) adLike = true;
        }
      }
    }
  } else if (!adLike && format === 'gif') {
    adLike = true;
  }

  return (!filters.excludeAdLike || !adLike) && matchesImage(item,{...filters,width:0,maxWidth:0,height:0,maxHeight:0}) && (!known ||
    ((!filters.width || item.width>=filters.width)
      && (!filters.maxWidth || item.width<=filters.maxWidth)
      && (!filters.height || item.height>=filters.height)
      && (!filters.maxHeight || item.height<=filters.maxHeight)));
}
export function representativeCandidates(items) {
  const groups=new Map();
  for(const item of items) {
    const key=item.groupId || item.url;
    if(!groups.has(key) || item.isCurrent)groups.set(key,item);
  }
  return [...groups.values()];
}

export class Gallery {
  constructor({getState,getSelected,onSelect,onView,onMeasure,onRender,onError,status,previews}) {
    Object.assign(this,{getState,getSelected,onSelect,onView,onMeasure,onRender,onError,status,previews});
    this.visible=[];this.measured=new Map();this.mode='all';this.lastURL='';this.viewerURLs=[];this.viewerIndex=0;
    this.previewBindings=new Set();this.previewSequence=0;
    this.permissionURLs=new Map();this.permissionRows=new Map();this.permissionRequests=new Set();this.permissionMessages=new Map();
    this.previewObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
      for(const entry of entries){const binding=[...this.previewBindings].find(value=>value.container===entry.target);if(!binding)continue;
        binding.visible=entry.isIntersecting;if(binding.visible)this.loadPreview(binding);else this.cancelPreview(binding);
      }
    },{rootMargin:'160px'}):null;
    $('view-all').addEventListener('click',()=>this.setMode('all'));
    $('view-selected').addEventListener('click',()=>this.setMode('selected'));
    $('view-added').addEventListener('click',()=>this.setMode('added'));
    $('selection').addEventListener('click',()=>this.setMode('selected'));
    $('measure-refresh').addEventListener('click',()=>this.render());
    $('preview-close').addEventListener('click',()=>$('image-preview').close());
    $('image-preview').addEventListener('close',()=>{this.clearPreviews('viewer');$('preview-stage').replaceChildren();this.restoreViewerFocus();});
    $('preview-prev').addEventListener('click',()=>this.showViewer(this.viewerURLs[this.viewerIndex-1]));
    $('preview-next').addEventListener('click',()=>this.showViewer(this.viewerURLs[this.viewerIndex+1]));
    $('preview-zoom').addEventListener('click',()=>{
      const actual=$('preview-stage').classList.toggle('actual-size');
      $('preview-zoom').textContent=actual?'全体を表示':'プレビューを等倍で表示';$('preview-zoom').setAttribute('aria-pressed',String(actual));
    });
    $('preview-select').addEventListener('change',()=>this.select(this.viewerURL,$('preview-select').checked));
    $('image-preview').addEventListener('keydown',event=>{
      if(event.target instanceof HTMLInputElement)return;
      if(event.key==='ArrowLeft' && this.viewerIndex>0){event.preventDefault();this.showViewer(this.viewerURLs[this.viewerIndex-1]);}
      if(event.key==='ArrowRight' && this.viewerIndex<this.viewerURLs.length-1){event.preventDefault();this.showViewer(this.viewerURLs[this.viewerIndex+1]);}
    });
    this.setupViewerGestures();
    $('return-gallery').addEventListener('click',()=>this.restoreFocus(this.lastURL));
    $('skip-save').addEventListener('click',event=>{event.preventDefault();this.focusSave();});
  }
  restore(ui={}) {
    this.mode=['all','selected','added'].includes(ui.view)?ui.view:ui.onlySelected?'selected':'all';
    for(const id of ['query','width','height','maxWidth','maxHeight','type']) {
      const el=$(id==='maxWidth'?'max-width':id==='maxHeight'?'max-height':id);
      if(el&&ui[id]!==undefined)el.value=ui[id];
    }
    if($('width-range')&&ui.width!==undefined)$('width-range').value=ui.width;
    if($('max-width-range')&&ui.maxWidth!==undefined)$('max-width-range').value=ui.maxWidth;
    if($('height-range')&&ui.height!==undefined)$('height-range').value=ui.height;
    if($('max-height-range')&&ui.maxHeight!==undefined)$('max-height-range').value=ui.maxHeight;
    $('exclude-ad-like').checked=ui.excludeAdLike===true;
    if(ui.filtersOpen)$('filters').open=true;if(ui.helpOpen)$('help').open=true;
    this.lastURL=ui.focusAnchor || '';
  }
  viewPatch() {
    return {view:this.mode,onlySelected:this.mode==='selected',query:$('query').value,
      width:Number($('width').value)||0,
      maxWidth:Number($('max-width')?.value)||0,
      height:Number($('height').value)||0,
      maxHeight:Number($('max-height')?.value)||0,
      type:$('type').value,
      excludeAdLike:$('exclude-ad-like').checked,
      scrollY:window.scrollY,focusAnchor:this.lastURL,filtersOpen:$('filters').open,helpOpen:$('help').open};
  }
  setMode(mode) {this.mode=mode;this.render();this.onView(this.viewPatch());$('gallery-heading').focus();}
  effective(item) {return this.measured.has(item.url)?{...item,...this.measured.get(item.url),dimensionSource:'decoded'}:item;}
  dimensions(item) {return item.dimensionSource==='decoded'||item.dimensionSource==='measured'?`${item.width} × ${item.height}`:'寸法未確認';}
  measure(url,image) {
    this.measureSource(url,image.naturalWidth,image.naturalHeight);
  }
  measureSource(url,width,height,detectedFormat) {
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return;
    const previous=this.measured.get(url),format=isDetectedImageFormat(detectedFormat)?detectedFormat:previous?.detectedFormat;
    const value={width,height,...(format?{detectedFormat:format}:{})};
    if(JSON.stringify(this.measured.get(url))===JSON.stringify(value))return;
    this.measured.set(url,value);this.onMeasure({url,...value});
    for(const meta of document.querySelectorAll('[data-dimensions]'))if(meta.dataset.dimensions===url)meta.textContent=`${value.width} × ${value.height}`;
    if(Number($('width').value)||Number($('max-width')?.value)||Number($('height').value)||Number($('max-height')?.value)||$('exclude-ad-like').checked)$('measure-refresh').hidden=false;
    const item=this.item(url);
    if(this.viewerURL===url&&item)$('preview-meta').textContent=this.description(this.effective(item));
  }
  cancelPreview(binding){
    binding.generation++;binding.controller?.abort();binding.controller=null;binding.pending=false;
    binding.handle?.release();binding.handle=null;
    binding.container.replaceChildren(node('span','preview-error',binding.host?'プレビューを読み込みます…':'この画像はプレビューに対応していません。'));
    this.showPreviewConsent(binding,false);
  }
  showPreviewConsent(binding,show){
    if(binding.button){
      binding.button.hidden=!show;binding.button.disabled=!binding.host||!this.previews||binding.requesting||binding.pending||this.previewsPaused||binding.needsPermission&&this.permissionRequests.has(binding.host.key);
      binding.button.children[0].textContent=!binding.host?'プレビュー非対応':binding.needsPermission?'アクセスを許可して表示':'再試行';
      binding.button.setAttribute('aria-label',binding.host?`${binding.host.label} のプレビュー${binding.needsPermission?'へのアクセスを許可して表示':'を再試行'}`:'この画像はプレビューできません');
      if(binding.needsPermission&&binding.details&&binding.host){
        binding.button.setAttribute('aria-describedby',binding.details.id);
        binding.button.title=`${binding.host.label} の画像を取得します。サイトの許可は同じホストの全パス・ポートに適用されます。`;
      }else{
        binding.button.removeAttribute('aria-describedby');
        binding.button.title=binding.host?`${binding.host.label} の画像を再取得します。`:'この画像は安全にプレビューできません';
      }
    }
    if(binding.details)binding.details.hidden=!show||!binding.host||!binding.needsPermission;
  }
  updatePermissionSummary(){
    const panel=$('preview-access'),list=$('preview-access-origins');if(!panel||!list||!this.permissionURLs)return;
    const retained=new Set(candidateCatalog(this.getState()).map(item=>item.url)),groups=new Map();
    for(const [url,host]of this.permissionURLs){
      if(!retained.has(url)){this.permissionURLs.delete(url);continue;}
      let group=groups.get(host.key);if(!group){group={host,url,origins:new Set(),count:0};groups.set(host.key,group);}
      group.origins.add(previewHost(url).label);group.count++;
    }
    for(const [key,row]of this.permissionRows)if(!groups.has(key)){
      if(row.element.contains(document.activeElement))$('gallery-heading').focus({preventScroll:true});
      row.element.remove();this.permissionRows.delete(key);this.permissionMessages.delete(key);
    }
    for(const [key,group]of groups){
      let row=this.permissionRows.get(key);
      if(!row){
        const element=node('div','preview-access-item'),info=node('div','preview-access-info');element.dataset.host=key;
        const source=node('p','preview-access-source'),scope=node('p','preview-access-scope'),message=node('p','preview-access-message');
        scope.id=`preview-access-scope-${++this.previewSequence}`;message.setAttribute('role','status');
        scope.textContent='この配信元の全パス・全ポートへのアクセスが対象です。サイトのログイン状態を使って画像を取得します。';
        const button=node('button','secondary preview-access-grant');button.type='button';button.dataset.host=key;
        button.append(icon('eye'),node('span',null,'この配信元の画像を表示'));
        button.setAttribute('aria-describedby',scope.id);info.append(source,scope,message);element.append(info,button);list.append(element);
        row={element,source,message,button};this.permissionRows.set(key,row);
      }
      const origins=[...group.origins].join('、');
      row.source.textContent=`配信元: ${origins}（プレビュー待ち${group.count}件）`;
      row.button.setAttribute('aria-label',`${origins} の画像を表示`);
      row.button.disabled=this.previewsPaused||this.busy||this.permissionRequests.has(key);
      row.button.onclick=()=>{void this.requestHostPreviews(group.url,row.button);};
      const message=this.permissionRequests.has(key)?'Chromeのアクセス許可を確認しています…':this.permissionMessages.get(key)||'';
      if(row.message.textContent!==message)row.message.textContent=message;
      row.message.hidden=!message;
    }
    panel.hidden=this.previewsPaused||groups.size===0;
  }
  requestHostPreviews(url,button){
    const host=previewHost(url);if(this.previewsPaused||this.permissionRequests.has(host.key))return Promise.resolve(false);
    this.permissionRequests.add(host.key);this.permissionMessages.delete(host.key);
    // Keep the native permission request in the real click, before any await.
    let permission;try{permission=this.previews.grantHost(url);}catch(error){permission=Promise.reject(error);}
    if(document.activeElement===button){
      const target=button.closest('.card')?.querySelector('.image-select:not(:disabled)')
        ||(button.closest('#preview-stage')?(!$('preview-select').disabled?$('preview-select'):$('preview-close')):$('gallery-heading'));
      target.focus({preventScroll:true});
    }
    this.updatePermissionSummary();
    for(const binding of this.previewBindings)if(binding.host?.key===host.key)this.showPreviewConsent(binding,!binding.handle&&!binding.pending);
    return Promise.resolve(permission).then(allowed=>{
      if(!allowed){this.permissionMessages.set(host.key,'許可されませんでした。もう一度試すか、元の形式で保存できます。');return false;}
      for(const [candidateURL,candidateHost]of this.permissionURLs)if(candidateHost.key===host.key)this.permissionURLs.delete(candidateURL);
      this.permissionMessages.delete(host.key);
      for(const binding of this.previewBindings)if(binding.host?.key===host.key){
        binding.needsPermission=false;
        if(binding.visible){this.cancelPreview(binding);this.loadPreview(binding);}
      }
      return true;
    },()=>{this.permissionMessages.set(host.key,'アクセス許可を確認できませんでした。もう一度試せます。');return false;})
      .finally(()=>{
        this.permissionRequests.delete(host.key);this.updatePermissionSummary();
        for(const binding of this.previewBindings)if(binding.host?.key===host.key)this.showPreviewConsent(binding,!binding.handle&&!binding.pending);
      });
  }
  clearPreviews(kind){
    for(const binding of [...this.previewBindings])if(!kind || binding.kind===kind){
      this.cancelPreview(binding);this.previewObserver?.unobserve(binding.container);this.previewBindings.delete(binding);
    }
  }
  refreshPreviews(){
    for(const binding of this.previewBindings){this.cancelPreview(binding);if(binding.visible)this.loadPreview(binding);}
  }
  suspendPreviews(){this.previewsPaused=true;this.clearPreviews();this.previews?.invalidate();this.updatePermissionSummary();}
  resumePreviews(){
    this.previewsPaused=false;this.render();
    if($('image-preview').open&&this.viewerURL)this.showViewer(this.viewerURL);
  }
  bindPreview(item,container,kind,button,details){
    let host;try{host=previewHost(item.url);}catch{}
    const binding={item,container,kind,button,details,host,visible:kind==='viewer'||!this.previewObserver,generation:0,pending:false,requesting:false,needsPermission:false,handle:null,controller:null};
    this.previewBindings.add(binding);container.replaceChildren(node('span','preview-error',host?'プレビューを読み込みます…':'この画像はプレビューに対応していません。'));
    if(button){
      button.replaceChildren(node('span','',host?'再試行':'プレビュー非対応'));
      button.setAttribute('aria-label',host?`${host.label} のプレビューを再試行`:'この画像はプレビューできません');
      if(details){
        details.id=`preview-details-${++this.previewSequence}`;details.replaceChildren();
        if(host)details.append(node('p','preview-source',host.isEmbedded?host.label:`配信元: ${host.label}`));
        if(host&&!host.isEmbedded)details.append(node('p','preview-scope','この配信元の全パス・全ポートが対象です。サイトのログイン状態を使って画像を取得します。この作業ページでは、同じ配信元のプレビューも表示します。'));
      }
      this.showPreviewConsent(binding,!host);
      button.onclick=event=>{
        event.preventDefault();event.stopPropagation();
        if(binding.needsPermission){void this.requestHostPreviews(item.url,button);return;}
        const permission=this.previews?.retry(item.url);
        if(document.activeElement===button){
          const target=kind==='viewer'?(!$('preview-select').disabled?$('preview-select'):$('preview-close'))
            :button.closest('.card')?.querySelector('.image-select:not(:disabled), .preview-open:not(:disabled)')||$('gallery-heading');
          target.focus({preventScroll:true});
        }
        binding.requesting=true;button.disabled=true;
        container.replaceChildren(node('span','preview-error',binding.needsPermission?'配信元の許可を確認しています…':'プレビューを読み込み中…'));
        Promise.resolve(permission).then(allowed=>{
          if(!allowed){container.replaceChildren(node('span','preview-error','プレビューは許可されませんでした。選択と元形式の保存はできます。'));return;}
          for(const candidate of this.previewBindings)if(candidate.host?.key===host?.key && candidate.visible){this.cancelPreview(candidate);this.loadPreview(candidate);}
        },()=>{container.replaceChildren(node('span','preview-error','プレビューを許可できませんでした。選択と元形式の保存はできます。'));})
          .finally(()=>{binding.requesting=false;this.showPreviewConsent(binding,!binding.handle&&!binding.pending);});
      };
    }
    if(this.previewObserver && kind==='thumbnail')this.previewObserver.observe(container);
    else this.loadPreview(binding);
  }
  loadPreview(binding){
    if(this.previewsPaused || !this.previews || !binding.host || !binding.visible || binding.pending || binding.handle)return;
    const generation=++binding.generation,controller=new AbortController();binding.controller=controller;binding.pending=true;
    this.showPreviewConsent(binding,false);binding.container.replaceChildren(node('span','preview-error','プレビューを読み込み中…'));
    this.previews.load(binding.item.url,{kind:binding.kind,signal:controller.signal}).then(handle=>{
      if(controller.signal.aborted || generation!==binding.generation || !this.previewBindings.has(binding) || binding.container.isConnected===false){handle.release();return;}
      binding.handle=handle;binding.needsPermission=false;this.permissionURLs.delete(binding.item.url);this.updatePermissionSummary();
      const image=new Image();image.alt=binding.kind==='viewer'?((binding.item.alt||'').trim()||fileLabel(binding.item.url)):'';
      image.referrerPolicy='no-referrer';
      image.onerror=()=>{if(binding.handle===handle){handle.release();binding.handle=null;binding.container.replaceChildren(node('span','preview-error','プレビューを表示できません。元形式での保存を試せます。'));this.showPreviewConsent(binding,true);}};
      image.src=handle.url;binding.container.replaceChildren(image);this.showPreviewConsent(binding,false);
      // The generated static image may be resized. Persist validated source
      // dimensions, never the thumbnail's naturalWidth/naturalHeight.
      this.measureSource(binding.item.url,handle.width,handle.height,handle.detectedFormat);
    },error=>{
      if(controller.signal.aborted || generation!==binding.generation || !this.previewBindings.has(binding))return;
      binding.container.replaceChildren(node('span','preview-error',publicError(error)));
      binding.needsPermission=error?.code==='PREVIEW_PERMISSION_REQUIRED';
      if(binding.needsPermission)this.permissionURLs.set(binding.item.url,binding.host);else this.permissionURLs.delete(binding.item.url);
      this.updatePermissionSummary();this.showPreviewConsent(binding,true);
    }).finally(()=>{if(generation===binding.generation){binding.pending=false;this.showPreviewConsent(binding,!binding.handle);}});
  }
  item(url) {return candidateCatalog(this.getState()).find(i=>i.url===url);}
  description(item) {
    const ext=extensionOf(item.url,'images');
    return `${this.dimensions(item)} · ${ext==='img'?'形式不明':ext.toUpperCase()}${item.descriptor?` · ページの指定 ${item.descriptor}`:''}`;
  }
  async select(url,checked) {
    if(this.busy)return;
    const next=new Set(this.getSelected());checked?next.add(url):next.delete(url);
    this.lastURL=url;
    try {await this.onSelect([...next]);this.sync();if(this.mode==='selected')this.render();}
    catch(e){this.onError(e);this.sync();}
  }
  sync() {
    const selected=this.getSelected();
    for(const input of document.querySelectorAll('.image-select'))input.checked=selected.has(input.dataset.url);
    if(this.viewerURL)$('preview-select').checked=selected.has(this.viewerURL);
    $('view-selected').textContent=`選択済み ${selected.size}`;
    this.setBusy(this.busy);
  }
  setBusy(busy=false) {
    this.busy=busy;
    for(const input of document.querySelectorAll('.image-select'))input.disabled=busy;
    $('preview-select').disabled=busy;this.updatePermissionSummary();
  }
  focusSave() {($('save').disabled?$('save-heading'):$('save')).focus();}
  restoreFocus(url,role='select',index=0) {
    const cards=[...document.querySelectorAll('#grid .card')];
    const card=cards.find(e=>e.dataset.url===url) || cards[Math.min(Math.max(index,0),cards.length-1)];
    const target=card?.querySelector(`[data-gallery-role="${role}"]:not(:disabled)`)
      || card?.querySelector('.image-select:not(:disabled), button:not(:disabled)') || $('gallery-heading');
    target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});
  }
  restoreViewerFocus() {
    if(this.returnTarget?.isConnected&&!this.returnTarget.disabled) {
      this.returnTarget.focus({preventScroll:true});this.returnTarget.scrollIntoView({block:'nearest'});
    } else this.restoreFocus(this.returnURL,'preview',this.returnIndex);
  }
  render() {
    this.clearPreviews('thumbnail');
    const state=this.getState(),selected=this.getSelected(),active=document.activeElement;
    const oldCard=active?.closest('#grid .card'),oldURL=oldCard?.dataset.url,oldRole=active?.dataset.galleryRole;
    const oldIndex=this.visible.findIndex(item=>item.url===oldURL);
    const filters={query:$('query').value,width:Number($('width').value)||0,maxWidth:Number($('max-width')?.value)||0,height:Number($('height').value)||0,maxHeight:Number($('max-height')?.value)||0,type:$('type').value,excludeAdLike:$('exclude-ad-like').checked};
    const all=candidateCatalog(state).map(i=>this.effective(i));
    const retained=new Set(all.map(item=>item.url));
    if(this.viewerURL&&!retained.has(this.viewerURL)){$('image-preview').close();this.clearPreviews('viewer');this.viewerURL=null;}
    for(const url of this.measured.keys())if(!retained.has(url))this.measured.delete(url);
    const page=(state.items || []).map(i=>this.effective(i));
    const candidates=this.mode==='selected'?all.filter(i=>selected.has(i.url)):
      page.filter(i=>candidateMatches(i,filters,state?.url) && (this.mode!=='added'||(state.scan?.addedURLs||[]).includes(i.url)));
    this.visible=this.mode==='selected'?candidates:representativeCandidates(candidates);
    $('count').textContent=`表示${this.visible.length} / ${this.mode==='selected'?'選択':'全'}${this.mode==='selected'?selected.size:page.length}件`;
    $('view-all').setAttribute('aria-pressed',String(this.mode==='all'));
    $('view-selected').setAttribute('aria-pressed',String(this.mode==='selected'));
    $('view-added').setAttribute('aria-pressed',String(this.mode==='added'));
    $('view-added').hidden=!(state.scan?.addedURLs?.length && state.scan.addedURLs.length < (state.items?.length || 0));
    $('next-page').hidden=!state.scan?.hasMore;
    $('measure-refresh').hidden=true;
    const unknown=candidates.filter(i=>!['decoded','measured'].includes(i.dimensionSource)).length;
    $('dimension-note').hidden=!(unknown&&(filters.width||filters.maxWidth||filters.height||filters.maxHeight||filters.excludeAdLike));
    $('dimension-note').textContent=filters.excludeAdLike?`実寸法未確認${unknown}件を含みます。元ページの寸法で概算し、不明な候補は残します。プレビュー後に確認した情報で条件を更新できます。`:`寸法未確認${unknown}件を含みます。画像を表示すると寸法を確認します。`;
    $('search-tools').hidden=this.mode==='selected';$('active-filters').hidden=this.mode==='selected'||!$('active-filters').children.length;
    $('grid').replaceChildren();
    for(const [index,item] of this.visible.entries()) {
      const card=node('article','card');card.dataset.url=item.url;
      const label=node('label','card-select'),thumb=node('div','thumb'),imageLabel=node('label','thumbnail-image');
      const input=node('input','image-select');input.type='checkbox';input.dataset.url=item.url;input.checked=selected.has(item.url);
      input.id=`image-select-${index}`;label.htmlFor=input.id;imageLabel.htmlFor=input.id;
      input.dataset.galleryRole='select';
      const nameText=(item.alt || '').trim() || fileLabel(item.url);
      input.setAttribute('aria-label',`${index+1}. ${nameText}を選択`);
      input.setAttribute('aria-describedby',`image-meta-${index} image-status-${index}`);
      input.addEventListener('focus',()=>{this.lastURL=item.url;});
      input.addEventListener('change',()=>this.select(item.url,input.checked));
      const body=node('div','card-body'),name=node('strong','file-name',fileLabel(item.url));name.title=name.textContent;
      const meta=node('span','meta');meta.id=`image-meta-${index}`;
      const dims=node('span','',this.dimensions(item));dims.dataset.dimensions=item.url;
      const ext=extensionOf(item.url,'images');meta.append(dims,node('span','file-type',ext==='img'?'形式不明':ext.toUpperCase()));
      const status=node('span','item-status',this.status(item.url));status.id=`image-status-${index}`;status.dataset.url=item.url;
      status.dataset.state=(state.jobs.find(j=>j.url===item.url)||state.history?.find(j=>j.url===item.url))?.status || '';
      body.append(name,meta,status);
      label.append(input,body);
      const jump=node('button','card-save-jump','保存操作へ移動');jump.type='button';jump.onclick=()=>this.focusSave();
      jump.dataset.galleryRole='save';jump.addEventListener('focus',()=>{this.lastURL=item.url;});
      const variants=all.filter(i=>item.groupId && i.groupId===item.groupId);
      const previewText=variants.length>1?`確認・他${variants.length-1}候補`:'大きく確認';
      const preview=node('button','preview-open');preview.type='button';
      preview.append(icon('search'),node('span','preview-open-text',previewText));
      preview.dataset.galleryRole='preview';preview.addEventListener('focus',()=>{this.lastURL=item.url;});
      preview.onclick=()=>this.openViewer(item.url,preview);
      const permission=node('button','secondary preview-permission'),details=node('div','preview-details');permission.type='button';permission.dataset.galleryRole='permission';
      permission.addEventListener('focus',()=>{this.lastURL=item.url;});
      thumb.append(imageLabel,permission);card.append(thumb,details,label,jump,preview);$('grid').append(card);
      this.bindPreview(item,imageLabel,'thumbnail',permission,details);
    }
    $('empty').hidden=!!this.visible.length;$('empty').replaceChildren();
    if(!this.visible.length) {
      $('empty').append(node('h3','',this.mode==='selected'?'選択した画像はありません':page.length?'一致する画像がありません':'画像が見つかりませんでした'));
      const reset=node('button','secondary',this.mode!=='all'?'すべてに戻る':'条件をリセット');
      reset.onclick=()=>{if(this.mode!=='all')this.setMode('all');else $('reset-filters').click();};
      $('empty').append(node('p','',page.length?'表示条件を変えるか、すべての画像へ戻れます。':'元ページで画像を表示して、再スキャンしてください。'),reset);
    }
    this.sync();
    if(oldURL)this.restoreFocus(oldURL,oldRole,oldIndex);
    else if(active===$('measure-refresh')&&active.hidden)$('gallery-heading').focus();
    this.onRender?.(this.visible);
  }
  setupViewerGestures() {
    const stage=$('preview-stage');
    if(!stage?.addEventListener)return;
    let startX=0, startY=0, startTime=0, lastTap=0, lastTapX=0, lastTapY=0;
    stage.addEventListener('touchstart', e => {
      if(e.touches?.length===1) {
        startX=e.touches[0].clientX;
        startY=e.touches[0].clientY;
        startTime=Date.now();
        const now=Date.now();
        if(now-lastTap<350 && Math.hypot(startX-lastTapX, startY-lastTapY)<24) {
          $('preview-zoom')?.click();
          lastTap=0;
          return;
        }
        lastTap=now;
        lastTapX=startX;
        lastTapY=startY;
      }
    }, {passive:true});
    stage.addEventListener('touchend', e => {
      if(startTime===0 || !e.changedTouches || e.changedTouches.length===0)return;
      const endX=e.changedTouches[0].clientX;
      const endY=e.changedTouches[0].clientY;
      const dx=endX-startX;
      const dy=endY-startY;
      const dt=Date.now()-startTime;
      startTime=0;
      if(Math.hypot(dx, dy)>12)lastTap=0;
      if(stage.classList?.contains('actual-size'))return;
      if(dt<450 && Math.abs(dx)>40 && Math.abs(dx)>Math.abs(dy)*1.4) {
        if(dx<0 && this.viewerIndex<this.viewerURLs.length-1) {
          this.showViewer(this.viewerURLs[this.viewerIndex+1]);
        } else if(dx>0 && this.viewerIndex>0) {
          this.showViewer(this.viewerURLs[this.viewerIndex-1]);
        }
      }
    }, {passive:true});
  }
  openViewer(url,origin=document.activeElement) {
    this.returnURL=url;this.viewerURLs=this.visible.map(i=>i.url);
    this.returnIndex=this.viewerURLs.indexOf(url);
    this.returnTarget=origin?.matches('.preview-open')?origin:null;
    if(!this.viewerURLs.includes(url))this.viewerURLs.push(url);
    $('preview-stage').classList.remove('actual-size');$('preview-zoom').textContent='プレビューを等倍で表示';$('preview-zoom').setAttribute('aria-pressed','false');
    this.showViewer(url);$('image-preview').showModal();
  }
  showViewer(url) {
    const raw=this.item(url);if(!raw)return;
    const active=document.activeElement,variantFocus=active?.closest('#preview-variants button')?.dataset.url;
    const item=this.effective(raw);this.viewerURL=url;
    const at=this.viewerURLs.indexOf(url);if(at>=0)this.viewerIndex=at;
    $('preview-title').textContent=(item.alt||'').trim() || fileLabel(url);
    $('preview-meta').textContent=this.description(item);
    $('preview-select').checked=this.getSelected().has(url);
    $('preview-prev').disabled=this.viewerIndex<=0;$('preview-next').disabled=this.viewerIndex>=this.viewerURLs.length-1;
    this.clearPreviews('viewer');
    const stage=node('div','viewer-image'),permission=node('button','secondary preview-permission'),details=node('div','preview-details');permission.type='button';
    $('preview-stage').replaceChildren(stage,permission,details);this.bindPreview(item,stage,'viewer',permission,details);
    $('preview-variants').replaceChildren();
    const alternatives=candidateCatalog(this.getState()).filter(i=>item.groupId&&i.groupId===item.groupId);
    if(alternatives.length>1)for(const variant of alternatives) {
      const b=node('button','secondary',`${fileLabel(variant.url)} · ${this.description(this.effective(variant))}`);b.type='button';b.dataset.url=variant.url;b.setAttribute('aria-pressed',String(variant.url===url));b.onclick=()=>this.showViewer(variant.url);$('preview-variants').append(b);
    }
    if(variantFocus) {
      const target=[...$('preview-variants').children].find(button=>button.dataset.url===variantFocus);
      (target||$('preview-close')).focus({preventScroll:true});
    } else if((active===$('preview-next')||active===$('preview-prev'))&&active.disabled) {
      const other=active===$('preview-next')?$('preview-prev'):$('preview-next');
      (other.disabled?$('preview-close'):other).focus({preventScroll:true});
    }
  }
}
