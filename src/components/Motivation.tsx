import { useEffect, useState } from 'react';
import { fetchTrainerMessage, saveTrainerMessage, type Streak } from '../lib/api';
import { quoteFor } from '../lib/quotes';
import { streakText } from '../lib/streak';
import { useToast } from './Toast';
import { setUnsaved } from '../lib/appUpdate';

export const MESSAGE_MAX = 100;

/** 회원 '오늘' 맨 위: 트레이너가 쓴 오늘 한마디, 없으면 기본 문구 */
export function TodayWord({ day, trainerName }: { day: string; trainerName: string }) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchTrainerMessage(day)
        .then((m) => alive && setMessage(m))
        .catch(() => {});
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [day]);
  return (
    <section className="today-word banner" aria-label="오늘의 한마디">
      <span className="today-word-label">{message ? `${trainerName || '트레이너'} 트레이너의 한마디` : '오늘의 한마디'}</span>
      <p>{message ?? quoteFor(day)}</p>
    </section>
  );
}

export function StreakLine({ streak }: { streak: Streak | null }) {
  if (!streak) return null;
  const t = streakText(streak);
  return (
    <div className={`streak-line ${t.milestone ? 'milestone' : ''}`} data-testid="streak">
      <strong>{t.main}</strong>
      {t.sub && <span>{t.sub}</span>}
    </div>
  );
}

/** 트레이너 '확인 목록' 위: 오늘 담당 회원들에게 보일 한마디 쓰기·고치기·지우기 */
export function TrainerMessageCard({ day }: { day: string }) {
  const toast = useToast();
  const [message, setMessage] = useState<string | null>(null);
  const [loadedDay, setLoadedDay] = useState('');
  const loaded = loadedDay === day;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchTrainerMessage(day)
      .then((m) => alive && (setMessage(m), setLoadedDay(day)))
      .catch(() => alive && setLoadedDay(day));
    return () => {
      alive = false;
    };
  }, [day]);

  // 쓰다 만 한마디가 있으면 새 버전 적용이 화면을 새로 고치지 않게 한다
  const dirty = draft !== null && draft.trim() !== (message ?? '');
  useEffect(() => {
    setUnsaved('trainer-message', dirty);
    return () => setUnsaved('trainer-message', false);
  }, [dirty]);

  async function save(body: string) {
    setBusy(true);
    try {
      await saveTrainerMessage(day, body);
      const text = body.trim() || null;
      setMessage(text);
      setDraft(null);
      toast(text ? '오늘 한마디를 회원들에게 보여 드려요.' : '한마디를 지웠어요. 회원들에게는 기본 문구가 보여요.');
    } catch {
      toast('저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (draft !== null)
    return (
      <section className="today-word editing" aria-label="오늘 회원들에게 보일 한마디">
        <label className="field">
          오늘 회원들에게 보일 한마디
          <textarea
            rows={3}
            maxLength={MESSAGE_MAX}
            value={draft}
            placeholder="예) 오늘은 물 2리터 도전해 봐요!"
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <div className="word-actions">
          <span className="tiny">
            {draft.length}/{MESSAGE_MAX}
          </span>
          <button className="text-button" disabled={busy} onClick={() => setDraft(null)}>
            취소
          </button>
          <button className="primary small" disabled={busy || !draft.trim()} onClick={() => void save(draft)}>
            저장
          </button>
        </div>
      </section>
    );

  return (
    <section className="today-word" aria-label="오늘 회원들에게 보일 한마디">
      <span className="today-word-label">{message ? '오늘 회원들에게 보이는 내 한마디' : '오늘 회원들에게 보이는 기본 문구'}</span>
      <p>{loaded ? (message ?? quoteFor(day)) : ' '}</p>
      <div className="word-actions">
        {message && (
          <button className="text-button" disabled={busy} onClick={() => void save('')}>
            지우기
          </button>
        )}
        <button className="secondary small" disabled={!loaded || busy} onClick={() => setDraft(message ?? '')}>
          {message ? '고치기' : '한마디 쓰기'}
        </button>
      </div>
    </section>
  );
}
