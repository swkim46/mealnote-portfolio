import { useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from '../components/Shell';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { Empty, Loading, MealCard } from '../components/Bits';
import { MealDetail } from '../components/MealDetail';
import { AccountPanel, FeedbackLink } from '../components/AccountPanel';
import { FeedbackForm } from '../components/FeedbackForm';
import { ReleaseNotes, VersionLine } from '../components/ReleaseNotes';
import { NicknameChangeForm, PinChangeForm, RecoverySetupForm } from '../components/PinForms';
import { useMealStore } from '../components/useMealStore';
import { useToast } from '../components/Toast';
import { addComment, fetchMemberStreaks, fetchMyMembers, markReviewed, rateMeal, WINDOW_DAYS } from '../lib/api';
import { ratingOf, type Rating } from '../lib/rating';
import { TrainerMessageCard } from '../components/Motivation';
import { InbodyPanel, RecordSwitch } from '../components/Inbody';
import { InbodyReports } from '../components/InbodyReports';
import { useInbody } from '../components/useInbody';
import { prettyDay, todayKey } from '../lib/dates';
import { hasQuestion, needsTrainer } from '../lib/status';
import { PushSettings } from '../components/PushSettings';
import { ActivityList } from '../components/Activity';
import { useActivity } from '../lib/activity';
import { usePushOpen } from '../lib/pushOpen';
import type { Profile } from '../lib/types';

type View = 'queue' | 'members' | 'me';

type Filter = 'pending' | 'question' | 'all';
type SheetState = { kind: 'detail'; id: string } | { kind: 'appFeedback' } | { kind: 'releases' } | { kind: 'pin' } | { kind: 'recovery' } | { kind: 'nickname' } | { kind: 'push' } | { kind: 'activity' } | null;

export function TrainerApp({ profile }: { profile: Profile }) {
  const toast = useToast();
  const store = useMealStore('trainer');
  const { meals, photoUrls } = store;
  const [view, setView] = useState<View>('queue');
  const [filter, setFilter] = useState<Filter>('pending');
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [recordMode, setRecordMode] = useState<'meals' | 'inbody'>('meals');
  const inbody = useInbody(selectedMember, view === 'members' && recordMode === 'inbody');
  const memberMealsKey = useMemo(
    () => meals.filter((m) => m.member_id === selectedMember).map((m) => `${m.id}:${m.eaten_on}:${m.rating ?? ''}`).join(','),
    [meals, selectedMember],
  );
  const [members, setMembers] = useState<{ id: string; nickname: string }[]>([]);
  const [streaks, setStreaks] = useState<Record<string, { current: number; today_logged: boolean }>>({});
  const [sheet, setSheet] = useState<SheetState>(null);
  const mainRef = useRef<HTMLElement>(null);
  const today = todayKey();
  const openReleases = () => setSheet({ kind: 'releases' });

  useEffect(() => {
    const load = () => {
      fetchMyMembers().then(setMembers).catch(() => {});
      fetchMemberStreaks(todayKey()).then(setStreaks).catch(() => {});
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [view]);

  const todo = useMemo(() => meals.filter(needsTrainer).length, [meals]);
  const questions = useMemo(() => meals.filter(hasQuestion).length, [meals]);
  const sheetMeal = sheet?.kind === 'detail' ? meals.find((m) => m.id === sheet.id) : undefined;
  const person = members.find((m) => m.id === selectedMember);

  const go = (v: View) => {
    setView(v);
    setSelectedMember(null);
    mainRef.current?.scrollTo(0, 0);
  };
  // 알림(확인할 소식 요약)을 눌러 열면 확인 목록으로(작성 중인 시트는 닫지 않는다)
  usePushOpen(profile.id, () => go('queue'));
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
      await store.refreshMeal(id);
      toast(`'${ratingOf(r)!.label}'로 평가했어요.${hadQuestion ? ' 남긴 말에 답하려면 식사를 눌러 주세요.' : ''}`);
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
        photoUrl={m.photo_path ? photoUrls[m.photo_path] : undefined}
        forTrainer
        onOpen={() => setSheet({ kind: 'detail', id: m.id })}
        onRate={quickRate && needsTrainer(m) ? (r) => rate(m.id, r) : undefined}
      />
    );
  };

  let title = '확인할 식단';
  let sub = '담당 회원의 기록을 놓치지 않도록.';
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
  else if (view === 'queue') {
    // 답을 기다리는 질문이 있는 식사를 맨 위로
    const list = meals
      .filter((m) => filter === 'all' || (filter === 'question' ? hasQuestion(m) : needsTrainer(m)))
      .sort((a, b) => Number(hasQuestion(b)) - Number(hasQuestion(a)));
    body = (
      <>
        <div className="date-line">
          <span>{prettyDay(today)}</span>
          <span className="tiny">담당 회원 {members.length}명</span>
        </div>
        <TrainerMessageCard day={today} />
        <div className="summary-grid">
          <div className="summary-cell">
            <span>확인이 필요한 식사</span>
            <strong>
              {todo}
              <small>건</small>
            </strong>
          </div>
          <button
            className={`summary-cell question-cell ${questions ? 'has-question' : ''}`}
            onClick={() => setFilter('question')}
            aria-label={`답을 기다리는 회원 질문 ${questions}건 보기`}
          >
            <span>답을 기다리는 질문</span>
            <strong>
              {questions}
              <small>건</small>
            </strong>
          </button>
        </div>
        <div className="filters" role="group" aria-label="식단 필터">
          {(
            [
              ['pending', '미확인'],
              ['question', '답변 대기'],
              ['all', '전체'],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button key={id} className={`filter ${filter === id ? 'active' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="meals">
          {list.length ? (
            list.map((m) => card(m.id, true, true))
          ) : (
            <Empty title="모두 확인했어요" description="새 식단이나 질문이 올라오면 여기에 표시돼요." />
          )}
        </div>
        <p className="hint">평가 버튼 하나만 눌러도 확인 완료예요. 글 피드백은 식사를 눌러 남겨 주세요. 최근 2주 기록과 처리할 기록을 보여 줍니다.</p>
        <FeedbackLink onClick={() => setSheet({ kind: 'appFeedback' })} />
        <VersionLine onClick={openReleases} />
      </>
    );
  } else if (view === 'me') {
    title = '내 정보';
    sub = '계정과 앱 설정을 확인해요.';
    body = (
      <AccountPanel
        profile={profile}
        detail={`담당 회원 ${members.length}명`}
        onFeedback={() => setSheet({ kind: 'appFeedback' })}
        onReleases={openReleases}
        onChangePin={() => setSheet({ kind: 'pin' })}
        onChangeNickname={() => setSheet({ kind: 'nickname' })}
        onNotifications={() => setSheet({ kind: 'push' })}
        onRecovery={() => setSheet({ kind: 'recovery' })}
      />
    );
  } else if (selectedMember) {
    const list = meals.filter((m) => m.member_id === selectedMember);
    title = `${person?.nickname ?? ''} 회원`;
    sub = '식사 기록과 피드백을 함께 확인하세요.';
    let lastDay = '';
    body = (
      <>
        <button className="back-button" onClick={() => setSelectedMember(null)}>
          <Icon name="left" /> 담당 회원으로
        </button>
        <div className="profile-banner">
          <span className="avatar">{person?.nickname.slice(0, 1)}</span>
          <div>
            <strong>{person?.nickname} 회원</strong>
            <p>
              최근 {WINDOW_DAYS}일 기록 {list.length}건 · 미확인 {list.filter(needsTrainer).length}건
            </p>
          </div>
        </div>
        <RecordSwitch value={recordMode} onChange={setRecordMode} />
        {recordMode === 'inbody' ? (
          <InbodyPanel inbody={inbody} canEdit={false}>
            {selectedMember && <InbodyReports memberId={selectedMember} records={inbody.records} mealsKey={memberMealsKey} />}
          </InbodyPanel>
        ) : (
          <>
            <div className="section-title">
              <h3>
                식사 기록 <span className="count">{list.length}</span>
              </h3>
            </div>
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
                <Empty title="아직 기록이 없어요" description="회원이 식단을 남기면 여기에 표시돼요." />
              )}
            </div>
          </>
        )}
      </>
    );
  } else {
    title = '담당 회원';
    sub = '회원별 기록을 한눈에 확인하세요.';
    body = (
      <>
        <div className="date-line">
          <span>함께 관리하는 회원</span>
          <span className="tiny">{members.length}명</span>
        </div>
        {members.length ? (
          members.map((p) => {
            const mine = meals.filter((m) => m.member_id === p.id);
            const n = mine.filter(needsTrainer).length;
            const st = streaks[p.id];
            return (
              <button
                key={p.id}
                className="member-row"
                onClick={() => {
                  setSelectedMember(p.id);
                  void store.loadMember(p.id);
                  mainRef.current?.scrollTo(0, 0);
                }}
              >
                <span className="avatar">{p.nickname.slice(0, 1)}</span>
                <span>
                  <strong>{p.nickname} 회원</strong>
                  <p>
                    오늘 {mine.filter((m) => m.eaten_on === today).length}끼 기록
                    {st && st.current > 0 && ` · ${st.today_logged ? `${st.current}일 연속` : `어제까지 ${st.current}일 연속`}`}
                  </p>
                </span>
                {n > 0 && <span className="status pending">미확인 {n}</span>}
                <Icon name="right" />
              </button>
            );
          })
        ) : (
          <Empty title="아직 담당 회원이 없어요" description="회원이 가입할 때 트레이너님을 선택하면 여기에 표시돼요." />
        )}
      </>
    );
  }

  const close = () => setSheet(null);
  let sheetTitle = '';
  let sheetBody = null;
  if (sheet?.kind === 'detail' && sheetMeal) {
    sheetTitle = `${sheetMeal.member_nickname}님의 ${sheetMeal.meal_type} 기록`;
    sheetBody = (
      <MealDetail
        meal={sheetMeal}
        role="trainer"
        trainerName={profile.nickname}
        photoUrl={sheetMeal.photo_path ? photoUrls[sheetMeal.photo_path] : undefined}
        onRate={(r) => rate(sheetMeal.id, r)}
        onReview={async () => {
          const withoutReply = hasQuestion(sheetMeal);
          try {
            await markReviewed(sheetMeal.id);
            await store.refreshMeal(sheetMeal.id);
            toast(withoutReply ? '답변 없이 확인했어요. 회원이 새로 말을 남기면 다시 올라와요.' : '확인 완료로 표시했어요.');
          } catch {
            toast('처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
          }
        }}
        onComment={async (text) => {
          try {
            await addComment(sheetMeal.id, text);
            await store.refreshMeal(sheetMeal.id);
            toast('피드백을 남겼어요. 회원 화면에 새 피드백으로 표시됩니다.');
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
    sheetBody = <FeedbackForm screen={`트레이너 ${view === 'queue' ? '확인 목록' : view === 'members' ? '담당 회원' : '내 정보'}`} onDone={close} />;
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
  } else if (sheet?.kind === 'releases') {
    sheetTitle = '업데이트 소식';
    sheetBody = <ReleaseNotes />;
  }

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
          { id: 'queue', icon: 'list', label: '확인 목록', count: todo, dot: questions > 0 },
          { id: 'members', icon: 'people', label: '담당 회원' },
          { id: 'me', icon: 'user', label: '내 정보' },
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
