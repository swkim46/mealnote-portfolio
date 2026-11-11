// v2.0 이달의 식단왕·운동왕(커뮤니티 탭). 수상은 달이 끝난 뒤 확정한다(2026-10-29 사용자 결정).
//  - 2.3.2(시안 design/community-20261106 2안, 사용자 11-06): 첫 화면은 상마다 요약 한 줄, 누르면 그 상의 창이 열린다. 줄을 눌러 순위로 들어가는 방식은 Hevy를 따른다
//  - 가장 최근 수상자 줄은 다음 수상자가 나올 때까지 그대로 둔다
import { fetchAwardMonths, fetchAwardProgress, fetchAwards, fetchAwardStandings, fetchStrengthKings, type AwardKind, type AwardProgress, type AwardStandings } from '../lib/api';
import { monthLeftText, tieLabel } from '../lib/awards';
import { useLive } from '../lib/useLive';
import { sharedRequest } from '../lib/sharedRequest';
import { StaleNotice, StatePanel } from '../ui/kit';
import { Icon } from './Icon';
import { StrengthCard } from './StrengthKings';

export type AwardBoard = AwardKind | 'strength';

const KIND: Record<AwardKind, { title: string; unit: (s: number) => string }> = {
  rating: { title: '식단 평가왕', unit: (s) => `평가 평균 ${s.toFixed(1)}점` },
  streak: { title: '식단 꾸준왕', unit: (s) => `${s}일 연속 기록` },
  workout: { title: '운동왕', unit: (s) => `운동한 날 ${s}일` },
};
const ORDER: AwardKind[] = ['rating', 'streak', 'workout'];
/** 상의 창 아래에 두는 기준. 규칙 원본은 private.award_ranking */
const RULES: Record<AwardKind, string[]> = {
  rating: ['기록 10끼 이상, 평가받은 식사 10끼 이상', '평가 평균 1등. 같으면 기록한 날이 많은 회원, 그래도 같으면 공동'],
  streak: ['기록 10끼 이상', '그달 안에서 가장 길게 이어 기록한 회원. 같으면 기록한 날, 그래도 같으면 공동'],
  workout: ['운동한 날(완료한 세트나 유산소가 있는 날) 8일 이상', '운동한 날이 가장 많은 회원. 같으면 공동'],
};
/** 후보 조건(수상 기준과 같은 숫자 — 규칙 원본은 private.award_ranking) */
const MIN = { meals: 10, rated: 10, workoutDays: 8 };
const NEED: Record<AwardKind, string> = {
  rating: '식사 10끼 이상을 기록하고 10끼 이상 평가받으면 후보가 돼요.',
  streak: '식사를 10끼 이상 기록하면 후보가 돼요.',
  workout: '8일 이상 운동하면 후보가 돼요.',
};
/** 후보까지 남은 양. 내 숫자를 받지 못했으면 조건만 말한다 */
function needText(kind: AwardKind, p: AwardProgress | null | undefined) {
  if (!p) return NEED[kind];
  const left = (min: number, have: number) => Math.max(0, min - have);
  const meals = left(MIN.meals, p.meals), rated = left(MIN.rated, p.rated), days = left(MIN.workoutDays, p.workout_days);
  const parts = kind === 'workout' ? [days > 0 && `운동 ${days}일`] : [meals > 0 && `식사 기록 ${meals}끼`, kind === 'rating' && rated > 0 && `식단 평가 ${rated}끼`];
  const text = parts.filter(Boolean).join('·');
  return text ? `후보까지 ${text} 남았어요.` : NEED[kind];
}

