// 이달의 중량왕(2.3 — 시안 design/v23-20261105). 규칙 원본은 private.strength_board.
// 남자·여자 탭마다 세 동작 × 무게 왕·체중 대비 왕 = 여섯 칸. 회원은 자기 성별 탭부터 본다.
import { useState } from 'react';
import { fetchStrengthKings, type Gender, type StrengthKing, type StrengthMine } from '../lib/api';
import { tieLabel } from '../lib/awards';
import { useLive } from '../lib/useLive';
import { sharedRequest } from '../lib/sharedRequest';
import { Segmented, StaleNotice, StatePanel } from '../ui/kit';

const LIFTS = ['벤치 프레스', '데드리프트', '스쿼트'];
const unit = { kg: (v: number) => `${v}kg`, pct: (v: number) => `${v}%` };

function King({ king, metric }: { king?: StrengthKing; metric: 'kg' | 'pct' }) {
  if (!king) return <div className="strength-king is-empty">아직 없어요</div>;
  return (
    <div className={`strength-king${king.names.some((n) => n.is_me) ? ' is-me' : ''}`}>
      <strong>{tieLabel(king.names)}</strong>
      <span>{unit[metric](king.value)}</span>
    </div>
  );
}

/** 내 기록 한 동작: 좁은 화면에서는 무게와 체중 대비 사이에서만 줄을 바꾼다 */
function MineRow({ m }: { m: StrengthMine }) {
  return (
    <div className="strength-mine-row">
      <span>{`${m.lift} ${unit.kg(m.kg)} ${m.kg_rank}위`}</span>
      {m.pct !== null && <span>{`체중 대비 ${unit.pct(m.pct)}${m.pct_rank ? ` ${m.pct_rank}위` : ''}`}</span>}
    </div>
  );
}

/** past: 지난 수상 창에 넣을 때. 제목을 보이고 규칙은 뺀다 */
export function StrengthCard({ month, today, testId = 'strength-kings', past = false }: { month: string; today: string; testId?: string; past?: boolean }) {
  const live = useLive(`strength-${month}-${today}`, '', () => sharedRequest(`strength:${month}:${today}`, () => fetchStrengthKings(month, today)));
  const [pick, setPick] = useState<Gender | null>(null);
  const s = live.value;
  const tab = pick ?? s?.my_gender ?? 'male';
  const now = month.slice(0, 7) === today.slice(0, 7);
  const label = `${Number(month.slice(5, 7))}월 중량왕`;
  if (s?.started === false) return null;
  const mine = s && s.my_gender === tab ? LIFTS.flatMap((lift) => s.mine.filter((m) => m.lift === lift)) : [];
  return (
    <section className="strength-card" aria-label={label} data-testid={testId}>
      {past && <h3>{label}</h3>}
      {s && live.failed && <StaleNotice text="최신 순위를 불러오지 못했어요." onRetry={live.reload} />}
      {!s ? (
        live.failed ? <StatePanel kind="failed" title="중량왕을 불러오지 못했어요" onRetry={live.reload} /> : <StatePanel kind="loading" />
      ) : (
        <>
          <Segmented label="성별" value={tab} options={[['male', '남자'], ['female', '여자']]} onChange={setPick} />
          <div className="strength-row strength-cols">
            <span />
            <span>무게</span>
            <span>체중 대비</span>
          </div>
          {LIFTS.map((lift) => {
            const of = (metric: 'kg' | 'pct') => s.kings.find((k) => k.gender === tab && k.lift === lift && k.metric === metric);
            return (
              <div key={lift} className="strength-row">
                <b>{lift}</b>
                <King king={of('kg')} metric="kg" />
                <King king={of('pct')} metric="pct" />
              </div>
            );
          })}
          {mine.length > 0 && (
            <div className="strength-mine" data-testid="strength-mine">
              <b>내 기록</b>
              {mine.map((m) => <MineRow key={m.lift} m={m} />)}
              {mine.every((m) => m.body_kg === null) && <small>체중 기록이 없어 체중 대비 순위를 계산할 수 없어요.</small>}
            </div>
          )}
          {s.my_state === 'no_gender' && <p className="strength-note">설정 → 계정에서 성별을 정하면 중량왕에 참여할 수 있어요.</p>}
          {s.my_state === 'hidden' && <p className="strength-note">성별을 비공개로 설정해 중량왕 후보에 포함되지 않아요.</p>}
          {past && <p className="tiny">기록을 고치면 순위가 바뀔 수 있어요.</p>}
          {!past && (
            <ul className="award-rules">
              <li>벤치 프레스·데드리프트·스쿼트로 정확히 적힌 5회 세트만 세요.</li>
              <li>완료한 세트 중 무게가 숫자로 적힌 기록만 반영해요.</li>
              <li>체중 대비는 운동 중량을 체중으로 나눈 비율이에요. 그달 마지막 체중을 쓰고 그달 기록이 없으면 이전 체중 기록을 써요.</li>
              <li>무게 왕에 뽑힌 회원은 같은 동작의 체중 대비 왕 후보에서 제외돼요.</li>
              <li>{now ? '순위는 달이 끝날 때까지 바뀔 수 있어요.' : '기록을 고치면 순위가 바뀔 수 있어요.'}</li>
            </ul>
          )}
        </>
      )}
    </section>
  );
}
