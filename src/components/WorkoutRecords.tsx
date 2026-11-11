// 운동 탭 '운동 기록'(2.1, 2026-11-03 사용자 확정 — design/workout-tab-20261103 시안 3, 같은 날 정돈):
//  꾸준함 요약(이번 주·연속 주·이번 달) + 최근 5주 달력 → 주 단위로 묶은 한 줄 기록(누르면 그 기록을 연다).
//  2026-11-03 사용자 요청("운동 기록이 그냥 쭉 나열돼 사용성이 안 좋다"): 큰 카드를 길게 잇던 것을, 레퍼런스대로 정돈했다 —
//   · 주 단위 묶음과 묶음 머리의 횟수(Fitbod 날짜 머리말·한 주 띠, Hevy 주 연속)
//   · 루틴별로 골라 보기(같은 루틴끼리 견주기 쉽게)
//   · 달력에서 운동한 날을 누르면 그날 기록으로(플랜핏·JEFIT·애플 피트니스 — 달력에서 날짜를 고르면 그날 기록)
//   · 한 줄 기록: 날짜 칸(일·요일) · 루틴 · 완료 세트 · 운동 두 개의 가장 무거운 세트와 최고 표시(Strong Best Set을 한 줄로)
//  카드 목록은 앱이 받아 둔 최근 기록(fetchWorkouts, 30개)이고, 요약·달력·최고 기록은 서버 집계(workout_overview·workout_compare)로 센다
//  (Codex v2.1.0 3차 리뷰 P2·P3). 집계를 받지 못하면 요약 대신 다시 불러오기를, 기록에는 최고·오름 표시를 하지 않는다.
// 근거: 문서/기획/운동탭_레퍼런스조사_261103.md
import { useEffect, useRef, useState } from 'react';
import { prettyDay, shiftDay, todayKey } from '../lib/dates';
import { routineFocus } from '../lib/bodyParts';
import { cardioLine } from '../lib/cardio';
import { bestRows, isWorkout, recentCalendar, weekStart } from '../lib/workoutStats';
import { WORKOUT_LIMIT, type WorkoutCompare, type WorkoutOverview, type WorkoutSession } from '../lib/api';
import { Section, StaleNotice, StatePanel } from '../ui/kit';
import { Icon } from './Icon';

/**
 * 보조 자료(요약·비교)의 상태(Codex v2.2.0 3차 리뷰 — 설명과 실제 값을 맞춤):
 *  ok = 지금 자료 세대의 값 · refreshing = 자료가 바뀌어 새로 받는 중, 직전 세대의 값을 보이는 중(요약만 — 비교는 쓰지 않음) ·
 *  stale = 값은 있지만 지금 기준의 조회가 실패(이전 값) · loading = 처음 받는 중 · failed = 받지 못함
 */
