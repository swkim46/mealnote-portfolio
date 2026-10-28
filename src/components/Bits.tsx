import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { prettyDay, todayKey } from '../lib/dates';
import { hasQuestion, pendingQuestion, statusOf, thread } from '../lib/status';
import type { Meal } from '../lib/types';
import { RATINGS, ratingOf, type Rating } from '../lib/rating';

export function RatingChip({ rating }: { rating: number | null }) {
  const r = ratingOf(rating);
  return r ? <span className={`rating-chip ${r.cls}`}>{r.label}</span> : null;
}

/** 트레이너 평가 버튼 세 개. 한 번 누르면 끝(다시 누르면 바꿈). */
export function RatingButtons({ value, onRate, compact }: { value: number | null; onRate: (r: Rating) => Promise<void>; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={`rating-buttons ${compact ? 'compact' : ''}`} role="group" aria-label="식단 평가">
      {RATINGS.map((r) => (
        <button
          key={r.value}
          className={`rating-button ${r.cls}`}
          aria-pressed={value === r.value}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRate(r.value);
            } finally {
              setBusy(false);
            }
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function StatusTag({ meal }: { meal: Meal }) {
  const { cls, label } = statusOf(meal);
  return <span className={`status ${cls}`}>{label}</span>;
}

export function MealImage({ url }: { url?: string }) {
  return <span className="meal-image">{url ? <img src={url} alt="등록한 식사 사진" loading="lazy" /> : <Icon name="photo" />}</span>;
}

/** 트레이너 카드에 붙는 한 줄: 답을 기다리는 질문이 있으면 질문, 없으면 회원 메모 */
function TrainerPreview({ meal }: { meal: Meal }) {
  const q = pendingQuestion(meal);
  if (q) {
    return (
      <span className="question-snippet">
        <b>{q.id === 'note' ? '남긴 말' : '질문'}</b>
        <span>{q.body}</span>
      </span>
    );
  }
  if (meal.note) return <span className="note-snippet">메모 · {meal.note}</span>;
  return null;
}

export function MealCard({
  meal,
  photoUrl,
  showMember,
  forTrainer,
  onOpen,
  onRate,
}: {
  meal: Meal;
  photoUrl?: string;
  showMember?: boolean;
  forTrainer?: boolean;
  onOpen: () => void;
  /** 있으면 카드 아래에 평가 버튼(트레이너 확인 목록) */
  onRate?: (r: Rating) => Promise<void>;
}) {
  const card = <MealCardButton meal={meal} photoUrl={photoUrl} showMember={showMember} forTrainer={forTrainer} onOpen={onOpen} />;
  if (!onRate) return card;
  return (
    <div className="meal-card-wrap">
      {card}
      <RatingButtons value={meal.rating} onRate={onRate} compact />
    </div>
  );
}

function MealCardButton({ meal, photoUrl, showMember, forTrainer, onOpen }: { meal: Meal; photoUrl?: string; showMember?: boolean; forTrainer?: boolean; onOpen: () => void }) {
  const notToday = meal.eaten_on !== todayKey();
  return (
    <button
      className={`meal-card ${showMember ? 'coach-card' : ''} ${forTrainer && hasQuestion(meal) ? 'has-question' : ''}`}
      onClick={onOpen}
      aria-label={`${showMember ? meal.member_nickname + ' ' : ''}${meal.meal_type} ${meal.food} 상세 보기`}
    >
      <MealImage url={photoUrl} />
      <span className="meal-card-content">
        <span className="meal-meta">
          {showMember && <strong>{meal.member_nickname}</strong>}
          <span>
            {notToday ? `${prettyDay(meal.eaten_on)} · ` : ''}
            {meal.meal_type} · {meal.eaten_at}
          </span>
        </span>
        <span className="meal-title">{meal.food}</span>
        {forTrainer && <TrainerPreview meal={meal} />}
        <span className="meal-bottom">
          <StatusTag meal={meal} />
          <RatingChip rating={meal.rating} />
          <span className="comment-count">
            <Icon name="chat" />
            {thread(meal).length}
          </span>
        </span>
      </span>
    </button>
  );
}

export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name="book" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Loading() {
  return <p className="hint loading">불러오는 중…</p>;
}
