// 인바디 변화 보고서(2.3 — 시안 design/v23-20261105 07·08). 변화 카드의 '자세히 보기'로 연다. 회원·트레이너가 같은 화면을 보고, 트레이너만 총평을 쓴다.
// 칸마다 따로 받는다 — 하나가 실패해도 나머지는 그대로 보인다(변화 카드와 같은 방식).
import { useEffect, useRef, useState } from 'react';
import { fetchDietPeriod, fetchDietReport, fetchFastingBetween, fetchReportNote, fetchWorkoutsBetween, fetchWorkoutSummary, PERIOD_WORKOUTS_LIMIT, saveReportNote, type WorkoutSession } from '../lib/api';
import { setUnsaved } from '../lib/appUpdate';
import { kstDateKey, prettyDay } from '../lib/dates';
import { MEAL_TYPES, type InbodyRecord } from '../lib/types';
import { fastingLine, liftChanges, periodCalendar, routineCounts, scoreWeeks } from '../lib/periodReport';
import { bodySentence, changeOf, dayAfter, scoreText } from '../lib/report';
import { useLive } from '../lib/useLive';
import { useSheetDraft } from './Sheet';
import { useToast } from './Toast';
import { StaleNotice, StatePanel } from '../ui/kit';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
/** 변화 카드와 같은 기다림: 넘기면 그 칸만 실패로 보이고 다시 받을 수 있다 */
const REPORT_WAIT_MS = 15000;
const inTime = <T,>(job: Promise<T>) => Promise.race([job, new Promise<never>((_, fail) => window.setTimeout(() => fail(new Error('timeout')), REPORT_WAIT_MS))]);
/** 제한 시간이 지나 실패로 보인 뒤에라도 응답이 오면 그 값을 보인다(변화 카드와 같다) */
function useSummary<T>(scope: string, load: () => Promise<T>) {
  const asked = useRef(0);
  // 받은 응답 가운데 가장 나중에 보낸 요청의 값. 먼저 보낸 요청이 늦게 와도 새 값을 덮지 않는다
  const [got, setGot] = useState<{ scope: string; n: number; value: T } | null>(null);
  const live = useLive(scope, '', () => {
    const n = ++asked.current;
    const job = load();
    job.then((value) => setGot((cur) => (cur?.scope === scope && cur.n > n ? cur : { scope, n, value })), () => {});
    return inTime(job);
  });
  const mine = got?.scope === scope ? got : null;
  // 마지막 요청의 응답이 왔으면 실패가 아니다. 앞선 값을 보이는 동안 새로 받지 못했으면 실패로 알린다
  return { ...live, value: mine?.value, failed: live.failed && mine?.n !== asked.current };
}
const LIFTS_SHOWN = 6;
const num = (n: number) => String(Math.round(n * 10) / 10);
const delta = (n: number | null, unit: string) => (n === null ? '–' : n === 0 ? '변화 없음' : `${n > 0 ? '+' : '-'}${Math.abs(n).toFixed(1)}${unit}`);

function Loading({ failed, title, onRetry }: { failed: boolean; title: string; onRetry: () => void }) {
  return failed ? <StatePanel kind="failed" title={title} onRetry={onRetry} /> : <StatePanel kind="loading" />;
}

function Calendar({ from, to, days, sessions }: { from: string; to: string; days: Parameters<typeof periodCalendar>[2]; sessions: WorkoutSession[] }) {
  return (
    <>
      <div className="period-cal" data-testid="period-calendar">
        {WEEKDAYS.map((w) => <small key={w}>{w}</small>)}
        {periodCalendar(from, to, days, sessions).map((c) => (
          <span key={c.day} className={c.inside ? undefined : 'is-out'} data-day={c.day}>
            {c.label}
            {c.tone && <i className={`tone-${c.tone}`} />}
            {c.work && <em className={c.work === 'cardio' ? 'is-cardio' : undefined} />}
          </span>
        ))}
      </div>
      <div className="period-legend">
        <span><i className="tone-great" />아주 좋아요</span>
        <span><i className="tone-good" />조금만 더</span>
        <span><i className="tone-care" />조절 필요</span>
        <span><i className="tone-wait" />평가 전</span>
        <span><em />운동</span>
        <span><em className="is-cardio" />유산소만</span>
      </div>
    </>
  );
}

