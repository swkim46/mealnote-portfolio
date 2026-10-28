import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { deleteInbody, InbodyDuplicateError, saveInbody } from '../lib/api';
import { INBODY_PRIVACY, type InbodyState } from './useInbody';
import { prettyDay, todayKey } from '../lib/dates';
import type { InbodyInput, InbodyRecord } from '../lib/types';
import { Empty, Loading } from './Bits';
import { Icon } from './Icon';

const fmt = (n: number | null, unit: string) => (n === null ? '–' : `${n.toFixed(1)}${unit}`);

function Delta({ now, before, unit }: { now: number | null; before: number | null | undefined; unit: string }) {
  if (now === null || before === null || before === undefined) return null;
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return <span className="delta">변화 없음</span>;
  return (
    <span className="delta">
      {d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)}
      {unit}
    </span>
  );
}

/** 기록 화면 위 '식단 | 인바디' 전환 */
export function RecordSwitch({ value, onChange }: { value: 'meals' | 'inbody'; onChange: (v: 'meals' | 'inbody') => void }) {
  return (
    <div className="record-switch" role="group" aria-label="기록 종류">
      {(
        [
          ['meals', '식단'],
          ['inbody', '인바디'],
        ] as const
      ).map(([id, label]) => (
        <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** 인바디: 최근 측정과 직전 대비 변화, 날짜별 기록 */
export function InbodyPanel({
  inbody,
  canEdit,
  onAdd,
  onEdit,
  children,
}: {
  inbody: InbodyState;
  canEdit: boolean;
  onAdd?: () => void;
  onEdit?: (r: InbodyRecord) => void;
  /** 결산 카드 등 목록 위에 붙일 내용 */
  children?: ReactNode;
}) {
  const { records, loaded, failed } = inbody;
  if (!loaded) return <Loading />;
  if (failed)
    return (
      <Empty
        title="인바디 기록을 불러오지 못했어요"
        description="연결을 확인한 뒤 다시 시도해 주세요."
        action={<button className="secondary" onClick={() => void inbody.reload()}>다시 불러오기</button>}
      />
    );
  const [latest, prev] = records;
  return (
    <>
      {canEdit && (
        <button className="primary full inbody-add" onClick={onAdd}>
          <Icon name="plus" /> 인바디 기록하기
        </button>
      )}
      {latest ? (
        <section className="inbody-latest" aria-label="최근 인바디">
          <div className="inbody-latest-head">
            <strong>최근 측정</strong>
            <span>{prettyDay(latest.measured_on)}</span>
          </div>
          <div className="inbody-metrics">
            {(
              [
                ['체중', latest.weight_kg, prev?.weight_kg, 'kg'],
                ['골격근량', latest.smm_kg, prev?.smm_kg, 'kg'],
                ['체지방률', latest.pbf_pct, prev?.pbf_pct, '%'],
              ] as const
            ).map(([label, now, before, unit]) => (
              <div key={label} className="inbody-metric">
                <span>{label}</span>
                <strong>{fmt(now, unit)}</strong>
                <Delta now={now} before={before} unit={unit === '%' ? '%p' : unit} />
              </div>
            ))}
          </div>
          {prev && <p className="tiny">직전 측정({prettyDay(prev.measured_on)})과 비교</p>}
        </section>
      ) : (
        <Empty
          title="아직 인바디 기록이 없어요"
          description={canEdit ? '결과지 사진을 고르거나 숫자를 직접 넣어 기록해 보세요.' : '회원이 인바디를 기록하면 여기에 표시돼요.'}
        />
      )}
      {children}
      {records.length > 0 && (
        <>
          <div className="section-title">
            <h3>
              날짜별 기록 <span className="count">{records.length}</span>
            </h3>
          </div>
          <div className="inbody-table">
            <div className="inbody-row head" aria-hidden="true">
              <span>측정일</span>
              <span>체중</span>
              <span>골격근량</span>
              <span>체지방률</span>
            </div>
            {records.map((r) => {
              const cells = (
                <>
                  <span>{prettyDay(r.measured_on)}</span>
                  <span>{fmt(r.weight_kg, 'kg')}</span>
                  <span>{fmt(r.smm_kg, 'kg')}</span>
                  <span>{fmt(r.pbf_pct, '%')}</span>
                </>
              );
              return canEdit && onEdit ? (
                <button key={r.id} className="inbody-row" onClick={() => onEdit(r)} aria-label={`${prettyDay(r.measured_on)} 인바디 고치기`}>
                  {cells}
                </button>
              ) : (
                <div key={r.id} className="inbody-row">
                  {cells}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

const numOrNull = (s: string) => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : NaN;
};

/** 인바디 기록 쓰기·고치기. 사진에서 읽기는 기기 안에서만, 사진은 바로 버린다. */
export function InbodyForm({
  memberId,
  initial,
  onDone,
  onError,
}: {
  memberId: string;
  initial?: InbodyRecord;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [day, setDay] = useState(initial?.measured_on ?? todayKey());
  const [weight, setWeight] = useState(initial ? String(initial.weight_kg) : '');
  const [smm, setSmm] = useState(initial?.smm_kg != null ? String(initial.smm_kg) : '');
  const [pbf, setPbf] = useState(initial?.pbf_pct != null ? String(initial.pbf_pct) : '');
  const [source, setSource] = useState<'ocr' | 'manual'>(initial?.source ?? 'manual');
  const [reading, setReading] = useState<string | null>(null);
  const [readNote, setReadNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readPhoto(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = ''; // 고른 사진을 입력 칸에서 바로 놓는다
    if (!file) return;
    // 새 사진의 결과로 네 칸을 모두 다시 채운다. 이전 사진·입력 값이 섞여 저장되지 않게 먼저 비운다(Codex 리뷰 v1.4 P2).
    setDay('');
    setWeight('');
    setSmm('');
    setPbf('');
    setSource('manual');
    setReading('읽을 준비 중이에요…');
    setReadNote('');
    try {
      const { readInbodyPhoto } = await import('../lib/inbodyOcr');
      const v = await readInbodyPhoto(file, (stage) => {
        if (/recogniz|숫자|항목/.test(stage)) setReading('사진에서 숫자를 찾는 중이에요…');
      });
      setDay(v.measured_on ?? '');
      setWeight(v.weight_kg !== null ? String(v.weight_kg) : '');
      setSmm(v.smm_kg !== null ? String(v.smm_kg) : '');
      setPbf(v.pbf_pct !== null ? String(v.pbf_pct) : '');
      const missing = [!v.measured_on && '측정일', v.weight_kg === null && '체중', v.smm_kg === null && '골격근량', v.pbf_pct === null && '체지방률'].filter(Boolean);
      const got = 4 - missing.length;
      if (got > 0) setSource('ocr');
      // 못 읽었을 때 원인을 짐작할 수 있게 받은 사진 크기를 함께 보여 준다(작은 사진이면 다시 고르라고 안내)
      const img = 'image' in v && v.image ? v.image : null;
      const size = img ? ` (받은 사진 ${img[0]}×${img[1]})` : '';
      const small = !!img && Math.min(img[0], img[1]) < 650;
      setReadNote(
        got === 0
          ? small
            ? `사진이 작아 숫자를 읽지 못했어요${size}. 결과지 원본 파일이나 더 선명한 사진으로 다시 골라 주세요.`
            : `숫자를 읽지 못했어요${size}. 결과지 전체가 밝고 반듯하게 나오게 다시 찍거나, 직접 입력해 주세요.`
          : missing.length
            ? `읽지 못한 항목: ${missing.join(', ')}${size}. 직접 입력해 주세요. 읽은 값도 결과지와 같은지 확인해 주세요.`
            : '읽은 값이 결과지와 같은지 확인한 뒤 저장해 주세요.',
      );
    } catch (e) {
      console.error(e);
      const why = e instanceof Error && e.message ? ` (${e.message.slice(0, 60)})` : '';
      setReadNote(`사진을 읽지 못했어요${why}. 직접 입력해 주세요.`);
    } finally {
      setReading(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const w = numOrNull(weight), s = numOrNull(smm), p = numOrNull(pbf);
    if (!day || day > todayKey()) return onError('측정일을 확인해 주세요.');
    if (w === null || Number.isNaN(w) || w < 20 || w > 300) return onError('체중을 확인해 주세요(20~300kg).');
    if (Number.isNaN(s) || (s !== null && (s < 5 || s > 150))) return onError('골격근량을 확인해 주세요(5~150kg).');
    if (Number.isNaN(p) || (p !== null && (p < 1 || p > 75))) return onError('체지방률을 확인해 주세요(1~75%).');
    const input: InbodyInput = { measured_on: day, weight_kg: w, smm_kg: s, pbf_pct: p, source };
    setBusy(true);
    try {
      await saveInbody(memberId, input, initial?.id);
      onDone(initial ? '인바디 기록을 고쳤어요.' : '인바디를 기록했어요.');
    } catch (err) {
      onError(err instanceof InbodyDuplicateError ? '이 날짜의 기록이 이미 있어요. 목록에서 그 기록을 눌러 고쳐 주세요.' : '저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inbody-form" onSubmit={submit}>
      {!initial && (
        <div className="inbody-photo">
          <p className="privacy-note" data-testid="inbody-privacy">
            {INBODY_PRIVACY}
          </p>
          <label className={`secondary full photo-read ${reading ? 'busy' : ''}`}>
            <Icon name="camera" /> {reading ?? '결과지 사진에서 읽기'}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              aria-label="인바디 결과지 사진 선택"
              disabled={!!reading}
              onChange={(e) => void readPhoto(e.target.files?.[0])}
            />
          </label>
          {readNote && (
            <p className="read-note" role="status">
              {readNote}
            </p>
          )}
        </div>
      )}
      <label className="field">
        측정일
        <input type="date" value={day} max={todayKey()} required onChange={(e) => setDay(e.target.value)} />
      </label>
      <div className="inbody-fields">
        <label className="field">
          체중 (kg)
          <input inputMode="decimal" value={weight} required placeholder="예) 69.0" onChange={(e) => setWeight(e.target.value)} />
        </label>
        <label className="field">
          골격근량 (kg)
          <input inputMode="decimal" value={smm} placeholder="예) 30.0" onChange={(e) => setSmm(e.target.value)} />
        </label>
        <label className="field">
          체지방률 (%)
          <input inputMode="decimal" value={pbf} placeholder="예) 22.6" onChange={(e) => setPbf(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="primary full" disabled={busy || !!reading}>
        {busy ? '저장하는 중…' : initial ? '고친 내용 저장하기' : '인바디 저장하기'}
      </button>
      {initial && (
        <button
          type="button"
          className={`text-button inbody-delete ${confirmDelete ? 'danger' : ''}`}
          disabled={busy}
          onClick={async () => {
            if (!confirmDelete) return setConfirmDelete(true);
            setBusy(true);
            try {
              await deleteInbody(initial.id);
              onDone('인바디 기록을 지웠어요.');
            } catch {
              onError('지우지 못했어요. 잠시 후 다시 시도해 주세요.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmDelete ? '한 번 더 누르면 지워져요' : '이 기록 지우기'}
        </button>
      )}
    </form>
  );
}
