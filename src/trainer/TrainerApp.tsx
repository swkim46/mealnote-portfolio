import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Shell, SwipeUnder } from '../components/Shell';
import { SetupNudge } from '../components/SetupNudge';
import { useSetupNudge, type SetupItem } from '../lib/setupNudge';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { MealCard } from '../components/Bits';
import { MealDetail } from '../components/MealDetail';
import { InstallHint } from '../components/AccountPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { StartGuide } from '../components/StartGuide';
import { WHATS_NEW_VERSION, firstOpenSheet } from '../lib/startGuide';
import { SharedMealDetail, SharedMeals } from '../components/Community';
import { AwardBoardView, AwardHistory, AwardsSection, boardTitle, type AwardBoard } from '../components/Awards';
import { Section, Segmented, StaleNotice, StatePanel } from '../ui/kit';
import { FeedbackForm } from '../components/FeedbackForm';
import { ReleaseNotes } from '../components/ReleaseNotes';
import { NicknameChangeForm, PinChangeForm, RecoverySetupForm } from '../components/PinForms';
import { savedNote, useMealStore } from '../components/useMealStore';
import { useToast } from '../components/Toast';
import { addComment, fetchMemberStreaks, fetchMembersConsent, fetchMyMembers, markReviewed, nudgeMember, rateMeal, removeMember, shareMeal, WINDOW_DAYS } from '../lib/api';
import { InbodyChart } from '../components/InbodyChart';
import { useFastingWeights } from '../components/FastingWeight';
import { TrainerWordsCard, TrainerWordsList } from '../components/TrainerWords';
import { NewWorkouts } from '../components/NewWorkouts';
import { BACK_LEVEL, shellSurface, useBackLayer, useEdgeSwiping } from '../lib/backNav';
import { mayLeaveScreen } from '../lib/appUpdate';
import { useTrainerWorkouts } from '../components/useTrainerWorkouts';
import { MemberDayCard, type MemberMode } from '../components/MemberDay';
import { CHOSEONG, OTHER_GROUP, choseongOf } from '../lib/memberOrder';
import { ratingOf, type Rating } from '../lib/rating';
import { TrainerMessageCard } from '../components/Motivation';
import { InbodyPanel } from '../components/Inbody';
import { RoutineForm, SheetLinkForm, TrainerWorkoutPanel, WorkoutForm, type RoutineDraft } from '../components/Workout';
import { ExerciseFind, type ExerciseTarget } from '../components/ExerciseFind';
import { exerciseKey } from '../lib/exercise';
import type { Routine, RoutineSheetLink, SharedMeal, WorkoutSession } from '../lib/api';
import { InbodyReports } from '../components/InbodyReports';
import { ChangeReport } from '../components/ChangeReport';
import { WhatsNew } from '../components/WhatsNew';
import { useInbody } from '../components/useInbody';
import { prettyDay, todayKey } from '../lib/dates';
import { hasQuestion, needsTrainer } from '../lib/status';
import { PushSettings } from '../components/PushSettings';
import { ActivityList } from '../components/Activity';
import { useActivity } from '../lib/activity';
import { usePushOpen } from '../lib/pushOpen';
import type { InbodyRecord, Profile } from '../lib/types';

type View = 'check' | 'members' | 'community' | 'settings';

type Filter = 'pending' | 'question' | 'all';
type SheetState = { kind: 'sharedMeal'; meal: SharedMeal } | { kind: 'awards' } | { kind: 'board'; board: AwardBoard } | { kind: 'nudge'; items: SetupItem[] } | { kind: 'words' } | { kind: 'whatsNew' } | { kind: 'report'; memberId: string; cur: InbodyRecord; prev: InbodyRecord } | { kind: 'sheetLink'; memberId: string; link: RoutineSheetLink | null } | { kind: 'routine'; memberId: string; current: Routine | null; initial?: RoutineDraft } | { kind: 'workoutView'; session: WorkoutSession } | { kind: 'exerciseFind'; memberId: string; initial?: { target: ExerciseTarget; editMemo?: boolean } } | { kind: 'detail'; id: string } | { kind: 'appFeedback' } | { kind: 'releases' } | { kind: 'pin' } | { kind: 'recovery' } | { kind: 'nickname' } | { kind: 'push' } | { kind: 'activity' } | { kind: 'install' } | { kind: 'guide' } | null;

