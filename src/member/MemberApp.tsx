import { useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from '../components/Shell';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { Empty, Loading, MealCard, RatingChip } from '../components/Bits';
import { MealForm } from '../components/MealForm';
import { MealDetail } from '../components/MealDetail';
import { AccountPanel, FeedbackLink } from '../components/AccountPanel';
import { FeedbackForm } from '../components/FeedbackForm';
import { ReleaseNotes, VersionLine } from '../components/ReleaseNotes';
import { NicknameChangeForm, PinChangeForm, RecoverySetupForm } from '../components/PinForms';
import { PushSettings } from '../components/PushSettings';
import { ActivityList } from '../components/Activity';
import { useActivity } from '../lib/activity';
import { usePushOpen } from '../lib/pushOpen';
import { useMealStore } from '../components/useMealStore';
import { useToast } from '../components/Toast';
import { addComment, createMeal, deleteMeal, fetchMyStreak, fetchMyTrainerName, markSeen, updateMeal, type Streak } from '../lib/api';
import { StreakLine, TodayWord } from '../components/Motivation';
import { InbodyForm, InbodyPanel, RecordSwitch } from '../components/Inbody';
import { InbodyReports } from '../components/InbodyReports';
import { useInbody } from '../components/useInbody';
import { prettyDay, shiftDay, todayKey, weekdayShort } from '../lib/dates';
import { hasNewFeedback, hasTrainerFeedback, lastTrainerComment } from '../lib/status';
import type { InbodyRecord, MealType, Profile } from '../lib/types';

type View = 'today' | 'history' | 'feedback' | 'me';
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
  | null;

const SAVE_ERROR = '저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.';

export function MemberApp({ profile }: { profile: Profile }) {
  const toast = useToast();
  const store = useMealStore('member');
  const { meals, photoUrls } = store;
  const [view, setView] = useState<View>('today');
  const [selectedDate, setSelectedDate] = useState(todayKey());
  const [sheet, setSheet] = useState<SheetState>(null);
  const [recordMode, setRecordMode] = useState<'meals' | 'inbody'>('meals');
  const inbody = useInbody(profile.id, view === 'history' && recordMode === 'inbody');
  // 식사 추가·삭제·날짜 변경·평가가 바뀌면 변화 카드의 식단 평가 평균을 다시 받는다
  const mealsKey = useMemo(() => meals.map((m) => `${m.id}:${m.eaten_on}:${m.rating ?? ''}`).join(','), [meals]);
  const [trainerName, setTrainerName] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const today = todayKey();
  const openReleases = () => setSheet({ kind: 'releases' });
  const activity = useActivity(profile.id);

  useEffect(() => {
    fetchMyTrainerName().then(setTrainerName).catch(() => {});
  }, []);

  // 기록한 날이 바뀔 때(추가·삭제·날짜 수정)만 연속 기록을 다시 센다
  const [streak, setStreak] = useState<Streak | null>(null);
  const loggedDays = useMemo(() => [...new Set(meals.map((m) => m.eaten_on))].sort().join(','), [meals]);
  useEffect(() => {
    if (!store.loaded) return;
    fetchMyStreak(today).then(setStreak).catch(() => {});
  }, [loggedDays, today, store.loaded]);

  const unread = useMemo(() => meals.filter(hasNewFeedback).length, [meals]);
  const sheetMeal = sheet && 'id' in sheet ? meals.find((m) => m.id === sheet.id) : undefined;

  const go = (v: View) => {
    setView(v);
    mainRef.current?.scrollTo(0, 0);
  };
  // 알림을 눌러 열면 그 화면으로(작성 중인 시트는 닫지 않는다)
  usePushOpen(profile.id, (screen) => go(screen === 'feedback' ? 'feedback' : 'today'));

  // 알림 목록에서 누른 소식: 그 식사 상세로(지금 불러온 범위 밖이면 그 식사만 따로 불러온다)
  async function openFromActivity(id: string) {
    const meal = meals.find((m) => m.id === id) ?? (await store.refreshMeal(id).catch(() => null));
    if (!meal) return toast('이 식사는 지금 볼 수 없어요.');
    setSheet({ kind: 'detail', id });
    if (hasNewFeedback(meal)) {
      try {
        await markSeen(id);
        await store.refreshMeal(id);
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
        await store.refreshMeal(id);
      } catch {
        /* 읽음 표시는 다음에 다시 시도된다 */
      }
    }
  }

  const headers: Record<View, [string, string]> = {
    today: ['오늘의 식단', '한 끼씩 남기고, 함께 돌아봐요.'],
    history: ['나의 기록', '지난 식사를 천천히 살펴보세요.'],
    feedback: ['받은 피드백', '트레이너와 나눈 이야기를 모았어요.'],
    me: ['내 정보', '계정과 앱 설정을 확인해요.'],
  };

  const card = (id: string) => {
    const m = meals.find((x) => x.id === id)!;
    return <MealCard key={m.id} meal={m} photoUrl={m.photo_path ? photoUrls[m.photo_path] : undefined} onOpen={() => void openDetail(m.id)} />;
  };

  let body;
  if (!store.loaded) body = <Loading />;
  else if (store.failed && !meals.length)
    body = (
      <Empty
        title="기록을 불러오지 못했어요"
        description="연결을 확인한 뒤 다시 시도해 주세요."
        action={<button className="secondary" onClick={() => void store.reload()}>다시 불러오기</button>}
      />
    );
  else if (view === 'today') {
    const list = meals.filter((m) => m.eaten_on === today);
    const has = (t: string) => list.some((m) => m.meal_type === t);
    body = (
      <>
        <div className="date-line">
          <span>{prettyDay(today, true)}</span>
          <span className="tiny">오늘</span>
        </div>
        <div className="daily-summary">
          <div className="summary-top">
            <Icon name="book" /> {profile.nickname}님의 식사 기록
          </div>
          <strong>오늘 {list.length}끼를 기록했어요.</strong>
          <div className="meal-progress">
            {['아침', '점심', '저녁'].map((t) => (
              <div key={t} className={`progress-item ${has(t) ? 'done' : ''}`}>
                {has(t) ? '✓ ' : ''}
                {t}
              </div>
            ))}
          </div>
          <StreakLine streak={streak} />
        </div>
        <button className="primary full" onClick={() => setSheet({ kind: 'add' })}>
          <Icon name="plus" /> 식단 기록하기
        </button>
        <div className="section-title">
          <h3>
            오늘 남긴 식단 <span className="count">{list.length}</span>
          </h3>
          <button className="text-button" onClick={() => go('history')}>
            전체 기록 <Icon name="right" />
          </button>
        </div>
        <div className="meals">
          {list.length ? list.map((m) => card(m.id)) : <Empty title="아직 기록한 식사가 없어요" description="첫 식사를 남겨보세요." />}
        </div>
        {!has('저녁') && (
          <button className="empty-slot" onClick={() => setSheet({ kind: 'add', type: '저녁' })}>
            <span>저녁을 드셨다면 기록해 주세요.</span>
            <Icon name="plus" />
          </button>
        )}
        <p className="hint">기록을 누르면 트레이너 피드백을 확인할 수 있어요.</p>
        <FeedbackLink onClick={() => setSheet({ kind: 'appFeedback' })} />
        <VersionLine onClick={openReleases} />
      </>
    );
  } else if (view === 'history' && recordMode === 'inbody') {
    body = (
      <>
        <RecordSwitch value={recordMode} onChange={setRecordMode} />
        <InbodyPanel inbody={inbody} canEdit onAdd={() => setSheet({ kind: 'inbody' })} onEdit={(r) => setSheet({ kind: 'inbody', record: r })}>
          <InbodyReports memberId={profile.id} records={inbody.records} mealsKey={mealsKey} />
        </InbodyPanel>
      </>
    );
  } else if (view === 'history') {
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(today, i - 6));
    const list = meals.filter((m) => m.eaten_on === selectedDate);
    body = (
      <>
        <RecordSwitch value={recordMode} onChange={setRecordMode} />
        <div className="history-picker">
          <label htmlFor="history-date">날짜 선택</label>
          <input
            id="history-date"
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
              <span className="day-dot" style={{ opacity: meals.some((m) => m.eaten_on === d) ? 0.6 : 0 }} />
            </button>
          ))}
        </div>
        <div className="section-title">
          <h3>
            {prettyDay(selectedDate)} <span className="count">{list.length}끼</span>
          </h3>
          <button className="text-button" onClick={() => setSheet({ kind: 'add', date: selectedDate })}>
            <Icon name="plus" /> 기록 추가
          </button>
        </div>
        <div className="meals">
          {list.length ? (
            list.map((m) => card(m.id))
          ) : (
            <Empty
              title="이날은 기록이 없어요"
              description="기억나는 식사가 있다면 남겨보세요."
              action={
                <button className="secondary" onClick={() => setSheet({ kind: 'add', date: selectedDate })}>
                  <Icon name="plus" /> 식단 기록하기
                </button>
              }
            />
          )}
        </div>
      </>
    );
  } else if (view === 'me') {
    body = (
      <AccountPanel
        profile={profile}
        detail={trainerName ? `담당 트레이너 · ${trainerName}` : '담당 트레이너 확인 중'}
        onFeedback={() => setSheet({ kind: 'appFeedback' })}
        onReleases={openReleases}
        onChangePin={() => setSheet({ kind: 'pin' })}
        onChangeNickname={() => setSheet({ kind: 'nickname' })}
        onNotifications={() => setSheet({ kind: 'push' })}
        onRecovery={() => setSheet({ kind: 'recovery' })}
      />
    );
  } else {
    const list = meals.filter(hasTrainerFeedback);
    body = (
      <>
        <div className="date-line">
          <span>식사에 도착한 피드백</span>
          <span className="tiny">{list.length}개</span>
        </div>
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
          <Empty title="새 피드백을 기다리고 있어요" description="트레이너의 답변이 오면 여기에 모아드려요." />
        )}
      </>
    );
  }

  const close = () => setSheet(null);
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
            await store.refreshMeal(id);
            close();
            setSelectedDate(input.eaten_on);
            go(input.eaten_on === todayKey() ? 'today' : 'history');
            toast(`식단을 등록했어요.${trainerName ? ` ${trainerName} 트레이너에게 전달됩니다.` : ''}`);
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
        submitLabel="수정 저장하기"
        onError={toast}
        onSubmit={async (input, photo) => {
          try {
            await updateMeal(sheetMeal, input, photo);
            await store.refreshMeal(sheetMeal.id);
            setSheet({ kind: 'detail', id: sheetMeal.id });
            toast('수정했어요.');
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
        onComment={async (text) => {
          try {
            await addComment(sheetMeal.id, text);
            await store.refreshMeal(sheetMeal.id);
            toast('질문을 남겼어요. 트레이너에게 답변 대기로 표시됩니다.');
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
            close();
            toast('식단을 삭제했어요.');
          } catch {
            toast('삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
          }
        }}
      />
    );
  } else if (sheet?.kind === 'appFeedback') {
    sheetTitle = '의견 보내기';
    sheetBody = <FeedbackForm screen={`회원 ${headers[view][0]}`} onDone={close} />;
  } else if (sheet?.kind === 'pin') {
    sheetTitle = 'PIN 바꾸기';
    sheetBody = <PinChangeForm uid={profile.id} onDone={close} />;
  } else if (sheet?.kind === 'nickname') {
    sheetTitle = '닉네임 바꾸기';
    sheetBody = <NicknameChangeForm profile={profile} onDone={close} />;
  } else if (sheet?.kind === 'activity') {
    sheetTitle = '알림 목록';
    sheetBody = <ActivityList activity={activity} onOpen={(id) => void openFromActivity(id)} />;
  } else if (sheet?.kind === 'push') {
    sheetTitle = '알림 설정';
    sheetBody = <PushSettings profile={profile} />;
  } else if (sheet?.kind === 'recovery') {
    sheetTitle = '복구 질문';
    sheetBody = <RecoverySetupForm onDone={close} />;
  } else if (sheet?.kind === 'inbody') {
    sheetTitle = sheet.record ? '인바디 고치기' : '인바디 기록하기';
    sheetBody = (
      <InbodyForm
        memberId={profile.id}
        initial={sheet.record}
        onError={toast}
        onDone={(msg) => {
          close();
          toast(msg);
          void inbody.reload();
        }}
      />
    );
  } else if (sheet?.kind === 'releases') {
    sheetTitle = '업데이트 소식';
    sheetBody = <ReleaseNotes />;
  }

  const [title, sub] = view === 'history' && recordMode === 'inbody' ? ['나의 기록', '인바디 변화를 한눈에 확인해요.'] : headers[view];
  return (
    <>
      <Shell
        title={title}
        sub={sub}
        active={view}
        onTab={(id) => go(id as View)}
        mainRef={mainRef}
        bell={{ dot: activity.unread > 0, onClick: () => setSheet({ kind: 'activity' }) }}
        tabs={[
          { id: 'today', icon: 'home', label: '오늘' },
          { id: 'history', icon: 'book', label: '기록' },
          { id: 'feedback', icon: 'chat', label: '피드백', dot: unread > 0 },
          { id: 'me', icon: 'user', label: '내 정보' },
        ]}
      >
        {/* 오늘의 한마디는 모든 탭 맨 위에(2026-10-26 사용자 요청). 같은 자리에 두어 탭을 바꿔도 다시 불러오지 않는다 */}
        <TodayWord day={today} trainerName={trainerName} />
        {body}
      </Shell>
      <Sheet open={!!sheetBody} title={sheetTitle} onClose={close}>
        {sheetBody}
      </Sheet>
    </>
  );
}
