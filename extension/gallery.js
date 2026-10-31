import {fileLabel, extensionOf, matchesImage} from './utils.js';

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
  constructor({getState,getSelected,onSelect,onView,onMeasure,onError,status}) {
    Object.assign(this,{getState,getSelected,onSelect,onView,onMeasure,onError,status});
    this.visible=[];this.measured=new Map();this.mode='all';this.lastURL='';this.viewerURLs=[];this.viewerIndex=0;
    $('view-all').addEventListener('click',()=>this.setMode('all'));
    $('view-selected').addEventListener('click',()=>this.setMode('selected'));
    $('view-added').addEventListener('click',()=>this.setMode('added'));
    $('selection').addEventListener('click',()=>this.setMode('selected'));
    $('measure-refresh').addEventListener('click',()=>this.render());
    $('preview-close').addEventListener('click',()=>$('image-preview').close());
    $('image-preview').addEventListener('close',()=>this.restoreViewerFocus());
    $('preview-prev').addEventListener('click',()=>this.showViewer(this.viewerURLs[this.viewerIndex-1]));
    $('preview-next').addEventListener('click',()=>this.showViewer(this.viewerURLs[this.viewerIndex+1]));
    $('preview-zoom').addEventListener('click',()=>{
      const actual=$('preview-stage').classList.toggle('actual-size');
      $('preview-zoom').textContent=actual?'全体を表示':'100%で表示';$('preview-zoom').setAttribute('aria-pressed',String(actual));
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
    if(!image.naturalWidth || !image.naturalHeight)return;
    const value={width:image.naturalWidth,height:image.naturalHeight};
    if(JSON.stringify(this.measured.get(url))===JSON.stringify(value))return;
    this.measured.set(url,value);this.onMeasure({url,...value});
    for(const meta of document.querySelectorAll('[data-dimensions]'))if(meta.dataset.dimensions===url)meta.textContent=`${value.width} × ${value.height}`;
    if(Number($('width').value)||Number($('height').value))$('measure-refresh').hidden=false;
    const item=this.item(url);
    if(this.viewerURL===url&&item)$('preview-meta').textContent=this.description(this.effective(item));
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
    try {await this.onSelect([...next]);this.sync();if(this.mode==='selected' && !checked)this.render();}
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
    const state=this.getState(),selected=this.getSelected(),active=document.activeElement;
    const oldCard=active?.closest('#grid .card'),oldURL=oldCard?.dataset.url,oldRole=active?.dataset.galleryRole;
    const oldIndex=this.visible.findIndex(item=>item.url===oldURL);
    const filters={query:$('query').value,width:Number($('width').value)||0,height:Number($('height').value)||0,type:$('type').value};
    const all=candidateCatalog(state).map(i=>this.effective(i));
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
      const label=node('label','card-select'),thumb=node('div','thumb');
      const input=node('input','image-select');input.type='checkbox';input.dataset.url=item.url;input.checked=selected.has(item.url);
      input.dataset.galleryRole='select';
      const nameText=(item.alt || '').trim() || fileLabel(item.url);
      input.setAttribute('aria-label',`${index+1}. ${nameText}を選択`);
      input.setAttribute('aria-describedby',`image-meta-${index} image-status-${index}`);
      input.addEventListener('focus',()=>{this.lastURL=item.url;});
      input.addEventListener('change',()=>this.select(item.url,input.checked));
      const image=new Image();image.loading='lazy';image.alt='';image.referrerPolicy='no-referrer';
      image.onload=()=>this.measure(item.url,image);
      image.onerror=()=>{thumb.replaceChildren(node('span','preview-error','プレビューなし'));};image.src=item.url;thumb.append(image);
      const body=node('div','card-body'),name=node('strong','file-name',fileLabel(item.url));name.title=name.textContent;
      const meta=node('span','meta');meta.id=`image-meta-${index}`;
      const dims=node('span','',this.dimensions(item));dims.dataset.dimensions=item.url;
      const ext=extensionOf(item.url,'images');meta.append(dims,node('span','file-type',ext==='img'?'形式不明':ext.toUpperCase()));
      const status=node('span','item-status',this.status(item.url));status.id=`image-status-${index}`;status.dataset.url=item.url;
      status.dataset.state=(state.jobs.find(j=>j.url===item.url)||state.history?.find(j=>j.url===item.url))?.status || '';
      body.append(name,meta,status);
      if(state.scan?.addedURLs?.includes(item.url))body.append(node('span','new-marker','今回追加'));
      label.append(input,thumb,body);
      const jump=node('button','card-save-jump','保存操作へ移動');jump.type='button';jump.onclick=()=>this.focusSave();
      jump.dataset.galleryRole='save';jump.addEventListener('focus',()=>{this.lastURL=item.url;});
      const variants=all.filter(i=>item.groupId && i.groupId===item.groupId);
      const preview=node('button','preview-open',variants.length>1?`確認・他${variants.length-1}候補`:'大きく確認');preview.type='button';
      preview.dataset.galleryRole='preview';preview.addEventListener('focus',()=>{this.lastURL=item.url;});
      preview.onclick=()=>this.openViewer(item.url,preview);
      card.append(label,jump,preview);$('grid').append(card);
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
  }
  openViewer(url,origin=document.activeElement) {
    this.returnURL=url;this.viewerURLs=this.visible.map(i=>i.url);
    this.returnIndex=this.viewerURLs.indexOf(url);
    this.returnTarget=origin?.matches('.preview-open')?origin:null;
    if(!this.viewerURLs.includes(url))this.viewerURLs.push(url);
    $('preview-stage').classList.remove('actual-size');$('preview-zoom').textContent='100%で表示';$('preview-zoom').setAttribute('aria-pressed','false');
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
    const image=new Image();image.alt=(item.alt||'').trim()||fileLabel(url);image.referrerPolicy='no-referrer';
    image.onload=()=>{if(this.viewerURL===url)this.measure(url,image);};
    image.onerror=()=>{if(this.viewerURL===url)$('preview-stage').replaceChildren(node('p','preview-error','画像を表示できません。選択と保存は引き続き試せます。'));};
    image.src=url;$('preview-stage').replaceChildren(image);
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
