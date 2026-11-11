// 트레이너 한마디 모아 보기(2.3 — 트레이너 의견 2026-11-04): 커뮤니티에 최신 글 한 줄, 누르면 달별 전체 목록(2.3.2 시안 design/community-20261106).
// '운동 꿀팁'으로 표시한 한마디만 골라 볼 수 있다. 오늘의 기본 문구(트레이너가 쓰지 않은 날)는 넣지 않는다.
import { useState } from 'react';
import { fetchTrainerMessages, type TrainerMessage } from '../lib/api';
import { prettyDay } from '../lib/dates';
import { useLive } from '../lib/useLive';
import { StaleNotice, StatePanel } from '../ui/kit';
import { Icon } from './Icon';

function Word({ w, today }: { w: TrainerMessage; today: string }) {
  return (
    <div className="trainer-word">
      <small>{w.day === today ? `오늘 · ${prettyDay(w.day)}` : prettyDay(w.day)}</small>
      <p>
        {w.is_tip && <span className="word-tag">운동 꿀팁</span>}
        {w.body}
      </p>
    </div>
  );
}

/** 커뮤니티 한 줄: 최신 글 하나, 누르면 모아 보기. 쓴 한마디가 없으면 보이지 않는다. past: 트레이너는 오늘 글을 위 칸에서 보므로 글 없이 줄만 둔다 */
export function TrainerWordsCard({ today, version = 0, past = false, onAll }: { today: string; version?: number; past?: boolean; onAll: () => void }) {
  const live = useLive('trainer-words', `${today}|${version}`, () => fetchTrainerMessages(today, 1));
  const list = live.value ?? [];
  if (!live.value && live.failed) return <StatePanel kind="failed" title="한마디를 불러오지 못했어요" onRetry={live.reload} />;
  if (!list.length) return null;
  return (
    <section className="community-card" aria-label="트레이너 한마디" data-testid="trainer-words">
      <button type="button" className="community-word" onClick={onAll}>
        <span>
          <b>{past ? '지난 한마디' : '트레이너 한마디'}</b>
          {!past && <span>{list[0].body}</span>}
        </span>
        <Icon name="right" />
      </button>
      {live.failed && <StaleNotice text="최신 한마디를 불러오지 못했어요." onRetry={live.reload} />}
    </section>
  );
}

/** 모두 보기 창: 달별 목록 · 운동 꿀팁만 골라 보기 */
export function TrainerWordsList({ today }: { today: string }) {
  const live = useLive('trainer-words-all', today, () => fetchTrainerMessages(today));
  const [tips, setTips] = useState(false);
  if (!live.value) return live.failed ? <StatePanel kind="failed" title="한마디를 불러오지 못했어요" onRetry={live.reload} /> : <StatePanel kind="loading" />;
  const list = live.value;
  const tipCount = list.filter((w) => w.is_tip).length;
  const shown = tips ? list.filter((w) => w.is_tip) : list;
  // 끝까지 받으면 1년 넘은 글도 있어 같은 달 이름이 둘 생긴다
  const manyYears = new Set(list.map((w) => w.day.slice(0, 4))).size > 1;
  const monthLabel = (month: string) => `${manyYears ? `${month.slice(0, 4)}년 ` : ''}${Number(month.slice(5))}월`;
  const months = new Map<string, TrainerMessage[]>();
  for (const w of shown) months.set(w.day.slice(0, 7), [...(months.get(w.day.slice(0, 7)) ?? []), w]);
  return (
    <div className="trainer-words-all" data-testid="trainer-words-all">
      {live.failed && <StaleNotice text="최신 한마디를 불러오지 못했어요." onRetry={live.reload} />}
      <div className="records-filter" role="group" aria-label="한마디 골라 보기">
        <button type="button" aria-pressed={!tips} onClick={() => setTips(false)}>
          전체 {list.length}
        </button>
        <button type="button" aria-pressed={tips} onClick={() => setTips(true)}>
          운동 꿀팁 {tipCount}
        </button>
      </div>
      {[...months].map(([month, words]) => (
        <section key={month} aria-label={monthLabel(month)}>
          <h3>{monthLabel(month)}</h3>
          <div className="trainer-words-list">
            {words.map((w) => (
              <Word key={w.day} w={w} today={today} />
            ))}
          </div>
        </section>
      ))}
      {!shown.length && <p className="tiny">{tips ? '아직 등록된 운동 꿀팁이 없어요.' : '아직 올라온 한마디가 없어요.'}</p>}
    </div>
  );
}
