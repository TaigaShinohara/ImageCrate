// Runs an isolated Chrome profile. Test copy grants ONLY the local fixture origin.
// Real activeTab toolbar invocation and native macOS pickers remain manual QA.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {runFormatChecks} from './format-browser.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'media-extension-qa-'));
const extension=join(scratch,'extension');await cp(join(repo,'extension'),extension,{recursive:true});
const workerPath=join(extension,'background.js');await writeFile(workerPath,(await readFile(workerPath,'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;globalThis.__workerBoot=crypto.randomUUID();globalThis.__restoreQA=({key,original})=>serial(()=>chrome.storage.session.set({[key]:original}));\n');
// Fixture replacement must not race the real UI's queued persistence writes.
const workspacePath=join(extension,'workspace.js');await writeFile(workspacePath,(await readFile(workspacePath,'utf8'))+'\nglobalThis.__flushQAUI=async()=>{clearTimeout(scrollTimer);clearTimeout(measureTimer);await uiWrites.catch(()=>{});clearTimeout(scrollTimer);clearTimeout(measureTimer);};\n');
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
let clip=Buffer.alloc(0), failedOnce=true, slowDirectoryWrites=false;
const fixture=`<!doctype html><html lang="ja"><title>Synthetic media fixture</title><body><h1>Local fixture</h1><img src="/red.svg" alt="赤" width="320" height="200"><img src="/blue.svg" alt="青" width="400" height="300"><img src="/red.svg"><div style="background-image:url('/green.svg');width:100px;height:100px"></div><picture><source srcset="/red.svg 1x, /blue.svg 2x"><img src="/red.svg"></picture><div id="shadow"></div><iframe src="/frame"></iframe><video controls src="/clip.webm" width="320" height="180"></video><a href="/stream.m3u8">stream</a><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<img src="/shadow.svg">';</script></body></html>`;
const server=createServer((req,res)=>{
  if(req.url==='/frame') {res.setHeader('Content-Type','text/html');return res.end('<img src="/frame.svg">');}
  if(req.url.startsWith('/clip.webm')) {res.setHeader('Content-Type','video/webm');return res.end(clip);}
  if(req.url.startsWith('/stream.m3u8')) {res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end('#EXTM3U\n');}
  if(req.url.startsWith('/fail.svg') && failedOnce) {res.statusCode=403;return res.end('blocked');}
  if(req.url==='/red.svg' && slowDirectoryWrites && req.headers['sec-fetch-dest']==='empty') {
    res.setHeader('Content-Type','image/svg+xml');res.write('<svg xmlns="http://www.w3.org/2000/svg">');
    const timer=setTimeout(()=>res.end('<rect width="4" height="4"/></svg>'),10000);
    res.on('close',()=>clearTimeout(timer));return;
  }
  if(req.url.endsWith('.svg')) {res.setHeader('Content-Type','image/svg+xml');return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${req.url.includes('blue')?'#566ac4':req.url.includes('green')?'#58a884':'#e8987e'}"/></svg>`);}
  res.setHeader('Content-Type','text/html');res.end(fixture);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function assertFilterGeometry(workspace,label) {
  // The native toggle event updates aria state, then scrolls the expanded
  // panel in requestAnimationFrame. Read layout only after that work settles.
  await workspace.waitForFunction(()=>document.querySelector('#filters').open && document.querySelector('#filters > summary').getAttribute('aria-expanded')==='true');
  await workspace.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await workspace.evaluate(()=>{
    const rect=element=>{const box=element.getBoundingClientRect();return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height};};
    return {
      panel:rect(document.querySelector('#filter-panel')),query:rect(document.querySelector('#query')),
      summary:rect(document.querySelector('#filters > summary')),tools:rect(document.querySelector('.search-tools')),
      fields:[...['width','height','type'].map(id=>({id,...rect(document.getElementById(id))})),
        {id:'exclude-ad-like label',...rect(document.querySelector('#exclude-ad-like').closest('label'))}],
      width:innerWidth,height:innerHeight,footerTop:document.querySelector('#footer').getBoundingClientRect().top
    };
  });
  const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
  for(const field of geometry.fields) {
    assert.ok(field.width>0 && field.height>=44,`${label}: ${field.id} has a usable field rectangle`);
    assert.ok(field.left>=0 && field.right<=geometry.width+1 && field.top>=0 && field.bottom<=Math.min(geometry.height,geometry.footerTop)+1,`${label}: ${field.id} stays in the viewport above the footer`);
    assert.ok(field.left>=geometry.panel.left-1 && field.right<=geometry.panel.right+1 && field.top>=geometry.panel.top-1 && field.bottom<=geometry.panel.bottom+1,`${label}: ${field.id} stays inside its panel`);
  }
  for(let i=0;i<geometry.fields.length;i++)for(let j=i+1;j<geometry.fields.length;j++) {
    assert.equal(overlaps(geometry.fields[i],geometry.fields[j]),false,`${label}: filter fields do not overlap`);
  }
  assert.equal(overlaps(geometry.panel,geometry.query),false,`${label}: the open panel does not cover search`);
  assert.equal(overlaps(geometry.panel,geometry.summary),false,`${label}: the open panel does not cover its summary`);
  if(geometry.width>=640)assert.ok(geometry.query.width>=geometry.tools.width/2,`${label}: search retains the main row width when filters open`);
}
let context;
try {
  context=await chromium.launchPersistentContext(join(scratch,'profile'),{channel:process.env.CHROME_CHANNEL || 'chrome',headless:true,chromiumSandbox:true,acceptDownloads:true,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required','--no-first-run']});
  const browserSession=await context.browser().newBrowserCDPSession();
  const {id}=await browserSession.send('Extensions.loadUnpacked',{path:extension});
  let worker=context.serviceWorkers().find(w=>w.url().includes(id));
  if(!worker) worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes(id)});
  const page=await context.newPage();await page.goto(origin);
  // Generate a small synthetic video locally; no remote media or personal pages.
  clip=Buffer.from(await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[];
    const rec=new MediaRecorder(stream,{mimeType:'video/webm'});
    const ready=new Promise(resolve=>{rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer())]);});
    rec.start(100);let n=0;const timer=setInterval(()=>{ctx.fillStyle=`hsl(${n++*15} 70% 50%)`;ctx.fillRect(0,0,320,180);},40);
    await new Promise(r=>setTimeout(r,400));rec.stop();clearInterval(timer);stream.getTracks().forEach(t=>t.stop());return ready;
  }));
  await page.reload();
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url?.startsWith(origin)),origin);
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  const previewRequests=[];manager.on('request',request=>{if(request.url().startsWith(origin))previewRequests.push(request.url());});
  await manager.waitForLoadState();
  const errors=[];manager.on('pageerror',e=>errors.push(e.message));
  await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('候補を取得'));
  const downloadFolder=join(scratch,'downloads');await mkdir(downloadFolder);
  const session=await context.newCDPSession(manager);await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadFolder,eventsEnabled:true});
  if(manifest.name==='ImageCrate') {
    assert.ok(await manager.locator('.card').count()>=5,'DOM, background, shadow and frame collection');
    assert.equal(await manager.locator('.image-select:checked').count(),0,'initial selection is empty');
    assert.equal(await manager.locator('.thumb img').count(),0,'pregranted Chrome host access does not establish this workspace preview consent');
    assert.deepEqual(previewRequests,[],'the workspace makes no fixture request before an actual preview consent click');
    await manager.locator('.card .preview-permission:visible').first().click();
    await manager.waitForFunction(()=>{const image=document.querySelector('.thumb img');return image?.complete&&image.naturalWidth>0&&image.src.startsWith('blob:');});
    assert.equal(await manager.locator('.thumb img').first().evaluate(image=>image.naturalWidth<=384),true,'the thumbnail is a bounded generated static image');
    await manager.waitForFunction(()=>[...document.querySelectorAll('[data-dimensions]')].some(node=>node.textContent.includes('400 × 300')));
    assert.equal(await manager.locator('.image-select:checked').count(),0,'preview consent does not select images');
    await manager.waitForFunction(()=>document.querySelectorAll('.thumb img').length>=2);
    await manager.locator('.thumbnail-image').first().click();
    await manager.waitForFunction(()=>document.querySelector('.image-select').checked);
    await manager.locator('.card-select').first().click();
    await manager.waitForFunction(()=>!document.querySelector('.image-select').checked);
    // Native disclosures must remain keyboard-operable and return focus on Escape.
    for(const disclosureId of ['filters','help']) {
      const summary=manager.locator(`#${disclosureId} > summary`);
      assert.equal(await summary.getAttribute('aria-expanded'),'false');
      await summary.focus();await summary.press('Enter');
      await manager.waitForFunction(id=>document.querySelector(`#${id}`).open && document.querySelector(`#${id} > summary`).getAttribute('aria-expanded')==='true',disclosureId);
      assert.ok(await manager.locator(`#${disclosureId} .disclosure-panel`).isVisible());
      if(disclosureId==='filters')await manager.locator('#width').focus();
      await manager.keyboard.press('Escape');
      await manager.waitForFunction(id=>!document.querySelector(`#${id}`).open && document.querySelector(`#${id} > summary`).getAttribute('aria-expanded')==='false',disclosureId);
      assert.equal(await manager.evaluate(id=>document.activeElement===document.querySelector(`#${id} > summary`),disclosureId),true,'Escape restores the disclosure summary focus');
      assert.equal(await manager.locator(`#${disclosureId} .disclosure-panel`).isVisible(),false);
    }
    await manager.locator('#filters > summary').click();
    await manager.locator('#width').fill('100');await manager.locator('#height').fill('100');await manager.locator('#type').selectOption('svg');
    await assertFilterGeometry(manager,'desktop filters');
    await manager.locator('#height').press('Escape');
    assert.equal(await manager.locator('#filter-count').textContent(),'3');
    assert.equal(await manager.locator('.filter-chip').count(),3,'closed filters expose every active dimension/type condition');
    assert.ok(await manager.locator('#active-filters').isVisible());
    const widthChip=manager.getByRole('button',{name:'幅 100px以上の条件を解除',exact:true});
    await widthChip.focus();await widthChip.press('Enter');
    assert.equal(await manager.locator('#width').inputValue(),'0');
    assert.equal(await manager.locator('.filter-chip').count(),2);
    assert.equal(await manager.evaluate(()=>document.activeElement?.classList.contains('filter-chip')),true,'removing a focused chip preserves a useful keyboard focus');
    await manager.locator('#reset-filters').click();
    assert.equal(await manager.locator('#height').inputValue(),'0');assert.equal(await manager.locator('#type').inputValue(),'');
    assert.equal(await manager.locator('#active-filters').isVisible(),false);assert.equal(await manager.locator('#filter-count').isVisible(),false);
    assert.equal(await manager.evaluate(()=>document.activeElement?.id),'query');
    await manager.locator('#query').fill('no-such-image-for-qa');
    assert.ok(await manager.locator('#empty').isVisible());assert.equal(await manager.locator('.card').count(),0);
    await manager.locator('#empty').getByRole('button',{name:'条件をリセット',exact:true}).click();
    assert.ok(await manager.locator('.card').count()>=5);assert.equal(await manager.locator('#query').inputValue(),'');
    assert.equal(await manager.evaluate(()=>document.activeElement?.id),'query');
    const cardSemantics=await manager.locator('.card').evaluateAll(cards=>cards.every(card=>{
      const checkbox=card.querySelector('input[type="checkbox"]'),meta=card.querySelector('.meta'),format=card.querySelector('.file-type');
      const descriptions=checkbox.getAttribute('aria-describedby')?.split(/\s+/).map(id=>document.getElementById(id));
      return checkbox.getAttribute('aria-label')?.endsWith('を選択') && descriptions?.length===2 && descriptions.every(Boolean)
        && /×|寸法未確認/.test(meta.textContent) && !!format.textContent && getComputedStyle(meta).display!=='none' && getComputedStyle(format).display!=='none';
    }));
    assert.equal(cardSemantics,true,'every checkbox names its image and describes always-present dimensions/type and save state');
    await manager.locator('.image-select').first().focus();await manager.keyboard.press('Space');
    assert.equal(await manager.locator('.image-select').first().isChecked(),true,'native checkbox supports Space');
    await manager.keyboard.press('Space');
    assert.equal(await manager.locator('.image-select').first().isChecked(),false);
    const boxes=manager.locator('.image-select');await boxes.nth(0).check();await boxes.nth(1).check();
    await manager.locator('#query').fill('red.svg');assert.match(await manager.locator('#selection').textContent(),/非表示1件/);
    assert.match(await manager.locator('#selection-hint').textContent(),/非表示の画像も保存/);
    assert.equal(await manager.getByRole('button',{name:'選択2件を保存',exact:true}).count(),1,'save action retains its count and accessible label');
    await manager.locator('#save').click();
    await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('2件保存完了'));
    assert.equal(await manager.locator('#selection').textContent(),'選択0件');
    await manager.locator('#query').fill('');
    await page.evaluate(origin=>{const image=new Image();image.src=origin+'/added.svg';document.body.append(image);},origin);
    await manager.locator('#scan').click();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全6件'));
    assert.equal(await manager.locator('.image-select:checked').count(),0,'rescan never reselects completed/new images');
    assert.match(await manager.locator('.card').filter({hasText:'red.svg'}).first().locator('.item-status').textContent(),/保存完了/);
    // Failed download keeps selection; retry only that item, with a fresh ID.
    await page.evaluate(origin=>{const image=new Image();image.dataset.src=origin+'/fail.svg';document.body.append(image);},origin);
    await manager.locator('#scan').click();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全7件'));
    await manager.locator('.card').filter({hasText:'fail.svg'}).locator('input').check();await manager.locator('#save').click();
    await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件中断'));
    assert.match(await manager.locator('#selection').textContent(),/選択1件/);
    failedOnce=false;
    await manager.locator('#retry').click();await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
    // Save settings use the actual workspace, downloads, IndexedDB and file writer.
    // Only native chooser / permission decisions are replaced at their API boundary.
    const readImageSession=()=>manager.evaluate(async()=>{
      const key=`workspace:${new URL(location.href).searchParams.get('id')}`;
      return (await chrome.storage.session.get(key))[key];
    });
    // Poll the resolved storage value. waitForFunction treats an async
    // predicate's Promise as truthy before its storage read has settled.
    const waitForImageSession=async predicate=>{
      const deadline=Date.now()+15000;
      while(Date.now()<deadline) {
        const current=await readImageSession();if(predicate(current))return current;
        await manager.waitForTimeout(25);
      }
      throw new Error('Timed out waiting for the image batch state');
    };
    const openSaveSettings=async()=>{
      await manager.locator('#destination-change').click();
      await manager.waitForFunction(()=>document.querySelector('#save-settings').open);
    };
    const closeSaveSettings=async()=>{
      await manager.locator('#settings-done').click();
      await manager.waitForFunction(()=>!document.querySelector('#save-settings').open);
    };
    const selectRedImage=async()=>{
      await manager.locator('#query').fill('');
      await manager.locator('.card').filter({hasText:'red.svg'}).first().locator('.image-select').check();
    };
    const saveSelectedImage=async()=>{
      const previousBatch=(await readImageSession()).batch?.id;
      await manager.locator('#save').click();
      await waitForImageSession(current=>current.batch?.id!==previousBatch && current.jobs.length===1 && current.jobs[0].status==='complete');
      await manager.waitForFunction(()=>document.querySelector('#selection').textContent==='選択0件');
      return readImageSession();
    };
    await manager.locator('#destination-change').focus();await manager.keyboard.press('Enter');
    await manager.waitForFunction(()=>document.querySelector('#save-settings').open);
    await manager.keyboard.press('Tab');
    assert.equal(await manager.evaluate(()=>document.activeElement?.closest('dialog')?.id),'save-settings','native modal keeps keyboard focus inside its settings');
    await manager.locator('#folder-name').focus();await manager.keyboard.press('Escape');
    await manager.waitForFunction(()=>!document.querySelector('#save-settings').open);
    assert.equal(await manager.evaluate(()=>document.activeElement?.id),'destination-change','Escape restores the save-settings trigger focus');
    await openSaveSettings();
    const sourceTitle=(await readImageSession()).title;
    await manager.locator('#folder-name').fill('');
    await manager.waitForFunction(title=>document.querySelector('#destination-preview').textContent.includes(title),sourceTitle);
    await manager.locator('#folder-name').fill('旅行/週末:*?');
    await manager.waitForFunction(()=>document.querySelector('#destination-preview').textContent.includes('旅行_週末___'));
    assert.ok(await manager.locator('#folder-adjustment').isVisible(),'unsafe folder characters have a visible explanation and effective preview');
    await manager.locator('#folder-name').fill('写真をまとめる_任意名');
    await closeSaveSettings();
    assert.match(await manager.locator('#destination-summary').textContent(),/写真をまとめる_任意名/);
    await selectRedImage();
    const namedDownloadState=await saveSelectedImage();
    assert.equal(namedDownloadState.batch.destination,'downloads');
    assert.equal(namedDownloadState.batch.folderName,'写真をまとめる_任意名');
    assert.equal(namedDownloadState.jobs[0].filename,'ImageCrate/写真をまとめる_任意名/001_red.svg','the chosen folder is frozen into the actual download filename');
    const namedDownload=await manager.evaluate(async downloadId=>(await chrome.downloads.search({id:downloadId}))[0],namedDownloadState.jobs[0].downloadId);
    // Browser.setDownloadBehavior controls this test profile's physical output:
    // this Chrome saves the source basename there instead of the extension's
    // relative filename. Assert the requested route above and real saved bytes
    // below; native Chrome subdirectory creation remains a manual QA item.
    assert.equal(namedDownload.state,'complete',`Chrome completes the requested download: actual=${JSON.stringify(namedDownload.filename)} requested=${JSON.stringify(namedDownloadState.jobs[0].filename)}`);
    assert.match(await readFile(namedDownload.filename,'utf8'),/<svg\b/,'custom-named default download contains the fixture image');
    await openSaveSettings();await manager.locator('#folder-reset').click();
    await manager.waitForFunction(title=>document.querySelector('#destination-preview').textContent.includes(title),sourceTitle);
    await manager.locator('#folder-name').fill('OPFSまとめ先');
    // OPFS is isolated in this temporary Chrome profile. This is an actual
    // cloneable FileSystemDirectoryHandle, not a mock filesystem or OS chooser.
    const qaDirectoryName='ImageCrate検証用_'+ '長い保存先フォルダ名'.repeat(6);
    await manager.evaluate(async name=>{
      const root=await navigator.storage.getDirectory();
      window.__qaSelectedDirectory=await root.getDirectoryHandle(name,{create:true});
      window.__qaPickerCancelled=false;window.__qaPickerCalls=0;
      Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>{
        window.__qaPickerCalls++;
        if(window.__qaPickerCancelled)throw new DOMException('Synthetic chooser cancellation','AbortError');
        return window.__qaSelectedDirectory;
      }});
    },qaDirectoryName);
    await manager.locator('#choose-directory').click();
    await manager.waitForFunction(()=>document.querySelector('#destination-directory').checked);
    await manager.waitForFunction(name=>document.querySelector('#chosen-directory').textContent.includes(name),qaDirectoryName);
    const beforePickerCancel=await manager.locator('#destination-preview').textContent();
    await manager.evaluate(()=>{window.__qaPickerCancelled=true;});
    await manager.locator('#choose-directory').click();
    await manager.waitForFunction(()=>window.__qaPickerCalls===2 && !document.querySelector('#choose-directory').disabled);
    assert.equal(await manager.locator('#destination-preview').textContent(),beforePickerCancel,'chooser cancel preserves the previously selected folder and preview');
    assert.equal(await manager.locator('#destination-directory').isChecked(),true);
    await closeSaveSettings();
    assert.ok(await manager.locator('#directory-warning').isVisible(),'the open-tab condition is visible before saving to a selected folder');
    assert.equal(await manager.evaluate(async()=>{
      const {getDirectory}=await import('./directory-store.js');
      const id=new URL(location.href).searchParams.get('id');
      const state=(await chrome.storage.session.get(`workspace:${id}`))[`workspace:${id}`];
      const saved=await getDirectory(state.saveSettings.directoryKey);
      return !!saved && saved.isSameEntry(window.__qaSelectedDirectory);
    }),true,'the selected real directory handle survives an IndexedDB structured clone');
    const readSelectedDirectory=folder=>manager.evaluate(async({name,folder})=>{
      const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
      const child=await directory.getDirectoryHandle(folder);const files=[];
      for await(const [name,handle] of child.entries()) {
        if(handle.kind==='file') {const file=await handle.getFile();files.push({name,text:await file.text(),size:file.size});}
      }
      return files.sort((a,b)=>a.name.localeCompare(b.name));
    },{name:qaDirectoryName,folder});
    await selectRedImage();const directoryState=await saveSelectedImage();
    assert.equal(directoryState.batch.destination,'directory');assert.equal(directoryState.batch.folderName,'OPFSまとめ先');
    const firstDirectoryFiles=await readSelectedDirectory('OPFSまとめ先');
    assert.equal(firstDirectoryFiles.length,1);assert.equal(firstDirectoryFiles[0].name,'001_red.svg');
    assert.ok(firstDirectoryFiles[0].size>0);assert.match(firstDirectoryFiles[0].text,/<svg\b/,'real OPFS file writer saves the image content');
    await selectRedImage();const repeatDirectoryState=await saveSelectedImage();
    const repeatedDirectoryFiles=await readSelectedDirectory('OPFSまとめ先');
    assert.equal(repeatedDirectoryFiles.length,2,'re-saving creates a second file instead of overwriting');
    assert.equal(repeatDirectoryState.jobs[0].filename,'001_red (1).svg');
    assert.deepEqual(repeatedDirectoryFiles.find(file=>file.name==='001_red.svg'),firstDirectoryFiles[0],'the first saved file remains intact');
    assert.equal(repeatedDirectoryFiles.find(file=>file.name==='001_red (1).svg').text,firstDirectoryFiles[0].text);
    await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
    await openSaveSettings();
    assert.equal(await manager.locator('#destination-directory').isChecked(),true,'selected-folder mode is restored after reload');
    assert.equal(await manager.locator('#folder-name').inputValue(),'OPFSまとめ先');
    assert.match(await manager.locator('#destination-preview').textContent(),new RegExp(qaDirectoryName));
    await closeSaveSettings();
    // Explicitly deny only the permission decision; do not revoke localhost
    // access or change the production manifest / real Chrome profile.
    await manager.evaluate(()=>{
      window.__qaOriginalPermissions={contains:chrome.permissions.contains.bind(chrome.permissions),request:chrome.permissions.request.bind(chrome.permissions)};
      chrome.permissions.contains=async()=>false;
      chrome.permissions.request=async options=>{window.__qaDeniedOrigins=options.origins;return false;};
    });
    await selectRedImage();const beforeDeniedBatch=(await readImageSession()).batch.id;
    await manager.locator('#save').click();
    await manager.waitForFunction(()=>window.__qaDeniedOrigins?.length>0 && !document.querySelector('#save').disabled);
    assert.deepEqual(await manager.evaluate(()=>window.__qaDeniedOrigins),['http://127.0.0.1/*'],'permission request is limited to the selected image source');
    assert.equal((await readImageSession()).batch.id,beforeDeniedBatch,'permission denial never starts a new save batch');
    assert.equal(await manager.locator('.image-select:checked').count(),1,'permission denial keeps the selected image for recovery');
    assert.equal((await readSelectedDirectory('OPFSまとめ先')).length,2,'permission denial writes no file');
    await manager.evaluate(()=>{chrome.permissions.contains=window.__qaOriginalPermissions.contains;chrome.permissions.request=window.__qaOriginalPermissions.request;});
    if(await manager.locator('#save-settings').evaluate(dialog=>dialog.open))await closeSaveSettings();
    await manager.locator('#clear').click();
    // Stop a real fetch stream, then retry the original batch after changing
    // the next-save setting. Exercise the UI/controller/worker boundary.
    await openSaveSettings();await manager.locator('#folder-name').fill('停止と再試行');await closeSaveSettings();
    slowDirectoryWrites=true;await selectRedImage();await manager.locator('#save').click();
    await waitForImageSession(current=>current.batch?.folderName==='停止と再試行' && current.jobs[0]?.status==='in_progress' && current.jobs[0].bytesReceived>0);
    const stoppedBatchId=(await readImageSession()).batch.id;
    assert.ok(await manager.locator('#save').isDisabled());assert.ok(await manager.locator('#destination-change').isDisabled());
    await manager.locator('#cancel').click();
    await manager.waitForFunction(()=>!document.querySelector('#retry').hidden && !document.querySelector('#destination-change').disabled);
    assert.equal((await readImageSession()).jobs[0].status,'interrupted');
    assert.equal((await readImageSession()).batch.id,stoppedBatchId,'Stop keeps the batch ID');
    assert.equal((await readSelectedDirectory('停止と再試行')).length,0,'Stop cleans its own unfinished file');
    slowDirectoryWrites=false;
    await openSaveSettings();await manager.locator('#folder-name').fill('次の保存先');await closeSaveSettings();
    assert.match(await manager.locator('#batch-destination').textContent(),/停止と再試行/);
    assert.equal((await readImageSession()).batch.id,stoppedBatchId,'changing settings keeps the batch ID');
    await manager.locator('#retry').click();
    await waitForImageSession(current=>current.jobs[0]?.status==='complete');
    const retriedState=await readImageSession();
    assert.equal(retriedState.batch.id,stoppedBatchId);assert.equal(retriedState.batch.folderName,'停止と再試行');
    assert.equal((await readSelectedDirectory('停止と再試行')).length,1,'Retry uses the batch folder, not the changed setting');
    assert.equal(await manager.locator('#selection').textContent(),'選択0件');

    // Confirm beforeunload is wired and reload reclassifies unfinished jobs.
    await openSaveSettings();await manager.locator('#folder-name').fill('再読込回復');await closeSaveSettings();
    slowDirectoryWrites=true;await selectRedImage();await manager.locator('#save').click();
    await waitForImageSession(current=>current.batch?.folderName==='再読込回復' && current.jobs[0]?.status==='in_progress' && current.jobs[0]?.bytesReceived>0);
    let unloadWarning=false;
    manager.once('dialog',async dialog=>{unloadWarning=dialog.type()==='beforeunload';await dialog.accept();});
    await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
    assert.ok(unloadWarning,'active custom saving warns before reload');
    assert.equal((await readImageSession()).jobs[0].status,'interrupted','reload never reports an unfinished write as complete');
    slowDirectoryWrites=false;await manager.locator('#retry').click();
    await waitForImageSession(current=>current.jobs[0]?.status==='complete');
    assert.ok((await readSelectedDirectory('再読込回復')).some(file=>file.size>0 && /<svg\b/.test(file.text)),'reload recovery can finish the saved image');
    // A real OPFS handle normally remains granted. Simulate only the browser's
    // restored-handle prompt/denial decisions; native permission UI stays manual.
    await manager.addInitScript(({name})=>{
      const prototype=FileSystemHandle.prototype;
      const query=prototype.queryPermission,request=prototype.requestPermission;
      window.__qaHandlePermissionRequests=0;
      Object.defineProperty(prototype,'queryPermission',{configurable:true,writable:true,value:function(options){
        if(this.kind==='directory' && this.name===name && sessionStorage.getItem('imagecrate-qa-directory-permission')==='prompt')return Promise.resolve('prompt');
        return query.call(this,options);
      }});
      Object.defineProperty(prototype,'requestPermission',{configurable:true,writable:true,value:function(options){
        if(this.kind==='directory' && this.name===name && sessionStorage.getItem('imagecrate-qa-directory-permission')==='prompt') {window.__qaHandlePermissionRequests++;return Promise.resolve('denied');}
        return request.call(this,options);
      }});
    },{name:qaDirectoryName});
    await manager.evaluate(()=>sessionStorage.setItem('imagecrate-qa-directory-permission','prompt'));
    await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
    await openSaveSettings();
    assert.ok(await manager.locator('#directory-reconnect').isVisible(),'a restored handle needing permission exposes its recovery action');
    const beforeReconnectBatch=(await readImageSession()).batch.id;
    await manager.locator('#directory-reconnect').click();
    await manager.waitForFunction(()=>window.__qaHandlePermissionRequests>0 && !document.querySelector('#directory-reconnect').disabled);
    assert.ok(await manager.locator('#directory-reconnect').isVisible(),'denying restored folder access retains a recovery action');
    assert.equal((await readImageSession()).batch.id,beforeReconnectBatch,'restored-folder permission denial never starts saving');
    await manager.evaluate(()=>sessionStorage.removeItem('imagecrate-qa-directory-permission'));
    await manager.reload();await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
    await openSaveSettings();await manager.locator('#folder-name').fill('日本語の写真をまとめる保存先'.repeat(10));await closeSaveSettings();
    await selectRedImage();const longFolderState=await saveSelectedImage();
    assert.ok(Buffer.byteLength(longFolderState.batch.folderName,'utf8')<=160,'long Japanese folder names respect the filesystem component byte limit');
    assert.ok((await manager.locator('#batch-destination').getAttribute('title')).includes(longFolderState.batch.folderName),'the batch destination exposes its full effective name in title');
    for(const width of [640,360]) {
      await manager.setViewportSize({width,height:800});await manager.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
      const footerGeometry=await manager.evaluate(()=>{
        const footer=document.querySelector('#footer').getBoundingClientRect(),save=document.querySelector('#save').getBoundingClientRect();
        const destination=document.querySelector('#batch-destination'),styles=getComputedStyle(destination);
        return {overflow:document.documentElement.scrollWidth>innerWidth,top:footer.top,bottom:footer.bottom,height:footer.height,saveTop:save.top,saveBottom:save.bottom,viewportHeight:innerHeight,clamp:styles.webkitLineClamp,destinationHeight:destination.getBoundingClientRect().height,lineHeight:parseFloat(styles.lineHeight)};
      });
      assert.equal(footerGeometry.overflow,false,`${width}px: long destination text does not cause horizontal overflow`);
      assert.ok(footerGeometry.top>=0 && footerGeometry.bottom<=footerGeometry.viewportHeight+1,`${width}px: custom-folder footer stays in the viewport`);
      assert.ok(footerGeometry.saveTop>=0 && footerGeometry.saveBottom<=footerGeometry.viewportHeight+1,`${width}px: saving remains reachable with custom-folder guidance and batch result`);
      assert.ok(footerGeometry.height<footerGeometry.viewportHeight*.6,`${width}px: the footer leaves room for the gallery`);
      assert.equal(footerGeometry.clamp,'2');assert.ok(footerGeometry.destinationHeight<=footerGeometry.lineHeight*2+1,`${width}px: batch destination is limited to two visual lines`);
      await openSaveSettings();
      const dialogGeometry=await manager.locator('#save-settings').evaluate(dialog=>{
        const rect=dialog.getBoundingClientRect(),radio=document.querySelector('#destination-downloads').getBoundingClientRect();
        return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,overflow:dialog.scrollWidth>dialog.clientWidth,radioWidth:radio.width,radioHeight:radio.height,preview:document.querySelector('#destination-preview').textContent};
      });
      assert.ok(dialogGeometry.left>=0 && dialogGeometry.right<=dialogGeometry.viewportWidth+1 && dialogGeometry.top>=0 && dialogGeometry.bottom<=dialogGeometry.viewportHeight+1,`${width}px: settings modal stays within the viewport`);
      assert.equal(dialogGeometry.overflow,false,`${width}px: long Japanese names wrap inside the settings modal`);
      assert.ok(dialogGeometry.radioWidth>=16 && dialogGeometry.radioWidth<=32 && dialogGeometry.radioHeight<=32,`${width}px: native radios retain usable small control dimensions`);
      assert.ok(dialogGeometry.preview.includes(longFolderState.batch.folderName),`${width}px: settings preview shows the full effective folder name`);
      await manager.locator('#save-settings').evaluate(dialog=>{dialog.scrollTop=dialog.scrollHeight;});
      const scrolledGeometry=await manager.evaluate(()=>{
        const dialog=document.querySelector('#save-settings').getBoundingClientRect(),close=document.querySelector('#settings-close').getBoundingClientRect(),done=document.querySelector('#settings-done').getBoundingClientRect();
        return {dialogTop:dialog.top,dialogBottom:dialog.bottom,closeTop:close.top,closeBottom:close.bottom,doneBottom:done.bottom};
      });
      assert.ok(scrolledGeometry.closeTop>=scrolledGeometry.dialogTop && scrolledGeometry.closeBottom<=scrolledGeometry.dialogBottom,`${width}px: close remains visible while settings scroll`);
      assert.ok(scrolledGeometry.doneBottom<=scrolledGeometry.dialogBottom+1,`${width}px: the final settings action can be reached by scrolling`);
      if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png',`-save-settings-${width}.png`),fullPage:false,animations:'disabled'});
      await closeSaveSettings();
    }
    await manager.setViewportSize({width:1280,height:900});
    await openSaveSettings();await manager.locator('#destination-downloads').check();await manager.locator('#folder-reset').click();await closeSaveSettings();
    if(await manager.locator('#clear').isEnabled())await manager.locator('#clear').click();
    await runFormatChecks({manager,worker,origin,downloadFolder});
  } else {
    assert.ok(await manager.locator('.direct-save').count()>=1);assert.ok(await manager.locator('#unsupported-count').textContent());
    await manager.locator('.direct-save').first().click();await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
    await manager.locator('#record-tab').click();
    // Inject synthetic capture at the native API boundary; exercise actual MediaRecorder lifecycle.
    await manager.evaluate(()=>{
      window.__captureTracks=[];
      Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#258d79';ctx.fillRect(0,0,320,180);
        const stream=canvas.captureStream(12);window.__captureTracks.push(...stream.getTracks());
        const timer=setInterval(()=>{ctx.fillStyle=`hsl(${Date.now()%360} 60% 50%)`;ctx.fillRect(0,0,320,180);},80);
        stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
      }});
    });
    await manager.locator('#record-mode').selectOption('display');await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-state').textContent==='録画中');
    assert.equal(await manager.locator('#download-tab').isDisabled(),true);
    await manager.locator('#pause-record').click();assert.equal(await manager.locator('#record-state').textContent(),'一時停止中');
    await manager.locator('#pause-record').click();
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-state').textContent.includes('保存してください'));
    assert.ok(await manager.evaluate(()=>window.__captureTracks.every(t=>t.readyState==='ended')),'all capture tracks stopped');
    assert.equal(await manager.locator('#start-record').isDisabled(),true,'unsaved capture blocks replacement');
    assert.match(await manager.locator('#record-description').textContent(),/音声なし/);
    // SaveAs is a native picker: mock only saveAs option for automated download destination.
    await manager.evaluate(()=>{const original=chrome.downloads.download.bind(chrome.downloads);chrome.downloads.download=options=>original({...options,saveAs:false});});
    await manager.locator('#save-record').click();await manager.waitForFunction(()=>document.querySelector('#record-state').textContent==='ファイル保存完了');
    assert.equal(await manager.locator('#download-tab').isDisabled(),false);
    const [savedCapture]=await manager.evaluate(()=>chrome.downloads.search({urlRegex:'^blob:'}));
    const captureBytes=await readFile(savedCapture.filename);assert.ok(captureBytes.length>100);
    clip=captureBytes;
    await page.evaluate(async origin=>{const v=document.querySelector('video');v.src=origin+'/clip.webm?recorded=1';await v.play();},origin);
    await page.waitForFunction(()=>document.querySelector('video').videoWidth===320 && document.querySelector('video').currentTime>0);
    // Cancel does not replace the previously completed recording.
    await manager.evaluate(()=>{Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{throw new DOMException('cancel','NotAllowedError');}});});
    await manager.locator('#start-record').click();await manager.waitForFunction(()=>!document.querySelector('#start-record').disabled);
    assert.ok(!await manager.locator('#stop-record').isVisible());
  }
  // A real extension service worker stop/restart must retain session-scoped result state.
  const bootBefore=await worker.evaluate(()=>globalThis.__workerBoot);
  await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
  await manager.reload();
  await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
  await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
  const restartedWorker=context.serviceWorkers().find(w=>w.url().includes(id));
  assert.ok(restartedWorker,'worker is available after page reconnects');
  assert.notEqual(await restartedWorker.evaluate(()=>globalThis.__workerBoot),bootBefore,'service worker actually restarted');
  if(manifest.name==='VideoHarbor')await manager.locator('#record-tab').click();
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-desktop.png'),fullPage:true,animations:'disabled'});
  if(manifest.name==='ImageCrate') {
    // A second representative visual state includes open filters, chips and hidden selections.
    await manager.locator('.image-select').nth(0).check();await manager.locator('.image-select').nth(1).check();
    await manager.locator('#filters > summary').click();
    await manager.locator('#width').fill('100');await manager.locator('#type').selectOption('svg');await manager.locator('#query').fill('red.svg');
    await assertFilterGeometry(manager,'selected desktop filters');
    if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-filters-desktop.png'),fullPage:false,animations:'disabled'});
    await manager.locator('#reset-filters').click();await manager.locator('#clear').click();
    await manager.locator('#filters > summary').focus();await manager.keyboard.press('Escape');
    // A 640 CSS-pixel viewport exercises the reflow used by 200% zoom on a 1280px window.
    // This checks layout only; it does not claim actual browser-zoom or screen-reader QA.
    await manager.setViewportSize({width:640,height:900});
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'640px zoom-equivalent layout does not overflow');
    await manager.locator('#filters > summary').click();
    assert.ok(await manager.locator('#width').isVisible());assert.ok(await manager.locator('#type').isVisible());
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'expanded filters reflow at 640px');
    await assertFilterGeometry(manager,'640px filters');
    await manager.locator('#width').press('Escape');
  }
  await manager.setViewportSize({width:360,height:900});
  assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'360px layout does not overflow');
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT,fullPage:true,animations:'disabled'});
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-viewport.png'),fullPage:false,animations:'disabled'});
  if(manifest.name==='ImageCrate') {
    assert.equal(await manager.locator('.grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2,'360px keeps two image columns');
    await manager.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    const mobileGeometry=await manager.evaluate(()=>{
      const footer=document.querySelector('#footer').getBoundingClientRect(),save=document.querySelector('#save').getBoundingClientRect(),last=document.querySelector('.card:last-child').getBoundingClientRect();
      return {footerTop:footer.top,footerBottom:footer.bottom,saveTop:save.top,saveBottom:save.bottom,lastBottom:last.bottom,height:innerHeight};
    });
    assert.ok(mobileGeometry.footerTop>=0 && mobileGeometry.footerBottom<=mobileGeometry.height+1,'mobile footer remains inside the viewport');
    assert.ok(mobileGeometry.saveTop>=0 && mobileGeometry.saveBottom<=mobileGeometry.height+1,'mobile save action remains inside the viewport');
    assert.ok(mobileGeometry.lastBottom<=mobileGeometry.footerTop+1,'scrolling to the end exposes the last card above the sticky footer');
    await manager.emulateMedia({reducedMotion:'reduce'});
    await manager.locator('#filters > summary').click();
    await assertFilterGeometry(manager,'360px filters');
    const reducedStyles=await manager.locator('#filter-panel').evaluate(el=>({animation:getComputedStyle(el).animationName,transition:getComputedStyle(document.querySelector('.card')).transitionDuration}));
    assert.equal(reducedStyles.animation,'none');assert.equal(reducedStyles.transition,'0s');
    await manager.locator('#width').press('Escape');
    await manager.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
    await manager.locator('.image-select').first().check();
    const forcedStyles=await manager.locator('.image-select').first().evaluate(el=>({appearance:getComputedStyle(el).appearance,outline:getComputedStyle(el.closest('.card')).outlineStyle}));
    assert.equal(forcedStyles.appearance,'auto','forced colors restore the native checkbox');assert.notEqual(forcedStyles.outline,'none','selected card has a forced-colors outline');
    assert.ok(await manager.getByRole('checkbox').first().isChecked());
    await manager.locator('#clear').click();await manager.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
    await manager.setViewportSize({width:1280,height:900});
    // The synthetic session belongs only to this temporary Chrome profile. Restore it afterward.
    await manager.evaluate(()=>globalThis.__flushQAUI());
    const stressState=await restartedWorker.evaluate(async ({managerUrl,origin})=>{
      const key=`workspace:${new URL(managerUrl).searchParams.get('id')}`,original=(await chrome.storage.session.get(key))[key];
      const items=Array.from({length:500},(_,index)=>({url:`${origin}/stress-${String(index).padStart(3,'0')}.svg`,width:640,height:480,alt:`Synthetic image ${index}`,type:'image'}));
      await chrome.storage.session.set({[key]:{...original,items,notices:[],scanned:true}});return {key,original};
    },{managerUrl:manager.url(),origin});
    try {
      await manager.reload();await manager.waitForFunction(()=>document.querySelectorAll('.card').length===500);
      await manager.locator('#query').focus();
      const stressResults=await manager.evaluate(()=>{
        const input=document.querySelector('#query'),results=[];
        for(const [query,expected] of [['stress-1',100],['stress-2',100],['stress-49',10],['no-stress-match',0],['',500]]) {
          const start=performance.now();input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));
          results.push({query,expected,count:document.querySelectorAll('.card').length,elapsedMs:Math.round(performance.now()-start),entryAnimation:[...document.querySelectorAll('.card')].some(card=>getComputedStyle(card).animationName!=='none'),queryFocused:document.activeElement===input});
        }
        return results;
      });
      for(const result of stressResults) {
        assert.equal(result.count,result.expected,`500-candidate query ${result.query || '(all)'} returns current results`);
        assert.equal(result.entryAnimation,false,'filter rebuilds do not replay card entry animations');assert.equal(result.queryFocused,true,'repeated filtering keeps search focus');
      }
      console.log(`ImageCrate 500-candidate synchronous filter timings (ms): ${stressResults.map(result=>result.elapsedMs).join(', ')}. These are local measurements, not human usability results.`);
    } finally {
      await manager.evaluate(()=>globalThis.__flushQAUI());
      await restartedWorker.evaluate(state=>globalThis.__restoreQA(state),stressState);
      await manager.reload();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全7件'));
    }
  }
  assert.deepEqual(errors,[],'no uncaught page errors');
  console.log(`${manifest.name} browser smoke PASS (isolated Chrome, local fixture). Native activeTab invocation, tabCapture consent and macOS display/audio remain manual.`);
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {await context?.close();await new Promise(resolve=>server.close(resolve));if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});}
