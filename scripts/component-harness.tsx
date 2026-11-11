/* eslint-disable react/only-export-components -- 검증 전용 화면이라 빠른 새로 고침(내보내기 규칙)을 쓰지 않는다 */
// 화면 조각 검증용(scripts/component-check.mjs 전용). 실제 컴포넌트를 그대로 그리고, 서버·인식기 응답은 검증 스크립트가 가로채 정한다.
// Codex 리뷰 v1.4 재현 하네스를 옮겨 온 것.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useInbody } from '../src/components/useInbody';
import { InbodyForm, InbodyPanel } from '../src/components/Inbody';
import { InbodyReports } from '../src/components/InbodyReports';
import { PushSettings } from '../src/components/PushSettings';
import { ActivityList } from '../src/components/Activity';
import { useActivity } from '../src/lib/activity';
import { useMealStore } from '../src/components/useMealStore';
import { DaySummary, TodayWord } from '../src/components/Motivation';
import { ShareConsentSetting, SharedMeals } from '../src/components/Community';
import { AwardBoardView, AwardHistory, AwardsSection } from '../src/components/Awards';
import { StartGuide } from '../src/components/StartGuide';
import { NotificationGuide } from '../src/components/NotificationGuide';
import { TrainerApp } from '../src/trainer/TrainerApp';
import { MemberApp } from '../src/member/MemberApp';
import { SecurityNotices } from '../src/components/SecurityNotices';
import { ToastProvider } from '../src/components/Toast';
import { MealImage } from '../src/components/Bits';
import { clearMealPhotos } from '../src/lib/mealPhoto';
import '../src/styles.css';

const ids = { A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222' };

function Hook() {
  const [id, setId] = useState(ids.A);
  const state = useInbody(id);
  return (
    <>
      <button onClick={() => setId(ids.A)}>회원 A</button>
      <button onClick={() => setId(ids.B)}>회원 B</button>
      <pre data-testid="state">{JSON.stringify({ id, loaded: state.loaded, failed: state.failed, records: state.records })}</pre>
    </>
  );
}

const records = [
  { id: 'current', member_id: ids.A, measured_on: '2026-10-22', weight_kg: 72.1, smm_kg: 32.8, pbf_pct: 22.4, source: 'manual' as const },
  { id: 'before', member_id: ids.A, measured_on: '2026-09-15', weight_kg: 73.3, smm_kg: 32.4, pbf_pct: 23.6, source: 'manual' as const },
];

function Reports() {
  const [mealsKey, setMealsKey] = useState('m1:2026-10-01:3');
  return (
    <>
      <button onClick={() => setMealsKey('m1:2026-10-01:1')}>평가 바뀜</button>
      <InbodyReports memberId={ids.A} inbody={{ records, loaded: true, failed: false, reload: async () => {} }} mealsKey={mealsKey} />
    </>
  );
}

// 실제 인바디 훅 + 인바디 칸·변화 칸(Codex v2.0.1 2차 리뷰): 회원 전환·재조회 실패에서 화면이 무엇을 보이는지
function InbodyLive() {
  const [id, setId] = useState(ids.A);
  const inbody = useInbody(id);
  return (
    <>
      <button onClick={() => setId(ids.A)}>회원 A</button>
      <button onClick={() => setId(ids.B)}>회원 B</button>
      <section data-testid="live-panel">
        <InbodyPanel inbody={inbody} canEdit={false} />
      </section>
      <section data-testid="live-reports">
        <InbodyReports memberId={id} inbody={inbody} />
      </section>
    </>
  );
}

// 운동 탭 '변화'의 상태(2.0.1): ?n=기록 수(0·1·2) &state=loading|failed|ok
function ReportsState() {
  const q = new URLSearchParams(location.search);
  const n = Number(q.get('n') ?? 0), st = q.get('state') ?? 'ok';
  const reload = async () => {
    (window as unknown as { __reloaded: number }).__reloaded = ((window as unknown as { __reloaded?: number }).__reloaded ?? 0) + 1;
  };
  return <InbodyReports memberId={ids.A} inbody={{ records: records.slice(0, n), loaded: st !== 'loading', failed: st === 'failed', reload }} />;
}

// 식단 탭 요약 줄의 연속 기록 배지(2.0.1): 오늘 남김 · 달성 날 · 아직 오늘 기록 전
function Streaks() {
  return (
    <>
      <DaySummary label="오늘" count={2} streak={{ current: 5, best: 9, today_logged: true }} />
      <DaySummary label="오늘" count={1} streak={{ current: 7, best: 7, today_logged: true }} />
      <DaySummary label="오늘" count={0} streak={{ current: 12, best: 12, today_logged: false }} />
    </>
  );
}

// 알림 목록: 실제 훅·목록. 버튼으로 다시 조회·읽음 저장을 직접 일으켜 응답 순서를 시험한다(Codex v1.7 품질 리뷰 재현을 옮김)
function Activity() {
  const activity = useActivity(ids.A);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>목록 열기</button>
      <button onClick={() => void activity.reload()}>다시 조회</button>
      <button onClick={() => void activity.markSeen()}>읽음 저장</button>
      <button onClick={() => void activity.loadMore()}>더 받기</button>
      <pre data-testid="state">
        {JSON.stringify({
          unread: activity.unread,
          loaded: activity.items !== null,
          failed: activity.failed,
          count: activity.items?.length ?? 0,
          hasMore: activity.hasMore,
          keys: activity.items?.map((i) => i.key) ?? [],
          ats: Object.fromEntries((activity.items ?? []).map((i) => [i.key, i.at])),
        })}
      </pre>
      {open && <ActivityList activity={activity} onOpen={() => {}} />}
    </>
  );
}

