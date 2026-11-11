// 1.3까지의 화면에서 넘어오기(2026-11-02 사용자 제보: Safari가 1.3.1에 머물러 새로고침해도 2.0이 안 뜸).
// vite-plugin-pwa가 만드는 서비스워커에 workbox.importScripts로 붙는다(vite.config.ts).
// 1.1～1.3은 registerType 'autoUpdate'라 화면에 '새 서비스워커로 넘어가라'를 보내는 코드가 없다. 1.4부터의 서비스워커는 앱의 신호를
// 기다리므로(registerType 'prompt', src/lib/appUpdate.ts) 그 화면에서는 영영 대기 상태로 남고, 새로 고쳐도 옛 저장본이 열린다.
// 지금 화면을 맡은 것이 그 시절 서비스워커일 때만 기다리지 않고 바로 맡는다 — 그 시절 저장본(workbox precache)에만 registerSW.js가 있다
// (1.4부터 injectRegister: false라 만들지 않고, 새 서비스워커가 자리를 잡으면 옛 항목은 지워진다). 1.4 이후의 화면은 그대로 앱이 시점을 정한다.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of await caches.keys()) {
          if (!name.startsWith('workbox-precache')) continue;
          const keys = await (await caches.open(name)).keys();
          if (keys.some((r) => new URL(r.url).pathname === '/registerSW.js')) {
            await self.skipWaiting();
            return;
          }
        }
      } catch {
        /* 확인하지 못하면 평소처럼 앱의 신호를 기다린다 */
      }
    })(),
  );
});
