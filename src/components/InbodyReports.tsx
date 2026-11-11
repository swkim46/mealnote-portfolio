import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchDietReport, fetchWorkoutSummary, type WorkoutSummary } from '../lib/api';
import { prettyDay } from '../lib/dates';
import { changeOf, dayAfter, scoreText, summarize, type DietReport } from '../lib/report';
import type { InbodyRecord } from '../lib/types';
import type { InbodyState } from './useInbody';
import { StaleNotice, StatePanel } from '../ui/kit';

const signed = (n: number | null, unit: string) => (n === null ? '–' : n === 0 ? '변화 없음' : `${n > 0 ? '▲' : '▼'} ${Math.abs(n).toFixed(1)}${unit}`);
type WorkoutSum = WorkoutSummary;
const round1 = (n: number) => String(Math.round(n * 10) / 10);
/** 조회 하나(회원·기간·조회 종류)의 결과. value = 받아 둔 마지막 값(없으면 null), failed = 마지막 조회가 실패했거나 제한 시간 안에 끝나지 않음 */
type Slot<T> = { value: T | null; failed: boolean };
type Slots<T> = Record<string, Slot<T>>;
/** 요약 조회 하나를 기다리는 시간. 넘기면 그 칸만 실패로 보이고(다시 불러오기), 그 뒤에라도 응답이 오면 그 값을 보인다 */
const REPORT_WAIT_MS = 15000;
/** 결과 하나를 그 칸에만 넣는다. 실패(null)면 받아 둔 값은 두고 실패만 표시 */
const put = <T,>(set: Dispatch<SetStateAction<Slots<T>>>, key: string, value: T | null) =>
  set((m) => ({ ...m, [key]: value === null ? { value: m[key]?.value ?? null, failed: true } : { value, failed: false } }));
/** 다시 불러오기: 값이 없는 실패 칸은 '불러오는 중'으로 돌리고, 값이 있는 칸은 그 값을 그대로 보인다 */
const unfail = <T,>(m: Slots<T>): Slots<T> => Object.fromEntries(Object.entries(m).filter(([, x]) => x.value !== null).map(([k, x]) => [k, { ...x, failed: false }]));

/**
 * 운동 탭 '인바디' 아래(2.1에서 '변화' 탭을 합침): 지난 측정 이후의 변화 카드(최신이 위). 인바디가 두 번 이상 있어야 카드가 생기고, 불러오는 중·실패·기록이 없거나
 * 하나뿐일 때도 무엇인지 보인다(2026-11-02 사용자 지적: 빈 화면이 고장처럼 보였다).
 * 식단 평가 평균은 서버에서 센다. 식단·평가가 바뀌면(mealsKey) 그리고 앱으로 돌아오면 다시 받는다(Codex 리뷰 v1.4 P2).
 * 다시 받는 동안에는 이전 값을 그대로 보여 준다.
 */