export type AuxState = 'ok' | 'refreshing' | 'stale' | 'loading' | 'failed';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00`) - Date.parse(`${b}T12:00:00`)) / 86_400_000);
const relDay = (day: string, today: string) => {
  const n = daysBetween(today, day);
  return n === 0 ? '오늘' : n === 1 ? '어제' : n > 1 ? `${n}일 전` : '';
};
const weekday = (day: string) => WEEKDAYS[new Date(`${day}T12:00:00`).getDay()];
/** 골라 보기 칸: 루틴 번호 · 유산소만 · 루틴 없이 직접 기록 */
const kindOf = (s: WorkoutSession) => (s.day_no ? `r${s.day_no}` : s.sets.length ? 'free' : 'cardio');
const kindLabel = (k: string) => (k === 'cardio' ? '유산소' : k === 'free' ? '직접 기록' : `루틴 ${k.slice(1)}`);

/** 한 줄 기록(누르면 연다) */
function RecordRow({ s, cmp, today, flash, onOpen }: { s: WorkoutSession; cmp: WorkoutCompare[string] | null; today: string; flash: boolean; onOpen: (s: WorkoutSession) => void }) {
  const done = s.sets.filter((x) => x.done).length;
  const names = [...new Set(s.sets.map((x) => x.name))];
  const focus = names.length ? routineFocus(names) : '';
  const title = s.day_no ? `루틴 ${s.day_no}${focus ? ` · ${focus}` : ''}` : names.length ? focus || '운동' : '유산소';
  const rows = bestRows(s, cmp);
  const records = rows.filter((r) => r.record).length;
  const stats = [relDay(s.day, today), s.sets.length ? `완료 ${done}/${s.sets.length}세트` : '', s.sets.length ? `운동 ${names.length}개` : ''].filter(Boolean);
  // 운동 두 개의 가장 무거운 세트(최고 기록·오른 무게가 있는 운동을 먼저), 나머지는 수만
  const rank = (r: (typeof rows)[number]) => (r.record ? 2 : r.up ? 1 : 0);
  const lifts = [...rows].sort((a, b) => rank(b) - rank(a)).slice(0, 2);
  const more = rows.length - lifts.length;
  return (
    <button type="button" className={`workout-row record-row${flash ? ' is-flash' : ''}`} data-day={s.day} onClick={() => onOpen(s)}>
      <span className="record-date" aria-hidden="true">
        <b>{Number(s.day.slice(8))}</b>
        <small>{weekday(s.day)}</small>
      </span>
      <span className="record-main">
        <span className="sr-only">{prettyDay(s.day, true)}</span>
        <span className="record-top">
          <strong className="record-title">{title}</strong>
          {s.source === 'sheet' && <span className="sheet-tag">시트 기록</span>}
          {records > 0 && <em className="record-pr">최고 {records}</em>}
        </span>
        <span className="record-stats">{stats.join(' · ')}</span>
        {lifts.length > 0 && (
          <span className="record-lifts">
            {lifts.map((r) => (
              <span key={r.name} className="record-lift">
                {r.name} <b>{r.best}</b>
                {r.record ? <em className="record-pr">최고</em> : r.up ? <em className="record-up">↑{r.up}</em> : null}
              </span>
            ))}
            {more > 0 && <span className="record-more">외 {more}개</span>}
          </span>
        )}
        {/* 유산소는 근력과 함께 한 날에도 종류·시간·거리를 한 줄로 */}
        {s.cardio.length > 0 && (
          <span className="record-lifts">
            {s.cardio.map((c, i) => (
              <span key={i} className="record-lift">
                {cardioLine(c)}
              </span>
            ))}
          </span>
        )}
        {!lifts.length && !s.cardio.length && <span className="record-stats">완료한 세트 없음</span>}
      </span>
    </button>
  );
}

export function WorkoutRecords({ sessions, overview, overviewState, compare, compareState, onOpen, onRetry, onFind }: {
  sessions: WorkoutSession[];
  /** 서버 요약(아직·못 받았으면 null) */
  overview: WorkoutOverview | null;
  overviewState: AuxState;
  /** 서버 비교 — 지금 기록 내용에 맞는 것만(아직·못 받았거나 기록이 바뀐 뒤 새로 받지 못했으면 null) */
  compare: WorkoutCompare | null;
  compareState: AuxState;
  onOpen: (s: WorkoutSession) => void;
  onRetry: () => void;
  /** 2.4 운동 찾기(결정 2-1: 기록 목록 제목 줄 오른쪽) */
  onFind?: () => void;
}) {
  // 서버가 센 날짜(기기 시계가 크게 틀리면 서버 날짜)로 달력·이번 달·며칠 전을 그린다 — 숫자와 달력이 같은 날을 기준으로
  const today = overview?.today ?? todayKey();
  const cells = overview ? recentCalendar(overview.days, today) : [];
  const [filter, setFilter] = useState('all');
  const [flash, setFlash] = useState('');
  const list = useRef<HTMLDivElement>(null);
  // 목록 순서 = 날짜·시작 시각·id(최근 것부터) — 서버 비교의 앞뒤와 같은 기준
  const sorted = [...sessions].sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.started_at !== b.started_at ? (a.started_at < b.started_at ? 1 : -1) : a.id < b.id ? 1 : -1));
  const kinds = [...new Set(sorted.map(kindOf))].sort((a, b) => (a[0] === 'r' && b[0] === 'r' ? Number(a.slice(1)) - Number(b.slice(1)) : a[0] === 'r' ? -1 : b[0] === 'r' ? 1 : a.localeCompare(b)));
  // 고른 종류가 목록에서 사라지면(그 종류의 마지막 기록을 지움·시트 맞추기) 전체로 — 종류가 하나만 남으면 고르는 칸이 숨어 돌아갈 길이 없었다(Codex v2.2.0 1차 리뷰 P2-3).
  // 그리는 순간부터 전체를 쓰고, 고른 값도 풀어 둔다(같은 종류가 나중에 다시 생겨도 저절로 다시 골라지지 않게)
  // 종류가 하나만 남아 고르는 칸이 숨을 때도 전체로(숨은 채 골라져 있으면 새로 저장한 다른 루틴 기록이 가려졌다 — 적대 검토)
  const kindsKey = kinds.join(',');
  const active = filter !== 'all' && kinds.length > 1 && kinds.includes(filter) ? filter : 'all';
  useEffect(() => {
    const ks = kindsKey ? kindsKey.split(',') : [];
    if (filter !== 'all' && (ks.length <= 1 || !ks.includes(filter))) setFilter('all');
  }, [filter, kindsKey]);
  const shown = active === 'all' ? sorted : sorted.filter((s) => kindOf(s) === active);
  const groups = new Map<string, WorkoutSession[]>();
  for (const s of shown) {
    const w = weekStart(s.day);
    groups.set(w, [...(groups.get(w) ?? []), s]);
  }
  // 받아 둔 목록이 한도까지 찼으면 가장 오래된 주는 일부만 있을 수 있다 — 그 주 묶음과 전체 개수는 세지 않는다
  const truncated = sessions.length >= WORKOUT_LIMIT;
  const oldest = [...groups.keys()].pop();
  const thisWeek = weekStart(today);
  const md = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;
  const weekLabel = (w: string) => {
    if (w === thisWeek) return '이번 주';
    if (w === shiftDay(thisWeek, -7)) return '지난주';
    const end = shiftDay(w, 6);
    return `${md(w)} ～ ${end.slice(5, 7) === w.slice(5, 7) ? `${Number(end.slice(8))}일` : md(end)}`;
  };
  // 달력에서 운동한 날을 누르면 그날 기록으로(골라 보기를 풀고 그 줄을 화면 가운데로 · 잠깐 표시)
  const jump = (day: string) => {
    setFilter('all');
    setFlash(day);
    window.setTimeout(() => setFlash((d) => (d === day ? '' : d)), 1600);
    requestAnimationFrame(() => list.current?.querySelector(`[data-day="${day}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };
  const loaded = new Set(sessions.map((s) => s.day));
  // 달력은 서버 집계 전체를, 아래 목록은 최근 기록만 그린다 — 목록에 없는 운동한 날이 있으면 누를 수 있는 날을 알린다(1차 리뷰 후속 검토)
  const unlisted = cells.some((c) => c.kind && !loaded.has(c.day));
  const staleOv = overviewState === 'stale';
  const staleCmp = compareState === 'stale' && sessions.length > 0;
  return (
    <>
      {/* 한 번 받은 뒤 다시 받기가 실패하면 이전 값을 두되 그 사실과 다시 불러오기를 알린다(1차 리뷰 P2-2) */}
      {(staleOv || staleCmp) && (
        <StaleNotice
          text={`${staleOv && staleCmp ? '운동 횟수·달력과 최고 기록·오른 무게를' : staleOv ? '운동 횟수·달력을' : '최고 기록·오른 무게를'} 새로 불러오지 못해 이전 값을 보여 드려요.`}
          onRetry={onRetry}
        />
      )}
      {overview ? (
        <section className="records-summary" aria-label="꾸준함" data-testid="records-summary">
          <div className="records-tiles">
            <div>
              <small>이번 주</small>
              <b>{overview.this_week}회</b>
            </div>
            <div>
              <small>연속</small>
              <b>{overview.streak_weeks}주</b>
            </div>
            <div>
              <small>{Number(today.slice(5, 7))}월</small>
              <b>{overview.this_month}회</b>
            </div>
          </div>
          <div className="records-cal-head">
            <strong>최근 5주</strong>
            <span className="tiny">{unlisted ? `최근 ${WORKOUT_LIMIT}개 기록에 있는 날을 누르면 그날 기록으로` : '운동한 날을 누르면 그날 기록으로'}</span>
          </div>
          <div className="records-cal" role="group" aria-label="최근 5주 운동한 날">
            {WEEKDAYS.map((w) => (
              <span key={w} className="records-wd" aria-hidden="true">
                {w}
              </span>
            ))}
            {cells.map((cell) => {
              const cls = `records-cell${cell.kind ? ` is-${cell.kind}` : ''}${cell.today ? ' is-today' : ''}${cell.future ? ' is-future' : ''}`;
              const label = `${prettyDay(cell.day)}${cell.label ? ` ${cell.label}` : ''}`;
              const body = (
                <>
                  <b>{cell.day.slice(8) === '01' ? `${Number(cell.day.slice(5, 7))}/1` : Number(cell.day.slice(8))}</b>
                  <small>{cell.label}</small>
                </>
              );
              return cell.kind && loaded.has(cell.day) ? (
                <button key={cell.day} type="button" className={cls} aria-label={`${label} 기록 보기`} onClick={() => jump(cell.day)}>
                  {body}
                </button>
              ) : (
                <span key={cell.day} className={cls} role="img" aria-label={label}>
                  {body}
                </span>
              );
            })}
          </div>
        </section>
      ) : overviewState === 'failed' ? (
        <StaleNotice text="운동 횟수·달력을 불러오지 못했어요." onRetry={onRetry} />
      ) : (
        <p className="tiny records-loading" data-testid="records-summary-loading">운동 횟수·달력을 불러오는 중…</p>
      )}
      {/* 비교만 실패하면 기록에 최고·오름 표시가 없다 — 표시가 없는 이유를 알리고 다시 불러오게(적대 검토 11-03). 받는 중이면 기록만 먼저 */}
      {compareState === 'failed' && sessions.length > 0 && <StaleNotice text="최고 기록·이전 기록보다 오른 무게를 불러오지 못했어요." onRetry={onRetry} />}
      <Section
        title="운동 기록"
        count={truncated ? undefined : sessions.filter(isWorkout).length}
        action={
          onFind && (
            <button type="button" className="find-open" onClick={onFind} data-testid="find-exercise">
              <Icon name="search" /> 운동 찾기
            </button>
          )
        }
      >
        {kinds.length > 1 && (
          <div className="records-filter" role="group" aria-label="루틴별로 보기">
            {['all', ...kinds].map((k) => (
              <button key={k} type="button" aria-pressed={active === k} onClick={() => setFilter(k)}>
                {k === 'all' ? '전체' : kindLabel(k)}
              </button>
            ))}
          </div>
        )}
        {shown.length ? (
          <div className="workout-list records-weeks" ref={list}>
            {truncated && <p className="tiny">최근 {WORKOUT_LIMIT}개 기록이에요.</p>}
            {[...groups].map(([w, items]) => (
              <div key={w} className="records-group">
                <h4>
                  {weekLabel(w)} {!(truncated && w === oldest) && <span className="tiny">{items.filter(isWorkout).length}회</span>}
                </h4>
                {items.map((s) => (
                  <RecordRow key={s.id} s={s} cmp={compare ? (compare[s.id] ?? {}) : null} today={today} flash={flash === s.day} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <StatePanel kind="empty" title="아직 운동 기록이 없어요" description="운동을 시작해 실제로 한 세트를 남겨 보세요." />
        )}
      </Section>
    </>
  );
}
