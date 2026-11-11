import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMeal, fetchMeals, mergeMeals, signPhotos, TRAINER_RECENT_DAYS, WINDOW_DAYS } from '../lib/api';
import { shiftDay, todayKey } from '../lib/dates';
import type { Meal, Role } from '../lib/types';
import { retryFailedMealPhotos } from '../lib/mealPhoto';

const SIGN_TTL_MS = 50 * 60 * 1000; // 서명 주소는 1시간 유효, 50분 뒤 새로 받는다
const POLL_MS = 60 * 1000;

export type MemberLoad = 'loading' | 'ok' | 'failed';

/**
 * 식사 목록 + 사진 주소. 화면이 보일 때 1분마다, 앱으로 돌아올 때마다 새로 불러온다.
 * 상태는 값의 범위가 다르다. 같은 자료를 받는 경로는 값과 함께 그 상태도 맞춘다.
 *  - loaded: 가장 최근 전체 조회가 끝났다(성공·실패 모두)
 *  - fullLoaded: 전체 조회가 한 번이라도 성공했다. 기본 범위에서 '기록 없음'을 말할 수 있다
 *  - failed: 가장 최근 전체 조회가 실패했다. 받아 둔 값은 남는다
 *  - memberLoads[회원]: 그 회원의 60일을 어떻게 받았나. loadMember와, 열어 본 회원을 함께 받는 reload가 바꾼다
 */
