// 트레이너 루틴 시트 읽기(v2.0). 원본은 여기 하나 — 앱(src/lib/routineSheet.ts)과 서버 기능 sheet-import가 같이 쓴다(2026-10-30 자동 반영).
// 시트 API로 받은 칸 배열과, 시트에서 복사해 붙여 넣은 글(줄=줄바꿈, 칸=탭) 모두 이 규칙으로 읽는다.
// 양식(2026-10-30 실제 시트 확인): 한 달이 탭 하나 · 맨 위 '본 운동 전 필수 동작' 몇 줄 · 운동 날마다 숫자 한 칸(1, 2, 3)으로 시작하는 블록 ·
// 블록의 제목줄 SET | REPS | 중량 | … | REST, 그 아래 운동 줄(운동 이름은 SET 칸 왼쪽) · 블록 끝 '컨디션'·'운동한 날' 줄은 건너뜀.
// 중량·횟수는 '32+40'·'10/10'·'30 S'처럼 글자가 섞여 그대로 글자로 둔다. 세트만 숫자. 읽지 못한 칸은 비우고 알림(추측해 채우지 않음).
/** 루틴 운동 한 줄(앱의 RoutineItemInput과 같은 모양) */
export interface RoutineItemInput {
  day_no: number;
  name: string;
  weight: string;
  reps: string;
  sets: number | null;
  rest: string;
  note: string;
}

