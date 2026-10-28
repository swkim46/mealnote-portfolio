// 푸시 알림 검증(v1.7, 로컬 DB + 로컬 서버 기능). 실행: npm run check:push (먼저 npm run push:setup 한 번)
// - 권한: 기기 등록·선점 함수의 접근 범위, 알려진 푸시 주소만 등록
// - 판정: DB 판정(질문 대기·확인 필요·새 피드백)이 앱의 src/lib/status.ts와 같은지
// - 알림 만들기: 트레이너 요약(하루 3회·5회)·새 피드백(묶음)·점심·저녁 기록, 보낼 때마다 다시 확인, 중복 생성 방지
// - 전송: 기기별 결과·재시도·410 정리·계정 전환, 실제 서버 기능 → 시험 수신 서버(브라우저 역할) 암호 해독까지
// 시험 수신 서버는 이 스크립트가 맥에 띄우고, 로컬 서버 기능(Docker)은 host.docker.internal로 닿는다.
import { createClient } from '@supabase/supabase-js';
import { createHash, createECDH, randomBytes, hkdfSync, createDecipheriv, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';

const URL_ = process.env.VITE_SUPABASE_URL, KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY, CODE = process.env.TRAINER_CODE, ADMIN = process.env.ADMIN_CODE;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(URL_ ?? '')) { console.error('중단: 로컬 DB에서만 돈다'); process.exit(1); }
const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const svc = createClient(URL_, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sql = (q) => {
  const out = execFileSync('supabase', ['db', 'query', '--local', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { return JSON.parse(out).rows ?? []; } catch { return []; } // UPDATE·DELETE는 결과 행이 없다
};
const run = Date.now().toString(36).slice(-4);
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); } return null; };

// 앱의 판정 코드를 그대로 불러온다(unit-check와 같은 방식)
const require = createRequire(`${process.cwd()}/package.json`);
const ts = require('typescript');
const loadTs = async (file) => {
  const src = readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js + '\n//' + randomUUID()).toString('base64')}`);
};
const status_ = await loadTs('src/lib/status.ts');
const quotes_ = await loadTs('supabase/functions/_shared/quotes.ts');

// ─── 시험 수신 서버: 브라우저처럼 키를 갖고 암호를 푼다 ───
const PORT = 8788;
const devices = new Map(); // path → { ecdh, auth, inbox: [], codes: [] }
const hk = (salt, ikm, info, len) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));
const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const d = devices.get(req.url);
    if (!d) { res.writeHead(410); return res.end(); }
    const code = d.codes.length ? d.codes.shift() : 201;
    if (code === 201) {
      try {
        const body = Buffer.concat(chunks);
        const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
        const ikm = hk(d.auth, d.ecdh.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), d.ecdh.getPublicKey(), asPub]), 32);
        const dc = createDecipheriv('aes-128-gcm', hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
        dc.setAuthTag(ct.subarray(ct.length - 16));
        const pt = Buffer.concat([dc.update(ct.subarray(0, ct.length - 16)), dc.final()]);
        d.inbox.push({ data: JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString('utf8')), ttl: req.headers.ttl, topic: req.headers.topic, auth: req.headers.authorization ?? '' });
      } catch (e) { d.inbox.push({ error: String(e.message) }); }
    }
    res.writeHead(code, code === 429 ? { 'retry-after': '1' } : {});
    res.end();
  });
});
await new Promise((r) => receiver.listen(PORT, '0.0.0.0', r));
const newDevice = () => {
  const path = `/p/${run}-${randomUUID()}`;
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const d = { path, ecdh, auth: randomBytes(16), inbox: [], codes: [] };
  devices.set(path, d);
  d.sub = { endpoint: `http://host.docker.internal:${PORT}${path}`, p256dh: ecdh.getPublicKey().toString('base64url'), auth: d.auth.toString('base64url') };
  return d;
};

// ─── 계정 ───
const emailOf = (n) => createHash('sha256').update(n.normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 32) + '@users.mealnote.local';
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function signUp(nick, role, extra = {}) {
  const c = client();
  const t = await c.rpc('begin_signup', { p_nickname: nick, p_role: role, p_question: 1, p_answer: '점검사', p_trainer_code: extra.code ?? null, p_trainer_id: extra.trainer ?? null });
  if (t.error) throw new Error(`begin_signup ${t.error.message}`);
  const r = await c.auth.signUp({ email: emailOf(nick), password: '135790', options: { data: { nickname: nick, signup_ticket: t.data } } });
  if (r.error) throw new Error(`signUp ${r.error.message}`);
  return { c, id: r.data.user.id, nick };
}
const login = async (nick) => { const c = client(); const r = await c.auth.signInWithPassword({ email: emailOf(nick), password: '135790' }); if (r.error) throw r.error; return { c, id: r.data.user.id }; };
const reg = (u, d) => u.c.rpc('register_push', { p_endpoint: d.sub.endpoint, p_p256dh: d.sub.p256dh, p_auth: d.sub.auth });

