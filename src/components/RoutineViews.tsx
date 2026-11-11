// 운동 탭 '루틴'(2.1, 2026-11-03 사용자 확정 — design/workout-tab-20261103 시안 4):
//  - 루틴 요약(이름·판·시트 탭·목표·바꾼 이유·필수 동작)
//  - 루틴이 바뀌었으면 '루틴이 바뀌었어요' 칸: 새 루틴을 한 바퀴(루틴마다 한 번씩) 돌기 전에는 루틴 카드 위, 돈 뒤에는 아래로 내려가 접힌다.
//    한 루틴에 4건 넘게 바뀌면 그 루틴은 숫자만 보이고 눌러 펼친다. 루틴 카드에는 지금 루틴만(바뀐 점 표시 없음)
//  - 루틴 카드: 가로로 넘기고, 보이는 카드가 아래 '운동 시작' 버튼의 루틴이 된다(처음엔 루틴 1). 마지막으로 한 날 표시
// 근거: 문서/기획/운동탭_레퍼런스조사_261103.md (JEFIT 주간 요약·Hevy 다음 운동·Strong 템플릿 카드)
import { useEffect, useRef, useState } from 'react';
import { prettyDay } from '../lib/dates';
import { focusOf, goalLine } from '../lib/routineText';
import { dayNos, lastDoneDay, routineCycle, routineDiff, versionDay, type DiffRow, type RoutineProgress } from '../lib/workoutStats';
import type { ExerciseMemo, Routine } from '../lib/api';
import { memoPair } from '../lib/exercise';
import { Icon } from './Icon';

/**
 * 루틴 카드의 동작별 메모(2.4 — 운동 아래 두 줄까지). viewer가 보는 이름: 회원은 트레이너·내 메모, 트레이너는 내 메모·회원 메모.
 * onWrite가 있으면(트레이너) 자기 칸이 없는 운동에 '메모 추가', 있으면 눌러 고친다
 */
export type RoutineMemos = { memos: ExerciseMemo[] | undefined; viewer: 'member' | 'trainer'; onWrite?: (name: string) => void };
function ItemMemos({ name, m }: { name: string; m: RoutineMemos }) {
  if (!m.memos) return null;
  const pair = memoPair(m.memos, name);
  const own = m.viewer === 'member' ? pair.member : pair.trainer;
  const other = m.viewer === 'member' ? pair.trainer : pair.member;
  const line = (memo: ExerciseMemo) => (
    <>
      <b>{memo.author === m.viewer ? '내 메모' : memo.author === 'trainer' ? '트레이너' : '회원 메모'}</b>
      {memo.body}
    </>
  );
  return (
    <>
      {other && <span className={`routine-memo${other.author === 'trainer' ? ' is-coach' : ''}`}>{line(other)}</span>}
      {own &&
        (m.onWrite ? (
          <button type="button" className={`routine-memo${own.author === 'trainer' ? ' is-coach' : ''}`} aria-label={`${name} 내 메모 고치기`} onClick={() => m.onWrite?.(name)}>
            {line(own)}
          </button>
        ) : (
          <span className={`routine-memo${own.author === 'trainer' ? ' is-coach' : ''}`}>{line(own)}</span>
        ))}
      {!own && m.onWrite && (
        <button type="button" className="text-button routine-memo-add" aria-label={`${name} 메모 추가`} onClick={() => m.onWrite?.(name)}>
          <Icon name="plus" /> 메모 추가
        </button>
      )}
    </>
  );
}

/** 루틴 요약 칸 */
export function RoutineSummary({ routine }: { routine: Routine }) {
  return (
    <section className="routine-card" aria-label="루틴" data-testid="routine-card">
      <div className="routine-summary">
        <div className="routine-head">
          <strong>{routine.title}</strong>
          <span className="tiny">
            {routine.version}번째 버전 · {prettyDay(versionDay(routine))}
            {routine.source === 'sheet' && routine.source_ref && ` · 시트 ${routine.source_ref} 탭`}
          </span>
        </div>
        {(routine.goal || routine.reason) && (
          <div className="routine-note">
            {routine.goal && (
              <p>
                <b>이번 목표</b> {routine.goal}
              </p>
            )}
            {routine.reason && (
              <p>
                <b>바꾼 이유</b> {routine.reason}
              </p>
            )}
          </div>
        )}
        {routine.warmup && (
          <details className="routine-warmup">
            <summary>본 운동 전 필수 동작</summary>
            <p>{routine.warmup}</p>
          </details>
        )}
      </div>
    </section>
  );
}

