// 앱에서 저장한 운동 기록을 연결한 시트의 그 달 탭에 써 넣는다(v2.1, 2026-11-02 사용자 피드백 "앱에서 기록하면 시트로 기록이 넘어가게").
// 요청 {session}. 부른 사람의 로그인으로 그 기록을 읽는다(회원 본인·담당 트레이너에게만 보인다) — 앱이 보낸 값은 쓰지 않고 DB의 기록을 쓴다.
// 쓰는 곳: 기록의 루틴이 시트에서 온 판이면 그 판의 탭(source_ref)·루틴 번호 블록의, 같은 날짜가 적힌 열 또는 날짜·운동 칸이 모두 빈 첫 열(REST 앞까지).
// 이미 값이 있는 칸은 덮어쓰지 않는다 — 앱이 실제로 써서 지금도 그 값 그대로인 칸만 고친다(sheet_record_links.cells, 운동 이름 → 쓴 값·'@date' → 날짜).
// 원래 있던 값이 앱 값과 같아도 앱 소유가 되지 않는다(2026-11-03 Codex 1차 리뷰 P1 — 같은 값도 '이미 적힌 칸'으로 알린다). 시트에 없는 운동·유산소는 쓰지 않는다.
// 쓰기 차례(2026-11-03 Codex 2차 리뷰 P1): 회원마다 한 작업만 시트에 쓴다(sheet_write_begin — 다른 작업이 쓰는 중이면 12초까지 기다리고, 그래도 쓰는 중이면 busy).
//  차례를 가진 작업만 열을 예약·확정한다. 같은 기록의 다른 요청이 쓰는 중인 열의 표시를 지우거나, 그 틈에 다른 기록이 같은 열을 받아 덮이던 것을 막는다.
//  차례는 시트 연결의 세대에 묶인다 — 쓰는 중에 연결이 바뀌면 차례를 잃고(lost) 새 연결로 처음부터 한 번 다시 한다(옛 시트의 표시가 새 시트에 남지 않게).
// 쓰는 중 표시(2026-11-03 Codex 2차 리뷰 P2): 시트에 보내기 전에 이번에 쓸 값을 적어 두고(pending), 쓰기 결과를 확인한 뒤 앱이 쓴 칸(cells)으로 확정한다.
//  응답이 끊겨 결과를 모르면 pending이 남고, 다음 쓰기가 칸 값과 맞춰 본다 — 그 칸에 적어 둔 값이 그대로 있으면 앱이 쓴 칸으로 되찾는다.
//  결과를 모르면 쓰기 차례를 60초 더 쥔다 — 끊긴 요청을 구글이 늦게 반영해도 그사이 다른 쓰기가 그 열을 받거나 새 값을 쓰지 않게(같은 날 적대 검토).
//  시트가 거절한 쓰기(권한 없음 등)는 쓰이지 않은 것이라 그 앞 단계까지 쓴 칸만 확정한다.
// 열 고르기: 지난번에 쓴 열(같은 탭·루틴, 날짜가 비었거나 같은 날) → 같은 날짜 열 → 빈 열. 다른 기록이 가진 열은 건너뛴다(그 열이 시트에서 모두 비었으면 넘겨받는다).
// 완료를 끈 운동은 앱이 쓴 값이 그대로일 때만 비운다. 앱이 쓴 운동 칸이 남지 않으면, 그 열의 운동 칸이 모두 빌 때만 앱이 쓴 날짜도 비우고
// 남의 값이 남으면 날짜는 두고 표시만 내려놓는다. 쓴 칸 표시는 기록마다 하나 — 루틴 번호·탭이 바뀌면 옛 자리의 앱이 쓴 칸을 비우고 옮긴다.
// 쓴 뒤 그 기록이 그사이 다시 저장됐으면 최신 내용으로 다시 쓴다(최대 세 번, 같은 차례 안에서) — 늦게 끝난 옛 쓰기가 새 값을 덮지 않게(2026-11-02 적대 검토).
// 칸 값: 완료한 세트 가운데 가장 높은 무게(세트마다 다르면 높은 쪽만, 기호가 든 두 동작 무게는 둘 다 쓰고 동작마다 높은 쪽 — 2026-11-02 사용자 결정), 무게 없이 했으면 '-'. 날짜는 탭에 적힌 표기를 따른다.
// 쓰는 방식(2026-11-02 실제 시트 확인): 무게는 RAW — 숫자만 있으면 숫자 칸('10'), 기호가 있으면 글자 칸('14,16'·'20+5', 직접 친 것처럼 쓰면 1416으로 바뀔 수 있다).
// '운동한 날'은 트레이너가 친 것과 같은 방식(USER_ENTERED)으로 써서 다른 회차처럼 날짜 값이 된다. 날짜를 먼저 쓴다 — 무게 쓰기가 실패해도 다음 저장이 같은 날짜 열을 찾는다.
// 서비스 계정이 '편집자'로 공유되어 있어야 한다(뷰어면 denied — 앱은 복사해서 붙여 넣기로 안내).
// 칸 값은 그 판의 루틴 항목 순서로 정한다 — 같은 이름의 운동이 블록에 둘이면 세트를 루틴 항목으로 가른다(_shared/routineSheet.ts blockCellValues).
// 돌려주는 것 {status: 'written'|'partial'|'nothing', tab, col, skipped: [시트에 없는 운동], kept: [값이 있어 둔 운동], owned: 이 쓰기 뒤 앱이 쓴 운동 칸 수}
//  · 쓸 수 없으면 {status: 'not_sheet'(시트 루틴 기록 아님)|'no_sheet'(연결 없음)|'no_column'(빈 회차 열 없음)|'denied'(편집 권한 없음)|'busy'(먼저 보낸 쓰기가 아직 끝나지 않음)
//    |'unknown'(보낸 쓰기의 결과를 모름 — 시트에 적혔을 수 있음)} · 실패 {error}
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { blockCellValues, colName, formatSheetDate, parseSheetDate, parseSheetLayout, sameCell, sheetCellFor, writeColumns } from '../_shared/routineSheet.ts';
import { SCOPE_WRITE, sheetToken, sheetValues, sheetsFetch, tabRange } from '../_shared/googleSheets.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