// 서버 기능 역할(DB 규칙만 볼 때): 선점 → 결과 기록. 실제 전송은 하지 않는다
const claim = async (now) => { const r = await svc.rpc('push_claim', { p_limit: 200, p_now: now.toISOString() }); if (r.error) throw r.error; return r.data; };
const report = (jobs, outcome = 'accepted', extra = {}) => svc.rpc('push_report', { p_results: jobs.map((j) => ({ notification_id: j.nid, subscription_id: j.sid, outcome, ...extra })) });
// 시험은 미래 시각(내일 15시 등)으로 알림을 만들기 때문에 기준 시각도 미래로 옮겨진다. 단계마다 지금으로 되돌리고 남은 전송은 치운다
const resetState = (ids_) => sql(`update private.push_state set digest_basis_at = now() - interval '1 second', feedback_basis_at = now() - interval '1 second', lunch_on = null, dinner_on = null, morning_on = null where user_id in (${ids_.map((x) => `'${x}'`).join(',')})`)
  && sql(`update private.push_deliveries d set status = 'canceled' from private.push_notifications n where n.id = d.notification_id and n.user_id in (${ids_.map((x) => `'${x}'`).join(',')}) and d.status in ('pending', 'retry', 'sending')`);
const jobsFor = (jobs, uid) => jobs.filter((j) => j.payload.uid === uid);
const kst = (day, h, m = 0) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const tomorrow = new Date(Date.now() + 9 * 3600e3 + 86400e3).toISOString().slice(0, 10); // 한국 날짜 기준 내일
const later = (min) => new Date(Date.now() + min * 60e3);

