// 알림 모아보기(v1.7) 데이터: 목록(최근 1주일, 쪽 나누기)·읽음 시각·문구. 화면은 components/Activity.tsx
// 늦게 도착한 옛 응답은 버린다(useInbody와 같은 요청 번호 방식). 조회 실패는 빈 목록·'안 읽음'으로 바꾸지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { prettyDay, todayKey } from './dates';

export interface ActivityItem {
  key: string;
  kind: 'rated' | 'replied' | 'recorded' | 'recorded_note' | 'question' | 'note_edited';
  at: string;
  meal_id: string;
  eaten_on: string;
  meal_type: string;
  actor: string;
}

const KINDS = ['rated', 'replied', 'recorded', 'recorded_note', 'question', 'note_edited'];
const PAGE = 50;

function parseItems(v: unknown): ActivityItem[] {
  if (!Array.isArray(v)) throw new Error('bad_activity');
  return v.map((r) => {
    const a = r as Partial<ActivityItem>;
    if (typeof a.key !== 'string' || !KINDS.includes(a.kind as string) || typeof a.at !== 'string' || typeof a.meal_id !== 'string')
      throw new Error('bad_activity');
    return a as ActivityItem;
  });
}

const dayLabel = (day: string) => (day === todayKey() ? '오늘' : prettyDay(day));

export function activityText(a: ActivityItem) {
  const meal = `${dayLabel(a.eaten_on)} ${a.meal_type}`;
  switch (a.kind) {
    case 'rated':
      return `${a.actor} 트레이너가 ${meal} 기록에 평가를 남겼어요`;
    case 'replied':
      return `${a.actor} 트레이너가 ${meal} 기록에 답글을 남겼어요`;
    case 'recorded':
      return `${a.actor} 회원이 ${meal}을 기록했어요`;
    case 'recorded_note':
      return `${a.actor} 회원이 ${meal}을 기록하고 한마디를 남겼어요`;
    case 'question':
      return `${a.actor} 회원이 ${meal} 기록에 말을 남겼어요`;
    case 'note_edited':
      return `${a.actor} 회원이 ${meal} 기록의 한마디를 고쳤어요`;
  }
}

/** 'unknown'은 읽음 시각을 아직 못 받았거나 조회가 실패한 상태(→ 새 소식 판단을 하지 않는다), null은 한 번도 안 연 계정 */
type Seen = { at: string | null } | 'unknown';

/**
 * 알림 목록과 '마지막으로 연 시각'. 앱이 앞으로 올 때와 1분마다 다시 받아 종 버튼의 점을 맞춘다.
 * 목록은 늘 서버 정렬상 맨 앞부터 이어진 한 구간이다(Codex v1.7 재리뷰).
 *  - 다시 받을 때는 첫 쪽부터 지금 펼친 만큼(쪽 수)을 이어서 새로 받아 목록을 통째로 바꾼다:
 *    같은 소식의 바뀐 값(재평가 시각 등)이 반영되고, 서버에서 사라진 소식은 빠지며, 펼친 범위는 유지된다.
 *  - 더 받기는 그 구간의 마지막 항목 다음부터. 다시 받는 중에는 하지 않는다(화면의 목록이 곧 바뀔 옛 목록이라서).
 *    더 받기가 참조한 목록 판(version)이 결과를 붙일 때도 그대로일 때만 붙인다 — 그 사이 다시 받기가 시작·완료됐으면 버린다.
 */