export const prevMonth = (today: string) => {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`;
const nextMonth = (month: string) => {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/** 한 달의 수상 결과 */
export function AwardsCard({ month, testId = 'awards' }: { month: string; testId?: string }) {
  const live = useLive(`awards-${month}`, '', () => fetchAwards(month));
  const a = live.value;
  const groups = ORDER.map((k) => ({ kind: k, list: (a?.winners ?? []).filter((w) => w.kind === k) })).filter((g) => g.list.length);
  return (
    <section className="award-month" aria-label={`${monthLabel(month)}의 식단왕·운동왕`} data-testid={testId}>
      <h3>{monthLabel(month)}</h3>
      {a && live.failed && <StaleNotice text="최신 수상 결과를 불러오지 못했어요." onRetry={live.reload} />}
      {!a ? (
        live.failed ? (
          <StatePanel kind="failed" title="수상 결과를 불러오지 못했어요" onRetry={live.reload} />
        ) : (
          <StatePanel kind="loading" />
        )
      ) : !a.started ? (
        <p className="tiny" data-testid="awards-not-started">
          식단왕·운동왕은 {monthLabel(a.starts)} 기록부터 뽑아요. {monthLabel(a.starts)} 결과는 {monthLabel(nextMonth(a.starts))} 1일 오전 9시에 공개돼요.
        </p>
      ) : !a.published ? (
        <p className="tiny">지난달 결과를 집계하고 있어요. 1일 오전 9시 뒤에 보여요.</p>
      ) : groups.length ? (
        groups.map((g) => (
          <div key={g.kind} className="award-win">
            <span>{KIND[g.kind].title}</span>
            <strong>{tieLabel(g.list)}</strong>
            <small>{KIND[g.kind].unit(g.list[0].score)}</small>
          </div>
        ))
      ) : (
        <p className="tiny">이 달은 수상 조건을 채운 회원이 없었어요.</p>
      )}
    </section>
  );
}

/** 첫 화면의 상 한 줄 값: 1위와 내 순위 */
function standingSummary(kind: AwardKind, s: AwardStandings, member: boolean) {
  if (!s.started) return `${monthLabel(s.starts)}부터`;
  if (kind === 'workout' && !s.workout_started) return `${monthLabel(s.workout_starts)}부터`;
  const rows = s.rows.filter((r) => r.kind === kind);
  if (!rows.length) return '아직 없어요';
  const first = Math.min(...rows.map((r) => r.rank));
  const me = member ? rows.find((r) => r.is_me) : undefined;
  if (me?.rank === first) return <em>나 {first}위</em>;
  return (
    <>
      {tieLabel(rows.filter((r) => r.rank === first))}
      {me && (
        <>
          {' · '}
          <em>나 {me.rank}위</em>
        </>
      )}
    </>
  );
}

function BoardRow({ title, value, onOpen, testId }: { title: string; value?: React.ReactNode; onOpen: () => void; testId?: string }) {
  return (
    <button type="button" className="community-row" data-testid={testId} onClick={onOpen}>
      <b>{title}</b>
      <small>{value}</small>
      <Icon name="right" />
    </button>
  );
}

/** 가장 최근 수상자 한 줄. 다음 수상자가 나올 때까지 그대로 둔다(사용자 11-06) */
function LatestWinners({ today, onHistory }: { today: string; onHistory: () => void }) {
  const live = useLive('award-latest', today, async () => {
    for (const month of (await fetchAwardMonths()).sort().reverse()) {
      const a = await fetchAwards(month);
      if (a.published && a.winners.length) return a;
    }
    return null;
  });
  const a = live.value;
  // 한 사람이 여럿 받으면 한 번만 센다. 익명 회원은 이름으로 가를 수 없어 상마다 센다
  const names = a ? [...new Map(a.winners.map((w, i) => [w.nickname === '익명 회원' ? i : w.nickname, w])).values()] : [];
  return (
    <div className="community-card" data-testid="awards">
      <BoardRow title={a ? `${monthLabel(a.month)} 수상자` : '지난 수상'} value={a ? tieLabel(names) : live.failedNow ? '불러오지 못했어요' : a === null ? '아직 없어요' : ''} onOpen={onHistory} />
    </div>
  );
}

/**
 * 커뮤니티의 수상 칸: 이번 달 상마다 한 줄 · 가장 최근 수상자 한 줄. 줄을 누르면 창이 열린다.
 * version: 집계에 쓰는 식사가 바뀌었다는 신호(식사 id·날짜·평가) — 이 탭에서 알림으로 식사를 열어 평가해도 바로 다시 받는다(Codex v2.0.0 정식 1차 리뷰 1)
 */
export function AwardsSection({ today, member, version, onBoard, onHistory }: { today: string; member: boolean; version: string; onBoard: (b: AwardBoard) => void; onHistory: () => void }) {
  const live = useLive(`standings-${today}`, version, () => sharedRequest(`standings:${today}:${version}`, () => fetchAwardStandings(today)));
  const month = `${today.slice(0, 7)}-01`;
  const strength = useLive(`strength-${month}-${today}`, version, () => sharedRequest(`strength:${month}:${today}`, () => fetchStrengthKings(month, today)));
  const s = live.value;
  const best = [...(strength.value?.mine ?? [])].sort((a, b) => a.kg_rank - b.kg_rank)[0];
  return (
    <>
      <section aria-label="이번 달 순위" data-testid="award-standings">
        <div className="community-title">
          <strong>{monthLabel(today)} 순위</strong>
          <span>{monthLeftText(today)}</span>
        </div>
        {s && live.failed && <StaleNotice text="최신 순위를 불러오지 못했어요. 이전 순위를 보여 드려요." onRetry={live.reload} />}
        {!s && (live.failed ? <StatePanel kind="failed" title="현재 순위를 불러오지 못했어요" onRetry={live.reload} /> : <StatePanel kind="loading" />)}
        <div className="community-card">
          {s && ORDER.map((k) => <BoardRow key={k} testId={`standing-${k}`} title={KIND[k].title} value={standingSummary(k, s, member)} onOpen={() => onBoard(k)} />)}
          {/* 중량왕은 조회가 따로라 순위가 실패해도 들어갈 수 있다 */}
          <BoardRow testId="standing-strength" title="중량왕" value={member && best ? <em>나 {best.lift} {best.kg_rank}위</em> : '동작별 보기'} onOpen={() => onBoard('strength')} />
        </div>
      </section>
      <LatestWinners today={today} onHistory={onHistory} />
    </>
  );
}

/** 상 하나의 창: 3위까지(공동은 한 줄) · 3위 밖이면 내 행 · 후보까지 남은 양 · 기준 */
function StandingBoard({ kind, today, member, version }: { kind: AwardKind; today: string; member: boolean; version: string }) {
  const live = useLive(`standings-${today}`, version, () => sharedRequest(`standings:${today}:${version}`, () => fetchAwardStandings(today)));
  const progress = useLive(`progress-${today}-${member}`, version, () => (member ? fetchAwardProgress(today) : Promise.resolve(null)));
  const s = live.value;
  const rows = s?.rows.filter((r) => r.kind === kind) ?? [];
  const top = rows.filter((r) => r.rank <= 3);
  const me = rows.find((r) => r.is_me);
  const ranks = [...new Set(top.map((r) => r.rank))].sort((a, b) => a - b);
  const waiting = kind === 'workout' && !!s && !s.workout_started;
  return (
    <div className="standing" data-testid={`board-${kind}`}>
      <p className="tiny">
        {monthLabel(today)} 현재 순위 · {monthLeftText(today)}
      </p>
      {s && live.failed && <StaleNotice text="최신 순위를 불러오지 못했어요. 이전 순위를 보여 드려요." onRetry={live.reload} />}
      {!s ? (
        live.failed ? (
          <StatePanel kind="failed" title="현재 순위를 불러오지 못했어요" onRetry={live.reload} />
        ) : (
          <StatePanel kind="loading" />
        )
      ) : !s.started ? (
        <p className="tiny">{monthLabel(s.starts)} 기록부터 순위를 매겨요.</p>
      ) : waiting ? (
        <p className="tiny">{monthLabel(s.workout_starts)} 기록부터 순위를 매겨요.</p>
      ) : (
        <>
          {top.length ? (
            <ol>
              {ranks.map((n) => {
                const g = top.filter((r) => r.rank === n);
                return (
                  <li key={n} className={g.some((r) => r.is_me) ? 'me' : undefined}>
                    <span className="standing-rank">{n}위</span>
                    <span className="standing-names">
                      {tieLabel(g)}
                      {!g[0].qualified && <em className="standing-pre">조건 미달</em>}
                    </span>
                    <small>{KIND[kind].unit(g[0].score)}</small>
                  </li>
                );
              })}
              {member && me && me.rank > 3 && (
                <li className="me">
                  <span className="standing-rank">{me.rank}위</span>
                  <span className="standing-names">
                    {tieLabel([me])}
                    {!me.qualified && <em className="standing-pre">조건 미달</em>}
                  </span>
                  <small>{KIND[kind].unit(me.score)}</small>
                </li>
              )}
            </ol>
          ) : (
            <p className="tiny">아직 기록한 회원이 없어요.</p>
          )}
          {member && !me?.qualified && (
            <>
              {progress.failedNow && <StaleNotice text="남은 조건을 불러오지 못했어요." onRetry={progress.reload} />}
              <p className="standing-need" data-testid={`need-${kind}`}>
                {needText(kind, progress.value)}
              </p>
            </>
          )}
        </>
      )}
      <ul className="award-rules">
        {RULES[kind].map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>후보 조건을 채운 회원부터 순위를 매기고, 후보 중 1위가 수상해요.</li>
        <li>달이 끝나면 다음 달 1일 오전 9시에 확정돼요.</li>
      </ul>
    </div>
  );
}

/** 첫 화면의 줄을 눌러 여는 창 */
export function AwardBoardView({ board, today, member, version }: { board: AwardBoard; today: string; member: boolean; version: string }) {
  if (board === 'strength') return <StrengthCard month={`${today.slice(0, 7)}-01`} today={today} />;
  return <StandingBoard kind={board} today={today} member={member} version={version} />;
}

export const boardTitle = (board: AwardBoard, today: string) => (board === 'strength' ? `${monthLabel(today)} 중량왕` : KIND[board].title);

/** 지난 수상: 최근 달부터. 같은 트레이너의 회원끼리 견주고, 한 사람이 여럿 받을 수 있다 */
export function AwardHistory({ today }: { today: string }) {
  const live = useLive('award-months', '', fetchAwardMonths);
  const months = live.value;
  const last = prevMonth(today);
  const list = months ? [...new Set([last, ...months])].sort().reverse() : null;
  return (
    <div className="award-history" data-testid="award-history">
      {list && live.failed && <StaleNotice text="지난 수상 목록을 새로 불러오지 못했어요." onRetry={live.reload} />}
      {list ? list.map((m) => <AwardsCard key={m} month={m} testId={`awards-${m}`} />) : live.failed ? <StatePanel kind="failed" title="지난 수상을 불러오지 못했어요" onRetry={live.reload} /> : <StatePanel kind="loading" />}
      <StrengthCard month={last} today={today} testId="strength-last" past />
      <p className="tiny">같은 트레이너의 회원끼리 견줘요. 한 사람이 여럿 받을 수 있어요.</p>
    </div>
  );
}