// 식사 목록: 전체 다시 받기와 식사 하나 다시 받기가 겹칠 때(늦게 끝난 전체 조회가 방금 바꾼 식사를 되돌리지 않는지)
const MEAL = '44444444-4444-4444-8444-444444444444';
function Store() {
  const store = useMealStore('trainer');
  const [opened, setOpened] = useState('');
  return (
    <>
      <button onClick={() => void store.reload()}>전체 다시 받기</button>
      <button onClick={() => void store.refreshMeal(MEAL).catch(() => {})}>하나 다시 받기</button>
      <button onClick={() => void store.refreshAfterSave(MEAL)}>저장 뒤 다시 받기</button>
      <button onClick={() => store.removeLocal(MEAL)}>화면에서 지우기</button>
      <button onClick={() => void store.refreshMeal(MEAL).then((m) => setOpened(m ? 'shown' : 'none'), () => setOpened('error'))}>알림에서 열기</button>
      <pre data-testid="state">
        {JSON.stringify({ loaded: store.loaded, reviewed: store.meals.find((m) => m.id === MEAL)?.reviewed_at ?? null, ids: store.meals.map((m) => m.id.slice(0, 4)).sort().join(','), opened })}
      </pre>
    </>
  );
}

// v2.0: 식단왕·운동왕 칸(1～15일 지난달 결과 / 16일부터 회원은 이번 달 참여 현황). 날짜는 주소의 today로
function Awards() {
  const q = new URLSearchParams(location.search);
  const today = q.get('today') ?? '2026-11-10';
  const member = q.get('role') !== 'trainer';
  return (
    <>
      <AwardsSection today={today} member={member} version="" onBoard={() => {}} onHistory={() => {}} />
      {(['rating', 'streak', 'workout'] as const).map((k) => <AwardBoardView key={k} board={k} today={today} member={member} version="" />)}
      <AwardHistory today={today} />
    </>
  );
}

// 모드는 페이지를 열 때 정해진다. 훅 순서를 지키려고 모드별 화면은 따로 그린다
function App() {
  const mode = new URLSearchParams(location.search).get('mode');
  // v1.8: 실제 트레이너 화면(내보내기 확인·회원 목록 응답 순서·사진), 추천 식단 사진 실패 뒤 다시 받기, 사진 임시 주소 수명
  if (mode === 'trainer')
    return (
      <ToastProvider>
        <TrainerApp profile={{ id: '99999999-9999-4999-8999-999999999999', nickname: '검증 트레이너', role: 'trainer' }} />
      </ToastProvider>
    );
  // v2.0.2: 실제 회원 화면(연속 기록 응답 순서 — Codex v2.0.1 4차 리뷰 재현을 옮김)
  if (mode === 'member') {
    const profile = { id: ids.A, nickname: '검증 회원', role: 'member' as const };
    // security=1: 실제 앱처럼 보안 알림을 함께 그린다(Codex v2.3.1 2차 리뷰 — 창이 겹치는 순서를 시험한다)
    return (
      <ToastProvider>
        <MemberApp profile={profile} />
        {new URLSearchParams(location.search).has('security') && <SecurityNotices profile={profile} />}
      </ToastProvider>
    );
  }
  if (mode === 'shared') return <SharedMeals />;
  if (mode === 'photos') return <Photos />;
  return <Pieces mode={mode} />;
}

// 사진 칸 여러 개를 켜고 끈다: 같은 사진 둘(카드·상세처럼), 사진 바꾸기, 모두 닫기, 계정 전환
function Photos() {
  const [shown, setShown] = useState<string[]>([]);
  const [path, setPath] = useState('owner/a.jpg');
  const ref = (n: string) => ({ mealId: `00000000-0000-4000-8000-${n.padStart(12, '0')}`, path: n === '1' ? path : `owner/${n}.jpg` });
  return (
    <>
      <button onClick={() => setShown(['1', '1'])}>같은 사진 둘</button>
      <button onClick={() => setShown(['1'])}>하나만</button>
      <button onClick={() => setPath('owner/b.jpg')}>사진 바꾸기</button>
      <button onClick={() => setShown(Array.from({ length: 50 }, (_, i) => String(i + 2)))}>다른 사진 50장</button>
      <button onClick={() => setShown([])}>모두 닫기</button>
      <button onClick={() => clearMealPhotos()}>계정 전환</button>
      {/* 사진 칸은 화면에 들어올 때 받으므로 모두 한 화면에 들어오게 작게 늘어놓는다 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', zoom: 0.3 }}>
        {shown.map((n, i) => (
          <MealImage key={`${n}-${i}`} photo={ref(n)} />
        ))}
      </div>
    </>
  );
}

function Pieces({ mode }: { mode: string | null }) {
  const [message, setMessage] = useState('');
  return (
    <main style={{ maxWidth: 460, margin: '0 auto', padding: 16 }}>
      {mode === 'hook' ? <Hook /> : mode === 'form' ? <InbodyForm memberId={ids.A} onDone={setMessage} onError={setMessage} /> : mode === 'prefs' ? <PushSettings profile={{ id: ids.A, nickname: '검증', role: 'member' }} /> : mode === 'activity' ? <Activity /> : mode === 'store' ? <Store /> : mode === 'like' ? <TodayWord day="2026-10-28" trainerName="검증" /> : mode === 'consent' ? <ShareConsentSetting userId={ids.A} /> : mode === 'awards' ? <Awards /> : mode === 'reportsState' ? <ReportsState /> : mode === 'inbodyLive' ? <InbodyLive /> : mode === 'streak' ? <Streaks /> : mode === 'guide' ? <StartGuide role="member" onOpenPush={() => {}} onDone={() => {}} /> : mode === 'notiguide' ? <NotificationGuide onBack={() => {}} backLabel="돌아가기" /> : <Reports />}
      <output>{message}</output>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
