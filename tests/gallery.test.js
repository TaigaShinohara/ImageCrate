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

test('maximum dimension filters retain unknown dimensions and exclude oversized candidates', () => {
  const filters={maxWidth:1000,maxHeight:700};
  assert.equal(candidateMatches(item('unknown'),filters),true,'unknown dimensions are kept');
  assert.equal(candidateMatches(item('source',{width:1400,height:900,dimensionSource:'source'}),filters),true,'source estimates are kept');
  assert.equal(candidateMatches(item('small',{width:400,height:300,dimensionSource:'decoded'}),filters),true);
  assert.equal(candidateMatches(item('too-wide',{width:1200,height:500,dimensionSource:'decoded'}),filters),false);
  assert.equal(candidateMatches(item('too-tall',{width:800,height:800,dimensionSource:'measured'}),filters),false);
  assert.equal(candidateMatches(item('exact',{width:1000,height:700,dimensionSource:'measured'}),filters),true);
});

test('keeping unknown dimensions does not bypass text or type conditions', () => {
  assert.equal(candidateMatches(item('landscape'),{query:'landscape',type:'png',width:2000}),true);
  assert.equal(candidateMatches(item('landscape'),{query:'portrait',width:2000}),false);
  assert.equal(candidateMatches(item('landscape'),{type:'jpg',width:2000}),false);
});

test('ad-like exclusions are opt-in and include both orientations at the ratio and short-side boundaries', () => {
  const filters={excludeAdLike:true};
  for(const [width,height,expected] of [
    [599,200,true],[600,200,false],[200,599,true],[200,600,false],
    [200,200,true],[199,200,false],[200,199,false],[1200,800,true],
  ]) {
    const candidate=item('size',{width,height,dimensionSource:'decoded'});
    assert.equal(candidateMatches(candidate,filters),expected,`${width} × ${height}`);
    assert.equal(candidateMatches(candidate,{}),true,'new exclusions are disabled by default');
    assert.equal(candidateMatches(candidate,{excludeAdLike:false}),true);
  }
  assert.equal(candidateMatches(item('tiny',{width:1,height:1,dimensionSource:'source',detectedFormat:'gif'}),{}),true);
});

test('the ad-like heuristic can use source dimensions without changing the existing minimum-size contract', () => {
  for(const dimensionSource of ['source','decoded','measured']) {
    assert.equal(candidateMatches(item('banner',{width:900,height:300,dimensionSource}),{excludeAdLike:true}),false,dimensionSource);
    assert.equal(candidateMatches(item('small',{width:199,height:199,dimensionSource}),{excludeAdLike:true}),false,dimensionSource);
  }
  const source=item('source',{width:400,height:300,dimensionSource:'source'});
  const filters={excludeAdLike:true,width:1000,height:700};
  assert.equal(candidateMatches(source,filters),true,'source estimates still do not enforce exact minimum dimensions');
  const gallery=Object.assign(Object.create(Gallery.prototype),{measured:new Map([[source.url,{width:1200,height:800,detectedFormat:'png'}]])});
  assert.equal(candidateMatches(gallery.effective(source),filters),true,'inspected source pixels take precedence over the page estimate');
  gallery.measured.set(source.url,{width:150,height:150,detectedFormat:'png'});
  assert.equal(candidateMatches(gallery.effective(source),{excludeAdLike:true}),false);
});

test('missing or invalid dimension pairs remain visible until they can be assessed', () => {
  for(const [width,height] of [[0,0],[0,100],[100,0],[-1,100],[100,-1],[NaN,100],[100,NaN],[Infinity,100],[100,Infinity],[undefined,100],[100,undefined]]) {
    assert.equal(candidateMatches(item('unknown',{width,height,dimensionSource:'source'}),{excludeAdLike:true}),true,`${width} × ${height}`);
  }
});

