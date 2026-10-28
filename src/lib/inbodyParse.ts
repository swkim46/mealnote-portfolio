// 인바디 결과지(InBody270 형식) 글자 인식 결과에서 숫자 4개를 고르는 규칙. 화면·인식기와 떼어 두어 검증 스크립트에서 바로 돌린다.
// 같은 값을 여러 곳에서 읽어(체성분 표·골격근·지방 막대·신체변화 마지막 칸) 서로 맞는 값만 쓴다.
// 체성분 합계(체수분+단백질+무기질+체지방량≈체중)와 체지방률≈체지방량÷체중도 맞춰 본다.

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface OcrWord { text: string; bbox: Box }
export interface OcrLine { text: string; bbox: Box; words: OcrWord[] }
/** sparse: 흩어진 글자 찾기(막대·그래프 칸), 아니면 한 덩어리 글 */
export interface Region { key: string; rect: { left: number; top: number; width: number; height: number }; sparse?: boolean }
export interface RegionRead { key: string; text: string; words?: OcrWord[] }
export interface InbodyValues {
  measured_on: string | null;
  weight_kg: number | null;
  smm_kg: number | null;
  pbf_pct: number | null;
}

const clean = (s: string) => s.replace(/[\s|ㆍ·:_\-–—()[\]{}.,'"`]/g, '');

/** 항목 이름 → 결과지에 적힌 글자(한글·영문) */
const LABELS: Record<string, string[]> = {
  date: ['검사일시', 'TestDate'],
  water: ['체수분'],
  protein: ['단백질'],
  mineral: ['무기질'],
  fat: ['체지방량'],
  weight: ['체중'],
  smm: ['골격근량'],
  pbf: ['체지방률'],
};

export interface LabelHit { bbox: Box; after: string }

const isHangul = (s: string) => /[가-힣]/.test(s);

/**
 * 항목 이름 찾기. 한글은 글자마다 낱말로 쪼개져 나오는 일이 많아(예: "체 지 방 량") 같은 줄의 이어진 낱말을 붙여 맞춘다.
 * 더 긴 낱말의 일부(예: 적정체중, 체중조절)는 버린다: 바로 앞뒤에 붙어 있는 한글 낱말이 있으면 다른 항목이다.
 */
function findLabel(lines: OcrLine[], names: string[]): LabelHit[] {
  const out: LabelHit[] = [];
  for (const l of lines) {
    const ws = l.words;
    for (let i = 0; i < ws.length; i++) {
      let joined = '';
      for (let j = i; j < ws.length && joined.length < 12; j++) {
        joined += clean(ws[j].text);
        const name = names.find((n) => joined === n);
        if (!name) continue;
        const h = Math.max(...ws.slice(i, j + 1).map((w) => w.bbox.y1 - w.bbox.y0));
        const prev = ws[i - 1], next = ws[j + 1];
        const glued = (a: OcrWord | undefined, gap: number) => !!a && isHangul(clean(a.text).slice(-1) + clean(a.text).slice(0, 1)) && gap < h * 0.6;
        if (glued(prev, prev ? ws[i].bbox.x0 - prev.bbox.x1 : 0) || glued(next, next ? next.bbox.x0 - ws[j].bbox.x1 : 0)) break;
        const part = ws.slice(i, j + 1);
        out.push({
          bbox: { x0: Math.min(...part.map((w) => w.bbox.x0)), y0: Math.min(...part.map((w) => w.bbox.y0)), x1: Math.max(...part.map((w) => w.bbox.x1)), y1: Math.max(...part.map((w) => w.bbox.y1)) },
          after: ws.slice(j + 1).map((w) => w.text).join(' '),
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.bbox.y0 - b.bbox.y0);
}

const rect = (x0: number, y0: number, x1: number, y1: number, W: number, H: number) => {
  const left = Math.max(0, Math.round(x0)), top = Math.max(0, Math.round(y0));
  const right = Math.min(W, Math.round(x1)), bottom = Math.min(H, Math.round(y1));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
};

/** 항목별 막대 눈금(이 중 연달아 3개가 한 줄에 있으면 그 막대). 소수점이 빠져 읽히는 일(5.0→50)이 있어 둘 다 둔다. */
const runs = (xs: number[]) => xs.slice(0, -2).map((_, i) => xs.slice(i, i + 3));
const SCALES: Record<string, number[][]> = {
  weight: runs([55, 70, 85, 100, 115, 130, 145, 160, 175, 190, 205]),
  smm: runs([70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170]),
  // 비만분석 BMI 눈금(10.0 15.0 18.5 22.0 …)과 겹치지 않게 앞쪽만. 소수점이 빠진 경우(0.0 5.0 → 00 50)도.
  pbf: [[0, 5, 10], [5, 10, 15], [10, 15, 20], [15, 20, 25], [0, 50, 100], [50, 100, 150], [100, 150, 200], [150, 200, 250]],
};

function findScale(lines: OcrLine[], key: string, top: number, bottom: number): Box | null {
  for (const l of lines) {
    if (l.bbox.y0 <= top || l.bbox.y0 >= bottom) continue;
    const ws = l.words.filter((w) => /^\d{1,3}(\.\d)?$/.test(w.text.trim()));
    const ns = ws.map((w) => Number(w.text.trim()));
    for (const seq of SCALES[key])
      for (let i = 0; i + 2 < ns.length; i++)
        if (ns[i] === seq[0] && ns[i + 1] === seq[1] && ns[i + 2] === seq[2]) {
          const xs = ws.map((w) => w.bbox);
          return { x0: Math.min(...xs.map((b) => b.x0)), y0: Math.min(...xs.map((b) => b.y0)), x1: Math.max(...xs.map((b) => b.x1)), y1: Math.max(...xs.map((b) => b.y1)) };
        }
  }
  return null;
}

/** 신체변화 표 아래 날짜 줄(26.10.02. 같은 낱말 2개 이상)에서 가장 오른쪽 칸 */
function lastDateColumn(lines: OcrLine[], historyTop: number): Box | null {
  let best: Box | null = null;
  for (const l of lines) {
    if (l.bbox.y0 <= historyTop) continue;
    const ds = l.words.filter((w) => /^\d{2}\.\d{1,2}\.\d{1,2}\.?$/.test(w.text.trim()));
    if (ds.length < 2) continue;
    const last = ds.reduce((a, b) => (b.bbox.x0 > a.bbox.x0 ? b : a));
    if (!best || last.bbox.y0 > best.y0) best = last.bbox;
  }
  return best;
}

/**
 * 양식 고정 위치(결과지 한 장 전체 기준 비율). 스캔본·PDF 화면처럼 사진 전체가 결과지이면 숫자 칸은 늘 같은 자리다.
 * 흐리거나 작은 사진에서 항목 이름을 못 찾아도 이 자리를 읽어 후보를 더한다(2026-10-26: 가로 1200px로 줄인 결과지에서 이름을 놓쳐 1/4만 읽힘).
 * 좌표는 받은 InBody270 결과지(1600×2255)에서 잰 값. 비율이 결과지와 다르면(휴대폰으로 찍은 사진 등) 쓰지 않는다.
 */
const SHEET_RATIO = 1600 / 2255;
const TEMPLATE: { key: string; box: [number, number, number, number]; sparse?: boolean }[] = [
  { key: 'date', box: [0.455, 0.077, 0.62, 0.098] },
  { key: 'comp_water', box: [0.425, 0.141, 0.62, 0.165] },
  { key: 'comp_protein', box: [0.425, 0.164, 0.62, 0.188] },
  { key: 'comp_mineral', box: [0.425, 0.187, 0.62, 0.211] },
  { key: 'comp_fat', box: [0.425, 0.21, 0.62, 0.234] },
  { key: 'comp_weight', box: [0.425, 0.233, 0.62, 0.257] },
  { key: 'bar_weight', box: [0.15, 0.335, 0.625, 0.353], sparse: true },
  { key: 'bar_smm', box: [0.15, 0.364, 0.625, 0.382], sparse: true },
  { key: 'bar_pbf', box: [0.15, 0.517, 0.625, 0.535], sparse: true },
  { key: 'hist_weight', box: [0.56, 0.848, 0.62, 0.876], sparse: true },
  { key: 'hist_smm', box: [0.56, 0.882, 0.62, 0.912], sparse: true },
  { key: 'hist_pbf', box: [0.56, 0.916, 0.62, 0.943], sparse: true },
];

function templateRegions(W: number, H: number): Region[] {
  if (Math.abs(W / H - SHEET_RATIO) > 0.04) return [];
  return TEMPLATE.map((t) => ({ key: `t_${t.key}`, sparse: t.sparse, rect: rect(t.box[0] * W, t.box[1] * H, t.box[2] * W, t.box[3] * H, W, H) }));
}

/** 2차로 숫자만 다시 읽을 영역들 */
function regionsFor(lines: OcrLine[], W: number, H: number): Region[] {
  const regions: Region[] = [];
  const add = (key: string, r: Region['rect'], sparse = false) => regions.push({ key, rect: r, sparse });
  const date = findLabel(lines, LABELS.date)[0];
  if (date) {
    const h = date.bbox.y1 - date.bbox.y0, w = date.bbox.x1 - date.bbox.x0;
    add('date', rect(date.bbox.x0 - w * 0.3, date.bbox.y1, date.bbox.x0 + w * 3.2, date.bbox.y1 + h * 2.4, W, H));
  }
  // 체성분 표: 각 항목의 맨 위(첫) 등장 줄의 오른쪽 "(kg) 69.0 ( 57.9~78.3 )"
  for (const key of ['water', 'protein', 'mineral', 'fat', 'weight']) {
    const w = findLabel(lines, LABELS[key])[0];
    if (!w) continue;
    const h = w.bbox.y1 - w.bbox.y0;
    add(`comp_${key}`, rect(w.bbox.x1, w.bbox.y0 - h * 0.4, w.bbox.x1 + W * 0.3, w.bbox.y1 + h * 0.4, W, H));
  }
  // 막대(골격근·지방분석, 비만분석): 값은 눈금 숫자 줄 바로 아래, 막대 오른쪽 끝에 있다.
  // 눈금 숫자는 항목마다 달라서(체중 115·130·145, 골격근량 110·120·130 …) 이름보다 잘 읽힌다 → 눈금 줄을 먼저 찾고, 없으면 이름으로.
  const compBottom = Math.max(0, ...regions.filter((r) => r.key.startsWith('comp_')).map((r) => r.rect.top + r.rect.height));
  const history = findLabel(lines, ['신체변화'])[0]?.bbox.y0 ?? H * 0.8;
  for (const key of ['weight', 'smm', 'pbf']) {
    const sc = findScale(lines, key, compBottom, history);
    if (sc) {
      const h = sc.y1 - sc.y0;
      // 눈금 글씨는 작아서 그 높이 대신 쪽 높이에 맞춰 아래로 넉넉히(다음 줄 눈금은 barValue가 뺀다)
      add(`bar_${key}`, rect(sc.x0 - h, sc.y1 - h * 0.1, W * 0.63, sc.y1 + Math.max(h * 2.2, H * 0.022), W, H), true);
    } else {
      const bar = findLabel(lines, LABELS[key]).find((w) => w.bbox.y0 > compBottom + 2 && w.bbox.y0 < history);
      if (bar) {
        const h = bar.bbox.y1 - bar.bbox.y0;
        add(`bar_${key}`, rect(bar.bbox.x1 + W * 0.05, bar.bbox.y0 - h * 0.2, W * 0.63, bar.bbox.y1 + h * 1.3, W, H), true);
      }
    }
    // 신체변화(과거 기록 표): 맨 아래 날짜 줄의 마지막 칸이 이번 측정
    const hist = findLabel(lines, LABELS[key]).filter((w) => w.bbox.y0 > history).pop();
    if (hist) {
      const h = hist.bbox.y1 - hist.bbox.y0;
      const col = lastDateColumn(lines, history);
      const cw = col ? col.x1 - col.x0 : 0;
      const x0 = col ? col.x0 - cw * 0.6 : hist.bbox.x1 + W * 0.05;
      const x1 = col ? col.x1 + cw * 0.6 : W * 0.63;
      add(`hist_${key}`, rect(x0, hist.bbox.y0 - h * 0.9, x1, hist.bbox.y1 + h * 0.6, W, H), true);
    }
  }
  return [...regions, ...templateRegions(W, H)];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * "69.0 ( 57.9~78.3 )" → 69.0  (괄호 안 정상 범위는 버린다)
 * 흐린 사진에서 소수점이 빠져 "156 (" 처럼 읽히면 항목의 소수 자리(무기질 2, 나머지 1)로 되살린다.
 * 되살린 값은 체성분 합계가 체중과 맞을 때만 쓰인다(values 참고).
 */
function compValue(text: string, decimals = 1): { v: number; exact: boolean } | null {
  const t = text.replace(/\s+/g, ' ');
  const m = /(\d{1,3}\.\d{1,2})\s*\(/.exec(t);
  if (m) return { v: Number(m[1]), exact: true };
  const lost = /(?<![\d.])(\d{2,4})\s*\(/.exec(t);
  return lost && lost[1].length === decimals + (decimals === 2 ? 1 : 2) ? { v: Number(lost[1]) / 10 ** decimals, exact: false } : null;
}

const DECIMAL = /^\d{1,3}\.\d$/;
const NUMERIC = /^[\d.]+$/;

/** 막대 영역: 눈금 줄(숫자 4개 이상이 한 줄)은 빼고 남은 소수 하나 */
function barValue(read: RegionRead): number | null {
  const ws = (read.words ?? []).map((w) => ({ t: w.text.trim(), b: w.bbox })).filter((w) => NUMERIC.test(w.t));
  const rowOf = (w: (typeof ws)[number]) => ws.filter((o) => Math.abs((o.b.y0 + o.b.y1) / 2 - (w.b.y0 + w.b.y1) / 2) < (w.b.y1 - w.b.y0) * 0.5);
  const alone = ws.filter((w) => rowOf(w).length < 4);
  const vals = alone.filter((w) => DECIMAL.test(w.t)).map((w) => Number(w.t));
  if (vals.length === 1) return vals[0];
  // 소수점이 빠져 '236'처럼 읽힌 경우: 세 자리 숫자 하나뿐이면 23.6으로 본다(다른 곳에서 읽은 값과 맞을 때만 채택된다)
  const lost = alone.filter((w) => /^\d{3}$/.test(w.t));
  return !vals.length && lost.length === 1 ? Number(lost[0].t) / 10 : null;
}

/** 신체변화 표: 가장 오른쪽 소수 */
function histValue(read: RegionRead): number | null {
  const ws = (read.words ?? []).filter((w) => DECIMAL.test(w.text.trim()));
  if (ws.length) return Number(ws.reduce((a, b) => (b.bbox.x0 > a.bbox.x0 ? b : a)).text.trim());
  const lost = (read.words ?? []).filter((w) => /^\d{3}$/.test(w.text.trim()));
  if (lost.length === 1) return Number(lost[0].text.trim()) / 10;
  const ds = [...read.text.matchAll(/\d{1,3}\.\d/g)];
  return ds.length ? Number(ds[ds.length - 1][0]) : null;
}

function parseDate(text: string, today = new Date()): string | null {
  for (const m of text.matchAll(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) continue;
    if (dt.getTime() > today.getTime() + 86_400_000) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** 후보 중 서로 맞는(차이 tol 이하) 값이 가장 많은 것. 둘 이상 맞아야 채택. */
function vote(cands: (number | null)[], tol: number): number | null {
  const xs = cands.filter((x): x is number => x !== null && Number.isFinite(x));
  let best: number | null = null, bestN = 1;
  for (const x of xs) {
    const n = xs.filter((y) => Math.abs(y - x) <= tol).length;
    if (n > bestN) [best, bestN] = [x, n];
  }
  return best;
}

function values(lines: OcrLine[], reads: RegionRead[], today = new Date()): InbodyValues {
  const by = (k: string) => reads.find((r) => r.key === k);
  // 같은 자리(칸)를 이름으로 찾은 영역과 양식 고정 위치로 각각 읽었으면 한 후보로 합친다(같은 인쇄 숫자를 두 표로 세지 않는다).
  // 이름으로 찾은 쪽을 먼저 믿고, 없으면 고정 위치 값.
  // 체성분 표 값: 2차(숫자 전용)와 1차 줄 글자에서 각각 읽어, 소수점까지 읽힌 값을 먼저
  const comp = (k: string) => {
    const dec = k === 'mineral' ? 2 : 1;
    const label = findLabel(lines, LABELS[k])[0];
    const reads = [by(`comp_${k}`), by(`t_comp_${k}`)].map((r) => (r ? compValue(r.text, dec) : null));
    reads.push(label ? compValue(label.after, dec) : null);
    return (reads.find((x) => x?.exact) ?? reads.find((x) => x))?.v ?? null;
  };
  const first = (...xs: (number | null)[]) => xs.find((x) => x !== null) ?? null;
  const bar = (k: string) => first(...[by(`bar_${k}`), by(`t_bar_${k}`)].map((r) => (r ? barValue(r) : null)));
  const hist = (k: string) => first(...[by(`hist_${k}`), by(`t_hist_${k}`)].map((r) => (r ? histValue(r) : null)));

  const measured_on =
    parseDate(by('date')?.text ?? '', today) ?? parseDate(lines.map((l) => l.text).join('\n'), today) ?? parseDate(by('t_date')?.text ?? '', today);

  const [water, protein, mineral, fat, wComp] = ['water', 'protein', 'mineral', 'fat', 'weight'].map(comp);
  const sum = water !== null && protein !== null && mineral !== null && fat !== null ? round1(water + protein + mineral + fat) : null;
  let weight = vote([wComp, bar('weight'), hist('weight'), sum], 0.15);
  if (weight !== null && (weight < 20 || weight > 300)) weight = null;
  // 체성분 합계가 체중과 맞으면 체지방량도 믿는다
  const fatOk = fat !== null && weight !== null && sum !== null && Math.abs(sum - weight) <= 0.3;
  const pbfCalc = fatOk ? round1((fat! / weight!) * 100) : null;
  let pbf = vote([bar('pbf'), hist('pbf'), pbfCalc], 0.15);
  if (pbf === null && pbfCalc !== null) pbf = pbfCalc;
  if (pbf !== null && (pbf < 1 || pbf > 75)) pbf = null;

  const lean = weight !== null && pbf !== null ? weight * (1 - pbf / 100) : null;
  const plausibleSmm = (x: number | null) => x !== null && x >= 5 && x <= 100 && (lean === null || (x >= lean * 0.4 && x <= lean * 0.75));
  const smmCands = [bar('smm'), hist('smm')];
  let smm = vote(smmCands, 0.05);
  // 한 곳에서만 읽었으면 체중을 알 때만(체중 대비 범위로 걸러야 엉뚱한 값을 막는다)
  if (smm === null && weight !== null) {
    const ok = smmCands.filter((x) => plausibleSmm(x) && x! <= weight! * 0.7);
    smm = ok.length === 1 ? ok[0] : null;
  }
  if (smm !== null && !plausibleSmm(smm)) smm = null;
  return { measured_on, weight_kg: weight, smm_kg: smm, pbf_pct: pbf };
}

export const parseInbody = { regionsFor, values, parseDate, compValue, barValue };
