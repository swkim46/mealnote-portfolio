// 푸시 알림(v1.7): 이 기기 켜기·끄기(브라우저 구독 + 서버 등록)와 종류별 설정(계정 전체) API.
// 알림을 눌러 연 화면으로 이동하는 부분은 pushOpen.ts(화면 훅). 로그아웃(auth.ts)은 이 파일의 등록 해제만 쓴다.
// 계획: docs/reference/푸시알림_계획_261026.md. 서버 쪽은 supabase/migrations/20261026000002_push.sql·functions/send-push.
import { supabase } from './supabase';

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type PushSupport = 'ok' | 'install' | 'unsupported' | 'unconfigured';
export type DeviceState = 'on' | 'off' | 'denied';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** 이 화면에서 알림을 켤 수 있나. 브라우저 이름이 아니라 기능 지원과 설치 상태로 본다 */
export function pushSupport(): PushSupport {
  const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!has) return isIos() && !standalone() ? 'install' : 'unsupported';
  if (!VAPID) return 'unconfigured';
  return 'ok';
}

const b64uToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** 이 기기가 지금 계정·세션으로 알림을 받고 있나 */
export async function deviceState(): Promise<DeviceState> {
  if (pushSupport() !== 'ok') return 'off';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentSubscription();
  if (!sub || Notification.permission !== 'granted') return 'off';
  const { data, error } = await supabase.rpc('push_registered', { p_endpoint: sub.endpoint });
  if (error) throw error;
  return data === true ? 'on' : 'off';
}

export type EnableResult = 'ok' | 'denied' | 'subscribe_failed' | 'save_failed' | 'bad_endpoint' | 'unsupported';

/**
 * 알림 켜기: 버튼 클릭 안에서 불러야 한다(아이폰은 사람이 누를 때만 허용 창을 띄운다).
 * 허용 → 이 기기 등록 → 서버 저장 → 시험 알림 접수 순서. 서버 저장이 실패하면 켰다고 하지 않는다.
 */
export async function enablePush(): Promise<{ result: EnableResult; tested: boolean }> {
  if (pushSupport() !== 'ok') return { result: 'unsupported', tested: false };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { result: 'denied', tested: false };
  let sub: PushSubscription;
  try {
    // 서비스워커가 없는 화면(개발 서버 등)에서 끝없이 기다리지 않게 8초 제한
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no_service_worker')), 8000)),
    ]);
    sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID!) }));
  } catch {
    return { result: 'subscribe_failed', tested: false };
  }
  const json = sub.toJSON();
  const { data, error } = await supabase.rpc('register_push', { p_endpoint: sub.endpoint, p_p256dh: json.keys?.p256dh ?? '', p_auth: json.keys?.auth ?? '' });
  if (error) return { result: 'save_failed', tested: false };
  const status = (data as { status?: string } | null)?.status;
  if (status === 'bad_endpoint') return { result: 'bad_endpoint', tested: false };
  if (status !== 'ok') return { result: 'save_failed', tested: false };
  const test = await supabase.rpc('push_test');
  return { result: 'ok', tested: !test.error && (test.data as { status?: string } | null)?.status === 'ok' };
}

/** 이 기기 알림 끄기: 서버 등록을 지우고 브라우저 구독도 끊는다 */
export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  const { error } = await supabase.rpc('unregister_push', { p_endpoint: sub.endpoint });
  if (error) throw error;
  await sub.unsubscribe().catch(() => {});
}

/** 로그아웃 직전: 이 기기의 서버 등록만 지운다(최대 2초, 실패해도 로그아웃은 진행) */
export async function unregisterThisDevice() {
  const job = (async () => {
    const sub = await currentSubscription();
    if (sub) await supabase.rpc('unregister_push', { p_endpoint: sub.endpoint });
  })();
  await Promise.race([job.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
}

// ─── 종류별 설정(계정 전체) ───
export interface PushPrefs {
  digest: boolean;
  digest_times: '3' | '5';
  feedback: boolean;
  reminder: boolean;
  morning: boolean;
}
/** 서버에 행이 없을 때의 값(서버 표의 기본값과 같다). 조회 실패를 이 값으로 바꾸지 않는다 */
export const DEFAULT_PREFS: PushPrefs = { digest: true, digest_times: '3', feedback: true, reminder: true, morning: true };
const PREFS_COLUMNS = 'digest, digest_times, feedback, reminder, morning';

function parsePrefs(v: unknown): PushPrefs {
  const r = v as Partial<PushPrefs> | null;
  if (
    !r ||
    typeof r.digest !== 'boolean' ||
    typeof r.feedback !== 'boolean' ||
    typeof r.reminder !== 'boolean' ||
    typeof r.morning !== 'boolean' ||
    (r.digest_times !== '3' && r.digest_times !== '5')
  ) {
    throw new Error('bad_prefs');
  }
  return { digest: r.digest, digest_times: r.digest_times, feedback: r.feedback, reminder: r.reminder, morning: r.morning };
}

/** 조회 실패는 던진다(기본값으로 바꾸지 않는다). 행이 없으면 기본값 */
export async function fetchPrefs(userId: string): Promise<PushPrefs> {
  const { data, error } = await supabase.from('push_prefs').select(PREFS_COLUMNS).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data ? parsePrefs(data) : DEFAULT_PREFS;
}

/**
 * 바꾼 항목만 저장하고 서버에 남은 값을 돌려준다. 다른 기기에서 바꾼 항목을 이 기기의 옛 값으로 덮지 않는다.
 * (행이 없으면 바꾼 항목 말고는 서버 기본값으로 만들어진다)
 */
export async function savePrefs(userId: string, patch: Partial<PushPrefs>): Promise<PushPrefs> {
  const { data, error } = await supabase
    .from('push_prefs')
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() })
    .select(PREFS_COLUMNS)
    .single();
  if (error) throw error;
  return parsePrefs(data);
}