export function useActivity(userId: string) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [seen, setSeen] = useState<Seen>('unknown');
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const req = useRef(0);
  const shown = useRef(0); // 지금 펼친 항목 수(다시 받을 범위)
  const version = useRef(0); // 목록을 바꿀 때마다 올린다(더 받기가 참조한 목록이 아직 그대로인지)
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(0); // 진행 중인 다시 받기 수

  const page = useCallback(async (before?: ActivityItem) => {
    const { data, error } = await supabase.rpc('my_activity', before ? { p_limit: PAGE, p_before_at: before.at, p_before_key: before.key } : { p_limit: PAGE });
    if (error) throw error;
    return parseItems(data);
  }, []);

  // 한 번의 다시 받기: 첫 쪽부터 펼친 쪽 수만큼 이어 받아 통째로 바꾼다(더 나중에 시작한 것이 있으면 버림)
  const reloadOnce = useCallback(
    async (id: number) => {
      const pages = Math.max(1, Math.ceil(shown.current / PAGE));
      const seenRow = supabase.from('activity_seen').select('seen_at').eq('user_id', userId).maybeSingle();
      let list: ActivityItem[] = [];
      let more = false;
      try {
        for (let n = 0; n < pages; n++) {
          const got = await page(list[list.length - 1]);
          list = list.concat(got);
          more = got.length === PAGE;
          if (!more) break;
        }
      } catch {
        if (id === req.current) setFailed(true);
        return;
      }
      const seenRes = await seenRow;
      if (id !== req.current) return; // 더 나중에 시작한 조회가 있으면 이 응답은 버린다
      setFailed(false);
      shown.current = list.length;
      version.current++;
      setItems(list);
      setHasMore(more);
      setSeen(seenRes.error ? 'unknown' : { at: (seenRes.data?.seen_at as string | undefined) ?? null });
    },
    [userId, page],
  );

  const reload = useCallback(async () => {
    const id = ++req.current;
    inFlight.current++;
    setRefreshing(true);
    try {
      await reloadOnce(id);
    } finally {
      if (--inFlight.current === 0) setRefreshing(false);
    }
  }, [reloadOnce]);

  /** 뒤쪽 한 쪽 더(이어진 구간의 마지막 항목 다음부터) */
  const loadMore = useCallback(async () => {
    if (!items?.length || inFlight.current > 0) return; // 다시 받는 중에는 옛 목록을 기준으로 더 받지 않는다
    const id = req.current;
    const ver = version.current;
    setLoadingMore(true);
    try {
      const got = await page(items[items.length - 1]);
      if (id !== req.current || ver !== version.current) return; // 그 사이 목록이 바뀌었으면 이 결과는 이어지지 않을 수 있다
      const list = items.concat(got.filter((g) => !items.some((i) => i.key === g.key)));
      shown.current = list.length;
      version.current++;
      setItems(list);
      setHasMore(got.length === PAGE);
    } catch {
      if (id === req.current) setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [items, page]);

  useEffect(() => {
    // 처음 한 번은 바로 받는다(외부 데이터와 맞추는 effect)
    void reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [reload]);

  const isNew = useCallback((a: ActivityItem) => seen !== 'unknown' && (!seen.at || Date.parse(a.at) > Date.parse(seen.at)), [seen]);
  const unread = items && seen !== 'unknown' ? items.filter(isNew).length : 0;

  /**
   * 화면에 보여 준 소식까지만 읽음으로 옮긴다. 결과: saved(저장함) · skipped(옮길 것이 없거나 아직 안 보여 준 새 소식이 남음) · failed(저장 실패). 아직 안 불러온 뒤쪽에 새 소식이 남아 있으면(보여 준 가장 오래된 소식도 새 소식이고 뒤쪽이 더 있음) 옮기지 않는다.
   * 성공한 목록이 있을 때만 부른다. 서버는 이 시각보다 앞으로 가지 않는다.
   */
  const markSeen = useCallback(async (): Promise<'saved' | 'skipped' | 'failed'> => {
    if (!items?.length || seen === 'unknown') return 'skipped';
    const oldest = items[items.length - 1];
    if (hasMore && isNew(oldest)) return 'skipped';
    const { error } = await supabase.rpc('mark_activity_seen', { p_through: items[0].at });
    if (error) return 'failed'; // 저장 실패는 호출한 쪽이 다시 시도할 계기를 정한다
    await reload();
    return 'saved';
  }, [items, seen, hasMore, isNew, reload]);

  return {
    items,
    hasMore,
    loadingMore,
    refreshing,
    failed,
    unread,
    isNew,
    reload,
    loadMore,
    markSeen,
    seenKnown: seen !== 'unknown',
  };
}
