const DATABASE = 'imagecrate-directories';
const STORE = 'handles';
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
