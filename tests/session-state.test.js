import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionDefaults, minimizeSessionPrivacy, needsSessionPrivacyMigration, actualFilenameBasename, applyUIPatch, applyJobCompletions, assertSessionBudget, selectableItems} from '../extension/session-state.js';
const record=index=>({url:`https://synthetic.test/${index}.png`,width:20,height:10});
const session=()=>sessionDefaults({id:'s',items:[record(1),record(2)],jobs:[]});
test('saved actual filenames retain only the real basename in both jobs and history',()=>{
  const requested='ImageCrate/Folder/001_photo.jpg',url='https://synthetic.test/photo?signature=fixture';
  for(const path of ['/Users/example/Pictures/001_photo (1).jpg','C:\\Users\\example\\Pictures\\001_photo (1).jpg','\\\\server\\share\\001_photo (1).jpg']) {
    const old={id:'s',url:'https://synthetic.test/private?fixture=1#part',title:'Synthetic page',revision:8,selectionRevision:5,
      selectedURLs:[url],items:[{url}],jobs:[{id:'j',url,filename:requested,actualFilename:path,status:'in_progress',outcomeUnknown:true,
        submission:{filename:requested},budget:{inputBytes:12}}],history:[{url,actualFilename:path,status:'complete'}]};
    const original=structuredClone(old),state=sessionDefaults(old);
    assert.equal(state.jobs[0].actualFilename,'001_photo (1).jpg');
    assert.equal(state.history[0].actualFilename,'001_photo (1).jpg');
    assert.equal(state.jobs[0].filename,requested);assert.equal(state.jobs[0].submission.filename,requested);
    assert.equal(state.jobs[0].url,url);assert.equal(state.url,old.url);assert.equal(state.title,old.title);
    assert.equal(state.revision,8);assert.equal(state.selectionRevision,5);assert.equal(state.jobs[0].outcomeUnknown,true);
    assert.deepEqual(state.jobs[0].budget,{inputBytes:12});assert.deepEqual(old,original,'normalization does not mutate the previous snapshot');
    assert.equal(needsSessionPrivacyMigration(old),true);
    assert.equal(needsSessionPrivacyMigration(state),false);
    assert.deepEqual(minimizeSessionPrivacy(state),state,'privacy normalization is idempotent');
  }
  assert.equal(actualFilenameBasename('/a/'+ '画像'.repeat(80)+' (12).png'),'画像'.repeat(80)+' (12).png');
  assert.equal(actualFilenameBasename(null),'');
});
test('closed session privacy removes source metadata without forgetting unresolved operations',()=>{
  const old={closed:true,url:'https://synthetic.test/private?fixture=1#part',title:'Synthetic title',tabId:1,workspaceTabId:2,
    scanRequest:{id:'scan'},batch:{id:'batch',directoryKey:'session:s:setting'},jobs:[{id:'job',url:'https://synthetic.test/media?fixture=2',
      downloadId:0,outcomeUnknown:true,resourceLease:{id:'lease'},submission:{filename:'ImageCrate/Safe/001_photo.jpg'},status:'in_progress'}]};
  const state=minimizeSessionPrivacy(old);
  assert.equal(Object.hasOwn(state,'url'),false);assert.equal(Object.hasOwn(state,'title'),false);
  assert.deepEqual(state.jobs,old.jobs);assert.deepEqual(state.batch,old.batch);assert.equal(state.tabId,1);
  assert.equal(needsSessionPrivacyMigration(old),true);assert.equal(needsSessionPrivacyMigration(state),false);
});
test('session defaults restore legacy sessions without clearing deliberate selection for an old completed job',()=>{
  const state=sessionDefaults({id:'s',items:[record(1)],selectedURLs:[record(1).url],jobs:[{url:record(1).url,status:'complete'}]});
  applyJobCompletions(state);
  assert.deepEqual(state.selectedURLs,[record(1).url]);
  assert.equal(state.ui.view,'all');
  assert.equal(state.ui.excludeAdLike,false);
  assert.equal(state.revision,0);
});
test('ad-like preference is session-local, accepts only booleans and preserves the selection',()=>{
  const initial=applyUIPatch(session(),{selectedURLs:[record(1).url],query:'photo',width:300,height:200,type:'png',view:'selected'});
  const enabled=applyUIPatch(initial,{excludeAdLike:true});
  assert.equal(enabled.ui.excludeAdLike,true);
  assert.deepEqual(enabled.selectedURLs,initial.selectedURLs);
  assert.equal(enabled.ui.view,'selected');assert.equal(enabled.ui.query,'photo');
  assert.equal(enabled.ui.width,300);assert.equal(enabled.ui.height,200);assert.equal(enabled.ui.type,'png');
  assert.equal(initial.ui.excludeAdLike,false,'updating a session does not mutate its prior state');
  const restored=sessionDefaults(JSON.parse(JSON.stringify(enabled)));
  assert.equal(restored.ui.excludeAdLike,true);
  assert.deepEqual(restored.selectedURLs,enabled.selectedURLs);
  assert.equal(session().ui.excludeAdLike,false,'a separate workspace does not inherit the preference');
  for(const invalid of ['true','false',1,0,null,{},[]]) {
    assert.equal(applyUIPatch(enabled,{excludeAdLike:invalid}).ui.excludeAdLike,true,JSON.stringify(invalid));
    assert.equal(applyUIPatch(initial,{excludeAdLike:invalid}).ui.excludeAdLike,false,JSON.stringify(invalid));
  }
  assert.equal(applyUIPatch(restored,{excludeAdLike:false}).ui.excludeAdLike,false);
});
test('a complete transition deselects exactly once and a later explicit selection survives polling',()=>{
  let state=applyUIPatch(session(),{selectedURLs:[record(1).url]});
  state.jobs=[{url:record(1).url,status:'complete',completionApplied:false}];
  applyJobCompletions(state);
  assert.deepEqual(state.selectedURLs,[]);
  state.revision++;
  state=applyUIPatch(state,{selectedURLs:[record(1).url]},state.revision);
  applyJobCompletions(state);
  assert.deepEqual(state.selectedURLs,[record(1).url]);
});
test('bulk selection refuses all of an invalid request and all of a request beyond 500',()=>{
  const state=session();
  assert.throws(()=>applyUIPatch(state,{selectedURLs:[record(1).url,'https://unknown.test/']}),/見つかりません/);
  state.items=Array.from({length:501},(_,i)=>record(i));
  assert.throws(()=>applyUIPatch(state,{selectedURLs:state.items.map(item=>item.url)}),/500/);
  assert.deepEqual(state.selectedURLs,[]);
});
test('page-external selected records remain selectable and deselection releases their session data',()=>{
  const state=session();
  state.selectedItems=[record(9)];state.selectedURLs=[record(9).url];
  assert.equal(selectableItems(state).length,3);
  const next=applyUIPatch(state,{selectedURLs:[]});
  assert.deepEqual(next.selectedItems,[]);
});
test('stale whole-selection patches are rejected only after a selection mutation',()=>{
  const state=session();state.revision=20;state.selectionRevision=4;
  assert.equal(applyUIPatch(state,{selectedURLs:[record(1).url]},5).selectedURLs.length,1);
  assert.throws(()=>applyUIPatch(state,{selectedURLs:[record(1).url]},3),/更新/);
});
test('all four sessions share one byte budget, including selected records and jobs',()=>{
  const states=Array.from({length:4},(_,i)=>({...session(),id:String(i),items:[{...record(i),alt:'x'.repeat(1600000)}]}));
  assert.throws(()=>assertSessionBudget(states[0],states),/容量/);
  const state=session();state.selectedItems=[{...record(9),alt:'x'.repeat(9*1024*1024)}];state.selectedURLs=[record(9).url];
  assert.throws(()=>assertSessionBudget(state,[]),/容量/);
});
