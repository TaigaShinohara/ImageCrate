import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../extension/collector.js';

function collectSet(srcset) {
  const source={tagName:'SOURCE',parentElement:{tagName:'PICTURE'},baseURI:'https://example.test/gallery/',getAttribute:name=>name==='srcset'?srcset:null};
  const doc={baseURI:'https://example.test/gallery/',querySelectorAll:()=>[source],defaultView:{getComputedStyle:()=>({backgroundImage:'none'})}};
  const previous=globalThis.document;globalThis.document=doc;
  try{return collect().items.map(item=>item.url);}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
}
test('srcset preserves internal CDN URL commas and signed queries',()=>{
  assert.deepEqual(collectSet('https://cdn.test/upload/w_100,c_scale/photo.jpg 1x, https://cdn.test/upload/w_200,c_scale/photo.jpg?sig=1 2x'),[
    'https://cdn.test/upload/w_100,c_scale/photo.jpg','https://cdn.test/upload/w_200,c_scale/photo.jpg?sig=1',
  ]);
});
test('srcset separates trailing comma, width and density candidates',()=>{
  assert.deepEqual(collectSet('a.png, b.png 400w, c.png 2x'),['https://example.test/gallery/a.png','https://example.test/gallery/b.png','https://example.test/gallery/c.png']);
  assert.deepEqual(collectSet('bad.png 0x, good.png 1x, wrong.png nope'),['https://example.test/gallery/good.png']);
});
