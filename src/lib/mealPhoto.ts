// 남의 식사 사진(담당 트레이너가 보는 회원 사진·추천 식단 사진, v1.8).
// 서명 주소 대신 서버 기능 meal-photo가 요청마다 지금 권한을 확인해 내려주고, 앱은 임시 주소(blob:)로 보인다.
//
// 임시 주소의 수명(Codex v1.8.0 3차 리뷰 1):
//  - 같은 사진(식사·경로)은 여러 화면(카드·상세)이 함께 쓴다. 쓰는 화면 수를 세고, 0이 되면 '쉬는 사진'으로 둔다.
//  - 쉬는 사진은 최근 것 IDLE_LIMIT장까지만 두고 오래된 것부터 해제한다(URL.revokeObjectURL). 같은 식사의 새 경로를 받으면 옛 경로는 쉬는 즉시 해제한다.
//  - 계정이 바뀌면(clearMealPhotos) 모두 해제하고, 그 전에 시작한 요청이 늦게 끝나도 캐시에 넣지 않고 바로 해제한다.
// 실패는 기억하지 않는다. 다시 받는 계기는 한 곳에서 낸다(3차 리뷰 2): 앱 복귀, 식사·추천 식단 목록을 새로 받았을 때(retryFailedMealPhotos).
// 실패한 사진만 그때 한 번씩 다시 받는다 — 성공한 사진은 다시 받지 않고, 실패를 쉬지 않고 반복하지도 않는다.
import { useEffect, useRef, useState } from 'react';
import { fetchMealPhoto } from './api';

export interface PhotoRef {
  mealId: string;
  path: string;
}

const IDLE_LIMIT = 40;
type Entry = { url: string; mealId: string; refs: number; idleSince: number };
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<string>>();
let generation = 0;
let idleClock = 0;
const keyOf = (p: PhotoRef) => `${p.mealId}|${p.path}`;

function trim() {
  const idle = [...entries].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].idleSince - b[1].idleSince);
  for (const [k, e] of idle.slice(0, Math.max(0, idle.length - IDLE_LIMIT))) {
    URL.revokeObjectURL(e.url);
    entries.delete(k);
  }
}

/** 같은 식사의 다른(옛) 경로 중 아무도 안 쓰는 것은 바로 해제 */
function dropReplaced(k: string, mealId: string) {
  for (const [other, e] of entries)
    if (other !== k && e.mealId === mealId && e.refs === 0) {
      URL.revokeObjectURL(e.url);
      entries.delete(other);
    }
}

function acquire(k: string): string | undefined {
  const e = entries.get(k);
  if (!e) return undefined;
  e.refs++;
  return e.url;
}

function release(k: string) {
  const e = entries.get(k);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  if (e.refs === 0) {
    e.idleSince = ++idleClock;
    trim();
  }
}

function load(p: PhotoRef): Promise<void> {
  const k = keyOf(p);
  if (entries.has(k)) return Promise.resolve();
  let job = pending.get(k);
  if (!job) {
    const gen = generation;
    job = fetchMealPhoto(p.mealId)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (gen !== generation) {
          URL.revokeObjectURL(url); // 계정이 바뀐 뒤 도착한 응답
          throw new Error('stale');
        }
        entries.set(k, { url, mealId: p.mealId, refs: 0, idleSince: ++idleClock });
        dropReplaced(k, p.mealId);
        trim();
        return url;
      })
      .finally(() => {
        if (pending.get(k) === job) pending.delete(k);
      });
    pending.set(k, job);
  }
  return job.then(() => undefined);
}

/** 받은 사진이 이미지로 열리지 않을 때(깨진 파일): 그 사진을 캐시에서 빼 다시 받게 한다(적대 검토 3차 S3 — 다시 불러오기가 깨진 캐시를 다시 썼다) */
function forget(k: string) {
  const e = entries.get(k);
  if (!e) return;
  URL.revokeObjectURL(e.url);
  entries.delete(k);
}

/** 로그아웃·계정 전환: 받은 사진을 모두 해제하고, 진행 중인 요청의 결과도 버린다 */
export function clearMealPhotos() {
  generation++;
  for (const e of entries.values()) URL.revokeObjectURL(e.url);
  entries.clear();
  pending.clear();
}

const retryListeners = new Set<() => void>();
/** 실패한 사진을 한 번 다시 받게 한다(목록을 새로 받았을 때 부른다) */
export function retryFailedMealPhotos() {
  for (const f of [...retryListeners]) f();
}
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && retryFailedMealPhotos());

/** 사진 하나. visible이 되면 받는다. 결과는 그 사진(식사·경로)에 묶어 다른 사진에 쓰지 않는다. */
export function useMealPhoto(photo: PhotoRef | undefined, visible: boolean) {
  return useMealPhotoState(photo, visible).url;
}

/**
 * 사진 하나와 받기 상태(2.4 — 상세에서 '사진 없이 기록한 식사'와 '받지 못함'을 나눈다, Codex v2.3.3 1차 요청 P3).
 * failed: 받지 못함(다시 불러오기 retry). url도 failed도 없으면 받는 중
 */
export function useMealPhotoState(photo: PhotoRef | undefined, visible: boolean) {
  const k = photo ? keyOf(photo) : '';
  const [state, setState] = useState<{ k: string; url?: string; failed: boolean }>({ k, failed: false });
  const [attempt, setAttempt] = useState(0);
  const failedRef = useRef(false);
  useEffect(() => {
    const onRetry = () => failedRef.current && setAttempt((n) => n + 1);
    retryListeners.add(onRetry);
    return () => {
      retryListeners.delete(onRetry);
    };
  }, []);
  useEffect(() => {
    if (!photo || !visible) return;
    let alive = true;
    let held = false;
    const take = () => {
      const url = acquire(k);
      if (!url) return false;
      held = true;
      failedRef.current = false;
      setState({ k, url, failed: false });
      return true;
    };
    if (!take())
      load(photo)
        .then(() => {
          if (alive && !take()) throw new Error('evicted');
        })
        .catch(() => {
          if (!alive) return;
          failedRef.current = true;
          setState({ k, failed: true });
        });
    return () => {
      alive = false;
      if (held) release(k);
    };
    // photo는 k로 대표된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, visible, attempt]);
  const mine = state.k === k;
  return {
    url: mine ? state.url : undefined,
    failed: mine && state.failed,
    /** broken: 받은 사진이 화면에서 열리지 않았다 — 캐시에서 빼고 새로 받는다 */
    retry: (broken = false) => {
      if (broken && k) forget(k);
      setState({ k, failed: false });
      setAttempt((n) => n + 1);
    },
  };
}
