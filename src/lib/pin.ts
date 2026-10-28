// PIN 되찾기·바꾸기와 계정 보안 상태(v1.3 복구 질문 방식)
import { supabase } from './supabase';

type Result = { status: string; remaining?: number; locked_until?: string | null; pin_changed_at?: string };

async function call(fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as Result;
}

export async function getRecoveryQuestion(nickname: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('get_recovery_question', { p_nickname: nickname.normalize('NFC').trim() });
  if (error) throw error;
  return (data as number | null) ?? null;
}

export const resetPinWithAnswer = (nickname: string, answer: string, newPin: string) =>
  call('reset_pin_with_answer', { p_nickname: nickname.normalize('NFC').trim(), p_answer: answer.normalize('NFC'), p_new_pin: newPin });

export const changeMyPin = (newPin: string, proof: { currentPin: string } | { answer: string }) =>
  call('change_my_pin', 'currentPin' in proof ? { p_new_pin: newPin, p_current_pin: proof.currentPin } : { p_new_pin: newPin, p_answer: proof.answer.normalize('NFC') });

/** 닉네임 바꾸기(로그인 아이디도 함께 바뀐다). 지금 PIN 확인. 결과: ok · wrong · taken · invalid · same */
export const changeMyNickname = (nickname: string, currentPin: string) =>
  call('change_my_nickname', { p_new_nickname: nickname.normalize('NFC').trim(), p_current_pin: currentPin });

/** 이 이름이 로그인한 본인의 예전 닉네임인지(다른 기기에 남은 기억값을 새 이름으로 맞출 때만 쓴다) */
export async function wasMyNickname(nickname: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_my_former_nickname', { p_nickname: nickname });
  if (error) throw error;
  return data === true;
}

export const setRecovery = (question: number, answer: string, currentPin: string) =>
  call('set_recovery', { p_question: question, p_answer: answer.normalize('NFC'), p_current_pin: currentPin });

export const reclaimAccount = (newPin: string, question: number, answer: string) =>
  call('reclaim_account', { p_new_pin: newPin, p_question: question, p_answer: answer.normalize('NFC') });

/** '네, 제가 바꿨어요': 바뀌기 전부터 로그인돼 있던 기기가 확인하면 서버의 되찾기 창을 닫는다 */
export async function ackPinChange() {
  const { error } = await supabase.rpc('ack_pin_change');
  if (error) throw error;
}

export async function reportNotMe() {
  const { error } = await supabase.rpc('report_pin_not_me');
  if (error) throw error;
}

export interface SecurityStatus {
  has_recovery: boolean;
  question: number | null;
  pin_changed_at: string | null;
  failed_count: number;
  last_failed_at: string | null;
  locked_until: string | null;
  /** 이 기기가 되찾기를 할 수 있는가(PIN이 바뀌기 전부터 로그인돼 있던 기기) */
  can_reclaim: boolean;
}

export async function mySecurityStatus(): Promise<SecurityStatus> {
  const { data, error } = await supabase.rpc('my_security_status');
  if (error) throw error;
  return data as SecurityStatus;
}

/** 실패 결과를 화면 문장으로 */
export function resultText(r: Result): string {
  switch (r.status) {
    case 'wrong':
      return r.remaining !== undefined ? `답이 맞지 않아요. ${r.remaining}번 더 틀리면 하루 동안 막혀요.` : '맞지 않아요.';
    case 'locked':
      return '답을 여러 번 틀려서 하루 동안 막혔어요. 내일 다시 시도해 주세요.';
    case 'no_recovery':
      return '이 닉네임은 PIN을 되찾을 수 있는 질문이 없어요.';
    case 'same':
      return '지금 PIN과 다른 숫자로 정해 주세요.';
    case 'bad_pin':
      return 'PIN은 숫자 6자리로 입력해 주세요.';
    case 'bad_answer':
      return '답을 두 글자 이상 적어 주세요.';
    default:
      return '처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

// ─── 이 기기에서 이미 확인한 알림 ───
// 서버 시각만 비교한다(기기 시계와 섞지 않는다).
const ackKey = (uid: string) => `mealnote:security-ack:${uid}`;
export interface SecurityAck {
  pin?: string | null;
  fail?: string | null;
}
export function getAck(uid: string): SecurityAck | null {
  try {
    return JSON.parse(localStorage.getItem(ackKey(uid)) ?? 'null');
  } catch {
    return null;
  }
}
export function setAck(uid: string, ack: SecurityAck) {
  try {
    localStorage.setItem(ackKey(uid), JSON.stringify({ ...(getAck(uid) ?? {}), ...ack }));
  } catch {
    /* 저장 못 하면 다음에 알림이 한 번 더 뜰 뿐이다 */
  }
}
/** 방금 이 기기에서 로그인했다는 표시: 첫 상태 조회 때 지금 상태를 '확인함'으로 적는다 */
export const markFreshLogin = () => {
  try {
    sessionStorage.setItem('mealnote:fresh-login', '1');
  } catch {
    /* 무시 */
  }
};
export const takeFreshLogin = () => {
  try {
    const v = sessionStorage.getItem('mealnote:fresh-login') === '1';
    sessionStorage.removeItem('mealnote:fresh-login');
    return v;
  } catch {
    return false;
  }
};
