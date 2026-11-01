const DATABASE = 'imagecrate-directories';
const STORE = 'handles';
const REMEMBER_POLICY = 'remember-destination';
class DestinationPolicyError extends Error {}
let opening;

function database() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(new Error('保存先の設定を読み込めませんでした。もう一度フォルダを選んでください。'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('保存先の設定を開けません。他のImageCrateタブを閉じて再度お試しください。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    }).catch(error => { opening = null; throw error; });
  }
  return opening;
}

async function access(key, mode, operation) {
  if (typeof key !== 'string' || !key) throw new Error('保存先の設定キーが不正です。');
  const db = await database();
  return new Promise((resolve, reject) => {
    let value;
    let transaction;
    const fail = () => reject(new Error(mode === 'readonly'
      ? '保存先の設定を読み込めませんでした。もう一度フォルダを選んでください。'
      : '保存先の設定を記録できませんでした。もう一度お試しください。'));
    try {
      transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value ?? null);
      transaction.onerror = fail;
      transaction.onabort = fail;
    } catch { fail(); }
  });
}

export const getDirectory = key => access(key, 'readonly', store => store.get(key));
export const putDirectory = (key, handle) => access(key, 'readwrite', store => store.put(handle, key));
export const deleteDirectory = key => access(key, 'readwrite', store => store.delete(key));

function rememberPolicy(stored) {
  // Absence is the pre-policy behavior. A malformed existing policy must not
  // silently turn a deliberate OFF setting back on.
  if (stored == null) return {remember:true, revision:0};
  if (typeof stored.remember !== 'boolean' || !Number.isSafeInteger(stored.revision) || stored.revision < 0) {
    throw new DestinationPolicyError('次回用の保存先設定を読み込めません。保存設定からもう一度確認してください。');
  }
  return {remember:stored.remember, revision:stored.revision};
}

export async function getRememberDestination() {
  return rememberPolicy(await access(REMEMBER_POLICY, 'readonly', store => store.get(REMEMBER_POLICY)));
}

export async function getLastDestination() {
  if (!(await getRememberDestination()).remember) return null;
  const stored = await access('last-destination', 'readonly', store => store.get('last-destination'));
  if (stored && ['directory','downloads'].includes(stored.destination)) {
    return {handle:stored.handle || null, destination:stored.destination};
  }
  const handle = await getDirectory('last');
  return handle ? {handle, destination:'directory'} : null;
}

export async function putLastDestination({handle = null, destination} = {}, policyChange = {}) {
  if (!['directory','downloads'].includes(destination) || (destination === 'directory' && !handle)) {
    throw new Error('保存先の設定が不正です。もう一度フォルダを選んでください。');
  }
  const explicit = Object.hasOwn(policyChange,'remember');
  if (explicit && (typeof policyChange.remember !== 'boolean' || !Number.isSafeInteger(policyChange.expectedRevision) || policyChange.expectedRevision < 0)) {
    throw new Error('次回用の保存先設定が正しくありません。設定を開き直してください。');
  }
  const db = await database();
  // IndexedDB serializes these readwrite transactions across extension tabs.
  // Read the current policy inside the same transaction as both memo entries;
  // a format-only apply from an old tab can therefore never resurrect OFF.
  return new Promise((resolve,reject) => {
    let result, failure;
    const fail = () => reject(failure || new Error('次回用の保存先設定を記録できませんでした。もう一度お試しください。'));
    try {
      const transaction = db.transaction(STORE,'readwrite'), store = transaction.objectStore(STORE);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = fail; transaction.onabort = fail;
      const request = store.get(REMEMBER_POLICY);
      request.onsuccess = () => {
        try {
          const current = rememberPolicy(request.result);
          if (explicit && current.revision !== policyChange.expectedRevision) {
            throw new DestinationPolicyError('次回用の保存先設定が別の作業で変更されました。最新の状態を確認して、もう一度適用してください。');
          }
          if (explicit && current.revision === Number.MAX_SAFE_INTEGER) throw new DestinationPolicyError('次回用の保存先設定を更新できません。設定を確認してください。');
          result = explicit ? {remember:policyChange.remember,revision:current.revision+1} : current;
          if (explicit) store.put(result,REMEMBER_POLICY);
          if (result.remember) {
            if (handle) store.put(handle,'last'); else store.delete('last');
            store.put({handle,destination},'last-destination');
          } else {
            store.delete('last'); store.delete('last-destination');
          }
        } catch (error) { failure=error instanceof DestinationPolicyError ? error : undefined;transaction.abort(); }
      };
    } catch { fail(); }
  });
}

export async function pruneDirectories(validKeys) {
  const keep = new Set(validKeys);
  const db = await database();
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('使い終わった保存先の設定を整理できませんでした。もう一度お試しください。'));
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && /^(?:session|batch):/.test(cursor.key) && !keep.has(cursor.key)) {
          store.delete(cursor.key);
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = fail;
      transaction.onabort = fail;
    } catch { fail(); }
  });
}
