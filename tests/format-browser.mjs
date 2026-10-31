// Real browser encoders, decoder pixels, File System Access writes and Chrome
// downloads. Only picker / permission / one fetch failure decisions are mocked.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const MIME={jpg:'image/jpeg',png:'image/png',webp:'image/webp'};
function assertMagic(bytes,format,label) {
  const buffer=Buffer.from(bytes);
  if(format==='jpg')assert.deepEqual([...buffer.subarray(0,3)],[255,216,255],`${label}: JPEG signature`);
  if(format==='png')assert.deepEqual([...buffer.subarray(0,8)],[137,80,78,71,13,10,26,10],`${label}: PNG signature`);
  if(format==='webp') {
    assert.equal(buffer.toString('ascii',0,4),'RIFF',`${label}: RIFF signature`);
    assert.equal(buffer.toString('ascii',8,12),'WEBP',`${label}: WebP signature`);
  }
}
function near(actual,expected,tolerance,label) {
  for(let index=0;index<4;index++)assert.ok(Math.abs(actual[index]-expected[index])<=tolerance,`${label}: channel ${index}, actual ${actual}, expected ${expected}`);
}

export async function runFormatChecks({manager,worker,origin,downloadFolder}) {
  const key=await manager.evaluate(()=>`workspace:${new URL(location.href).searchParams.get('id')}`);
  const readState=()=>worker.evaluate(async key=>(await chrome.storage.session.get(key))[key],key);
  const original=await readState();
  const originalLocal=await manager.evaluate(()=>chrome.storage.local.get(null));
  const originalViewport=manager.viewportSize();
  const backupPrefix=`qa:format:${original.id}:`;
  const directoryName='ImageCrate形式検証';
  // Startup prunes stale batch handles. Keep backups under non-session keys so
  // restoring the old session also restores its original selected folder.
  await manager.evaluate(async({id,batchId,prefix})=>{
    const {getDirectory,putDirectory}=await import('./directory-store.js');
    for(const [name,key] of [['session',`session:${id}`],['last','last'],['batch',`batch:${batchId}`]]) {
      const handle=await getDirectory(key);if(handle)await putDirectory(prefix+name,handle);
    }
  },{id:original.id,batchId:original.batch?.id,prefix:backupPrefix});
  const poll=async(predicate,label='format batch',timeout=15000)=>{
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {
      const state=await readState();if(predicate(state))return state;
      await manager.waitForTimeout(25);
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify((await readState()).jobs)}`);
  };
  const reload=async()=>{
    await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
  };
  const settings=async({format,destination='directory',folderName})=>{
    await manager.locator('#destination-change').click();
    await manager.waitForFunction(()=>document.querySelector('#save-settings').open);
    await manager.locator('#output-format').selectOption(format);
    await manager.locator(`#destination-${destination}`).check();
    await manager.locator('#folder-name').fill(folderName);
    await manager.locator('#settings-done').click();
    await manager.waitForFunction(()=>!document.querySelector('#save-settings').open);
    await poll(state=>state.saveSettings?.format===format && state.saveSettings?.folderName===folderName,'persisted format setting');
    assert.ok((await manager.locator('#format-summary').textContent()).trim(),'the next-save format has a visible footer summary');
  };
  const select=async index=>{
    if(await manager.locator('#clear').isEnabled())await manager.locator('#clear').click();
    await manager.locator('.image-select').nth(index).check();
  };
  const save=async(index,status='complete')=>{
    await select(index);const previous=(await readState()).batch?.id;
    await manager.locator('#save').click();
    const state=await poll(state=>state.batch?.id!==previous && state.jobs.length===1 && state.jobs[0].status===status);
    if(status==='complete')await manager.waitForFunction(()=>document.querySelector('#selection').textContent==='選択0件');
    else assert.equal(await manager.locator('.image-select:checked').count(),1,'a failed conversion keeps its image selected');
    return state;
  };
  const directoryFiles=folder=>manager.evaluate(async({name,folder})=>{
    const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    let child;try{child=await directory.getDirectoryHandle(folder);}catch(error){if(error.name==='NotFoundError')return [];throw error;}
    const files=[];
    for await(const [name,handle] of child.entries())if(handle.kind==='file') {
      const file=await handle.getFile();files.push({name,type:file.type,bytes:[...new Uint8Array(await file.arrayBuffer())]});
    }
    return files;
  },{name:directoryName,folder});
  const decode=bytes=>manager.evaluate(async bytes=>{
    const image=await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    try {
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
      return {width:image.width,height:image.height,red:[...context.getImageData(2,8,1,1).data],transparent:[...context.getImageData(14,8,1,1).data],first:[...context.getImageData(0,0,1,1).data]};
    } finally {image.close();}
  },bytes);
  try {
    const fixtures=await manager.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=16;canvas.height=12;
      const context=canvas.getContext('2d');context.fillStyle='#ff0000';context.fillRect(0,0,6,12);
      // PNG permits trailing data after IEND. A same-format conversion must
      // actually re-encode, rather than silently copying these source bytes.
      const taggedURL=type=>{
        const source=Uint8Array.from(atob(canvas.toDataURL(type).split(',')[1]),character=>character.charCodeAt(0));
        const marker=new TextEncoder().encode('SOURCE_METADATA_SENTINEL');
        const tagged=new Uint8Array(source.length+marker.length);tagged.set(source);tagged.set(marker,source.length);
        return `data:${type};base64,${btoa(String.fromCharCode(...tagged))}`;
      };
      const png=taggedURL('image/png'),jpg=taggedURL('image/jpeg'),webp=taggedURL('image/webp');
      const svg='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="6" height="12" fill="red"/></svg>');
      // Two 1×1 frames with a global red/blue palette and distinct LZW pixels.
      const gifBytes=[...new TextEncoder().encode('GIF89a'),1,0,1,0,128,0,0,255,0,0,0,0,255,
        33,255,11,...new TextEncoder().encode('NETSCAPE2.0'),3,1,0,0,0,
        33,249,4,0,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,
        33,249,4,0,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,76,1,0,59];
      return {png,jpg,webp,svg,gif:`data:image/gif;base64,${btoa(String.fromCharCode(...gifBytes))}`,gifBytes,broken:'data:image/png;base64,bm90LWFuLWltYWdl'};
    });
    const items=[
      {url:fixtures.png,width:16,height:12,type:'image',alt:'format-png'},
      {url:fixtures.svg,width:16,height:12,type:'image',alt:'format-svg'},
      {url:fixtures.gif,width:1,height:1,type:'image',alt:'format-animated-gif'},
      {url:fixtures.broken,width:0,height:0,type:'image',alt:'format-broken'},
      {url:origin+'/red.svg',width:400,height:300,type:'image',alt:'format-permission'}
    ];
    await worker.evaluate(async({key,state,items})=>chrome.storage.session.set({[key]:{
      ...state,items,jobs:[],history:[],batch:null,notices:[],scanned:true,
      saveSettings:{destination:'downloads',format:'original',folderName:'形式検証',directoryName:''}
    }}),{key,state:original,items});
    await reload();
    assert.equal(await manager.locator('.image-select:checked').count(),0,'format fixtures start unselected');
    await manager.locator('#destination-change').click();
    assert.deepEqual(await manager.locator('#output-format option').evaluateAll(options=>options.map(option=>option.value)),['original','jpg','png','webp'],'only supported original/JPEG/PNG/WebP output choices are exposed');
    await manager.evaluate(async name=>{
      const root=await navigator.storage.getDirectory();const directory=await root.getDirectoryHandle(name,{create:true});
      Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>directory});
    },directoryName);
    await manager.locator('#choose-directory').click();
    await manager.waitForFunction(()=>document.querySelector('#destination-directory').checked && !document.querySelector('#choose-directory').disabled);
    await manager.locator('#settings-done').click();
    await manager.waitForFunction(()=>!document.querySelector('#save-settings').open);

    // Direct converter checks inspect the actual Blob MIME, encoded signature,
    // dimensions and pixels. The UI saves below inspect the resulting files too.
    for(const format of ['jpg','png','webp']) {
      const converted=await manager.evaluate(async({url,format})=>{
        const {convertImage}=await import('./image-converter.js');
        const blob=await convertImage(url,format,{});
        return {type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]};
      },{url:fixtures.png,format});
      assert.equal(converted.type,MIME[format],`${format}: actual Blob MIME`);assertMagic(converted.bytes,format,format);
      const image=await decode(converted.bytes);assert.deepEqual([image.width,image.height],[16,12],`${format}: dimensions preserved`);
      near(image.red,[255,0,0,255],format==='jpg'?25:3,`${format}: red content retained`);
      if(format==='jpg')near(image.transparent,[255,255,255,255],10,'JPEG flattens transparency to white');
      else assert.equal(image.transparent[3],0,`${format}: transparency retained`);
      if(format==='png')assert.equal(Buffer.from(converted.bytes).includes(Buffer.from('SOURCE_METADATA_SENTINEL')),false,'PNG→PNG re-encodes instead of copying metadata');
      if(format!=='png') {
        const sameFormat=await manager.evaluate(async({url,format})=>{
          const {convertImage}=await import('./image-converter.js');const blob=await convertImage(url,format,{});
          return {type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]};
        },{url:fixtures[format],format});
        assert.equal(sameFormat.type,MIME[format]);assertMagic(sameFormat.bytes,format,`${format}→${format}`);
        assert.equal(Buffer.from(sameFormat.bytes).includes(Buffer.from('SOURCE_METADATA_SENTINEL')),false,`${format}→${format} re-encodes source metadata`);
        const image=await decode(sameFormat.bytes);assert.deepEqual([image.width,image.height],[16,12]);
      }
      await settings({format,folderName:`形式_${format}`});
      const saved=await save(0);assert.equal(saved.batch.format,format);assert.equal(saved.batch.destination,'directory');
      const files=await directoryFiles(`形式_${format}`);assert.equal(files.length,1);assert.match(files[0].name,new RegExp(`\\.${format}$`));
      assertMagic(files[0].bytes,format,`${format} selected-folder file`);
      const actual=await decode(files[0].bytes);assert.deepEqual([actual.width,actual.height],[16,12]);
      if(format==='jpg')near(actual.transparent,[255,255,255,255],10,'saved JPEG has a white background');
      else assert.equal(actual.transparent[3],0,`saved ${format} preserves alpha`);
    }
    await reload();await manager.locator('#destination-change').click();
    assert.equal(await manager.locator('#output-format').inputValue(),'webp','the selected output format survives workspace reload');
    await manager.locator('#settings-done').click();await manager.waitForFunction(()=>!document.querySelector('#save-settings').open);
    await settings({format:'png',folderName:'SVGラスタ'});await save(1);
    const [raster]=await directoryFiles('SVGラスタ');assertMagic(raster.bytes,'png','SVG raster output');
    const rasterImage=await decode(raster.bytes);assert.deepEqual([rasterImage.width,rasterImage.height],[16,12],'SVG uses its decoded natural dimensions');
    near(rasterImage.red,[255,0,0,255],0,'SVG content is actually rasterized');assert.equal(rasterImage.transparent[3],0);

    await settings({format:'original',folderName:'GIF元形式'});const originalGifState=await save(2);
    assert.equal(originalGifState.batch.format,'original');
    const [originalGif]=await directoryFiles('GIF元形式');assert.match(originalGif.name,/\.gif$/);assert.deepEqual(originalGif.bytes,fixtures.gifBytes,'original mode preserves all animated GIF bytes');
    const frameCount=await manager.evaluate(async bytes=>{
      const decoder=new ImageDecoder({data:new Uint8Array(bytes),type:'image/gif'});
      try{await decoder.tracks.ready;return decoder.tracks.selectedTrack.frameCount;}finally{decoder.close();}
    },originalGif.bytes);
    assert.equal(frameCount,2,'the original GIF fixture contains two animation frames');
    for(let attempt=0;attempt<3;attempt++) {
      const converted=await manager.evaluate(async url=>{
        const {convertImage}=await import('./image-converter.js');const blob=await convertImage(url,'png',{});
        return [...new Uint8Array(await blob.arrayBuffer())];
      },fixtures.gif);
      assertMagic(converted,'png','GIF first-frame conversion');const image=await decode(converted);
      assert.deepEqual([image.width,image.height],[1,1]);near(image.first,[255,0,0,255],0,'animated GIF conversion consistently selects its first frame');
      await manager.waitForTimeout(130);
    }
    await settings({format:'png',folderName:'GIF先頭フレーム'});await save(2);
    const [gifFrame]=await directoryFiles('GIF先頭フレーム');assertMagic(gifFrame.bytes,'png','saved GIF first frame');
    near((await decode(gifFrame.bytes)).first,[255,0,0,255],0,'saved GIF first frame is red');

    // Corrupt input must remain a failure; never write an original file while
    // reporting the requested format as completed.
    await settings({format:'webp',folderName:'壊れた画像'});const broken=await save(3,'interrupted');
    assert.equal(broken.jobs[0].downloadId,undefined);assert.equal((await directoryFiles('壊れた画像')).length,0,'a failed decoder writes no original fallback');

    // A failed fetch can recover, but retry retains the previous batch format
    // and destination even when the next-save controls have since changed.
    await manager.evaluate(url=>{
      const fetchImage=window.fetch.bind(window);window.__qaFormatFetchFails=true;
      window.fetch=(input,...rest)=>input===url && window.__qaFormatFetchFails ? Promise.reject(new TypeError('Synthetic first fetch failure')) : fetchImage(input,...rest);
    },fixtures.svg);
    await settings({format:'png',folderName:'元バッチPNG'});const failed=await save(1,'interrupted');
    await settings({format:'jpg',folderName:'次の保存JPEG'});
    assert.match(await manager.locator('#batch-format').textContent(),/PNG/i,'the previous batch format remains visible beside the new next-save format');
    await manager.evaluate(()=>{window.__qaFormatFetchFails=false;});await manager.locator('#retry').click();
    const retried=await poll(state=>state.jobs[0]?.status==='complete','retry of frozen PNG format');
    assert.equal(retried.batch.id,failed.batch.id);assert.equal(retried.batch.format,'png');assert.equal(retried.batch.folderName,'元バッチPNG');
    assert.equal(retried.saveSettings.format,'jpg');assert.equal((await directoryFiles('次の保存JPEG')).length,0);
    const [retryFile]=await directoryFiles('元バッチPNG');assertMagic(retryFile.bytes,'png','retry retains its original encoding');

    // Converted Chrome-default saves use the same real encoder and accepted
    // download ID. CDP may override the requested physical basename, so inspect
    // the frozen job filename and Chrome's actual saved bytes separately.
    await manager.evaluate(()=>{
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      window.__qaFormatBlobURLs=[];
      URL.createObjectURL=blob=>{
        const url=create(blob);window.__qaFormatBlobURLs.push({url,type:blob.type,revoked:false});return url;
      };
      URL.revokeObjectURL=url=>{
        const entry=window.__qaFormatBlobURLs.find(entry=>entry.url===url);if(entry)entry.revoked=true;
        return revoke(url);
      };
    });
    for(const format of ['jpg','png','webp']) {
      await settings({format,destination:'downloads',folderName:`Chrome_${format}`});
      await manager.evaluate(()=>{window.__qaFormatBlobURLs=[];});
      const saved=await save(0);assert.equal(saved.batch.format,format);assert.equal(saved.batch.destination,'downloads');
      assert.match(saved.jobs[0].filename,new RegExp(`^ImageCrate/Chrome_${format}/.*\\.${format}$`));
      assert.ok(Number.isInteger(saved.jobs[0].downloadId),'converted default saving has a tracked Chrome download ID');
      const [download]=await manager.evaluate(id=>chrome.downloads.search({id}),saved.jobs[0].downloadId);
      assert.equal(download.state,'complete');assert.ok(download.filename.startsWith(downloadFolder));
      assert.equal(download.mime,MIME[format],`${format}: Chrome sees the actual encoded MIME`);
      await manager.waitForFunction(url=>window.__qaFormatBlobURLs.some(entry=>entry.url===url && entry.revoked),download.url);
      const blobURLs=await manager.evaluate(()=>window.__qaFormatBlobURLs);
      assert.equal(blobURLs.length,1,`${format}: a converted PNG source creates only its download Blob URL`);
      assert.equal(blobURLs[0].type,MIME[format]);assert.equal(blobURLs[0].url,download.url);
      assert.equal(blobURLs[0].revoked,true,`${format}: the completed download releases its Blob URL`);
      const bytes=[...await readFile(download.filename)];assertMagic(bytes,format,`${format} actual Chrome download`);
      const image=await decode(bytes);assert.deepEqual([image.width,image.height],[16,12]);
      if(format==='jpg')near(image.transparent,[255,255,255,255],10,'downloaded JPEG has white transparency');
      else assert.equal(image.transparent[3],0,`downloaded ${format} retains alpha`);
    }
    await settings({format:'png',destination:'downloads',folderName:'Chrome破損画像'});
    const downloadsBeforeBroken=await manager.evaluate(async()=>new Set((await chrome.downloads.search({})).map(download=>download.id)).size);
    const brokenDefault=await save(3,'interrupted');assert.equal(brokenDefault.jobs[0].downloadId,undefined);
    assert.equal(await manager.evaluate(async()=>(await chrome.downloads.search({})).length),downloadsBeforeBroken,'a decoder failure never downloads the original bytes as a fallback');
    await settings({format:'png',destination:'downloads',folderName:'許可拒否変換'});await select(4);
    const beforePermission=await readState();
    await manager.evaluate(()=>{
      window.__qaFormatOriginalPermissions={contains:chrome.permissions.contains.bind(chrome.permissions),request:chrome.permissions.request.bind(chrome.permissions)};
      chrome.permissions.contains=async()=>false;
      chrome.permissions.request=async options=>{window.__qaFormatDeniedOrigins=options.origins;return false;};
    });
    await manager.locator('#save').click();
    await manager.waitForFunction(()=>window.__qaFormatDeniedOrigins?.length>0 && !document.querySelector('#save').disabled);
    assert.deepEqual(await manager.evaluate(()=>window.__qaFormatDeniedOrigins),['http://127.0.0.1/*']);
    assert.equal((await readState()).batch.id,beforePermission.batch.id,'denied host permission never replaces the previous batch');
    assert.equal(await manager.locator('.image-select:checked').count(),1,'denied host permission retains converted-download selection');
    await manager.evaluate(()=>{chrome.permissions.contains=window.__qaFormatOriginalPermissions.contains;chrome.permissions.request=window.__qaFormatOriginalPermissions.request;});
    if(await manager.locator('#clear').isEnabled())await manager.locator('#clear').click();

    // Include conversion guidance, long Japanese destination names and the
    // real completed batch together in the narrow responsive layout checks.
    const longFolderName='日本語の画像を形式変換して保存するフォルダ'.repeat(8);
    await settings({format:'jpg',destination:'directory',folderName:longFolderName});
    const longNameBatch=await save(0);
    assert.equal(longNameBatch.batch.format,'jpg');assert.equal(longNameBatch.batch.destination,'directory');
    for(const width of [640,360]) {
      await manager.setViewportSize({width,height:800});
      await manager.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
      const footer=await manager.evaluate(()=>{
        const rect=element=>{const {left,right,top,bottom,height}=element.getBoundingClientRect();return {left,right,top,bottom,height};};
        return {overflow:document.documentElement.scrollWidth>innerWidth,width:innerWidth,height:innerHeight,footer:rect(document.querySelector('#footer')),save:rect(document.querySelector('#save')),change:rect(document.querySelector('#destination-change')),warning:document.querySelector('#directory-warning').hidden,batch:document.querySelector('#batch-format').textContent,format:document.querySelector('#format-summary').textContent};
      });
      assert.equal(footer.overflow,false,`${width}px: converted saving with a long destination has no horizontal overflow`);
      for(const [name,rect] of [['footer',footer.footer],['Save',footer.save],['Change',footer.change]]) {
        assert.ok(rect.left>=0 && rect.right<=footer.width+1 && rect.top>=0 && rect.bottom<=footer.height+1,`${width}px: ${name} remains inside the viewport with conversion and batch guidance`);
      }
      assert.equal(footer.warning,false,`${width}px: conversion keeps its open-tab requirement visible`);
      assert.match(footer.batch,/JPEG/i);assert.match(footer.format,/JPEG/i);
      assert.ok(footer.footer.height<footer.height*.6,`${width}px: the converted-save footer leaves room for the gallery`);
      await manager.locator('#destination-change').focus();await manager.keyboard.press('Enter');
      await manager.waitForFunction(()=>document.querySelector('#save-settings').open);
      await manager.locator('#output-format').scrollIntoViewIfNeeded();
      await manager.locator('#output-format').focus();
      const dialog=await manager.evaluate(()=>{
        const box=element=>{const {left,right,top,bottom,width,height}=element.getBoundingClientRect();return {left,right,top,bottom,width,height};};
        const dialog=document.querySelector('#save-settings'),select=document.querySelector('#output-format');
        return {dialog:box(dialog),select:box(select),width:innerWidth,height:innerHeight,overflow:dialog.scrollWidth>dialog.clientWidth,format:select.value,detailsVisible:!document.querySelector('#format-details').hidden,preview:document.querySelector('#destination-preview').textContent};
      });
      assert.equal(dialog.overflow,false,`${width}px: long names and conversion details wrap inside the modal`);
      assert.ok(dialog.dialog.left>=0 && dialog.dialog.right<=dialog.width+1 && dialog.dialog.top>=0 && dialog.dialog.bottom<=dialog.height+1,`${width}px: the converted-save modal stays inside the viewport`);
      assert.ok(dialog.select.width>0 && dialog.select.height>=44,`${width}px: output format has a usable native selector`);
      assert.ok(dialog.select.left>=dialog.dialog.left && dialog.select.right<=dialog.dialog.right && dialog.select.top>=dialog.dialog.top && dialog.select.bottom<=dialog.dialog.bottom,`${width}px: the focused output selector remains inside the modal`);
      assert.equal(dialog.format,'jpg');assert.equal(dialog.detailsVisible,true);
      assert.ok(dialog.preview.includes(longNameBatch.batch.folderName),`${width}px: the effective long destination name remains available in the preview`);
      if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png',`-format-${width}.png`),fullPage:false,animations:'disabled'});
      await manager.keyboard.press('Escape');
      await manager.waitForFunction(()=>!document.querySelector('#save-settings').open);
      assert.equal(await manager.evaluate(()=>document.activeElement?.id),'destination-change',`${width}px: Escape from the format selector returns focus to Change`);
    }
  } finally {
    // This helper is embedded before the existing worker-restart, collection,
    // responsive-layout and 500-item tests. Restore their exact fixture state.
    await manager.evaluate(async({state,local,prefix,key})=>{
      const {getDirectory,putDirectory,deleteDirectory}=await import('./directory-store.js');
      for(const [name,target] of [['session',`session:${state.id}`],['last','last'],['batch',`batch:${state.batch?.id}`]]) {
        const handle=await getDirectory(prefix+name);
        if(handle)await putDirectory(target,handle);else if(name!=='batch' || state.batch)await deleteDirectory(target);
        await deleteDirectory(prefix+name);
      }
      const current=await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(current).filter(name=>!Object.hasOwn(local,name)));
      await chrome.storage.local.set(local);await chrome.storage.session.set({[key]:state});
    },{state:original,local:originalLocal,prefix:backupPrefix,key});
    if(originalViewport)await manager.setViewportSize(originalViewport);
    await reload();
  }
}