/** 한 루틴에 이보다 많이 바뀌면 숫자만 보이고 눌러 펼친다(사용자 결정 11-03) */
const FOLD_OVER = 4;
const MARK: Record<DiffRow['kind'], string> = { del: '−', add: '+', chg: '↑' };
const TAG: Record<DiffRow['kind'], string> = { del: '빠짐', add: '새로', chg: '목표' };

/** 루틴이 바뀐 점. 새 루틴을 한 바퀴 돌기 전(place='top')에는 펼쳐서, 돈 뒤(place='bottom')에는 접어서 */
export function RoutineUpdate({ current, previous, progress, place }: { current: Routine; previous: Routine; progress: RoutineProgress; place: 'top' | 'bottom' }) {
  const rows = routineDiff(current, previous);
  const [openDays, setOpenDays] = useState<number[]>([]);
  const [openAll, setOpenAll] = useState(false);
  if (!rows.length) return null;
  const cycle = routineCycle(current, progress);
  const count = (k: DiffRow['kind']) => rows.filter((r) => r.kind === k).length;
  const multi = dayNos(current.items).length > 1 || dayNos(previous.items).length > 1;
  const days = [...new Set(rows.map((r) => r.day_no))].sort((a, b) => a - b);
  const span = `${previous.title} → ${current.title} · ${prettyDay(versionDay(current))}`;
  const chips = (
    <div className="update-chips">
      {count('add') > 0 && <span className="add">새 운동 {count('add')}</span>}
      {count('del') > 0 && <span className="del">빠진 운동 {count('del')}</span>}
      {count('chg') > 0 && <span className="chg">목표 바뀜 {count('chg')}</span>}
    </div>
  );
  const perDay = days.map((d) => {
    const mine = rows.filter((r) => r.day_no === d);
    const folded = mine.length > FOLD_OVER && !openDays.includes(d);
    const n = (k: DiffRow['kind']) => mine.filter((r) => r.kind === k).length;
    return (
      <div key={d} className="update-day" data-testid={`update-day-${d}`}>
        {multi && <h5>루틴 {d}{focusOf(current.items, d) && ` · ${focusOf(current.items, d)}`}</h5>}
        {folded ? (
          <button type="button" className="update-fold" onClick={() => setOpenDays((v) => [...v, d])}>
            <b>{[n('del') && `빠짐 ${n('del')}`, n('add') && `새로 ${n('add')}`, n('chg') && `목표 ${n('chg')}`].filter(Boolean).join(' · ')}</b>
            <span>펼치기</span>
          </button>
        ) : (
          <ul className="update-list">
            {mine.map((r) => (
              <li key={r.key} className={r.kind}>
                <i aria-hidden="true">{MARK[r.kind]}</i>
                <span>
                  {r.name}
                  <small>{r.detail}</small>
                </span>
                <em>{TAG[r.kind]}</em>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  });
  if (place === 'bottom')
    return (
      <section className="update-card is-past" aria-label="지난 루틴 업데이트" data-testid="routine-update">
        <div className="update-head">
          <strong>지난 루틴 업데이트</strong>
          <span className="tiny">{span}</span>
        </div>
        {chips}
        {openAll ? (
          perDay
        ) : (
          <button type="button" className="update-fold" onClick={() => setOpenAll(true)}>
            <b>바뀐 운동 {rows.length}개 보기</b>
            <span>펼치기</span>
          </button>
        )}
      </section>
    );
  return (
    <section className="update-card" aria-label="루틴이 바뀌었어요" data-testid="routine-update">
      <div className="update-head">
        <strong>루틴이 바뀌었어요</strong>
        <span className="tiny">
          {span}에 바뀜 · 바뀐 운동 {rows.length}개
        </span>
      </div>
      {chips}
      {cycle.days.length > 1 && (
        <div className="update-cycle">
          <b>새 루틴 한 바퀴</b>
          <span className="update-steps">
            {cycle.days.map((d) => (
              <i key={d} className={cycle.done.has(d) ? 'on' : ''}>
                루틴 {d}
                {cycle.done.has(d) ? ' ✓' : progress.checking ? ' · 확인 중' : ''}
              </i>
            ))}
          </span>
          <small>루틴을 한 번씩 하면 이 안내는 루틴 카드 아래로 내려가요</small>
        </div>
      )}
      {perDay}
    </section>
  );
}

/** 루틴 카드(가로로 넘김). onShow = 지금 보이는 카드의 루틴 번호 */
export function RoutineCarousel({ routine, progress, onShow, memos }: { routine: Routine; progress: RoutineProgress; onShow?: (day: number) => void; memos?: RoutineMemos }) {
  const days = dayNos(routine.items);
  const track = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(days[0] ?? 1);
  // 판이 바뀌면 처음 카드로(루틴 1부터 — 사용자 결정 11-03)
  useEffect(() => {
    setShown(days[0] ?? 1);
    track.current?.scrollTo?.({ left: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine.id]);
  useEffect(() => {
    onShow?.(shown);
  }, [shown, onShow]);
  // 보이는 카드: 왼쪽 끝이 스크롤 위치에 가장 가까운 카드
  const onScroll = () => {
    const el = track.current;
    if (!el) return;
    const cards = [...el.children] as HTMLElement[];
    const left = el.scrollLeft + cards[0]?.offsetLeft;
    let best = 0;
    cards.forEach((c, i) => {
      if (Math.abs(c.offsetLeft - left) < Math.abs(cards[best].offsetLeft - left)) best = i;
    });
    if (days[best] !== undefined && days[best] !== shown) setShown(days[best]);
  };
  const card = (d: number) => {
    const items = routine.items.filter((i) => i.day_no === d);
    const last = lastDoneDay(progress, d);
    const sets = items.reduce((s, i) => s + (i.sets ?? 0), 0);
    return (
      <article key={d} className="routine-slide" aria-label={days.length > 1 ? `루틴 ${d}` : '운동 목록'} data-testid={`routine-day-${d}`}>
        <header className="routine-slide-head">
          <span className="routine-slide-day">{days.length > 1 ? `루틴 ${d}` : '운동 목록'}</span>
          {focusOf(routine.items, d) && <span className="routine-slide-focus">{focusOf(routine.items, d)}</span>}
        </header>
        <p className="routine-slide-meta">
          <b>
            운동 {items.length}개{sets ? ` · ${sets}세트` : ''}
          </b>
          {` · ${last ? `마지막 ${prettyDay(last)}` : progress.checking ? '확인 중' : '아직 안 함'}`}
        </p>
        <ul className="routine-items">
          {items.map((i) => (
            <li key={i.id}>
              <span>
                <strong>{i.name}</strong>
                {goalLine(i) && <small>{goalLine(i)}</small>}
                {memos && <ItemMemos name={i.name} m={memos} />}
              </span>
              {i.sets && <span className="tiny">{i.sets}세트</span>}
            </li>
          ))}
        </ul>
      </article>
    );
  };
  if (days.length <= 1) return <div className="routine-slides is-single">{days.map(card)}</div>;
  return (
    <div className="routine-slides">
      <div className="routine-slides-label">
        <strong>루틴 {days.length}개</strong>
        <span className="routine-dots" aria-hidden="true">
          {days.map((d) => (
            <i key={d} className={d === shown ? 'on' : ''} />
          ))}
          <span className="tiny">옆으로 넘겨 보기</span>
        </span>
      </div>
      <div className="routine-track" ref={track} onScroll={onScroll} data-testid="routine-track">
        {days.map(card)}
      </div>
    </div>
  );
}

/** 루틴 탭 본문: 요약 → (한 바퀴 전) 바뀐 점 → 루틴 카드 → (한 바퀴 뒤) 지난 업데이트. progress = progressOf(기록 창과 같은 값) */
export function RoutineTab({ routine, previous, progress, onShow, memos }: { routine: Routine; previous: Routine | null; progress: RoutineProgress; onShow?: (day: number) => void; memos?: RoutineMemos }) {
  const cycled = routineCycle(routine, progress).complete;
  return (
    <>
      <RoutineSummary routine={routine} />
      {previous && !cycled && <RoutineUpdate key={routine.id} current={routine} previous={previous} progress={progress} place="top" />}
      <RoutineCarousel routine={routine} progress={progress} onShow={onShow} memos={memos} />
      {previous && cycled && <RoutineUpdate key={`${routine.id}-past`} current={routine} previous={previous} progress={progress} place="bottom" />}
    </>
  );
}
