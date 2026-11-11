// 루틴 시트 자동 반영(v2.0). 시트 주인이 우리 서비스 계정에 공유한 구글 시트를 읽기 전용 토큰으로 읽는다(회원·트레이너는 구글 로그인 없음).
// 우리 계정에 공유된 시트는 이 서버가 모두 읽을 수 있으므로, 부른 사람의 로그인으로 DB 함수 routine_sheet_for(회원)를 불러
// 그 회원 본인·지금 담당 트레이너일 때만, 그 회원에게 연결된 시트만 읽는다. 이 기능은 시트를 바꾸지 않는다(쓰기는 sheet-write).
// 읽은 탭을 앱과 같은 규칙(_shared/routineSheet.ts)으로 해석해 DB 함수 sheet_sync_save로 저장한다 — 운동 구성이 같으면 새 판을 만들지 않고,
// 첫 회차 중량만 바뀌었으면 지금 판의 목표 중량만 고친다(v2.1, 마이그레이션 20261102000004).
// v2.1(2026-11-02 사용자 피드백 "이전까지의 운동 기록 불러오기"): 그 달 탭의 회차 기록도 sheet_records_save로 '시트에서 가져온 기록'으로 저장한다.
// 요청 {member, force, mode?, preview?}
//  - 기본: force가 아니면 마지막으로 읽은 지 1시간 안(오류 없음)일 때 시트를 다시 읽지 않는다(운동 탭을 열 때마다 부르므로).
//    돌려주는 것 {status: 'updated'|'same'|'fresh', version?, tab?, problems?, records?}
//  - mode 'records_all': 연월마다 탭 하나(같은 달 사본 탭은 빼고, pickMonthTabs)의 회차 기록. preview면 저장하지 않고 탭마다 회차 수·읽지 못한 칸만.
//    저장하면 이번에 읽은 탭 말고 다른 탭에서 가져온 기록(시트에서 지운 탭·사본 탭)은 지운다(sheet_records_prune).
//    미리보기의 removes = 이미 가져온 기록 가운데 이번에 시트에서 다시 나오지 않아 지울 수(가져올 것이 0개여도 맞추기를 할 수 있게).
//    시트에 월별 탭이 하나도 없으면(마지막 월별 탭을 지움) 가져올 회차 0개로 보고, 이미 가져온 기록은 모두 지울 대상이다(Codex v2.1 2차 리뷰 P2) —
//    시트를 읽은 경우에만. 공유가 끊기거나 읽기에 실패하면 빈 시트로 보지 않고 오류로 끝난다.
//    돌려주는 것 {status: 'preview', removes, tabs: [{tab, sessions, skipped, problems}]} · {status: 'imported', saved, skipped, removed(실제로 지운 수), problems}
//  - 회차 기록 저장은 시트를 읽기 전의 시트 쓰기 번호(write_seq)를 넘긴다 — 그사이 앱이 시트에 썼으면 다시 읽는다(세 번까지, 지난 기록 가져오기는 그래도 바뀌면 409 busy).
//  - 시트를 읽어 저장하는 작업은 읽기 전에 작업 번호를 받는다(sheet_import_begin, 2026-11-03 Codex v2.1.0 3차 리뷰 P2). 루틴 판·탭 기록·사라진 탭 정리는
//    그 번호가 지금도 마지막 번호일 때만 저장된다 — 더 새 가져오기가 시작됐으면 'superseded'로 아무것도 바꾸지 않고 끝난다
//    (옛 시트 내용을 읽은 작업이 늦게 끝나 더 새 작업이 저장한 기록을 되돌리거나 지우던 것). 자동 반영은 {status: 'superseded'}(앱은 '같음'처럼 다시 받음),
//    지난 기록 가져오기는 409 {error: 'superseded'}. 미리보기는 저장하지 않으므로 번호를 받지 않는다.
//    지난 기록 가져오기도 자동 반영처럼 가장 최근 달 탭의 루틴 판을 반영한다 — 자동 반영을 밀어낸 작업이 그 루틴 변경을 대신 저장하게(적대 검토 11-03).
//    탭 기록을 모두 저장한 뒤 정리만 밀리면(그사이 더 새 작업이 시작됨) 가져온 기록은 그대로 'imported'로 알리고 정리는 그 작업에 맡긴다.
//  - 사라진 탭 정리는 시트에 아직 있는 월별 탭(읽은 것이 MAX_TABS개로 잘려도)의 기록을 지우지 않는다 — 시트에서 없어진 탭·사본 탭만.
// 실패 {error: 'no_access'|'no_items'|'no_tab'|'unlinked'|'busy'|'superseded'|'failed'}.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { parseRoutineRows, parseSheetRecords, pickMonthTabs, pickTab, routineDefinition, routineWeights, tabTitle, type SheetSession } from '../_shared/routineSheet.ts';
import { SCOPE_READ, sheetTabs, sheetToken, sheetValues } from '../_shared/googleSheets.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
const REREAD_MS = 60 * 60 * 1000;
/** 지난 기록 가져오기가 한 번에 읽는 탭 수(연월 탭이 이보다 많으면 최근 것부터) */
const MAX_TABS = 36;

