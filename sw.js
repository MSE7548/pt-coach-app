// 앱 껍데기만 캐시한다. 녹음 데이터는 IndexedDB에 있고 여기서 건드리지 않는다.
// 이름을 올리면 activate가 낡은 캐시를 지운다. 흰 화면을 고칠 때 함께 올린다.
const CACHE = 'pt-coach-os-v3';
const SHELL = [
  '.', 'index.html', 'styles.css', 'app.js', 'store.js', 'recorder.js',
  'manifest.webmanifest', 'icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 네트워크를 먼저 쓰고 실패할 때만 캐시로 떨어진다.
//
// 캐시 우선으로 두면 앱을 고쳐도 사용자에게 영원히 안 간다. 캐시 이름이 고정이라
// 낡은 파일이 계속 살아남기 때문이다. 2026-08-11에 실제로 이 문제로 수정한 코드가
// 반영되지 않았다. 오프라인 동작은 아래 fallback으로 유지된다.
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  e.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || Promise.reject(new Error('offline'))))
  );
});
