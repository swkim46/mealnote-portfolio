// 트레이너 '회원' 탭의 회원별 하루 카드(2.1, 2026-11-03 사용자 확정 — design/diet-tab-20261103 시안):
// 그날 끼니 사진 네 칸(아침·점심·저녁·간식, 위 띠는 평가 색, 답할 질문은 '?'), 연속 일수, 미확인·답변 대기 수, 오늘 댓글 수.
// 오늘 기록이 없는 회원에게는 '기록 알림 보내기'(하루 한 번, 서버 nudge_member). 카드를 누르면 그 회원 화면.
// 카드 아래 바로 가기(2.3): 식단·루틴·운동 기록·인바디 칸으로 한 번에 — 사용자 요청 11-03 '회원 운동 기록·루틴에 쉽게 접근'.
// 근거: 문서/기획/식단탭_레퍼런스조사_261103.md (밀리그램 코칭 그룹 — 코치가 회원별 하루 카드로 여러 회원을 한 번에 훑음)
import { useState } from 'react';
import { MealImage } from './Bits';
import { ratingOf } from '../lib/rating';
import { dayTone, hasQuestion, needsTrainer } from '../lib/status';
import { MEAL_TYPES, type Meal } from '../lib/types';
import type { NudgeResult } from '../lib/api';
import type { WorkoutLine } from '../lib/workoutBrief';

const NUDGE_TEXT: Record<NudgeResult, string> = {
  sent: '기록 알림을 보냈어요.',
  already: '오늘은 이미 기록 알림을 보냈어요.',
  logged: '오늘 기록이 이미 있어요.',
  no_device: '회원이 알림을 켜지 않아서 보낼 수 없어요.',
  muted: '회원이 식단 기록 알림을 꺼 두어서 보내지 않았어요.',
  off: '지금은 알림을 보낼 수 없어요.',
};

/** 회원 화면 칸 */
export type MemberMode = 'meals' | 'routine' | 'records' | 'inbody';
const LINKS: [MemberMode, string][] = [['meals', '식단'], ['routine', '루틴'], ['records', '운동 기록'], ['inbody', '인바디']];