type Session = { id: string; member_id: string; routine_id: string | null; day_no: number | null; day: string; source: string; updated_at: string; sets: { item_id: string | null; name: string; kg: string | null; done: boolean }[] };
type Link = { tab: string; day_no: number; col: number; cells: Record<string, string> | null; pending: Record<string, string> | null };
/** 이 요청의 쓰기 차례: 작업 id·회원·연결 세대·시트 */
type Job = { id: string; member: string; gen: string; sheetId: string; token: string };
type Block = ReturnType<typeof parseSheetLayout>[number];
/** 탭 하나의 루틴 블록 하나. keys = 앱이 쓴 칸의 이름 → 줄 번호(운동 이름, 같은 이름이 또 있으면 '이름#2', 날짜 줄은 DATE) */
type Place = { tab: string; rows: string[][]; blocks: Block[]; block: Block; keys: { key: string; row: number; name: string }[] };

type Outcome = { code?: number; body: Record<string, unknown>; stamp?: string };
type Client = ReturnType<typeof createClient>;
/** 쓰기 차례를 잃음(연결이 풀리거나 바뀜, 또는 멈춘 것으로 보고 다른 작업이 넘겨받음) — 시트에 더 쓰지 않고 처음부터 */
class Lost extends Error {}
/** 시트에 보낸 쓰기의 결과를 모름(연결 끊김·시간 초과·구글 서버 오류) — 구글이 끊긴 요청을 늦게 반영할 수 있다 */
class Uncertain extends Error {}

