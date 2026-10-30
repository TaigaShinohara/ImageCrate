import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePart,mediaType,allowedURL,extensionOf,fileLabel,downloadName,matchesImage,mergeItems,summarizeJobs,publicError} from '../extension/utils.js';
test('filenames stay inside chosen download folder',()=>{
  assert.equal(sanitizePart('../../bad\\name:*'),'_.._bad_name__');
  assert.equal(sanitizePart('..'),'untitled');
  assert.equal(sanitizePart('CON'),'_CON');
  const name=downloadName({url:'https://example.test/a%2Fb.png?token=private'},'../../outside',0,'images');
  assert.equal(name.split('/').length,3);assert.ok(!name.includes('token'));
  assert.ok(name.endsWith('.png'));assert.ok(!name.split('/').some(p=>p==='..'));
});
test('reject executable and credential-bearing URLs',()=>{
  for(const url of ['javascript:alert(1)','file:///tmp/a.png','https://u:p@example.test/image.png','data:text/html,test'])assert.equal(allowedURL(url,'images'),false);
  assert.equal(allowedURL('https://example.test/image?id=1','images'),true);
  assert.equal(allowedURL('data:image/png;base64,AA==','images'),true);
  assert.equal(allowedURL('data:image/png;base64,AA==','videos'),false);
  assert.equal(allowedURL('data:image/png;base64,'+'a'.repeat(131072),'images'),false);
});
test('streaming manifests never masquerade as direct files',()=>{
  assert.equal(mediaType('https://a.test/a.m3u8?x=1'),'stream');
  assert.equal(mediaType('https://a.test/a.mpd'),'stream');
  assert.equal(mediaType('https://a.test/no-suffix','application/vnd.apple.mpegurl'),'stream');
  assert.equal(mediaType('blob:https://a.test/123'),'blob');
  assert.equal(mediaType('https://a.test/a.webm?auth=yes'),'direct');
  assert.equal(mediaType('https://a.test/resource','video/mp4'),'direct');
  assert.equal(mediaType('https://a.test/resource'),'unknown');
});
test('query strings remain part of identity and do not affect suffixes',()=>{
  assert.equal(extensionOf('https://a.test/a.PNG?size=2','images'),'png');
  assert.equal(extensionOf('data:image/svg+xml;base64,AAA=','images'),'svg');
  assert.equal(fileLabel('https://a.test/photo%20one.jpg?secret=value'),'photo one.jpg');
  assert.equal(extensionOf('https://a.test/endpoint?file=movie.mp4','videos'),'video');
});
test('unknown dimensions are excluded only when requested',()=>{
  const item={url:'https://a.test/photo.png',alt:'海',width:0,height:0};
  assert.ok(matchesImage(item,{}));assert.ok(!matchesImage(item,{width:100}));
  assert.ok(matchesImage({...item,width:300,height:200},{query:'海',width:200,height:100,type:'png'}));
  assert.ok(!matchesImage(item,{query:'mountain'}));
});
test('rescan merges URLs, retains records, and adds variants',()=>{
  const before=[{url:'https://a.test/i?size=1',width:100,alt:'first'}];
  const merged=mergeItems(before,[{url:'https://a.test/i?size=1',width:200},{url:'https://a.test/i?size=2',width:400}]);
  assert.equal(merged.length,2);assert.equal(merged[0].width,200);assert.equal(merged[0].alt,'first');assert.equal(before[0].width,100);
});
test('accepted and queued downloads are not completed',()=>{
  assert.deepEqual(summarizeJobs([{status:'queued'},{status:'in_progress'},{status:'complete'},{status:'interrupted'}]),{total:4,complete:1,interrupted:1,active:2});
});
test('public errors do not reproduce signed media URLs',()=>{
  const s=publicError(new Error('Failed https://example.test/media?secret=token'));
  assert.ok(!s.includes('secret'));assert.ok(s.includes('[URL]'));
  assert.match(publicError({name:'AbortError'}),/キャンセル/);
});
