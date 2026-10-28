import { useEffect, useState } from 'react';
import { fetchDietReport } from '../lib/api';
import { prettyDay } from '../lib/dates';
import { changeOf, dayAfter, scoreText, summarize, type DietReport } from '../lib/report';
import type { InbodyRecord } from '../lib/types';

const signed = (n: number | null, unit: string) => (n === null ? '–' : n === 0 ? '변화 없음' : `${n > 0 ? '▲' : '▼'} ${Math.abs(n).toFixed(1)}${unit}`);

/**
 * 지난 측정 이후의 변화 카드(최신이 위). 인바디가 두 번 이상 있어야 생긴다.
 * 식단 평가 평균은 서버에서 센다. 식단·평가가 바뀌면(mealsKey) 그리고 앱으로 돌아오면 다시 받는다(Codex 리뷰 v1.4 P2).
 * 다시 받는 동안에는 이전 값을 그대로 보여 준다.
 */
export function InbodyReports({ memberId, records, mealsKey = '' }: { memberId: string; records: InbodyRecord[]; mealsKey?: string }) {
  // records는 최근 측정이 앞
  const pairs = records.slice(0, -1).map((cur, i) => ({ cur, prev: records[i + 1] }));
  const periods = `${memberId}|${pairs.map((p) => `${p.prev.measured_on}~${p.cur.measured_on}`).join(',')}`;
  const [resumes, setResumes] = useState(0);
  const [loaded, setLoaded] = useState<{ periods: string; reports: (DietReport | null)[] }>({ periods: '', reports: [] });
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && setResumes((n) => n + 1);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all(pairs.map((p) => fetchDietReport(memberId, dayAfter(p.prev.measured_on), p.cur.measured_on).catch(() => null))).then(
      (reports) => alive && setLoaded({ periods, reports }),
    );
    return () => {
      alive = false;
    };
    // periods가 기간 목록 전체를 담고 있다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, mealsKey, resumes]);
  if (!pairs.length) return null;
  const reports = loaded.periods === periods ? loaded.reports : null;
  return (
    <>
      <div className="section-title">
        <h3>
          지난 측정 이후의 변화 <span className="count">{pairs.length}</span>
        </h3>
      </div>
      <p className="hint report-hint">직전 측정 다음 날부터 이번 측정 날까지 받은 식단 평가와 인바디 변화를 함께 보여 드려요.</p>
      {pairs.map((p, i) => {
        const r = reports?.[i];
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
            </div>
            {!reports ? (
              <p className="hint">불러오는 중…</p>
            ) : !r ? (
              <p className="hint">식단 평가를 불러오지 못했어요.</p>
            ) : (
              <>
                <div className="report-grid">
                  <div className="report-score">
                    <span>식단 평가 평균</span>
                    <strong>
                      {r.score === null ? '–' : `${scoreText(r.score)}점`}
                      <em> / 5점</em>
                    </strong>
                    <small>
                      기록한 {r.meals}끼 중 {r.rated}끼 평가
                    </small>
                  </div>
                  <div className="report-body">
                    <span>체중 {signed(c.weight, 'kg')}</span>
                    <span>골격근량 {signed(c.smm, 'kg')}</span>
                    <span>체지방률 {signed(c.pbf, '%p')}</span>
                  </div>
                </div>
                <p className="report-detail">
                  기록한 날 {r.logged_days}/{r.days}일 · 아주 좋아요 {r.great} · 조금만 더 {r.good} · 조절 필요 {r.care} · 평가 안 됨 {r.meals - r.rated}
                </p>
                <p className={`report-line ${s!.goodDiet && s!.improved ? 'good' : ''}`}>{s!.line}</p>
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
