import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMeal, fetchMeals, mergeMeals, signPhotos, TRAINER_RECENT_DAYS, WINDOW_DAYS } from '../lib/api';
import { shiftDay, todayKey } from '../lib/dates';
import type { Meal, Role } from '../lib/types';

const SIGN_TTL_MS = 50 * 60 * 1000; // 서명 주소는 1시간 유효, 50분 뒤 새로 받는다
const POLL_MS = 60 * 1000;

/** 식사 목록 + 사진 주소. 화면이 보일 때 1분마다, 앱으로 돌아올 때마다 새로 불러온다. */
export function useMealStore(role: Role) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const signedAt = useRef<Record<string, number>>({});
  const extraDays = useRef(new Set<string>());
  const extraMembers = useRef(new Set<string>()); // 트레이너가 열어 본 회원: 그 회원의 60일 기록을 함께 유지
  // 전체 다시 받기(1분마다·앱 복귀)와 식사 하나 다시 받기(확인·평가·댓글 뒤)가 겹칠 때 늦게 끝난 전체 조회가
  // 방금 바꾼 식사를 옛 값으로 되돌리지 않게 한다(2026-10-27 화면 흐름 검증에서 '답변 없이 확인' 뒤 질문 표시가 남은 일).
  // 식사를 따로 바꿀 때마다 번호를 매겨 두고, 전체 조회는 시작 뒤에 바뀐 식사를 지금 값으로 둔다. 더 나중에 시작한 전체 조회가 있으면 옛 것은 버린다.
  const stamp = useRef(0);
  const touched = useRef(new Map<string, number>());
  const reloadSeq = useRef(0);
  const touch = (ids: string[]) => {
    stamp.current++;
    for (const id of ids) touched.current.set(id, stamp.current);
  };

  const sign = useCallback(async (list: Meal[]) => {
    const now = Date.now();
    const paths = [...new Set(list.map((m) => m.photo_path).filter((p): p is string => !!p))].filter(
      (p) => !signedAt.current[p] || now - signedAt.current[p] > SIGN_TTL_MS,
    );
    if (!paths.length) return;
    try {
      const map = await signPhotos(paths);
      for (const p of Object.keys(map)) signedAt.current[p] = now;
      setPhotoUrls((prev) => ({ ...prev, ...map }));
    } catch {
      /* 사진 주소를 못 받아도 목록은 보여 준다 */
    }
  }, []);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const startedAt = stamp.current;
    try {
      const since = shiftDay(todayKey(), -WINDOW_DAYS);
      let list =
        role === 'trainer'
          ? await fetchMeals({
              trainer: {
                recentSince: shiftDay(todayKey(), -TRAINER_RECENT_DAYS),
                messageSince: new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString(),
              },
            })
          : await fetchMeals({ member: { since, feedbackSince: new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString() } });
      for (const memberId of extraMembers.current) list = mergeMeals(list, await fetchMeals({ memberId, since }));
      for (const day of extraDays.current) list = mergeMeals(list, await fetchMeals({ day }));
      if (seq !== reloadSeq.current) return;
      const changedSince = (id: string) => (touched.current.get(id) ?? 0) > startedAt;
      setMeals((prev) => mergeMeals(list.filter((m) => !changedSince(m.id)), prev.filter((m) => changedSince(m.id))));
      setFailed(false);
      void sign(list);
    } catch {
      setFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [role, sign]);

  /** 기간 밖의 날짜를 기록 화면에서 골랐을 때 */
  const loadDay = useCallback(
    async (day: string) => {
      if (day >= shiftDay(todayKey(), -WINDOW_DAYS) || extraDays.current.has(day)) return;
      extraDays.current.add(day);
      try {
        const list = await fetchMeals({ day });
        touch(list.map((m) => m.id));
        setMeals((prev) => mergeMeals(prev, list));
        void sign(list);
      } catch {
        extraDays.current.delete(day);
      }
    },
    [sign],
  );

  /** 트레이너: 회원별 기록을 열 때 그 회원의 최근 60일을 불러온다 */
  const loadMember = useCallback(
    async (memberId: string) => {
      extraMembers.current.add(memberId);
      try {
        const list = await fetchMeals({ memberId, since: shiftDay(todayKey(), -WINDOW_DAYS) });
        touch(list.map((m) => m.id));
        setMeals((prev) => mergeMeals(prev, list));
        void sign(list);
      } catch {
        /* 다음 새로 고침에 다시 시도된다 */
      }
    },
    [sign],
  );

  const refreshMeal = useCallback(
    async (id: string) => {
      const m = await fetchMeal(id);
      touch([id]);
      setMeals((prev) => (m ? mergeMeals(prev, [m]) : prev.filter((x) => x.id !== id)));
      if (m) {
        if (m.photo_path) delete signedAt.current[m.photo_path];
        void sign([m]);
      }
      return m;
    },
    [sign],
  );

  const removeLocal = useCallback((id: string) => {
    touch([id]);
    setMeals((prev) => prev.filter((m) => m.id !== id));
  }, []);

  useEffect(() => {
    void reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [reload]);

  return { meals, photoUrls, loaded, failed, reload, loadDay, loadMember, refreshMeal, removeLocal };
}
