// 화면 조각 검증용(scripts/component-check.mjs 전용). 실제 컴포넌트를 그대로 그리고, 서버·인식기 응답은 검증 스크립트가 가로채 정한다.
// Codex 리뷰 v1.4 재현 하네스를 옮겨 온 것.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useInbody } from '../src/components/useInbody';
import { InbodyForm } from '../src/components/Inbody';
import { InbodyReports } from '../src/components/InbodyReports';
import { PushSettings } from '../src/components/PushSettings';
import { ActivityList } from '../src/components/Activity';
import { useActivity } from '../src/lib/activity';
import { useMealStore } from '../src/components/useMealStore';
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
      <InbodyReports memberId={ids.A} records={records} mealsKey={mealsKey} />
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
  return (
    <>
      <button onClick={() => void store.reload()}>전체 다시 받기</button>
      <button onClick={() => void store.refreshMeal(MEAL)}>하나 다시 받기</button>
      <pre data-testid="state">{JSON.stringify({ loaded: store.loaded, reviewed: store.meals.find((m) => m.id === MEAL)?.reviewed_at ?? null })}</pre>
    </>
  );
}

function App() {
  const mode = new URLSearchParams(location.search).get('mode');
  const [message, setMessage] = useState('');
  return (
    <main style={{ maxWidth: 460, margin: '0 auto', padding: 16 }}>
      {mode === 'hook' ? <Hook /> : mode === 'form' ? <InbodyForm memberId={ids.A} onDone={setMessage} onError={setMessage} /> : mode === 'prefs' ? <PushSettings profile={{ id: ids.A, nickname: '검증', role: 'member' }} /> : mode === 'activity' ? <Activity /> : mode === 'store' ? <Store /> : <Reports />}
      <output>{message}</output>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
