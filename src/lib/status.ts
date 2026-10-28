// 와이어프레임(app.js 43~46행)의 상태 규칙을 옮기고,
// 식단 등록 때 남긴 말(note)을 대화의 첫 메시지로 다룬다(2026-10-21 사용자 피드백:
// "등록할 때 남긴 질문이 작게 보여서 트레이너가 놓친다").
import type { Comment, Meal } from './types';

export const NOTE_ID = 'note';

/**
 * 대화 전체: 등록 때 남긴 말 + 댓글, 시각 순.
 * 한마디의 시각은 마지막으로 고친 시각(note_updated_at)이다. Codex 리뷰 P2(5): 처음 등록 시각을 쓰면
 * 확인 뒤 한마디를 질문으로 고쳐도 '확인보다 과거 메시지'가 되어 답변 대기에 안 올라왔다.
 */
export function thread(m: Meal): Comment[] {
  const note = m.note.trim();
  if (!note) return m.comments;
  const noteMsg: Comment = { id: NOTE_ID, meal_id: m.id, author_role: 'member', body: note, created_at: m.note_updated_at || m.created_at };
  return [noteMsg, ...m.comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** 한마디를 등록 뒤에 고쳤는가(1분 넘게 차이) */
export const noteEdited = (m: Meal) => Date.parse(m.note_updated_at) - Date.parse(m.created_at) > 60_000;

export const lastTrainerComment = (m: Meal) =>
  [...m.comments].reverse().find((c) => c.author_role === 'trainer');

/**
 * 트레이너 답을 기다리는 회원 메시지.
 * 대화의 마지막이 회원 메시지이고, 트레이너가 그 뒤에 확인(확인 완료·답변 없이 확인)하지 않았을 때.
 * 2026-10-21: "감사합니다" 같은 말에도 답을 달아야 목록에서 빠지는 게 불편하다는 피드백으로
 * 트레이너가 답 없이 확인할 수 있게 했다(방안 A). 확인 뒤 새 메시지가 오면 다시 대기로 올라온다.
 */
export function pendingQuestion(m: Meal): Comment | null {
  const t = thread(m);
  const last = t[t.length - 1];
  if (!last || last.author_role !== 'member') return null;
  if (m.reviewed_at && Date.parse(m.reviewed_at) >= Date.parse(last.created_at)) return null;
  return last;
}

export const hasQuestion = (m: Meal) => pendingQuestion(m) !== null;

/** 트레이너가 처리해야 하는 식사: 아직 확인 안 했거나 답할 말이 남아 있음 */
export const needsTrainer = (m: Meal) => !m.reviewed_at || hasQuestion(m);

/** 회원에게 보일 트레이너 반응(댓글이나 평가)이 있음 */
export const hasTrainerFeedback = (m: Meal) => !!lastTrainerComment(m) || !!m.rating;

/** 회원이 아직 읽지 않은 트레이너 피드백(댓글·평가)이 있음 */
export const hasNewFeedback = (m: Meal) => {
  const c = lastTrainerComment(m);
  const seen = Date.parse(m.member_seen_at);
  return (!!c && Date.parse(c.created_at) > seen) || (!!m.rated_at && Date.parse(m.rated_at) > seen);
};

export function statusOf(m: Meal): { cls: string; label: string } {
  if (hasQuestion(m)) return { cls: 'question', label: '답변 대기' };
  if (!m.reviewed_at) return { cls: 'pending', label: '확인 대기' };
  if (lastTrainerComment(m) || m.rating) return { cls: '', label: '피드백 완료' };
  return { cls: '', label: '확인 완료' };
}
