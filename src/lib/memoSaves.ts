// 동작별 메모 저장의 진행·실패를 화면 밖에서 맡는다(Codex v2.4.0 2차 리뷰 P2-1·P3-1, 사용자 결정 11-09 '저장 중에도 이동').
// 메모 칸은 저장을 시작만 하고, 결과는 이 모듈이 받는다 — 칸이 닫힌 뒤(창 ✕·층 이동·운동 기록 저장) 실패해도 글을 잃지 않는다.
//  - 실패한 글은 보낼 때의 저장 기준(수정 시각)과 함께 둔다. 다시 쓸 때 그 기준으로 보내야 그사이 다른 기기가 고친 글을 몰래 덮지 않는다
//  - 한 메모 칸(회원·운동·쓴 사람)에서 더 나중에 시작한 저장이 있으면 앞선 저장의 실패는 버린다(사용자가 이미 새 글을 썼다).
//    더 나중의 저장이 성공하면 그 앞의 실패도 지운다
//  - 저장을 시작한 칸이 아직 열려 있으면 실패는 그 칸이 맡는다(글이 칸에 그대로 있다). 닫히거나 가려졌을 때만 여기에 남긴다.
//    남은 실패는 그 운동의 메모 칸이 보일 때 다른 글을 쓰고 있지 않으면 편집 칸으로 바로 되돌린다(카드·버튼 없음 — 3차 리뷰 사용자 의견)
//  - 보관은 같은 로그인 동안만: 로그인한 사용자가 바뀌거나 로그아웃하면 비우고, 그 전에 시작한 저장의 결과는 받지 않는다.
//    새로고침·앱 다시 열기는 메모리가 비므로 함께 사라진다
import { exerciseKey } from './exercise';
import { loginGeneration, onLoginChange } from './sharedRequest';

export type MemoSlot = { memberId: string; name: string; viewer: 'member' | 'trainer' };
/** 저장하지 못한 메모: 보낸 글과 그때의 저장 기준, 실패한 때의 목록 번호(stamp — 이보다 큰 번호의 목록만 실패 뒤에 받은 것) */
export type MemoFailure = { seq: number; body: string; base: string | null; stamp: number };
export type MemoSaveResult = { ok: true; at: string | null } | { ok: false; code: string };
/** 저장을 시작한 칸. 칸이 닫히면 alive를 끈다 */
export type MemoOwner = { alive: boolean };

type Slot = { last: number; inflight: Set<number>; failure: MemoFailure | null; saving: boolean };
let slots = new Map<string, Slot>();
let seq = 0;
// 메모 목록을 받기 시작할 때마다 하나씩 는다. '서버에 이미 그 글이 있다'는 실패 뒤에 받기 시작한 목록으로만 판단한다
// (실패 전에 받은 낡은 목록이 우연히 같은 글이면 진짜 실패를 지웠다 — 넘기기 전 적대 검토 P3-B)
let listSeq = 0;
/** 메모 목록을 받기 시작할 때 부른다 — 그 목록의 번호 */
export const nextListStamp = () => ++listSeq;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const slotKey = (s: MemoSlot) => `${s.memberId}|${exerciseKey(s.name)}|${s.viewer}`;
const slotOf = (k: string) => {
  let s = slots.get(k);
  if (!s) slots.set(k, (s = { last: 0, inflight: new Set(), failure: null, saving: false }));
  return s;
};
// 바뀐 칸은 새 객체로 — 화면이 바뀐 것을 알아본다(useSyncExternalStore는 같은 값이면 다시 그리지 않는다)
const update = (k: string, patch: Partial<Slot>) => {
  slots.set(k, { ...slotOf(k), ...patch });
  emit();
};

onLoginChange(() => {
  slots = new Map();
  emit();
});

export const subscribeMemoSaves = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
/** 이 칸에 남은 저장하지 못한 메모(없으면 null) */
export const memoFailure = (s: MemoSlot) => slots.get(slotKey(s))?.failure ?? null;
/** 이 칸의 저장이 진행 중인가 */
export const memoSaving = (s: MemoSlot) => slots.get(slotKey(s))?.saving ?? false;
/** 사용자가 버린 실패, 또는 서버에 이미 같은 글이 있는 실패를 지운다(그사이 더 새 실패가 왔으면 그대로 둔다).
 * 불러가 쓰는 동안은 지우지 않는다 — 그 글의 저장이 성공하면 번호 규칙으로 지워진다 */
export function dropMemoFailure(s: MemoSlot, failureSeq: number) {
  const k = slotKey(s);
  if (slots.get(k)?.failure?.seq === failureSeq) update(k, { failure: null });
}

/**
 * 메모 저장을 시작한다. done은 늘 이루어지고(거절하지 않음) 결과에 덧붙여 알린다.
 *  - current: 같은 로그인에서 끝났는가(최신 저장이라는 뜻은 아니다)
 *  - newest: 끝난 때 이 칸에서 더 나중에 시작한 저장이 없었는가 — 아니면 성공해도 그 글을 화면 값으로 쓰지 않는다
 *    (늦게 온 옛 성공이 더 새 메모를 가렸다 — Codex v2.4.0 3차 리뷰 P3-1)
 *  - kept: 닫힌 칸의 실패를 여기에 남겼는가
 */
export function beginMemoSave(s: MemoSlot, body: string, base: string | null, send: () => Promise<string | null>) {
  const k = slotKey(s);
  const gen = loginGeneration();
  const n = ++seq;
  const owner: MemoOwner = { alive: true };
  const start = slotOf(k);
  const inflight = new Set(start.inflight).add(n);
  update(k, { last: n, inflight, saving: true });
  const finish = (r: MemoSaveResult) => {
    if (gen !== loginGeneration()) return { ...r, current: false, newest: false, kept: false };
    const cur = slotOf(k);
    const newest = n === cur.last;
    const left = new Set(cur.inflight);
    left.delete(n);
    let failure = cur.failure;
    let kept = false;
    if (r.ok) {
      // 더 나중의 저장이 성공했다 — 그 앞의 실패는 되살리지 않는다
      if (failure && failure.seq < n) failure = null;
    } else if (!owner.alive && newest) {
      failure = { seq: n, body, base, stamp: listSeq };
      kept = true;
    }
    update(k, { inflight: left, saving: left.size > 0, failure });
    return { ...r, current: true, newest, kept };
  };
  const done = send().then(
    (at) => finish({ ok: true, at }),
    (e: unknown) => finish({ ok: false, code: e instanceof Error ? e.message : '' }),
  );
  return { seq: n, owner, done };
}
