import { useState, type FormEvent } from 'react';
import { Icon } from './Icon';
import { compressPhoto, PhotoError } from '../lib/photo';
import { defaultMealType, nowTime, todayKey } from '../lib/dates';
import { MEAL_TYPES, type MealInput, type MealType } from '../lib/types';

interface Props {
  initial?: Partial<MealInput>;
  initialPhotoUrl?: string;
  submitLabel: string;
  onSubmit: (input: MealInput, photo: Blob | null | undefined) => Promise<void>;
  onError: (message: string) => void;
}

/** 식단 등록·수정 폼. photo는 새 사진이면 Blob, 지웠으면 null, 그대로면 undefined로 넘긴다. */
export function MealForm({ initial, initialPhotoUrl, submitLabel, onSubmit, onError }: Props) {
  const today = todayKey();
  const [date, setDate] = useState(initial?.eaten_on ?? today);
  const [time, setTime] = useState(initial?.eaten_at ?? nowTime());
  const [type, setType] = useState<MealType>(initial?.meal_type ?? (defaultMealType() as MealType));
  const [food, setFood] = useState(initial?.food ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [photo, setPhoto] = useState<Blob | null | undefined>(undefined);
  const [preview, setPreview] = useState<string | undefined>(initialPhotoUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const blob = await compressPhoto(file);
      setPhoto(blob);
      setPreview(URL.createObjectURL(blob));
    } catch (e) {
      onError(e instanceof PhotoError ? e.message : '사진을 불러오지 못했어요.');
    } finally {
      setBusy(false);
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

  return (
    <form onSubmit={submit}>
      <label className="field">
        식사 사진 <span className="tiny">선택</span>
      </label>
      <label className={`photo-upload ${preview ? 'has-image' : ''}`}>
        {preview ? (
          <img src={preview} alt="선택한 식사 사진 미리보기" />
        ) : (
          <>
            <Icon name="camera" />
            <strong>사진 찍기 또는 선택</strong>
            <small>사진 없이도 기록할 수 있어요</small>
          </>
        )}
        <input type="file" accept="image/*" aria-label="식사 사진 선택" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {preview && (
        <button
          type="button"
          className="text-button photo-remove"
          onClick={() => {
            setPhoto(null);
            setPreview(undefined);
          }}
        >
          사진 빼기
        </button>
      )}
      <div className="form-two">
        <label className="field">
          먹은 날짜
          <input type="date" value={date} max={today} required onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          먹은 시각
          <input type="time" value={time} required onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <label className="field">
        식사 구분
        <select value={type} onChange={(e) => setType(e.target.value as MealType)}>
          {MEAL_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="field">
        무엇을 드셨나요?
        <input
          value={food}
          maxLength={150}
          placeholder="예: 밥 반 공기, 닭가슴살, 샐러드"
          required
          autoComplete="off"
          onChange={(e) => setFood(e.target.value)}
        />
      </label>
      <label className="field">
        트레이너에게 한마디 <span className="tiny">선택</span>
        <textarea
          value={note}
          maxLength={500}
          rows={2}
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
    </form>
  );
}
