// v2.4 동작별 메모·지난번 조회. 메모는 운동 기록 창·루틴 카드·운동별 기록 세 곳이 함께 보므로,
// 한 곳에서 저장하면 같은 회원의 메모를 보는 곳이 모두 다시 받는다(회원마다 세대 번호).
import { useSyncExternalStore } from 'react';
import { fetchExerciseMemos, fetchLastSets, saveExerciseMemo, type LastSets } from '../lib/api';
import { useLive } from '../lib/useLive';
import { beginMemoSave, dropMemoFailure, memoFailure, memoSaving, nextListStamp, subscribeMemoSaves, type MemoSlot } from '../lib/memoSaves';
import { loginGeneration } from '../lib/sharedRequest';
import { exerciseKey } from '../lib/exercise';

const gens = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
/** 이 회원의 메모가 바뀌었다 — 보는 곳마다 다시 받는다 */
export function memosChanged(memberId: string) {
  gens.set(memberId, (gens.get(memberId) ?? 0) + 1);
  listeners.forEach((f) => f());
}

/** 회원의 동작별 메모. 받지 못하면 memos는 마지막 정상 값(처음이면 undefined)이고 failed가 참 */
export function useExerciseMemos(memberId: string | null) {
  const gen = useSyncExternalStore(subscribe, () => (memberId ? (gens.get(memberId) ?? 0) : 0));
  // 받기 시작한 때의 번호(stamp)를 목록과 함께 둔다 — 저장하지 못한 메모가 서버에 이미 있는지는 실패 뒤에 받은 목록으로만 본다
  const live = useLive(`memos:${memberId ?? ''}`, String(gen), () => {
    const stamp = nextListStamp();
    return (memberId ? fetchExerciseMemos(memberId) : Promise.resolve([])).then((list) => ({ list, stamp }));
  });
  return { memos: live.value?.list, stamp: live.value?.stamp ?? 0, failed: live.failedNow, reload: live.reload };
}

/** 이전 기록 줄: 받지 못하면 빈 값(줄을 숨기고 입력은 막지 않는다). ready = 지금 이름들의 기록을 받았다(최신 무게 채우기는 받은 뒤에만) */
export function useLastSets(memberId: string | null, names: string[], day: string, sessionId: string | null) {
  const scope = [memberId ?? '', day, sessionId ?? '', ...names].join('\n');
  const live = useLive(`last:${scope}`, '0', () => (memberId ? fetchLastSets(memberId, names, day, sessionId) : Promise.resolve({} as LastSets)));
  return { sets: live.value ?? ({} as LastSets), ready: live.value !== undefined };
}

/** 닫힌 칸의 저장이 실패했을 때 알리는 글(지우기·권한 없음은 따로) */
const lostMessage = (slot: MemoSlot, body: string, code: string) =>
  code === 'not_allowed'
    ? slot.viewer === 'trainer'
      ? '메모를 쓸 수 없어요. 담당이 바뀌었는지 확인해 주세요.'
      : '메모를 저장하지 못했어요. 다시 로그인한 뒤 시도해 주세요.'
    : `${slot.name} 메모를 ${body ? '저장하지' : '지우지'} 못했어요. 메모 칸에서 다시 확인해 주세요.`;

/**
 * 메모 저장(결과는 lib/memoSaves가 받는다 — 칸이 닫혀도 이어진다). 끝나면 같은 회원의 메모를 보는 곳이 모두 다시 받는다.
 * 닫힌 칸의 저장이 실패하면 서버의 메모를 한 번 새로 받아 본다 — 응답만 끊기고 저장은 됐으면(같은 글) 실패로 남기지 않고 알리지도 않는다.
 * 새로 받지 못하거나 다른 글이면 알린다(넘기기 전 적대 검토 P3-C)
 */
export function saveMemo(slot: MemoSlot, body: string, base: string | null, onError: (msg: string) => void) {
  const gen = loginGeneration();
  const run = beginMemoSave(slot, body, base, () => saveExerciseMemo(slot.memberId, slot.name, body, base));
  void run.done.then((r) => {
    if (!r.current) return;
    memosChanged(slot.memberId);
    if (r.ok || !r.kept) return;
    const say = () => gen === loginGeneration() && onError(lostMessage(slot, body, r.code));
    const key = exerciseKey(slot.name);
    fetchExerciseMemos(slot.memberId).then((list) => {
      if (gen !== loginGeneration()) return;
      const now = list.find((m) => m.key === key && m.author === slot.viewer);
      if ((now?.body ?? '') === body) dropMemoFailure(slot, run.seq);
      else say();
    }, say);
  });
  return run;
}

/** 이 칸에 남은 저장하지 못한 메모와 진행 중인 저장 */
export function useMemoSaves(slot: MemoSlot, enabled: boolean) {
  const failure = useSyncExternalStore(subscribeMemoSaves, () => (enabled ? memoFailure(slot) : null));
  const saving = useSyncExternalStore(subscribeMemoSaves, () => enabled && memoSaving(slot));
  return { failure, saving };
}
