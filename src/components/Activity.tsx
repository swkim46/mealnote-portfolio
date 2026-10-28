// 알림 모아보기(v1.7, 2026-10-27 사용자 요청): 받은 소식을 시간순으로. 누르면 그 식사 상세로 간다.
// 회원은 트레이너의 평가·답글, 트레이너는 담당 회원의 식사 기록·말. 끼니 기록 알림은 넣지 않는다.
import { useEffect, useRef, useState } from 'react';
import { relativeTime } from '../lib/dates';
import { activityText, type useActivity } from '../lib/activity';

/**
 * 알림 목록(시트 안). 목록을 성공적으로 받은 뒤에만 새 소식 표시를 정하고 읽음을 남긴다
 * (못 불러왔거나 아직 보여 주지 않은 소식은 읽음이 되지 않는다 · Codex v1.7 품질 리뷰 3).
 */
export function ActivityList({ activity, onOpen }: { activity: ReturnType<typeof useActivity>; onOpen: (mealId: string) => void }) {
  const { items, hasMore, loadingMore, refreshing, failed, isNew, seenKnown, unread, loadMore } = activity;
  // 연 순간의 새 소식(받은 목록 기준). 읽음을 남긴 뒤에도 이 목록을 보는 동안은 강조를 유지한다
  const [fresh, setFresh] = useState<Set<string> | null>(null);
  const ready = !!items && seenKnown;
  useEffect(() => {
    if (!ready || !items) return;
    setFresh((prev) => {
      const next = new Set(prev ?? []);
      for (const a of items) if (isNew(a)) next.add(a.key);
      return next;
    });
  }, [ready, items, isNew]);
  // 보여 준 새 소식이 있으면 그 경계(가장 새 소식·뒤쪽 여부·새 소식 수)까지 읽음으로. 개수가 같아도 내용(재평가 시각,
  // 밀려 들어온 새 소식)이 바뀌면 경계가 달라져 다시 처리한다(Codex v1.7 후속 리뷰 2). 같은 경계는 한 번만 — 읽음 저장 뒤
  // 다시 받은 목록은 새 소식이 0이라 반복하지 않는다. markSeen 자체가 '아직 안 보여 준 새 소식'은 건너뛴다.
  const mark = useRef(activity.markSeen);
  useEffect(() => {
    mark.current = activity.markSeen;
  });
  // 경계는 저장에 성공(또는 옮길 것 없음)한 뒤에만 '처리함'으로 남긴다. 실패하면 앱으로 돌아올 때나 '다시 시도'로만 다시 보낸다 —
  // 저절로 반복하지 않아 실패가 이어져도 요청이 쏟아지지 않는다(Codex v1.7 운영 배포 후 리뷰 2).
  // 저장마다 번호를 매겨, 마지막에 보낸 저장의 응답만 처리함·오류·다시 시도 표시를 바꾼다 — 목록을 연 채로 새 소식이 들어와
  // 저장이 겹치면 늦게 온 옛 응답이 최신 결과를 덮던 문제(Codex v1.7.1 리뷰). 서버의 읽음 시각은 뒤로 가지 않는다.
  const done = useRef('');
  const inFlight = useRef('');
  const markSeq = useRef(0);
  // 실패는 그 저장의 대상(경계)과 묶어 기억한다. 지금 화면의 대상과 같을 때만 안내·다시 시도를 보인다 — 대상이 바뀌면(모두 읽음,
  // 새 소식) 옛 실패가 새 대상의 실패처럼 보이지 않는다(Codex v1.7.2 재리뷰 P3). 같은 대상을 다시 시도하는 동안은 안내를 유지한다.
  const [failedFor, setFailedFor] = useState('');
  const [retry, setRetry] = useState(0);
  const boundary = ready && items?.length && unread > 0 ? `${items[0].key}@${items[0].at}|${hasMore}|${unread}` : '';
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setRetry((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    if (!boundary) {
      // 다시 받은 읽음 상태에 처리할 새 소식이 없음(예: 다른 기기에서 읽음): 진행 중 저장의 늦은 응답은 무시한다(Codex v1.7.2 리뷰).
      // 읽음 시각을 아직 모르는 상태(ready=false)는 '모두 읽음'과 다르므로 건드리지 않는다.
      if (ready) {
        markSeq.current++;
        inFlight.current = '';
      }
      return;
    }
    if (boundary === done.current || boundary === inFlight.current) return;
    inFlight.current = boundary;
    const id = ++markSeq.current;
    void mark.current().then((r) => {
      if (id !== markSeq.current) return; // 더 나중에 보낸 저장이 있으면 이 응답은 화면 상태를 바꾸지 않는다
      inFlight.current = '';
      if (r === 'failed') {
        setFailedFor(boundary);
        return;
      }
      done.current = boundary;
      setFailedFor('');
    });
  }, [boundary, retry, ready]);

  if (!items) return <p className="hint">{failed ? '알림을 불러오지 못했어요. 잠시 후 다시 열어 주세요.' : '불러오는 중…'}</p>;
  if (!items.length) return <p className="hint">최근 1주일 동안 받은 소식이 없어요.</p>;
  return (
    <>
      {failed && <p className="field-error">최신 알림을 불러오지 못했어요. 잠시 후 다시 열어 주세요.</p>}
      {failedFor !== '' && failedFor === boundary && (
        <p className="field-error">
          읽음 표시를 저장하지 못했어요.{' '}
          <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
            다시 시도
          </button>
        </p>
      )}
      <ul className="activity-list">
        {items.map((a) => (
          <li key={a.key}>
            <button type="button" className={`activity-item ${fresh?.has(a.key) ? 'new' : ''}`} onClick={() => onOpen(a.meal_id)}>
              <span className="activity-text">{activityText(a)}</span>
              <span className="tiny">{relativeTime(a.at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" className="older-toggle" disabled={loadingMore || refreshing} onClick={() => void loadMore()}>
          {loadingMore ? '불러오는 중…' : '이전 알림 더 보기'}
        </button>
      )}
    </>
  );
}