/** 다른 작업이 쓰는 중일 때 차례를 기다리는 시간(앱은 시트 쓰기 결과를 20초까지 기다린다) */
const TURN_WAIT_MS = 12_000;
/**
 * 앱이 쓴 칸은 줄 번호가 아니라 운동 이름으로 기억한다 — 트레이너가 블록에 줄을 끼워 넣으면 줄 번호가 밀려 다른 운동 칸을 앱 칸으로 보고
 * 지웠다(2026-11-03 적대 검토 F4). 이름이 바뀐 줄은 앱 칸이 아닌 것으로 본다(손대지 않는 쪽).
 */
const DATE = '@date';
const placeKeys = (block: Block) => {
  const seen = new Map<string, number>();
  const keys = block.rows.map((r) => {
    const n = (seen.get(r.name) ?? 0) + 1;
    seen.set(r.name, n);
    return { key: n === 1 ? r.name : `${r.name}#${n}`, row: r.row, name: r.name };
  });
  return block.dateRow === null ? keys : [...keys, { key: DATE, row: block.dateRow, name: '' }];
};

/** 부른 사람의 로그인으로 기록을 읽고 시트에 쓸 기록인지 본다 — 쓸 탭(그 판의 source_ref)까지 */
async function target(user: Client, admin: Client, sessionId: string): Promise<{ session: Session; tab: string } | Outcome> {
  const { data: s, error: sErr } = await user.from('workout_sessions').select('id, member_id, routine_id, day_no, day, source, updated_at, sets:workout_sets(item_id, name, kg, done)').eq('id', sessionId).maybeSingle();
  if (sErr || !s) return { code: 403, body: { error: 'not_allowed' } };
  const session = s as unknown as Session;
  if (session.source !== 'app' || !session.routine_id || !session.day_no) return { body: { status: 'not_sheet' } };
  const { data: routine, error: rErr } = await admin.from('routines').select('source, source_ref').eq('id', session.routine_id).maybeSingle();
  if (rErr) throw new Error('routine_read');
  const tab = routine?.source === 'sheet' ? String(routine.source_ref ?? '') : '';
  if (!tab) return { body: { status: 'not_sheet' } };
  return { session, tab };
}

