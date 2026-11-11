import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMessageLikers, fetchMyLike, fetchTrainerMessage, fetchTrainerMessageRow, saveTrainerMessage, setMessageLike, type Streak } from '../lib/api';
import { quoteFor } from '../lib/quotes';
import { streakText } from '../lib/streak';
import { useToast } from './Toast';
import { Icon } from './Icon';
import { setUnsaved } from '../lib/appUpdate';

export const MESSAGE_MAX = 100;

/** 회원 '오늘' 맨 위: 트레이너가 쓴 오늘 한마디, 없으면 기본 문구. 트레이너 한마디에는 좋아요(♥)를 누를 수 있다. */
export function TodayWord({ day, trainerName }: { day: string; trainerName: string }) {
  const toast = useToast();
  const [message, setMessage] = useState<string | null>(null);
  // 좋아요는 그날 한마디에 묶는다(날짜가 바뀌면 옛 값을 쓰지 않는다). 못 받았으면 버튼을 잠근다.
  // 저장이 이긴다: 저장 중에 끝난 조회와 저장 전에 시작한 조회의 결과는 버린다(앱 복귀 조회가 저장 성공을 덮던 문제, Codex v1.8.0 리뷰 7)
  const [like, setLike] = useState<{ day: string; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const likeReq = useRef(0);
  const saving = useRef(false);
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  const loadLike = useCallback((d: string) => {
    const n = ++likeReq.current;
    fetchMyLike(d)
      .then((on) => n === likeReq.current && !saving.current && dayRef.current === d && setLike({ day: d, on }))
      .catch(() => {});
  }, []);
  const msgReq = useRef(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const n = ++msgReq.current; // 앱 복귀 조회가 겹치면 마지막에 시작한 것만 쓴다
      fetchTrainerMessage(day)
        .then((m) => {
          if (!alive || n !== msgReq.current) return;
          setMessage(m);
          if (m) loadLike(day);
        })
        .catch(() => {});
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [day, loadLike]);

  const liked = like?.day === day ? like.on : null;
  async function toggle() {
    if (liked === null || busy) return;
    const d = day;
    const next = !liked;
    saving.current = true;
    setBusy(true);
    try {
      await setMessageLike(d, next);
      likeReq.current++; // 저장 전에 시작한 조회는 버린다
      if (dayRef.current === d) setLike({ day: d, on: next });
    } catch {
      toast('좋아요를 저장하지 못했어요. 다시 시도해 주세요.');
      saving.current = false;
      if (dayRef.current === d) loadLike(d); // 서버의 실제 상태로 맞춘다
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  // 2.0: 식단 탭 맨 위 한 줄(2026-10-29 계획 — 모든 탭에 큰 배너로 반복하던 것을 줄임). 누르면 전문과 ♥
  const [open, setOpen] = useState(false);
  const text = message ?? quoteFor(day);
  const who = message ? `${trainerName || '트레이너'} 트레이너` : '오늘의 한마디';
  return (
    <section className={`today-line ${open ? 'open' : ''}`} aria-label="오늘의 한마디" data-testid="today-word">
      <button type="button" className="today-line-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="today-line-who">{who}</span>
        <span className="today-line-text">{text}</span>
        {message && liked && <span className="today-line-liked" aria-label="좋아요 누름">♥</span>}
      </button>
      {open && message && (
        <button
          type="button"
          className={`like-button ${liked ? 'on' : ''}`}
          aria-pressed={!!liked}
          disabled={liked === null || busy}
          onClick={() => void toggle()}
        >
          {liked ? '♥ 좋아요' : '♡ 좋아요'}
        </button>
      )}
    </section>
  );
}

/**
 * 2.0 식단 탭의 요약 한 줄: '오늘 2끼 기록' + 연속 기록 배지(원칙 4 — 큰 카드 대신 한 줄).
 * 연속 기록은 한 줄 안에서도 눈에 띄게 큰 숫자 배지로(2026-11-02 사용자 지적: 2.0에서 작은 회색 글자가 돼 잘 안 보였다).
 * 오늘 남겼으면 라임으로 채우고, 아직이면 옅게 '오늘 남기면 N일째', 달성 단위(3·7·14·30…)에서는 테두리로 한 번 더 강조
 */
export function DaySummary({ label, count, streak }: { label: string; count: number; streak: Streak | null }) {
  const t = streak ? streakText(streak) : null;
  const on = !!streak && streak.current > 0;
  return (
    <div className="day-summary" data-testid="streak" title={t ? [t.main, t.sub].filter(Boolean).join(' ') : undefined}>
      <span>
        {label} <strong>{count}끼</strong> 기록
      </span>
      {on && (
        <span className={`streak-pill ${streak.today_logged ? 'on' : 'pending'} ${t?.milestone ? 'milestone' : ''}`} aria-label={t?.main}>
          <Icon name="flame" />
          <span>
            {streak.today_logged ? '연속' : '어제까지 연속'} <b>{streak.current}</b>일
          </span>
        </span>
      )}
      {on && !streak.today_logged && <small className="streak-next">오늘 남기면 {streak.current + 1}일째</small>}
    </div>
  );
}

/** 트레이너 '확인 목록' 위: 오늘 담당 회원들에게 보일 한마디 쓰기·고치기·지우기 */
export function TrainerMessageCard({ day, onSaved }: { day: string; onSaved?: () => void }) {
  const toast = useToast();
  const [message, setMessage] = useState<string | null>(null);
  const [loadedDay, setLoadedDay] = useState('');
  const loaded = loadedDay === day;
  const [draft, setDraft] = useState<string | null>(null);
  // 운동 꿀팁 표시(2.3): 모아 보기에서 꿀팁만 골라 볼 수 있다
  // savedTip이 null이면 저장된 표시를 읽지 못한 것 — 건드리지 않았으면 저장할 때 그대로 둔다
  const [savedTip, setSavedTip] = useState<boolean | null>(null);
  const [tip, setTip] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // 좋아요 누른 회원(그날 한마디에 묶음). 앱이 앞으로 올 때 다시 받는다
  const [likers, setLikers] = useState<{ day: string; names: string[] } | null>(null);
  const [showLikers, setShowLikers] = useState(false);
  const likersReq = useRef(0);

  useEffect(() => {
    let alive = true;
    setSavedTip(null);
    setTip(null);
    fetchTrainerMessageRow(day)
      .then((m) => alive && (setMessage(m?.body ?? null), setSavedTip(!!m?.is_tip), setTip(!!m?.is_tip), setLoadedDay(day)))
      .catch(() => alive && setLoadedDay(day));
    return () => {
      alive = false;
    };
  }, [day]);

  useEffect(() => {
    if (!message) return;
    let alive = true;
    const load = () => {
      const n = ++likersReq.current;
      fetchMessageLikers(day)
        .then((names) => alive && n === likersReq.current && setLikers({ day, names }))
        .catch(() => {});
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [day, message]);
  const likeNames = message && likers?.day === day ? likers.names : null;

  // 쓰다 만 한마디가 있으면 새 버전 적용이 화면을 새로 고치지 않게 한다
  const dirty = draft !== null && (draft.trim() !== (message ?? '') || !!tip !== !!savedTip);
  useEffect(() => {
    setUnsaved('trainer-message', dirty);
    return () => setUnsaved('trainer-message', false);
  }, [dirty]);

  async function save(body: string) {
    setBusy(true);
    try {
      await saveTrainerMessage(day, body, tip);
      const text = body.trim() || null;
      const nextTip = text ? tip : false;
      setMessage(text);
      setSavedTip(nextTip);
      setTip(nextTip);
      setDraft(null);
      onSaved?.();
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
            disabled={busy}
            placeholder="예) 오늘은 물 2리터 도전해 봐요!"
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <label className="remember-row">
          <input type="checkbox" checked={!!tip} disabled={busy} onChange={(e) => setTip(e.target.checked)} />
          운동 꿀팁으로 표시
        </label>
        <div className="word-actions">
          <span className="tiny">
            {draft.length}/{MESSAGE_MAX}
          </span>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setTip(savedTip);
            }}
          >
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
      {likeNames && showLikers && (
        <p className="likers tiny" data-testid="likers">
          {likeNames.length ? `${likeNames.join(', ')} 회원이 좋아요를 눌렀어요` : '아직 좋아요를 누른 회원이 없어요'}
        </p>
      )}
      <div className="word-actions">
        {likeNames && (
          <button type="button" className="text-button like-count" aria-expanded={showLikers} onClick={() => setShowLikers((v) => !v)}>
            ♥ {likeNames.length}명
          </button>
        )}
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
