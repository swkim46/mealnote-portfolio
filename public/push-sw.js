// 푸시 알림 받기·누르기(v1.7). vite-plugin-pwa가 만드는 서비스워커에 workbox.importScripts로 붙는다(vite.config.ts).
// 새 버전 적용 흐름(appUpdate.ts)은 건드리지 않는다.
// 알림을 누르면 이동할 화면을 IndexedDB에 잠시 적어 두고, 열린 앱이 있으면 그 창을 앞으로 가져와 알린다.
// 주소를 바꿔 새로 고치지 않으므로 작성 중인 입력이 남는다. 앱은 로그인·프로필 확인 뒤 받는 계정이 같을 때만 이동한다.
// 저장소 이름·버전·저장소·키와 화면 목록은 src/lib/pushOpen.ts(PUSH_OPEN_DB·PUSH_SCREENS)와 같아야 한다 — scripts/unit-check.mjs가 대조한다.
const SCREENS = ['queue', 'feedback', 'today'];

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('mealnote-push', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function savePending(value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, 'open');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = {};
  }
  const str = (v) => (typeof v === 'string' ? v : '');
  event.waitUntil(
    self.registration.showNotification(str(d.title) || '식단노트', {
      body: str(d.body),
      tag: str(d.tag) || undefined,
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      data: { open: SCREENS.includes(d.open) ? d.open : '', uid: str(d.uid) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      if (data.open) await savePending({ open: data.open, uid: data.uid, at: Date.now() }).catch(() => {});
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ type: 'mealnote:push-open' });
        return;
      }
      await self.clients.openWindow('/');
    })(),
  );
});
