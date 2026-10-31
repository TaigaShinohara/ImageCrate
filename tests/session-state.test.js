import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionDefaults, applyUIPatch, applyJobCompletions, assertSessionBudget, selectableItems} from '../extension/session-state.js';
const record=index=>({url:`https://synthetic.test/${index}.png`,width:20,height:10});
const session=()=>sessionDefaults({id:'s',items:[record(1),record(2)],jobs:[]});
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
