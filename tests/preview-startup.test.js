import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {previewPermissionHosts,startupPreviewOrigins,createPreviewStartup} from '../extension/preview-startup.js';

const source='https://source.test/page',tab={id:1,url:source,status:'complete'};
function probe(nodes,{url=source,base='https://source.test/',step=0}={}){
  let index=0,now=0;const document={URL:url,baseURI:base,createTreeWalker(){return{nextNode:()=>nodes[index++]||null};}};
  for(const node of nodes){node.ownerDocument??=document;node.getAttribute??=name=>node[name]??null;}
  return vm.runInNewContext(`(${previewPermissionHosts.toString()})(${JSON.stringify(source)})`,{document,URL,performance:{now:()=>now+=step}});
}
const image=src=>({tagName:'IMG',currentSrc:src});
const plain=value=>JSON.parse(JSON.stringify(value));
test('stateless probe returns only concrete cross-origin image hosts without query/path data',()=>{
  const result=probe([image('/a.webp'),image('https://cdn.test/path/a.webp?synthetic=1'),image('https://cdn.test/other.webp'),image('https://source.test:444/a.webp'),image('data:image/png;base64,AA=='),image('https://user:pass@secret.test/a'),image('https://*.invalid.test/a'),{tagName:'IMG','data-src':'https://lazy.test/a.webp'}]);
  assert.deepEqual(plain(result.origins),['https://cdn.test','https://source.test:444','https://lazy.test']);
  assert.equal(result.sourceURL,source);assert.equal(result.limited,false);
});
test('source identity uses document URL even with an unrelated base and refuses stale documents',()=>{
  assert.deepEqual(plain(probe([image('a.webp')],{base:'https://cdn.test/'}).origins),['https://cdn.test']);
  assert.equal(probe([],{url:'https://different.test/'}),null);
  assert.deepEqual(plain(probe([image('a')],{base:'x'.repeat(131073)}).origins),[]);
});
test('probe traversal, URL attempts, characters and host counts stay bounded',()=>{
  assert.equal(probe(Array.from({length:12001},()=>({tagName:'DIV'}))).limited,true);
  assert.equal(probe(Array.from({length:501},()=>image('https://cdn.test/a'))).limited,true);
  const hosts=probe(Array.from({length:200},(_,i)=>image(`https://h${i}.test/a`)));assert.equal(hosts.origins.length,128);assert.equal(hosts.limited,true);
  assert.equal(probe([image('x'.repeat(131073))]).limited,true);
  assert.equal(probe([image('https://cdn.test/a')],{step:26}).limited,true);
});
test('worker independently validates origins, removes exact source and existing grants, and deduplicates all-port patterns',()=>{
  const data={sourceURL:source,origins:['https://source.test','https://source.test:444','https://cdn.test','https://cdn.test:444','http://other.test']};
  assert.deepEqual(startupPreviewOrigins(data,source,['https://*.test/*']),['http://other.test/*']);
  assert.deepEqual(startupPreviewOrigins(data,source,[]),['https://source.test/*','https://cdn.test/*','http://other.test/*']);
  assert.deepEqual(startupPreviewOrigins(data,source,['<all_urls>']),[]);
  for(const value of ['https://cdn.test/path','https://user:pw@cdn.test','https://*.test','data:image/png,a'])assert.throws(()=>startupPreviewOrigins({sourceURL:source,origins:[value]},source,[]));
  assert.throws(()=>startupPreviewOrigins({sourceURL:'https://other.test',origins:[]},source,[]));
  assert.throws(()=>startupPreviewOrigins({sourceURL:source,origins:Array(129).fill('https://cdn.test')},source,[]));
});
function harness(options={}){
  const updated=[],removed=[],opened=[],requests=[],callbacks={};let callbackScope=false;
  const api={runtime:{},tabs:{onUpdated:{addListener:fn=>updated.push(fn)},onRemoved:{addListener:fn=>removed.push(fn)}},
    scripting:{executeScript(request,callback){assert.equal(request.target.tabId,options.tabId??1);callbacks.script=callback;if(options.scriptThrow)throw Error('injection failed');}},
    permissions:{getAll(callback){callbacks.grants=callback;if(options.grantsThrow)throw Error('query failed');},request(request,callback){assert.equal(callbackScope,true,'the request stays in the native callback stack');requests.push(request);callbacks.permission=callback;if(options.requestThrow)throw Error('request failed');}}};
  const startup=createPreviewStartup({api,onOpen:page=>opened.push(page.id),timeoutMs:options.timeoutMs??5000});
  const call=(kind,value,error)=>{api.runtime.lastError=error?{message:error}:undefined;callbackScope=true;try{callbacks[kind](value);}finally{callbackScope=false;delete api.runtime.lastError;}};
  return{api,startup,opened,requests,callbacks,updated,removed,call,
    script(result={sourceURL:source,origins:['https://cdn.test']},error){call('script',[{frameId:0,documentId:'doc-1',result}],error);},
    grants(origins=[],error){call('grants',{origins},error);},
    permission(allowed=true,error){call('permission',allowed,error);}};
}
test('both callback orders request one concrete CDN grant before opening the workspace',()=>{
  for(const order of [['script','grants'],['grants','script']]){
    const h=harness();h.startup.open(tab);h[order[0]]();assert.deepEqual(h.requests,[]);h[order[1]]();
    assert.deepEqual(h.requests,[{origins:['https://cdn.test/*']}]);assert.deepEqual(h.opened,[]);
    h.permission();assert.deepEqual(h.opened,[1]);assert.deepEqual(h.startup.stats(),{pendingProbes:0,permissionPending:false});
  }
});
test('existing grants, same-origin images, invalid results and callback errors fall back without widening access',()=>{
  for(const prepare of [h=>{h.grants(['https://cdn.test/*']);h.script();},h=>{h.grants();h.script({sourceURL:source,origins:['https://source.test']});},h=>{h.grants([], 'query failed');h.script();},h=>{h.grants();h.script(undefined,'injection failed');},h=>{h.grants();h.script({sourceURL:source,origins:['https://*.test']});}]){
    const h=harness();h.startup.open(tab);prepare(h);assert.deepEqual(h.requests,[]);assert.deepEqual(h.opened,[1]);
  }
});
test('denied permissions open a usable workspace once and never retry automatically',()=>{
  const h=harness();h.startup.open(tab);h.grants();h.script();h.permission(false);assert.deepEqual(h.opened,[1]);assert.equal(h.requests.length,1);
});
test('synchronous API errors are contained and do not request permissions',()=>{
  for(const options of [{grantsThrow:true},{scriptThrow:true},{requestThrow:true}]){
    const h=harness(options);h.startup.open(tab);if(!options.grantsThrow)h.grants();if(!options.scriptThrow)h.script();
    assert.deepEqual(h.opened,[1]);assert.equal(h.startup.stats().pendingProbes,0);
  }
});
test('source navigation and closure discard callbacks, including an outstanding permission dialog',()=>{
  for(const duringDialog of [false,true]){
    const h=harness();h.startup.open(tab);if(duringDialog){h.grants();h.script();}
    h.updated[0](1,{status:'loading'});if(duringDialog)h.permission();else{h.grants();h.script();}
    assert.deepEqual(h.opened,[]);assert.equal(h.requests.length,duringDialog?1:0);
  }
  const h=harness();h.startup.open(tab);h.removed[0](1);h.grants();h.script();assert.deepEqual(h.requests,[]);assert.deepEqual(h.opened,[]);
});
test('timeout keeps its unsettled slot and ignores every late grant/probe response',async()=>{
  const h=harness({timeoutMs:5});h.startup.open(tab);h.startup.open(tab);
  await new Promise(resolve=>setTimeout(resolve,12));assert.deepEqual(h.opened,[1]);assert.equal(h.startup.stats().pendingProbes,1);
  h.grants();h.script();assert.deepEqual(h.requests,[]);assert.equal(h.startup.stats().pendingProbes,0);
});
test('a second toolbar operation does not create a concurrent permission dialog',()=>{
  const h=harness();h.startup.open(tab);h.grants();h.script();h.startup.open({...tab,id:2});assert.deepEqual(h.opened,[2]);assert.equal(h.requests.length,1);h.permission();assert.deepEqual(h.opened,[2,1]);
});

test('stateless probe slots are bounded to four and a closed tab releases its slot',()=>{
  const requests=[],opened=[],removed=[];
  const api={runtime:{},tabs:{onUpdated:{addListener(){}},onRemoved:{addListener:fn=>removed.push(fn)}},permissions:{getAll(){},request(){assert.fail('unsettled probes cannot request permission');}},scripting:{executeScript(request){requests.push(request.target.tabId);}}};
  const startup=createPreviewStartup({api,onOpen:page=>opened.push(page.id)});
  for(let id=1;id<=5;id++)startup.open({...tab,id});
  assert.deepEqual(requests,[1,2,3,4]);assert.deepEqual(opened,[5]);assert.equal(startup.stats().pendingProbes,4);
  startup.open(tab);assert.equal(requests.length,4);removed[0](1);startup.open({...tab,id:6});assert.deepEqual(requests,[1,2,3,4,6]);
  for(const id of [2,3,4,6])removed[0](id);
});
