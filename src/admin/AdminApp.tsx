import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Sheet } from '../components/Sheet';
import { Empty, Loading } from '../components/Bits';
import { AccountPanel } from '../components/AccountPanel';
import { ReleaseNotes } from '../components/ReleaseNotes';
import { NicknameChangeForm, PinChangeForm, RecoverySetupForm } from '../components/PinForms';
import { supabase } from '../lib/supabase';
import { useToast } from '../components/Toast';
import { relativeTime } from '../lib/dates';
import { CATEGORY_LABEL, listFeedback, setFeedbackStatus, type AppFeedback, type FeedbackStatus } from '../lib/feedback';
import type { Profile } from '../lib/types';

type View = 'new' | 'all' | 'me';
const STATUS_LABEL: Record<FeedbackStatus, string> = { new: '새 의견', read: '읽음', done: '처리 완료' };
const EVENT_LABEL: Record<string, string> = {
  reported_not_me: '본인이 바꾸지 않았다고 신고',
  reclaimed: '로그인해 둔 기기로 계정을 되찾음',
  recovery_locked: 'PIN 찾기 답을 5번 틀려 하루 잠김',
  nickname_changed: '닉네임을 바꿈',
};

/** 운영자 화면: 익명으로 들어온 의견을 읽고 상태를 바꾼다. 식단·회원 기록은 볼 수 없다. */
export function AdminApp({ profile }: { profile: Profile }) {
  const toast = useToast();
  const [items, setItems] = useState<AppFeedback[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>('new');
  const [releases, setReleases] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [events, setEvents] = useState<{ nickname: string; kind: string; created_at: string }[]>([]);

  const load = useCallback(async () => {
    try {
      setItems(await listFeedback());
      const ev = await supabase.rpc('admin_security_events');
      if (!ev.error) setEvents((ev.data ?? []) as typeof events);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    const t = window.setInterval(onVisible, 60000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(t);
    };
  }, [load]);

  const fresh = useMemo(() => items.filter((i) => i.status !== 'done'), [items]);
  const list = view === 'new' ? fresh : items;

  async function change(id: string, status: FeedbackStatus) {
    try {
      await setFeedbackStatus(id, status);
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
      if (status === 'done') toast('처리 완료로 옮겼어요.');
    } catch {
      toast('바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
  }

  let body;
  if (view === 'me')
    body = (
      <AccountPanel
        profile={profile}
        detail="운영자 · 의견만 볼 수 있어요"
        onReleases={() => setReleases(true)}
        onChangePin={() => setPinOpen(true)}
        onChangeNickname={() => setNicknameOpen(true)}
        onRecovery={() => setRecoveryOpen(true)}
      />
    );
  else if (!loaded) body = <Loading />;
  else if (failed && !items.length)
    body = (
      <Empty
        title="의견을 불러오지 못했어요"
        description="연결을 확인한 뒤 다시 시도해 주세요."
        action={<button className="secondary" onClick={() => void load()}>다시 불러오기</button>}
      />
    );
  else
    body = (
      <>
        <div className="summary-grid">
          <div className="summary-cell">
            <span>처리할 의견</span>
            <strong>
              {fresh.length}
              <small>건</small>
            </strong>
          </div>
          <div className="summary-cell">
            <span>전체</span>
            <strong>
              {items.length}
              <small>건</small>
            </strong>
          </div>
        </div>
        {events.length > 0 && (
          <section className="security-events">
            <h3>계정 보안 기록</h3>
            {events.slice(0, view === 'new' ? 5 : 100).map((e, i) => (
              <p key={i}>
                <strong>{e.nickname}</strong> · {EVENT_LABEL[e.kind] ?? e.kind} · <span className="tiny">{relativeTime(e.created_at)}</span>
              </p>
            ))}
          </section>
        )}
        {list.length ? (
          list.map((f) => (
            <article key={f.id} className={`admin-feedback ${f.status}`}>
              <div className="admin-feedback-head">
                <span className={`status ${f.category === 'bug' ? 'question' : ''}`}>{CATEGORY_LABEL[f.category]}</span>
                <span className="tiny">{relativeTime(f.created_at)}</span>
              </div>
              <p className="admin-feedback-body">{f.body}</p>
              <p className="admin-feedback-meta">
                {f.screen || '화면 정보 없음'} · {f.device || '기기 정보 없음'} · {f.app_version || '버전 정보 없음'}
              </p>
              <div className="admin-feedback-actions">
                <span className="tiny">{STATUS_LABEL[f.status]}</span>
                {f.status === 'new' && (
                  <button className="text-button" onClick={() => void change(f.id, 'read')}>
                    읽음 표시
                  </button>
                )}
                {f.status !== 'done' ? (
                  <button className="secondary" onClick={() => void change(f.id, 'done')}>
                    처리 완료
                  </button>
                ) : (
                  <button className="text-button" onClick={() => void change(f.id, 'read')}>
                    다시 열기
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <Empty
            title={view === 'new' ? '처리할 의견이 없어요' : '아직 들어온 의견이 없어요'}
            description="회원·트레이너가 의견 보내기를 쓰면 여기에 모여요. 보낸 사람은 남지 않아요."
          />
        )}
      </>
    );

  return (
    <>
      <Shell
        title={view === 'me' ? '내 정보' : '받은 의견'}
        sub={view === 'me' ? '계정과 앱 설정을 확인해요.' : '익명으로 들어온 의견과 오류 제보예요.'}
        active={view}
        onTab={(id) => setView(id as View)}
        tabs={[
          { id: 'new', icon: 'list', label: '처리할 의견', count: fresh.length, dot: items.some((i) => i.status === 'new') },
          { id: 'all', icon: 'book', label: '전체' },
          { id: 'me', icon: 'user', label: '내 정보' },
        ]}
      >
        {body}
      </Shell>
      <Sheet open={nicknameOpen} title="닉네임 바꾸기" onClose={() => setNicknameOpen(false)}>
        <NicknameChangeForm profile={profile} onDone={() => setNicknameOpen(false)} />
      </Sheet>
      <Sheet open={pinOpen} title="PIN 바꾸기" onClose={() => setPinOpen(false)}>
        <PinChangeForm uid={profile.id} onDone={() => setPinOpen(false)} />
      </Sheet>
      <Sheet open={recoveryOpen} title="복구 질문" onClose={() => setRecoveryOpen(false)}>
        <RecoverySetupForm onDone={() => setRecoveryOpen(false)} />
      </Sheet>
      <Sheet open={releases} title="업데이트 소식" onClose={() => setReleases(false)}>
        <ReleaseNotes />
      </Sheet>
    </>
  );
}
