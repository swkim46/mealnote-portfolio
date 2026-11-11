import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Icon } from './Icon';
import { useSheetDraft } from './Sheet';
import { compressPhoto, PhotoError } from '../lib/photo';
import { defaultMealType, nowTime, todayKey } from '../lib/dates';
import { MEAL_TYPES, type MealInput, type MealType } from '../lib/types';
import { useMealPhotoState, type PhotoRef } from '../lib/mealPhoto';

interface Props {
  initial?: Partial<MealInput>;
  initialPhotoUrl?: string;
  /** 수정 창: 지금 사진(서명 주소가 없으면 상세처럼 서버 기능으로 받는다 — 상세에선 보이던 사진이 수정 창에서 '없음'으로 보였다, 2.4 넘기기 전 적대 검토 9) */
  initialPhoto?: PhotoRef;
  submitLabel: string;
  onSubmit: (input: MealInput, photo: Blob | null | undefined) => Promise<void>;
  onError: (message: string) => void;
}

/** 식단 등록·수정 폼. photo는 새 사진이면 Blob, 지웠으면 null, 그대로면 undefined로 넘긴다. */
export function MealForm({ initial, initialPhotoUrl, initialPhoto, submitLabel, onSubmit, onError }: Props) {
  const today = todayKey();
  const [date, setDate] = useState(initial?.eaten_on ?? today);
  const [time, setTime] = useState(initial?.eaten_at ?? nowTime());
  const [type, setType] = useState<MealType>(initial?.meal_type ?? (defaultMealType() as MealType));
  const typeLabelId = useId();
  const [food, setFood] = useState(initial?.food ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [photo, setPhoto] = useState<Blob | null | undefined>(undefined);
  // 이 폼이 고른 새 사진의 미리보기 주소(이 폼이 만들고 바꿀 때·뺄 때·닫힐 때 해제한다 — 서명 주소·공용 사진 주소는 다른 주인이 있어 건드리지 않는다)
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const madeUrl = useRef<string | null>(null);
  const dropMade = () => {
    if (madeUrl.current) URL.revokeObjectURL(madeUrl.current);
    madeUrl.current = null;
  };
  // 사진 고르기 차례와 폼이 열려 있는지: 압축이 끝나기 전에 창을 닫거나 다른 사진을 고르면 늦게 끝난 압축은 버린다 —
  // 닫힌 폼이 미리보기 주소를 새로 만들면 해제할 곳이 없었다(Codex v2.4.0 2차 리뷰 4절)
  const pickNo = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dropMade();
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 사진 오류는 사진 칸 바로 아래에도 — 창이 열린 동안의 짧은 안내가 창 뒤에 가려 '아무 일도 없는' 것처럼 보였다(2026-11-03 안드로이드 제보)
  const [photoError, setPhotoError] = useState('');
  const [reading, setReading] = useState(false);
  // 사진과 끼니 버튼은 칸을 거치지 않는다. 글자 칸은 창이 처음 값과 견준다
  const [startType] = useState(type);
  // 사진을 바꾸거나 뺐는가 = photo가 정해졌는가(새 사진 Blob · 뺌 null)
  useSheetDraft(photo !== undefined || type !== startType, busy);
  // 지금 사진(수정 창): 서명 주소가 있으면 그것. 없거나 그 이미지가 깨지면 서버 기능으로 받는다(상세와 같은 규칙 — Codex v2.4.0 1차 리뷰 P3-1).
  // 서명 주소가 창을 연 뒤에 와도(다시 서명·처음 서명 전에 연 수정) 그 주소를 쓴다(넘기기 전 적대 검토 2차 N5)
  const [signedBroken, setSignedBroken] = useState<string | null>(null);
  const signedOk = !!initialPhotoUrl && signedBroken !== initialPhotoUrl;
  const keeping = photo === undefined && !preview && (!!initialPhoto || !!initialPhotoUrl);
  const existing = useMealPhotoState(keeping && !signedOk ? initialPhoto : undefined, true);
  const [shownBroken, setShownBroken] = useState<string | null>(null);
  const shown = preview ?? (keeping ? (signedOk ? initialPhotoUrl : existing.url) : undefined);
  const existingFailed = keeping && !signedOk && (existing.failed || (!!existing.url && shownBroken === existing.url) || !initialPhoto);

  // 고른 파일을 읽은 뒤 칸을 비운다 — 같은 사진을 다시 골라도 change가 일어나게(처음에 실패한 사진을 다시 고르면 아무 반응이 없었다)
  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    void pick(file);
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    const n = ++pickNo.current;
    setBusy(true);
    setReading(true);
    setPhotoError('');
    try {
      const blob = await compressPhoto(file);
      if (!mounted.current || n !== pickNo.current) return;
      setPhoto(blob);
      const url = URL.createObjectURL(blob);
      dropMade();
      madeUrl.current = url;
      setPreview(url);
    } catch (e) {
      if (!mounted.current || n !== pickNo.current) return;
      const msg = e instanceof PhotoError ? e.message : '사진을 불러오지 못했어요. 다른 사진을 골라 주세요.';
      setPhotoError(msg);
      onError(msg);
    } finally {
      if (n === pickNo.current) {
        setBusy(false);
        setReading(false);
      }
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = food.trim();
    if (!trimmed) return setError('먹은 음식을 간단히 입력해 주세요.');
    if (date > today) return setError('오늘 또는 지난 식사 날짜를 선택해 주세요.');
    setError('');
    setBusy(true);
    try {
      await onSubmit({ eaten_on: date, eaten_at: time, meal_type: type, food: trimmed, note: note.trim() }, photo);
    } finally {
      setBusy(false);
    }
  }

  // 한마디 칸은 한 줄로 시작하고 쓰는 만큼 늘어난다(2.4 — 식단 등록 버튼까지 한 화면)
  const noteBox = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = noteBox.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [note]);
  const photoInputs = (again: boolean) => (
    <>
      {/* 사진 찍기와 앨범 고르기를 나눈다(2026-10-31 회원 의견: 안드로이드 크롬·홈 화면 앱에서 촬영 선택지 없이 사진첩만 열림).
          안드로이드 14부터 크롬 계열은 이미지만 받는 파일 칸을 사진 선택기로 바로 보내고 거기엔 카메라가 없다(Chromium 이슈 40937303).
          표준 capture 속성으로 카메라를 바로 여는 칸을 따로 둔다 */}
      <label className="photo-button">
        <Icon name="camera" /> {again ? '다시 찍기' : '사진 찍기'}
        <input type="file" accept="image/*" capture="environment" aria-label="식사 사진 찍기" onChange={onFile} />
      </label>
      <label className="photo-button">
        <Icon name="photo" /> {again ? '다시 고르기' : '앨범에서 고르기'}
        <input type="file" accept="image/*" aria-label="식사 사진 선택" onChange={onFile} />
      </label>
    </>
  );

  // 2.4 칸 순서(사용자 결정 11-09): 미리 채워진 날짜·시각·식사 구분 → 꼭 적을 '무엇을 드셨나요'(필수) → 넣지 않아도 되는 사진·한마디.
  // 날짜·시각·식사 구분은 칸 이름을 화면에서 빼고 읽어 주는 이름만 남긴다. 사진은 버튼 두 개, 고르면 그 자리가 160px 미리보기(모든 기기 같은 높이)
  return (
    <form onSubmit={submit} className="meal-form">
      <fieldset className="form-lock" disabled={busy}>
      <div className="form-two">
        <label className="field">
          <span className="sr-only">먹은 날짜</span>
          <input type="date" value={date} max={today} required onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="sr-only">먹은 시각</span>
          <input type="time" value={time} required onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      {/* 식사 구분은 버튼 네 개(2026-10-30 회원 의견 — 드롭다운보다 한 번 덜 누른다). 기본값은 지금 시간대 */}
      <div className="field">
        <span id={typeLabelId} className="sr-only">
          식사 구분
        </span>
        <div className="meal-type-buttons" role="group" aria-labelledby={typeLabelId}>
          {MEAL_TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        무엇을 드셨나요? <span className="req">필수</span>
        <input
          value={food}
          maxLength={150}
          placeholder="예: 밥 반 공기, 닭가슴살, 샐러드"
          required
          autoComplete="off"
          onChange={(e) => setFood(e.target.value)}
        />
      </label>
      <p className="field field-title" aria-hidden="true">
        식사 사진 <span className="tiny">선택</span>
      </p>
      {shown || keeping ? (
        <div className="meal-photo-has">
          <div className="meal-photo-view">
            {existingFailed ? (
              <span className="meal-photo-state" role="status">
                사진을 불러오지 못했어요
                {initialPhoto && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      const broken = shownBroken !== null;
                      setShownBroken(null);
                      existing.retry(broken);
                    }}
                  >
                    다시 불러오기
                  </button>
                )}
              </span>
            ) : shown ? (
              <img
                src={shown}
                alt="선택한 식사 사진 미리보기"
                onError={() => (shown === initialPhotoUrl && signedOk ? setSignedBroken(shown) : shown === existing.url ? setShownBroken(shown) : undefined)}
              />
            ) : (
              <span className="meal-photo-state" role="status">
                사진을 불러오는 중…
              </span>
            )}
            <button
              type="button"
              className="photo-x"
              aria-label="사진 빼기"
              onClick={() => {
                setPhoto(null);
                setPreview(undefined);
                dropMade();
              }}
            >
              ✕
            </button>
          </div>
          <div className="meal-photo-again">{photoInputs(true)}</div>
        </div>
      ) : (
        <div className="meal-photo-pick">{photoInputs(false)}</div>
      )}
      {reading && <p className="tiny photo-reading">사진을 줄이는 중…</p>}
      {photoError && (
        <p className="field-error photo-error" role="alert" data-testid="photo-error">
          {photoError}
        </p>
      )}
      <label className="field">
        트레이너에게 한마디 <span className="tiny">선택</span>
        <textarea
          ref={noteBox}
          value={note}
          maxLength={500}
          rows={1}
          placeholder="먹은 양이나 궁금한 점을 남겨주세요."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="field-error" role="alert">
        {error}
      </div>
      <button className="primary full" type="submit" disabled={busy}>
        {busy ? '저장하는 중…' : submitLabel}
      </button>
    </fieldset>
    </form>
  );
}
