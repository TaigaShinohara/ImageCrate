import test from 'node:test';
import assert from 'node:assert/strict';
import {createTransferBudget, reserveTransferAttempt, recordTransferBytes, settleTransferAttempt,
  transferBudgetRemaining,transferOutputBudgetRemaining} from '../extension/transfer-budget.js';

const reserve = (budget, attemptId = 'a1', logicalJobId = 'image', maxBytes = 10, now = 100) =>
  reserveTransferAttempt(budget, {attemptId,logicalJobId,maxBytes,now});

test('whole attempt capacity is reserved before fetch and known actual bytes refund only unused capacity', () => {
  const initial = createTransferBudget({now:100,maxBytes:20,timeoutMs:50});
  const reserved = reserve(initial);
  assert.equal(initial.reservedBytes, 0); assert.equal(reserved.reservedBytes, 10);
  assert.equal(transferBudgetRemaining(reserved), 10);
  const second = reserve(reserved, 'b1', 'other');
  assert.throws(() => reserve(second, 'c1', 'third'), error => error.code === 'batch-byte-limit');
  const progress = recordTransferBytes(second, {attemptId:'a1',bytesReceived:3});
  assert.equal(recordTransferBytes(progress, {attemptId:'a1',bytesReceived:2}), progress);
  const settled = settleTransferAttempt(progress, {attemptId:'a1',bytesReceived:3,outcome:'complete',outputBytes:17});
  assert.equal(settled.consumedBytes, 3); assert.equal(settled.reservedBytes, 10);
  assert.equal(settled.outputBytes, 17); assert.equal(transferBudgetRemaining(settled), 7);
  assert.equal(settleTransferAttempt(settled, {attemptId:'a1',bytesReceived:3,outputBytes:17}), settled);
});

test('retry keeps logical attempt count, byte consumption and original batch deadline through JSON persistence', () => {
  let budget = createTransferBudget({now:100,maxBytes:100,timeoutMs:50});
  for (let i = 1; i <= 3; i++) {
    budget = reserve(budget, `a${i}`, 'image', 10, 100 + i);
    budget = settleTransferAttempt(budget, {attemptId:`a${i}`,bytesReceived:2,outcome:'interrupted'});
    budget = JSON.parse(JSON.stringify(budget));
  }
  assert.equal(budget.startedAt, 100); assert.equal(budget.deadline, 150);
  assert.equal(budget.consumedBytes, 6); assert.equal(budget.logicalAttempts.image, 3);
  assert.throws(() => reserve(budget, 'a4', 'image'), error => error.code === 'attempt-limit');
  assert.throws(() => reserve(budget, 'other', 'fresh', 1, 150), error => error.code === 'batch-deadline');
});

test('unknown or missing observations never refund reservation or permit another attempt for that logical job', () => {
  for (const result of [{outcome:'unknown',bytesReceived:1},{outcome:'interrupted'}]) {
    const budget = settleTransferAttempt(reserve(createTransferBudget({now:100,maxBytes:20})), {attemptId:'a1',...result});
    assert.equal(budget.reservedBytes, 0); assert.equal(budget.consumedBytes, 10);
    assert.equal(budget.attempts.a1.status, 'unknown');
    assert.throws(() => reserve(budget, 'a2'), error => error.code === 'attempt-unresolved');
  }
});

test('an active attempt is idempotent only under its original identity and cannot run twice concurrently', () => {
  const budget = reserve(createTransferBudget({now:100,maxBytes:20}));
  assert.equal(reserve(budget), budget);
  assert.throws(() => reserve(budget, 'a1', 'other'), error => error.code === 'attempt-reused');
  assert.throws(() => reserve(budget, 'a2'), error => error.code === 'attempt-unresolved');
  assert.equal(budget.logicalAttempts.image, 1);
});

