// 경쟁 상황 검증(로컬 DB 전용). DB 행 잠금을 일부러 잡아 요청들을 겹치게 만든 뒤 결과를 본다.
// Codex 재검토(f0e8c9f·ad10d77)에서 재현된 상황을 우리 검증으로 옮긴 것. 실행: npm run check (또는 sh scripts/check.sh race)
// 앱의 실제 updateMeal을 쓰기 위해 src/lib/api.ts를 TypeScript로 변환해 불러온다.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const root = process.cwd();
const require = createRequire(`${root}/package.json`);
const { createClient } = require('@supabase/supabase-js');
const ts = require('typescript');
const URL_ = process.env.VITE_SUPABASE_URL, KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY, CODE = process.env.TRAINER_CODE;
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(URL_ ?? '')) throw new Error('로컬 DB 전용 검증입니다.');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const fresh = () => createClient(URL_, KEY, opts);
const ok = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };
const emailOf = (n) => createHash('sha256').update(n.normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 32) + '@users.mealnote.local';
const psql = (q) => execFileSync('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', q], { encoding: 'utf8' }).trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

// 주의: supabase-js 요청은 then(또는 await) 전까지 보내지지 않는다. 겹치게 하려면 만들자마자 .then으로 보낸다.
const loadApi = async (client) => {
  globalThis.__raceClient = client;
  globalThis.__racePaging = async (page) => { const out = []; for (let f = 0; ; f += 500) { const { data, error } = await page(f, f + 499); if (error) throw error; out.push(...(data ?? [])); if (!data || data.length < 500) return out; } };
  const src = 'const supabase=globalThis.__raceClient;const uuid=()=>crypto.randomUUID();const fetchAllPages=globalThis.__racePaging;\n' +
    readFileSync(`${root}/src/lib/api.ts`, 'utf8').replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js + '\n//' + randomUUID()).toString('base64')}`);
};

// auth.users 행을 잠가 두는 별도 연결(되찾기·PIN 변경이 그 뒤에서 기다리게 된다)
let holder = null;
const lockUser = (uid) => lockRow(`SELECT id FROM auth.users WHERE id='${uid}' FOR UPDATE;`);
const lockRow = async (lockSql) => {
  holder = spawn('docker', ['exec', '-i', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = ''; const t = setTimeout(() => reject(new Error('잠금 준비 실패')), 10000);
    holder.stdout.on('data', (c) => { out += c; if (out.includes('LOCK_READY')) { clearTimeout(t); resolve(); } });
    holder.stdin.write(`BEGIN;\n${lockSql}\n\\echo LOCK_READY\n`);
  });
};
const unlock = async () => { if (!holder) return; const h = holder; holder = null; const closed = new Promise((r) => h.once('close', r)); h.stdin.end('ROLLBACK;\n'); await closed; };
const waitBlocked = async (fn, n = 1) => {
  for (let i = 0; i < 40; i++) {
    await delay(100);
    if (Number(psql(`select count(*) from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type='Lock' and query ilike '%${fn}%';`)) >= n) return true;
  }
  return false;
};

// 실행 번호: check.sh가 주면 그것(정리를 이 실행 것만 하도록), 따로 돌리면 새로 만든다
const run = process.env.CHECK_RUN || Date.now().toString(36).slice(-4);
const signup = async (n, role, trainerId) => {
  const c = fresh();
  const ticket = ok(await c.rpc('begin_signup', { p_nickname: n, p_role: role, p_question: 1, p_answer: '경쟁 검증', p_trainer_code: role === 'trainer' ? CODE : null, p_trainer_id: trainerId ?? null }));
  const r = ok(await c.auth.signUp({ email: emailOf(n), password: '135790', options: { data: { nickname: n, signup_ticket: ticket } } }));
  return { c, id: r.user.id };
};
const login = async (n, pin) => { const c = fresh(); const r = await c.auth.signInWithPassword({ email: emailOf(n), password: pin }); return r.error ? null : c; };

try {
  const tn = `zz검증RT${run}`, mn = `zz검증RM${run}`;
  const t = await signup(tn, 'trainer');
  const owner = await signup(mn, 'member', t.id);
  const second = await login(mn, '135790');

  // 1) 이전 기기 두 곳의 동시 되찾기 → 하나만 성공, 이긴 기기 세션은 남는다
  ok(await fresh().rpc('reset_pin_with_answer', { p_nickname: mn, p_answer: '경쟁 검증', p_new_pin: '111111' }));
  await lockUser(owner.id);
  const r1 = owner.c.rpc('reclaim_account', { p_new_pin: '222222', p_question: 2, p_answer: '첫째' }).then((r) => r);
  const r2 = second.rpc('reclaim_account', { p_new_pin: '333333', p_question: 2, p_answer: '둘째' }).then((r) => r);
  const both = await waitBlocked('reclaim_account', 2);
  await unlock();
  const [a, b] = await Promise.all([r1, r2]);
  const sessions = Number(psql(`select count(*) from auth.sessions where user_id='${owner.id}';`));
  check('동시 되찾기가 실제로 겹침', both);
  check('동시 되찾기는 하나만 성공, 세션 1개 남음', [a, b].filter((r) => r.data?.status === 'ok').length === 1 && sessions === 1, JSON.stringify([a.data?.status ?? a.error?.message, b.data?.status ?? b.error?.message, sessions]));
  const winnerPin = a.data?.status === 'ok' ? '222222' : '333333';
  const winner = a.data?.status === 'ok' ? owner.c : second;

  // 2) 본인 되찾기 중에 기다리던 공격자의 PIN·복구 질문 변경은 거부
  ok(await fresh().rpc('reset_pin_with_answer', { p_nickname: mn, p_answer: a.data?.status === 'ok' ? '첫째' : '둘째', p_new_pin: '444444' }));
  const attacker = await login(mn, '444444');
  await lockUser(owner.id);
  const own = winner.rpc('reclaim_account', { p_new_pin: '555555', p_question: 3, p_answer: '주인' }).then((r) => r);
  await waitBlocked('reclaim_account', 1);
  const chg = attacker.rpc('change_my_pin', { p_new_pin: '666666', p_current_pin: '444444' }).then((r) => r);
  const rec = attacker.rpc('set_recovery', { p_question: 4, p_answer: '공격자', p_current_pin: '444444' }).then((r) => r);
  const queued = (await waitBlocked('change_my_pin', 1)) && (await waitBlocked('set_recovery', 1));
  await unlock();
  const [o, c1, c2] = await Promise.all([own, chg, rec]);
  const attackerLogin = await login(mn, '666666');
  check('공격자 요청이 실제로 기다렸음', queued);
  check('되찾기 중 기다리던 공격자의 PIN·복구 질문 변경은 거부(Codex ad10d77 P1)',
    o.data?.status === 'ok' && !!c1.error && !!c2.error && !attackerLogin && ok(await fresh().rpc('get_recovery_question', { p_nickname: mn })) === 3,
    JSON.stringify([o.data?.status, c1.data?.status ?? c1.error?.message, c2.data?.status ?? c2.error?.message, !!attackerLogin]));

  // 3) 오래 열어 둔 폼에서 글만 저장해도 다른 기기가 바꾼 최신 사진을 되돌리지 않는다
  const me = await login(mn, '555555');
  const api = await loadApi(me);
  const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const photo = () => new Blob([jpg], { type: 'image/jpeg' });
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const input = { eaten_on: day, eaten_at: '12:00', meal_type: '점심', food: '처음', note: '' };
  const id = await api.createMeal(owner.id, input, photo());
  const stale = await api.fetchMeal(id);
  await api.updateMeal(stale, { ...input, food: '다른 기기가 사진 교체' }, photo());
  const replaced = await api.fetchMeal(id);
  await api.updateMeal(stale, { ...input, food: '늦게 저장한 글 수정' }, undefined);
  const final = await api.fetchMeal(id);
  const file = await me.storage.from('meal-photos').download(final.photo_path);
  check('오래 열어 둔 폼의 글 수정이 최신 사진을 유지(Codex ad10d77 P2)', final.photo_path === replaced.photo_path && !file.error && final.food === '늦게 저장한 글 수정',
    JSON.stringify({ kept: final.photo_path === replaced.photo_path, exists: !file.error }));
  await api.deleteMeal(final);

  // 4) v1.4 평가와 '답변 없이 확인'이 동시에 와도 둘 다 처리되고 상태가 하나로 맞는다
  const tc = await login(tn, '135790');
  const qid = await api.createMeal(owner.id, { ...input, food: '평가 경쟁', note: '괜찮았나요?' }, null);
  if (!/^[0-9a-f-]{36}$/.test(qid)) throw new Error('잘못된 식사 id');
  await lockRow(`SELECT id FROM public.meals WHERE id='${qid}' FOR UPDATE;`);
  const rate = tc.rpc('rate_meal', { p_meal: qid, p_rating: 3 }).then((r) => r);
  const ack = tc.rpc('mark_reviewed', { p_meal: qid }).then((r) => r);
  const overlapped = (await waitBlocked('rate_meal', 1)) && (await waitBlocked('mark_reviewed', 1));
  await unlock();
  const [ra, rb] = await Promise.all([rate, ack]);
  const row = ok(await tc.from('meals').select('rating, rated_at, reviewed_at, member_msg_at').eq('id', qid).single());
  check('평가와 답변 없이 확인이 실제로 겹침', overlapped);
  check('겹쳐도 둘 다 처리되고 평가·확인 완료·답변 대기 정리가 맞음', !ra.error && !rb.error && row.rating === 3 && !!row.rated_at && !!row.reviewed_at && Date.parse(row.reviewed_at) >= Date.parse(row.member_msg_at),
    JSON.stringify([ra.error?.message, rb.error?.message, row]));
  await me.from('meals').delete().eq('id', qid);

  // 5) v1.8 공유와 동의 끄기가 겹쳐도 옛 공유가 남지 않는다(Codex v1.8.0 리뷰 4): 공유가 회원 profiles를 잡고 식사에서 기다리는 사이 동의 끄기
  const sid = await api.createMeal(owner.id, { ...input, food: '공유 경쟁', note: '' }, null);
  ok(await me.rpc('set_share_consent', { p_on: true }));
  await lockRow(`SELECT id FROM public.meals WHERE id='${sid}' FOR UPDATE;`);
  const share = tc.rpc('share_meal', { p_meal: sid, p_on: true }).then((r) => r);
  const shareWaits = await waitBlocked('share_meal', 1);
  const revoke = me.rpc('set_share_consent', { p_on: false }).then((r) => r);
  const revokeWaits = await waitBlocked('set_share_consent', 1);
  await unlock();
  const [sr, vr] = await Promise.all([share, revoke]);
  const consent = psql(`select share_consent from public.profiles where id='${owner.id}';`);
  const sharedAt = psql(`select coalesce(shared_at::text, '') from public.meals where id='${sid}';`);
  check('공유와 동의 끄기가 실제로 겹침', shareWaits && revokeWaits);
  check('겹쳐도 동의가 꺼지면 공유도 풀림(다시 켜도 옛 공유가 안 살아남)', !vr.error && consent === 'f' && sharedAt === '', JSON.stringify([sr.error?.message ?? 'ok', vr.error?.message ?? 'ok', consent, sharedAt]));

  // 6) 트레이너 계정 되찾기 중에 기다리던 공격 기기의 공유는 완료되지 않는다(Codex v1.8.0 리뷰 2)
  ok(await me.rpc('set_share_consent', { p_on: true }));
  ok(await fresh().rpc('reset_pin_with_answer', { p_nickname: tn, p_answer: '경쟁 검증', p_new_pin: '777777' }));
  const tAttacker = await login(tn, '777777');
  await lockUser(t.id);
  const tOwn = tc.rpc('reclaim_account', { p_new_pin: '888888', p_question: 5, p_answer: '트레이너 주인' }).then((r) => r);
  await waitBlocked('reclaim_account', 1);
  const atkShare = tAttacker.rpc('share_meal', { p_meal: sid, p_on: true }).then((r) => r);
  const atkWaits = await waitBlocked('share_meal', 1);
  await unlock();
  const [tr, ar] = await Promise.all([tOwn, atkShare]);
  const sharedAfter = psql(`select coalesce(shared_at::text, '') from public.meals where id='${sid}';`);
  check('공격 기기의 공유가 되찾기 뒤에서 기다렸음', atkWaits);
  check('되찾기가 끝나면 기다리던 공격 기기의 공유는 거부', tr.data?.status === 'ok' && !!ar.error && sharedAfter === '', JSON.stringify([tr.data?.status ?? tr.error?.message, ar.error?.message ?? 'ok', sharedAfter]));
  await me.from('meals').delete().eq('id', sid);

  // 7) v2.0 같은 새 운동 기록을 두 기기에서 동시에 저장(같은 세션 id·다른 저장 요청): 하나만 만들고 다른 하나는 conflict(덮어쓰지 않음, Codex v2.0.0 1차 리뷰 3)
  const wid = randomUUID();
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const dev2 = await login(mn, '555555');
  await lockRow(`SELECT user_id FROM private.account_security WHERE user_id='${owner.id}' FOR UPDATE;`);
  const w1 = me.rpc('save_workout', { p_session: wid, p_day: today, p_routine: null, p_sets: [{ name: '스쿼트', set_no: 1, kg: 50, reps: 10, done: true }], p_finished: true, p_day_no: null, p_save_id: randomUUID() }).then((r) => r);
  const w1Waits = await waitBlocked('save_workout', 1);
  const w2 = dev2.rpc('save_workout', { p_session: wid, p_day: today, p_routine: null, p_sets: [{ name: '스쿼트', set_no: 1, kg: 55, reps: 8, done: true }, { name: '스쿼트', set_no: 2, kg: 55, reps: 8, done: false }], p_finished: false, p_day_no: null, p_save_id: randomUUID() }).then((r) => r);
  const w2Waits = await waitBlocked('save_workout', 2);
  await unlock();
  const [a1, a2] = await Promise.all([w1, w2]);
  const nSess = psql(`select count(*) from public.workout_sessions where id='${wid}';`);
  const nSets = psql(`select count(*) from public.workout_sets where session_id='${wid}';`);
  check('같은 운동 기록 동시 저장이 실제로 겹침', w1Waits && w2Waits);
  const firstWon = !a1.error && /conflict/.test(a2.error?.message ?? '');
  check('동시 저장: 먼저 잡은 쪽만 저장되고 다른 쪽은 conflict(기록 하나·먼저 저장한 세트 그대로)', firstWon && nSess === '1' && nSets === '1', JSON.stringify([a1.error?.message ?? 'ok', a2.error?.message ?? 'ok', nSess, nSets]));
  await me.rpc('delete_workout', { p_session: wid });

  // 8) v2.0 같은 달 수상 확정을 동시에 두 번(크론 재시도와 겹침): 하나만 확정하고 다른 하나는 건너뜀(겹친 기록 없음)
  const M1 = '2025-02-01';
  psql(`delete from private.award_runs where month='${M1}'; delete from public.monthly_awards where month='${M1}';`);
  const prevStart = psql(`select value from public.app_settings where key='award_from';`);
  psql(`update public.app_settings set value='${M1}' where key='award_from';`); // 시험 달을 수상 시작 뒤로
  await lockRow(`SELECT pg_advisory_xact_lock(hashtext('mealnote_awards'), (date '${M1}' - date '2000-01-01'));`);
  const pub = () => new Promise((resolve) => { const c = spawn('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', `select private.publish_monthly_awards('${M1}')`]); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', (code) => resolve({ code, out: out.trim() })); });
  const p1 = pub(), p2 = pub();
  const pubWaits = await waitBlocked('publish_monthly_awards', 2);
  await unlock();
  const [q1, q2] = await Promise.all([p1, p2]);
  const runs = psql(`select count(*) from private.award_runs where month='${M1}';`);
  check('수상 확정 동시 실행이 실제로 겹침', pubWaits);
  check('동시에 두 번 확정해도 한 번만(오류 없음)', q1.code === 0 && q2.code === 0 && runs === '1' && [q1.out, q2.out].includes('0'), JSON.stringify([q1, q2, runs]));
  psql(`delete from private.award_runs where month='${M1}'; delete from public.monthly_awards where month='${M1}';`);
  psql(`update public.app_settings set value='${prevStart}' where key='award_from';`);

  // 9) v2.1 앱 저장과 시트 가져오기가 겹침(같은 날·같은 루틴, 사용자 피드백 11-02): 둘 다 같은 계정 잠금 뒤에서 차례로 돈다.
  //    앱 기록이 먼저 들어가면 가져오기는 그 회차를 건너뛰고, 가져오기가 먼저면 다음 가져오기 때 앱 기록에 자리를 내준다 — 끝에는 기록 하나
  {
    const sheetId = `zzrace${run}aaaaaaaaaaaaaaaaaaaa`.slice(0, 30);
    psql(`insert into public.routine_sources (member_id, sheet_id, set_by) values ('${owner.id}', '${sheetId}', '${owner.id}') on conflict (member_id) do update set sheet_id = excluded.sheet_id;`);
    const sessionsJson = JSON.stringify([{ day_no: 1, col: 4, date: today, items: [{ name: '스쿼트', sets: 3, reps: '10', weight: '60' }] }]);
    const importNow = () => new Promise((resolve) => { const c = spawn('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', `select public.sheet_records_save('${owner.id}', '${sheetId}', '2699', '${sessionsJson}'::jsonb)`]); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', (code) => resolve({ code, out: out.trim() })); });
    const count = (src) => psql(`select count(*) from public.workout_sessions where member_id='${owner.id}' and day='${today}' and day_no=1 and source='${src}';`);
    const appSave = (id) => me.rpc('save_workout', { p_session: id, p_day: today, p_routine: null, p_day_no: 1, p_sets: [{ name: '스쿼트', set_no: 1, kg: '62.5', reps: '10', done: true }], p_finished: true, p_save_id: randomUUID() }).then((r) => r);
    // 앱 저장이 먼저 잠금을 기다림 → 가져오기가 뒤에
    const wa = randomUUID();
    await lockRow(`SELECT user_id FROM private.account_security WHERE user_id='${owner.id}' FOR UPDATE;`);
    const s1 = appSave(wa);
    const s1Waits = await waitBlocked('save_workout', 1);
    const i1 = importNow();
    const i1Waits = await waitBlocked('sheet_records_save', 1);
    await unlock();
    const [sr1, ir1] = await Promise.all([s1, i1]);
    check('앱 저장과 시트 가져오기가 실제로 겹침', s1Waits && i1Waits);
    check('앱 저장이 먼저면 가져오기는 그 회차를 건너뜀(앱 기록 하나, 시트 기록 없음)', !sr1.error && ir1.code === 0 && /"skipped": 1/.test(ir1.out) && count('app') === '1' && count('sheet') === '0', JSON.stringify([sr1.error?.message ?? 'ok', ir1, count('app'), count('sheet')]));
    await me.rpc('delete_workout', { p_session: wa });
    // 가져오기가 먼저 잠금을 기다림 → 앱 저장이 뒤에: 잠깐 둘 다 있다가 다음 가져오기가 시트 기록을 지운다
    const wb = randomUUID();
    psql(`delete from public.sheet_record_links where member_id='${owner.id}';`);
    await lockRow(`SELECT user_id FROM private.account_security WHERE user_id='${owner.id}' FOR UPDATE;`);
    const i2 = importNow();
    const i2Waits = await waitBlocked('sheet_records_save', 1);
    const s2 = appSave(wb);
    const s2Waits = await waitBlocked('save_workout', 1);
    await unlock();
    const [ir2, sr2] = await Promise.all([i2, s2]);
    const overlapped = [count('app'), count('sheet')];
    const ir3 = await importNow();
    check('가져오기가 먼저면 다음 가져오기 때 앱 기록만 남음(오류 없음)', i2Waits && s2Waits && ir2.code === 0 && !sr2.error && JSON.stringify(overlapped) === '["1","1"]' && ir3.code === 0 && count('app') === '1' && count('sheet') === '0', JSON.stringify([overlapped, ir3, count('app'), count('sheet')]));
    await me.rpc('delete_workout', { p_session: wb });
    // 잠금 순서(적대 검토 11-02 교착 재현): 시트 자동 반영(sheet_sync_save)이 회원 행을 잡고 있으면 가져오기는 그 뒤에서 기다리고,
    // 그동안 시트 연결 행(routine_sources)은 잡지 않는다 — 옛 순서(연결 행 먼저)는 자동 반영과 서로 기다려 교착이 났다
    await lockRow(`SELECT id FROM public.profiles WHERE id='${owner.id}' FOR UPDATE;`);
    const i4 = importNow();
    const i4Waits = await waitBlocked('sheet_records_save', 1);
    let srcFree = true;
    try { psql(`begin; select 1 from public.routine_sources where member_id='${owner.id}' for update nowait; rollback;`); } catch { srcFree = false; }
    await unlock();
    const ir4 = await i4;
    check('가져오기는 회원 행에서 기다리는 동안 시트 연결 행을 잡지 않음(자동 반영과 같은 잠금 순서)', i4Waits && srcFree && ir4.code === 0, JSON.stringify([i4Waits, srcFree, ir4]));
    psql(`delete from public.routine_sources where member_id='${owner.id}';`);
  }

  // 10) v2.1 시트 쓰기 차례(Codex 2차 리뷰 P1): 두 작업이 동시에 차례를 잡으면 하나만 받고 다른 하나는 busy.
  //     차례는 같은 잠금 순서(계정 → 회원 행 → 시트 연결)로 잡는다. 연결을 다른 시트로 바꾸면 차례가 끊겨, 그 뒤 옛 작업의 예약·확정은 lost(표시가 생기지 않음)
  {
    const sheetId = `zzrace${run}bbbbbbbbbbbbbbbbbbbb`.slice(0, 30);
    psql(`insert into public.routine_sources (member_id, sheet_id, set_by) values ('${owner.id}', '${sheetId}', '${owner.id}') on conflict (member_id) do update set sheet_id = excluded.sheet_id; delete from private.sheet_write_turns where member_id='${owner.id}';`);
    const sqlBg = (q) => new Promise((resolve) => { const c = spawn('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', q]); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', (code) => resolve({ code, out: out.trim() })); });
    const j1 = randomUUID(), j2 = randomUUID(), sess = randomUUID();
    const begin = (job) => sqlBg(`select public.sheet_write_begin('${owner.id}', '${sheetId}', '${job}')->>'status'`);
    await lockRow(`SELECT id FROM public.profiles WHERE id='${owner.id}' FOR UPDATE;`);
    const b1 = begin(j1), b2 = begin(j2);
    const bWaits = await waitBlocked('sheet_write_begin', 2);
    let srcFree = true;
    try { psql(`begin; select 1 from public.routine_sources where member_id='${owner.id}' for update nowait; rollback;`); } catch { srcFree = false; }
    await unlock();
    const [r1, r2] = await Promise.all([b1, b2]);
    check('쓰기 차례 동시 요청이 실제로 겹침(회원 행에서 기다리는 동안 시트 연결 행은 잡지 않음)', bWaits && srcFree, JSON.stringify([bWaits, srcFree]));
    check('쓰기 차례는 하나만: 한쪽 ok · 다른 쪽 busy', r1.code === 0 && r2.code === 0 && JSON.stringify([r1.out, r2.out].sort()) === '["busy","ok"]', JSON.stringify([r1, r2]));
    const holder = r1.out === 'ok' ? j1 : j2, other = holder === j1 ? j2 : j1;
    const claim = (job) => psql(`select public.sheet_link_claim('${owner.id}', '${job}', '2699', 1, 4, '${today}', '${sess}', true, '{}'::jsonb, '{"2": "40"}'::jsonb)`);
    const busyClaim = claim(other);
    const okClaim = claim(holder);
    // 연결 교체가 확정보다 먼저: 차례가 끊겨 옛 작업의 확정·예약은 lost, 표시는 남지 않음
    const sw = await me.rpc('set_routine_sheet', { p_member: owner.id, p_sheet: `zzrace${run}cccccccccccccccccccc`.slice(0, 30) });
    const lostConfirm = psql(`select public.sheet_link_confirm('${owner.id}', '${holder}', '2699', 1, 4, '${sess}', '{"2": "40"}'::jsonb)`);
    const lostClaim = claim(holder);
    const links = psql(`select count(*) from public.sheet_record_links where member_id='${owner.id}';`);
    check('차례가 없는 작업은 예약 못 함(lost) · 차례를 가진 작업만 ok', busyClaim === 'lost' && okClaim === 'ok', JSON.stringify([busyClaim, okClaim]));
    check('연결을 바꾸면 옛 작업의 확정·예약은 lost이고 표시가 남지 않음', !sw.error && lostConfirm === 'lost' && lostClaim === 'lost' && links === '0', JSON.stringify([sw.error?.message ?? 'ok', lostConfirm, lostClaim, links]));
    psql(`delete from public.routine_sources where member_id='${owner.id}'; delete from private.sheet_write_turns where member_id='${owner.id}';`);
  }

  // Codex v2.4.0 1차 리뷰 P2-4: 메모가 서버 행 상한(1,000)을 넘어도 앱의 fetchExerciseMemos가 빠짐없이 받고, 뒤쪽 메모도 고치고 지울 수 있다
  {
    const d = await login(mn, '555555');
    const memoApi = await loadApi(d);
    psql(`delete from public.exercise_memos where member_id='${owner.id}';`);
    psql(`insert into public.exercise_memos (member_id, key, author, name, body, updated_at)
          select '${owner.id}', 'zz' || lpad(g::text, 4, '0'), case when g % 2 = 0 then 'member' else 'trainer' end, 'zz' || lpad(g::text, 4, '0'), '메모 ' || g, now()
            from generate_series(1, 1000) g;
          insert into public.exercise_memos (member_id, key, author, name, body, updated_at) values ('${owner.id}', '스쿼트', 'member', '스쿼트', '뒤쪽 메모', now());`);
    const all = await memoApi.fetchExerciseMemos(owner.id);
    const tail = all.find((m) => m.key === '스쿼트' && m.author === 'member');
    let fixed = null, gone = 'x';
    try { fixed = await memoApi.saveExerciseMemo(owner.id, '스쿼트', '뒤쪽 메모 고침', tail?.updated_at ?? null); } catch (e) { fixed = `오류 ${e.message}`; }
    const again = (await memoApi.fetchExerciseMemos(owner.id)).find((m) => m.key === '스쿼트' && m.author === 'member');
    try { gone = await memoApi.saveExerciseMemo(owner.id, '스쿼트', '', again?.updated_at ?? null); } catch (e) { gone = `오류 ${e.message}`; }
    const left = (await memoApi.fetchExerciseMemos(owner.id)).length;
    check('메모 1,001행: 빠짐없이 받고(1,000행 뒤의 메모 포함) 그 메모를 고치고 지울 수 있음',
      all.length === 1001 && !!tail && typeof fixed === 'string' && !fixed.startsWith('오류') && again?.body === '뒤쪽 메모 고침' && gone === null && left === 1000, JSON.stringify({ n: all.length, tail: !!tail, fixed, gone, left }));
    psql(`delete from public.exercise_memos where member_id='${owner.id}';`);
  }

  // 2.4 동작별 메모: 같은 칸을 두 기기가 동시에 처음 쓰면(둘 다 읽은 시각 없음) 하나만 저장되고 다른 하나는 conflict(뒤 요청이 앞 글을 덮어쓰지 않음)
  {
    const d1 = await login(mn, '555555'), d2 = await login(mn, '555555');
    psql(`delete from public.exercise_memos where member_id='${owner.id}';`);
    psql(`insert into private.account_security (user_id) values ('${owner.id}') on conflict (user_id) do nothing;`);
    await lockRow(`SELECT user_id FROM private.account_security WHERE user_id='${owner.id}' FOR UPDATE;`);
    const s1 = d1.rpc('save_exercise_memo', { p_member: owner.id, p_name: '스쿼트', p_body: '첫째 기기', p_base: null }).then((r) => r);
    const s2 = d2.rpc('save_exercise_memo', { p_member: owner.id, p_name: '스쿼트', p_body: '둘째 기기', p_base: null }).then((r) => r);
    const overlapped = await waitBlocked('save_exercise_memo', 2);
    await unlock();
    const [x, y] = await Promise.all([s1, s2]);
    const stored = psql(`select body from public.exercise_memos where member_id='${owner.id}' and key='스쿼트' and author='member';`);
    const won = !x.error ? '첫째 기기' : '둘째 기기';
    check('동시 메모 저장이 실제로 겹침', overlapped);
    check('같은 메모 칸을 두 기기가 동시에 처음 쓰면 하나만 저장, 다른 하나는 conflict(덮어쓰지 않음)',
      [x, y].filter((r) => !r.error).length === 1 && [x, y].some((r) => /conflict/.test(r.error?.message ?? '')) && stored === won, JSON.stringify([x.error?.message ?? 'ok', y.error?.message ?? 'ok', stored]));
    psql(`delete from public.exercise_memos where member_id='${owner.id}';`);
  }
} finally {
  await unlock();
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
