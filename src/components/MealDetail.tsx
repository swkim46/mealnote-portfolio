import { useRef, useState, type FormEvent } from 'react';
import { useMealPhotoState, type PhotoRef } from '../lib/mealPhoto';
import { Icon } from './Icon';
import { RatingButtons, RatingChip, StatusTag } from './Bits';
import type { Rating } from '../lib/rating';
import { prettyDay, relativeTime } from '../lib/dates';
import { NOTE_ID, needsTrainer, noteEdited, pendingQuestion, shareActive, shareEnds, thread } from '../lib/status';
import type { Meal, Role } from '../lib/types';

interface Props {
  meal: Meal;
  role: Role;
  photoUrl?: string;
  /** 남의 사진(트레이너): 서명 주소 대신 서버 기능으로 받는다 */
  photo?: PhotoRef;
  trainerName: string;
  onComment: (body: string) => Promise<boolean>;
  onReview?: () => Promise<void>;
  /** 트레이너: 식단 평가 */
  onRate?: (r: Rating) => Promise<void>;
  onEdit?: () => void;
  onDelete?: () => Promise<void>;
  /** 트레이너: 추천 식단으로 공유(회원 동의가 있어야 켤 수 있다). consent null = 아직 모름 */
  share?: { consent: boolean | null; onToggle: (on: boolean) => Promise<void> };
}

export function MealDetail({ meal, role, photoUrl: signedUrl, photo, trainerName, onComment, onReview, onRate, onEdit, onDelete, share }: Props) {
  const [sharing, setSharing] = useState(false);
  // 위 '답변 없이 확인'과 아래 '확인 완료로 표시'는 같은 저장이다 — 처리 중 상태를 같이 써서 두 버튼 모두 잠그고 두 번 보내지 않는다(Codex v1.8.3 3차 리뷰)
  const [reviewing, setReviewing] = useState(false);
  const reviewBusy = useRef(false);
  async function review() {
    if (!onReview || reviewBusy.current) return;
    reviewBusy.current = true;
    setReviewing(true);
    try {
      await onReview();
    } finally {
      reviewBusy.current = false;
      setReviewing(false);
    }
  }
  // 서명 주소의 이미지가 깨지면(주소 만료·저장소 오류) 서버 기능으로 다시 받는다. 그것도 실패하면 실패 안내(Codex v2.4.0 1차 리뷰 P3-1)
  const [signedBroken, setSignedBroken] = useState<string | null>(null);
  const useSigned = !!signedUrl && signedBroken !== signedUrl;
  const fetched = useMealPhotoState(useSigned ? undefined : photo, true);
  const photoUrl = useSigned ? signedUrl : fetched.url;
  const [shownBroken, setShownBroken] = useState<string | null>(null);
  const photoFailed = !!photo && (fetched.failed || (!!photoUrl && shownBroken === photoUrl));
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
              <button className="question-ack" disabled={reviewing} onClick={() => void review()}>
                <Icon name="check" /> {reviewing ? '확인 중…' : '답변 없이 확인'}
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
      {/* 사진이 있는 식사인데 받지 못하면 '사진 없이 기록한 식사'가 아니라 실패를 알리고 다시 불러오게 한다(2.4 · 4-1) */}
      {photoFailed ? (
        <div className="placeholder-photo is-failed" data-testid="photo-failed">
          <Icon name="photo" />
          <span>사진을 불러오지 못했어요</span>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              const broken = shownBroken !== null;
              setShownBroken(null);
              fetched.retry(broken);
            }}
          >
            다시 불러오기
          </button>
        </div>
      ) : photoUrl ? (
        <img
          className="detail-photo"
          src={photoUrl}
          alt="등록한 식사 사진"
          onError={() => (useSigned ? setSignedBroken(signedUrl) : setShownBroken(photoUrl))}
        />
      ) : photo ? (
        <div className="placeholder-photo" role="status">
          <Icon name="photo" />
          <span>사진을 불러오는 중…</span>
        </div>
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
          disabled={!pending || reviewing}
          onClick={() => void review()}
        >
          <Icon name="check" />
          {reviewing ? '확인 중…' : pending ? '확인 완료로 표시' : '확인한 식사입니다'}
        </button>
      )}

      {coach && share && (() => {
        // 공유한 지 7일이 지나면 목록에서 내려간다(서버 기준). 다시 공유하면 그때부터 7일
        const active = shareActive(meal.shared_at);
        const ends = active && meal.shared_at ? shareEnds(meal.shared_at) : null;
        return (
        <div className="share-panel">
          <button
            className="secondary full"
            data-testid="share-meal"
            disabled={sharing || (!active && share.consent !== true)}
            onClick={async () => {
              setSharing(true);
              try {
                await share.onToggle(!active);
              } finally {
                setSharing(false);
              }
            }}
          >
            {active ? '추천 식단 공유 풀기' : meal.shared_at ? '좋은 식단으로 다시 공유' : '좋은 식단으로 공유'}
          </button>
          <p className="tiny" data-testid="share-note">
            {ends
              ? `같은 트레이너의 회원들에게 보이고 있어요. ${ends.getMonth() + 1}월 ${ends.getDate()}일까지 보여요.`
              : share.consent === false
                ? '회원이 설정에서 식단 공유를 허용해야 공유할 수 있어요.'
                : meal.shared_at
                  ? '공유한 지 일주일이 지나 추천 식단에서 내려갔어요. 다시 공유하면 일주일 동안 보여요.'
                  : '사진·음식·평가·날짜가 일주일 동안 다른 회원들에게 보여요. 닉네임은 회원의 공개 설정에 따라 보여요.'}
          </p>
        </div>
        );
      })()}

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
      <fieldset className="form-lock" disabled={sending}>
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
      </fieldset>
    </form>
    </>
  );
}
