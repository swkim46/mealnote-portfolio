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

const run = Date.now().toString(36).slice(-4);
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
} finally {
  await unlock();
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
