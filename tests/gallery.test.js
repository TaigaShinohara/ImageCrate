import test from 'node:test';
import assert from 'node:assert/strict';
import {Gallery, candidateCatalog, candidateMatches, representativeCandidates} from '../extension/gallery.js';

const item=(name,extra={})=>({url:`https://images.test/${name}.png`,width:0,height:0,dimensionSource:'unknown',...extra});

test('the gallery retains selected candidates from prior pages and prefers current-page metadata', () => {
  const current=item('current',{width:1600,height:1200,dimensionSource:'decoded',descriptor:'1600w'});
  const selected=item('previous',{groupId:'previous-picture'});
  const candidates=candidateCatalog({items:[current],selectedItems:[selected,item('current',{descriptor:'800w'})]});
  assert.equal(candidates.length,2);
  assert.deepEqual(candidates.find(value=>value.url===current.url),current);
  assert.deepEqual(candidates.find(value=>value.url===selected.url),selected);
  assert.deepEqual(candidateCatalog({}),[]);
});

test('unmeasured and density-corrected source dimensions remain available under size filters', () => {
  const filters={width:1000,height:700};
  assert.equal(candidateMatches(item('unknown'),filters),true);
  assert.equal(candidateMatches(item('source',{width:400,height:300,dimensionSource:'source'}),filters),true);
  assert.equal(candidateMatches(item('small',{width:400,height:300,dimensionSource:'decoded'}),filters),false);
  assert.equal(candidateMatches(item('large',{width:1600,height:1200,dimensionSource:'decoded'}),filters),true);
  assert.equal(candidateMatches(item('short',{width:1600,height:600,dimensionSource:'measured'}),filters),false);
  assert.equal(candidateMatches(item('narrow',{width:900,height:900,dimensionSource:'measured'}),filters),false);
  assert.equal(candidateMatches(item('known',{width:40,height:30,dimensionSource:'measured'}),{}),true);
});

test('keeping unknown dimensions does not bypass text or type conditions', () => {
  assert.equal(candidateMatches(item('landscape'),{query:'landscape',type:'png',width:2000}),true);
  assert.equal(candidateMatches(item('landscape'),{query:'portrait',width:2000}),false);
  assert.equal(candidateMatches(item('landscape'),{type:'jpg',width:2000}),false);
});

test('grouped views prefer the current picture candidate and retain independent images', () => {
  const small=item('small',{groupId:'picture',descriptor:'400w'});
  const current=item('current',{groupId:'picture',isCurrent:true,descriptor:'1200w'});
  const other=item('other',{groupId:'other-picture'});
  const standalone=item('standalone');
  assert.deepEqual(representativeCandidates([small,other,current,standalone]),[current,other,standalone]);
  assert.deepEqual(representativeCandidates([current,small]),[current]);
  assert.deepEqual(representativeCandidates([small,other]),[small,other]);
  assert.deepEqual(representativeCandidates([]),[]);
});

test('adding a preview alternative rebuilds the selected view after optimistic selection persistence', async () => {
  const original=item('small',{groupId:'picture'}),alternative=item('large',{groupId:'picture'});
  const state={items:[original,alternative]};
  let selected=new Set([original.url]),resolveSave;
  const saved=new Promise(resolve=>{resolveSave=resolve;});
  const origin={role:'preview',url:original.url};
  const gallery=Object.assign(Object.create(Gallery.prototype),{
    mode:'selected',visible:[original],viewerURL:alternative.url,viewerURLs:[original.url],returnURL:original.url,returnTarget:origin,
    getSelected:()=>selected,
    // workspace.persistUI updates selection before its asynchronous write.
    onSelect:urls=>{selected=new Set(urls);return saved;},
    sync(){},
    render(){this.visible=candidateCatalog(state).filter(candidate=>selected.has(candidate.url));},
    onError(error){throw error;},
  });
  const pending=gallery.select(alternative.url,true);
  assert.equal(selected.has(alternative.url),true,'optimistic state already contains the new alternative');
  assert.deepEqual(gallery.visible,[original],'the pending save has not rebuilt the list yet');
  resolveSave();await pending;
  assert.deepEqual(gallery.visible,[original,alternative],'selected view includes the newly selected URL');
  assert.equal(gallery.viewerURL,alternative.url,'the current preview is kept');
  assert.equal(gallery.returnTarget,origin,'the preview origin remains available for focus restoration');
  assert.equal(gallery.returnURL,original.url);
});

test('selected view still rebuilds on removal while other views only synchronize controls', async () => {
  for(const mode of ['selected','all','added']) {
    let selected=new Set(['https://images.test/one.png']),renders=0,syncs=0;
    const gallery=Object.assign(Object.create(Gallery.prototype),{
      mode,getSelected:()=>selected,onSelect:async urls=>{selected=new Set(urls);},
      sync(){syncs++;},render(){renders++;},onError(error){throw error;},
    });
    await gallery.select('https://images.test/one.png',false);
    assert.equal(selected.size,0);
    assert.equal(syncs,1);
    assert.equal(renders,mode==='selected'?1:0,mode);
  }
});

test('render publishes the rebuilt selected list after cards and preview controls are synchronized', () => {
  const previousDocument=globalThis.document,previousImage=globalThis.Image;
  const elements=new Map();
  const makeNode=tag=>({
    tagName:tag.toUpperCase(),children:[],dataset:{},attributes:{},className:'',hidden:false,disabled:false,value:'',
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},
    setAttribute(name,value){this.attributes[name]=String(value);},addEventListener(){},closest(){return null;},
    focus(){globalThis.document.activeElement=this;},scrollIntoView(){},
  });
  const descendants=function*(node){for(const child of node.children){yield child;yield* descendants(child);}};
  globalThis.document={
    activeElement:null,createElement:makeNode,
    getElementById(id){if(!elements.has(id))elements.set(id,makeNode('div'));return elements.get(id);},
    querySelectorAll(selector){return [...descendants(this.getElementById('grid'))].filter(node=>selector==='.image-select'&&node.className==='image-select');},
  };
  globalThis.Image=function(){return makeNode('img');};
  try {
    const original=item('small',{groupId:'picture'}),alternative=item('large',{groupId:'picture'});
    const selected=new Set([original.url,alternative.url]);
    const state={items:[original,alternative],jobs:[],selectedItems:[]};
    let calls=0,hidden=1;
    const gallery=new Gallery({getState:()=>state,getSelected:()=>selected,status:()=>'',onRender:items=>{
      calls++;
      assert.equal(items,gallery.visible);
      assert.equal(document.getElementById('grid').children.length,2,'the callback sees the completed card rebuild');
      assert.equal(document.getElementById('preview-select').checked,true,'preview state is already synchronized');
      hidden=[...selected].filter(url=>!items.some(candidate=>candidate.url===url)).length;
      gallery.setBusy(false); // workspace.updateSummary does this without another render.
    }});
    gallery.mode='selected';gallery.viewerURL=alternative.url;
    const previewSelection=document.getElementById('preview-select');document.activeElement=previewSelection;
    gallery.render();
    assert.equal(calls,1,'summary notification does not recurse through setBusy');
    assert.equal(hidden,0,'the published list clears the obsolete hidden-selection count');
    assert.equal(document.activeElement,previewSelection,'the open preview keeps focus');
    assert.equal(gallery.viewerURL,alternative.url);
    const withoutCallback=new Gallery({getState:()=>state,getSelected:()=>selected,status:()=>''});
    assert.doesNotThrow(()=>withoutCallback.render(),'onRender remains optional');
  } finally {
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
    if(previousImage===undefined)delete globalThis.Image;else globalThis.Image=previousImage;
  }
});