const enc = new TextEncoder();
/** 한국 날짜(YYYY-MM-DD): 이 날 뒤의 '운동한 날'은 가져오지 않는다 */
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
async function sha256(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer \S+$/.test(auth)) return reply(401, { error: 'not_allowed' });
  let member = '', force = false, mode = '', preview = false;
  try {
    const b = await req.json();
    member = String(b?.member ?? '');
    force = b?.force === true;
    mode = b?.mode === 'records_all' ? 'records_all' : '';
    preview = b?.preview === true;
  } catch {
    return reply(400, { error: 'bad_request' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(member)) return reply(400, { error: 'bad_request' });
  const user = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: sheetId, error } = await user.rpc('routine_sheet_for', { p_member: member });
  if (error || typeof sheetId !== 'string' || !sheetId) return reply(403, { error: 'not_allowed' });
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  // 이 작업의 번호(저장하는 작업만). 마지막 오류 기록도 이 작업이 마지막 번호일 때만 남긴다 — 늦게 끝난 옛 작업이 새 작업의 결과를 덮지 않게
  let job: { ticket: number; gen: string } | null = null;
  const note = (last_error: string) => {
    const q = admin.from('routine_sources').update({ last_read_at: new Date().toISOString(), last_error }).eq('member_id', member).eq('sheet_id', sheetId);
    return job ? q.eq('import_seq', job.ticket).eq('link_gen', job.gen) : q;
  };
  // 시트 쓰기 번호(routine_sources.write_seq): 시트를 읽기 전에 받아 저장 때 넘긴다. 그사이 앱이 시트에 썼으면 저장하지 않고('stale') 다시 읽는다 —
  // 앱이 방금 비운 칸을 읽어 둔 옛 내용으로 가져오지 않게(2026-11-03 적대 검토 F11)
  const writeSeq = async () => {
    const { data, error: e } = await admin.from('routine_sources').select('write_seq').eq('member_id', member).maybeSingle();
    if (e) throw new Error('seq_read');
    return (data?.write_seq as number | undefined) ?? null;
  };
  // 루틴 판 저장(자동 반영·지난 기록 가져오기 공통). 반환 상태: updated·same·unlinked·superseded
  const saveRoutine = async (tab: string, parsed: ReturnType<typeof parseRoutineRows>) => {
    const { data, error: e } = await admin.rpc('sheet_sync_save', {
      p_member: member, p_sheet: sheetId, p_tab: tab, p_title: tabTitle(tab), p_warmup: parsed.warmup, p_items: parsed.items,
      p_hash: await sha256(routineDefinition(tab, parsed)), p_weight_hash: await sha256(routineWeights(parsed)),
      p_ticket: job?.ticket ?? null, p_gen: job?.gen ?? null,
    });
    if (e) throw new Error(`save_${e.code ?? 'failed'}`);
    return (data as { status?: string; version?: number } | null) ?? {};
  };
  const saveRecords = async (tab: string, sessions: SheetSession[], seq: number | null) => {
    const { data, error: e } = await admin.rpc('sheet_records_save', { p_member: member, p_sheet: sheetId, p_tab: tab, p_sessions: sessions, p_seq: seq, p_ticket: job?.ticket ?? null, p_gen: job?.gen ?? null });
    if (e) throw new Error(`records_${e.code ?? 'failed'}`);
    return (data as { status?: string; saved?: number; skipped?: number; removed?: number } | null) ?? {};
  };
  if (!force && !mode) {
    const { data: src } = await admin.from('routine_sources').select('last_read_at, last_error').eq('member_id', member).maybeSingle();
    if (src?.last_read_at && !src.last_error && Date.now() - Date.parse(src.last_read_at) < REREAD_MS) return reply(200, { status: 'fresh' });
  }
  try {
    // 작업 번호와 그 순간의 시트 쓰기 번호를 함께 받는다(미리보기는 저장하지 않으므로 받지 않음)
    let firstSeq: number | null = null;
    if (!preview) {
      const { data: b, error: be } = await admin.rpc('sheet_import_begin', { p_member: member, p_sheet: sheetId });
      if (be) throw new Error('begin');
      const st = b as { status?: string; ticket?: number; gen?: string; seq?: number } | null;
      if (st?.status === 'unlinked') return reply(409, { error: 'unlinked' });
      if (st?.status !== 'ok' || typeof st.ticket !== 'number' || typeof st.gen !== 'string') throw new Error('begin');
      job = { ticket: st.ticket, gen: st.gen };
      firstSeq = st.seq ?? null;
    }
    const token = await sheetToken(sheetId, SCOPE_READ, req);
    const meta = await sheetTabs(token, sheetId);
    if (meta.status === 403 || meta.status === 404) {
      await note('no_access');
      return reply(403, { error: 'no_access' });
    }
    if (meta.status !== 200) throw new Error(`meta_${meta.status}`);

    // 지난 기록 가져오기: 연월마다 탭 하나, 최근 달부터 MAX_TABS개
    if (mode === 'records_all') {
      // 월별 탭이 없어도 끝내지 않는다 — 가져올 것은 0개, 이미 가져온 기록은 정리 대상(루틴 반영의 'no_tab'과 다름)
      const monthTabs = pickMonthTabs(meta.tabs);
      const tabs = [...monthTabs].sort((a, b) => b.slice(0, 4).localeCompare(a.slice(0, 4))).slice(0, MAX_TABS);
      const today = kstToday();
      let read: { tab: string; rows: string[][]; sessions: SheetSession[]; problems: string[] }[] = [];
      let seq: number | null = null;
      const readAll = async (start: number | null = null) => {
        seq = start ?? (await writeSeq());
        read = [];
        for (const tab of tabs) {
          const rows = await sheetValues(token, sheetId, tab);
          read.push({ tab, rows, ...parseSheetRecords(rows, tab, today) });
        }
      };
      await readAll(firstSeq);
      if (preview) {
        // 건너뛸 회차(앱이 쓴 열·같은 날 같은 루틴의 앱 기록)와 지울 기록은 서버 sheet_records_preview가 저장·정리와 같은 규칙으로 전체 대상에서 센다 —
        // 여기서 목록을 조회해 세면 API 행 상한(1,000개) 밖이 빠져 예고보다 많이 지웠다(Codex v2.1.0 4차 리뷰 P2). 조회 오류는 실패로(빈 목록으로 바꾸지 않음)
        const { data: pv, error: pvErr } = await admin.rpc('sheet_records_preview', {
          p_member: member, p_sheet: sheetId, p_month_tabs: monthTabs,
          p_read: read.map((r) => ({ tab: r.tab, sessions: r.sessions.map((x) => ({ day_no: x.day_no, col: x.col, date: x.date })) })),
        });
        if (pvErr) throw new Error('preview_read');
        const st = pv as { status?: string; removes?: number; tabs?: { tab: string; sessions: number; skipped: number }[] } | null;
        if (st?.status === 'unlinked') return reply(409, { error: 'unlinked' });
        if (st?.status !== 'preview' || !Array.isArray(st.tabs)) throw new Error('preview_read');
        const counts = new Map(st.tabs.map((t) => [t.tab, t]));
        return reply(200, {
          status: 'preview',
          removes: st.removes ?? 0,
          tabs: read.map((r) => ({ tab: r.tab, sessions: counts.get(r.tab)?.sessions ?? 0, skipped: counts.get(r.tab)?.skipped ?? 0, problems: r.problems.slice(0, 20) })),
        });
      }
      // 가장 최근 달 탭의 루틴 판도 반영한다(자동 반영과 같은 규칙 — 운동이 없는 탭이면 건너뜀)
      const routineTab = pickTab(meta.tabs);
      const routineRows = read.find((r) => r.tab === routineTab)?.rows;
      if (routineTab && routineRows) {
        const parsed = parseRoutineRows(routineRows, { sheet: true });
        if (parsed.items.length) {
          const rs = await saveRoutine(routineTab, parsed);
          if (rs.status === 'unlinked') return reply(409, { error: 'unlinked' });
          if (rs.status === 'superseded') return reply(409, { error: 'superseded' });
        }
      }
      // 저장하는 동안 앱이 시트에 쓰면(stale) 처음부터 다시 읽어 저장한다(세 번까지). 이미 저장한 탭은 다시 저장해도 같다 — 지운 수만 앞의 것과 더한다
      let saved = 0, skipped = 0, removed = 0;
      for (let tries = 1; ; tries++) {
        saved = 0;
        skipped = 0;
        let stale = false;
        for (const r of read) {
          const st = await saveRecords(r.tab, r.sessions, seq);
          if (st.status === 'unlinked') return reply(409, { error: 'unlinked' });
          // 더 새 가져오기가 시작됐다 — 그 작업이 더 새 시트 내용을 저장한다. 이 작업은 남은 탭·정리를 하지 않고 끝낸다
          if (st.status === 'superseded') return reply(409, { error: 'superseded' });
          if (st.status === 'stale') {
            stale = true;
            break;
          }
          saved += st.saved ?? 0;
          skipped += st.skipped ?? 0;
          removed += st.removed ?? 0;
        }
        if (!stale) break;
        if (tries >= 3) return reply(409, { error: 'busy' });
        await readAll();
      }
      // 시트에 없는 탭(시트에서 지운 탭·같은 달 사본 탭)에서 가져온 기록은 지운다(월별 탭이 하나도 없으면 모두). 시트에 있는 월별 탭은 읽지 않았어도 둔다
      const { data: pruned, error: pruneErr } = await admin.rpc('sheet_records_prune', { p_member: member, p_sheet: sheetId, p_tabs: monthTabs, p_ticket: job!.ticket, p_gen: job!.gen });
      if (pruneErr) throw new Error(`prune_${pruneErr.code ?? 'failed'}`);
      const pr = (pruned as { status?: string; removed?: number } | null) ?? {};
      if (pr.status === 'unlinked') return reply(409, { error: 'unlinked' });
      // superseded: 탭 기록은 이 작업이 저장했다 — 정리만 더 새 작업에 맡긴다(저장한 기록을 '멈췄어요'로 알리지 않게)
      removed += pr.status === 'superseded' ? 0 : (pr.removed ?? 0);
      // 지운 수는 저장 때 실제로 지운 것 — 미리보기 뒤에 시트가 바뀌었을 수 있어 미리보기의 removes를 쓰지 않는다(Codex v2.1 2차 리뷰)
      return reply(200, { status: 'imported', saved, skipped, removed, problems: read.flatMap((r) => r.problems).slice(0, 30) });
    }

    const tab = pickTab(meta.tabs);
    if (!tab) {
      await note('no_tab');
      return reply(422, { error: 'no_tab' });
    }
    let seq = firstSeq;
    const rows = await sheetValues(token, sheetId, tab);
    const parsed = parseRoutineRows(rows, { sheet: true });
    if (!parsed.items.length) {
      await note('no_items');
      return reply(422, { error: 'no_items', tab });
    }
    const st = await saveRoutine(tab, parsed);
    if (st.status === 'unlinked') return reply(409, { error: 'unlinked' });
    if (st.status === 'superseded') return reply(200, { status: 'superseded', version: null, tab });
    // 그 달 탭의 회차 기록(트레이너가 수업 중 시트에 적은 것)도 함께 가져온다
    // 그사이 앱이 시트에 썼으면 그 탭만 다시 읽어 저장한다(세 번까지, 그래도 바뀌면 이번에는 회차 기록을 저장하지 않음 — 다음 읽기 때)
    let rec = parseSheetRecords(rows, tab, kstToday());
    let recSt = await saveRecords(tab, rec.sessions, seq);
    for (let tries = 1; recSt.status === 'stale' && tries < 3; tries++) {
      seq = await writeSeq();
      rec = parseSheetRecords(await sheetValues(token, sheetId, tab), tab, kstToday());
      recSt = await saveRecords(tab, rec.sessions, seq);
    }
    if (recSt.status === 'superseded') return reply(200, { status: 'superseded', version: null, tab });
    return reply(200, { status: st.status, version: st.version ?? null, tab, problems: [...parsed.problems, ...rec.problems].slice(0, 10), records: { saved: recSt.saved ?? 0, skipped: recSt.skipped ?? 0 } });
  } catch (e) {
    await note('read_failed');
    console.error('sheet-import failed', (e as Error).message); // 키·토큰·시트 내용은 남기지 않는다
    return reply(502, { error: 'failed' });
  }
});