export interface SheetRoutine {
  warmup: string;
  items: RoutineItemInput[];
  problems: string[];
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const dash = (s: string) => (/^[-–—]$/.test(s) ? '' : s);
// 시트 표기(2.3 — 회원마다 시트 양식이 달라 흔한 표기를 함께 읽는다, 사용자 결정 2026-11-05). 읽기·쓰기가 같은 규칙을 쓰도록 여기 한 곳에 둔다
const SET_TITLE = /^(set|sets|세트|세트\s*수)$/i;
const REPS_TITLE = /^(reps?|횟수|회수|반복|반복\s*수)$/i;
const WEIGHT_TITLE = /^(중량|무게|kg|weight)(\s*\(\s*kg\s*\))?$/i;
const REST_TITLE = /^(rest|휴식|휴식\s*시간|쉬는\s*시간)$/i;
const DATE_ROW = /^(운동한\s*날|운동\s*날짜|운동일|날짜)$/;
const DAY_MARKER = /^(?:day\s*|루틴\s*)?([1-9]|10)(?:\s*일차)?$/i;
const isDayMarker = (cells: string[]) => {
  const filled = cells.filter(Boolean);
  const m = filled.length === 1 ? DAY_MARKER.exec(filled[0]) : null;
  return m ? Number(m[1]) : null;
};
const findCol = (cells: string[], re: RegExp) => cells.findIndex((c) => re.test(c));

/**
 * sheet: 시트를 읽을 때(서버 기능 자동 반영)는 운동 제목줄(SET·REPS)이 나온 뒤의 줄만 운동으로 본다 — 제목줄 없이 읽으면 메모만 있는 탭도
 * 운동으로 저장된다(2026-10-30 검증에서 발견). 붙여넣기는 제목줄 없이 복사하는 일이 많아 시트 순서 기본값으로 읽는다.
 */
export function parseRoutineRows(input: string[][], opts: { sheet?: boolean } = {}): SheetRoutine {
  const rows = input.map((r) => r.map(clean));
  const warm: string[] = [];
  const items: RoutineItemInput[] = [];
  const problems: string[] = [];
  let mode: 'none' | 'warmup' | 'day' = 'none';
  let day = 1;
  // 시트 순서 기본값(제목줄이 없는 붙여넣기): 운동 · SET · REPS · 중량 · REST
  let cols = { set: 1, reps: 2, weight: 3, rest: 4 };
  let sawHeader = false;
  rows.forEach((cells, i) => {
    const filled = cells.filter(Boolean);
    if (!filled.length) return;
    const line = `${i + 1}째 줄`;
    if (filled.some((c) => /필수\s*동작|운동\s*전/.test(c))) return void (mode = 'warmup');
    const marker = isDayMarker(cells);
    if (marker !== null) {
      day = marker;
      mode = 'day';
      return;
    }
    const setCol = findCol(cells, SET_TITLE);
    // '날짜' 칸이 있는 제목줄이 있어 SET 제목이 없는 줄만 날짜 줄로 본다
    if (setCol < 0 && filled.some((c) => c === '컨디션' || DATE_ROW.test(c))) return;
    if (setCol >= 0) {
      // 제목줄에 이름이 빠진 칸은 시트 순서(SET 다음 REPS, 그다음 중량)로 본다 — 실제 시트의 3일차 블록은 '중량' 칸 제목이 비어 있었다
      const reps = findCol(cells, REPS_TITLE);
      const weight = findCol(cells, WEIGHT_TITLE);
      cols = {
        set: setCol,
        reps: reps >= 0 ? reps : setCol + 1,
        weight: weight >= 0 ? weight : (reps >= 0 ? reps : setCol + 1) + 1,
        rest: findCol(cells, REST_TITLE),
      };
      sawHeader = true;
      mode = 'day';
      return;
    }
    if (mode === 'warmup') return void warm.push(...filled);
    if (opts.sheet && !sawHeader) return;
    const first = cells.findIndex(Boolean);
    const nameAt = first;
    if (sawHeader && nameAt >= cols.set) return; // 운동 이름 없이 숫자만 있는 줄
    const name = cells[nameAt];
    const at = (k: number) => (k >= 0 ? (cells[k] ?? '') : '');
    const setText = at(sawHeader ? cols.set : nameAt + cols.set);
    const repsText = dash(at(sawHeader ? cols.reps : nameAt + cols.reps));
    const weightText = dash(at(sawHeader ? cols.weight : nameAt + cols.weight));
    const restText = dash(at(sawHeader ? cols.rest : nameAt + cols.rest));
    const sets = /^\d+$/.test(setText) && Number(setText) >= 1 && Number(setText) <= 20 ? Number(setText) : null;
    if (setText && sets === null) problems.push(`${line} '${name}': 세트 '${setText}'을 읽지 못했어요`);
    items.push({ day_no: day, name: name.slice(0, 60), weight: weightText.slice(0, 30), reps: repsText.slice(0, 30), sets, rest: restText.slice(0, 10), note: '' });
  });
  if (opts.sheet && !sawHeader) problems.push('운동 제목줄(SET·REPS)을 찾지 못했어요');
  if (items.length > 80) problems.push('운동은 80개까지 가져올 수 있어요');
  return { warmup: warm.join('\n').slice(0, 1000), items: items.slice(0, 80), problems };
}

/** 시트에서 복사해 붙여 넣은 글 */
export const parseRoutinePaste = (text: string) =>
  parseRoutineRows(
    text
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.split('\t')),
  );

/** 기본으로 읽을 탭: 이름이 '연월 4자리'(예: 2610)인 탭 중 가장 최근, 없으면 첫 탭 */
export const pickTab = (tabs: string[]) => {
  const months = tabs.filter((t) => /^\d{4}$/.test(t)).sort();
  return months[months.length - 1] ?? tabs[0] ?? '';
};

/** 시트 탭 이름 2610 → '26년 10월 루틴' */
export const tabTitle = (tab: string) => (/^\d{4}$/.test(tab) ? `${tab.slice(0, 2)}년 ${Number(tab.slice(2))}월 루틴` : `${tab} 루틴`);

// ─── v2.1 시트의 회차 기록(2026-11-02 사용자 피드백: 이전 운동 기록 불러오기 · 앱에서 기록하면 시트로) ───
// 실제 시트(2026-11-02 탭 열 개 확인): 블록 제목줄 SET | REPS | 중량 | (빈 칸 몇 개) | REST. 중량 칸부터 REST 앞까지가 회차 칸이고
// 회차마다 한 칸(운동마다 그 회차의 무게 하나)을 적는다. 블록 끝 '운동한 날' 줄의 같은 열에 그 회차 날짜가 있다.
// REST 뒤 열에 회차를 더 적은 달도 있다 — 가져올 때는 날짜가 있으면 읽고, 앱이 쓸 때는 REST 앞까지만 쓴다.
// 날짜는 '10/20'·'10.20'·'2026.06.22'처럼 섞여 있고 연도가 없으면 탭 이름(연월 4자리, 예: 2512)에서 정한다.

