import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shell, SwipeUnder } from '../components/Shell';
import { SetupNudge } from '../components/SetupNudge';
import { useSetupNudge, type SetupItem } from '../lib/setupNudge';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { MealCard, RatingChip } from '../components/Bits';
import { MealForm } from '../components/MealForm';
import { MealDetail } from '../components/MealDetail';
import { InstallHint } from '../components/AccountPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { StartGuide } from '../components/StartGuide';
import { WHATS_NEW_VERSION, firstOpenSheet } from '../lib/startGuide';
import { PrimaryAction, Section, Segmented, StatePanel } from '../ui/kit';
import { FeedbackForm } from '../components/FeedbackForm';
import { ReleaseNotes } from '../components/ReleaseNotes';
import { NicknameChangeForm, PinChangeForm, RecoverySetupForm } from '../components/PinForms';
import { PushSettings } from '../components/PushSettings';
import { ActivityList } from '../components/Activity';
import { useActivity } from '../lib/activity';
import { usePushOpen } from '../lib/pushOpen';
import { savedNote, useMealStore } from '../components/useMealStore';
import { useToast } from '../components/Toast';
import { addComment, createMeal, deleteMeal, fetchMyStreak, fetchMyTrainerName, markSeen, markSeenMany, updateMeal, type Streak } from '../lib/api';
import { DaySummary, TodayWord } from '../components/Motivation';
import { AwardPublicSetting, ChooseTrainer, ShareConsentSetting, SharedMealDetail, SharedMeals } from '../components/Community';
import { AwardBoardView, AwardHistory, AwardsSection, boardTitle, type AwardBoard } from '../components/Awards';
import { signOut } from '../lib/auth';
import { InbodyForm, InbodyPanel } from '../components/Inbody';
import { MemberWorkoutPanel, SheetLinkForm, WorkoutForm, type WorkoutData } from '../components/Workout';
import { ExerciseFind } from '../components/ExerciseFind';
import { InbodyChart } from '../components/InbodyChart';
import { FastingWeightCard, useFastingWeights } from '../components/FastingWeight';
import { TrainerWordsCard, TrainerWordsList } from '../components/TrainerWords';
import { DayRatings, MealSlots, ToneLegend } from '../components/MealDay';
import type { RoutineSheetLink, SharedMeal, WorkoutSession } from '../lib/api';
import { InbodyReports } from '../components/InbodyReports';
import { ChangeReport } from '../components/ChangeReport';
import { WhatsNew } from '../components/WhatsNew';
import { BACK_LEVEL, shellSurface, useBackLayer, useEdgeSwiping } from '../lib/backNav';
import { mayLeaveScreen } from '../lib/appUpdate';
import { useInbody } from '../components/useInbody';
import { prettyDay, shiftDay, todayKey, weekdayShort } from '../lib/dates';
import { dayTone, hasNewFeedback, hasTrainerFeedback, lastTrainerComment, latestFeedbackAt } from '../lib/status';
import type { InbodyRecord, MealType, Profile } from '../lib/types';

type View = 'meal' | 'workout' | 'community' | 'settings';
type SheetState =
  | { kind: 'add'; type?: MealType; date?: string }
  | { kind: 'edit'; id: string }
  | { kind: 'detail'; id: string }
  | { kind: 'appFeedback' }
  | { kind: 'releases' }
  | { kind: 'pin' }
  | { kind: 'nickname' }
  | { kind: 'push' }
  | { kind: 'activity' }
  | { kind: 'recovery' }
  | { kind: 'inbody'; record?: InbodyRecord }
  | { kind: 'install' }
  | { kind: 'guide' }
  | { kind: 'awards' }
  | { kind: 'board'; board: AwardBoard }
  | { kind: 'nudge'; items: SetupItem[] }
  | { kind: 'words' }
  | { kind: 'whatsNew' }
  | { kind: 'report'; cur: InbodyRecord; prev: InbodyRecord }
  | { kind: 'sharedMeal'; meal: SharedMeal }
  | { kind: 'sheetLink'; link: RoutineSheetLink | null }
  | { kind: 'workout'; data: WorkoutData; session: WorkoutSession | null; dayNo?: number | null }
  | { kind: 'exerciseFind'; data: WorkoutData }
  | null;

