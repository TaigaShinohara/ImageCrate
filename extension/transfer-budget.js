import {MEDIA_LIMITS, MEDIA_POLICY_VERSION, ResourceLimitError} from './media-limits.js';

function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function fail(message, code) { throw new ResourceLimitError(message, code); }
function validate(budget) {
  if (budget?.version !== MEDIA_POLICY_VERSION || !integer(budget.startedAt) || !integer(budget.deadline)
    || budget.deadline < budget.startedAt || !integer(budget.maxBytes) || !integer(budget.maxAttempts)
    || !budget.maxAttempts || !integer(budget.consumedBytes) || !integer(budget.reservedBytes)
    || !integer(budget.outputBytes) || !integer(budget.maxOutputBytes) || !integer(budget.reservedOutputBytes)
    || budget.maxOutputBytes > MEDIA_LIMITS.batch.maxOutputBytes || !budget.attempts || !budget.logicalAttempts
    || budget.maxBytes > MEDIA_LIMITS.batch.maxBytes || budget.maxAttempts > MEDIA_LIMITS.batch.maxAttempts
    || budget.deadline - budget.startedAt > MEDIA_LIMITS.batch.timeoutMs) {
    fail('保存予算を確認できません。新しい保存として準備してください。', 'invalid-budget');
  }
}
function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function own(object, key) { return Object.hasOwn(object, key) ? object[key] : undefined; }
function copy(budget) { return {...budget, attempts:{...budget.attempts}, logicalAttempts:{...budget.logicalAttempts}}; }

export function createTransferBudget({now = Date.now(), maxBytes = MEDIA_LIMITS.batch.maxBytes,
  maxOutputBytes = MEDIA_LIMITS.batch.maxOutputBytes,
  timeoutMs = MEDIA_LIMITS.batch.timeoutMs, maxAttempts = MEDIA_LIMITS.batch.maxAttempts} = {}) {
  if (!integer(now) || !integer(maxBytes) || !maxBytes || !integer(timeoutMs) || !timeoutMs
    || !integer(maxAttempts) || !maxAttempts || !Number.isSafeInteger(now + timeoutMs)
    || !integer(maxOutputBytes) || maxOutputBytes > MEDIA_LIMITS.batch.maxOutputBytes
    || maxBytes > MEDIA_LIMITS.batch.maxBytes || timeoutMs > MEDIA_LIMITS.batch.timeoutMs
    || maxAttempts > MEDIA_LIMITS.batch.maxAttempts) fail('保存予算が不正です。', 'invalid-budget');
  return {version:MEDIA_POLICY_VERSION, startedAt:now, deadline:now + timeoutMs, maxBytes, maxOutputBytes, maxAttempts,
    consumedBytes:0, reservedBytes:0, outputBytes:0, reservedOutputBytes:0, attempts:{}, logicalAttempts:{}};
}

export function transferBudgetRemaining(budget) {
  validate(budget); return Math.max(0, budget.maxBytes - budget.consumedBytes - budget.reservedBytes);
}
export function transferOutputBudgetRemaining(budget) {
  validate(budget); return Math.max(0, budget.maxOutputBytes - budget.outputBytes - budget.reservedOutputBytes);
}