function NoteEditor({ inbodyId, saved, onSaved }: { inbodyId: string; saved: string; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(saved);
  // stored = 서버에 있다고 아는 글. 저장에 성공하면 다시 받기를 기다리지 않고 바로 바꾼다(다시 받기가 실패해도 저장한 글을 쓰던 내용으로 보지 않게)
  const [stored, setStored] = useState(saved);
  const [received, setReceived] = useState(saved);
  const [busy, setBusy] = useState(false);
  // 다시 받은 총평이 달라지면 받아 쓰되, 쓰던 글은 덮지 않는다
  if (saved !== received) {
    setReceived(saved);
    setStored(saved);
    if (text.trim() === stored) setText(saved);
  }
  const dirty = text.trim() !== stored;
  useEffect(() => {
    setUnsaved('report-note', dirty);
    return () => setUnsaved('report-note', false);
  }, [dirty]);
  useSheetDraft(dirty, busy);
  const save = async () => {
    setBusy(true);
    try {
      await saveReportNote(inbodyId, text.trim());
      setStored(text.trim());
      toast(text.trim() ? '총평을 저장했어요.' : '총평을 지웠어요.');
      onSaved();
    } catch {
      toast('총평을 저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <textarea className="report-note-input" aria-label="트레이너 총평" rows={4} maxLength={1000} data-saved={dirty ? undefined : ''} value={text} placeholder="이 기간의 변화와 회원에게 전할 말을 적어 주세요." onChange={(e) => setText(e.target.value)} />
      <div className="report-note-actions">
        <button type="button" className="secondary" disabled={!dirty || busy} onClick={() => setText(stored)}>취소</button>
        <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '저장 중…' : '총평 저장'}</button>
      </div>
      <p className="tiny">저장한 총평은 회원의 변화 보고서에도 보여요.</p>
    </>
  );
}

export function ChangeReport({ memberId, cur, prev, canWrite = false }: { memberId: string; cur: InbodyRecord; prev: InbodyRecord; canWrite?: boolean }) {
  const from = dayAfter(prev.measured_on), to = cur.measured_on;
  const scope = `report-${memberId}-${cur.id}-${prev.id}`;
  const summary = useSummary(`${scope}-diet`, () => fetchDietReport(memberId, from, to));
  const work = useSummary(`${scope}-work`, () => fetchWorkoutSummary(memberId, from, to));
  const period = useLive(`${scope}-period`, '', () => fetchDietPeriod(memberId, from, to));
  const sessions = useLive(`${scope}-sessions`, '', () => fetchWorkoutsBetween(memberId, from, to));
  const fasting = useLive(`${scope}-fasting`, '', () => fetchFastingBetween(memberId, from, to));
  const [noteVersion, setNoteVersion] = useState(0);
  const note = useLive(`${scope}-note`, String(noteVersion), () => fetchReportNote(cur.id));
  const parts = [summary, work, period, sessions, fasting, note];
  // 요약·공복 체중이 비었거나, 어느 칸이든 마지막 값을 보이는 중에 새로 받지 못했으면 알린다(달력·식단·운동·총평은 값이 없으면 그 칸에 다시 불러오기가 있다)
  const missed = summary.failed || work.failed || fasting.failed || parts.some((x) => x.failed && x.value !== undefined);
  const c = changeOf(cur, prev);
  const r = summary.value, w = work.value, p = period.value, list = sessions.value;
  const fastLine = fastingLine(fasting.value ?? []);
  const lifts = list ? liftChanges(list) : [];
  const counts = list ? routineCounts(list) : [];
  const weeks = p ? scoreWeeks(from, to, p.days) : [];
  const types = p ? MEAL_TYPES.flatMap((t) => p.types.filter((x) => x.meal_type === t)) : [];
  return (
    <div className="change-report" data-testid="change-report">
      <p className="tiny">
        {prettyDay(from)} ～ {prettyDay(to)} · 이전 측정({prettyDay(prev.measured_on)}) 이후부터 이번 측정({prettyDay(to)})까지의 기록
      </p>
      {missed && <StaleNotice text="일부 기록을 새로 불러오지 못했어요." onRetry={() => parts.forEach((x) => x.reload())} />}
      <section>
        <h3>한눈에</h3>
        <div className="report-sum">
          <p>
            <b>식단</b>
            <span>{r ? `평가 평균 ${r.score === null ? '–' : `${scoreText(r.score)}점`} / 5점 · 기록한 ${r.meals}끼 중 ${r.rated}끼 평가 · ${r.logged_days}일 기록` : summary.failed ? '불러오지 못했어요' : '불러오는 중…'}</span>
          </p>
          <p>
            <b>운동</b>
            <span>
              {!w ? (work.failed ? '불러오지 못했어요' : '불러오는 중…') : w.days ? `운동한 날 ${w.days}일 · 완료 ${w.done_sets}세트${w.cardio_count ? ` · 유산소 ${w.cardio_count}회 ${num(w.cardio_minutes)}분${w.cardio_km > 0 ? ` ${num(w.cardio_km)}km` : ''}` : ''}` : '이 기간에는 운동 기록이 없어요'}
            </span>
          </p>
          <p>
            <b>체성분</b>
            <span>{bodySentence(c)}</span>
          </p>
        </div>
      </section>
      <section>
        <h3>체성분</h3>
        <div className="report-body3">
          <div><small>체중</small><b>{cur.weight_kg}kg</b><span>{delta(c.weight, 'kg')}</span></div>
          <div><small>골격근량</small><b>{cur.smm_kg === null ? '–' : `${cur.smm_kg}kg`}</b><span className={c.smm && c.smm > 0 ? 'is-good' : undefined}>{delta(c.smm, 'kg')}</span></div>
          <div><small>체지방률</small><b>{cur.pbf_pct === null ? '–' : `${cur.pbf_pct}%`}</b><span className={c.pbf && c.pbf < 0 ? 'is-good' : undefined}>{delta(c.pbf, '%p')}</span></div>
        </div>
        {fastLine && <p className="tiny">{fastLine}</p>}
      </section>
      <section>
        <h3>기간 달력</h3>
        {p && list ? <Calendar from={from} to={to} days={p.days} sessions={list} /> : <Loading failed={period.failed || sessions.failed} title="달력을 불러오지 못했어요" onRetry={() => { period.reload(); sessions.reload(); }} />}
        {list && list.length >= PERIOD_WORKOUTS_LIMIT && <p className="tiny">운동 기록은 최근 {PERIOD_WORKOUTS_LIMIT}개까지만 표시해요.</p>}
      </section>
      <section>
        <h3>식단 평가 흐름</h3>
        {!p ? (
          <Loading failed={period.failed} title="식단 평가를 불러오지 못했어요" onRetry={period.reload} />
        ) : !p.days.length ? (
          <p className="tiny">이 기간 식단 기록이 없어요.</p>
        ) : (
          <>
            <div className="report-bars" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }} data-testid="report-weeks">
              {weeks.map((x) => (
                <div key={x.label}>
                  <b>{x.text}</b>
                  {x.score !== null && <i style={{ height: `${x.score * 14}px` }} />}
                  <small>{x.label}</small>
                </div>
              ))}
            </div>
            <div className="report-stack" data-testid="report-types">
              {types.map((t) => {
                const total = t.great + t.good + t.care + t.none;
                const bar = (n: number) => ({ width: `${(n / total) * 100}%` });
                return (
                  <div key={t.meal_type}>
                    <b>{t.meal_type}</b>
                    <p>
                      <i className="tone-great" style={bar(t.great)} />
                      <i className="tone-good" style={bar(t.good)} />
                      <i className="tone-care" style={bar(t.care)} />
                      <i className="tone-wait" style={bar(t.none)} />
                    </p>
                    <small>{total}끼</small>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
      <section>
        <h3>운동 변화</h3>
        {!list ? (
          <Loading failed={sessions.failed} title="운동 기록을 불러오지 못했어요" onRetry={sessions.reload} />
        ) : !counts.length ? (
          <p className="tiny">이 기간 운동 기록이 없어요.</p>
        ) : (
          <>
            <div className="report-counts">
              {counts.map((x) => (
                <div key={x.label}><small>{x.label}</small><b>{x.count}회</b></div>
              ))}
            </div>
            {lifts.length > 0 ? (
              <>
                <p className="tiny">운동별 최고 중량 · 첫 기록 → 마지막 기록</p>
                <div className="report-lifts" data-testid="report-lifts">
                  {lifts.slice(0, LIFTS_SHOWN).map((x) => (
                    <div key={x.name}>
                      <span>{x.name}</span>
                      <b>{num(x.first)} → {num(x.last)}kg<em className={x.delta < 0 ? 'is-down' : undefined}>{x.delta > 0 ? '+' : ''}{num(x.delta)}</em></b>
                    </div>
                  ))}
                </div>
                {lifts.length > LIFTS_SHOWN && <p className="tiny">외 {lifts.length - LIFTS_SHOWN}개</p>}
              </>
            ) : (
              <p className="tiny">첫 기록과 마지막 기록의 중량이 달라진 운동이 없어요.</p>
            )}
            {list.length >= PERIOD_WORKOUTS_LIMIT && <p className="tiny">운동 기록이 많아 최근 {PERIOD_WORKOUTS_LIMIT}개를 기준으로 계산했어요.</p>}
          </>
        )}
      </section>
      <section>
        <h3>트레이너 총평</h3>
        {note.value === undefined ? (
          <Loading failed={note.failed} title="총평을 불러오지 못했어요" onRetry={note.reload} />
        ) : canWrite ? (
          <NoteEditor inbodyId={cur.id} saved={note.value?.body ?? ''} onSaved={() => setNoteVersion((v) => v + 1)} />
        ) : note.value ? (
          <>
            <p className="report-note">{note.value.body}</p>
            <small className="report-note-meta">{note.value.trainer ? `${note.value.trainer} 트레이너 · ` : ''}{prettyDay(kstDateKey(new Date(note.value.updated_at)))}</small>
          </>
        ) : (
          <p className="tiny">아직 총평이 없어요.</p>
        )}
      </section>
    </div>
  );
}
