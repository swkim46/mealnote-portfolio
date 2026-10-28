// 닉네임 + PIN 6자리 로그인.
// Supabase의 이메일/비밀번호 로그인을 그대로 쓰되, 이메일 자리에 닉네임에서 만든 가짜 주소를 넣는다.
// (한글 닉네임은 이메일 앞부분에 쓸 수 없어서 해시로 바꾼다. 실제 메일은 보내지 않는다.)
import { supabase } from './supabase';
import { unregisterThisDevice } from './push';
import { sha256Hex } from './sha256';
import type { AccountRole } from './types';

export const normalizeNickname = (nickname: string) => nickname.normalize('NFC').trim();

export const nicknameEmail = (nickname: string) =>
  `${sha256Hex(normalizeNickname(nickname).toLowerCase()).slice(0, 32)}@users.mealnote.local`;

export const isValidPin = (pin: string) => /^\d{6}$/.test(pin);

export function nicknameProblem(nickname: string): string | null {
  const n = normalizeNickname(nickname);
  if (n.length < 2 || n.length > 20) return '닉네임은 2~20자로 입력해 주세요.';
  return null;
}

export interface Trainer {
  id: string;
  nickname: string;
}

export async function listTrainers(): Promise<Trainer[]> {
  const { data, error } = await supabase.rpc('list_trainers');
  if (error) throw error;
  return (data ?? []) as Trainer[];
}

type SignUpInput = (
  | { role: 'trainer'; nickname: string; pin: string; trainerCode: string }
  | { role: 'member'; nickname: string; pin: string; trainerId: string }
) & { recoveryQuestion: number; recoveryAnswer: string };

/**
 * 가입. 성공하면 null, 실패하면 화면에 보일 문장.
 * 등록 코드·복구 답은 인증 서버에 보내지 않는다(가입 응답·로그인 토큰에 원문이 남기 때문, Codex 재검토 P1).
 * 1) begin_signup이 DB에서 코드·트레이너·답을 확인하고 한 번만 쓰는 가입권을 준다
 * 2) 인증 서버에는 닉네임과 가입권만 보낸다
 */
export async function signUp(input: SignUpInput): Promise<string | null> {
  const nickname = normalizeNickname(input.nickname);
  const begin = await supabase.rpc('begin_signup', {
    p_nickname: nickname,
    p_role: input.role,
    p_question: input.recoveryQuestion,
    p_answer: input.recoveryAnswer.normalize('NFC'),
    p_trainer_code: input.role === 'trainer' ? input.trainerCode.trim() : null,
    p_trainer_id: input.role === 'member' ? input.trainerId : null,
  });
  if (begin.error) {
    const m = begin.error.message;
    if (/nickname_taken/.test(m)) return '이미 쓰고 있는 닉네임이에요. 다른 닉네임을 입력해 주세요.';
    if (/invalid_trainer_code/.test(m)) return '트레이너 등록 코드가 맞지 않아요. 운영자에게 받은 코드를 확인해 주세요.';
    if (/invalid_trainer/.test(m)) return '선택한 트레이너를 찾을 수 없어요. 목록을 새로 불러와 다시 골라 주세요.';
    if (/invalid_recovery/.test(m)) return '복구 질문의 답을 두 글자 이상 적어 주세요.';
    if (/invalid_nickname/.test(m)) return '닉네임은 2~20자로 입력해 주세요.';
    return '연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.';
  }
  const { error } = await supabase.auth.signUp({
    email: nicknameEmail(nickname),
    password: input.pin,
    options: { data: { nickname, signup_ticket: begin.data as string } },
  });
  if (!error) return null;
  if (error.status === 429) return '시도가 많아 잠시 막혔어요. 몇 분 뒤 다시 시도해 주세요.';
  if (/already registered/i.test(error.message)) return '이미 쓰고 있는 닉네임이에요. 다른 닉네임을 입력해 주세요.';
  return '가입하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

export async function signIn(nickname: string, pin: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email: nicknameEmail(nickname), password: pin });
  if (!error) return null;
  if (error.status === 429) return '시도가 많아 잠시 막혔어요. 몇 분 뒤 다시 시도해 주세요.';
  if (/invalid login credentials/i.test(error.message)) return '닉네임 또는 PIN이 맞지 않아요.';
  return '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/** 로그아웃: 이 기기의 알림 등록을 먼저 지운다(최대 2초, 실패해도 로그아웃은 진행) */
export async function signOut() {
  await unregisterThisDevice();
  return supabase.auth.signOut();
}

export const roleLabel = (role: AccountRole) => (role === 'admin' ? '운영자' : role === 'trainer' ? '트레이너' : '회원');