export function TrainerApp({ profile }: { profile: Profile }) {
  const toast = useToast();
  const store = useMealStore('trainer');
  const { meals } = store;
  const [view, setView] = useState<View>('check');
  const [filter, setFilter] = useState<Filter>('pending');
  const [selectedMember, setSelectedMemberRaw] = useState<string | null>(null);
  // 회원 화면 안: 식단 / 루틴 / 운동 기록 / 인바디(2.1 — 운동을 루틴·운동 기록으로 나누고 인바디와 변화를 합침, 2026-11-03 사용자 확정)
  const [memberMode, setMemberMode] = useState<MemberMode>('meals');
  // 회원 목록 정렬(2.3 — 트레이너 의견 11-03): 확인할 것 많은 순 · 이름순(초성 구분)
  const [memberOrder, setMemberOrder] = useState<'check' | 'name'>('check');
  const [workoutVersion, setWorkoutVersion] = useState(0); // 루틴을 저장하면 올려 다시 받는다
  const [wordsVersion, setWordsVersion] = useState(0); // 한마디를 저장하면 올려 모아 보기를 다시 받는다
  const inbody = useInbody(selectedMember, view === 'members' && memberMode === 'inbody');
  const fasting = useFastingWeights(selectedMember, view === 'members' && memberMode === 'inbody');
  const memberMealsKey = useMemo(
    () => meals.filter((m) => m.member_id === selectedMember).map((m) => `${m.id}:${m.eaten_on}:${m.rating ?? ''}`).join(','),
    [meals, selectedMember],
  );
  const [members, setMembers] = useState<{ id: string; nickname: string }[]>([]);
  const [streaks, setStreaks] = useState<Record<string, { current: number; today_logged: boolean }>>({});
  const [sheet, setSheet] = useState<SheetState>(null);
  // 시작 안내·새 기능 소개: 이 기기에서 처음 열면 한 번(다른 창이 열려 있으면 그 창을 둔다)
  useEffect(() => {
    const kind = firstOpenSheet();
    if (kind) setSheet((cur) => cur ?? { kind });
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  useSetupNudge(profile.id, false, true, (items) => setSheet({ kind: 'nudge', items }));
  const today = todayKey();
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const workouts = useTrainerWorkouts(profile.id, memberIds, today, (view === 'check' || view === 'members') && !selectedMember);
  // 회원 화면에서 돌아오면 그 회원 카드부터(2.3 — 트레이너 의견 11-03). 스크롤 값이 아니라 카드 위치로 — 그사이 목록 순서가 바뀌어도 그 회원이 보인다
  const returnTo = useRef<string | null>(null);

  // 회원별 식단 공유 동의(식사 상세의 공유 버튼). 못 받았으면 null → 공유 버튼을 잠근다
  const [consent, setConsent] = useState<Record<string, boolean> | null>(null);
  // 내보내기 확인은 그 회원에 묶는다(다른 회원으로 옮기면 확인이 풀린다)
  const [confirmRemoveFor, setConfirmRemoveFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [membersVersion, setMembersVersion] = useState(0);
  // 회원 화면을 열고 닫는 모든 이동은 여기로: 내보내기 확인은 그 화면을 연 동안에만 유효하다(A → B → A로 돌아와도 풀려 있게, Codex v1.8.0 재리뷰 2)
  const setSelectedMember = (id: string | null) => {
    setConfirmRemoveFor(null);
    setMemberMode('meals');
    setSelectedMemberRaw(id);
  };
  // 회원·연속 기록·공유 동의는 마지막에 시작한 조회의 결과만 쓴다 — 내보내기 전에 시작한 늦은 조회가 내보낸 회원을 되살리지 않게(재리뷰 3)
  const membersReq = useRef(0);
  // 명단과 보조 정보(연속 기록·공유 동의)는 실패를 따로 센다: 보조 정보 실패를 명단 실패로 말하지 않는다(v2.3.0 4차 리뷰)
  const [membersFailed, setMembersFailed] = useState(false);
  const [membersKnown, setMembersKnown] = useState(false);
  const [extrasMissed, setExtrasMissed] = useState<string[]>([]);
  const loadMembers = useCallback(() => {
    const n = ++membersReq.current;
    const latest = () => n === membersReq.current;
    // 실패해도 마지막 정상 값은 두고, 실패했다는 사실은 담당 회원 화면에 알린다(3차 리뷰 후속 개선)
    void fetchMyMembers().then(
      (v) => {
        if (!latest()) return;
        setMembers(v);
        setMembersKnown(true);
        setMembersFailed(false);
      },
      () => latest() && setMembersFailed(true),
    );
    void Promise.allSettled([
      fetchMemberStreaks(todayKey()).then((v) => latest() && setStreaks(v)),
      fetchMembersConsent().then((v) => latest() && setConsent(v)),
    ]).then(([streak, share]) => latest() && setExtrasMissed([...(streak.status === 'rejected' ? ['연속 기록'] : []), ...(share.status === 'rejected' ? ['공유 동의'] : [])]));
  }, []);
  useEffect(() => {
    const load = loadMembers;
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [view, membersVersion, loadMembers]);

  // 수상 칸의 다시 받기 신호: 이 화면이 가진 식사의 추가·삭제·날짜·평가(커뮤니티에서 알림으로 식사를 열어 평가해도 순위를 다시 받는다)
  const awardsKey = useMemo(() => meals.map((m) => `${m.id}:${m.eaten_on}:${m.rating ?? ''}`).join(','), [meals]);
  const todo = useMemo(() => meals.filter(needsTrainer).length, [meals]);
  const questions = useMemo(() => meals.filter(hasQuestion).length, [meals]);
  const sheetMeal = sheet?.kind === 'detail' ? meals.find((m) => m.id === sheet.id) : undefined;
  const person = members.find((m) => m.id === selectedMember);

  const go = (v: View) => {
    setView(v);
    setSelectedMember(null);
    mainRef.current?.scrollTo(0, 0);
  };
  const openMember = (id: string, mode: MemberMode = 'meals') => {
    setSelectedMember(id);
    setMemberMode(mode);
    void store.loadMember(id);
    mainRef.current?.scrollTo(0, 0);
  };
  const backToMembers = () => {
    returnTo.current = selectedMember;
    setSelectedMember(null);
  };
  const leaveWith = (leave: () => void) => () => {
    if (!mayLeaveScreen()) return false;
    leave();
  };
  useBackLayer(view === 'members' && !!selectedMember, leaveWith(backToMembers), { level: BACK_LEVEL.screen, surface: shellSurface });
  useBackLayer(view !== 'check', leaveWith(() => go('check')));
  const swiping = useEdgeSwiping();
  useLayoutEffect(() => {
    const id = returnTo.current;
    if (selectedMember || !id) return;
    returnTo.current = null;
    mainRef.current?.querySelector(`[data-member="${id}"]`)?.scrollIntoView({ block: 'start' });
  }, [selectedMember]);
  // 알림(확인할 소식 요약)을 눌러 열면 확인 목록으로(작성 중인 시트는 닫지 않는다)
  usePushOpen(profile.id, () => go('check'));
  const activity = useActivity(profile.id);
  // 알림 목록에서 누른 소식: 그 식사 상세로(지금 불러온 범위 밖이면 그 식사만 따로 불러온다)
  async function openFromActivity(id: string) {
    const meal = meals.find((m) => m.id === id) ?? (await store.refreshMeal(id).catch(() => null));
    if (!meal) return toast('이 식사는 지금 볼 수 없어요.');
    setSheet({ kind: 'detail', id });
  }
  async function rate(id: string, r: Rating) {
    const m = meals.find((x) => x.id === id);
    const hadQuestion = !!m && hasQuestion(m);
    try {
      await rateMeal(id, r);
      const fresh = await store.refreshAfterSave(id);
      void activity.reload(); // 확인 처리됐으니 종 버튼 점도 다시 맞춘다
      toast(savedNote(`'${ratingOf(r)!.label}'로 평가했어요.${hadQuestion ? ' 남긴 말에 답하려면 식사를 눌러 주세요.' : ''}`, fresh));
    } catch {
      toast('평가하지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
  }
  const card = (id: string, showMember: boolean, quickRate = false) => {
    const m = meals.find((x) => x.id === id)!;
    return (
      <MealCard
        key={m.id}
        meal={m}
        showMember={showMember}
        photo={m.photo_path ? { mealId: m.id, path: m.photo_path } : undefined}
        forTrainer
        onOpen={() => setSheet({ kind: 'detail', id: m.id })}
        onRate={quickRate && needsTrainer(m) ? (r) => rate(m.id, r) : undefined}
      />
    );
  };

  const titles: Record<View, string> = { check: '확인', members: '회원', community: '커뮤니티', settings: '설정' };
  // 식단의 로딩·실패는 식단 칸에만 쓴다 — 운동 목록과 회원 진입은 각자의 조회로 그린다(v2.3.0 2차 리뷰). 식단을 모르면 0이나 '기록 없음'으로 말하지 않는다
  const mealsKnown = store.fullLoaded && !(store.failed && !meals.length);
  const mealsPanel = mealsKnown ? null : store.loaded ? <StatePanel kind="failed" title="기록을 불러오지 못했어요" onRetry={() => void store.reload()} /> : <StatePanel kind="loading" />;
  const mealsStale = store.failed && <StaleNotice text="식단 기록을 새로 불러오지 못했어요." onRetry={() => void store.reload()} />;
  const renderMembers = () => {
    const rows = members.map((p) => ({ p, mine: meals.filter((m) => m.member_id === p.id) }));
    const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.p.nickname.localeCompare(b.p.nickname, 'ko');
    // 확인할 것 많은 순(2.1 — 2026-11-03 사용자 확정 시안): 답할 질문·확인할 식사가 많은 회원부터, 오늘 기록이 없는 회원은 뒤로
    const sorted = [...rows].sort(
      memberOrder === 'name'
        ? byName
        : (a, b) =>
            b.mine.filter(hasQuestion).length - a.mine.filter(hasQuestion).length ||
            b.mine.filter(needsTrainer).length - a.mine.filter(needsTrainer).length ||
            Number(b.mine.some((m) => m.eaten_on === today)) - Number(a.mine.some((m) => m.eaten_on === today)) ||
            byName(a, b),
    );
    const groups = new Set(sorted.map(({ p }) => choseongOf(p.nickname)));
    const index = [...CHOSEONG, ...(groups.has(OTHER_GROUP) ? [OTHER_GROUP] : [])];
    let lastGroup = '';
    return (
      <>
        {membersKnown && membersFailed && <StaleNotice text="회원 목록을 새로 불러오지 못했어요. 이전 목록을 보여 드려요." onRetry={loadMembers} />}
        {extrasMissed.length > 0 && <StaleNotice text={`${extrasMissed.join(' · ')} 정보를 새로 불러오지 못했어요.`} onRetry={loadMembers} />}
        {workouts.failed && <StaleNotice text="운동 기록을 불러오지 못했어요." onRetry={workouts.reload} />}
        {mealsStale}
        {members.length ? (
          // 회원별 하루 카드(2.1) · 담당 회원 수·정렬·초성 구분·바로 가기(2.3 — 트레이너 의견 11-03, 시안 design/v23-20261105)
          <div className="member-list">
            <div className="member-list-head">
              <b>담당 회원 {members.length}명</b>
              <span className="tiny member-day-date">오늘 · {prettyDay(today, true)}</span>
            </div>
            <Segmented
              label="회원 정렬"
              value={memberOrder}
              onChange={setMemberOrder}
              options={[
                ['check', '확인할 것 많은 순'],
                ['name', '이름순'],
              ]}
            />
            {memberOrder === 'name' && (
              <div className="member-cho-bar" role="group" aria-label="초성으로 이동">
                {index.map((c) => (
                  <button key={c} type="button" disabled={!groups.has(c)} onClick={() => mainRef.current?.querySelector(`[data-cho="${c}"]`)?.scrollIntoView({ block: 'start' })}>
                    {c}
                  </button>
                ))}
              </div>
            )}
            {sorted.map(({ p, mine }) => {
              const group = choseongOf(p.nickname);
              const head = memberOrder === 'name' && group !== lastGroup;
              lastGroup = group;
              const line = workouts.lineFor(p.id);
              return (
                <Fragment key={p.id}>
                  {head && (
                    <p className="member-cho" data-cho={group}>
                      {group}
                    </p>
                  )}
                  <MemberDayCard
                    member={p}
                    meals={mine}
                    today={today}
                    streak={streaks[p.id]}
                    mealsKnown={mealsKnown}
                    workout={line}
                    records={line?.session ? workouts.records(line.session) : 0}
                    onOpen={() => openMember(p.id)}
                    onOpenMode={(mode) => openMember(p.id, mode)}
                    onNudge={() => nudgeMember(p.id)}
                    onLogged={() => void store.reload()}
                    onMessage={toast}
                  />
                </Fragment>
              );
            })}
          </div>
        ) : !membersKnown ? (
          membersFailed ? <StatePanel kind="failed" title="회원 목록을 불러오지 못했어요" onRetry={loadMembers} /> : <StatePanel kind="loading" />
        ) : (
          <StatePanel kind="empty" title="아직 담당 회원이 없어요" description="회원이 가입할 때 트레이너님을 선택하면 여기에 표시돼요." />
        )}
      </>
    );
  };
  let title = titles[view];
  let body;
  if (view === 'check') {
    // 답을 기다리는 질문이 있는 식사를 맨 위로. 건수는 필터 버튼에(요약 칸 두 개를 필터와 합침, 원칙 4)
    const list = meals
      .filter((m) => filter === 'all' || (filter === 'question' ? hasQuestion(m) : needsTrainer(m)))
      .sort((a, b) => Number(hasQuestion(b)) - Number(hasQuestion(a)));
    body = (
      <>
        {membersFailed && <StaleNotice text={membersKnown ? '회원 목록을 새로 불러오지 못했어요.' : '회원 목록을 불러오지 못했어요.'} onRetry={loadMembers} />}
        {workouts.failed && <StaleNotice text="운동 기록을 불러오지 못했어요." onRetry={workouts.reload} />}
        <NewWorkouts
          sessions={workouts.fresh}
          nameOf={(id) => members.find((m) => m.id === id)?.nickname ?? '회원'}
          records={workouts.records}
          recordsMissed={workouts.recordsMissed}
          today={today}
          onOpen={(session) => setSheet({ kind: 'workoutView', session })}
          onSeen={workouts.markSeen}
        />
        {mealsPanel ?? (
          <>
            {mealsStale}
            <Segmented
              label="식단 필터"
              value={filter}
              onChange={setFilter}
              options={[
                ['pending', `미확인 ${todo}`],
                ['question', `답변 대기 ${questions}`],
                ['all', '전체'],
              ]}
            />
            <div className="meals">
              {list.length ? (
                list.map((m) => card(m.id, true, true))
              ) : (
                <StatePanel kind="empty" title="모두 확인했어요" description="평가 버튼 하나로 확인 완료, 답글은 식사를 눌러 남겨요." />
              )}
            </div>
          </>
        )}
      </>
    );
  } else if (view === 'community') {
    body = (
      <>
        <TrainerMessageCard day={today} onSaved={() => setWordsVersion((v) => v + 1)} />
        <TrainerWordsCard today={today} version={wordsVersion} past onAll={() => setSheet({ kind: 'words' })} />
        <AwardsSection today={today} member={false} version={awardsKey} onBoard={(board) => setSheet({ kind: 'board', board })} onHistory={() => setSheet({ kind: 'awards' })} />
        <SharedMeals onOpen={(meal) => setSheet({ kind: 'sharedMeal', meal })} />
      </>
    );
  } else if (view === 'settings') {
    body = <SettingsPanel profile={profile} detail={membersKnown ? `담당 회원 ${members.length}명` : membersFailed ? '담당 회원을 불러오지 못했어요' : '담당 회원 확인 중'} onOpen={(k) => setSheet({ kind: k })} />;
  } else if (selectedMember) {
    const list = meals.filter((m) => m.member_id === selectedMember);
    // 이 회원의 식단: 회원 단위 조회가 끝났으면 그 값을, 아니면 전체 조회로 받아 둔 값을 쓴다. 둘 다 없으면 0이나 '기록 없음'으로 말하지 않는다
    const memberLoad = store.memberLoads[selectedMember];
    const memberMealsPanel =
      memberLoad === 'ok' || (mealsKnown && (list.length > 0 || !memberLoad)) ? null : memberLoad === 'failed' ? (
        <StatePanel kind="failed" title="기록을 불러오지 못했어요" onRetry={() => void store.loadMember(selectedMember)} />
      ) : (
        <StatePanel kind="loading" />
      );
    title = `${person?.nickname ?? ''} 회원`;
    let lastDay = '';
    const confirmRemove = confirmRemoveFor === selectedMember;
    body = (
      <>
        <button className="back-button" onClick={backToMembers}>
          <Icon name="left" /> 담당 회원으로
        </button>
        <Segmented
          label="회원 화면"
          value={memberMode}
          onChange={setMemberMode}
          options={[
            ['meals', '식단'],
            ['routine', '루틴'],
            ['records', '운동 기록'],
            ['inbody', '인바디'],
          ]}
        />
        {memberMode === 'routine' || memberMode === 'records' ? (
          // 루틴·운동 기록은 같은 자리에 같은 부품 — 탭을 바꿔도 다시 받지 않는다
          <TrainerWorkoutPanel
            memberId={selectedMember}
            version={workoutVersion}
            mode={memberMode}
            onEditRoutine={(memberId, current, initial) => setSheet({ kind: 'routine', memberId, current, initial })}
            onOpenSession={(session) => setSheet({ kind: 'workoutView', session })}
            onLinkSheet={(data) => setSheet({ kind: 'sheetLink', memberId: selectedMember, link: data.sheet })}
            onFind={(memberId) => setSheet({ kind: 'exerciseFind', memberId })}
            onMemo={(memberId, name) => setSheet({ kind: 'exerciseFind', memberId, initial: { target: { type: 'strength', key: exerciseKey(name), name }, editMemo: true } })}
            onError={toast}
          />
        ) : memberMode === 'inbody' ? (
          // 인바디: 최근 측정 → 그래프 → 지난 측정 이후의 변화 → 날짜별 기록
          <InbodyPanel
            inbody={inbody}
            canEdit={false}
            pinned={
              <>
                {fasting.failed && <StaleNotice text="공복 체중 기록을 불러오지 못했어요." onRetry={fasting.reload} />}
                <InbodyChart records={inbody.records} fasting={fasting.list} known={inbody.loaded && !(inbody.failed && !inbody.records.length)} />
              </>
            }
          >
            {selectedMember && inbody.records.length > 0 && <InbodyReports memberId={selectedMember} inbody={inbody} mealsKey={memberMealsKey} onOpen={(cur, prev) => setSheet({ kind: 'report', memberId: selectedMember, cur, prev })} />}
          </InbodyPanel>
        ) : memberMealsPanel ? (
          memberMealsPanel
        ) : (
          <>
            {/* 전체 조회로 받은 식사만 있다: 기본 범위는 14일이라 60일 전부가 아니다 */}
            {memberLoad === 'failed' && <StaleNotice text={`최근 ${WINDOW_DAYS}일 식단 기록을 모두 불러오지 못했어요.`} onRetry={() => void store.loadMember(selectedMember)} />}
            <Section title={`최근 ${WINDOW_DAYS}일 식사`} count={list.length}>
              <div className="meals">
                {list.length ? (
                  list.map((m) => {
                    const header = m.eaten_on !== lastDay;
                    lastDay = m.eaten_on;
                    return (
                      <div key={m.id}>
                        {header && <p className="hint day-header">{m.eaten_on === today ? '오늘' : prettyDay(m.eaten_on, true)}</p>}
                        {card(m.id, false)}
                      </div>
                    );
                  })
                ) : (
                  <StatePanel kind="empty" title="아직 기록이 없어요" description="회원이 식단을 남기면 여기에 표시돼요." />
                )}
              </div>
            </Section>
          </>
        )}
        <div className="remove-member">
          <button
            className={`text-button ${confirmRemove ? 'danger' : ''}`}
            data-testid="remove-member"
            disabled={removing}
            onClick={async () => {
              if (!confirmRemove) return setConfirmRemoveFor(selectedMember);
              setRemoving(true);
              try {
                await removeMember(selectedMember);
                toast(`${person?.nickname ?? ''} 회원을 담당에서 내보냈어요. 회원의 기록은 그대로 남아요.`);
                setSelectedMember(null);
                setMembersVersion((v) => v + 1);
                void store.reload();
                void activity.reload();
              } catch {
                toast('내보내지 못했어요. 잠시 후 다시 시도해 주세요.');
              } finally {
                setRemoving(false);
                setConfirmRemoveFor(null);
              }
            }}
          >
            {confirmRemove ? '한 번 더 누르면 담당에서 내보내요' : '담당에서 내보내기'}
          </button>
          {confirmRemove && <p className="tiny">내보내면 이 회원의 기록을 더 볼 수 없고, 회원은 다른 트레이너를 고르게 돼요.</p>}
        </div>
      </>
    );
  } else {
    body = renderMembers();
  }

  const close = () => setSheet(null);
  // 저장 같은 비동기 작업이 끝났을 때 닫거나 옮길 수 있는 창은 그 작업을 시작한 창(이 렌더의 sheet 객체)뿐이다.
  // 그사이 사용자가 창을 닫고 다른 창(새 식단 초안 등)을 열었으면 그 창은 건드리지 않는다(Codex v2.0.0 3차 리뷰 2)
  const sheetNow = sheet;
  const closeMine = () => setSheet((cur) => (cur === sheetNow ? null : cur));
  const replaceMine = (next: SheetState) => setSheet((cur) => (cur === sheetNow ? next : cur));
  let sheetTitle = '';
  let sheetBody = null;
  if (sheet?.kind === 'detail' && sheetMeal) {
    sheetTitle = `${sheetMeal.member_nickname}님의 ${sheetMeal.meal_type} 기록`;
    sheetBody = (
      <MealDetail
        meal={sheetMeal}
        role="trainer"
        trainerName={profile.nickname}
        photo={sheetMeal.photo_path ? { mealId: sheetMeal.id, path: sheetMeal.photo_path } : undefined}
        onRate={(r) => rate(sheetMeal.id, r)}
        share={{
          consent: consent ? (consent[sheetMeal.member_id] ?? false) : null,
          onToggle: async (on) => {
            try {
              await shareMeal(sheetMeal.id, on);
              const fresh = await store.refreshAfterSave(sheetMeal.id);
              toast(savedNote(on ? '추천 식단으로 공유했어요. 일주일 동안 다른 회원들에게 보여요.' : '공유를 풀었어요.', fresh));
            } catch {
              toast('처리하지 못했어요. 회원이 공유를 껐을 수 있어요.');
              loadMembers();
            }
          },
        }}
        onReview={async () => {
          const withoutReply = hasQuestion(sheetMeal);
          try {
            await markReviewed(sheetMeal.id);
            const fresh = await store.refreshAfterSave(sheetMeal.id);
            void activity.reload();
            toast(savedNote(withoutReply ? '답변 없이 확인했어요. 회원이 새로 말을 남기면 다시 올라와요.' : '확인 완료로 표시했어요.', fresh));
          } catch {
            toast('처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
          }
        }}
        onComment={async (text) => {
          try {
            await addComment(sheetMeal.id, text);
            const fresh = await store.refreshAfterSave(sheetMeal.id);
            void activity.reload();
            toast(savedNote('피드백을 남겼어요. 회원 화면에 새 피드백으로 표시됩니다.', fresh));
            return true;
          } catch {
            toast('보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
            return false;
          }
        }}
      />
    );
  } else if (sheet?.kind === 'appFeedback') {
    sheetTitle = '의견 보내기';
    sheetBody = <FeedbackForm screen={`트레이너 ${titles[view]}`} onDone={closeMine} />;
  } else if (sheet?.kind === 'pin') {
    sheetTitle = 'PIN 바꾸기';
    sheetBody = <PinChangeForm uid={profile.id} onDone={closeMine} />;
  } else if (sheet?.kind === 'nickname') {
    sheetTitle = '닉네임 바꾸기';
    sheetBody = <NicknameChangeForm profile={profile} onDone={closeMine} />;
  } else if (sheet?.kind === 'activity') {
    sheetTitle = '알림 목록';
    sheetBody = <ActivityList activity={activity} onOpen={(id) => void openFromActivity(id)} />;
  } else if (sheet?.kind === 'push') {
    sheetTitle = '알림 설정';
    sheetBody = <PushSettings profile={profile} />;
  } else if (sheet?.kind === 'recovery') {
    sheetTitle = '복구 질문';
    sheetBody = <RecoverySetupForm onDone={closeMine} />;
  } else if (sheet?.kind === 'releases') {
    sheetTitle = '업데이트 소식';
    sheetBody = <ReleaseNotes />;
  } else if (sheet?.kind === 'install') {
    sheetTitle = '홈 화면에 추가하기';
    sheetBody = <InstallHint />;
  } else if (sheet?.kind === 'guide') {
    sheetTitle = '사용 안내';
    sheetBody = (
      <StartGuide
        role="trainer"
        onOpenPush={() => replaceMine({ kind: 'push' })}
        onDone={closeMine}
        onConnectSheet={() => {
          // 시트는 회원마다 따로 — 회원을 고른 뒤 루틴의 '운동 시트 연결'에서(2026-11-03 사용자 요청: 설명과 연결 화면을 잇는다)
          closeMine();
          go('members');
          toast('회원을 고른 뒤 루틴 → 운동 시트 연결에서 연결해요.');
        }}
      />
    );
  } else if (sheet?.kind === 'sharedMeal') {
    sheetTitle = '이번 주 추천 식단';
    sheetBody = <SharedMealDetail meal={sheet.meal} />;
  } else if (sheet?.kind === 'whatsNew') {
    sheetTitle = `새 기능 안내 · ${WHATS_NEW_VERSION}`;
    sheetBody = (
      <WhatsNew
        role="trainer"
        onDone={closeMine}
        onGo={(to) => {
          closeMine();
          go(to === 'members' || to === 'check' ? to : 'community');
        }}
      />
    );
  } else if (sheet?.kind === 'words') {
    sheetTitle = '트레이너 한마디';
    sheetBody = <TrainerWordsList today={today} />;
  } else if (sheet?.kind === 'report') {
    sheetTitle = `${members.find((m) => m.id === sheet.memberId)?.nickname ?? '회원'} 회원 · 변화 보고서`;
    sheetBody = <ChangeReport memberId={sheet.memberId} cur={sheet.cur} prev={sheet.prev} canWrite />;
  } else if (sheet?.kind === 'nudge') {
    sheetTitle = '아직 안 한 설정이 있어요';
    sheetBody = <SetupNudge items={sheet.items} member={false} onPush={() => replaceMine({ kind: 'push' })} onSheet={closeMine} onClose={closeMine} />;
  } else if (sheet?.kind === 'board') {
    sheetTitle = boardTitle(sheet.board, today);
    sheetBody = <AwardBoardView board={sheet.board} today={today} member={false} version={awardsKey} />;
  } else if (sheet?.kind === 'awards') {
    sheetTitle = '지난 수상';
    sheetBody = <AwardHistory today={today} />;
  } else if (sheet?.kind === 'routine') {
    sheetTitle = sheet.current ? '새 루틴 만들기' : '루틴 등록하기';
    sheetBody = (
      <RoutineForm
        memberId={sheet.memberId}
        current={sheet.current}
        initial={sheet.initial}
        onError={toast}
        onSaved={() => {
          closeMine();
          toast('루틴을 저장했어요. 회원 운동 탭에 보여요.');
          setWorkoutVersion((v) => v + 1);
        }}
      />
    );
  } else if (sheet?.kind === 'sheetLink') {
    sheetTitle = '운동 시트 연결';
    sheetBody = (
      <SheetLinkForm
        role="trainer"
        memberId={sheet.memberId}
        link={sheet.link}
        onError={toast}
        onDone={(msg) => {
          closeMine();
          toast(msg);
          setWorkoutVersion((v) => v + 1);
        }}
      />
    );
  } else if (sheet?.kind === 'workoutView') {
    sheetTitle = `${members.find((m) => m.id === sheet.session.member_id)?.nickname ?? ''} 회원의 운동 기록`;
    sheetBody = <WorkoutForm memberId={sheet.session.member_id} viewer="trainer" data={null} session={sheet.session} readOnly onSaved={() => {}} onError={toast} />;
  } else if (sheet?.kind === 'exerciseFind') {
    const nick = members.find((m) => m.id === sheet.memberId)?.nickname ?? '';
    sheetTitle = nick ? `${nick} 회원 · 운동 찾기` : '운동 찾기';
    sheetBody = (
      <ExerciseFind
        key={sheet.memberId}
        memberId={sheet.memberId}
        viewer="trainer"
        initial={sheet.initial}
        onClose={closeMine}
        onError={toast}
        onOpenDay={(session) => replaceMine({ kind: 'workoutView', session })}
      />
    );
  }

  return (
    <>
      <Shell
        title={title}
        active={view}
        onTab={(id) => go(id as View)}
        mainRef={mainRef}
        under={swiping && view === 'members' && selectedMember && !sheet ? <SwipeUnder title={titles.members} anchor={`[data-member="${selectedMember}"]`}>{renderMembers()}</SwipeUnder> : null}
        bell={{ dot: activity.unread > 0, onClick: () => setSheet({ kind: 'activity' }) }}
        onHelp={() => setSheet({ kind: 'guide' })}
        tabs={[
          { id: 'check', icon: 'list', label: '확인', count: mealsKnown ? todo : 0, dot: mealsKnown && questions > 0 },
          { id: 'members', icon: 'user', label: '회원' },
          { id: 'community', icon: 'people', label: '커뮤니티' },
          { id: 'settings', icon: 'gear', label: '설정' },
        ]}
      >
        {body}
      </Shell>
      <Sheet open={!!sheetBody} title={sheetTitle} onClose={close}>
        {sheetBody}
      </Sheet>
    </>
  );
}