export function InbodyReports({ memberId, inbody, mealsKey = '', onOpen }: { memberId: string; inbody: Pick<InbodyState, 'records' | 'loaded' | 'failed' | 'reload'>; mealsKey?: string; onOpen?: (cur: InbodyRecord, prev: InbodyRecord) => void }) {
  // records는 최근 측정이 앞
  const records = inbody.records;
  const pairs = records.slice(0, -1).map((cur, i) => ({ cur, prev: records[i + 1] }));
  // 칸 이름에 회원을 넣어 같은 날짜의 다른 회원 값이 섞이지 않게 한다
  const keyOf = (p: (typeof pairs)[number]) => `${memberId}|${p.prev.measured_on}~${p.cur.measured_on}`;
  const periods = pairs.map(keyOf).join(',') || memberId;
  const [resumes, setResumes] = useState(0);
  const [retries, setRetries] = useState(0);
  // 식단 결산과 운동 요약은 기간마다 따로 받고, 끝난 것부터 그 칸에 보인다 — 하나가 실패하거나 끝나지 않아도 다른 칸과 체성분 변화는
  // 그대로(Codex v2.0.1 4차 리뷰: 실패 하나가 전부를 가림 · v2.0.2 1차 리뷰: 끝나지 않은 조회 하나가 끝난 조회까지 '불러오는 중'으로 묶음).
  // 다시 받다 실패하면 같은 칸의 마지막 값은 두고 failed로 알린다
  const [diet, setDiet] = useState<Slots<DietReport>>({});
  const [workouts, setWorkouts] = useState<Slots<WorkoutSum>>({});
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && setResumes((n) => n + 1);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    // 이 회차가 끝나면(기간·회원이 바뀌거나 다시 받기 시작) 늦게 온 응답과 남은 제한 시간은 버린다
    let alive = true;
    const timers: number[] = [];
    const watch = <T,>(set: Dispatch<SetStateAction<Slots<T>>>, key: string, job: Promise<T>) => {
      let settled = false;
      timers.push(window.setTimeout(() => alive && !settled && put(set, key, null), REPORT_WAIT_MS));
      void job.then((v) => v ?? null, () => null).then((v) => {
        settled = true;
        if (alive) put<T>(set, key, v);
      });
    };
    for (const p of pairs) {
      const from = dayAfter(p.prev.measured_on);
      watch(setDiet, keyOf(p), fetchDietReport(memberId, from, p.cur.measured_on));
      watch(setWorkouts, keyOf(p), fetchWorkoutSummary(memberId, from, p.cur.measured_on));
    }
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
    // periods가 기간 목록 전체를 담고 있다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, mealsKey, resumes, retries]);
  if (!inbody.loaded) return <StatePanel kind="loading" />;
  if (inbody.failed && !records.length) return <StatePanel kind="failed" title="인바디 기록을 불러오지 못했어요" onRetry={() => void inbody.reload()} />;
  // 다시 받기 실패: 기록 개수와 관계없이 마지막 값과 함께 알린다(Codex v2.0.1 2차 리뷰 — 기록이 하나일 때도 다시 불러오기)
  const stale = inbody.failed && <StaleNotice text="최신 인바디 기록을 불러오지 못했어요. 이전 기록을 보여 드려요." onRetry={() => void inbody.reload()} />;
  if (!pairs.length)
    return (
      <>
        {stale}
        <StatePanel
          kind="empty"
          title={records.length ? '비교할 측정이 하나 더 필요해요' : '아직 인바디 기록이 없어요'}
          description={
            records.length
              ? `다음 인바디를 기록하면 ${prettyDay(records[0].measured_on)} 측정과 비교해 그사이 식단·운동·체성분 변화를 보여 드려요.`
              : '인바디를 두 번 이상 기록하면 지난 측정 이후의 식단·운동·체성분 변화를 함께 보여 드려요.'
          }
        />
      </>
    );
  const failed = pairs.some((p) => diet[keyOf(p)]?.failed || workouts[keyOf(p)]?.failed);
  const retry = () => {
    setDiet(unfail);
    setWorkouts(unfail);
    setRetries((n) => n + 1);
  };
  return (
    <>
      {stale}
      {failed && <StaleNotice text="식단 평가·운동 기록 중 받지 못한 것이 있어요. 받은 것만 보여 드려요." onRetry={retry} />}
      <div className="section-title">
        <h3>
          지난 측정 이후의 변화 <span className="count">{pairs.length}</span>
        </h3>
      </div>
      <p className="hint report-hint">직전 측정 다음 날부터 이번 측정 날까지의 식단 평가·운동 기록·인바디 변화를 함께 보여 드려요.</p>
      {pairs.map((p) => {
        const d = diet[keyOf(p)], w = workouts[keyOf(p)];
        const r = d?.value ?? null;
        const c = changeOf(p.cur, p.prev);
        const from = dayAfter(p.prev.measured_on);
        const s = r ? summarize(r, c) : null;
        return (
          <section key={p.cur.id} className="report-card" aria-label={`${prettyDay(from)}부터 ${prettyDay(p.cur.measured_on)}까지의 변화`}>
            <div className="report-head">
              <strong>
                {prettyDay(from)} ~ {prettyDay(p.cur.measured_on)}
              </strong>
              {r && <span>{r.days}일</span>}
              {onOpen && (
                <button type="button" className="text-button report-more" onClick={() => onOpen(p.cur, p.prev)}>
                  자세히 보기 ›
                </button>
              )}
            </div>
            <div className="report-grid">
              <div className="report-score">
                <span>식단 평가 평균</span>
                {!d ? (
                  <small>불러오는 중…</small>
                ) : !r ? (
                  <small>식단 평가를 불러오지 못했어요</small>
                ) : (
                  <>
                    <strong>
                      {r.score === null ? '–' : `${scoreText(r.score)}점`}
                      <em> / 5점</em>
                    </strong>
                    <small>
                      기록한 {r.meals}끼 중 {r.rated}끼 평가
                    </small>
                  </>
                )}
              </div>
              {/* 체성분 변화는 인바디 기록만으로 정해진다 — 식단·운동 조회와 관계없이 늘 보인다 */}
              <div className="report-body">
                <span>체중 {signed(c.weight, 'kg')}</span>
                <span>골격근량 {signed(c.smm, 'kg')}</span>
                <span>체지방률 {signed(c.pbf, '%p')}</span>
              </div>
            </div>
            {r && (
              <p className="report-detail">
                기록한 날 {r.logged_days}/{r.days}일 · 아주 좋아요 {r.great} · 조금만 더 {r.good} · 조절 필요 {r.care} · 평가 안 됨 {r.meals - r.rated}
              </p>
            )}
            <p className="report-detail" data-testid="report-workout">
              {(() => {
                if (!w) return '운동 기록을 불러오는 중…';
                if (!w.value) return '운동 기록을 불러오지 못했어요.';
                // 계획(루틴)이 아니라 실제로 완료 표시한 세트만 센다. 0일은 '없음'으로(못 받은 것과 구분)
                return w.value.days ? `운동한 날 ${w.value.days}일 · 완료한 세트 ${w.value.done_sets}` : '이 기간 운동 기록 없음';
              })()}
            </p>
            {/* v2.1 유산소 합계: 거리는 적은 것만 더한다(속도·시간으로 계산해 채우지 않음) */}
            {w?.value && w.value.cardio_count > 0 && (
              <p className="report-detail" data-testid="report-cardio">
                유산소 {w.value.cardio_count}회 · {round1(w.value.cardio_minutes)}분{w.value.cardio_km > 0 ? ` · ${round1(w.value.cardio_km)}km` : ''}
              </p>
            )}
            {s && <p className={`report-line ${s.goodDiet && s.improved ? 'good' : ''}`}>{s.line}</p>}
          </section>
        );
      })}
    </>
  );
}
