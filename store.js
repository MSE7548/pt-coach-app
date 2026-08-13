// 기기 안에서만 쓰는 저장소. 조각을 IndexedDB에 남겨 앱이 죽어도 복구한다.
// 업로드는 조각을 하나로 합쳐서 보낸다 — Stage 1이 "파일 하나 = 세션 하나"로 보기 때문이다.

const DB_NAME = 'pt-coach-os';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const META = 'meta';
const ACTIVE_KEY = 'active-session';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: ['sessionId', 'index'] });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, run) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = run(t.objectStore(store));
    t.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function putChunk(sessionId, index, blob) {
  await tx(CHUNKS, 'readwrite', s => s.put({ sessionId, index, blob, at: Date.now() }));
}

export async function listChunks(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
    const req = db.transaction(CHUNKS, 'readonly').objectStore(CHUNKS).openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { out.sort((a, b) => a.index - b.index); resolve(out); return; }
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dropChunks(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
    const t = db.transaction(CHUNKS, 'readwrite');
    const req = t.objectStore(CHUNKS).openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      cur.delete();
      cur.continue();
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// 진행 중인 세션 한 건. 앱이 죽으면 이것으로 복구 화면을 띄운다.
export async function setActive(meta) {
  await tx(META, 'readwrite', s => s.put(meta, ACTIVE_KEY));
}

export async function getActive() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(META, 'readonly').objectStore(META).get(ACTIVE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearActive() {
  await tx(META, 'readwrite', s => s.delete(ACTIVE_KEY));
}

// 회차 자동 계산의 근거. 회원별로 끝낸 녹음 수를 센다.
// PT 회차(결제 기준)가 아니라 녹음 회차다. 둘은 어긋날 수 있다.
const ROUNDS_KEY = 'rounds-by-member';

export async function bumpRound(memberId) {
  const counts = await getRounds();
  counts[memberId] = (counts[memberId] || 0) + 1;
  await tx(META, 'readwrite', s => s.put(counts, ROUNDS_KEY));
  return counts[memberId];
}

export async function getRounds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(META, 'readonly').objectStore(META).get(ROUNDS_KEY);
    req.onsuccess = () => resolve(req.result || {});
    req.onerror = () => reject(req.error);
  });
}
