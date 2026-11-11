// 트레이너 화면의 회원 운동(2.3): 담당 회원의 최근 2주 기록을 한 번에 받아 회원 카드의 운동 줄과 확인 탭의 새 운동 기록을 만든다.
// '모두 봤어요'는 이 기기에, 화면에 보인 기록마다 적는다. 처음에는 사흘 전부터를 새 기록으로 본다 — 업데이트 뒤 2주치가 한꺼번에 뜨지 않게.
import { useMemo, useRef, useState } from 'react';
import { fetchMembersWorkouts, fetchWorkoutCompare, type WorkoutCompare, type WorkoutSession } from '../lib/api';
import { shiftDay } from '../lib/dates';
import { useLive } from '../lib/useLive';
import { WORKOUT_WINDOW_DAYS, isUnseen, markWorkouts, memberWorkoutLine, parseSeen, type SeenWorkouts } from '../lib/workoutBrief';
import { bestRows, isWorkout } from '../lib/workoutStats';

const seenKey = (trainerId: string) => `mealnote:workouts-seen:${trainerId}`;
const readSeen = (trainerId: string): SeenWorkouts => {
  const first = { base: new Date(Date.now() - 3 * 86_400_000).toISOString(), marks: {} };
  try {
    const v = localStorage.getItem(seenKey(trainerId));
    const seen = v && parseSeen(v);
    if (seen) return seen;
    // 처음 정한 기준을 바로 적는다: 기준이 밀리면 뜨던 기록이 누르지 않았는데 사라진다
    localStorage.setItem(seenKey(trainerId), JSON.stringify(first));
  } catch {
    /* 저장소를 못 쓰거나 적힌 값이 망가진 환경 */
  }
  return first;
};

export function useTrainerWorkouts(trainerId: string, memberIds: string[], today: string, active: boolean) {
  const ids = memberIds.join(',');
  // 회원 화면을 보는 동안은 받지 않고 마지막 값을 둔다. 값에 회원 명단을 함께 적어, 새 명단의 기록이 오기 전에 '기록 없음'이 뜨지 않게 한다
  const kept = useRef<{ ids: string; list: WorkoutSession[] } | undefined>(undefined);
  const live = useLive(`trainer-workouts-${trainerId}`, `${ids}|${today}|${active}`, async () => {
    if (!active) return kept.current;
    const list = memberIds.length ? await fetchMembersWorkouts(memberIds, shiftDay(today, -WORKOUT_WINDOW_DAYS)) : [];
    kept.current = { ids, list };
    return kept.current;
  });
  const [seen, setSeen] = useState(() => readSeen(trainerId));
  const loaded = live.value?.ids === ids ? live.value.list : null;
  const sessions = useMemo(() => (loaded ?? []).filter(isWorkout), [loaded]);
  const fresh = useMemo(() => sessions.filter((s) => isUnseen(s, seen)), [sessions, seen]);
  // 최고 표시: 오늘 기록과 새 기록만 비교를 받는다. 회원마다 따로 부른다(서버 workout_compare)
  const wanted = useMemo(() => {
    const byId = new Map<string, WorkoutSession>();
    for (const s of sessions) if (s.day === today || isUnseen(s, seen)) byId.set(s.id, s);
    return [...byId.values()];
  }, [sessions, seen, today]);
  const compareKey = wanted.map((s) => s.id).join(',');
  // 회원 하나의 비교를 못 받아도 나머지는 쓴다. 못 받은 사실은 missed로 알린다 — 최고 표시가 없는 것과 구분
  const compare = useLive<{ map: WorkoutCompare; missed: boolean }>(`trainer-compare-${trainerId}`, compareKey, async () => {
    const byMember = new Map<string, string[]>();
    for (const s of wanted) byMember.set(s.member_id, [...(byMember.get(s.member_id) ?? []), s.id]);
    const results = await Promise.allSettled([...byMember].map(([member, list]) => fetchWorkoutCompare(member, list)));
    return { map: Object.assign({}, ...results.map((r) => (r.status === 'fulfilled' ? r.value : {}))) as WorkoutCompare, missed: results.some((r) => r.status === 'rejected') };
  });
  const records = (s: WorkoutSession) => {
    const c = compare.value?.map[s.id];
    return c ? bestRows(s, c).filter((r) => r.record).length : 0;
  };
  const lineFor = (memberId: string) => (loaded ? memberWorkoutLine(sessions.filter((s) => s.member_id === memberId), today) : null);
  // 화면에 보인 기록만: 아직 받지 못한 기록은 시각이 더 일러도 새 기록으로 남는다
  const markSeen = () => {
    if (!fresh.length) return;
    const next = markWorkouts(seen, fresh);
    setSeen(next);
    try {
      localStorage.setItem(seenKey(trainerId), JSON.stringify(next));
    } catch {
      /* 저장소를 못 쓰는 환경 — 이 화면에서만 비운다 */
    }
  };
  return { fresh, lineFor, records, markSeen, failed: live.failed, reload: live.reload, recordsMissed: !!compare.value?.missed || compare.failed };
}
