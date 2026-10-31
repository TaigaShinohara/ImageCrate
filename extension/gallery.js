import {fileLabel, extensionOf, matchesImage, publicError} from './utils.js';
import {previewHost} from './preview-loader.js';

const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
export function candidateCatalog(state) {
  return [...new Map([...(state.selectedItems || []),...(state.items || [])].map(item=>[item.url,item])).values()];
}
export function candidateMatches(item,filters) {
  const known=item.dimensionSource==='decoded' || item.dimensionSource==='measured';
  return matchesImage(item,{...filters,width:0,height:0}) && (!known ||
    ((!filters.width || item.width>=filters.width) && (!filters.height || item.height>=filters.height)));
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
    $('return-gallery').addEventListener('click',()=>this.restoreFocus(this.lastURL));
    $('skip-save').addEventListener('click',event=>{event.preventDefault();this.focusSave();});
  }
  restore(ui={}) {
    this.mode=['all','selected','added'].includes(ui.view)?ui.view:ui.onlySelected?'selected':'all';
    for(const id of ['query','width','height','type'])if(ui[id]!==undefined)$(id).value=ui[id];
    if(ui.filtersOpen)$('filters').open=true;if(ui.helpOpen)$('help').open=true;
    this.lastURL=ui.focusAnchor || '';
  }
  viewPatch() {
    return {view:this.mode,onlySelected:this.mode==='selected',query:$('query').value,width:Number($('width').value)||0,height:Number($('height').value)||0,type:$('type').value,
      scrollY:window.scrollY,focusAnchor:this.lastURL,filtersOpen:$('filters').open,helpOpen:$('help').open};
  }
  setMode(mode) {this.mode=mode;this.render();this.onView(this.viewPatch());$('gallery-heading').focus();}
  effective(item) {return this.measured.has(item.url)?{...item,...this.measured.get(item.url),dimensionSource:'decoded'}:item;}
  dimensions(item) {return item.dimensionSource==='decoded'||item.dimensionSource==='measured'?`${item.width} × ${item.height}`:'寸法未確認';}
  measure(url,image) {
    this.measureSource(url,image.naturalWidth,image.naturalHeight);
  }
  measureSource(url,width,height) {
    if(!width || !height)return;
    const value={width,height};
    if(JSON.stringify(this.measured.get(url))===JSON.stringify(value))return;
    this.measured.set(url,value);this.onMeasure({url,...value});
    for(const meta of document.querySelectorAll('[data-dimensions]'))if(meta.dataset.dimensions===url)meta.textContent=`${value.width} × ${value.height}`;
    if(Number($('width').value)||Number($('height').value))$('measure-refresh').hidden=false;
    const item=this.item(url);
    if(this.viewerURL===url&&item)$('preview-meta').textContent=this.description(this.effective(item));
  }
  cancelPreview(binding){
    binding.generation++;binding.controller?.abort();binding.controller=null;binding.pending=false;
    binding.handle?.release();binding.handle=null;
    binding.container.replaceChildren(node('span','preview-error','下のボタンでプレビューを表示できます'));
    this.showPreviewConsent(binding,true);
  }
  showPreviewConsent(binding,show){
    if(binding.button){binding.button.hidden=!show;binding.button.disabled=!binding.host||!this.previews||binding.requesting||binding.pending;}
    if(binding.details)binding.details.hidden=!show||!binding.host;
  }
  clearPreviews(kind){
    for(const binding of [...this.previewBindings])if(!kind || binding.kind===kind){
      this.cancelPreview(binding);this.previewObserver?.unobserve(binding.container);this.previewBindings.delete(binding);
    }
  }
  refreshPreviews(){
    for(const binding of this.previewBindings){this.cancelPreview(binding);if(binding.visible)this.loadPreview(binding);}
  }
  suspendPreviews(){this.clearPreviews();this.previews?.invalidate();}
  bindPreview(item,container,kind,button,details){
    let host;try{host=previewHost(item.url);}catch{}
    const binding={item,container,kind,button,details,host,visible:kind==='viewer'||!this.previewObserver,generation:0,pending:false,requesting:false,handle:null,controller:null};
    this.previewBindings.add(binding);container.replaceChildren(node('span','preview-error','下のボタンでプレビューを表示できます'));
    if(button){
      button.replaceChildren(node('span','',host?'プレビューを表示':'プレビュー非対応'));
      button.setAttribute('aria-label',host?.isEmbedded?'埋め込み画像のプレビューを表示':host?`${host.label} のプレビューを表示`:'この画像はプレビューできません');
      if(details){
        details.id=`preview-details-${++this.previewSequence}`;details.replaceChildren();
        if(host)details.append(node('p','preview-source',host.isEmbedded?host.label:`配信元: ${host.label}`));
        if(host&&!host.isEmbedded)details.append(node('p','preview-scope','この配信元の全パス・全ポートが対象です。サイトのログイン状態を使って画像を取得します。この作業ページでは、同じ配信元のプレビューも表示します。'));
        button.setAttribute('aria-describedby',details.id);
      }
      button.title=host?.isEmbedded?'ページに埋め込まれた画像を読み込みます。':host?`${host.label} の画像を取得します。サイトの許可は同じホストの全パス・ポートに適用されます。`:'この画像は安全にプレビューできません';
      this.showPreviewConsent(binding,true);
      button.onclick=event=>{
        event.preventDefault();event.stopPropagation();
        // permissions.request must run in this real click, before any await.
        const permission=this.previews?.grantHost(item.url);
        if(document.activeElement===button){
          const target=kind==='viewer'?(!$('preview-select').disabled?$('preview-select'):$('preview-close'))
            :button.closest('.card')?.querySelector('.image-select:not(:disabled), .preview-open:not(:disabled)')||$('gallery-heading');
          target.focus({preventScroll:true});
        }
        binding.requesting=true;button.disabled=true;
        container.replaceChildren(node('span','preview-error','配信元の許可を確認しています…'));
        Promise.resolve(permission).then(allowed=>{
          if(!allowed){container.replaceChildren(node('span','preview-error','プレビューは許可されませんでした。選択と元形式の保存はできます。'));return;}
          for(const candidate of this.previewBindings)if(candidate.host?.key===host?.key && candidate.visible){this.cancelPreview(candidate);this.loadPreview(candidate);}
        },()=>{container.replaceChildren(node('span','preview-error','プレビューを許可できませんでした。選択と元形式の保存はできます。'));})
          .finally(()=>{binding.requesting=false;this.showPreviewConsent(binding,!binding.handle);});
      };
    }
    if(this.previewObserver && kind==='thumbnail')this.previewObserver.observe(container);
    else this.loadPreview(binding);
  }
  loadPreview(binding){
    if(!this.previews || !binding.host || !binding.visible || binding.pending || binding.handle)return;
    const generation=++binding.generation,controller=new AbortController();binding.controller=controller;binding.pending=true;
    this.showPreviewConsent(binding,true);binding.container.replaceChildren(node('span','preview-error','プレビューを読み込み中…'));
    this.previews.load(binding.item.url,{kind:binding.kind,signal:controller.signal}).then(handle=>{
      if(controller.signal.aborted || generation!==binding.generation || !this.previewBindings.has(binding) || binding.container.isConnected===false){handle.release();return;}
      binding.handle=handle;
      const image=new Image();image.alt=binding.kind==='viewer'?((binding.item.alt||'').trim()||fileLabel(binding.item.url)):'';
      image.referrerPolicy='no-referrer';
      image.onerror=()=>{if(binding.handle===handle){handle.release();binding.handle=null;binding.container.replaceChildren(node('span','preview-error','プレビューを表示できません。元形式の保存はできます。'));this.showPreviewConsent(binding,true);}};
      image.src=handle.url;binding.container.replaceChildren(image);this.showPreviewConsent(binding,false);
      // The generated static image may be resized. Persist validated source
      // dimensions, never the thumbnail's naturalWidth/naturalHeight.
      this.measureSource(binding.item.url,handle.width,handle.height);
    },error=>{
      if(controller.signal.aborted || generation!==binding.generation || !this.previewBindings.has(binding))return;
      binding.container.replaceChildren(node('span','preview-error',publicError(error)));
      this.showPreviewConsent(binding,true);
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
    $('preview-select').disabled=busy;
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
    const filters={query:$('query').value,width:Number($('width').value)||0,height:Number($('height').value)||0,type:$('type').value};
    const all=candidateCatalog(state).map(i=>this.effective(i));
    const retained=new Set(all.map(item=>item.url));
    if(this.viewerURL&&!retained.has(this.viewerURL)){$('image-preview').close();this.clearPreviews('viewer');this.viewerURL=null;}
    for(const url of this.measured.keys())if(!retained.has(url))this.measured.delete(url);
    const page=(state.items || []).map(i=>this.effective(i));
    const candidates=this.mode==='selected'?all.filter(i=>selected.has(i.url)):
      page.filter(i=>candidateMatches(i,filters) && (this.mode!=='added'||(state.scan?.addedURLs||[]).includes(i.url)));
    this.visible=this.mode==='selected'?candidates:representativeCandidates(candidates);
    $('count').textContent=`表示${this.visible.length} / ${this.mode==='selected'?'選択':'全'}${this.mode==='selected'?selected.size:page.length}件`;
    $('view-all').setAttribute('aria-pressed',String(this.mode==='all'));
    $('view-selected').setAttribute('aria-pressed',String(this.mode==='selected'));
    $('view-added').setAttribute('aria-pressed',String(this.mode==='added'));
    $('view-added').hidden=!(state.scan?.addedURLs?.length);
    $('next-page').hidden=!state.scan?.hasMore;
    $('measure-refresh').hidden=true;
    const unknown=candidates.filter(i=>!['decoded','measured'].includes(i.dimensionSource)).length;
    $('dimension-note').hidden=!(unknown&&(filters.width||filters.height));
    $('dimension-note').textContent=`寸法未確認${unknown}件を含みます。画像を表示すると寸法を確認します。`;
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
      if(state.scan?.addedURLs?.includes(item.url))body.append(node('span','new-marker','今回追加'));
      label.append(input,body);
      const jump=node('button','card-save-jump','保存操作へ移動');jump.type='button';jump.onclick=()=>this.focusSave();
      jump.dataset.galleryRole='save';jump.addEventListener('focus',()=>{this.lastURL=item.url;});
      const variants=all.filter(i=>item.groupId && i.groupId===item.groupId);
      const preview=node('button','preview-open',variants.length>1?`確認・他${variants.length-1}候補`:'大きく確認');preview.type='button';
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
      reset.onclick=()=>{if(this.mode!=='all')this.setMode('all');else{for(const id of ['query','width','height','type'])$(id).value=['width','height'].includes(id)?0:'';this.render();this.onView(this.viewPatch());$('query').focus();}};
      $('empty').append(node('p','',page.length?'表示条件を変えるか、すべての画像へ戻れます。':'元ページで画像を表示して、再スキャンしてください。'),reset);
    }
    this.sync();
    if(oldURL)this.restoreFocus(oldURL,oldRole,oldIndex);
    else if(active===$('measure-refresh')&&active.hidden)$('gallery-heading').focus();
    this.onRender?.(this.visible);
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