test('observed oversized delivery is fully charged and output bytes do not silently reset transfer capacity', () => {
  const budget = settleTransferAttempt(reserve(createTransferBudget({now:100,maxBytes:20})), {
    attemptId:'a1',bytesReceived:25,outcome:'interrupted',outputBytes:100});
  assert.equal(budget.consumedBytes, 25); assert.equal(budget.outputBytes, 100);
  assert.equal(transferBudgetRemaining(budget), 0);
  assert.throws(() => reserve(budget, 'b1', 'other', 1), error => error.code === 'batch-byte-limit');
});

test('prototype-like IDs are ordinary own identities and invalid persisted policy fails closed', () => {
  let budget = reserve(createTransferBudget({now:100,maxBytes:20}), '__proto__', 'constructor');
  budget = settleTransferAttempt(budget, {attemptId:'__proto__',bytesReceived:1});
  assert.equal(Object.hasOwn(budget.attempts, '__proto__'), true);
  assert.equal(budget.logicalAttempts.constructor, 1);
  assert.throws(() => reserve({...budget,version:0}, 'a2'), error => error.code === 'invalid-budget');
  assert.throws(() => reserve({...budget,deadline:Infinity}, 'a2'), error => error.code === 'invalid-budget');
});

test('source and expanded output use independent atomic budgets and known settlement releases unused output', () => {
  const initial=createTransferBudget({now:100,maxBytes:100,maxOutputBytes:20});
  const one=reserveTransferAttempt(initial,{attemptId:'one',logicalJobId:'image-one',maxBytes:1,maxOutputBytes:15,now:100});
  assert.equal(transferBudgetRemaining(one),99);assert.equal(transferOutputBudgetRemaining(one),5);
  assert.throws(()=>reserveTransferAttempt(one,{attemptId:'two',logicalJobId:'image-two',maxBytes:1,maxOutputBytes:6,now:100}),
    error=>error.code==='batch-output-limit');
  assert.equal(one.reservedBytes,1);assert.equal(one.reservedOutputBytes,15,'a rejected combined reservation changes neither budget');
  const settled=settleTransferAttempt(one,{attemptId:'one',bytesReceived:1,outcome:'complete',outputBytes:12});
  assert.equal(settled.consumedBytes,1);assert.equal(settled.outputBytes,12);assert.equal(settled.reservedOutputBytes,0);
  assert.equal(transferOutputBudgetRemaining(settled),8);
  const next=reserveTransferAttempt(settled,{attemptId:'two',logicalJobId:'image-two',maxBytes:1,maxOutputBytes:8,now:100});
  assert.equal(transferOutputBudgetRemaining(next),0);assert.equal(transferBudgetRemaining(next),98);
});

test('unknown file output consumes its full allowance, while failed-before-write consumes zero output', () => {
  for(const outputUnknown of [true,false]) {
    const budget=reserveTransferAttempt(createTransferBudget({now:100,maxBytes:100,maxOutputBytes:20}),
      {attemptId:'one',logicalJobId:'image',maxBytes:10,maxOutputBytes:20,now:100});
    const settled=settleTransferAttempt(budget,{attemptId:'one',bytesReceived:2,outcome:'interrupted',outputBytes:0,outputUnknown});
    assert.equal(settled.consumedBytes,2,'output uncertainty does not double-count source bytes');
    assert.equal(settled.reservedOutputBytes,0);
    assert.equal(settled.outputBytes,outputUnknown?20:0);
    assert.equal(transferOutputBudgetRemaining(settled),outputUnknown?0:20);
  }
  const budget=reserveTransferAttempt(createTransferBudget({now:100,maxBytes:100,maxOutputBytes:20}),
    {attemptId:'one',logicalJobId:'image',maxBytes:10,maxOutputBytes:20,now:100});
  const sourceUnknown=settleTransferAttempt(budget,{attemptId:'one',outcome:'unknown',outputUnknown:false});
  assert.equal(sourceUnknown.consumedBytes,10);assert.equal(sourceUnknown.outputBytes,0);
});
