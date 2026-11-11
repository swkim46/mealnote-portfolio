// 인바디 꺾은선 그래프(2.1, 2026-11-03 사용자 확정 — design/workout-tab-20261103 시안 3·4): 체중·골격근량·체지방률 가운데 하나를 골라
// 최근 7번 측정을 점마다 값·날짜와 함께, 최근 값을 강조해 보인다(InBody 앱 변화 탭·Hevy/Fitbod 측정 화면의 공통 꼴 — 문서/기획/운동탭_레퍼런스조사_261103.md).
// 값이 없는 측정(골격근량·체지방률을 비워 둔 기록)은 그 항목 그래프에서 뺀다. 두 번 이상 측정해야 그린다.
// 체중 그래프에는 공복 체중(2.3)을 빈 점으로 함께 그린다.
import { useState } from 'react';
import type { FastingWeight } from '../lib/api';
import type { InbodyRecord } from '../lib/types';

const METRICS = [
  { key: 'weight_kg', label: '체중', unit: 'kg' },
  { key: 'smm_kg', label: '골격근량', unit: 'kg' },
  { key: 'pbf_pct', label: '체지방률', unit: '%' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];
const SHOW = 7;
/** 그래프에 올리는 공복 체중(최근 것부터) */
const FASTING_SHOW = 30;
/** 글자 사이의 최소 간격(그래프 좌표) */
const LABEL_GAP = 36;

export function InbodyChart({ records, fasting = [], known = true }: { records: InbodyRecord[]; fasting?: FastingWeight[]; /** 인바디 기록을 받았는가. 모르면 '측정 0번'이나 '두 번 이상 적으면'을 말하지 않는다 */ known?: boolean }) {
  const [metric, setMetric] = useState<MetricKey>('weight_kg');
  const m = METRICS.find((x) => x.key === metric)!;
  // records는 최근 측정이 앞 — 그래프는 오래된 것부터
  const pts = records
    .filter((r) => r[metric] !== null && r[metric] !== undefined)
    .slice(0, SHOW)
    .reverse()
    .map((r) => ({ day: r.measured_on, v: Number(r[metric]) }));
  // 공복 체중(2.3)은 체중 그래프에만. 잘려 나간 오래된 인바디가 있으면 그려지는 기간부터. 날짜 간격대로 그려 두 기록이 이어진다
  const from = records.length > SHOW ? (pts[0]?.day ?? '') : '';
  const extra = metric === 'weight_kg' ? fasting.filter((w) => w.day >= from).slice(0, FASTING_SHOW).map((w) => ({ day: w.day, v: w.kg })).reverse() : [];
  // 항목을 바꿔도 칩이 사라지지 않게 고른 항목과 상관없이 정한다. 인바디 한 번과 공복 체중 한 번도 체중 두 값이다
  if (records.length + fasting.length < 2) return null;
  const line = [...pts, ...extra].sort((a, b) => a.day.localeCompare(b.day));
  const W = 330, H = 150, PAD = 26;
  const vals = [...pts, ...extra].map((p) => p.v);
  const span = Math.max(...vals) - Math.min(...vals);
  const lo = Math.min(...vals) - Math.max(span * 0.15, 0.3), hi = Math.max(...vals) + Math.max(span * 0.15, 0.3);
  const time = (d: string) => Date.parse(`${d}T12:00:00`);
  const days = [...pts, ...extra].map((p) => time(p.day));
  const t0 = Math.min(...days), t1 = Math.max(...days);
  // 공복 체중이 있으면 날짜 간격대로, 없으면 지금처럼 측정마다 같은 간격으로
  const x = (i: number, d: string) => (extra.length ? (t1 === t0 ? W / 2 : PAD + ((time(d) - t0) * (W - PAD * 2)) / (t1 - t0)) : pts.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (pts.length - 1));
  const y = (v: number) => 20 + (H - 48) * (1 - (v - lo) / (hi - lo));
  const path = (extra.length ? line : pts).map((p, i) => `${i ? 'L' : 'M'}${x(i, p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const drawable = line.length >= 2;
  // 글자는 인바디 측정마다, 공복 체중은 그래프의 양 끝만. 날짜 간격대로 그리면 가까운 날의 글자가 겹쳐, 최근 측정부터 자리를 잡고 공복 체중은 남는 자리에 둔다
  const labelled = new Set(pts.map((p) => p.day));
  if (extra.length) {
    labelled.clear();
    const taken: number[] = [];
    for (const p of [...[...pts].reverse(), line[line.length - 1], line[0]]) {
      const at = x(0, p.day);
      if (taken.every((t) => Math.abs(t - at) >= LABEL_GAP)) {
        taken.push(at);
        labelled.add(p.day);
      }
    }
  }
  return (
    <section className="inbody-chart" aria-label="인바디 변화 그래프" data-testid="inbody-chart">
      <div className="inbody-chart-chips" role="group" aria-label="그래프 항목">
        {METRICS.map((x2) => (
          <button key={x2.key} type="button" aria-pressed={x2.key === metric} onClick={() => setMetric(x2.key)}>
            {x2.label}
          </button>
        ))}
      </div>
      <div className="inbody-chart-head">
        <b>{m.label}</b>
        <span className="tiny">
          {!known ? (extra.length ? `공복 체중 ${extra.length}번 · ${m.unit}` : m.unit) : `${extra.length ? `측정 ${pts.length}번 · 공복 체중 ${extra.length}번` : `최근 ${pts.length}번 측정`} · ${m.unit}`}
        </span>
      </div>
      {drawable ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="inbody-chart-svg" role="img" aria-label={`${m.label} 변화: ${pts.map((p) => `${p.day.slice(5).replace('-', '/')} ${p.v}`).join(', ')}${extra.length ? ` · 공복 체중 ${extra.map((p) => `${p.day.slice(5).replace('-', '/')} ${p.v}`).join(', ')}` : ''}`}>
          <path d={path} className="inbody-chart-line" />
          {extra.map((p) => (
            <circle key={`f${p.day}`} cx={x(0, p.day)} cy={y(p.v)} r={3.5} className="is-fasting" data-testid="fasting-point" />
          ))}
          {extra.filter((p) => labelled.has(p.day) && !pts.some((q) => q.day === p.day)).map((p) => (
            <g key={`e${p.day}`}>
              <text x={x(0, p.day)} y={y(p.v) - 10} textAnchor="middle" className="value">
                {p.v}
              </text>
              <text x={x(0, p.day)} y={H - 6} textAnchor="middle" className="date">
                {Number(p.day.slice(5, 7))}/{Number(p.day.slice(8))}
              </text>
            </g>
          ))}
          {pts.map((p, i) => {
            const last = i === pts.length - 1;
            return (
              <g key={p.day}>
                <circle cx={x(i, p.day)} cy={y(p.v)} r={last ? 5 : 3.5} className={last ? 'is-last' : ''} />
                {labelled.has(p.day) && (
                  <>
                    <text x={x(i, p.day)} y={y(p.v) - 10} textAnchor="middle" className={last ? 'value is-last' : 'value'}>
                      {p.v}
                    </text>
                    <text x={x(i, p.day)} y={H - 6} textAnchor="middle" className="date">
                      {Number(p.day.slice(5, 7))}/{Number(p.day.slice(8))}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      ) : (
        <p className="tiny">{known ? `${m.label} 기록이 두 개 이상이면 그래프로 볼 수 있어요.` : '인바디 기록을 불러오면 그래프를 보여 드려요.'}</p>
      )}
      {extra.length > 0 && (
        <div className="inbody-chart-legend">
          <span>
            <i className="is-inbody" />
            인바디 측정
          </span>
          <span>
            <i className="is-fasting" />
            공복 체중
          </span>
        </div>
      )}
    </section>
  );
}
