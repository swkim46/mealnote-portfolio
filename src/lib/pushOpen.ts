// 알림을 눌러 연 화면으로 이동(v1.7). 서비스워커(public/push-sw.js)가 IndexedDB에 적어 둔 요청을 앱이 꺼내 쓴다.
// 아래 PUSH_OPEN_DB·PUSH_SCREENS는 push-sw.js와 같은 값이어야 한다(scripts/unit-check.mjs가 두 파일을 대조한다).
import { useEffect, useRef } from 'react';
import { supabase } from './supabase';
import { currentSubscription } from './push';

export const PUSH_OPEN_DB = { name: 'mealnote-push', version: 1, store: 'kv', key: 'open' } as const;
export const PUSH_SCREENS = ['queue', 'feedback', 'today'] as const;
export type PushScreen = (typeof PUSH_SCREENS)[number];

interface Pending {
  open: PushScreen;
  uid: string;
  at: number;
}

const isPending = (v: unknown): v is Pending => {
  const p = v as Partial<Pending> | null;
  return !!p && typeof p.uid === 'string' && typeof p.at === 'number' && (PUSH_SCREENS as readonly string[]).includes(p.open as string);
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(PUSH_OPEN_DB.name, PUSH_OPEN_DB.version);
    r.onupgradeneeded = () => r.result.createObjectStore(PUSH_OPEN_DB.store);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 서비스워커가 적어 둔 '열 화면'을 꺼내고 지운다(한 번만 쓰인다) */
async function takePending(): Promise<Pending | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PUSH_OPEN_DB.store, 'readwrite');
      const store = tx.objectStore(PUSH_OPEN_DB.store);
      const get = store.get(PUSH_OPEN_DB.key);
      get.onsuccess = () => {
        store.delete(PUSH_OPEN_DB.key);
        resolve(isPending(get.result) ? get.result : null);
      };
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * 알림을 눌러 앱이 열리거나 앞으로 왔을 때 그 화면으로 보낸다.
 * 받는 계정이 지금 계정과 다르거나 하루가 지난 요청은 버린다(다른 계정이면 지금 화면 그대로).
 * 시트(작성 창)는 닫지 않으므로 쓰던 내용이 남는다. 알림을 누른 것만으로 읽음 처리하지 않는다.
 * 앱이 앞으로 올 때 이 기기의 알림 권한이 꺼져 있으면 서버 등록도 지운다.
 */
export function usePushOpen(profileId: string, onOpen: (screen: PushScreen) => void) {
  const handler = useRef(onOpen);
  useEffect(() => {
    handler.current = onOpen;
  });
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const take = async () => {
      const p = await takePending().catch(() => null);
      if (!p || p.uid !== profileId || Date.now() - p.at > 86_400_000) return;
      handler.current(p.open);
    };
    const resync = async () => {
      if (!('Notification' in window) || Notification.permission === 'granted') return;
      const sub = await currentSubscription().catch(() => null);
      if (sub) await supabase.rpc('unregister_push', { p_endpoint: sub.endpoint });
    };
    void take();
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'mealnote:push-open') void take();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void take();
      void resync().catch(() => {});
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [profileId]);
}
