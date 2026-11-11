// 공복 체중(2.3 — 트레이너 의견 2026-11-04, 시안 design/v23-20261105). 인바디 사이에도 아침 체중을 빠르게 적고, 같은 그래프에 이어 본다.
// 하루 한 값이라 같은 날 다시 적으면 바뀐다. 최근 값을 누르면 그 날짜를 고쳐 쓰거나 지울 수 있다. 회원만 적고 담당 트레이너는 그래프에서 본다.
import { useEffect, useState } from 'react';
import { deleteFastingWeight, fetchFastingWeights, saveFastingWeight, type FastingWeight } from '../lib/api';
import { setUnsaved } from '../lib/appUpdate';
import { todayKey } from '../lib/dates';
import { useLive } from '../lib/useLive';
import { StaleNotice } from '../ui/kit';
import { Icon } from './Icon';
import { useToast } from './Toast';

const SHOW = 4;
/** 올해가 아닌 기록은 연도까지(끝까지 받으면 1년 넘은 값도 보인다) */
const shortDay = (day: string, today: string) => `${day.slice(0, 4) === today.slice(0, 4) ? '' : `${day.slice(2, 4)}.`}${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;

/** 회원 한 명의 공복 체중. active일 때 받고, 앱으로 돌아오면 다시 받는다 */
export function useFastingWeights(memberId: string | null, active = true) {
  const [version, setVersion] = useState(0);
  const live = useLive<FastingWeight[]>(`fasting-${memberId}`, `${version}|${active}`, () => (memberId && active ? fetchFastingWeights(memberId) : Promise.resolve([])));
  return { list: live.value ?? [], failed: live.failed, reload: () => setVersion((v) => v + 1) };
}
export type FastingState = ReturnType<typeof useFastingWeights>;

export function FastingWeightCard({ fasting }: { fasting: FastingState }) {
  const toast = useToast();
  const today = todayKey();
  // 고른 날이 없으면 늘 오늘: 앱을 켜 둔 채 날이 바뀌어도 어제 기록을 덮어쓰지 않는다
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? today;
  const [kg, setKg] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const saved = fasting.list.find((w) => w.day === day);
  // 최근 기록 칸을 눌러 값이 채워진 것은 쓰던 내용이 아니다
  const dirty = !!kg.trim() && Number(kg) !== saved?.kg;
  useEffect(() => {
    setUnsaved('fasting', dirty);
    return () => setUnsaved('fasting', false);
  }, [dirty]);
  const save = async () => {
    const v = Number(kg);
    if (!kg.trim() || !Number.isFinite(v) || v < 20 || v > 300) return toast('체중을 20～300kg 사이로 적어 주세요.');
    setBusy(true);
    try {
      await saveFastingWeight(day, v);
      toast('공복 체중을 기록했어요.');
      setKg('');
      setPicked(null);
      fasting.reload();
    } catch {
      toast('저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await deleteFastingWeight(day);
      toast('공복 체중을 지웠어요.');
      setKg('');
      setPicked(null);
      fasting.reload();
    } catch {
      toast('지우지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };
  const shown = all ? fasting.list : fasting.list.slice(0, SHOW);
  return (
    <section className="fasting-card" aria-label="공복 체중" data-testid="fasting-card">
      <div className="fasting-head">
        <strong>공복 체중</strong>
        <span className="tiny">식사 전에 잰 체중을 적어 주세요.</span>
      </div>
      {fasting.failed && <StaleNotice text="공복 체중 기록을 새로 불러오지 못했어요." onRetry={fasting.reload} />}
      <div className="fasting-row">
        {/* 날짜 입력은 글자 칸 위에 투명하게 덮는다: 아이폰은 날짜 입력을 칸보다 넓게 그려 옆 칸을 덮었다(11-06 사용자 화면) */}
        <label className="fasting-day">
          <Icon name="calendar" />
          <span>{day === today ? '오늘' : shortDay(day, today)}</span>
          <input type="date" aria-label="공복 체중 날짜" value={day} max={today} disabled={busy} onChange={(e) => setPicked(e.target.value || null)} />
        </label>
        <label className="fasting-kg">
          <input inputMode="decimal" aria-label="공복 체중(kg)" placeholder={saved ? String(saved.kg) : '0.0'} value={kg} disabled={busy} onChange={(e) => setKg(e.target.value)} />
          <small>kg</small>
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          기록
        </button>
      </div>
      {shown.length > 0 && (
        <div className="fasting-list">
          {shown.map((w) => (
            <button
              key={w.day}
              type="button"
              aria-pressed={w.day === day && !!saved}
              disabled={busy}
              onClick={() => {
                setPicked(w.day);
                setKg(String(w.kg));
              }}
            >
              {shortDay(w.day, today)} {w.kg}
            </button>
          ))}
          {!all && fasting.list.length > SHOW && (
            <button type="button" disabled={busy} onClick={() => setAll(true)}>
              더 보기
            </button>
          )}
        </div>
      )}
      {saved && (
        <button type="button" className="text-button fasting-delete" disabled={busy} onClick={() => void remove()}>
          {shortDay(day, today)} 기록 지우기
        </button>
      )}
    </section>
  );
}