/** 블록 하나(루틴 N): 제목줄·열 위치·운동 줄·'운동한 날' 줄. 행·열 번호는 0부터, restCol -1이면 REST 칸 없음 */
export interface SheetBlock {
  day_no: number;
  header: number;
  setCol: number;
  repsCol: number;
  weightCol: number;
  restCol: number;
  rows: { row: number; name: string; sets: number | null; reps: string }[];
  dateRow: number | null;
}

/** 시트의 블록 배치(시트 읽기 규칙과 같다: 제목줄이 나온 뒤의 줄만 운동, 필수 동작·컨디션 줄은 건너뜀) */
export function parseSheetLayout(input: string[][]): SheetBlock[] {
  const rows = input.map((r) => r.map(clean));
  const blocks: SheetBlock[] = [];
  let day = 1;
  let cur: SheetBlock | null = null;
  let warm = false;
  rows.forEach((cells, i) => {
    const filled = cells.filter(Boolean);
    if (!filled.length) return;
    if (filled.some((c) => /필수\s*동작|운동\s*전/.test(c))) return void (warm = true);
    const marker = isDayMarker(cells);
    if (marker !== null) {
      day = marker;
      cur = null;
      warm = false;
      return;
    }
    const setCol = findCol(cells, SET_TITLE);
    if (setCol < 0 && filled.some((c) => DATE_ROW.test(c))) {
      if (cur) cur.dateRow = i;
      return;
    }
    if (setCol < 0 && filled.some((c) => /^컨디션$/.test(c))) return;
    if (setCol >= 0) {
      const reps = findCol(cells, REPS_TITLE);
      const weight = findCol(cells, WEIGHT_TITLE);
      const repsCol = reps >= 0 ? reps : setCol + 1;
      cur = { day_no: day, header: i, setCol, repsCol, weightCol: weight >= 0 ? weight : repsCol + 1, restCol: findCol(cells, REST_TITLE), rows: [], dateRow: null };
      blocks.push(cur);
      warm = false;
      return;
    }
    if (warm || !cur) return;
    const nameAt = cells.findIndex(Boolean);
    if (nameAt >= cur.setCol) return;
    const setText = cells[cur.setCol] ?? '';
    const sets = /^\d+$/.test(setText) && Number(setText) >= 1 && Number(setText) <= 20 ? Number(setText) : null;
    cur.rows.push({ row: i, name: cells[nameAt].slice(0, 60), sets, reps: dash(cells[cur.repsCol] ?? '').slice(0, 30) });
  });
  return blocks;
}