/** 쓰기 차례를 받는다. 다른 작업이 쓰는 중이면 TURN_WAIT_MS까지 기다린다 */
async function takeTurn(admin: Client, member: string, sheetId: string): Promise<{ id: string; gen: string } | 'busy' | 'unlinked'> {
  const id = crypto.randomUUID();
  const until = Date.now() + TURN_WAIT_MS;
  for (;;) {
    const { data, error } = await admin.rpc('sheet_write_begin', { p_member: member, p_sheet: sheetId, p_job: id });
    if (error) throw new Error('begin');
    const st = data as { status?: string; gen?: string } | null;
    if (st?.status === 'ok' && st.gen) return { id, gen: st.gen };
    if (st?.status !== 'busy') return 'unlinked';
    if (Date.now() >= until) return 'busy';
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 기록 하나를 시트에 한 번 쓴다(쓰기 차례 안에서). stamp = 쓸 때 읽은 그 기록의 수정 시각(쓰지 않았으면 없음) */
async function writeOnce(user: Client, admin: Client, job: Job, sessionId: string): Promise<Outcome> {
  const t = await target(user, admin, sessionId);
  if (!('session' in t)) return t;
  const { session, tab } = t;
  if (session.member_id !== job.member) throw new Lost();
  // 이 기록의 쓴 칸 표시는 지금 연결 세대에 하나(고유 색인). 조회 오류는 실패로 — 오류를 '표시 없음'으로 보면 앱이 쓴 칸을 남의 칸으로 오해한다
  const { data: links, error: linkErr } = await admin.from('sheet_record_links').select('tab, day_no, col, cells, pending').eq('member_id', job.member).eq('gen', job.gen).eq('session_id', session.id);
  if (linkErr) throw new Error('link_read');
  let link = (links ?? [])[0] as Link | undefined;
  // 완료 세트도 쓴 칸 표시도 없으면 시트에 할 일이 없다(시트를 읽지 않음)
  if (!link && !session.sets.some((x) => x.done)) return { body: { status: 'nothing', tab, col: null, skipped: [], kept: [], owned: 0 }, stamp: session.updated_at };
  const readPlace = async (tabName: string, dayNo: number, reuse?: Place): Promise<Place | null> => {
    // 표시 형식을 거치지 않은 값으로 읽는다 — 앱이 쓴 숫자가 칸 형식 때문에 다르게 보여도 앱이 쓴 칸으로 알아보게(3차 리뷰 P2)
    const rows = reuse && reuse.tab === tabName ? reuse.rows : (await sheetValues(job.token, job.sheetId, tabName, true)).map((r) => r.map(clean));
    const blocks = parseSheetLayout(rows);
    const block = blocks.find((b) => b.day_no === dayNo);
    return block ? { tab: tabName, rows, blocks, block, keys: placeKeys(block) } : null;
  };
  const here = await readPlace(tab, session.day_no!);
  if (!here) return { body: { status: 'no_column', tab } };
  const inSheet = new Set(here.block.rows.map((r) => r.name));
  const notInSheet = [...new Set(session.sets.filter((x) => x.done).map((x) => clean(x.name)).filter((n) => !inSheet.has(n)))];
  // 칸 값: 그 판의 루틴 항목 순서로 정한다 — 같은 이름의 운동이 블록에 둘이면 세트를 루틴 항목으로 가른다(blockCellValues, 적대 검토 F13).
  // 칸 이름은 placeKeys와 같은 꼴(이름 · 이름#2). 판에 없는 줄(시트가 그 뒤 바뀜)은 이름으로 모은다
  const { data: items, error: itemErr } = await admin.from('routine_items').select('id, name, ord').eq('routine_id', session.routine_id!).eq('day_no', session.day_no!).order('ord');
  if (itemErr) throw new Error('items_read');
  const sets = session.sets.map((x) => ({ ...x, name: clean(x.name) }));
  const list = (items ?? []).map((i) => ({ id: String(i.id), name: clean(String(i.name)) }));
  const byKey = new Map<string, string>();
  const seenName = new Map<string, number>();
  blockCellValues(list, sets).forEach((v, i) => {
    const n = (seenName.get(list[i].name) ?? 0) + 1;
    seenName.set(list[i].name, n);
    byKey.set(n === 1 ? list[i].name : `${list[i].name}#${n}`, v);
  });
  const valueOf = (key: string, name: string) => byKey.get(key) ?? sheetCellFor(sets.filter((x) => x.name === name));
  const dateAt = (pl: Place, col: number) => (pl.block.dateRow === null ? '' : (pl.rows[pl.block.dateRow][col] ?? ''));
  const keyOf = (pl: Place, col: number) => ({ p_member: job.member, p_job: job.id, p_tab: pl.tab, p_day_no: pl.block.day_no, p_col: col, p_session: session.id });
  const claim = async (pl: Place, col: number, empty: boolean, cells: Record<string, string>, pending: Record<string, string> | null) => {
    const { data, error } = await admin.rpc('sheet_link_claim', { ...keyOf(pl, col), p_day: session.day, p_empty: empty, p_cells: cells, p_pending: pending });
    if (error) throw new Error('claim');
    if (data === 'lost') throw new Lost();
    return data === 'ok';
  };
  const confirm = async (at: ReturnType<typeof keyOf>, cells: Record<string, string>) => {
    const { data, error } = await admin.rpc('sheet_link_confirm', { ...at, p_cells: cells });
    if (error) throw new Error('link_save');
    if (data !== 'ok') throw new Lost();
  };
  // 앱이 쓴 칸: 확정한 값(cells)이나 쓰는 중이던 값(pending) 가운데 지금 시트의 그 운동 칸에 그 값이 그대로 있는 것. 값이 같다는 것만으로는 앱이 쓴 칸이 아니다(Codex 1차 리뷰 P1) —
  // 앱이 그 칸에 쓰려고 적어 둔 값일 때만(응답이 끊겨 결과를 몰랐던 쓰기, Codex 2차 리뷰 P2).
  // 숫자는 값으로 견준다(sameCell): 숫자로 보낸 40은 시트에 '40'으로, 칸 형식에 따라 '40.0'으로 보인다. 예전에 적어 둔 '40.0'도 같은 값(Codex 3차 리뷰 P2)
  const ownedAt = (pl: Place, col: number, l: Link | undefined) => {
    const owned: Record<string, string> = {};
    if (!l) return owned;
    const cells = l.cells ?? {}, pending = l.pending ?? {};
    for (const { key, row } of pl.keys) {
      if (cells[key] === undefined && pending[key] === undefined) continue;
      if (key === DATE) {
        const d = dateAt(pl, col) ? parseSheetDate(dateAt(pl, col), pl.tab)?.date : undefined;
        if (d && (pending[key] === d || cells[key] === d)) owned[key] = d;
        continue;
      }
      const now = pl.rows[row]?.[col] ?? '';
      if (now && ((pending[key] !== undefined && sameCell(pending[key], now)) || (cells[key] !== undefined && sameCell(cells[key], now)))) owned[key] = now;
    }
    return owned;
  };
  // 열 하나에 쓸 계획: 무게 칸 쓰기·비우기, 날짜 쓰기·비우기, 끝난 뒤의 앱이 쓴 칸, 이번에 쓸 값(pending)
  const plan = (pl: Place, col: number, owned: Record<string, string>, want: (key: string, name: string) => string) => {
    const cells: Record<string, string> = {};
    const writes: { row: number; key: string; value: string }[] = [];
    const kept: string[] = [];
    let wanted = 0;
    let othersLeft = false; // 이 쓰기 뒤에도 남의 값이 남는 운동 칸이 있는가
    for (const { key, row, name } of pl.keys) {
      if (key === DATE) continue;
      const value = want(key, name);
      const now = pl.rows[row][col] ?? '';
      const mine = owned[key] !== undefined; // 앱이 쓴 값이 지금도 그대로
      if (!value) {
        // 완료를 끈 운동: 앱이 쓴 값이 그대로 있으면 비운다(남이 고친 값·원래 있던 값은 둔다)
        if (mine) writes.push({ row, key, value: '' });
        else if (now) othersLeft = true;
        continue;
      }
      wanted++;
      if (mine && sameCell(now, value)) {
        cells[key] = value;
        continue;
      }
      if (now && !mine) {
        // 이미 적힌 남의 값(같은 값이어도 앱 소유가 아니다 — '적었어요'로 알리지 않음, 적대 검토 F7)
        kept.push(name);
        othersLeft = true;
        continue;
      }
      writes.push({ row, key, value });
      cells[key] = value;
    }
    const mineRows = Object.keys(cells).length;
    // 날짜: 앱이 쓴 운동 칸이 있으면 앱이 쓴 날짜는 그대로 두고, 날짜 칸이 비었으면 쓴다(표시에는 YYYY-MM-DD로).
    // 앱이 쓴 운동 칸이 하나도 남지 않으면, 그 열의 운동 칸이 모두 비게 될 때만 앱이 쓴 날짜를 비운다. 남의 값(트레이너가 고친 무게 등)이 남으면
    // 날짜는 그대로 두고 표시만 내려놓는다 — 그 열은 시트 쪽 기록이 된다(날짜를 지우면 그 기록을 가져오지도, 다시 쓰지도 못했다, 적대 검토 F3)
    let dateWrite: string | null = null;
    let dateClear = false;
    if (pl.block.dateRow !== null) {
      if (mineRows) {
        if (owned[DATE]) cells[DATE] = owned[DATE];
        else if (!dateAt(pl, col)) {
          const samples = pl.blocks.flatMap((b) => (b.dateRow === null ? [] : pl.rows[b.dateRow].slice(b.weightCol)));
          dateWrite = formatSheetDate(session.day, samples);
          cells[DATE] = session.day;
        }
      } else if (owned[DATE] && !othersLeft) dateClear = true;
    }
    const pending: Record<string, string> = {};
    for (const w of writes) pending[w.key] = w.value;
    if (dateWrite !== null) pending[DATE] = session.day;
    if (dateClear) pending[DATE] = '';
    const status = kept.length || notInSheet.length ? 'partial' : 'written';
    // owned = 이 쓰기 뒤 앱이 쓴 운동 칸 수 — 0이면 앱은 '시트에도 적었어요'라고 하지 않는다(모두 이미 적힌 칸이었을 때)
    const body = { status: wanted ? status : 'nothing', tab: pl.tab, col: colName(col), skipped: notInSheet, kept, owned: mineRows };
    return { writes, dateWrite, dateClear, cells, pending: Object.keys(pending).length ? pending : null, body };
  };
  // 계획대로 시트에 쓰고 확정한다. 반환 'denied'(편집 권한 없음) 또는 null
  const run = async (pl: Place, col: number, p: ReturnType<typeof plan>, owned: Record<string, string>) => {
    const put = (input: 'RAW' | 'USER_ENTERED', data: { row: number; value: string | number }[]) =>
      sheetsFetch(job.token, job.sheetId, '/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: input, data: data.map((w) => ({ range: tabRange(pl.tab, `${colName(col)}${w.row + 1}`), values: [[w.value]] })) }),
      });
    // 하나씩 쓰고 확인한다. 쓸 때는 날짜 → 무게(무게가 실패해도 다음 저장이 같은 날짜 열을 찾는다), 비울 때는 무게 → 날짜. 앞의 것이 거절·실패하면 뒤의 것은 하지 않는다
    type Step = { run: () => Promise<Response>; done: [string, string][] };
    const values: Step | null = p.writes.length
      ? { run: () => put('RAW', p.writes.map((w) => ({ row: w.row, value: /^\d+(\.\d+)?$/.test(w.value) ? Number(w.value) : w.value }))), done: p.writes.map((w) => [w.key, w.value]) }
      : null;
    const date: Step | null = p.dateWrite !== null
      ? { run: () => put('USER_ENTERED', [{ row: pl.block.dateRow!, value: p.dateWrite! }]), done: [[DATE, session.day]] }
      : p.dateClear
        ? { run: () => put('RAW', [{ row: pl.block.dateRow!, value: '' }]), done: [[DATE, '']] }
        : null;
    const steps = (p.dateClear ? [values, date] : [date, values]).filter((x): x is Step => !!x);
    const applied = { ...owned }; // 쓰기 결과를 확인한 칸까지의 앱이 쓴 칸
    for (const [i, step] of steps.entries()) {
      // 다음 쓰기를 보내기 전에 차례를 다시 확인한다(첫 쓰기는 바로 앞의 예약이 확인함) — 그사이 연결이 바뀌었으면 옛 시트에 더 쓰지 않는다
      if (i > 0) {
        const { data: still, error: renewErr } = await admin.rpc('sheet_write_renew', { p_member: job.member, p_job: job.id });
        if (renewErr) throw new Error('renew');
        if (still !== true) throw new Lost();
      }
      let res: Response;
      try {
        res = await step.run();
      } catch {
        throw new Uncertain(); // 연결이 끊김·시간 초과 — 결과를 모르므로 pending이 남는다(다음 쓰기가 맞춰 봄)
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408) {
        // 시트가 거절한 쓰기는 쓰이지 않았다(권한 없음·한도 초과 429 포함 — 구글이 처리하지 않은 요청) — 앞 단계까지 쓴 칸만 확정한다(쓰는 중 표시를 남기지 않음).
        // 429를 '결과 모름'으로 보면 한도에 걸릴 때마다 그 회원의 쓰기가 60초씩 막혔다(적대 검토 F9). 408(요청 시간 초과)만 결과를 모른다
        await confirm(keyOf(pl, col), applied);
        if (res.status === 403) return 'denied';
        throw new Error(`write_${res.status}`);
      }
      if (!res.ok) throw new Uncertain(); // 구글 서버 오류·408: 결과를 모른다
      for (const [k, v] of step.done) {
        if (v) applied[k] = v;
        else delete applied[k];
      }
    }
    // 표시: 이 기록의 칸만 확정한다(다른 기록의 표시는 건드리지 않음). 앱이 쓴 칸이 남지 않았으면 표시를 지운다. 차례를 잃었으면 확정하지 않는다
    await confirm(keyOf(pl, col), p.cells);
    return null;
  };

  const linkHere = !!link && link.tab === tab && link.day_no === session.day_no;
  const linkOk = linkHere && (!dateAt(here, link!.col) || parseSheetDate(dateAt(here, link!.col), tab)?.date === session.day);
  if (link && !linkOk) {
    // 지난번 표시가 지금 자리와 맞지 않음. 루틴 번호·탭이 바뀐 것이면 옛 자리의 앱이 쓴 칸을 비운다 — 그대로 두면 다음 가져오기에서 같은 운동이
    // 시트 기록으로 하나 더 생긴다(적대 검토 F6). 날짜를 남이 고친 것이면 그 열은 남의 기록이라 손대지 않고 표시만 내려놓는다
    // 옛 탭이 지워졌으면(구글 400·404) 옛 자리는 없는 것으로 보고 표시만 내려놓는다 — 읽기 실패로 이 기록의 쓰기가 계속 막히지 않게(적대 검토 F14)
    const old = linkHere ? null : await readPlace(link.tab, link.day_no, here).catch((e: Error) => {
      if (/^values_(400|404)$/.test(e.message)) return null;
      throw e;
    });
    const oldDate = old ? dateAt(old, link.col) : '';
    if (old && (!oldDate || parseSheetDate(oldDate, old.tab)?.date === session.day)) {
      const owned = ownedAt(old, link.col, link);
      const q = plan(old, link.col, owned, () => '');
      if (!(await claim(old, link.col, false, owned, q.pending))) throw new Lost();
      if ((await run(old, link.col, q, owned)) === 'denied') return { body: { status: 'denied', tab } };
    } else await confirm({ ...keyOf(here, link.col), p_tab: link.tab, p_day_no: link.day_no }, {});
    link = undefined;
  }
  let col = -1;
  let owned: Record<string, string> = {};
  let p: ReturnType<typeof plan> | null = null;
  if (link) {
    col = link.col;
    owned = ownedAt(here, col, link);
    p = plan(here, col, owned, valueOf);
    if (!(await claim(here, col, false, owned, p.pending))) throw new Lost();
  } else {
    if (!here.keys.some((k) => k.key !== DATE && valueOf(k.key, k.name))) return { body: { status: 'nothing', tab, col: null, skipped: notInSheet, kept: [], owned: 0 }, stamp: session.updated_at };
    for (const c of writeColumns(here.rows, here.block, session.day, tab)) {
      const q = plan(here, c, {}, valueOf);
      // 같은 날짜 열에 남의 값이 이미 다 있음 — 쓸 것이 없다(열을 예약하지 않음)
      if (!q.pending) return { body: q.body, stamp: session.updated_at };
      const empty = !dateAt(here, c) && here.block.rows.every((r) => !(here.rows[r.row][c] ?? ''));
      if (await claim(here, c, empty, {}, q.pending)) {
        col = c;
        p = q;
        break;
      }
    }
    if (col < 0 || !p) return { body: { status: 'no_column', tab } };
  }
  if ((await run(here, col, p, owned)) === 'denied') return { body: { status: 'denied', tab } };
  return { body: p.body, stamp: session.updated_at };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer \S+$/.test(auth)) return reply(401, { error: 'not_allowed' });
  let sessionId = '';
  try {
    sessionId = String((await req.json())?.session ?? '');
  } catch {
    return reply(400, { error: 'bad_request' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return reply(400, { error: 'bad_request' });
  const user = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  try {
    // 쓰는 중에 연결이 바뀌어 차례를 잃으면 새 연결로 한 번 더(두 번째에도 잃으면 실패)
    for (let round = 0; round < 2; round++) {
      const t = await target(user, admin, sessionId);
      if (!('session' in t)) return reply(t.code ?? 200, t.body);
      // 완료 세트도 쓴 칸 표시도 없으면 시트에 할 일이 없다 — 쓰기 차례를 기다리지 않고 바로 돌려준다(적대 검토 F10)
      if (!t.session.sets.some((x) => x.done)) {
        const { count, error: cErr } = await admin.from('sheet_record_links').select('session_id', { count: 'exact', head: true }).eq('session_id', sessionId);
        if (cErr) throw new Error('link_read');
        if (!count) return reply(200, { status: 'nothing', tab: t.tab, col: null, skipped: [], kept: [], owned: 0 });
      }
      const { data: sheetId } = await user.rpc('routine_sheet_for', { p_member: t.session.member_id });
      if (typeof sheetId !== 'string' || !sheetId) return reply(200, { status: 'no_sheet' });
      const turn = await takeTurn(admin, t.session.member_id, sheetId);
      if (turn === 'busy') return reply(200, { status: 'busy', tab: t.tab });
      if (turn === 'unlinked') continue;
      const job: Job = { id: turn.id, member: t.session.member_id, gen: turn.gen, sheetId, token: '' };
      let hold = false;
      try {
        job.token = await sheetToken(sheetId, SCOPE_WRITE, req);
        // 쓰고 난 뒤 그 기록이 그사이 다시 저장됐으면(수정 시각이 바뀜) 최신 내용으로 한 번 더 쓴다 — 늦게 끝난 옛 쓰기가 새 값을 덮지 않게(적대 검토 11-02)
        let last: Outcome = { body: { status: 'nothing' } };
        for (let attempt = 0; attempt < 3; attempt++) {
          last = await writeOnce(user, admin, job, sessionId);
          if (last.code || !last.stamp) break;
          const { data: now } = await admin.from('workout_sessions').select('updated_at').eq('id', sessionId).maybeSingle();
          if (!now || now.updated_at === last.stamp) break;
        }
        return reply(last.code ?? 200, last.body);
      } catch (e) {
        if (e instanceof Uncertain) {
          hold = true;
          return reply(200, { status: 'unknown', tab: t.tab });
        }
        if (!(e instanceof Lost)) throw e;
      } finally {
        // 결과를 모르는 쓰기가 있으면 차례를 바로 돌려주지 않고 60초 더 쥔다 — 끊긴 요청을 구글이 늦게 반영해도 그동안 다른 쓰기가
        // 그 열을 받거나 새 값을 쓰지 않게(적대 검토 F1·F2). 그 뒤의 쓰기는 쓰는 중 표시(pending)로 칸 값을 맞춰 본다
        if (hold) await admin.rpc('sheet_write_renew', { p_member: job.member, p_job: job.id });
        else await admin.rpc('sheet_write_end', { p_member: job.member, p_job: job.id });
      }
    }
    throw new Error('lost');
  } catch (e) {
    console.error('sheet-write failed', (e as Error).message); // 키·토큰·시트 내용은 남기지 않는다
    return reply(502, { error: 'failed' });
  }
});
