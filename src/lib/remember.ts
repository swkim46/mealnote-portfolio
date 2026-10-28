// 이 기기에 마지막으로 로그인한 닉네임·역할을 기억한다(PIN은 저장하지 않는다).
// v1.6부터 사용자 ID도 함께 둔다: 다른 기기에서 닉네임을 바꿨을 때 이 기기의 기억값이 그 사람 것인지 알아보려고.
// 사생활 보호 모드 등에서 저장소가 막혀도 앱이 멈추지 않도록 모두 try로 감싼다.
import type { Role } from './types';

const KEY = 'mealnote:remember';

export interface Remembered {
  nickname: string;
  role: Role;
  userId?: string; // v1.5 이전에 기억한 값에는 없다
}

export function getRemembered(): Remembered | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v.nickname === 'string' && (v.role === 'member' || v.role === 'trainer') && (v.userId === undefined || typeof v.userId === 'string') ? v : null;
  } catch {
    return null;
  }
}

const CHANGED = 'mealnote:remembered-changed';

export function setRemembered(v: Remembered | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* 저장 못 해도 로그인에는 지장 없다 */
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** 기억값이 바뀌면 알려 준다(늦게 끝난 syncRemembered가 이미 열린 로그인 화면에도 닿게) */
export function onRememberedChange(fn: () => void) {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}

const sameName = (a: string, b: string) => a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();

/** 기억값이 이 사용자 것인지: 사용자 ID가 있으면 ID로, 없으면(옛 값) 이름으로 본다 */
export const rememberedIsMine = (r: Remembered, p: { id: string; nickname: string }) => (r.userId ? r.userId === p.id : sameName(r.nickname, p.nickname));

/**
 * 로그인한 사람의 프로필을 받을 때마다 이 기기의 기억값을 맞춘다(가입 때 정한 표기·바뀐 닉네임·사용자 ID).
 * 사용자 ID가 없는 옛 값이 지금 이름과 다르면 '이 사람의 예전 닉네임'인지 서버에 물어본다(wasMine).
 * 다른 사람의 기억값이거나 기억하기를 끈 기기(값 없음)는 건드리지 않는다.
 */
export async function syncRemembered(p: { id: string; nickname: string; role: Role }, wasMine: (nickname: string) => Promise<boolean>) {
  const r = getRemembered();
  if (!r) return;
  let mine = rememberedIsMine(r, p);
  if (!mine && !r.userId) mine = await wasMine(r.nickname).catch(() => false);
  if (!mine) return;
  const now = getRemembered(); // 묻는 사이 다른 로그인이 기억값을 바꿨으면 손대지 않는다
  if (!now || now.nickname !== r.nickname || now.userId !== r.userId) return;
  if (now.nickname !== p.nickname || now.role !== p.role || now.userId !== p.id) setRemembered({ nickname: p.nickname, role: p.role, userId: p.id });
}