test('all GIF candidates are excluded from URL or embedded MIME while query text remains unknown', () => {
  const filters={excludeAdLike:true};
  for(const url of ['https://images.test/static.gif','https://images.test/animated.GIF?size=2','data:image/gif;base64,AA==','data:IMAGE/GIF;base64,AA==']) {
    for(const frameCount of [1,2])assert.equal(candidateMatches(item('gif',{url,frameCount}),filters),false,url);
  }
  for(const url of ['https://images.test/asset?format=gif','https://images.test/photo.png?name=ad.gif','https://images.test/asset']) {
    assert.equal(candidateMatches(item('unknown',{url}),filters),true,url);
  }
});

test('tracking beacon imp candidates are excluded under excludeAdLike without dimensions', () => {
  const filters={excludeAdLike:true};
  for(const url of [
    'https://js.dsp.bance.jp/imp',
    'https://js.dsp.bance.jp/imp?bid=123',
    'https://ad.example.com/ad/imp.png',
    'https://ad.example.com/imp_123',
    'https://ad.example.com/imp-pixel',
    'https://ad.example.com/imp/pixel.gif',
  ]) {
    assert.equal(candidateMatches(item('beacon',{url}),filters),false,url);
    assert.equal(candidateMatches(item('beacon',{url}),{excludeAdLike:false}),true,`${url} (disabled)`);
  }
  for(const url of [
    'https://site.test/simple.jpg',
    'https://site.test/important.png',
    'https://site.test/shrimp.webp',
  ]) {
    assert.equal(candidateMatches(item('normal',{url}),filters),true,url);
  }
});

test('tracking beacon, ad network domains and standard ad banners are excluded while substantial content is preserved', () => {
  const filters={excludeAdLike:true};
  // 広告配信ドメイン・ビーコン・バナー名
  for(const url of [
    'https://js.dsp.bance.jp/infomark.png',
    'https://pagead2.googlesyndication.com/pagead/imgad?id=123',
    'https://securepubads.g.doubleclick.net/gampad/ad.jpg',
    'https://static.criteo.net/ad.png',
    'https://site.test/assets/ad-banner-top.jpg',
    'https://site.test/pixel.gif',
    'https://site.test/1x1.png',
  ]) {
    assert.equal(candidateMatches(item('ad',{url}),filters),false,url);
  }

  // IAB標準バナーサイズ（728x90, 300x250, 160x600等）
  for(const [width,height] of [[728,90],[90,728],[300,250],[250,300],[160,600],[600,160],[320,50],[468,60]]) {
    assert.equal(candidateMatches(item('standard-ad',{width,height,dimensionSource:'decoded'}),filters),false,`${width}x${height}`);
  }

  // 元ページの縦長コンテンツ（Webtoon漫画）や高解像度コンテンツは保護される
  const webtoon=item('webtoon',{url:'https://site.test/comic/ch1_p01.jpg',width:800,height:3200,dimensionSource:'decoded',detectedFormat:'jpeg'});
  assert.equal(candidateMatches(webtoon,filters),true,'vertical Webtoon is protected from 3:1 ratio exclusion');

  const panorama=item('panorama',{url:'https://site.test/gallery/wide.png',width:2400,height:600,dimensionSource:'decoded',detectedFormat:'png'});
  assert.equal(candidateMatches(panorama,filters),true,'high-res panorama is protected from 3:1 ratio exclusion');

  const regularComic=item('comic',{url:'https://site.test/comic/1.webp',width:1000,height:1414,dimensionSource:'decoded',detectedFormat:'webp'});
  assert.equal(candidateMatches(regularComic,filters),true,'standard comic page is preserved');
});

test('inspected formats override URL hints and ad-like exclusions compose with existing conditions', () => {
  const filters={excludeAdLike:true};
  assert.equal(candidateMatches(item('hidden',{url:'https://images.test/asset',detectedFormat:'gif'}),filters),false);
  assert.equal(candidateMatches(item('disguised',{detectedFormat:'gif'}),filters),false);
  assert.equal(candidateMatches(item('actual-photo',{url:'https://images.test/photo.gif',detectedFormat:'jpeg'}),filters),true);
  const photo=item('landscape',{width:1200,height:800,dimensionSource:'decoded',detectedFormat:'png'});
  assert.equal(candidateMatches(photo,{...filters,query:'landscape',width:1000,height:700,type:'png'}),true);
  for(const extra of [{query:'portrait'},{width:1300},{height:900},{type:'jpg'}]) {
    assert.equal(candidateMatches(photo,{...filters,...extra}),false,JSON.stringify(extra));
  }
  assert.equal(candidateMatches(item('unknown'),{...filters,query:'missing'}),false);
  assert.equal(candidateMatches(item('unknown'),{...filters,type:'gif'}),false);
});

