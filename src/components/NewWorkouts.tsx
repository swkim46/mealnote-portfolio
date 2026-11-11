// 트레이너 확인 탭의 새 운동 기록(2.3 — 시안 design/v23-20261105). 회원이 새로 남긴 기록을 맨 위에 모아 보이고, 누르면 그 기록을 연다.
import { useState } from 'react';
import type { WorkoutSession } from '../lib/api';
import { sessionDetail, sessionWhen } from '../lib/workoutBrief';

const SHOW = 5;

export function NewWorkouts({ sessions, nameOf, records, recordsMissed, today, onOpen, onSeen }: {
  sessions: WorkoutSession[];
  nameOf: (memberId: string) => string;
  records: (s: WorkoutSession) => number;
  /** 최고 기록 비교를 받지 못함: 최고 표시가 없다고 최고 기록이 없는 것은 아니다 */
  recordsMissed: boolean;
  today: string;
  onOpen: (s: WorkoutSession) => void;
  onSeen: () => void;
}) {
  const [all, setAll] = useState(false);
  if (!sessions.length) return null;
  const shown = all ? sessions : sessions.slice(0, SHOW);
  const hidden = sessions.length - shown.length;
  return (
    <section className="new-workouts" aria-label="새 운동 기록" data-testid="new-workouts">
      <div className="new-workouts-head">
        <strong>새 운동 기록</strong>
        <span>{sessions.length}</span>
        {/* 모두 봤어요는 전체에 적용된다 — 숨은 기록이 있으면 펼친 뒤에 누른다 */}
        {!hidden && (
          <button type="button" className="text-button" onClick={onSeen}>
            모두 봤어요
          </button>
        )}
      </div>
      {shown.map((s) => {
        const name = nameOf(s.member_id);
        const n = records(s);
        return (
          <button key={s.id} type="button" className="new-workout" onClick={() => onOpen(s)}>
            <span className="avatar">{name.slice(0, 1)}</span>
            <span className="new-workout-main">
              <b>
                {name} 회원
                {n > 0 && <em className="record-pr">최고 {n}</em>}
              </b>
              <small>{sessionDetail(s)}</small>
            </span>
            <time>{sessionWhen(s, today)}</time>
          </button>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="text-button new-workouts-more" onClick={() => setAll(true)}>
          외 {hidden}개 더 보기
        </button>
      )}
      {recordsMissed && <p className="tiny">최고 기록 여부를 확인하지 못했어요.</p>}
    </section>
  );
}