export function MemberDayCard({ member, meals, today, streak, mealsKnown = true, workout, records = 0, onOpen, onOpenMode, onNudge, onLogged, onMessage }: {
  member: { id: string; nickname: string };
  /** 이 회원의 받아 둔 식사(최근 것부터) */
  meals: Meal[];
  today: string;
  streak?: { current: number; today_logged: boolean };
  /** 식단을 받았는가. 모르면 기록 없음·기록 알림을 말하지 않는다 */
  mealsKnown?: boolean;
  /** 운동 줄(2.3). 아직 받지 못했으면 null */
  workout?: WorkoutLine | null;
  /** 운동 줄 기록의 최고 기록 수 */
  records?: number;
  onOpen: () => void;
  /** 회원 화면의 그 칸으로 바로 */
  onOpenMode: (mode: MemberMode) => void;
  onNudge: () => Promise<NudgeResult>;
  /** 서버가 '오늘 기록 있음'(logged)이라고 답했을 때 — 화면의 식사 목록이 옛것이므로 다시 받는다 */
  onLogged?: () => void;
  onMessage: (msg: string) => void;
}) {
  // 보냄 표시는 보낸 날에만 — 앱을 켜 둔 채 날이 바뀌면 다시 보낼 수 있다
  const [nudge, setNudge] = useState<{ state: 'idle' | 'sending' | 'done'; day: string }>({ state: 'idle', day: today });
  const nudgeState = nudge.day === today ? nudge.state : 'idle';
  const todays = meals.filter((m) => m.eaten_on === today);
  const pending = meals.filter(needsTrainer).length;
  const questions = meals.filter(hasQuestion).length;
  const comments = todays.reduce((n, m) => n + m.comments.length, 0);
  const send = async () => {
    if (nudgeState !== 'idle') return;
    setNudge({ state: 'sending', day: today });
    try {
      const r = await onNudge();
      onMessage(`${member.nickname} 회원: ${NUDGE_TEXT[r]}`);
      // 보냈거나 이미 보낸 날만 '보냄'. 그사이 기록이 생겼으면(logged) 목록을 다시 받아 카드가 오늘 기록으로 바뀐다
      setNudge({ state: r === 'sent' || r === 'already' ? 'done' : 'idle', day: today });
      if (r === 'logged') onLogged?.();
    } catch {
      onMessage('기록 알림을 보내지 못했어요. 잠시 후 다시 시도해 주세요.');
      setNudge({ state: 'idle', day: today });
    }
  };
  return (
    <div className={`member-day${todays.length || !mealsKnown ? '' : ' is-quiet'}`} data-testid="member-day" data-member={member.id}>
      <button type="button" className="member-row member-day-main" onClick={onOpen}>
        <span className="member-day-head">
          <span className="avatar">{member.nickname.slice(0, 1)}</span>
          <strong>{member.nickname} 회원</strong>
          {streak && streak.current > 0 && <span className="member-day-streak">{streak.today_logged ? `${streak.current}일 연속` : `어제까지 ${streak.current}일 연속`}</span>}
        </span>
        <span className="member-day-chips">
          <span className="status">{!mealsKnown ? '식단 확인 전' : todays.length ? `오늘 ${todays.length}끼` : '오늘 기록 없음'}</span>
          {pending > 0 && <span className="status pending">미확인 {pending}</span>}
          {questions > 0 && <span className="status question">답변 대기 {questions}</span>}
        </span>
        {mealsKnown && <span className="member-day-photos">
          {MEAL_TYPES.map((t) => {
            const mine = todays.filter((m) => m.meal_type === t).sort((a, b) => a.eaten_at.localeCompare(b.eaten_at));
            const m = mine[0];
            if (!m) {
              return (
                <span key={t} className="member-day-cell is-empty">
                  <small>{t}</small>
                </span>
              );
            }
            // 같은 끼니가 여럿이면 가장 낮은 평가 색(날짜 띠와 같은 규칙), 평가가 없으면 모두 확인했을 때만 확인 색
            const tone = mine.some((x) => ratingOf(x.rating)) ? dayTone(mine.filter((x) => ratingOf(x.rating))) : mine.every((x) => x.reviewed_at) ? 'seen' : 'wait';
            return (
              <span key={t} className="member-day-cell" aria-label={`${t} ${m.eaten_at.slice(0, 5)} ${m.food}`}>
                {m.photo_path ? <MealImage photo={{ mealId: m.id, path: m.photo_path }} /> : <span className="member-day-food">{m.food}</span>}
                <i className={`tone ${tone}`} />
                {mine.some(hasQuestion) && <span className="member-day-q">?</span>}
                <small>
                  {t} {m.eaten_at.slice(0, 5)}
                  {mine.length > 1 ? ` +${mine.length - 1}` : ''}
                </small>
              </span>
            );
          })}
        </span>}
        {workout && (
          <span className={`member-day-workout is-${workout.kind}`}>
            <i />
            <span>{workout.text}</span>
            {workout.kind === 'today' && records > 0 && <em className="record-pr">최고 {records}</em>}
          </span>
        )}
        {comments > 0 && <small className="member-day-foot">오늘 댓글 {comments}개</small>}
      </button>
      {mealsKnown && !todays.length && (
        <button type="button" className="secondary small member-day-nudge" disabled={nudgeState !== 'idle'} onClick={() => void send()}>
          {nudgeState === 'sending' ? '보내는 중…' : nudgeState === 'done' ? '오늘 알림 보냄' : '기록 알림 보내기'}
        </button>
      )}
      <div className="member-day-links" role="group" aria-label={`${member.nickname} 회원 바로 가기`}>
        {LINKS.map(([mode, text]) => (
          <button key={mode} type="button" onClick={() => onOpenMode(mode)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