test('a same-size format update is persisted and offered explicitly without rebuilding cards', () => {
  const previousDocument=globalThis.document;
  const controls=new Map([
    ['width',{value:'0'}],['height',{value:'0'}],['exclude-ad-like',{checked:true}],['measure-refresh',{hidden:true}],
  ]);
  globalThis.document={getElementById:id=>controls.get(id),querySelectorAll:()=>[]};
  try {
    const candidate=item('asset'),updates=[],visible=[candidate];let renders=0;
    const gallery=Object.assign(Object.create(Gallery.prototype),{
      measured:new Map(),visible,onMeasure:update=>updates.push(update),item:()=>candidate,render(){renders++;},
    });
    gallery.measureSource(candidate.url,400,300,'png');
    controls.get('measure-refresh').hidden=true;
    gallery.measureSource(candidate.url,400,300,'gif');
    assert.equal(updates.length,2,'a newly inspected format is not mistaken for an unchanged size');
    assert.deepEqual(updates[1],{url:candidate.url,width:400,height:300,detectedFormat:'gif'});
    assert.equal(controls.get('measure-refresh').hidden,false,'format-only discovery offers a manual filter update');
    assert.equal(renders,0,'preview inspection never removes cards immediately');
    assert.equal(gallery.visible,visible);
    assert.equal(gallery.effective(candidate).detectedFormat,'gif');
    gallery.measureSource(candidate.url,400,300,'gif');
    assert.equal(updates.length,2,'identical inspected metadata does not trigger another update');
    gallery.measureSource(candidate.url,400,300,'not-an-image-format');
    assert.equal(gallery.effective(candidate).detectedFormat,'gif','invalid format input cannot erase inspected metadata');
  } finally {
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
  }
});

test('gallery view restoration preserves the ad-like toggle and existing view fields', () => {
  const previousDocument=globalThis.document,previousWindow=globalThis.window;
  const controls=new Map();
  globalThis.document={getElementById(id){if(!controls.has(id))controls.set(id,{value:'',checked:false,open:false});return controls.get(id);}};
  globalThis.window={scrollY:140};
  try {
    const gallery=Object.assign(Object.create(Gallery.prototype),{});
    gallery.restore({view:'added',query:'landscape',width:400,height:300,type:'png',excludeAdLike:true,filtersOpen:true,focusAnchor:'image'});
    const patch=gallery.viewPatch();
    assert.equal(patch.excludeAdLike,true);
    assert.equal(patch.view,'added');assert.equal(patch.query,'landscape');
    assert.equal(patch.width,400);assert.equal(patch.height,300);assert.equal(patch.type,'png');
    assert.equal(patch.filtersOpen,true);assert.equal(patch.focusAnchor,'image');
    gallery.restore({});
    assert.equal(controls.get('exclude-ad-like').checked,false,'legacy UI state starts with the new toggle off');
  } finally {
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
    if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  }
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
    setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},addEventListener(){},closest(){return null;},
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
    const original=item('small',{groupId:'picture',width:100,height:100,dimensionSource:'source',detectedFormat:'gif'}),alternative=item('large',{groupId:'picture'});
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
    document.getElementById('exclude-ad-like').checked=true;
    gallery.mode='selected';gallery.viewerURL=alternative.url;
    const previewSelection=document.getElementById('preview-select');document.activeElement=previewSelection;
    gallery.render();
    assert.equal(calls,1,'summary notification does not recurse through setBusy');
    assert.equal(hidden,0,'the published list clears the obsolete hidden-selection count');
    assert.equal(document.activeElement,previewSelection,'the open preview keeps focus');
    assert.equal(gallery.viewerURL,alternative.url);
    assert.deepEqual([...selected],[original.url,alternative.url],'selected view retains images excluded by the ad-like heuristic');
    const withoutCallback=new Gallery({getState:()=>state,getSelected:()=>selected,status:()=>''});
    assert.doesNotThrow(()=>withoutCallback.render(),'onRender remains optional');
  } finally {
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
    if(previousImage===undefined)delete globalThis.Image;else globalThis.Image=previousImage;
  }
});