const SAVE_ERROR = '저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.';

export function MemberApp({ profile }: { profile: Profile }) {
  const toast = useToast();
  const store = useMealStore('member');
  const { meals, photoUrls } = store;
  const [view, setView] = useState<View>('meal');
  const [selectedDate, setSelectedDate] = useState(todayKey());
  const [sheet, setSheet] = useState<SheetState>(null);
  const sheetRef = useRef<SheetState>(null);
  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);
  // 시작 안내·새 기능 소개: 이 기기에서 처음 열면 한 번(다른 창이 열려 있으면 그 창을 둔다)
  useEffect(() => {
    const kind = firstOpenSheet();
    if (kind) setSheet((cur) => cur ?? { kind });
  }, []);
  // 식단 탭 안: 날짜별 식단 / 받은 피드백 · 운동 탭 안: 루틴 / 운동 기록 / 인바디(2.1 — 인바디와 변화를 한 탭으로, 2026-11-03 사용자 확정)
  const [mealMode, setMealMode] = useState<'day' | 'feedback'>('day');
  const [workoutMode, setWorkoutMode] = useState<'routine' | 'records' | 'inbody'>('routine');
  const [workoutVersion, setWorkoutVersion] = useState(0); // 운동 기록을 저장·삭제하면 올려 다시 받는다
  const inbody = useInbody(profile.id, view === 'workout' && workoutMode === 'inbody');
  const fasting = useFastingWeights(profile.id, view === 'workout' && workoutMode === 'inbody');
  // 식사 추가·삭제·날짜 변경·평가가 바뀌면 변화 카드의 식단 평가 평균을 다시 받는다
  const mealsKey = useMemo(() => meals.map((m) => `${m.id}:${m.eaten_on}:${m.rating ?? ''}`).join(','), [meals]);
  // 담당 트레이너: undefined = 아직 모름(조회 중·실패), null = 담당 없음(내보내짐 → 다시 고르기 화면)
  const [trainer, setTrainer] = useState<string | null | undefined>(undefined);
  const trainerName = trainer ?? '';
  const mainRef = useRef<HTMLElement>(null);
  const today = todayKey();
  const activity = useActivity(profile.id);
  useSetupNudge(profile.id, true, typeof trainer === 'string', (items) => setSheet({ kind: 'nudge', items }));

  const trainerReq = useRef(0);
  const loadTrainer = useCallback(() => {
    const n = ++trainerReq.current;
    fetchMyTrainerName()
      .then((t) => n === trainerReq.current && setTrainer(t))
      .catch(() => {});
  }, []);
  // 앱을 쓰는 중에 내보내질 수 있어 앞으로 올 때마다 다시 확인한다
  useEffect(() => {
    loadTrainer();
    const onVisible = () => document.visibilityState === 'visible' && loadTrainer();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadTrainer]);

  // 기록한 날이 바뀔 때(추가·삭제·날짜 수정)만 연속 기록을 다시 센다.
  // 앞선 조회가 늦게 끝나도 최신 배지를 덮지 않게 다시 세기 시작하면 앞 응답은 버리고, 응답은 센 날짜와 함께 둔다
  // (Codex v2.0.1 4차 리뷰: 오늘 기록 뒤 '연속 8일'이 늦게 온 옛 응답으로 '어제까지 7일'로 되돌아갔다)
  const [streak, setStreak] = useState<{ day: string; value: Streak } | null>(null);
  const loggedDays = useMemo(() => [...new Set(meals.map((m) => m.eaten_on))].sort().join(','), [meals]);
  useEffect(() => {
    if (!store.loaded) return;
    let current = true;
    fetchMyStreak(today)
      .then((value) => current && setStreak({ day: today, value }))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [loggedDays, today, store.loaded]);
  const todayStreak = streak?.day === today ? streak.value : null;

  const unread = useMemo(() => meals.filter(hasNewFeedback).length, [meals]);
  const sheetMeal = sheet && 'id' in sheet ? meals.find((m) => m.id === sheet.id) : undefined;

  const go = (v: View) => {
    setView(v);
    mainRef.current?.scrollTo(0, 0);
  };
  useBackLayer(view !== 'meal', () => {
    if (!mayLeaveScreen()) return false;
    go('meal');
  });
  const goMeal = (mode: 'day' | 'feedback') => {
    setMealMode(mode);
    mainRef.current?.scrollTo(0, 0);
  };
  useBackLayer(view === 'meal' && mealMode === 'feedback', () => goMeal('day'), { level: BACK_LEVEL.screen, surface: shellSurface });
  const swiping = useEdgeSwiping();
  // 알림을 눌러 열면 그 화면으로(작성 중인 시트는 닫지 않는다)
  // 피드백 알림은 식단 탭의 받은 피드백으로, 그 밖(아침 응원·끼니 알림)은 식단 탭 첫 화면으로
  usePushOpen(profile.id, (screen) => {
    go('meal');
    setMealMode(screen === 'feedback' ? 'feedback' : 'day');
    if (screen !== 'feedback') setSelectedDate(todayKey());
  });

  // 알림 목록에서 누른 소식: 그 식사 상세로(지금 불러온 범위 밖이면 그 식사만 따로 불러온다)
  async function openFromActivity(id: string) {
    const meal = meals.find((m) => m.id === id) ?? (await store.refreshMeal(id).catch(() => null));
    if (!meal) return toast('이 식사는 지금 볼 수 없어요.');
    setSheet({ kind: 'detail', id });
    if (hasNewFeedback(meal)) {
      try {
        await markSeen(id);
        await store.refreshAfterSave(id);
        void activity.reload(); // 그 식사를 읽었으니 종 버튼 점도 다시 맞춘다
      } catch {
        /* 읽음 표시는 다음에 다시 시도된다 */
      }
    }
  }

  async function openDetail(id: string) {
    setSheet({ kind: 'detail', id });
    const meal = meals.find((m) => m.id === id);
    if (meal && hasNewFeedback(meal)) {
      try {
        await markSeen(id);
        await store.refreshAfterSave(id);
        void activity.reload(); // 그 식사를 읽었으니 종 버튼 점도 다시 맞춘다
      } catch {
        /* 읽음 표시는 다음에 다시 시도된다 */
      }
    }
  }

  // 피드백 탭 '모두 읽음'(v1.8.2 회원 의견): 지금 새 피드백으로 보이는 식사들만, 보이는 가장 늦은 피드백 시각까지.
  // 누르는 사이 새로 온 피드백은 새 피드백으로 남는다. 저장 중에는 버튼을 잠근다
  const [markingAll, setMarkingAll] = useState(false);
  async function markAllRead() {
    const fresh = meals.filter(hasNewFeedback);
    const times = fresh.map(latestFeedbackAt).filter((t): t is string => !!t);
    if (!fresh.length || !times.length || markingAll) return;
    const through = times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    setMarkingAll(true);
    try {
      await markSeenMany(
        fresh.map((m) => m.id),
        through,
      );
      await store.reload();
      void activity.reload(); // 평가·답글 소식도 확인함으로 바뀐다
      toast('피드백을 모두 읽음으로 표시했어요.');
    } catch {
      toast('읽음으로 표시하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setMarkingAll(false);
    }
  }

  const titles: Record<View, string> = { meal: '식단', workout: '운동', community: '커뮤니티', settings: '설정' };

  const card = (id: string) => {
    const m = meals.find((x) => x.id === id)!;
    return <MealCard key={m.id} meal={m} photoUrl={m.photo_path ? photoUrls[m.photo_path] : undefined} onOpen={() => void openDetail(m.id)} />;
  };

  // 왼쪽 끝을 밀 때 받은 피드백 아래에도 같은 화면을 깐다
  const renderDay = () => {
    const list = meals.filter((m) => m.eaten_on === selectedDate);
    // 주간 달력: 고른 날이 최근 7일 안이면 오늘까지의 7일, 더 예전이면 그날까지의 7일
    const anchor = selectedDate >= shiftDay(today, -6) ? today : selectedDate;
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(anchor, i - 6));
    const isToday = selectedDate === today;
    return (
      <>
        <TodayWord day={today} trainerName={trainerName} />
        <div className="date-head">
          <strong>{prettyDay(selectedDate, true)}</strong>
          <label className="calendar-pick" aria-label="날짜 고르기">
            <Icon name="calendar" />
            <input
              type="date"
              value={selectedDate}
              max={today}
              onChange={(e) => {
                const v = e.target.value;
                if (v && v <= today) {
                  setSelectedDate(v);
                  void store.loadDay(v);
                }
              }}
            />
          </label>
        </div>
        <div className="week-strip">
          {days.map((d) => (
            <button
              key={d}
              className={`day-button ${d === selectedDate ? 'selected' : ''}`}
              aria-pressed={d === selectedDate}
              aria-label={`${prettyDay(d)} 기록`}
              onClick={() => setSelectedDate(d)}
            >
              <span>{weekdayShort(d)}</span>
              <strong>{Number(d.slice(-2))}</strong>
              {/* 그날 트레이너 평가 색(평가 없이 기록만 있으면 옅은 점) — 2.1 식단 시안 */}
              <span className={`day-dot ${dayTone(meals.filter((m) => m.eaten_on === d))}`} style={{ opacity: meals.some((m) => m.eaten_on === d) ? undefined : 0 }} />
            </button>
          ))}
        </div>
        {days.some((d) => ['great', 'good', 'care'].includes(dayTone(meals.filter((m) => m.eaten_on === d)))) && <ToneLegend />}
        <DaySummary label={isToday ? '오늘' : prettyDay(selectedDate)} count={list.length} streak={isToday ? todayStreak : null} />
        <DayRatings label={isToday ? '오늘' : prettyDay(selectedDate)} meals={list} />
        <button type="button" className="feedback-entry" data-testid="feedback-entry" onClick={() => goMeal('feedback')}>
          <Icon name="chat" />
          <span>받은 피드백</span>
          {unread > 0 && <span className="count-badge">{unread}</span>}
          <Icon name="right" />
        </button>
        <Section title={isToday ? '오늘의 식단' : `${prettyDay(selectedDate)} 식단`} count={list.length}>
          {/* 끼니 칸(아침·점심·저녁·간식): 빈 끼니는 그 끼니·그 날짜로 바로 기록 — 2.1 식단 시안 */}
          <MealSlots meals={list} card={card} onAdd={(type) => setSheet({ kind: 'add', type, date: selectedDate })} />
        </Section>
      </>
    );
  };

  let body;
  let action = null;
  if (view === 'meal' && !store.loaded) body = <StatePanel kind="loading" />;
  else if (view === 'meal' && store.failed && !meals.length) body = <StatePanel kind="failed" title="기록을 불러오지 못했어요" onRetry={() => void store.reload()} />;
  else if (view === 'meal' && mealMode === 'feedback') {
    const list = meals.filter(hasTrainerFeedback);
    body = (
      <>
        <button className="back-button" onClick={() => goMeal('day')}>
          <Icon name="left" /> 식단으로
        </button>
        <Section title="받은 피드백" count={list.length}>
          {unread > 0 && (
            <button type="button" className="secondary small mark-all" data-testid="mark-all-read" disabled={markingAll} onClick={() => void markAllRead()}>
              새 피드백 {unread}개 모두 읽음으로 표시
            </button>
          )}
          {list.length ? (
            list.map((m) => {
              const c = lastTrainerComment(m);
              return (
                <button key={m.id} className="feedback-card" onClick={() => void openDetail(m.id)}>
                  <span className="feedback-head">
                    <span>
                      {prettyDay(m.eaten_on)} · {m.meal_type} {m.eaten_at}
                    </span>
                    {hasNewFeedback(m) && <span className="new-badge">NEW</span>}
                  </span>
                  <h3>{m.food}</h3>
                  <RatingChip rating={m.rating} />
                  {c && <p>{c.body}</p>}
                </button>
              );
            })
          ) : (
            <StatePanel kind="empty" title="아직 받은 피드백이 없어요" description="트레이너가 평가하거나 답하면 여기에 모아 드려요." />
          )}
        </Section>
      </>
    );
  } else if (view === 'meal') {
    body = renderDay();
    action = (
      <PrimaryAction testId="add-meal" onClick={() => setSheet({ kind: 'add', date: selectedDate })}>
        <Icon name="plus" /> 식단 기록하기
      </PrimaryAction>
    );
  } else if (view === 'workout') {
    body = (
      <>
        <Segmented
          label="운동 화면"
          value={workoutMode}
          onChange={setWorkoutMode}
          options={[
            ['routine', '루틴'],
            ['records', '운동 기록'],
            ['inbody', '인바디'],
          ]}
        />
        {workoutMode !== 'inbody' ? (
          // 루틴·운동 기록은 같은 자리에 같은 부품 — 탭을 바꿔도 다시 받지 않는다
          <MemberWorkoutPanel
            memberId={profile.id}
            version={workoutVersion}
            mode={workoutMode}
            onStart={(data, session, dayNo) => setSheet({ kind: 'workout', data, session, dayNo })}
            onLinkSheet={(data) => setSheet({ kind: 'sheetLink', link: data.sheet })}
            onFind={(data) => setSheet({ kind: 'exerciseFind', data })}
            onError={toast}
          />
        ) : (
          // 인바디: 최근 측정 → 그래프 → 지난 측정 이후의 변화 → 날짜별 기록
          <InbodyPanel
            inbody={inbody}
            canEdit
            onEdit={(r) => setSheet({ kind: 'inbody', record: r })}
            pinned={
              <>
                <FastingWeightCard fasting={fasting} />
                <InbodyChart records={inbody.records} fasting={fasting.list} known={inbody.loaded && !(inbody.failed && !inbody.records.length)} />
              </>
            }
          >
            {inbody.records.length > 0 && <InbodyReports memberId={profile.id} inbody={inbody} mealsKey={mealsKey} onOpen={(cur, prev) => setSheet({ kind: 'report', cur, prev })} />}
          </InbodyPanel>
        )}
      </>
    );
    if (workoutMode === 'inbody')
      action = (
        <PrimaryAction testId="add-inbody" onClick={() => setSheet({ kind: 'inbody' })}>
          <Icon name="plus" /> 인바디 기록하기
        </PrimaryAction>
      );
  } else if (view === 'community') {
    body = (
      <>
        <TrainerWordsCard today={today} onAll={() => setSheet({ kind: 'words' })} />
        <AwardsSection today={today} member version={mealsKey} onBoard={(board) => setSheet({ kind: 'board', board })} onHistory={() => setSheet({ kind: 'awards' })} />
        <SharedMeals onOpen={(meal) => setSheet({ kind: 'sharedMeal', meal })} />
      </>
    );
  } else {
    body = (
      <SettingsPanel
        profile={profile}
        detail={trainer ? `담당 트레이너 · ${trainer}` : '담당 트레이너 확인 중'}
        onOpen={(k) => setSheet({ kind: k })}
        share={
          <>
            <ShareConsentSetting userId={profile.id} />
            <AwardPublicSetting userId={profile.id} />
          </>
        }
      />
    );
  }

  const close = () => setSheet(null);
  // 저장 같은 비동기 작업이 끝났을 때 닫거나 옮길 수 있는 창은 그 작업을 시작한 창(이 렌더의 sheet 객체)뿐이다.
  // 그사이 사용자가 창을 닫고 다른 창(새 식단 초안 등)을 열었으면 그 창은 건드리지 않는다(Codex v2.0.0 3차 리뷰 2)
  const sheetNow = sheet;
  const closeMine = () => setSheet((cur) => (cur === sheetNow ? null : cur));
  const replaceMine = (next: SheetState) => setSheet((cur) => (cur === sheetNow ? next : cur));
  const isMine = () => sheetRef.current === sheetNow;
  let sheetTitle = '';
  let sheetBody = null;
  if (sheet?.kind === 'add') {
    sheetTitle = '식단 기록하기';
    sheetBody = (
      <MealForm
        initial={{ meal_type: sheet.type, eaten_on: sheet.date }}
        submitLabel="식단 등록하기"
        onError={toast}
        onSubmit={async (input, photo) => {
          try {
            const id = await createMeal(profile.id, input, photo ?? null);
            const fresh = await store.refreshAfterSave(id);
            // 등록한 날짜로 옮기는 것은 이 창이 아직 열려 있을 때만(그사이 다른 화면으로 갔으면 그대로 둔다)
            const mine = isMine();
            closeMine();
            if (mine) {
              setSelectedDate(input.eaten_on);
              setMealMode('day');
              go('meal');
            }
            toast(savedNote(`식단을 등록했어요.${trainerName ? ` ${trainerName} 트레이너에게 전달됩니다.` : ''}`, fresh));
          } catch (e) {
            console.error(e);
            toast(SAVE_ERROR);
          }
        }}
      />
    );
  } else if (sheet?.kind === 'edit' && sheetMeal) {
    sheetTitle = '식단 수정하기';
    sheetBody = (
      <MealForm
        initial={sheetMeal}
        initialPhotoUrl={sheetMeal.photo_path ? photoUrls[sheetMeal.photo_path] : undefined}
        initialPhoto={sheetMeal.photo_path ? { mealId: sheetMeal.id, path: sheetMeal.photo_path } : undefined}
        submitLabel="수정 저장하기"
        onError={toast}
        onSubmit={async (input, photo) => {
          try {
            await updateMeal(sheetMeal, input, photo);
            const fresh = await store.refreshAfterSave(sheetMeal.id);
            replaceMine({ kind: 'detail', id: sheetMeal.id });
            toast(savedNote('수정했어요.', fresh));
          } catch (e) {
            console.error(e);
            toast(SAVE_ERROR);
          }
        }}
      />
    );
  } else if (sheet?.kind === 'detail' && sheetMeal) {
    sheetTitle = `${sheetMeal.meal_type} 기록`;
    sheetBody = (
      <MealDetail
        meal={sheetMeal}
        role="member"
        trainerName={trainerName}
        photoUrl={sheetMeal.photo_path ? photoUrls[sheetMeal.photo_path] : undefined}
        photo={sheetMeal.photo_path ? { mealId: sheetMeal.id, path: sheetMeal.photo_path } : undefined}
        onComment={async (text) => {
          try {
            await addComment(sheetMeal.id, text);
            const fresh = await store.refreshAfterSave(sheetMeal.id);
            toast(savedNote('질문을 남겼어요. 트레이너에게 답변 대기로 표시됩니다.', fresh));
            return true;
          } catch (e) {
            console.error(e);
            toast(SAVE_ERROR);
            return false;
          }
        }}
        onEdit={() => setSheet({ kind: 'edit', id: sheetMeal.id })}
        onDelete={async () => {
          try {
            await deleteMeal(sheetMeal);
            store.removeLocal(sheetMeal.id);
            closeMine();
            toast('식단을 삭제했어요.');
          } catch {
            toast('삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
          }
        }}
      />
    );
  } else if (sheet?.kind === 'appFeedback') {
    sheetTitle = '의견 보내기';
    sheetBody = <FeedbackForm screen={`회원 ${titles[view]}`} onDone={closeMine} />;
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
  } else if (sheet?.kind === 'inbody') {
    sheetTitle = sheet.record ? '인바디 고치기' : '인바디 기록하기';
    sheetBody = (
      <InbodyForm
        memberId={profile.id}
        initial={sheet.record}
        onError={toast}
        onDone={(msg) => {
          closeMine();
          toast(msg);
          void inbody.reload();
        }}
      />
    );
  } else if (sheet?.kind === 'releases') {
    sheetTitle = '업데이트 소식';
    sheetBody = <ReleaseNotes />;
  } else if (sheet?.kind === 'install') {
    sheetTitle = '홈 화면에 추가하기';
    sheetBody = <InstallHint />;
  } else if (sheet?.kind === 'whatsNew') {
    sheetTitle = `새 기능 안내 · ${WHATS_NEW_VERSION}`;
    sheetBody = (
      <WhatsNew
        role="member"
        onDone={closeMine}
        onGo={(to) => {
          closeMine();
          if (to === 'community') return go('community');
          go('workout');
          setWorkoutMode(to === 'inbody' ? 'inbody' : 'records');
        }}
      />
    );
  } else if (sheet?.kind === 'guide') {
    sheetTitle = '사용 안내';
    sheetBody = <StartGuide role="member" onOpenPush={() => replaceMine({ kind: 'push' })} onDone={closeMine} onConnectSheet={() => replaceMine({ kind: 'sheetLink', link: null })} />;
  } else if (sheet?.kind === 'sheetLink') {
    sheetTitle = '운동 시트 연결';
    sheetBody = (
      <SheetLinkForm
        role="member"
        memberId={profile.id}
        link={sheet.link}
        onError={toast}
        onDone={(msg) => {
          closeMine();
          toast(msg);
          setWorkoutVersion((v) => v + 1);
        }}
      />
    );
  } else if (sheet?.kind === 'sharedMeal') {
    sheetTitle = '이번 주 추천 식단';
    sheetBody = <SharedMealDetail meal={sheet.meal} />;
  } else if (sheet?.kind === 'words') {
    sheetTitle = '트레이너 한마디';
    sheetBody = <TrainerWordsList today={today} />;
  } else if (sheet?.kind === 'report') {
    sheetTitle = '변화 보고서';
    sheetBody = <ChangeReport memberId={profile.id} cur={sheet.cur} prev={sheet.prev} />;
  } else if (sheet?.kind === 'nudge') {
    sheetTitle = '아직 안 한 설정이 있어요';
    sheetBody = <SetupNudge items={sheet.items} member onPush={() => replaceMine({ kind: 'push' })} onSheet={() => replaceMine({ kind: 'sheetLink', link: null })} onClose={closeMine} />;
  } else if (sheet?.kind === 'board') {
    sheetTitle = boardTitle(sheet.board, today);
    sheetBody = <AwardBoardView board={sheet.board} today={today} member version={mealsKey} />;
  } else if (sheet?.kind === 'awards') {
    sheetTitle = '지난 수상';
    sheetBody = <AwardHistory today={today} />;
  } else if (sheet?.kind === 'exerciseFind') {
    const data = sheet.data;
    sheetTitle = '운동 찾기';
    sheetBody = (
      <ExerciseFind
        memberId={profile.id}
        viewer="member"
        onError={toast}
        // 그날 기록은 운동 찾기가 새로 받아 넘긴다(목록 밖의 오래된 기록도). 그사이 다른 창으로 바뀌었으면 그대로 둔다
        onOpenDay={(session) => replaceMine({ kind: 'workout', data, session })}
      />
    );
  } else if (sheet?.kind === 'workout') {
    sheetTitle = sheet.session ? '운동 기록' : '운동 시작';
    sheetBody = (
      <WorkoutForm
        key={sheet.session?.id ?? 'new'}
        memberId={profile.id}
        data={sheet.data}
        session={sheet.session}
        initialDay={sheet.dayNo ?? null}
        onError={toast}
        onSaved={(msg) => {
          closeMine();
          toast(msg);
          setWorkoutVersion((v) => v + 1);
        }}
        onDeleted={() => {
          closeMine();
          toast('운동 기록을 지웠어요.');
          setWorkoutVersion((v) => v + 1);
        }}
      />
    );
  }

  // 담당에서 내보내진 회원: 트레이너를 다시 고를 때까지 이 화면만(기록은 그대로 남아 있다).
  // 쓰던 창(식단 기록·수정 등)이 열려 있으면 닫을 때까지 기다린다 — 앱 복귀 확인으로 입력 중인 내용을 날리지 않게
  if (trainer === null && !sheet)
    return (
      <div className="workspace">
        <section className="prototype splash">
          <ChooseTrainer onChosen={loadTrainer} />
          <button className="text-button" onClick={() => void signOut()}>
            로그아웃
          </button>
        </section>
      </div>
    );

  return (
    <>
      <Shell
        title={titles[view]}
        active={view}
        onTab={(id) => go(id as View)}
        mainRef={mainRef}
        under={swiping && view === 'meal' && mealMode === 'feedback' && !sheet ? <SwipeUnder title={titles.meal}>{renderDay()}</SwipeUnder> : null}
        bell={{ dot: activity.unread > 0, onClick: () => setSheet({ kind: 'activity' }) }}
        onHelp={() => setSheet({ kind: 'guide' })}
        tabs={[
          { id: 'meal', icon: 'meal', label: '식단', dot: unread > 0 },
          { id: 'workout', icon: 'dumbbell', label: '운동' },
          { id: 'community', icon: 'people', label: '커뮤니티' },
          { id: 'settings', icon: 'gear', label: '설정' },
        ]}
      >
        {body}
        {action}
      </Shell>
      <Sheet open={!!sheetBody} title={sheetTitle} onClose={close}>
        {sheetBody}
      </Sheet>
    </>
  );
}