export function useMealStore(role: Role) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  // 전체 조회가 한 번이라도 끝났는가. 회원 하나·식사 하나를 받아 meals가 차도 전체를 안다는 뜻은 아니다(v2.3.0 2차 리뷰 뒤 적대 검토)
  const [fullLoaded, setFullLoaded] = useState(false);
  const [memberLoads, setMemberLoads] = useState<Record<string, MemberLoad>>({});
  // 회원 상태도 값처럼 나중에 시작한 조회가 이긴다: 지금 상태를 만든 조회의 번호
  const memberReq = useRef<Record<string, number>>({});
  const [failed, setFailed] = useState(false);
  const signedAt = useRef<Record<string, number>>({});
  const extraDays = useRef(new Set<string>());
  const extraMembers = useRef(new Set<string>()); // 트레이너가 열어 본 회원: 그 회원의 60일 기록을 함께 유지
  // 조회 응답 순서 보호: 모든 조회(전체·식사 하나·날짜·회원)는 시작할 때 번호를 받고, 식사마다 '지금 화면 값을 만든 조회(또는 지움)의 번호'를
  // 기억한다. 응답이 오면 그 식사에 더 나중에 시작한 조회의 값이 이미 있으면 버린다 — 어떤 순서로 끝나도 나중에 시작한 값이 이긴다.
  //  - 2026-10-27: 늦게 끝난 전체 조회가 방금 확인한 식사를 옛 값으로 되돌림
  //  - Codex v1.8.4 1차 리뷰: 저장 뒤 다시 받기 두 번이 역순으로 끝나 새 질문을 지움(식사 하나 조회끼리는 보호가 없었다)
  // 더 나중에 시작한 전체 조회가 있으면 옛 전체 조회는 통째로 버린다(reloadSeq).
  const stamp = useRef(0);
  const touched = useRef(new Map<string, number>());
  const reloadSeq = useRef(0);
  const issue = () => ++stamp.current;
  const newer = (id: string, n: number) => (touched.current.get(id) ?? 0) > n;
  const mark = (ids: string[], n: number) => {
    for (const id of ids) if (!newer(id, n)) touched.current.set(id, n);
  };
  // 마지막으로 끝난 전체 조회(번호와 받은 식사). 아직 목록에 없던 식사를 처음 받는 조회(알림에서 열기)도 지운 식사를 되살리지 않게 쓴다(Codex v1.8.4 3차 리뷰)
  const lastFull = useRef<{ n: number; ids: Set<string> } | null>(null);
  const settleMember = (memberId: string, n: number, state: MemberLoad) => {
    if ((memberReq.current[memberId] ?? 0) > n) return;
    memberReq.current[memberId] = n;
    setMemberLoads((m) => (m[memberId] === state ? m : { ...m, [memberId]: state }));
  };
  // 지금 화면 값(옛 응답을 버릴 때 부른 쪽에 돌려줄 값)
  const shown = useRef<Meal[]>([]);
  useEffect(() => {
    shown.current = meals;
  }, [meals]);

  // 본인 사진만 서명 주소로 받는다. 트레이너는 남의 사진이라 서버 기능으로 그때그때 받는다(MealImage의 photo, Codex v1.8.0 재리뷰 1)
  const sign = useCallback(async (list: Meal[]) => {
    if (role !== 'member') return;
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
  }, [role]);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const n = issue();
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
      const members: string[] = [];
      for (const memberId of extraMembers.current) {
        list = mergeMeals(list, await fetchMeals({ memberId, since }));
        members.push(memberId);
      }
      for (const day of extraDays.current) list = mergeMeals(list, await fetchMeals({ day }));
      if (seq !== reloadSeq.current) return;
      // 이 조회 뒤에 시작한 조회(또는 지움)가 이미 바꾼 식사는 지금 값을 둔다
      const kept = new Set([...touched.current].filter(([, at]) => at > n).map(([id]) => id));
      const fresh = list.filter((m) => !kept.has(m.id));
      const freshIds = new Set(fresh.map((m) => m.id));
      // 받은 식사뿐 아니라 '이번 결과에 없어 화면에서 빠지는 식사'에도 이 조회 번호를 남긴다 — 다른 기기에서 지운 식사를
      // 이 조회 전에 시작한 옛 식사 조회가 늦게 도착해 되살리지 않게(Codex v1.8.4 2차 리뷰). 전체 조회는 저장소가 가진 범위
      // (기본 기간·열어 본 회원·고른 날짜)를 모두 다시 받으므로 여기서 빠진 식사는 이 조회가 '없음'을 확인한 것이다.
      // 날짜·회원별 불러오기는 더하기만 하므로 빠짐을 기록하지 않는다
      mark([...touched.current.keys()].filter((id) => !kept.has(id) && !freshIds.has(id)), n);
      mark([...freshIds], n);
      if (!lastFull.current || lastFull.current.n < n) lastFull.current = { n, ids: new Set(list.map((m) => m.id)) };
      setMeals((prev) => mergeMeals(fresh, prev.filter((m) => kept.has(m.id))));
      setFailed(false);
      setFullLoaded(true);
      // 열어 본 회원의 60일도 다시 받았다: 회원 조회가 실패했던 화면이 다시 불러오기 없이 풀린다(v2.3.0 3차 리뷰)
      for (const memberId of members) settleMember(memberId, n, 'ok');
      void sign(list);
      retryFailedMealPhotos(); // 목록을 새로 받았으니 받지 못했던 남의 사진만 한 번 다시 받는다(3차 리뷰 2)
    } catch {
      if (seq === reloadSeq.current) setFailed(true);
    } finally {
      // 밀려난 조회는 끝났다고 알리지 않는다: 뒤의 조회가 아직 도는데 빈 목록을 '기록 없음'으로 보이게 된다
      if (seq === reloadSeq.current) setLoaded(true);
    }
  }, [role, sign]);

  /** 기간 밖의 날짜를 기록 화면에서 골랐을 때 */
  const loadDay = useCallback(
    async (day: string) => {
      if (day >= shiftDay(todayKey(), -WINDOW_DAYS) || extraDays.current.has(day)) return;
      extraDays.current.add(day);
      const n = issue();
      try {
        const list = (await fetchMeals({ day })).filter((m) => !newer(m.id, n));
        mark(list.map((m) => m.id), n);
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
      const n = issue();
      settleMember(memberId, n, 'loading');
      try {
        const list = (await fetchMeals({ memberId, since: shiftDay(todayKey(), -WINDOW_DAYS) })).filter((m) => !newer(m.id, n));
        mark(list.map((m) => m.id), n);
        setMeals((prev) => mergeMeals(prev, list));
        void sign(list);
        settleMember(memberId, n, 'ok');
      } catch {
        // 다음 새로 고침에 다시 시도되지만, 그때까지 회원 화면이 '기록 없음'으로 보이지 않게 실패를 알린다
        settleMember(memberId, n, 'failed');
      }
    },
    [sign],
  );

  /**
   * 식사 하나를 다시 받아 화면에 맞춘다. 돌려주는 값은 '지금 화면에 맞춘 값'(없으면 null) — 옛 응답을 버렸으면 그 응답이 아니라 지금 값을 돌려준다
   * (알림에서 열기가 이 값으로 상세를 연다, Codex v1.8.4 3차 리뷰).
   *  - 그사이 더 나중에 시작한 조회가 이 식사를 이미 맞췄으면 옛 응답은 쓰지 않는다
   *  - 이 조회 뒤에 시작한 전체 조회가 이 식사 없이 끝났으면, 지워졌는지 전체 조회 범위 밖이라 빠졌는지 알 수 없다 → 한 번 더 받아 확정한다
   *    (범위 밖의 오래된 식사를 지운 것으로 보지 않는다)
   */
  const refreshMeal = useCallback(
    async (id: string, depth = 0): Promise<Meal | null> => {
      const n = issue();
      const m = await fetchMeal(id);
      if (newer(id, n)) return shown.current.find((x) => x.id === id) ?? null;
      const full = lastFull.current;
      // 옛 응답인지 먼저 판정하고, 그다음 다시 받을지 멈출지 고른다. 한도(두 번)는 요청 수를 줄이는 장치일 뿐 옛 응답을 쓰는 조건이 아니다
      // (Codex v1.8.4 4차 리뷰: 한도에 닿으면 확인 못 한 응답을 그대로 썼다). 한도에 닿으면 지금 화면 값을 돌려주고, 없으면 '확인 못 함'으로 끝낸다 —
      // 알림에서 열기는 '볼 수 없어요', 저장 뒤 다시 받기는 잠시 뒤 다시 시도한다
      if (m && full && full.n > n && !full.ids.has(id)) {
        if (depth < 2) return refreshMeal(id, depth + 1);
        const cur = shown.current.find((x) => x.id === id);
        if (cur) return cur;
        throw new Error('meal_unconfirmed');
      }
      mark([id], n);
      setMeals((prev) => (m ? mergeMeals(prev, [m]) : prev.filter((x) => x.id !== id)));
      if (m) {
        if (m.photo_path) delete signedAt.current[m.photo_path];
        void sign([m]);
      }
      return m;
    },
    [sign],
  );

  /**
   * 저장한 뒤 그 식사를 다시 받는다(Codex v1.8.3 3차 리뷰). 저장은 이미 끝났으므로 다시 받기에 실패해도 던지지 않고 false를 돌려준다 —
   * 부른 쪽은 저장 실패로 안내하지 않는다(저장 실패로 보이면 다시 눌러 같은 식사가 두 번 저장될 수 있다). 3초 뒤, 그것도 실패하면 10초 뒤 다시 받아 화면을 맞춘다.
   * 서버 값으로만 맞춘다(기기 시각으로 '확인됨'을 채우면 그사이 온 새 질문을 가릴 수 있다).
   */
  // 다시 받기 재시도는 식사마다 하나만: 앞의 시도가 실패했을 때만 다음 시도를 건다(3초 → 10초). 새로 저장하거나 지우거나 화면이 닫히면 남은 예약을 지운다
  const retries = useRef(new Map<string, { gen: number; timer?: number }>());
  const alive = useRef(true);
  const stopRetry = (id: string) => {
    const r = retries.current.get(id);
    if (r?.timer) window.clearTimeout(r.timer);
    retries.current.set(id, { gen: (r?.gen ?? 0) + 1 });
    return (r?.gen ?? 0) + 1;
  };
  const refreshAfterSave = useCallback(
    async (id: string) => {
      const gen = stopRetry(id);
      try {
        await refreshMeal(id);
        return true;
      } catch {
        const attempt = (delays: number[]) => {
          if (!delays.length || !alive.current || retries.current.get(id)?.gen !== gen) return;
          const timer = window.setTimeout(() => {
            if (!alive.current || retries.current.get(id)?.gen !== gen) return;
            refreshMeal(id).then(
              () => retries.current.get(id)?.gen === gen && retries.current.set(id, { gen }),
              () => attempt(delays.slice(1)),
            );
          }, delays[0]);
          retries.current.set(id, { gen, timer });
        };
        attempt([3000, 10000]);
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshMeal],
  );

  const removeLocal = useCallback((id: string) => {
    stopRetry(id);
    touched.current.set(id, issue());
    setMeals((prev) => prev.filter((m) => m.id !== id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 화면이 닫히면(로그아웃·계정 전환) 남은 다시 받기 예약을 모두 지운다
  useEffect(() => {
    alive.current = true;
    const map = retries.current;
    return () => {
      alive.current = false;
      for (const r of map.values()) if (r.timer) window.clearTimeout(r.timer);
      map.clear();
    };
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

  return { meals, photoUrls, loaded, fullLoaded, memberLoads, failed, reload, loadDay, loadMember, refreshMeal, refreshAfterSave, removeLocal };
}

/** 저장은 됐지만 화면을 다시 받지 못했을 때 안내에 덧붙인다(refreshAfterSave가 잠시 뒤 다시 받는다) */
export const savedNote = (msg: string, fresh: boolean) => (fresh ? msg : `${msg} 화면은 잠시 뒤 새로 받아요.`);
