// 같은 트레이너의 회원들이 함께 보는 것: 트레이너 추천 식단(공유) · 공유 동의·닉네임 공개 · 트레이너 다시 고르기. 식단왕·운동왕은 Awards.tsx
// 비동기 결과는 요청 번호로 마지막 것만 쓰고, 조회 실패는 빈 목록·꺼짐으로 바꾸지 않는다(마지막 정상 값과 실패 안내를 함께 보인다).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from '../lib/useLive';
import {
  chooseTrainer,
  fetchAwardPublic,
  fetchShareConsent,
  fetchSharedMeals,
  fetchTrainersForMe,
  setAwardPublic,
  setShareConsent,
  type SharedMeal,
} from '../lib/api';
import { prettyDay } from '../lib/dates';
import { MealImage, RatingChip } from './Bits';
import { retryFailedMealPhotos, useMealPhoto } from '../lib/mealPhoto';
import { useToast } from './Toast';
import { StaleNotice } from '../ui/kit';

/** 이번 주 추천 식단(2026-10-30 이름 변경): 공유한 때부터 7일 동안(서버 private.share_active). 담당 트레이너가 고른 같은 트레이너 회원들의 식사(사진·음식·평가·날짜·닉네임. 닉네임 공개를 끄면 '익명 회원', 2026-11-06 사용자 결정). 1분마다·앱 복귀 때 다시 받는다 */
export function SharedMeals({ onOpen }: { onOpen?: (m: SharedMeal) => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const list = useLive('shared', String(tick), () =>
    fetchSharedMeals(20).then((v) => {
      retryFailedMealPhotos();
      return v;
    }),
  );
  if (!list.value)
    return list.failed ? (
      <p className="hint">
        추천 식단을 불러오지 못했어요.{' '}
        <button type="button" className="text-button" onClick={list.reload}>
          다시 불러오기
        </button>
      </p>
    ) : null;
  const meals = list.value;
  return (
    <section className="shared-meals" aria-label="이번 주 추천 식단" data-testid="shared-meals">
      <div className="section-title">
        <h3>
          이번 주 추천 식단 <span className="count">{meals.length}</span>
        </h3>
      </div>
      {list.failed && <p className="tiny">최신 목록을 불러오지 못했어요. 잠시 뒤 다시 받아요.</p>}
      {meals.length ? (
        <ul className="shared-strip">
          {meals.map((m) => (
            <li key={m.id}>
              {/* 누르면 사진을 크게(2026-10-30 사용자 요청). 사진은 요청마다 권한을 확인하는 서버 기능으로(Codex v1.8.0 리뷰 3). 날짜·평가는 큰 화면에서 본다(2.3.2) */}
              <button type="button" className="shared-item" aria-label={`${m.food} 추천 식단 크게 보기`} onClick={() => onOpen?.(m)}>
                <MealImage photo={m.photo_path ? { mealId: m.id, path: m.photo_path } : undefined} />
                <strong>{m.food}</strong>
                <small>{m.mine ? '내 식단' : m.nickname}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">트레이너가 좋은 식단을 고르면 일주일 동안 여기에 보여요.</p>
      )}
    </section>
  );
}

/** 추천 식단 하나를 크게: 사진·음식·평가·날짜·닉네임(남긴 말·댓글 없음). 사진은 목록에서 받은 것을 그대로 쓴다(같은 사진은 다시 받지 않음) */
export function SharedMealDetail({ meal }: { meal: SharedMeal }) {
  const url = useMealPhoto(meal.photo_path ? { mealId: meal.id, path: meal.photo_path } : undefined, true);
  return (
    <div className="shared-detail" data-testid="shared-detail">
      {meal.photo_path ? (
        url ? (
          <img className="detail-photo" src={url} alt={`${meal.food} 사진`} />
        ) : (
          <div className="placeholder-photo">
            <span>사진을 불러오는 중…</span>
          </div>
        )
      ) : (
        <div className="placeholder-photo">
          <span>사진 없이 기록한 식사</span>
        </div>
      )}
      <h3 className="detail-food">{meal.food}</h3>
      <p className="tiny">
        {prettyDay(meal.eaten_on)} {meal.meal_type} · {meal.mine ? '내 식단' : meal.nickname}
      </p>
      <RatingChip rating={meal.rating} />
    </div>
  );
}

/**
 * 회원 설정의 켜고 끄는 항목(식단 공유 허용·닉네임 공개). 값을 모를 때(조회 중·실패)는 꺼진 스위치로 보이지 않고,
 * 실패하면 안내와 다시 불러오기를 보인다(Codex v1.8.0 리뷰 8). 저장이 끝나면 그 전에 시작한 조회 결과는 버린다(저장 결과가 이긴다).
 */
export function ProfileSwitch({ userId, label, description, testId, load: fetchValue, save: saveValue, messages }: {
  userId: string;
  label: string;
  description: string;
  testId: string;
  load: (userId: string) => Promise<boolean>;
  save: (on: boolean) => Promise<void>;
  messages: { on: string; off: string };
}) {
  const toast = useToast();
  const [state, setState] = useState<{ status: 'loading' | 'failed' } | { status: 'ok'; on: boolean }>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const req = useRef(0);
  const saving = useRef(false);
  const fetchRef = useRef(fetchValue);
  useEffect(() => {
    fetchRef.current = fetchValue;
  });
  const load = useCallback(() => {
    const n = ++req.current;
    fetchRef
      .current(userId)
      .then((on) => n === req.current && !saving.current && setState({ status: 'ok', on }))
      .catch(() => n === req.current && !saving.current && setState((s) => (s.status === 'ok' ? s : { status: 'failed' })));
  }, [userId]);
  useEffect(() => {
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);
  async function toggle() {
    if (state.status !== 'ok' || busy) return;
    const next = !state.on;
    saving.current = true;
    setBusy(true);
    try {
      await saveValue(next);
      req.current++; // 저장 전에 시작한 조회는 버린다
      setState({ status: 'ok', on: next });
      toast(next ? messages.on : messages.off);
    } catch {
      toast('저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="menu-row consent-row" data-testid={testId}>
      <span>
        <strong>{label}</strong>
        <small>{state.status === 'failed' ? '설정을 불러오지 못했어요.' : description}</small>
      </span>
      {state.status === 'ok' ? (
        <input type="checkbox" role="switch" aria-label={label} checked={state.on} disabled={busy} onChange={() => void toggle()} />
      ) : state.status === 'failed' ? (
        <button type="button" className="text-button" onClick={load}>
          다시 불러오기
        </button>
      ) : (
        <span className="tiny">확인 중</span>
      )}
    </div>
  );
}

/** 내 식단 공유 허용(기본 꺼짐). 끄면 공유된 식단이 모두 내려간다 */
export function ShareConsentSetting({ userId }: { userId: string }) {
  return (
    <ProfileSwitch
      userId={userId}
      label="내 식단 공유 허용"
      description="트레이너가 고른 내 식단을 같은 트레이너의 다른 회원에게 보여 줘요. 남긴 말은 보이지 않아요."
      testId="share-consent"
      load={fetchShareConsent}
      save={setShareConsent}
      messages={{ on: '트레이너가 고른 식단을 다른 회원에게 보여 줄 수 있어요.', off: '공유를 껐어요. 공유된 식단도 모두 내렸어요.' }}
    />
  );
}

/** 수상과 공유한 식단의 닉네임 공개(기본 켜짐, 2026-10-29 사용자 결정 · 식단은 11-06부터). 끄면 다른 사람에게는 '익명 회원'으로 보인다 */
export function AwardPublicSetting({ userId }: { userId: string }) {
  return (
    <ProfileSwitch
      userId={userId}
      label="수상·식단 닉네임 공개"
      description="수상하거나 내 식단이 공유되면 같은 트레이너의 회원들에게 닉네임이 보여요. 끄면 '익명 회원'으로 보여요."
      testId="award-public"
      load={fetchAwardPublic}
      save={setAwardPublic}
      messages={{ on: '수상하거나 식단이 공유되면 닉네임이 보여요.', off: "수상하거나 식단이 공유돼도 '익명 회원'으로 보여요." }}
    />
  );
}

/** 담당 트레이너가 없는 회원(내보내진 경우): 트레이너를 다시 고른다. 내보낸 트레이너는 목록에 없다 */
export function ChooseTrainer({ onChosen }: { onChosen: () => void }) {
  const toast = useToast();
  const trainers = useLive('trainers', '', fetchTrainersForMe);
  const list = trainers.value;
  const reload = trainers.reload;
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!pick || busy) return;
    setBusy(true);
    try {
      await chooseTrainer(pick);
      onChosen();
    } catch {
      toast('저장하지 못했어요. 목록을 다시 불러온 뒤 골라 주세요.');
      reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="choose-trainer" data-testid="choose-trainer">
      <h2>담당 트레이너를 다시 골라 주세요</h2>
      <p className="hint">담당 트레이너와의 연결이 끊겼어요. 지금까지의 기록은 그대로 남아 있어요.</p>
      {list && trainers.failed && <StaleNotice text="트레이너 목록을 새로 불러오지 못했어요." onRetry={reload} />}
      {list ? (
        list.length ? (
          <>
            <label className="field">
              트레이너
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">선택해 주세요</option>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nickname}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary full" disabled={!pick || busy} onClick={() => void save()}>
              이 트레이너로 정하기
            </button>
          </>
        ) : (
          <p className="hint">고를 수 있는 트레이너가 없어요. 운영자에게 문의해 주세요.</p>
        )
      ) : trainers.failed ? (
        <button className="secondary" onClick={reload}>
          다시 불러오기
        </button>
      ) : null}
    </section>
  );
}
