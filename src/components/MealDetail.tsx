import { useRef, useState, type FormEvent } from 'react';
import { Icon } from './Icon';
import { RatingButtons, RatingChip, StatusTag } from './Bits';
import type { Rating } from '../lib/rating';
import { prettyDay, relativeTime } from '../lib/dates';
import { NOTE_ID, needsTrainer, noteEdited, pendingQuestion, thread } from '../lib/status';
import type { Meal, Role } from '../lib/types';

interface Props {
  meal: Meal;
  role: Role;
  photoUrl?: string;
  trainerName: string;
  onComment: (body: string) => Promise<boolean>;
  onReview?: () => Promise<void>;
  /** 트레이너: 식단 평가 */
  onRate?: (r: Rating) => Promise<void>;
  onEdit?: () => void;
  onDelete?: () => Promise<void>;
}

export function MealDetail({ meal, role, photoUrl, trainerName, onComment, onReview, onRate, onEdit, onDelete }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const coach = role === 'trainer';
  const pending = needsTrainer(meal);
  const question = pendingQuestion(meal);
  const messages = thread(meal);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const focusReply = () => {
    replyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    replyRef.current?.focus({ preventScroll: true });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await onComment(body);
    setSending(false);
    if (ok) setText('');
  }

  return (
    <>
      {coach && question && (
        <div className="question-callout">
          <div className="question-callout-head">
            <strong>{question.id === NOTE_ID ? '식단을 올리며 남긴 말' : '답변을 기다리는 질문'}</strong>
            <span>{relativeTime(question.created_at)}</span>
          </div>
          <p>{question.body}</p>
          <div className="question-actions">
            <button className="question-reply" onClick={focusReply}>
              답변 쓰기 <Icon name="right" />
            </button>
            {onReview && (
              <button className="question-ack" onClick={() => void onReview()}>
                <Icon name="check" /> 답변 없이 확인
              </button>
            )}
          </div>
        </div>
      )}
      {coach && onRate && (
        <section className="rating-panel" aria-label="식단 평가">
          <strong>{meal.rating ? '식단 평가 · 바꾸려면 다시 고르세요' : '이 식단은 어땠나요?'}</strong>
          <RatingButtons value={meal.rating} onRate={onRate} />
        </section>
      )}
      {!coach && meal.rating && (
        <section className="rating-panel member" aria-label="트레이너 평가">
          <strong>{trainerName ? `${trainerName} 트레이너의 평가` : '트레이너 평가'}</strong>
          <RatingChip rating={meal.rating} />
        </section>
      )}
      <div className="detail-meta">
        <span>
          {prettyDay(meal.eaten_on)} · {meal.eaten_at}
        </span>
        <StatusTag meal={meal} />
      </div>
      {photoUrl ? (
        <img className="detail-photo" src={photoUrl} alt="등록한 식사 사진" />
      ) : (
        <div className="placeholder-photo">
          <Icon name="photo" />
          <span>사진 없이 기록한 식사</span>
        </div>
      )}
      <h3 className="detail-food">{meal.food}</h3>
      <p className="detail-date">먹은 시각 기준으로 표시됩니다.</p>

      {coach && onReview && (
        <button
          className="secondary full review-button"
          disabled={!pending}
          onClick={() => void onReview()}
        >
          <Icon name="check" />
          {pending ? '확인 완료로 표시' : '확인한 식사입니다'}
        </button>
      )}

      {!coach && (onEdit || onDelete) && (
        <div className="detail-actions">
          {onEdit && (
            <button className="text-button" onClick={onEdit}>
              수정
            </button>
          )}
          {onDelete && (
            <button
              className={`text-button ${confirmDelete ? 'danger' : ''}`}
              onClick={() => (confirmDelete ? void onDelete() : setConfirmDelete(true))}
            >
              {confirmDelete ? '한 번 더 누르면 삭제돼요' : '삭제'}
            </button>
          )}
        </div>
      )}

      <div className="divider" />
      <div className="conversation-title">
        <Icon name="chat" /> 식사에 대한 대화 <span className="tiny">{messages.length}</span>
      </div>
      {messages.length ? (
        messages.map((c) => (
          <div key={c.id} className={`message ${c.author_role === 'member' ? 'member' : ''} ${coach && question?.id === c.id ? 'awaiting' : ''}`}>
            <div className="message-head">
              <strong>{c.author_role === 'trainer' ? `${trainerName} 트레이너` : `${meal.member_nickname} 회원`}</strong>
              <span>{c.id === NOTE_ID ? `${noteEdited(meal) ? '고쳐 쓴 한마디' : '등록 때 남긴 말'} · ${relativeTime(c.created_at)}` : relativeTime(c.created_at)}</span>
            </div>
            <p>{c.body}</p>
          </div>
        ))
      ) : (
        <p className="no-conversation">
          아직 나눈 이야기가 없어요.
          <br />이 식사에 대한 질문이나 피드백을 남겨주세요.
        </p>
      )}
      <form className="comment-form" onSubmit={submit}>
        <label htmlFor="comment-text">{coach ? '회원에게 피드백' : '트레이너에게 추가 질문'}</label>
        <textarea
          ref={replyRef}
          id="comment-text"
          value={text}
          maxLength={1000}
          rows={3}
          required
          placeholder={coach ? '잘한 점이나 다음 식사에서 시도할 점을 남겨주세요.' : '이 식사에 대해 궁금한 점을 남겨주세요.'}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="primary full" disabled={sending}>
          {sending ? '보내는 중…' : coach ? '피드백 보내기' : '질문 남기기'}
        </button>
      </form>
    </>
  );
}
