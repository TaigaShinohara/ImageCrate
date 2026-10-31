import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateCatalog, candidateMatches, representativeCandidates} from '../extension/gallery.js';

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

test('keeping unknown dimensions does not bypass text or type conditions', () => {
  assert.equal(candidateMatches(item('landscape'),{query:'landscape',type:'png',width:2000}),true);
  assert.equal(candidateMatches(item('landscape'),{query:'portrait',width:2000}),false);
  assert.equal(candidateMatches(item('landscape'),{type:'jpg',width:2000}),false);
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
