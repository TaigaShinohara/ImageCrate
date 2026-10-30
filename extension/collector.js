// Injected as a self-contained function into the authorized source document.
export function collect() {

  const items = new Map();
  const notices = new Set();
  const seenDocs = new Set();
  let visited = 0, dataBytes = 0;
  const LIMIT = 500, NODE_LIMIT = 12000;
  const add = (raw, metadata = {}, base = document.baseURI) => {
    if (!raw || items.size >= LIMIT) { if (items.size >= LIMIT) notices.add('候補は500件までです。表示範囲を絞って再取得してください。'); return; }
    try {
      const u = new URL(raw, base); u.hash = '';
      const url = u.href;
      if (u.username || u.password || url.length > 131072) return;
      const supported = /^https?:$/.test(u.protocol) || ("images" === 'images' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);/i.test(url));
      if ("images" === 'images' && !supported) { if(u.protocol === 'blob:') notices.add('ページ内blob画像は今回の直接保存に未対応です。'); return; }
      if ("images" === 'videos' && !supported && u.protocol !== 'blob:') return;
      if (u.protocol === 'data:' && !items.has(url)) { dataBytes += url.length; if (dataBytes > 524288) { notices.add('埋め込み画像の取得量を制限しました。'); return; } }
      const old = items.get(url);
      items.set(url, {...old, url, ...metadata, width: Math.max(old?.width || 0, metadata.width || 0), height: Math.max(old?.height || 0, metadata.height || 0)});
    } catch { /* ignore malformed/unusable page values */ }
  };
  const walkDocument = doc => {
    if (seenDocs.has(doc)) return;
    seenDocs.add(doc);
    const view = doc.defaultView;
    const walk = root => {
      for (const el of root.querySelectorAll('*')) {
        if (++visited > NODE_LIMIT) { notices.add('要素数が多いため取得を12000要素に制限しました。'); return; }
        const base = el.baseURI || doc.baseURI;

        if (el.tagName === 'IMG') {
          const meta = {width:el.naturalWidth || 0, height:el.naturalHeight || 0, alt:(el.alt || '').slice(0,160), source:'img'};
          for (const src of [el.currentSrc, el.getAttribute('src'), el.getAttribute('data-src'), el.getAttribute('data-original'), el.getAttribute('data-lazy-src')]) add(src, src === el.currentSrc ? meta : {...meta,width:0,height:0}, base);
        }
        if (el.tagName === 'IMG' || (el.tagName === 'SOURCE' && el.parentElement?.tagName === 'PICTURE')) {
          // Responsive candidates are separate URLs. Unknown dimensions stay unknown.
          const set = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
          // Follow srcset tokenization: commas inside URL tokens are part of the URL.
          // Only trailing commas or commas after whitespace/descriptors split candidates.
          let pos=0;
          while(pos<set.length) {
            while(pos<set.length && /[\t\n\f\r ,]/.test(set[pos]))pos++;
            const start=pos;
            while(pos<set.length && !/[\t\n\f\r ]/.test(set[pos]))pos++;
            let url=set.slice(start,pos);
            if(!url)break;
            let descriptors='';
            if(url.endsWith(',')) url=url.replace(/,+$/,'');
            else {
              let depth=0;
              while(pos<set.length) {
                const ch=set[pos++];
                if(ch===',' && !depth)break;
                if(ch==='(')depth++;
                if(ch===')')depth=Math.max(0,depth-1);
                descriptors+=ch;
              }
            }
            const tokens=descriptors.trim().split(/\s+/).filter(Boolean);
            const valid=!tokens.length || (tokens.length===1 && (/^[1-9]\d*w$/.test(tokens[0]) || /^(?:\d+(?:\.\d+)?|\.\d+)x$/.test(tokens[0]) && Number.parseFloat(tokens[0])>0));
            if(valid)add(url,{source:'srcset'},base);
          }
        }
        const bg = view.getComputedStyle(el).backgroundImage;
        for (const match of bg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) add(match[1] || match[2] || match[3], {source:'background'}, base);

        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try { const child = el.contentDocument; if(child) walkDocument(child); else notices.add('別ドメインの埋め込み内は取得できません。'); }
          catch { notices.add('別ドメインの埋め込み内は取得できません。'); }
        }
      }
    };
    walk(doc);

  };
  walkDocument(document);
  return {items:[...items.values()], notices:[...notices]};

}