// 정기 호출(pg_cron)이 시험 중에 끼어들지 않게 잠시 멈춘다
sql(`select cron.alter_job(jobid, active := false) from cron.job where jobname in ('mealnote-push', 'mealnote-push-pending')`);
const ids = [];
try {
  const T = await signUp(`zz검증푸T${run}`, 'trainer', { code: CODE }); ids.push(T.id);
  const M1 = await signUp(`zz검증푸A${run}`, 'member', { trainer: T.id }); ids.push(M1.id);
  const M2 = await signUp(`zz검증푸B${run}`, 'member', { trainer: T.id }); ids.push(M2.id);
  const AD = await signUp(`zz검증푸관${run}`, 'trainer', { code: ADMIN }); ids.push(AD.id);
  const anon = client();

  // ─── 1. 권한 ───
  const dT = newDevice(), dM1 = newDevice(), dM2 = newDevice();
  check('로그인 안 한 사람은 기기 등록 못 함', !!(await anon.rpc('register_push', { p_endpoint: dT.sub.endpoint, p_p256dh: dT.sub.p256dh, p_auth: dT.sub.auth })).error);
  check('로그인 안 한 사람은 선점·결과 기록 못 함', !!(await anon.rpc('push_claim', {})).error && !!(await anon.rpc('push_report', { p_results: [] })).error);
  check('회원·트레이너도 선점·결과 기록 못 함', !!(await M1.c.rpc('push_claim', {})).error && !!(await T.c.rpc('push_report', { p_results: [] })).error);
  check('기기 등록 표는 직접 못 읽음', ((await M1.c.from('push_subscriptions').select('id')).data ?? []).length === 0);
  const bad = await M1.c.rpc('register_push', { p_endpoint: 'https://evil.example.com/push/x', p_p256dh: dM1.sub.p256dh, p_auth: dM1.sub.auth });
  check('알려진 푸시 서비스가 아닌 주소는 거부', bad.data?.status === 'bad_endpoint', JSON.stringify(bad.data ?? bad.error));
  const apple = await M1.c.rpc('register_push', { p_endpoint: `https://web.push.apple.com/zz${run}`, p_p256dh: dM1.sub.p256dh, p_auth: dM1.sub.auth });
  check('애플 푸시 주소는 받음', apple.data?.status === 'ok', JSON.stringify(apple.data ?? apple.error));
  await M1.c.rpc('unregister_push', { p_endpoint: `https://web.push.apple.com/zz${run}` });
  check('운영자 계정은 알림 대상이 아님', (await AD.c.rpc('register_push', { p_endpoint: newDevice().sub.endpoint, p_p256dh: dT.sub.p256dh, p_auth: dT.sub.auth })).data?.status === 'not_supported');
  check('트레이너 기기 등록', (await reg(T, dT)).data?.status === 'ok');
  check('회원 기기 등록', (await reg(M1, dM1)).data?.status === 'ok' && (await reg(M2, dM2)).data?.status === 'ok');
  check('이 기기가 이 세션으로 등록됐는지 확인', (await M1.c.rpc('push_registered', { p_endpoint: dM1.sub.endpoint })).data === true
    && (await M2.c.rpc('push_registered', { p_endpoint: dM1.sub.endpoint })).data === false);
  check('남의 기기 등록은 못 지움', (await M2.c.rpc('unregister_push', { p_endpoint: dM1.sub.endpoint }), (await M1.c.rpc('push_registered', { p_endpoint: dM1.sub.endpoint })).data === true));
  const prefs = await M1.c.from('push_prefs').upsert({ user_id: M1.id, feedback: true, reminder: true });
  check('내 알림 설정 저장', !prefs.error, prefs.error?.message);
  check('남의 알림 설정은 못 씀', !!(await M1.c.from('push_prefs').upsert({ user_id: M2.id, feedback: false })).error);

  // ─── 2. 판정: DB와 앱(status.ts)이 같은지 ───
  const meal = async (u, extra = {}) => (await u.c.from('meals').insert({ eaten_on: tomorrow, eaten_at: '12:00', meal_type: '점심', food: '샐러드', note: '', ...extra }).select('id').single()).data.id;
  const cases = {};
  cases.first_question = await meal(M2, { note: '이거 괜찮나요?' });
  cases.reviewed_no_reply = await meal(M2, { note: '양이 많았나요?' });
  await T.c.rpc('mark_reviewed', { p_meal: cases.reviewed_no_reply });
  cases.new_after_review = await meal(M2, { note: '' });
  await T.c.rpc('mark_reviewed', { p_meal: cases.new_after_review });
  await sleep(1100);
  await M2.c.from('comments').insert({ meal_id: cases.new_after_review, body: '저녁은요?' });
  cases.note_edited = await meal(M2, { note: '' });
  await T.c.rpc('mark_reviewed', { p_meal: cases.note_edited });
  await sleep(1100);
  await M2.c.from('meals').update({ note: '이걸로 바꿨어요, 괜찮나요?' }).eq('id', cases.note_edited);
  cases.trainer_replied = await meal(M2, { note: '이거 괜찮나요?' });
  await sleep(1100);
  await T.c.from('comments').insert({ meal_id: cases.trainer_replied, body: '좋아요!' });
  cases.rated_only = await meal(M2, {});
  await T.c.rpc('rate_meal', { p_meal: cases.rated_only, p_rating: 1 });
  cases.unreviewed = await meal(M2, {});
  const rows = (await svc.from('meals').select('id, note, note_updated_at, created_at, reviewed_at, rated_at, rating, member_seen_at, comments(id, meal_id, author_role, body, created_at)').in('id', Object.values(cases))).data;
  const db = sql(`select m.id::text, private.meal_pending_question(m) q, private.meal_needs_trainer_check(m) n, private.meal_new_feedback(m) f
                    from public.meals m where m.id in (${Object.values(cases).map((x) => `'${x}'`).join(',')})`.replace('private.meal_needs_trainer_check(m)', '(m.reviewed_at is null or private.meal_pending_question(m))'));
  for (const [name, id] of Object.entries(cases)) {
    const r = rows.find((x) => x.id === id);
    const app = { ...r, comments: [...r.comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)) };
    const d = db.find((x) => x.id === id);
    const want = { q: status_.hasQuestion(app), n: status_.needsTrainer(app), f: status_.hasNewFeedback(app) };
    const got = { q: d.q === true || d.q === 't', n: d.n === true || d.n === 't', f: d.f === true || d.f === 't' };
    check(`판정이 앱과 같음: ${name}`, JSON.stringify(want) === JSON.stringify(got), `앱 ${JSON.stringify(want)} · DB ${JSON.stringify(got)}`);
  }
  // 판정 시험용 식사는 지운다(아래 알림 시험에 섞이지 않게)
  await M2.c.from('meals').delete().in('id', Object.values(cases));

  // ─── 3. 트레이너 요약 ───
  const d9 = kst(tomorrow, 9, 5), d12 = kst(tomorrow, 12, 5), d15 = kst(tomorrow, 15, 5);
  let jobs = await claim(d9);
  check('새로 들어온 것이 없으면 요약 안 보냄', jobsFor(jobs, T.id).length === 0);
  const m1a = await meal(M1, { note: '' });
  const m1b = await meal(M1, { meal_type: '저녁', note: '단백질 충분한가요?' });
  jobs = await claim(kst(tomorrow, 9, 15));
  check('같은 회차(9시)에는 두 번 만들지 않음', jobsFor(jobs, T.id).length === 0);
  jobs = await claim(d12);
  check('하루 3회 설정이면 12시 회차는 없음', jobsFor(jobs, T.id).length === 0);
  jobs = await claim(d15);
  const tj = jobsFor(jobs, T.id);
  check('15시 요약: 확인할 기록 1건·답할 질문 1건', tj.length === 1 && tj[0].payload.body === '확인할 식사 기록 1건, 답할 질문 1건이 있어요' && tj[0].payload.open === 'queue', JSON.stringify(tj[0]?.payload));
  check('알림 내용에 이름·식단 원문 없음', tj.length === 1 && !JSON.stringify(tj[0].payload).includes('zz검증') && !JSON.stringify(tj[0].payload).includes('샐러드') && !JSON.stringify(tj[0].payload).includes('단백질'));
  await report(tj, 'retry', { code: 503 });
  await T.c.rpc('mark_reviewed', { p_meal: m1a });
  await T.c.from('comments').insert({ meal_id: m1b, body: '충분해요' });
  await sql(`update private.push_deliveries set next_try_at = now() where subscription_id = '${tj[0].sid}'`);
  jobs = await claim(kst(tomorrow, 15, 30));
  check('재시도 직전 다시 셈: 그사이 모두 처리했으면 취소', jobsFor(jobs, T.id).length === 0
    && sql(`select status from private.push_deliveries where notification_id = '${tj[0].nid}'`)[0]?.status === 'canceled');
  await T.c.from('push_prefs').upsert({ user_id: T.id, digest_times: '5' });
  resetState([T.id, M1.id, M2.id]);
  await meal(M2, {});
  jobs = await claim(kst(tomorrow, 18, 5));
  check('하루 5회 설정이면 18시 회차에 보냄', jobsFor(jobs, T.id).length === 1);
  await report(jobsFor(jobs, T.id));
  await T.c.from('push_prefs').upsert({ user_id: T.id, digest: false });
  resetState([T.id, M1.id, M2.id]);
  await meal(M2, {});
  jobs = await claim(kst(tomorrow, 21, 5));
  check('요약을 끄면 안 보냄', jobsFor(jobs, T.id).length === 0);
  await T.c.from('push_prefs').upsert({ user_id: T.id, digest: true });

  // ─── 4. 새 피드백(회원): 묶지 않고 피드백마다 바로(2026-10-27 사용자 결정) ───
  resetState([T.id, M1.id, M2.id]);
  const isFb = (j) => j.payload.tag?.startsWith('feedback-');
  const f1 = await meal(M1, { meal_type: '아침' });
  await T.c.rpc('rate_meal', { p_meal: f1, p_rating: 1 });
  jobs = await claim(later(0.2));
  let fj = jobsFor(jobs, M1.id).filter(isFb);
  check('피드백은 기다리지 않고 바로 알림', fj.length === 1 && fj[0].payload.body === '트레이너가 피드백을 남겼어요' && fj[0].payload.open === 'feedback', JSON.stringify(fj.map((j) => j.payload)));
  await report(fj);
  const f2 = await meal(M1, { meal_type: '간식' });
  await T.c.from('comments').insert({ meal_id: f2, body: '좋아요' });
  jobs = await claim(later(0.2));
  const fj2 = jobsFor(jobs, M1.id).filter(isFb);
  check('다음 피드백은 따로 알림(알림마다 다른 tag라 쌓임)', fj2.length === 1 && fj2[0].payload.tag !== fj[0].payload.tag);
  await report(fj2, 'retry', { code: 429, retry_after: 1 });
  await M1.c.rpc('mark_seen', { p_meal: f2 });
  await sql(`update private.push_deliveries set next_try_at = now() where notification_id = '${fj2[0].nid}'`);
  jobs = await claim(later(0.2));
  check('429로 미룬 사이 읽었으면 재시도 취소', jobsFor(jobs, M1.id).filter(isFb).length === 0
    && sql(`select status from private.push_deliveries where notification_id = '${fj2[0].nid}'`)[0]?.status === 'canceled');
  const f3 = await meal(M1, { meal_type: '저녁' });
  await T.c.rpc('rate_meal', { p_meal: f3, p_rating: 2 });
  jobs = await claim(later(0.2));
  fj = jobsFor(jobs, M1.id).filter(isFb);
  check('그 뒤 새 피드백은 다음 알림으로', fj.length === 1);
  await report(fj);
  // 저장과 알림 만들기가 겹쳐, 이미 알린 피드백보다 앞선 시각으로 늦게 들어온 다른 식사의 피드백도 놓치지 않음
  const f6 = await meal(M1, { meal_type: '점심' });
  await T.c.rpc('rate_meal', { p_meal: f6, p_rating: 2 });
  sql(`update public.meals set rated_at = (select rated_at from public.meals where id = '${f3}') - interval '1 millisecond', member_seen_at = (select rated_at from public.meals where id = '${f3}') - interval '1 second' where id = '${f6}'`);
  jobs = await claim(later(0.2));
  check('늦게 들어온 앞선 시각의 피드백도 알림', jobsFor(jobs, M1.id).filter(isFb).length === 1);
  await report(jobsFor(jobs, M1.id).filter(isFb));
  jobs = await claim(later(0.3));
  check('같은 피드백으로 두 번 알리지 않음', jobsFor(jobs, M1.id).filter(isFb).length === 0);
  // 재시도 대기 중 읽은 피드백 A는 같은 식사의 새 피드백 B를 근거로 되살아나지 않는다(Codex v1.7 리뷰 1)
  resetState([M1.id]);
  const fa = await meal(M1, { meal_type: '아침' });
  await T.c.rpc('rate_meal', { p_meal: fa, p_rating: 1 });
  const jA = jobsFor(await claim(later(0.2)), M1.id).filter(isFb);
  await report(jA, 'retry', { code: 503 });
  await M1.c.rpc('mark_seen', { p_meal: fa });
  await T.c.from('comments').insert({ meal_id: fa, body: '추가로 남긴 피드백' });
  sql(`update private.push_deliveries set next_try_at = now() where notification_id = '${jA[0]?.nid}'`);
  let jB = jobsFor(await claim(later(0.3)), M1.id).filter(isFb);
  check('읽은 피드백의 재시도는 새 피드백이 와도 취소되고 새 알림만', jA.length === 1 && jB.length === 1 && jB[0].nid !== jA[0].nid
    && sql(`select status from private.push_deliveries where notification_id = '${jA[0]?.nid}'`)[0]?.status === 'canceled', `A ${jA.length} · 이번 ${jB.length}`);
  await report(jB);
  // 아직 안 읽은 A의 재시도 중 같은 식사에 B가 오면 새 알림 하나만(같은 식사를 새 알림이 맡는다)
  const fc = await meal(M1, { meal_type: '간식' });
  await T.c.rpc('rate_meal', { p_meal: fc, p_rating: 2 });
  const jC = jobsFor(await claim(later(0.4)), M1.id).filter(isFb);
  await report(jC, 'retry', { code: 503 });
  await T.c.from('comments').insert({ meal_id: fc, body: '하나 더' });
  sql(`update private.push_deliveries set next_try_at = now() where notification_id = '${jC[0]?.nid}'`);
  jB = jobsFor(await claim(later(0.5)), M1.id).filter(isFb);
  check('안 읽은 피드백 재시도 중 같은 식사에 새 피드백: 새 알림 하나만', jC.length === 1 && jB.length === 1 && jB[0].nid !== jC[0].nid, `이번 ${jB.length}`);
  await report(jB);

  // 바로 보내기: 서버 기능은 10초에 한 번 부르고, 그 사이 요청은 대기로 남겨 10초 작업이 처리한다(Codex v1.7 리뷰 2)
  // 서버 기능 호출 수: pg_net 요청 번호(늘기만 함). 대기열·응답 기록의 행 수는 pg_net이 오래된 응답을 지우면서 줄 수 있어 쓰지 않는다
  // (DB를 새로 만든 직후 아직 한 번도 안 쓴 번호는 last_value가 1이라 is_called로 구분한다)
  const kickCount = () => Number(sql(`select (case when is_called then last_value else 0 end)::text n from net.http_request_queue_id_seq`)[0]?.n ?? 0);
  const kst_ = () => sql(`select pending, (last_kick_at > now() - interval '10 seconds') as recent from private.push_kick_state`)[0];
  sql(`update private.push_kick_state set last_kick_at = '-infinity', pending = false`);
  check('로그인 안 한 사람은 바로 보내기 요청 못 함', !!(await anon.rpc('push_nudge')).error);
  const k0 = kickCount();
  await M1.c.rpc('push_nudge');
  check('회원의 바로 보내기 요청은 무시', JSON.stringify(kst_()) === JSON.stringify({ pending: false, recent: false }) && kickCount() === k0);
  await T.c.rpc('push_nudge');
  check('트레이너 바로 보내기: 서버 기능을 바로 부름', !!(await waitFor(() => kickCount() > k0, 10000)) && kst_()?.recent === true && kst_()?.pending === false);
  const k1 = kickCount();
  await T.c.rpc('push_nudge');
  await sleep(1500);
  check('10초 안의 두 번째 요청은 버리지 않고 대기로 남김', kst_()?.pending === true && kickCount() === k1);
  sql(`select private.push_kick_pending()`);
  check('10초가 안 지났으면 대기 그대로', kst_()?.pending === true && kickCount() === k1);
  sql(`update private.push_kick_state set last_kick_at = now() - interval '11 seconds'`);
  sql(`select private.push_kick_pending()`);
  check('10초 뒤 대기 처리 작업이 서버 기능을 부름', kst_()?.pending === false && !!(await waitFor(() => kickCount() > k1, 10000)));
  check('대기 처리 작업이 10초마다 도도록 등록됨', sql(`select schedule from cron.job where jobname = 'mealnote-push-pending'`)[0]?.schedule === '10 seconds');

  // ─── 5. 점심·저녁 기록 알림 ───
  resetState([T.id, M1.id, M2.id]);
  const remind = (jobsList, uid) => jobsFor(jobsList, uid).filter((j) => j.payload.tag === 'reminder');
  await M1.c.from('meals').delete().eq('member_id', M1.id).eq('eaten_on', tomorrow).in('meal_type', ['점심', '저녁']);
  await M2.c.from('meals').delete().eq('member_id', M2.id).eq('eaten_on', tomorrow);
  await meal(M2, { meal_type: '점심' });
  jobs = await claim(kst(tomorrow, 12, 55));
  check('13시 전에는 점심 알림 없음', remind(jobs, M1.id).length === 0);
  jobs = await claim(kst(tomorrow, 13, 5));
  check('13시: 점심 기록 없는 회원에게 점심 알림', remind(jobs, M1.id).length === 1 && remind(jobs, M1.id)[0].payload.body === '점심 식단을 남겨 주세요');
  check('13시: 점심 기록한 회원은 안 보냄', remind(jobs, M2.id).length === 0);
  await report(remind(jobs, M1.id), 'retry', { code: 500 });
  await meal(M1, { meal_type: '점심' });
  await sql(`update private.push_deliveries set next_try_at = now() where notification_id = '${remind(jobs, M1.id)[0].nid}'`);
  jobs = await claim(kst(tomorrow, 13, 20));
  check('재시도 전에 점심을 기록했으면 취소', remind(jobs, M1.id).length === 0);
  jobs = await claim(kst(tomorrow, 20, 5));
  check('20시: 점심을 기록했어도 저녁 기록이 없으면 저녁 알림', remind(jobs, M1.id).length === 1 && remind(jobs, M1.id)[0].payload.body === '저녁 식단을 남겨 주세요');
  await report(remind(jobs, M1.id));
  jobs = await claim(kst(tomorrow, 21, 0));
  check('저녁 알림은 하루 한 번', remind(jobs, M1.id).length === 0);

  // ─── 5b. 오전 9시 아침 응원(오늘의 한마디, 2026-10-27 사용자 요청) ───
  resetState([T.id, M1.id, M2.id]);
  const morning = (jobsList, uid) => jobsFor(jobsList, uid).filter((j) => j.payload.tag === 'morning');
  // 앞 단계가 쓰지 않은 날짜(앞 단계의 9시대 처리에서 그날 아침 응원이 이미 만들어졌으므로)
  const dayA = new Date(Date.parse(tomorrow) + 2 * 86400e3).toISOString().slice(0, 10);
  jobs = await claim(kst(dayA, 8, 55));
  check('9시 전에는 아침 응원 없음', morning(jobs, M1.id).length === 0);
  jobs = await claim(kst(dayA, 9, 5));
  const mj = morning(jobs, M1.id);
  check('9시: 아침 응원(제목·오늘 화면·기본 문구는 날짜로 서버 기능이 채움)', mj.length === 1 && mj[0].payload.title === '오늘 하루도 화이팅!' && mj[0].payload.open === 'today' && mj[0].payload.quote_day === dayA && !mj[0].payload.body, JSON.stringify(mj[0]?.payload));
  check('식사 기록과 관계없이 담당 회원 모두에게', morning(jobs, M2.id).length === 1);
  await report(jobs.filter((j) => j.payload.tag === 'morning'));
  check('아침 응원은 하루 한 번', morning(await claim(kst(dayA, 9, 30)), M1.id).length === 0);
  const dayM = new Date(Date.parse(tomorrow) + 3 * 86400e3).toISOString().slice(0, 10);
  // 앱에서는 오늘 날짜로만 한마디를 쓸 수 있어, 그날의 한마디는 DB에 직접 넣는다(앞뒤 공백은 보낼 때 정리되는지 함께 본다)
  sql(`insert into public.trainer_messages (trainer_id, day, body) values ('${T.id}', '${dayM}', '  오늘은 계단으로 올라가 봐요!  ')`);
  const tm = { error: null };
  await M2.c.from('push_prefs').upsert({ user_id: M2.id, morning: false });
  jobs = await claim(kst(dayM, 9, 10));
  const mj2 = morning(jobs, M1.id);
  check('트레이너가 그날 한마디를 썼으면 그 글로(앞뒤 공백 정리)', !tm.error && mj2.length === 1 && mj2[0].payload.body === '오늘은 계단으로 올라가 봐요!' && !mj2[0].payload.quote_day, JSON.stringify(tm.error ?? mj2[0]?.payload));
  check('아침 응원을 끈 회원에게는 안 감', morning(jobs, M2.id).length === 0);
  await report(jobs.filter((j) => j.payload.tag === 'morning'));
  await M2.c.from('push_prefs').upsert({ user_id: M2.id, morning: true });
  const dayN = new Date(Date.parse(tomorrow) + 4 * 86400e3).toISOString().slice(0, 10);
  check('11시가 지나 처음 돌면 그날 아침 응원은 보내지 않음', morning(await claim(kst(dayN, 11, 5)), M1.id).length === 0);
  check('트레이너는 아침 응원을 받지 않음', morning(await claim(kst(dayN, 9, 5)), T.id).length === 0);

  // ─── 6. 동시 호출: 같은 시점 판정이 겹쳐도 알림 하나 ───
  resetState([T.id, M1.id, M2.id]);
  const day2 = new Date(Date.parse(tomorrow) + 86400e3).toISOString().slice(0, 10);
  await meal(M1, { eaten_on: day2, meal_type: '아침' });
  const [a, b] = await Promise.all([claim(kst(day2, 9, 5)), claim(kst(day2, 9, 5))]);
  const both = [...jobsFor(a, T.id), ...jobsFor(b, T.id)];
  const made = sql(`select count(*)::int n from private.push_notifications where user_id = '${T.id}' and kind = 'digest' and slot_key = '${day2} 09'`)[0]?.n;
  check('두 호출이 겹쳐도 알림 1건·전송 1건', made === 1 && both.length === 1, `알림 ${made} · 전송 ${both.length}`);
  await report(both);

  // ─── 7. 기기 두 대 중 한 대만 실패 / 410 정리 ───
  resetState([T.id, M1.id, M2.id]);
  const dM1b = newDevice();
  await (await login(M1.nick ?? `zz검증푸A${run}`)).c.rpc('register_push', { p_endpoint: dM1b.sub.endpoint, p_p256dh: dM1b.sub.p256dh, p_auth: dM1b.sub.auth });
  const f4 = await meal(M1, { eaten_on: day2, meal_type: '간식' });
  await T.c.rpc('rate_meal', { p_meal: f4, p_rating: 1 });
  jobs = (await claim(later(0.2))).filter((j) => j.payload.tag?.startsWith('feedback-') && j.payload.uid === M1.id);
  check('기기 두 대면 전송 두 건', jobs.length === 2);
  // 두 번째 기기(dM1b)만 실패시킨다(순서에 기대지 않고 주소로 고른다)
  const okJob = jobs.find((j) => j.endpoint_url !== dM1b.sub.endpoint), badJob = jobs.find((j) => j.endpoint_url === dM1b.sub.endpoint);
  await svc.rpc('push_report', { p_results: [{ notification_id: okJob.nid, subscription_id: okJob.sid, outcome: 'accepted' }, { notification_id: badJob.nid, subscription_id: badJob.sid, outcome: 'retry', code: 503 }] });
  await sql(`update private.push_deliveries set next_try_at = now() where notification_id = '${jobs[0].nid}' and status = 'retry'`);
  const again = (await claim(later(0.2))).filter((j) => j.nid === jobs[0].nid);
  check('실패한 기기만 다시 보냄', again.length === 1 && again[0].sid === badJob.sid);
  await report(again, 'gone', { code: 410 });
  check('410이면 그 기기 등록 삭제', sql(`select count(*)::int n from public.push_subscriptions where id = '${badJob.sid}'`)[0]?.n === 0
    && sql(`select count(*)::int n from public.push_subscriptions where id = '${okJob.sid}'`)[0]?.n === 1);

  // ─── 8. 실제 서버 기능 경로: 시험 알림 → 암호 해독 · 계정 전환 · 로그아웃 ───
  resetState([T.id, M1.id, M2.id]);
  const pt = await M1.c.rpc('push_test');
  check('알림 켜기 직후 시험 알림 요청', pt.data?.status === 'ok', JSON.stringify(pt.data ?? pt.error));
  const got = await waitFor(() => dM1.inbox.find((x) => x.data?.tag === 'test'));
  check('서버 기능이 보낸 시험 알림을 받아 암호를 풂', got?.data?.body?.startsWith('알림이 켜졌어요') && got?.data?.uid === M1.id && got?.ttl === '600' && got?.topic === 'test', JSON.stringify(got));
  check('VAPID 서명 머리글', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(got?.auth ?? ''));
  // 아침 응원의 기본 문구는 서버 기능이 앱과 같은 목록·같은 날짜 규칙으로 채운다(실제 전송·암호 해독으로 확인)
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  sql(`select private.push_add('${M1.id}', 'morning', '${today}', null, now(), now() + interval '2 hours')`);
  sql(`select private.push_kick()`);
  const gotM = await waitFor(() => dM1.inbox.find((x) => x.data?.tag === 'morning'));
  check('아침 응원: 받은 알림의 문구가 앱의 오늘의 한마디와 같음', gotM?.data?.title === '오늘 하루도 화이팅!' && gotM?.data?.body === quotes_.quoteFor(today) && !('quote_day' in (gotM?.data ?? {})), JSON.stringify(gotM?.data));
  check('30초 안에 다시 시험 알림은 거절', (await M1.c.rpc('push_test')).data?.status === 'too_soon');
  // 계정 전환: M1의 시험 알림이 429로 대기하는 사이 같은 브라우저(endpoint)를 M2가 등록
  await sleep(31000);
  dM1.codes.push(429, 429, 429);
  await M1.c.rpc('push_test');
  await waitFor(() => sql(`select status from private.push_deliveries d join private.push_notifications n on n.id = d.notification_id where n.user_id = '${M1.id}' and n.kind = 'test' order by n.created_at desc limit 1`)[0]?.status === 'retry');
  const before = dM1.inbox.length;
  check('같은 브라우저를 다른 계정이 등록', (await reg(M2, dM1)).data?.status === 'ok');
  dM1.codes.length = 0; // 이제부터 수신 서버는 정상(201)으로 받는다
  check('이전 계정의 대기 전송은 사라짐', sql(`select count(*)::int n from private.push_deliveries d join private.push_notifications n on n.id = d.notification_id where n.user_id = '${M1.id}' and n.kind = 'test' and d.status in ('pending','retry','sending')`)[0]?.n === 0);
  check('새 계정 시험 알림은 새 계정 것으로', (await M2.c.rpc('push_test')).data?.status === 'ok'
    && !!(await waitFor(() => dM1.inbox.slice(before).find((x) => x.data?.tag === 'test' && x.data?.uid === M2.id))));
  check('이전 계정 알림은 이 기기로 안 옴', !dM1.inbox.slice(before).some((x) => x.data?.uid === M1.id));
  // 로그아웃(세션 끝)한 기기는 알림 대상에서 빠지고 등록도 정리
  await M2.c.auth.signOut();
  const f5 = await meal(M1, { eaten_on: day2, meal_type: '저녁' });
  await T.c.from('comments').insert({ meal_id: f5, body: '확인했어요' });
  await claim(later(8));
  check('로그아웃한 세션의 기기 등록은 보낼 때 정리', sql(`select count(*)::int n from public.push_subscriptions where user_id = '${M2.id}'`)[0]?.n === 0);
  // 송신 스위치
  resetState([T.id, M1.id, M2.id]);
  sql(`update public.app_settings set value = 'off' where key = 'push_mode'`);
  await meal(M1, { eaten_on: day2, meal_type: '점심', note: '질문 있어요' });
  check('송신 스위치 off면 아무것도 안 만듦', jobsFor(await claim(kst(day2, 15, 5)), T.id).length === 0);
  sql(`update public.app_settings set value = 'testers' where key = 'push_mode'`);
  sql(`update public.app_settings set value = '${T.id}' where key = 'push_testers'`);
  const tjobs = await claim(kst(day2, 18, 5));
  check('testers면 허용한 계정만', jobsFor(tjobs, T.id).length === 1 && tjobs.every((j) => j.payload.uid === T.id));
  await report(tjobs);
} catch (e) {
  check('검증 도중 오류 없음', false, String(e?.message ?? e));
} finally {
  sql(`update public.app_settings set value = 'all' where key = 'push_mode'`);
  sql(`update public.app_settings set value = '' where key = 'push_testers'`);
  sql(`select cron.alter_job(jobid, active := true) from cron.job where jobname in ('mealnote-push', 'mealnote-push-pending')`);
  if (ids.length) sql(`delete from auth.users where id in (${ids.map((x) => `'${x}'`).join(',')})`);
  receiver.close();
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
