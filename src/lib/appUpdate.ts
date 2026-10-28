// 새 버전 적용(v1.4). 사용자가 새로고침을 몰라도 새 버전을 쓰게 한다.
// - 앱으로 돌아올 때와 켜 둔 동안 30분마다 새 버전을 확인한다(확인용 파일 약 1KB, 바뀐 게 없으면 수백 바이트).
// - 앱으로 돌아온 직후 새 버전을 찾았고 입력 중이 아니면 조용히 바로 적용한다.
// - 입력 중(시트가 열려 있거나, 입력칸에 커서가 있거나, 화면 안에 저장하지 않은 글이 있음)이거나 화면을 보는 도중 찾았으면 띠만 띄우고, 다음에 돌아올 때 적용한다.
// - 적용 직전 로그인 연장 작업이 끝나기를 기다린다(연장 중에 화면을 새로 그리면 새 열쇠를 못 받아 로그아웃될 수 있다).
// - 새로고침은 모두 reloadIfSafe 한 곳을 거친다: 라이브러리의 '새 버전이 맡음' 신호(다른 탭이 적용한 경우 포함),
//   적용 3초 뒤 직접 새로고침, '지금 적용'. 자동 새로고침은 그 순간 입력 중이면 미루고 띠를 남긴다(Codex 재검토 v1.4 r3 P2).
import { registerSW } from 'virtual:pwa-register';
import { supabase } from './supabase';

const CHECK_EVERY_MS = 30 * 60 * 1000;
const RESUME_WINDOW_MS = 8000; // 돌아온 뒤 이 시간 안에 찾은 새 버전은 '돌아온 순간'으로 보고 바로 적용

type Listener = (ready: boolean) => void;
const listeners = new Set<Listener>();
let ready = false;
let resumedAt = Date.now();
let applying = false;
let update: ((reload?: boolean) => Promise<void>) | null = null;
let manual = false; // '지금 적용'을 눌렀다 → 입력이 있어도 새로 고친다
let reloadPending = false; // 새 버전이 이미 화면을 맡았지만 입력 때문에 새로고침을 미뤘다
let reloading = false;
let registration: ServiceWorkerRegistration | undefined;

const setReady = (v: boolean) => {
  ready = v;
  listeners.forEach((l) => l(v));
};

export function onUpdateReady(l: Listener) {
  listeners.add(l);
  l(ready);
  return () => listeners.delete(l);
}

// 시트 밖에서 쓰는 글(트레이너 한마디, 로그인·가입 화면)은 커서가 떠나도 저장 전이면 지켜야 한다(Codex 리뷰 v1.4 P2).
const unsaved = new Set<string>();

/** 화면 안에 저장하지 않은 입력이 있음을 알린다(on=false로 해제). 화면이 사라질 때도 꼭 해제한다. */
export function setUnsaved(key: string, on: boolean) {
  if (on) unsaved.add(key);
  else unsaved.delete(key);
}

/** 입력 중인가: 시트(식단 등록·댓글·PIN 등)가 열려 있거나, 입력칸에 커서가 있거나, 저장하지 않은 입력이 있다 */
export function isBusy() {
  if (unsaved.size) return true;
  if (document.querySelector('dialog[open]')) return true;
  const el = document.activeElement;
  return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * 모든 새로고침이 거치는 곳. 로그인 연장이 끝나기를 기다리고, '지금 적용'이 아니면 그 앞뒤로 입력 중인지 보고 입력 중이면 미루고 띠를 남긴다.
 * 미룬 새로고침은 '지금 적용'을 누르거나, 입력을 마친 뒤 앱으로 돌아올 때 한다.
 */
async function reloadIfSafe() {
  if (reloading) return;
  const defer = () => {
    reloadPending = true;
    applying = false;
    setReady(true);
  };
  if (!manual && isBusy()) return defer();
  // 어느 경로든(다른 탭이 적용한 신호 포함) 진행 중인 로그인 연장이 끝난 뒤 새로 고친다(Codex 재검토 v1.4 r4 P2).
  // 연장 중에 새로 고치면 새 열쇠를 못 받아 로그아웃될 수 있다.
  try {
    await supabase.auth.getSession();
  } catch {
    /* 확인에 실패해도 저장된 로그인은 그대로다 */
  }
  if (reloading) return;
  if (!manual && isBusy()) return defer(); // 기다리는 사이 입력을 시작했다
  reloading = true;
  window.location.reload();
  // 새 서비스워커로 넘어가는 순간의 새로고침이 끝나지 않고 걸리는 일이 있다(새 버전 적용 검증에서 재현).
  // 3초 뒤에도 이 화면이 살아 있으면 새로고침이 걸린 것 → 한 번 더 한다(그사이 입력과 무관: 이미 새로 고치기로 한 화면).
  window.setTimeout(() => window.location.reload(), 3000);
}

/**
 * 새 버전 적용. auto=true(앱으로 돌아온 순간의 자동 적용)면 기다리는 사이 입력을 시작했는지 적용 직전에 다시 본다
 * (Codex 재검토 v1.4 P2: 로그인 연장을 기다리는 동안 쓰기 시작한 글이 사라졌다). 입력 중이면 멈추고 띠만 남긴다.
 * '지금 적용'을 직접 누른 경우(auto=false)는 그대로 적용한다.
 */
export async function applyUpdate(auto = false) {
  if (!auto) manual = true;
  if ((!update && !reloadPending) || applying) return;
  applying = true;
  try {
    await supabase.auth.getSession(); // 진행 중인 로그인 연장이 있으면 끝날 때까지 기다린다
  } catch {
    /* 확인에 실패해도 저장된 로그인은 그대로다 */
  }
  if (auto && (isBusy() || document.visibilityState !== 'visible')) {
    applying = false;
    return;
  }
  if (reloadPending) return reloadIfSafe(); // 새 버전이 이미 화면을 맡았다 → 새로고침만 남았다
  await update!(true);
  // 처음 연 화면처럼 서비스워커가 맡지 않은 화면은 '맡기 시작' 신호가 안 와서 새로고침이 안 될 수 있다 → 직접 새로고침
  // (vite.config.ts에서 clientsClaim을 끈 이유와 같이 본다)
  window.setTimeout(() => void reloadIfSafe(), 3000);
}

function maybeApplyNow() {
  if (!ready && !reloadPending) return;
  const justResumed = Date.now() - resumedAt < RESUME_WINDOW_MS;
  if (document.visibilityState === 'visible' && justResumed && !isBusy()) void applyUpdate(true);
}

const check = () => {
  if (registration && navigator.onLine !== false) void registration.update().catch(() => {});
};

export function startUpdateChecks() {
  if (!('serviceWorker' in navigator)) return;
  update = registerSW({
    immediate: true,
    onNeedRefresh() {
      setReady(true);
      maybeApplyNow();
    },
    // 새 버전이 이 화면을 맡았다(이 탭이 적용했거나 다른 탭이 적용함). 이 콜백이 없으면 라이브러리가 입력 검사 없이 바로 새로 고친다.
    onNeedReload() {
      void reloadIfSafe();
    },
    onRegisteredSW(_url, reg) {
      registration = reg;
      window.setInterval(() => document.visibilityState === 'visible' && check(), CHECK_EVERY_MS);
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    resumedAt = Date.now();
    if (ready) maybeApplyNow();
    else check();
  });
}

// 검증용: 지금 빌드 식별값(화면에는 안 보인다)
export const BUILD_ID = __BUILD_ID__;