// Persist this returned ledger atomically BEFORE allowing fetch/start. A retry
// uses a fresh attemptId and the same logicalJobId and ledger/deadline.
export function reserveTransferAttempt(budget, {attemptId, logicalJobId,
  maxBytes = MEDIA_LIMITS.original.maxBytes, maxOutputBytes = maxBytes, now = Date.now()} = {}) {
  validate(budget);
  if (!id(attemptId) || !id(logicalJobId) || !integer(maxBytes) || !maxBytes || !integer(now)
    || maxBytes > MEDIA_LIMITS.original.maxBytes || !integer(maxOutputBytes)
    || maxOutputBytes > MEDIA_LIMITS.original.maxBytes) fail('保存試行が不正です。', 'invalid-attempt');
  const existing = own(budget.attempts, attemptId);
  if (existing) {
    if (existing.status === 'reserved' && existing.logicalJobId === logicalJobId && existing.maxBytes === maxBytes
      && existing.maxOutputBytes === maxOutputBytes) return budget;
    fail('この保存試行は既に使用されています。', 'attempt-reused');
  }
  if (now >= budget.deadline) fail('今回の保存の制限時間を超えました。新しい保存として準備してください。', 'batch-deadline');
  if (Object.values(budget.attempts).some(attempt => attempt.logicalJobId === logicalJobId
    && ['reserved', 'unknown'].includes(attempt.status))) {
    fail('前の保存試行の結果を確認してから操作してください。', 'attempt-unresolved');
  }
  const count = own(budget.logicalAttempts, logicalJobId) || 0;
  if (count >= budget.maxAttempts) fail('この画像の再試行回数の上限に達しました。', 'attempt-limit');
  if (maxBytes > transferBudgetRemaining(budget)) fail('今回の保存の容量予算が不足しています。', 'batch-byte-limit');
  if (maxOutputBytes > transferOutputBudgetRemaining(budget)) fail('今回の保存の出力容量予算が不足しています。', 'batch-output-limit');
  const next = copy(budget);
  Object.defineProperty(next.attempts, attemptId, {value:{logicalJobId, maxBytes, maxOutputBytes, bytesReceived:0,
    status:'reserved', startedAt:now}, enumerable:true, configurable:true, writable:true});
  Object.defineProperty(next.logicalAttempts, logicalJobId, {value:count + 1, enumerable:true, configurable:true, writable:true});
  next.reservedBytes += maxBytes;
  next.reservedOutputBytes += maxOutputBytes;
  return next;
}

export function recordTransferBytes(budget, {attemptId, bytesReceived} = {}) {
  validate(budget); const attempt = own(budget.attempts, attemptId);
  if (!attempt || attempt.status !== 'reserved' || !integer(bytesReceived)) fail('保存試行の受信量を確認できません。', 'invalid-attempt');
  if (bytesReceived <= attempt.bytesReceived) return budget;
  const next = copy(budget); next.attempts[attemptId] = {...attempt, bytesReceived}; return next;
}

export function settleTransferAttempt(budget, {attemptId, bytesReceived, outcome = 'complete', outputBytes = 0,
  outputUnknown = outcome === 'unknown'} = {}) {
  validate(budget); const attempt = own(budget.attempts, attemptId);
  if (!attempt || !['complete', 'interrupted', 'unknown'].includes(outcome) || !integer(outputBytes)
    || typeof outputUnknown !== 'boolean'
    || (bytesReceived !== undefined && !integer(bytesReceived))) fail('保存試行の結果を確認できません。', 'invalid-attempt');
  if (attempt.status !== 'reserved') return budget;
  // Missing observations (crash/unknown write outcome) never refund a byte.
  const unknown = outcome === 'unknown' || bytesReceived === undefined;
  const actual = Math.max(attempt.bytesReceived, bytesReceived || 0);
  const chargedBytes = unknown ? Math.max(attempt.maxBytes, actual) : actual;
  const chargedOutputBytes = outputUnknown ? Math.max(attempt.maxOutputBytes, outputBytes) : outputBytes;
  if (!Number.isSafeInteger(budget.consumedBytes + chargedBytes) || !Number.isSafeInteger(budget.outputBytes + chargedOutputBytes)) fail('保存予算が不正です。', 'invalid-budget');
  const next = copy(budget); next.reservedBytes -= attempt.maxBytes; next.consumedBytes += chargedBytes;
  next.reservedOutputBytes -= attempt.maxOutputBytes;
  next.outputBytes += chargedOutputBytes;
  next.attempts[attemptId] = {...attempt, status:unknown || outputUnknown ? 'unknown' : outcome,
    bytesReceived:actual, chargedBytes, outputBytes, chargedOutputBytes, outputUnknown};
  return next;
}
