import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewStartup} from '../extension/preview-startup.js';

const tab={id:1,url:'https://source.test/page',status:'complete'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

test('toolbar opens directly without probing the page or requesting any host permission',async()=>{
  const api=new Proxy({}, {get(_target,key){assert.fail(`Opening must not access Chrome ${String(key)} APIs`);}});
  const opened=[];
  const startup=createPreviewStartup({api,onOpen:page=>opened.push(page)});
  const pending=startup.open(tab);
  assert.deepEqual(opened,[tab],'the workspace opens immediately');
  await pending;
});

test('loading pages and tabs without a normal web URL still reach workspace handling',async()=>{
  for(const page of [{...tab,status:'loading'},{...tab,url:'chrome://extensions/'},{id:2}]){
    const opened=[];
    const startup=createPreviewStartup({onOpen:value=>opened.push(value)});
    await startup.open(page);
    assert.deepEqual(opened,[page]);
  }
});

test('repeated clicks while the same workspace is opening share one operation',async()=>{
  const gate=deferred(),opened=[];
  const startup=createPreviewStartup({onOpen:page=>{opened.push(page.id);return gate.promise;}});
  const first=startup.open(tab),second=startup.open(tab);
  assert.equal(second,first);
  assert.deepEqual(opened,[1]);
  gate.resolve();await first;
  await startup.open(tab);
  assert.deepEqual(opened,[1,1],'a later click can activate the existing workspace');
});

test('a pending workspace does not delay another source tab',async()=>{
  const gate=deferred(),opened=[];
  const startup=createPreviewStartup({onOpen:page=>{opened.push(page.id);return page.id===1?gate.promise:undefined;}});
  const first=startup.open(tab);
  await startup.open({...tab,id:2});
  assert.deepEqual(opened,[1,2]);
  gate.resolve();await first;
});

test('synchronous and asynchronous open failures are reported and leave retry available',async()=>{
  for(const asynchronous of [false,true]){
    const failure=new Error('workspace failed'),errors=[];let attempts=0;
    const startup=createPreviewStartup({onOpen:()=>{
      attempts++;
      if(attempts>1)return;
      if(asynchronous)return Promise.reject(failure);
      throw failure;
    },onError:error=>errors.push(error)});
    await startup.open(tab);
    assert.deepEqual(errors,[failure]);
    await startup.open(tab);
    assert.equal(attempts,2);
  }
});