test('viewer touch gestures support horizontal swiping for next/prev navigation and double tap for zoom', () => {
  const previousDocument = globalThis.document;
  const elements = new Map();
  const listeners = new Map();
  const makeNode = tag => ({
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    classList: {
      tokens: new Set(),
      contains(cls) { return this.tokens.has(cls); },
      add(cls) { this.tokens.add(cls); },
      remove(cls) { this.tokens.delete(cls); },
      toggle(cls) { if(this.tokens.has(cls)){this.tokens.delete(cls);return false;}else{this.tokens.add(cls);return true;} }
    },
    attributes: {},
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(event, fn) {
      if (!listeners.has(this)) listeners.set(this, new Map());
      const map = listeners.get(this);
      if (!map.has(event)) map.set(event, []);
      map.get(event).push(fn);
    },
    dispatchEvent(e) {
      const fns = listeners.get(this)?.get(e.type) || [];
      for (const fn of fns) fn(e);
    },
    click() {
      this.dispatchEvent({ type: 'click' });
    },
    closest() { return null; },
    focus() { globalThis.document.activeElement = this; },
  });

  globalThis.document = {
    activeElement: null,
    createElement: makeNode,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeNode(id.includes('preview') || id.includes('view') ? 'button' : 'div'));
      return elements.get(id);
    },
  };

  try {
    let showViewerCalls = [];
    let zoomClicks = 0;
    const stage = document.getElementById('preview-stage');
    const zoomBtn = document.getElementById('preview-zoom');
    zoomBtn.addEventListener('click', () => { zoomClicks++; });

    const gallery = Object.assign(Object.create(Gallery.prototype), {
      viewerURLs: ['https://images.test/1.png', 'https://images.test/2.png', 'https://images.test/3.png'],
      viewerIndex: 1,
      showViewer(url) { showViewerCalls.push(url); }
    });

    gallery.setupViewerGestures();

    const touchstart = (x, y) => {
      stage.dispatchEvent({
        type: 'touchstart',
        touches: [{ clientX: x, clientY: y }]
      });
    };
    const touchend = (x, y) => {
      stage.dispatchEvent({
        type: 'touchend',
        changedTouches: [{ clientX: x, clientY: y }]
      });
    };

    // 1. Swipe left (next image)
    touchstart(200, 100);
    touchend(100, 105);
    assert.deepEqual(showViewerCalls, ['https://images.test/3.png'], 'swipe left navigates to next image');
    showViewerCalls = [];

    // 2. Swipe right (prev image)
    touchstart(100, 100);
    touchend(220, 102);
    assert.deepEqual(showViewerCalls, ['https://images.test/1.png'], 'swipe right navigates to previous image');
    showViewerCalls = [];

    // 3. Vertical swipe (should not navigate)
    touchstart(100, 100);
    touchend(110, 220);
    assert.deepEqual(showViewerCalls, [], 'vertical swipe does not trigger image navigation');

    // 4. Swipe while actual-size zoom is active (should not navigate)
    stage.classList.add('actual-size');
    touchstart(200, 100);
    touchend(80, 100);
    assert.deepEqual(showViewerCalls, [], 'swipe does not trigger navigation when zoomed to actual size');
    stage.classList.remove('actual-size');

    // 5. Double tap triggers zoom toggle
    touchstart(150, 150);
    touchend(150, 150);
    assert.equal(zoomClicks, 0, 'first tap does not trigger zoom');
    touchstart(152, 151);
    assert.equal(zoomClicks, 1, 'double tap triggers zoom button click');
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});