/** 열 번호 → 시트 열 이름(0 → A, 26 → AA) */
export function colName(col: number): string {
  let s = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 탭 이름 앞 연월 4자리(예: '2512', '2606의 사본') → {y, m}. 없으면 null */
export function tabMonth(tab: string): { y: number; m: number } | null {
  const t = /^(\d{2})(\d{2})/.exec(tab.trim());
  const m = t ? Number(t[2]) : 0;
  return t && m >= 1 && m <= 12 ? { y: 2000 + Number(t[1]), m } : null;
}

/**
 * 지난 기록을 가져올 탭: 연월(앞 4자리)마다 하나. 같은 달에 '2610'과 '2610의 사본'이 함께 있으면 '2610'만,
 * 그 달 탭이 '2512/back/up'처럼 하나뿐이면 그것을 쓴다(실제 시트, 2026-11-02 적대 검토 — 사본 탭이 같은 회차를 한 번 더 가져왔다)
 */
export function pickMonthTabs(tabs: string[]): string[] {
  const byMonth = new Map<string, string>();
  for (const t of tabs) {
    const m = tabMonth(t);
    if (!m) continue;
    const key = t.trim().slice(0, 4);
    const cur = byMonth.get(key);
    if (!cur || (t.trim() === key && cur.trim() !== key)) byMonth.set(key, t);
  }
  return [...byMonth.values()];
}

const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
/** 연도 없는 날짜의 연도: 탭 달에서 반년 넘게 떨어지면 다음 해·지난해로(2512 탭의 1/6 → 2026) */
const yearNear = (tm: { y: number; m: number }, month: number) => tm.y + (month - tm.m < -6 ? 1 : month - tm.m > 6 ? -1 : 0);

/**
 * '운동한 날' 칸 → 'YYYY-MM-DD'. 연도가 적혀 있어도 탭 달에서 두 달 넘게 떨어지면 탭 기준 연도로 고쳐 읽고 fixed로 알린다
 * (실제 시트: 2606 탭의 '2025.07.10'). 읽지 못하면 null
 */
export function parseSheetDate(text: string, tab: string): { date: string; fixed: boolean } | null {
  const t = clean(text);
  const tm = tabMonth(tab);
  const full = /^(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\.?$/.exec(t);
  if (full) {
    const [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    if (!tm || Math.abs(y * 12 + m - (tm.y * 12 + tm.m)) <= 2) {
      const date = iso(y, m, d);
      return date ? { date, fixed: false } : null;
    }
    const date = iso(yearNear(tm, m), m, d);
    return date ? { date, fixed: true } : null;
  }
  const md = /^(\d{1,2})\s*[./]\s*(\d{1,2})\.?$/.exec(t);
  if (!md || !tm) return null;
  const date = iso(yearNear(tm, Number(md[1])), Number(md[1]), Number(md[2]));
  return date ? { date, fixed: false } : null;
}

/** 탭에 이미 적힌 날짜 표기를 따라 쓴다: '2026.06.22' · '10.20' · 기본 '10/20' */
export function formatSheetDate(date: string, samples: string[]): string {
  const [y, m, d] = date.split('-').map(Number);
  const s = samples.map(clean).find(Boolean) ?? '';
  if (/^\d{4}\./.test(s)) return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
  if (/^\d{1,2}\.\d{1,2}$/.test(s)) return `${m}.${String(d).padStart(2, '0')}`;
  return `${m}/${d}`;
}

/** 시트의 회차 기록 하나: 루틴 N의 열 하나(그 회차 날짜와, 값이 있는 운동들) */
export interface SheetSession {
  day_no: number;
  col: number;
  date: string;
  items: { name: string; sets: number | null; reps: string; weight: string }[];
}

/** 날짜가 탭의 달에서 두 달 안인지(연말을 넘겨도 달 수로 센다) */
const nearTab = (date: string, tab: string) => {
  const tm = tabMonth(tab);
  if (!tm) return false;
  const [y, m] = date.split('-').map(Number);
  return Math.abs(y * 12 + m - (tm.y * 12 + tm.m)) <= 2;
};

/**
 * 탭 하나의 회차 기록. 값이 있는 칸 = 그 회차에 한 운동(무게는 칸 글자 그대로, '-'는 무게 없이 함), 빈 칸 = 하지 않음.
 * 날짜가 없는 열·읽지 못한 날짜는 가져오지 않고 problems로 알린다. REST 뒤 열은 날짜가 있을 때만 회차로 본다(메모 칸일 수 있다).
 * 탭의 달에서 두 달 넘게 떨어진 날짜, today(YYYY-MM-DD)를 주면 그 뒤의 날짜도 가져오지 않는다 — 연도를 추측해 미래 기록이 생기지 않게(적대 검토 11-02)
 */
export function parseSheetRecords(input: string[][], tab: string, today?: string): { sessions: SheetSession[]; problems: string[] } {
  const rows = input.map((r) => r.map(clean));
  const sessions: SheetSession[] = [];
  const problems: string[] = [];
  for (const b of parseSheetLayout(input)) {
    const dates = b.dateRow === null ? [] : rows[b.dateRow];
    const width = Math.max(dates.length, ...b.rows.map((r) => rows[r.row].length));
    for (let col = b.weightCol; col < width; col++) {
      if (col === b.restCol) continue;
      const dateText = dates[col] ?? '';
      if (b.restCol >= 0 && col > b.restCol && !dateText) continue;
      const items = b.rows.map((r) => ({ name: r.name, sets: r.sets, reps: r.reps, cell: rows[r.row][col] ?? '' })).filter((x) => x.cell !== '');
      if (!items.length) continue;
      const where = `${tab} 탭 루틴 ${b.day_no}의 ${colName(col)}열`;
      if (!dateText) {
        problems.push(`${where}: 운동한 날이 비어 있어 가져오지 않았어요`);
        continue;
      }
      const d = parseSheetDate(dateText, tab);
      if (!d) {
        problems.push(`${where}: 날짜 '${dateText}'를 읽지 못했어요`);
        continue;
      }
      if (!nearTab(d.date, tab) || (today && d.date > today)) {
        problems.push(`${where}: 날짜 '${dateText}'가 탭의 달과 멀거나 아직 오지 않은 날이라 가져오지 않았어요`);
        continue;
      }
      if (d.fixed) problems.push(`${where}: 날짜 '${dateText}'는 탭의 달에 맞춰 ${d.date}로 읽었어요`);
      sessions.push({ day_no: b.day_no, col, date: d.date, items: items.map((x) => ({ name: x.name, sets: x.sets, reps: x.reps, weight: dash(x.cell).slice(0, 30) })) });
    }
  }
  return { sessions, problems };
}

/** 무게 글자 → 견줄 숫자 목록('20+5' → [20, 5], '60-' → [60]). 숫자가 없으면 빈 목록 */
export const weightKey = (v: string) => (v.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
/** a가 b보다 무거운지: 앞 숫자부터 차례로 견준다 */
export const heavier = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d > 0;
  }
  return false;
};
/** 무게 글자의 모양: 숫자 자리를 #로('20+5' → '#+#', '60-' → '#-') */
const weightShape = (v: string) => v.replace(/\d+(?:\.\d+)?/g, '#');

/**
 * 루틴 블록의 운동마다 시트 칸 값(블록 순서대로) — 서버 기능 sheet-write와 앱의 '시트용으로 복사'가 같이 쓴다.
 * 같은 이름의 운동이 블록에 둘 이상이면(준비 세트·본 세트처럼) 세트를 루틴 항목(item_id)으로 가르고, 아니면 이름으로 모은다 —
 * 이름으로만 모으면 두 줄에 같은 값이 들어갔다(2026-11-03 적대 검토 F13). 이름은 부르는 쪽이 같은 꼴(앞뒤 공백 정리)로 넘긴다.
 */
export function blockCellValues(items: { id: string; name: string }[], sets: { item_id: string | null; name: string; kg: string | null; done: boolean }[]): string[] {
  const count = new Map<string, number>();
  for (const i of items) count.set(i.name, (count.get(i.name) ?? 0) + 1);
  return items.map((i) => sheetCellFor(sets.filter((x) => ((count.get(i.name) ?? 0) > 1 ? x.item_id === i.id : x.name === i.name))));
}

/** 기호 없는 숫자 하나('40'·'40.0'·'040'·'12.50') */
const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;
/**
 * 시트 칸에 쓰는 값의 표기(2026-11-03 Codex v2.1.0 3차 리뷰 P2): 기호 없는 숫자는 숫자로 보내므로 시트가 기본으로 보이는 꼴('40.0' → '40',
 * '040' → '40', '12.50' → '12.5')로 맞춘다 — 보낸 값과 '앱이 쓴 칸'으로 적어 두는 값이 같게. 기호가 든 무게('20+5'·'14,16')는 글자 그대로이되,
 * 공백은 시트를 읽을 때(sheet-write의 clean)와 같이 하나로 줄인다('20 +  5' → '20 + 5' — 다시 읽은 칸과 글자가 같게, 적대 검토 11-03)
 */
export const canonCell = (v: string) => {
  const t = v.replace(/\s+/g, ' ').trim();
  return PLAIN_NUMBER.test(t) ? String(Number(t)) : t;
};
/**
 * 시트 칸 값이 앱이 적어 둔 값과 같은가: 둘 다 기호 없는 숫자면 숫자로 견준다 — 칸의 표시 형식이 '40.0'처럼 소수를 보여도 같은 값.
 * 기호가 든 값은 공백을 줄인 글자가 같아야 같다('20+5'를 숫자로 합치거나 바꾸지 않는다)
 */
export const sameCell = (a: string, b: string) => {
  const x = a.replace(/\s+/g, ' ').trim(), y = b.replace(/\s+/g, ' ').trim();
  return PLAIN_NUMBER.test(x) && PLAIN_NUMBER.test(y) ? Number(x) === Number(y) : x === y;
};

/**
 * 앱 기록 한 운동 → 시트 칸 하나: 완료한 세트 가운데 가장 높은 무게(세트마다 다르면 높은 쪽만 — 2026-11-02 사용자 결정),
 * 무게 없이 했으면 '-', 완료한 세트가 없으면 빈 글자(쓰지 않음).
 * 기호가 든 무게('20+5' = 두 동작의 무게)는 두 무게를 다 쓰고, 동작마다 따로 높은 쪽을 고른다('20+5'·'18+8' → '20+8', 사용자 11-02).
 * 세트끼리 모양이 다르면('60-'·'62.5') 앞 숫자부터 견줘 한 세트의 값을 그대로 쓴다
 */
export function sheetCellFor(sets: { kg: string | null; done: boolean }[]): string {
  const done = sets.filter((s) => s.done);
  if (!done.length) return '';
  const kgs = done.map((s) => (s.kg ?? '').trim()).filter(Boolean);
  if (!kgs.length) return '-';
  const shape = weightShape(kgs[0]);
  if (shape.includes('#') && kgs.every((k) => weightShape(k) === shape)) {
    const parts = kgs.map((k) => k.match(/\d+(?:\.\d+)?/g) ?? []);
    const best = parts[0].map((_, i) => parts.reduce((m, p) => (Number(p[i]) > Number(m) ? p[i] : m), parts[0][i]));
    let i = 0;
    return canonCell(kgs[0].replace(/\d+(?:\.\d+)?/g, () => best[i++]).slice(0, 50));
  }
  let best = kgs[0];
  for (const k of kgs.slice(1)) if (heavier(weightKey(k), weightKey(best))) best = k;
  best = canonCell(best);
  return best.slice(0, 50);
}

/**
 * 앱 기록을 쓸 수 있는 회차 열 후보(앞이 먼저): 같은 날짜가 적힌 열 → 날짜와 운동 칸이 모두 빈 열. REST 앞까지만(REST가 없으면 중량 칸부터 네 칸).
 * 서버 기능은 앞에서부터 DB에 그 열을 예약해 보고, 다른 기록이 먼저 예약했으면 다음 후보로 간다(2026-11-03 Codex 1차 리뷰 P1 — 다른 기록 두 개가 같은 빈 열을 차지)
 */
export function writeColumns(input: string[][], b: SheetBlock, date: string, tab: string): number[] {
  const rows = input.map((r) => r.map(clean));
  const last = b.restCol >= 0 ? b.restCol - 1 : b.weightCol + 3;
  const dates = b.dateRow === null ? [] : rows[b.dateRow];
  const out: number[] = [];
  for (let c = b.weightCol; c <= last; c++) if (dates[c] && parseSheetDate(dates[c], tab)?.date === date) out.push(c);
  for (let c = b.weightCol; c <= last; c++) if (!dates[c] && b.rows.every((r) => !rows[r.row][c])) out.push(c);
  return out;
}
/** 첫 후보(없으면 -1) */
export const pickWriteColumn = (input: string[][], b: SheetBlock, date: string, tab: string) => writeColumns(input, b, date, tab)[0] ?? -1;

/** 루틴의 구성(운동·세트·횟수·쉬는 시간·필수 동작) — 이것이 바뀔 때만 새 판. 중량(첫 회차 칸)만 바뀌면 지금 판의 목표 중량만 고친다 */
export const routineDefinition = (tab: string, r: SheetRoutine) =>
  JSON.stringify({ tab, warmup: r.warmup, items: r.items.map((i) => [i.day_no, i.name, i.sets, i.reps, i.rest]) });
export const routineWeights = (r: SheetRoutine) => JSON.stringify(r.items.map((i) => i.weight));
