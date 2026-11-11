// Supabase에 시험 계정을 만들어 가입·권한 규칙을 확인한다.
// 기본은 로컬 DB: npm run check:backend (끝나면 시험 계정을 자동으로 지운다)
// 시험 계정 닉네임은 모두 "zz검증"으로 시작한다. 사진은 스크립트가 마지막에 직접 지운다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createHash, webcrypto } from 'node:crypto';

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const CODE = process.env.TRAINER_CODE;
if (!URL || !KEY || !CODE) throw new Error('VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, TRAINER_CODE 필요');

// 실행 번호: check.sh가 주면 그것(정리를 이 실행 것만 하도록), 따로 돌리면 새로 만든다
const run = process.env.CHECK_RUN || Date.now().toString(36).slice(-4);
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const emailOf = async (nick) => {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(nick.normalize('NFC').trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32) + '@users.mealnote.local';
};
let pass = 0, fail = 0;
// 실패 기록(v2.3.0 1차 리뷰): 시트 시험의 간헐적 시간 초과를 같은 실행 번호로 맞춰 볼 수 있게 끝에 test-results/backend/에 남긴다
const startedAt = new Date().toISOString();
const failures = [];
let fakeSheetLogs = () => null;
const edgeCalls = [];
const slowExec = [];
// 시험이 도중에 멈춰도 남도록 끝날 때 쓴다. docker logs는 도는 동안 부르면 가짜 시트 서버를 멈춘다
process.on('uncaughtExceptionMonitor', (e) => failures.push({ at: new Date().toISOString(), label: '시험이 도중에 멈춤', extra: String(e?.stack ?? e).slice(0, 4000) }));
// 올린 사진(경로 → 올린 계정). 계정은 정리 스크립트가 지우지만 사진은 올린 계정만 지울 수 있어, 시험이 도중에 멈춰도 여기서 지운다(v2.3.0 3차 리뷰)
const photos = new Map();
const removePhoto = async (path) => {
  const r = await photos.get(path).storage.from('meal-photos').remove([path]);
  if (!r.error) photos.delete(path);
  return r;
};
const stopEarly = async () => {
  await Promise.race([Promise.allSettled([...photos.keys()].map(removePhoto)), new Promise((r) => setTimeout(r, 10_000))]);
  if (photos.size) console.error(`지우지 못한 시험 사진 ${photos.size}개`);
  process.exit(1);
};
process.on('uncaughtException', (e) => {
  console.error(e);
  void stopEarly();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    failures.push({ at: new Date().toISOString(), label: '시험이 도중에 멈춤', extra: signal });
    void stopEarly();
  });
}
process.on('exit', () => {
  if (!failures.length) return;
  const logs = spawnSync('docker', ['logs', '--since', startedAt, 'supabase_edge_runtime_app'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const edge = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.split('\n').filter((l) => /\[Error\]|timed out/i.test(l)).slice(-200);
  mkdirSync('test-results/backend', { recursive: true });
  const file = `test-results/backend/failures-${run}.json`;
  writeFileSync(file, JSON.stringify({ run, startedAt, failures, edge, edgeCalls: edgeCalls.slice(-300), slowExec, fakeSheets: fakeSheetLogs() }, null, 1));
  console.log(`실패 기록: ${file}`);
});
const check = (label, ok, extra = '') => {
  ok ? pass++ : fail++;
  if (!ok) failures.push({ at: new Date().toISOString(), label, extra: String(extra).slice(0, 4000) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// 앱과 같은 가입 경로: begin_signup(코드·답 확인, 가입권) → 인증 서버에는 닉네임·가입권만
async function signUp(nickname, data) {
  const c = client();
  const d = { recovery_question: '1', recovery_answer: '어바웃 타임', ...data };
  const begin = await c.rpc('begin_signup', {
    p_nickname: nickname, p_role: d.role, p_question: Number(d.recovery_question) || null, p_answer: d.recovery_answer,
    p_trainer_code: d.trainer_code ?? null, p_trainer_id: d.trainer_id ?? null,
  });
  if (begin.error) return { c, error: begin.error };
  const { data: res, error } = await c.auth.signUp({ email: await emailOf(nickname), password: '123456', options: { data: { nickname, signup_ticket: begin.data } } });
  return { c, user: res?.user, session: res?.session, error };
}
const SECRET_KEYS = ['trainer_code', 'recovery_answer', 'recovery_question'];
const jwtClaims = (session) => JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString());
const hasSecret = (o) => SECRET_KEYS.some((k) => Object.hasOwn(o ?? {}, k)) || JSON.stringify(o ?? {}).includes('어바웃 타임');

const nT1 = `zz검증T1${run}`, nT2 = `zz검증T2${run}`, nM1 = `zz검증M1${run}`, nM2 = `zz검증M2${run}`;

// 가입 분기
const bad = await signUp(`zz검증X${run}`, { role: 'trainer', trainer_code: 'WRONG0000' });
check('틀린 등록 코드로 트레이너 가입 거부', !!bad.error, bad.error?.message);

const t1 = await signUp(nT1, { role: 'trainer', trainer_code: CODE.toLowerCase() });
check('맞는 등록 코드(소문자)로 트레이너 가입', !t1.error && !!t1.session, t1.error?.message);
const t2 = await signUp(nT2, { role: 'trainer', trainer_code: CODE });
check('두 번째 트레이너 가입', !t2.error && !!t2.session, t2.error?.message);
check('가입 직후 응답·로그인 토큰에 등록 코드·복구 답 원문이 없음(Codex 재검토 P1)', !!t1.session && !hasSecret(t1.user?.user_metadata) && !hasSecret(jwtClaims(t1.session).user_metadata) && !JSON.stringify(t1.session).includes(CODE.toLowerCase()), JSON.stringify(Object.keys(t1.user?.user_metadata ?? {})));
const direct = await client().auth.signUp({ email: await emailOf(`zz검증D${run}`), password: '123456', options: { data: { nickname: `zz검증D${run}`, role: 'trainer', trainer_code: CODE, recovery_question: '1', recovery_answer: '어바웃 타임' } } });
check('가입권 없이 인증 서버로 직접 가입하면 거부', !!direct.error, direct.error?.message);
const t1fresh = (await t1.c.auth.getUser()).data.user;
check('저장된 계정 정보에 등록 코드가 남지 않음', !!t1fresh && !('trainer_code' in (t1fresh.user_metadata || {})));

const anon = client();
const { data: trainers } = await anon.rpc('list_trainers');
check('로그인 전 트레이너 목록에 두 트레이너가 보임', [nT1, nT2].every((n) => trainers?.some((t) => t.nickname === n)));
const t1id = trainers.find((t) => t.nickname === nT1).id, t2id = trainers.find((t) => t.nickname === nT2).id;

// 테스트 계정 표시가 붙은 트레이너는 가입 화면 목록에서 빠진다(로컬 DB에서만 표시를 바꿔 본다)
if (/127\.0\.0\.1|localhost/.test(URL)) {
  const { execSync } = await import('node:child_process');
  execSync(`supabase db query --local "update public.profiles set is_test = true where nickname = '${nT2}';"`, { stdio: 'ignore' });
  const { data: listed } = await anon.rpc('list_trainers');
  check('테스트 트레이너는 가입 화면 목록에 안 뜸', !listed?.some((t) => t.nickname === nT2) && listed?.some((t) => t.nickname === nT1));
  execSync(`supabase db query --local "update public.profiles set is_test = false where nickname = '${nT2}';"`, { stdio: 'ignore' });
}
const forgedTest = await t1.c.from('profiles').update({ is_test: true }).eq('id', t1.user.id).select();
check('앱에서 테스트 표시를 바꾸는 것 거부', (forgedTest.data?.length ?? 0) === 0);

const { data: taken } = await anon.rpc('nickname_taken', { p_nickname: nT1.toUpperCase() });
check('닉네임 중복 확인(대소문자 무시)', taken === true);

const badMember = await signUp(`zz검증Y${run}`, { role: 'member', trainer_id: '00000000-0000-0000-0000-000000000000' });
check('없는 트레이너로 회원 가입 거부', !!badMember.error);

const m1 = await signUp(nM1, { role: 'member', trainer_id: t1id });
check('회원1 가입(트레이너1 담당)', !m1.error && !!m1.session, m1.error?.message);
const m2 = await signUp(nM2, { role: 'member', trainer_id: t2id });
check('회원2 가입(트레이너2 담당)', !m2.error && !!m2.session, m2.error?.message);

const dup = await signUp(nM1, { role: 'member', trainer_id: t1id });
check('같은 닉네임 재가입 거부', !!dup.error, dup.error?.message);

// 로그인
const login = client();
const { error: loginErr } = await login.auth.signInWithPassword({ email: await emailOf(nM1), password: '123456' });
check('닉네임+PIN 로그인', !loginErr, loginErr?.message);
const { error: wrongPin } = await client().auth.signInWithPassword({ email: await emailOf(nM1), password: '654321' });
check('틀린 PIN 로그인 거부', !!wrongPin);

// 식사 등록과 사진
const mealId = webcrypto.randomUUID();
const m1id = m1.user.id;
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const putPhoto = (c, path) => {
  photos.set(path, c);
  return c.storage.from('meal-photos').upload(path, jpeg, { contentType: 'image/jpeg' });
};
const up = await putPhoto(m1.c, `${m1id}/${mealId}.jpg`);
check('회원1 자기 폴더에 사진 업로드', !up.error, up.error?.message);
const upOther = await m2.c.storage.from('meal-photos').upload(`${m1id}/hack.jpg`, jpeg, { contentType: 'image/jpeg' });
check('회원2가 회원1 폴더에 업로드 거부', !!upOther.error);

// 시험 식사 날짜는 오늘 기준 어제로(2026-10-31: 고정 날짜 '2026-10-20'이 시간이 지나 뒤쪽 결산 시험의 기간(20일 전～11일 전)에 들어가 결산 끼니 수가 늘었다)
const recentDay = (() => { const x = new Date(); x.setDate(x.getDate() - 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })();
const ins = await m1.c.from('meals').insert({ id: mealId, eaten_on: recentDay, eaten_at: '12:30', meal_type: '점심', food: '현미밥, 닭가슴살', note: '', photo_path: `${m1id}/${mealId}.jpg` }).select().single();
check('회원1 식사 등록', !ins.error, ins.error?.message);
const insForged = await m1.c.from('meals').insert({ eaten_on: recentDay, eaten_at: '12:30', meal_type: '점심', food: 'x', reviewed_at: new Date().toISOString() });
check('회원이 확인 시각을 직접 넣는 것 거부', !!insForged.error);
const insByTrainer = await t1.c.from('meals').insert({ eaten_on: recentDay, eaten_at: '12:30', meal_type: '점심', food: 'x' });
check('트레이너의 식사 등록 거부', !!insByTrainer.error);

// 보이는 범위
const seen = async (c) => (await c.from('meals').select('id').eq('id', mealId)).data?.length ?? -1;
check('트레이너1(담당)은 회원1 식사를 봄', (await seen(t1.c)) === 1);
check('트레이너2(비담당)는 회원1 식사를 못 봄', (await seen(t2.c)) === 0);
check('회원2는 회원1 식사를 못 봄', (await seen(m2.c)) === 0);
check('로그인 안 한 사람은 못 봄', (await seen(anon)) <= 0);

const sig = async (c) => !(await c.storage.from('meal-photos').createSignedUrl(`${m1id}/${mealId}.jpg`, 60)).error;
// 남의 사진(담당 트레이너·추천 식단)은 서명 주소 없이 서버 기능 meal-photo가 요청마다 권한을 확인해 내려준다(Codex v1.8.0 재리뷰 1)
const photoVia = async (c, id) => {
  const token = (await c.auth.getSession()).data.session?.access_token;
  const r = await fetch(`${URL}/functions/v1/meal-photo`, { method: 'POST', headers: { apikey: KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ meal: id }) });
  return r.status === 200 && (await r.arrayBuffer()).byteLength > 0;
};
check('회원1은 자기 사진 주소를 받음', await sig(m1.c));
check('트레이너1은 서명 주소 없이 서버 기능으로 사진을 받음', !(await sig(t1.c)) && (await photoVia(t1.c, mealId)));
check('트레이너2는 서버 기능으로도 못 받음', !(await photoVia(t2.c, mealId)));
check('트레이너2는 사진 주소를 못 받음', !(await sig(t2.c)));
check('회원2는 사진 주소를 못 받음', !(await sig(m2.c)));

const profT2 = (await t2.c.from('profiles').select('nickname')).data?.map((p) => p.nickname) ?? [];
check('트레이너2는 회원1 프로필을 못 봄', !profT2.includes(nM1));
const profM1 = (await m1.c.from('profiles').select('nickname')).data?.map((p) => p.nickname) ?? [];
check('회원1은 자기와 담당 트레이너 프로필만 봄', profM1.length === 2 && profM1.includes(nT1));

// 댓글·확인
const q = await m1.c.from('comments').insert({ meal_id: mealId, body: '양이 괜찮을까요?' }).select().single();
check('회원1 질문 댓글', !q.error && q.data?.author_role === 'member', q.error?.message);
const forged = await m1.c.from('comments').insert({ meal_id: mealId, body: 'x', author_role: 'trainer' });
check('작성자 역할 위조 거부', !!forged.error);
const c2 = await t2.c.from('comments').insert({ meal_id: mealId, body: '끼어들기' });
check('비담당 트레이너 댓글 거부', !!c2.error);
const rv2 = await t2.c.rpc('mark_reviewed', { p_meal: mealId });
check('비담당 트레이너 확인 완료 거부(권한 때문에)', /not_allowed/.test(rv2.error?.message ?? ''), rv2.error?.message);
const rv1 = await t1.c.rpc('mark_reviewed', { p_meal: mealId });
check('담당 트레이너 확인 완료(답변 없이 확인)', !rv1.error, rv1.error?.message);
const rvAt = await m1.c.from('meals').select('reviewed_at, reviewed_by').eq('id', mealId).single();
check('확인 시각·확인한 트레이너가 기록됨', !!rvAt.data?.reviewed_at && rvAt.data?.reviewed_by === t1.user.id);

const a = await t1.c.from('comments').insert({ meal_id: mealId, body: '적당해요. 저녁엔 채소를 더해 보세요.' }).select().single();
check('담당 트레이너 피드백 댓글', !a.error && a.data?.author_role === 'trainer', a.error?.message);
const after = await m1.c.from('meals').select('reviewed_at, reviewed_by').eq('id', mealId).single();
check('트레이너 댓글로 확인 시각이 기록됨', !!after.data?.reviewed_at && after.data?.reviewed_by === t1.user.id);

const seenRpc = await m1.c.rpc('mark_seen', { p_meal: mealId });
check('회원이 피드백 읽음 표시(서버 시각)', !seenRpc.error, seenRpc.error?.message);
const seenRow = await m1.c.from('meals').select('member_seen_at').eq('id', mealId).single();
const lastT = (await m1.c.from('comments').select('created_at').eq('meal_id', mealId).eq('author_role', 'trainer').order('created_at', { ascending: false }).limit(1)).data?.[0];
check('읽은 시각이 트레이너 댓글보다 뒤', !!lastT && Date.parse(seenRow.data.member_seen_at) >= Date.parse(lastT.created_at));
const seenOther = await m2.c.rpc('mark_seen', { p_meal: mealId });
check('남의 식사 읽음 표시 거부(권한 때문에)', /not_allowed/.test(seenOther.error?.message ?? ''), seenOther.error?.message);
const forgedSeen = await m1.c.from('meals').update({ member_seen_at: '2099-01-01T00:00:00Z' }).eq('id', mealId);
check('앱이 읽은 시각을 직접 넣는 것 거부', !!forgedSeen.error);
const updRev = await m1.c.from('meals').update({ reviewed_at: null }).eq('id', mealId);
check('회원이 확인 시각을 지우는 것 거부', !!updRev.error);
const updOther = await m2.c.from('meals').update({ food: '조작' }).eq('id', mealId).select();
check('회원2가 회원1 식사 수정 못 함', (updOther.data?.length ?? 0) === 0);

// 익명 의견·운영자
const ADMIN = process.env.ADMIN_CODE;
if (!ADMIN) throw new Error('ADMIN_CODE 필요(.env.local)');
const fbText = `검증 의견 ${run}`;
const fb1 = await m1.c.from('app_feedback').insert({ category: 'bug', body: fbText, screen: '회원 오늘', device: 'test', app_version: 'test' });
check('회원이 의견을 보냄', !fb1.error, fb1.error?.message);
const fb2 = await t1.c.from('app_feedback').insert({ category: 'idea', body: `${fbText} 트레이너`, screen: '트레이너 확인 목록' });
check('트레이너도 의견을 보냄', !fb2.error, fb2.error?.message);
const fbAnon = await anon.from('app_feedback').insert({ category: 'other', body: 'x' });
check('로그인 안 한 사람은 의견을 못 보냄', !!fbAnon.error);
const fbForged = await m1.c.from('app_feedback').insert({ category: 'bug', body: 'x', status: 'done' });
check('보내는 사람이 처리 상태를 정하는 것 거부', !!fbForged.error);
check('회원은 의견 목록을 못 읽음', ((await m1.c.from('app_feedback').select('id')).data?.length ?? 0) === 0);
check('트레이너는 의견 목록을 못 읽음', ((await t1.c.from('app_feedback').select('id')).data?.length ?? 0) === 0);

const ad = await signUp(`zz검증운영${run}`, { role: 'trainer', trainer_code: ADMIN.toLowerCase() });
check('운영자 코드로 가입', !ad.error && !!ad.session, ad.error?.message);
const adProf = await ad.c.from('profiles').select('role').eq('id', ad.user?.id ?? '').maybeSingle();
check('운영자 역할로 저장됨', adProf.data?.role === 'admin', JSON.stringify(adProf.data));
const { data: trainers2 } = await anon.rpc('list_trainers');
check('운영자는 회원 가입 화면 트레이너 목록에 안 뜸', !trainers2?.some((t) => t.nickname === `zz검증운영${run}`));
const adList = await ad.c.from('app_feedback').select('*').like('body', `${fbText}%`);
check('운영자는 의견 2건을 읽음', adList.data?.length === 2, adList.error?.message);
const cols = Object.keys(adList.data?.[0] ?? {});
check('의견에 작성자 칸이 없음(익명)', cols.length > 0 && !cols.some((c) => /author|user|member|nick|profile/i.test(c)), cols.join(','));
check('운영자는 식사 기록을 못 봄', ((await ad.c.from('meals').select('id')).data?.length ?? 0) === 0);
const adUpd = await ad.c.from('app_feedback').update({ status: 'done' }).eq('id', adList.data?.[0]?.id ?? '').select();
check('운영자가 처리 완료로 바꿈', !adUpd.error && adUpd.data?.length === 1, adUpd.error?.message);
const mUpd = await m1.c.from('app_feedback').update({ status: 'new' }).eq('id', adList.data?.[0]?.id ?? '').select();
check('회원은 의견 상태를 못 바꿈', (mUpd.data?.length ?? 0) === 0);
await ad.c.from('app_feedback').delete().like('body', `${fbText}%`); // 운영자도 삭제 권한은 없다(아래 정리 SQL이 지움)

// v1.3 복구 질문: 트레이너 재설정 기능은 없어야 하고, 답을 아는 본인만 PIN을 되찾는다
const anonCalls = await Promise.all(['my_security_status', 'report_pin_not_me', 'admin_security_events', 'ack_pin_change'].map((f) => anon.rpc(f)));
check('로그인 안 한 사람은 로그인 전용 함수를 못 부름', anonCalls.every((r) => !!r.error), JSON.stringify(anonCalls.map((r) => r.error?.code ?? 'OK')));
const oldReq = await anon.rpc('request_pin_reset', { p_nickname: nM1, p_trainer: t1id });
const oldReset = await t1.c.rpc('reset_member_pin', { p_member: m1id });
check('트레이너가 회원 PIN을 만드는 기능이 없음(Codex P1)', !!oldReq.error && !!oldReset.error);
const noRec = await signUp(`zz검증R${run}`, { role: 'member', trainer_id: t1id, recovery_question: '', recovery_answer: '' });
check('복구 질문 없이는 가입 거부', !!noRec.error);
const u1 = (await m1.c.auth.getUser()).data.user;
const meta1 = u1?.user_metadata ?? {};
check('계정 정보에 복구 답이 남지 않음', !('recovery_answer' in meta1) && !('recovery_question' in meta1));
const idData = [u1, (await t1.c.auth.getUser()).data.user].flatMap((u) => u?.identities ?? []).map((i) => i.identity_data ?? {});
check('identities에도 복구 답·등록 코드 원문이 없음(Codex 재검토 P1)', idData.length >= 2 && idData.every((d) => !('recovery_answer' in d) && !('trainer_code' in d) && !('recovery_question' in d)), JSON.stringify(idData.map(Object.keys)));
const rq = await anon.rpc('get_recovery_question', { p_nickname: nM1.toUpperCase() });
check('로그인 전 닉네임으로 복구 질문 번호를 받음', rq.data === 1, JSON.stringify(rq));
const tRec = await t1.c.from('account_security').select('*');
check('복구 답 저장소는 앱에서 못 읽음', !!tRec.error || (tRec.data?.length ?? 0) === 0);
const wrong = await anon.rpc('reset_pin_with_answer', { p_nickname: nM1, p_answer: '타이타닉', p_new_pin: '111111' });
check('틀린 답 → 남은 횟수 안내', wrong.data?.status === 'wrong' && wrong.data?.remaining === 4, JSON.stringify(wrong.data));
const st1 = (await m1.c.rpc('my_security_status')).data;
check('로그인해 둔 기기가 틀린 시도를 알 수 있음', st1?.failed_count === 1 && !!st1?.last_failed_at, JSON.stringify(st1));
const okReset = await anon.rpc('reset_pin_with_answer', { p_nickname: nM1, p_answer: '어바웃타임', p_new_pin: '111111' });
check('맞는 답(띄어쓰기 달라도) → 본인이 새 PIN', okReset.data?.status === 'ok', JSON.stringify(okReset.data));
check('예전 PIN으로는 로그인 안 됨', !!(await client().auth.signInWithPassword({ email: await emailOf(nM1), password: '123456' })).error);
const m1b = client();
check('새 PIN으로 로그인', !(await m1b.auth.signInWithPassword({ email: await emailOf(nM1), password: '111111' })).error);
const st2 = (await m1.c.rpc('my_security_status')).data;
check('로그인해 둔 다른 기기가 PIN 변경 시각을 알 수 있음', !!st2?.pin_changed_at && st2?.failed_count === 0, JSON.stringify(st2));
// 바뀐 뒤 로그인한 기기(m1b)는 되찾기 불가, 바뀌기 전부터 로그인돼 있던 기기(m1)는 되찾기 가능
const reclaimNew = await m1b.rpc('reclaim_account', { p_new_pin: '222222', p_question: 2, p_answer: '밤양갱' });
check('PIN이 바뀐 뒤 로그인한 기기는 되찾기 불가', /not_allowed/.test(reclaimNew?.error?.message ?? ''), reclaimNew?.error?.message);
const selfChange = await m1b.rpc('change_my_pin', { p_new_pin: '121212', p_current_pin: '111111' });
const reclaimAfterSelf = await m1b.rpc('reclaim_account', { p_new_pin: '232323', p_question: 4, p_answer: '제주도' });
check('새 기기가 PIN을 한 번 더 바꿔도 되찾기 자격이 안 생김(Codex 재검토 P1)', selfChange.data?.status === 'ok' && /not_allowed/.test(reclaimAfterSelf.error?.message ?? ''), JSON.stringify([selfChange.data, reclaimAfterSelf.error?.message]));
await m1.c.rpc('report_pin_not_me');
const reclaim = await m1.c.rpc('reclaim_account', { p_new_pin: '222222', p_question: 2, p_answer: '밤양갱' });
check('바뀌기 전부터 로그인돼 있던 기기는 되찾기 가능', reclaim.data?.status === 'ok', JSON.stringify(reclaim.error ?? reclaim.data));
// 남은 접근 토큰(최대 1시간)으로도 데이터에 손대지 못해야 한다 — 토큰 갱신 시도 전에 확인
const leftProf = await m1b.from('profiles').select('id');
const leftIns = await m1b.from('meals').insert({ eaten_on: recentDay, eaten_at: '09:00', meal_type: '아침', food: '남은 토큰' });
const leftRpc = await m1b.rpc('my_security_status');
check('되찾은 뒤 다른 기기의 남은 토큰으로 조회·등록·함수 호출 불가(Codex 재검토 P1)', (leftProf.data?.length ?? 0) === 0 && !!leftIns.error && !!leftRpc.error, JSON.stringify([leftProf.data?.length, leftIns.error?.message, leftRpc.error?.message]));
const afterReclaim = await m1b.auth.refreshSession();
check('되찾으면 다른 기기는 로그아웃됨', !!afterReclaim.error);
check('되찾은 PIN으로 로그인', !(await client().auth.signInWithPassword({ email: await emailOf(nM1), password: '222222' })).error);
const rq2 = await anon.rpc('get_recovery_question', { p_nickname: nM1 });
check('되찾을 때 정한 새 복구 질문으로 바뀜', rq2.data === 2);
const chWrong = await m1.c.rpc('change_my_pin', { p_new_pin: '333333', p_current_pin: '000000' });
check('지금 PIN이 틀리면 PIN 바꾸기 거부', chWrong.data?.status === 'wrong');
const chAns = await m1.c.rpc('change_my_pin', { p_new_pin: '333333', p_answer: '밤 양갱' });
check('로그인 상태에서 복구 답으로 PIN 바꾸기', chAns.data?.status === 'ok' && !!chAns.data?.pin_changed_at, JSON.stringify(chAns.data));
const chPin = await m1.c.rpc('change_my_pin', { p_new_pin: '444444', p_current_pin: '333333' });
check('지금 PIN으로 PIN 바꾸기', chPin.data?.status === 'ok');
const setRecWrong = await m1.c.rpc('set_recovery', { p_question: 3, p_answer: '아이유', p_current_pin: '000000' });
const setRec = await m1.c.rpc('set_recovery', { p_question: 3, p_answer: '아이유', p_current_pin: '444444' });
check('복구 질문 바꾸기는 지금 PIN이 맞을 때만', setRecWrong.data?.status === 'wrong' && setRec.data?.status === 'ok');
// 잠금: 5번 틀리면 24시간, 잠긴 동안은 맞는 답도 거부
let last;
for (let i = 0; i < 5; i++) last = await anon.rpc('reset_pin_with_answer', { p_nickname: nM2, p_answer: `틀림${i}`, p_new_pin: '555555' });
const lockedOk = await anon.rpc('reset_pin_with_answer', { p_nickname: nM2, p_answer: '어바웃 타임', p_new_pin: '555555' });
check('5번 틀리면 잠김, 잠긴 동안 맞는 답도 거부', last.data?.status === 'locked' && lockedOk.data?.status === 'locked', JSON.stringify([last.data, lockedOk.data]));
const bypass = await m2.c.auth.updateUser({ password: '777777' });
const stillOld = await client().auth.signInWithPassword({ email: await emailOf(nM2), password: '123456' });
check('표준 Auth API로는 PIN을 못 바꿈(Codex 재검토 P1)', !!bypass.error && !stillOld.error, JSON.stringify([bypass.error?.message, stillOld.error?.message]));
const adEvents = await ad.c.rpc('admin_security_events');
check('운영자가 신고·되찾기·잠김 기록을 봄', ['reported_not_me', 'reclaimed', 'recovery_locked'].every((k) => adEvents.data?.some((e) => e.kind === k)), JSON.stringify(adEvents.error ?? adEvents.data?.map((e) => e.kind)));
check('운영자가 아니면 보안 기록을 못 봄', ((await t1.c.rpc('admin_security_events')).data?.length ?? 0) === 0);

// Codex 재검토(25480f2) P1: 되찾기 기준 시각의 수명 — 본인 기기는 나중 공격 때도 되찾을 수 있어야 하고, 공격자 새 기기는 못 해야 한다
const nM3 = `zz검증M3${run}`;
const m3 = await signUp(nM3, { role: 'member', trainer_id: t1id });
const login3 = async (pin) => { const c = client(); const r = await c.auth.signInWithPassword({ email: await emailOf(nM3), password: pin }); return r.error ? null : c; };
const reset3 = (answer, pin) => anon.rpc('reset_pin_with_answer', { p_nickname: nM3, p_answer: answer, p_new_pin: pin });
const canReclaim = async (c) => (await c.rpc('my_security_status')).data?.can_reclaim;
// (가) 정상 변경 → 로그아웃 → 재로그인 → 다른 기기에서 복구(공격) → 재로그인한 본인 기기가 되찾기
await m3.c.rpc('change_my_pin', { p_new_pin: '101010', p_current_pin: '123456' });
await m3.c.auth.signOut();
const m3b = await login3('101010');
await reset3('어바웃 타임', '202020');
const rcA = await m3b.rpc('reclaim_account', { p_new_pin: '303030', p_question: 2, p_answer: '밤양갱' });
check('정상 변경 뒤 재로그인한 본인 기기도 나중 공격 때 되찾기 가능(Codex 재검토 P1)', rcA.data?.status === 'ok', JSON.stringify(rcA.error?.message ?? rcA.data));
// (나) 로그인 기기 없이 정상 복구 → 새로 로그인 → 다른 기기에서 복구(공격) → 그 본인 기기가 되찾기
await m3b.auth.signOut();
await reset3('밤양갱', '404040');
const m3c = await login3('404040');
await reset3('밤양갱', '505050');
const rcB = await m3c.rpc('reclaim_account', { p_new_pin: '606060', p_question: 3, p_answer: '아이유' });
check('로그인 기기 없이 정상 복구한 뒤에도 나중 공격 때 되찾기 가능(Codex 재검토 P1)', rcB.data?.status === 'ok', JSON.stringify(rcB.error?.message ?? rcB.data));
// (다) 본인 기기가 있는 동안 공격자가 복구·로그인·재복구를 반복해도 공격자 기기는 자격이 없다
await reset3('아이유', '707070');
const atk = await login3('707070');
await reset3('아이유', '808080');
check('공격자가 복구를 거듭해도 공격자 기기는 되찾기 불가, 본인 기기는 가능', (await canReclaim(atk)) === false && (await canReclaim(m3c)) === true);
await m3c.rpc('ack_pin_change');
check("'네, 제가 바꿨어요'로 되찾기 창이 닫힘", (await canReclaim(m3c)) === false);
const rcLogin = await m3.c.rpc('change_my_pin', { p_new_pin: '909090', p_current_pin: '808080' });
check('로그아웃한 세션으로는 PIN 변경 불가', !!rcLogin.error);
// Codex 재검토(f0e8c9f) P1: 이전 기기 두 곳이 동시에 되찾기 → 하나만 성공하고 그 기기 세션은 남아야 한다
const old2 = await login3('808080');
await reset3('아이유', '919191');
const rr = await Promise.all([
  m3c.rpc('reclaim_account', { p_new_pin: '121212', p_question: 5, p_answer: '소방관' }),
  old2.rpc('reclaim_account', { p_new_pin: '131313', p_question: 5, p_answer: '우주비행사' }),
]);
const okCount = rr.filter((r) => r.data?.status === 'ok').length;
const winner = rr[0].data?.status === 'ok' ? m3c : old2;
check('동시 되찾기는 하나만 성공하고 이긴 기기 세션은 살아 있음(Codex 재검토 P1)', okCount === 1 && !(await winner.rpc('my_security_status')).error, JSON.stringify(rr.map((r) => r.data?.status ?? r.error?.message)));

// Codex P2(5): 확인 뒤 '한마디'를 고쳐 쓰면 다시 답변 대기
const nm = await m2.c.from('meals').insert({ eaten_on: recentDay, eaten_at: '08:00', meal_type: '아침', food: '토스트', note: '' }).select().single();
await t2.c.rpc('mark_reviewed', { p_meal: nm.data.id });
await new Promise((r) => setTimeout(r, 30));
await m2.c.from('meals').update({ note: '양이 적었나요?' }).eq('id', nm.data.id);
const nm2 = (await t2.c.from('meals').select('reviewed_at, note_updated_at, member_msg_at').eq('id', nm.data.id).single()).data;
check('확인 뒤 고친 한마디는 확인 시각보다 뒤(다시 답변 대기)', Date.parse(nm2.note_updated_at) > Date.parse(nm2.reviewed_at) && Date.parse(nm2.member_msg_at) > Date.parse(nm2.reviewed_at), JSON.stringify(nm2));
// Codex P2(3): 70일 전 식사를 확인한 뒤 새 질문 → 트레이너 조회 조건에 걸림
const old = await m2.c.from('meals').insert({ eaten_on: '2026-08-10', eaten_at: '12:00', meal_type: '점심', food: '오래된 식사', note: '' }).select().single();
await t2.c.rpc('mark_reviewed', { p_meal: old.data.id });
await m2.c.from('comments').insert({ meal_id: old.data.id, body: '이때 식사 괜찮았나요?' });
const sinceDay = '2026-10-07', sinceTs = new Date(Date.now() - 60 * 864e5).toISOString();
const found = await t2.c.from('meals').select('id').or(`eaten_on.gte.${sinceDay},reviewed_at.is.null,member_msg_at.gte."${sinceTs}"`).eq('id', old.data.id);
check('오래된 식사의 새 질문도 트레이너 조회에 잡힘', found.data?.length === 1, JSON.stringify(found.error ?? found.data));
await t2.c.from('comments').insert({ meal_id: old.data.id, body: '네, 괜찮았어요.' });
const memberSees = await m2.c.from('meals').select('id').or(`eaten_on.gte.${sinceDay},trainer_msg_at.gte."${sinceTs}"`).eq('id', old.data.id);
check('오래된 식사에 달린 새 피드백도 회원 조회에 잡힘(Codex 재검토 P2)', memberSees.data?.length === 1, JSON.stringify(memberSees.error ?? memberSees.data));
await m2.c.from('meals').delete().in('id', [nm.data.id, old.data.id]);

// v1.4 오늘의 한마디(트레이너가 쓰면 담당 회원에게만) · 연속 기록(하루 1끼 이상)
const dk = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const today = dk();
const anonNew = await Promise.all([
  anon.rpc('meal_streak', { p_today: today }), anon.rpc('member_streaks', { p_today: today }), anon.rpc('set_trainer_message', { p_day: today, p_body: 'x' }),
]);
check('로그인 안 한 사람은 한마디·연속 기록 함수를 못 부름', anonNew.every((r) => !!r.error), JSON.stringify(anonNew.map((r) => r.error?.code ?? 'OK')));
check('로그인 안 한 사람은 한마디를 못 읽음', ((await anon.from('trainer_messages').select('body')).data?.length ?? 0) === 0);

const w1 = await t1.c.rpc('set_trainer_message', { p_day: today, p_body: '  오늘은 물 2리터 도전!  ' });
check('트레이너1이 오늘 한마디를 씀', !w1.error, w1.error?.message);
const readMsg = async (c) => (await c.from('trainer_messages').select('trainer_id, body').eq('day', today)).data ?? [];
const m1msg = await readMsg(m1.c);
check('담당 회원은 트레이너 한마디를 읽음(앞뒤 공백 정리)', m1msg.length === 1 && m1msg[0].body === '오늘은 물 2리터 도전!', JSON.stringify(m1msg));
check('다른 트레이너의 회원은 못 읽음', (await readMsg(m2.c)).length === 0);
check('다른 트레이너도 못 읽음', (await readMsg(t2.c)).length === 0);
await t2.c.rpc('set_trainer_message', { p_day: today, p_body: '트레이너2 한마디' });
const m1again = await readMsg(m1.c), m2msg = await readMsg(m2.c);
check('두 트레이너가 쓰면 회원마다 자기 트레이너 것 하나만 보임', m1again.length === 1 && m1again[0].trainer_id === t1id && m2msg.length === 1 && m2msg[0].trainer_id === t2id, JSON.stringify([m1again, m2msg]));
const wm = await m1.c.rpc('set_trainer_message', { p_day: today, p_body: '회원이 쓴 글' });
check('회원은 한마디를 못 씀(권한 때문에)', /not_allowed/.test(wm.error?.message ?? ''), wm.error?.message);
const wLong = await t1.c.rpc('set_trainer_message', { p_day: today, p_body: '가'.repeat(101) });
check('100자를 넘는 한마디 거부', /too_long/.test(wLong.error?.message ?? ''), wLong.error?.message);
const wDay = await t1.c.rpc('set_trainer_message', { p_day: '2020-01-01', p_body: '옛날 글' });
check('터무니없는 날짜의 한마디 거부', /bad_day/.test(wDay.error?.message ?? ''), wDay.error?.message);
const wDirect = await t1.c.from('trainer_messages').insert({ trainer_id: t1id, day: dk(1), body: '직접 넣기' });
check('표에 직접 쓰는 것 거부(함수로만)', !!wDirect.error);
const wUpd = await t1.c.from('trainer_messages').update({ body: '직접 고치기' }).eq('trainer_id', t1id).select();
check('표를 직접 고치는 것 거부', !!wUpd.error || (wUpd.data?.length ?? 0) === 0);
const wFake = await t2.c.from('trainer_messages').select('body').eq('trainer_id', t1id);
check('다른 트레이너 것을 골라 읽어도 안 보임', (wFake.data?.length ?? 0) === 0);
await t1.c.rpc('set_trainer_message', { p_day: today, p_body: '   ' });
check('빈 글로 저장하면 지워져 기본 문구로 돌아감', (await readMsg(m1.c)).length === 0);

const m4 = await signUp(`zz검증M4${run}`, { role: 'member', trainer_id: t1id });
const m4id = m4.user?.id;
const streak = async (c, d = today) => (await c.rpc('meal_streak', { p_today: d })).data;
const s0 = await streak(m4.c);
check('기록이 없으면 연속 0일', s0?.current === 0 && s0?.best === 0 && s0?.today_logged === false, JSON.stringify(s0));
const meal = (day, type = '점심') => ({ eaten_on: day, eaten_at: '12:00', meal_type: type, food: '연속 기록 검증', note: '' });
await m4.c.from('meals').insert([meal(dk(-1)), meal(dk(-2)), meal(dk(-2), '저녁'), meal(dk(-5)), meal(dk(-6)), meal(dk(-7))]);
const s1 = await streak(m4.c);
check('오늘 미기록이면 어제까지 이어진 날 수(같은 날 두 끼는 하루)', s1?.current === 2 && s1?.best === 3 && s1?.today_logged === false, JSON.stringify(s1));
await m4.c.from('meals').insert(meal(today, '아침'));
const s2 = await streak(m4.c);
check('오늘 기록하면 오늘까지 이어짐', s2?.current === 3 && s2?.best === 3 && s2?.today_logged === true, JSON.stringify(s2));
const sBad = await m4.c.rpc('meal_streak', { p_today: '2020-01-01' });
check('터무니없는 기준 날짜 거부', /bad_day/.test(sBad.error?.message ?? ''), sBad.error?.message);
const ms1 = (await t1.c.rpc('member_streaks', { p_today: today })).data ?? [];
const ms4 = ms1.find((r) => r.member_id === m4id);
check('담당 트레이너는 회원별 연속 기록을 봄', ms1.some((r) => r.member_id === m1id) && ms4?.current_streak === 3 && ms4?.today_logged === true, JSON.stringify(ms1));
const ms2 = (await t2.c.rpc('member_streaks', { p_today: today })).data ?? [];
check('비담당 트레이너에게는 그 회원 연속 기록이 안 보임', !ms2.some((r) => r.member_id === m4id) && ms2.every((r) => r.member_id === m2.user.id), JSON.stringify(ms2));
const msM = await m4.c.rpc('member_streaks', { p_today: today });
check('회원이 회원별 연속 기록을 부르면 빈 목록', !msM.error && (msM.data?.length ?? 0) === 0, JSON.stringify(msM.error ?? msM.data));
// 오늘·어제 기록을 지워 이틀을 비운다(미래 날짜로 묻지 않는다: 한국 자정~오전 9시엔 서버(UTC) 날짜와 하루 차이)
await m4.c.from('meals').delete().eq('member_id', m4id).in('eaten_on', [today, dk(-1)]);
const s3 = await streak(m4.c);
check('이틀 비면 연속이 끊김(최고 기록은 남음)', s3?.current === 0 && s3?.best === 3 && s3?.today_logged === false, JSON.stringify(s3));
await m4.c.from('meals').delete().eq('member_id', m4id);

// v1.4 식단 3단계 평가: 담당 트레이너만, 고르면 확인 완료·답변 대기 정리·회원에게 새 피드백
const rm1 = (await m1.c.from('meals').insert({ eaten_on: today, eaten_at: '13:00', meal_type: '점심', food: '평가 검증 식사', note: '양이 괜찮았나요?' }).select().single()).data;
const rAnon = await anon.rpc('rate_meal', { p_meal: rm1.id, p_rating: 1 });
check('로그인 안 한 사람은 평가 못 함', !!rAnon.error, rAnon.error?.code);
const rOther = await t2.c.rpc('rate_meal', { p_meal: rm1.id, p_rating: 1 });
check('비담당 트레이너는 평가 못 함(권한 때문에)', /not_allowed/.test(rOther.error?.message ?? ''), rOther.error?.message);
const rSelf = await m1.c.rpc('rate_meal', { p_meal: rm1.id, p_rating: 1 });
check('회원은 자기 식사를 평가 못 함', /not_allowed/.test(rSelf.error?.message ?? ''), rSelf.error?.message);
const rBad = await t1.c.rpc('rate_meal', { p_meal: rm1.id, p_rating: 4 });
check('세 단계 밖의 값 거부', /bad_rating/.test(rBad.error?.message ?? ''), rBad.error?.message);
const r1 = await t1.c.rpc('rate_meal', { p_meal: rm1.id, p_rating: 2 });
check('담당 트레이너가 평가', !r1.error && r1.data?.rating === 2, r1.error?.message);
const rRow = (await m1.c.from('meals').select('rating, rated_at, reviewed_at, trainer_msg_at, member_msg_at, member_seen_at').eq('id', rm1.id).single()).data;
check('평가하면 확인 완료·답변 대기 정리·회원 새 피드백 시각이 같이 기록됨',
  rRow?.rating === 2 && !!rRow.rated_at && rRow.reviewed_at === rRow.rated_at && rRow.trainer_msg_at === rRow.rated_at
  && Date.parse(rRow.reviewed_at) >= Date.parse(rRow.member_msg_at) && Date.parse(rRow.rated_at) > Date.parse(rRow.member_seen_at), JSON.stringify(rRow));
const rUpdM = await m1.c.from('meals').update({ rating: 1 }).eq('id', rm1.id).select();
check('회원이 평가를 직접 바꾸는 것 거부', !!rUpdM.error || (rUpdM.data?.length ?? 0) === 0, rUpdM.error?.code);
const rUpdT = await t1.c.from('meals').update({ rating: 1 }).eq('id', rm1.id).select();
check('트레이너도 표를 직접 고쳐 평가할 수 없음(함수로만)', !!rUpdT.error || (rUpdT.data?.length ?? 0) === 0, rUpdT.error?.code);
const rInsF = await m1.c.from('meals').insert({ eaten_on: today, eaten_at: '13:00', meal_type: '점심', food: 'x', rating: 1 });
check('회원이 평가를 넣어 등록하는 것 거부', !!rInsF.error);
await new Promise((r) => setTimeout(r, 20));
const r2 = await t1.c.rpc('rate_meal', { p_meal: rm1.id, p_rating: 1 });
const rRow2 = (await t1.c.from('meals').select('rating, rated_at').eq('id', rm1.id).single()).data;
check('평가를 바꾸면 새 값·새 시각', !r2.error && rRow2?.rating === 1 && Date.parse(rRow2.rated_at) > Date.parse(rRow.rated_at), JSON.stringify(rRow2));
check('다른 트레이너의 회원에게는 평가가 안 보임', ((await m2.c.from('meals').select('rating').eq('id', rm1.id)).data?.length ?? 0) === 0);
await m1.c.from('meals').delete().eq('id', rm1.id);

// v1.4 인바디: 회원 본인만 쓰고, 담당 트레이너는 읽기만. 사진·원문 칸 없음
const ib = { measured_on: dk(-10), weight_kg: 69.0, smm_kg: 30.0, pbf_pct: 22.6, source: 'ocr' };
const ib1 = await m1.c.from('inbody_records').insert({ member_id: m1id, ...ib }).select().single();
check('회원이 자기 인바디를 기록', !ib1.error, ib1.error?.message);
check('인바디 행에 사진·원문 칸이 없음', !!ib1.data && !Object.keys(ib1.data).some((k) => /photo|image|text|raw|path/i.test(k)), Object.keys(ib1.data ?? {}).join(','));
const ibOther = await m2.c.from('inbody_records').insert({ member_id: m1id, ...ib, measured_on: dk(-9) });
check('남의 인바디를 대신 기록 못 함', !!ibOther.error);
const ibT = await t1.c.from('inbody_records').insert({ member_id: m1id, ...ib, measured_on: dk(-8) });
check('트레이너는 인바디를 기록 못 함', !!ibT.error);
const ibDup = await m1.c.from('inbody_records').insert({ member_id: m1id, ...ib });
check('같은 날짜 기록은 하나만(중복 거부)', ibDup.error?.code === '23505', ibDup.error?.code);
const ibFuture = await m1.c.from('inbody_records').insert({ member_id: m1id, ...ib, measured_on: dk(5) });
check('앞날짜 측정일 거부', /future_date/.test(ibFuture.error?.message ?? ''), ibFuture.error?.message);
const ibRange = await m1.c.from('inbody_records').insert({ member_id: m1id, ...ib, measured_on: dk(-7), weight_kg: 5 });
check('터무니없는 체중 거부', !!ibRange.error);
const ibRead = async (c) => (await c.from('inbody_records').select('id').eq('member_id', m1id)).data?.length ?? -1;
check('담당 트레이너는 회원 인바디를 읽음', (await ibRead(t1.c)) === 1);
check('다른 트레이너는 못 읽음', (await ibRead(t2.c)) === 0);
check('다른 회원은 못 읽음', (await ibRead(m2.c)) === 0);
check('로그인 안 한 사람은 못 읽음', (await ibRead(anon)) <= 0);
const ibTUpd = await t1.c.from('inbody_records').update({ weight_kg: 50 }).eq('id', ib1.data.id).select();
check('트레이너는 회원 인바디를 못 고침', !!ibTUpd.error || (ibTUpd.data?.length ?? 0) === 0);
const ibTDel = await t1.c.from('inbody_records').delete().eq('id', ib1.data.id).select();
check('트레이너는 회원 인바디를 못 지움', !!ibTDel.error || (ibTDel.data?.length ?? 0) === 0);
const ibMove = await m1.c.from('inbody_records').update({ member_id: m2.user.id }).eq('id', ib1.data.id).select();
check('인바디를 다른 회원 것으로 옮기지 못함', !!ibMove.error || (ibMove.data?.length ?? 0) === 0);
const ibUpd = await m1.c.from('inbody_records').update({ weight_kg: 68.5, source: 'manual' }).eq('id', ib1.data.id).select().single();
check('회원은 자기 인바디를 고침', !ibUpd.error && Number(ibUpd.data?.weight_kg) === 68.5, ibUpd.error?.message);
const ibDel = await m1.c.from('inbody_records').delete().eq('id', ib1.data.id).select();
check('회원은 자기 인바디를 지움', !ibDel.error && ibDel.data?.length === 1, ibDel.error?.message);

// v1.4 결산: 기간 안 식단 기록·평가를 서버에서 센다(회원 본인·담당 트레이너만)
const rmeals = (await m1.c.from('meals').insert([
  { eaten_on: dk(-20), eaten_at: '08:00', meal_type: '아침', food: '결산1', note: '' },
  { eaten_on: dk(-20), eaten_at: '12:00', meal_type: '점심', food: '결산2', note: '' },
  { eaten_on: dk(-15), eaten_at: '12:00', meal_type: '점심', food: '결산3', note: '' },
  { eaten_on: dk(-11), eaten_at: '19:00', meal_type: '저녁', food: '결산4', note: '' },
  { eaten_on: dk(-5), eaten_at: '19:00', meal_type: '저녁', food: '기간 밖', note: '' },
]).select('id, food')).data ?? [];
const rid = (f) => rmeals.find((x) => x.food === f).id;
await t1.c.rpc('rate_meal', { p_meal: rid('결산1'), p_rating: 1 });
await t1.c.rpc('rate_meal', { p_meal: rid('결산2'), p_rating: 1 });
await t1.c.rpc('rate_meal', { p_meal: rid('결산3'), p_rating: 2 });
await t1.c.rpc('rate_meal', { p_meal: rid('기간 밖'), p_rating: 3 });
const rep = await m1.c.rpc('diet_report', { p_member: m1id, p_from: dk(-20), p_to: dk(-11) });
check('결산 계산(10일·3일 기록·4끼·평가 3끼·5점 만점 평균 4.3·기간 밖 제외)',
  !rep.error && rep.data?.days === 10 && rep.data.logged_days === 3 && rep.data.meals === 4 && rep.data.great === 2 && rep.data.good === 1 && rep.data.care === 0 && rep.data.rated === 3 && rep.data.score === 4.3,
  JSON.stringify(rep.error ?? rep.data));
const repT = await t1.c.rpc('diet_report', { p_member: m1id, p_from: dk(-20), p_to: dk(-11) });
check('담당 트레이너도 결산을 봄(같은 값)', !repT.error && repT.data?.score === 4.3, repT.error?.message);
const repT2 = await t2.c.rpc('diet_report', { p_member: m1id, p_from: dk(-20), p_to: dk(-11) });
check('비담당 트레이너는 결산을 못 봄', /not_allowed/.test(repT2.error?.message ?? ''), repT2.error?.message);
const repM2 = await m2.c.rpc('diet_report', { p_member: m1id, p_from: dk(-20), p_to: dk(-11) });
check('다른 회원은 결산을 못 봄', /not_allowed/.test(repM2.error?.message ?? ''), repM2.error?.message);
const repAnon = await anon.rpc('diet_report', { p_member: m1id, p_from: dk(-20), p_to: dk(-11) });
check('로그인 안 한 사람은 결산을 못 부름', !!repAnon.error, repAnon.error?.code);
const repBad = await m1.c.rpc('diet_report', { p_member: m1id, p_from: dk(-11), p_to: dk(-20) });
check('거꾸로 된 기간 거부', /bad_range/.test(repBad.error?.message ?? ''), repBad.error?.message);
const repNone = await m1.c.rpc('diet_report', { p_member: m1id, p_from: dk(-40), p_to: dk(-30) });
check('기록 없는 기간은 0끼·점수 없음', repNone.data?.meals === 0 && repNone.data?.score === null, JSON.stringify(repNone.data));
await m1.c.from('meals').delete().in('id', rmeals.map((x) => x.id));

// v1.6 닉네임 바꾸기: 로그인 아이디(내부 주소)까지 함께 바뀐다. 지금 PIN 확인
const n5 = `zz검증M5${run}`, n5b = `zz검증N5${run}`;
const m5 = await signUp(n5, { role: 'member', trainer_id: t1id });
const nickCall = (c, nick, pin) => c.rpc('change_my_nickname', { p_new_nickname: nick, p_current_pin: pin });
const nAnon = await nickCall(anon, n5b, '123456');
check('로그인 안 한 사람은 닉네임을 못 바꿈', !!nAnon.error, nAnon.error?.code);
check('PIN이 틀리면 거부', (await nickCall(m5.c, n5b, '000000')).data?.status === 'wrong');
check('규칙에 안 맞는 닉네임(1자) 거부', (await nickCall(m5.c, 'z', '123456')).data?.status === 'invalid');
check('이미 쓰는 닉네임(대소문자 달라도) 거부', (await nickCall(m5.c, nT1.toUpperCase(), '123456')).data?.status === 'taken');
check('지금과 같은 닉네임은 그대로', (await nickCall(m5.c, n5, '123456')).data?.status === 'same');
const nOk = await nickCall(m5.c, `  ${n5b}  `, '123456');
check('닉네임 바꾸기(앞뒤 공백 정리)', nOk.data?.status === 'ok' && nOk.data?.nickname === n5b, JSON.stringify(nOk.error ?? nOk.data));
const loginWith = async (nick) => !(await client().auth.signInWithPassword({ email: await emailOf(nick), password: '123456' })).error;
check('새 닉네임으로 로그인됨', await loginWith(n5b));
check('옛 닉네임으로는 로그인 안 됨', !(await loginWith(n5)));
check('바꾼 기기의 지금 세션은 그대로', !(await m5.c.rpc('my_security_status')).error);
const seenByTrainer = (await t1.c.from('profiles').select('nickname').eq('id', m5.user.id).maybeSingle()).data?.nickname;
check('담당 트레이너에게 새 닉네임이 보임', seenByTrainer === n5b, String(seenByTrainer));
check('옛 닉네임은 다시 가입·사용 가능(중복 아님)', (await anon.rpc('nickname_taken', { p_nickname: n5 })).data === false);
// 다른 기기에 남은 기억값을 맞출 때 쓰는 '내 예전 닉네임' 확인(Codex v1.6 리뷰)
const former = (c, nick) => c.rpc('is_my_former_nickname', { p_nickname: nick });
check('로그인 안 한 사람은 예전 닉네임 확인을 못 부름', !!(await former(anon, n5)).error);
check('본인의 예전 닉네임이면 참(대소문자·앞뒤 공백 무시)', (await former(m5.c, ` ${n5.toUpperCase()} `)).data === true);
check('본인 것이 아닌 이름은 거짓', (await former(m5.c, nT1)).data === false && (await former(m5.c, `zz검증없음${run}`)).data === false);
check('다른 사람이 물으면 거짓', (await former(t1.c, n5)).data === false);
const nCase = await nickCall(m5.c, n5b.toUpperCase(), '123456');
check('대소문자만 바꿔도 되고, 어느 표기로도 로그인됨', nCase.data?.status === 'ok' && (await loginWith(n5b)) && (await loginWith(n5b.toUpperCase())), JSON.stringify(nCase.data));
if (/127\.0\.0\.1|localhost/.test(URL)) {
  const { execSync } = await import('node:child_process');
  const ev = execSync(`supabase db query --local "select count(*) as n from private.security_events where kind = 'nickname_changed' and user_id = '${m5.user.id}';"`, { encoding: 'utf8' });
  check('보안 기록 테이블에 닉네임 변경 2건', /"n":\s*2/.test(ev), ev.replace(/\s+/g, ' ').slice(0, 120));
}
const adNick = await ad.c.rpc('admin_security_events');
check('운영자 조회 결과에 닉네임 변경 2건', (adNick.data ?? []).filter((e) => e.kind === 'nickname_changed' && e.nickname === n5b.toUpperCase()).length === 2, JSON.stringify(adNick.error ?? adNick.data?.slice(0, 3)));
check('트레이너·회원은 닉네임 변경 기록도 못 봄', ((await t1.c.rpc('admin_security_events')).data?.length ?? 0) === 0 && ((await m5.c.rpc('admin_security_events')).data?.length ?? 0) === 0);
// 예전 이름을 이제 다른 사람이 쓰면 그 사람의 기억값일 수 있으니 거짓
const m6 = await signUp(n5, { role: 'member', trainer_id: t1id });
check('예전 닉네임으로 다른 사람이 가입 가능', !m6.error, m6.error?.message);
check('예전 닉네임을 지금 다른 사람이 쓰면 거짓', (await former(m5.c, n5)).data === false);

// v1.7 알림 모아보기: 최근 1주일, 회원은 트레이너 평가·답글 / 트레이너는 담당 회원의 기록·말. 원문은 돌려주지 않는다
{
  const tX = await signUp(`zz검증활T${run}`, { role: 'trainer', trainer_code: CODE });
  const mX = await signUp(`zz검증활M${run}`, { role: 'member', trainer_id: tX.user.id });
  const tY = await signUp(`zz검증활U${run}`, { role: 'trainer', trainer_code: CODE });
  const mY = await signUp(`zz검증활N${run}`, { role: 'member', trainer_id: tY.user.id });
  const mealX = (await mX.c.from('meals').insert({ eaten_on: dk(0), eaten_at: '12:00', meal_type: '점심', food: '비밀 음식', note: '비밀 한마디' }).select('id').single()).data.id;
  await mX.c.from('comments').insert({ meal_id: mealX, body: '비밀 질문' });
  const mealY = (await mY.c.from('meals').insert({ eaten_on: dk(0), eaten_at: '12:00', meal_type: '점심', food: '다른 회원 음식', note: '' }).select('id').single()).data.id;
  await tX.c.rpc('rate_meal', { p_meal: mealX, p_rating: 1 });
  await tX.c.from('comments').insert({ meal_id: mealX, body: '비밀 답글' });
  const actT = (await tX.c.rpc('my_activity', {})).data ?? [];
  const kindsT = actT.map((a) => a.kind).sort().join(',');
  check('트레이너 알림 목록: 담당 회원의 기록(한마디 포함)·말', kindsT === 'question,recorded_note' && actT.every((a) => a.meal_id === mealX && a.actor === `zz검증활M${run}`), JSON.stringify(actT));
  check('다른 트레이너 회원의 소식은 안 보임', !actT.some((a) => a.meal_id === mealY));
  const actM = (await mX.c.rpc('my_activity', {})).data ?? [];
  check('회원 알림 목록: 트레이너의 평가·답글', actM.map((a) => a.kind).sort().join(',') === 'rated,replied' && actM.every((a) => a.actor === `zz검증활T${run}`), JSON.stringify(actM));
  check('알림 목록에 식단·댓글 원문 없음', !JSON.stringify([...actT, ...actM]).includes('비밀'));
  // v1.8: 소식마다 알림 목록 밖에서 이미 확인했는지(handled)
  check('트레이너가 평가(확인 처리)한 식사의 기록·질문은 확인함', actT.every((a) => a.handled === true), JSON.stringify(actT.map((a) => [a.kind, a.handled])));
  check('회원이 아직 안 읽은 평가·답글은 확인 전', actM.every((a) => a.handled === false), JSON.stringify(actM.map((a) => [a.kind, a.handled])));
  await mX.c.rpc('mark_seen', { p_meal: mealX });
  const actM2 = (await mX.c.rpc('my_activity', {})).data ?? [];
  check('회원이 피드백 탭에서 그 식사를 읽으면 평가·답글 소식도 확인함', actM2.length === 2 && actM2.every((a) => a.handled === true), JSON.stringify(actM2.map((a) => [a.kind, a.handled])));
  const mealX2 = (await mX.c.from('meals').insert({ eaten_on: dk(0), eaten_at: '18:00', meal_type: '저녁', food: '비밀 음식2', note: '' }).select('id').single()).data.id;
  const recX2 = ((await tX.c.rpc('my_activity', {})).data ?? []).find((a) => a.meal_id === mealX2);
  check('트레이너가 아직 확인하지 않은 기록은 확인 전', recX2?.handled === false, JSON.stringify(recX2));
  await tX.c.rpc('mark_reviewed', { p_meal: mealX2 });
  check('확인 목록에서 확인하면 그 기록 소식도 확인함', ((await tX.c.rpc('my_activity', {})).data ?? []).find((a) => a.meal_id === mealX2)?.handled === true);
  check('다른 회원의 소식은 안 보임', ((await mY.c.rpc('my_activity', {})).data ?? []).length === 0);
  check('로그인 안 한 사람은 알림 목록 못 봄', !!(await anon.rpc('my_activity', {})).error);
  const seenOf = async () => (await mX.c.from('activity_seen').select('seen_at').eq('user_id', mX.user.id).maybeSingle()).data?.seen_at;
  await mX.c.rpc('mark_activity_seen', { p_through: actM[0].at });
  check('읽음은 보여 준 가장 새 소식 시각까지', Date.parse(await seenOf()) === Date.parse(actM[0].at));
  await mX.c.rpc('mark_activity_seen', { p_through: '2000-01-01T00:00:00Z' });
  check('읽음 시각은 뒤로 돌아가지 않음', Date.parse(await seenOf()) === Date.parse(actM[0].at));
  await mX.c.rpc('mark_activity_seen', { p_through: '2999-01-01T00:00:00Z' });
  check('읽음 시각은 지금보다 앞으로 가지 않음', Date.parse(await seenOf()) <= Date.now() + 5000);
  check('남의 목록 연 시각은 못 읽음', ((await mY.c.from('activity_seen').select('user_id').eq('user_id', mX.user.id)).data ?? []).length === 0);
  check('목록 연 시각을 직접 고치지 못함', !!(await mX.c.from('activity_seen').upsert({ user_id: mX.user.id, seen_at: '2000-01-01T00:00:00Z' })).error);
  // 쪽 나누기: 같은 시각에 63건이 생겨도 50건 + 13건으로 끝까지, 빠지거나 겹치지 않게(Codex v1.7 리뷰 3)
  const tZ = await signUp(`zz검증활Z${run}`, { role: 'trainer', trainer_code: CODE });
  const mZ = await signUp(`zz검증활W${run}`, { role: 'member', trainer_id: tZ.user.id });
  const bulk = await mZ.c.from('meals').insert(Array.from({ length: 63 }, (_, i) => ({ eaten_on: dk(0), eaten_at: `${String(6 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`, meal_type: '간식', food: `간식 ${i}`, note: '' })));
  check('같은 시각 식사 63건 만들기', !bulk.error, bulk.error?.message);
  const p1 = (await tZ.c.rpc('my_activity', { p_limit: 50 })).data ?? [];
  const lastOf = p1[p1.length - 1];
  const p2 = (await tZ.c.rpc('my_activity', { p_limit: 50, p_before_at: lastOf?.at, p_before_key: lastOf?.key })).data ?? [];
  const keys = new Set([...p1, ...p2].map((a) => a.key));
  check('알림 목록 쪽 나누기: 50건 + 13건, 같은 시각이어도 빠짐·겹침 없음', p1.length === 50 && p2.length === 13 && keys.size === 63, `${p1.length}+${p2.length}, 서로 다른 ${keys.size}`);
  const lastOf2 = p2[p2.length - 1];
  check('마지막 쪽 다음은 빈 목록', ((await tZ.c.rpc('my_activity', { p_limit: 50, p_before_at: lastOf2?.at, p_before_key: lastOf2?.key })).data ?? []).length === 0);
  check('다른 트레이너 목록에는 섞이지 않음', !((await tX.c.rpc('my_activity', { p_limit: 100 })).data ?? []).some((a) => keys.has(a.key)));
  if (/127\.0\.0\.1|localhost/.test(URL)) {
    const { execSync } = await import('node:child_process');
    execSync(`supabase db query --local "update public.meals set created_at = now() - interval '8 days', note_updated_at = now() - interval '8 days' where id = '${mealX}'"`, { stdio: 'ignore' });
    execSync(`supabase db query --local "update public.comments set created_at = now() - interval '8 days' where meal_id = '${mealX}'"`, { stdio: 'ignore' });
    check('1주일 지난 소식은 목록에서 빠짐', !((await tX.c.rpc('my_activity', {})).data ?? []).some((a) => a.meal_id === mealX));
  }
}

// ─── v1.8: 한마디 좋아요 · 이달의 식단왕 · 공유 식단 · 담당에서 내보내기 ───
{
  const tS = await signUp(`zz검증소T${run}`, { role: 'trainer', trainer_code: CODE });
  const tO = await signUp(`zz검증소O${run}`, { role: 'trainer', trainer_code: CODE });
  const mA = await signUp(`zz검증소A${run}`, { role: 'member', trainer_id: tS.user.id });
  const mB = await signUp(`zz검증소B${run}`, { role: 'member', trainer_id: tS.user.id });
  const mC = await signUp(`zz검증소C${run}`, { role: 'member', trainer_id: tS.user.id });
  const mO = await signUp(`zz검증소M${run}`, { role: 'member', trainer_id: tO.user.id });
  const d0 = dk(0);
  // 좋아요
  check('한마디가 없으면 좋아요 거부', !!(await mA.c.rpc('set_message_like', { p_day: d0, p_on: true })).error);
  await tS.c.rpc('set_trainer_message', { p_day: d0, p_body: '오늘도 물 2리터!' });
  check('담당 회원이 한마디에 좋아요', !(await mA.c.rpc('set_message_like', { p_day: d0, p_on: true })).error);
  check('두 번 눌러도 한 번만', !(await mA.c.rpc('set_message_like', { p_day: d0, p_on: true })).error);
  check('내 좋아요는 읽힘', ((await mA.c.from('trainer_message_likes').select('day').eq('day', d0)).data ?? []).length === 1);
  check('다른 회원의 좋아요는 못 읽음', ((await mB.c.from('trainer_message_likes').select('day')).data ?? []).length === 0);
  check('좋아요 행을 직접 못 넣음', !!(await mB.c.from('trainer_message_likes').insert({ trainer_id: tS.user.id, day: d0, member_id: mB.user.id })).error);
  const likers = (await tS.c.rpc('message_likers', { p_day: d0 })).data ?? [];
  check('트레이너는 누른 회원 이름을 봄', likers.length === 1 && likers[0].nickname === `zz검증소A${run}`, JSON.stringify(likers));
  check('다른 트레이너는 못 봄', ((await tO.c.rpc('message_likers', { p_day: d0 })).data ?? []).length === 0);
  check('다른 트레이너 회원은 이 한마디에 못 누름(자기 트레이너 한마디가 없음)', !!(await mO.c.rpc('set_message_like', { p_day: d0, p_on: true })).error);
  const likedAct = ((await tS.c.rpc('my_activity', {})).data ?? []).filter((a) => a.kind === 'liked');
  check('트레이너 알림 목록에 좋아요 소식(식사 없음)', likedAct.length === 1 && likedAct[0].meal_id === null && likedAct[0].actor === `zz검증소A${run}`, JSON.stringify(likedAct));
  await mA.c.rpc('set_message_like', { p_day: d0, p_on: false });
  check('좋아요 취소', ((await tS.c.rpc('message_likers', { p_day: d0 })).data ?? []).length === 0);
  await mA.c.rpc('set_message_like', { p_day: d0, p_on: true });
  check('비로그인은 좋아요 못 함', !!(await client().rpc('set_message_like', { p_day: d0, p_on: true })).error);

  // 이달의 식단왕: A = 여러 날 연속(평가 낮음), B = 오늘 10끼(평가 높음), C = 9끼(후보 아님)
  const dom = new Date().getDate();
  const span = Math.min(dom, 5);
  const ins = async (m, n, dayOf, food) => (await m.c.from('meals').insert(Array.from({ length: n }, (_, i) => ({ eaten_on: dayOf(i), eaten_at: `${String(6 + (i % 12)).padStart(2, '0')}:00`, meal_type: '간식', food, note: '' }))).select('id')).data ?? [];
  const aMeals = await ins(mA, 10, (i) => dk(-(i % span)), '식단왕 A');
  const bMeals = await ins(mB, 10, () => d0, '식단왕 B');
  await ins(mC, 9, () => d0, '식단왕 C');
  for (const x of aMeals) await tS.c.rpc('rate_meal', { p_meal: x.id, p_rating: 3 });
  for (const x of bMeals) await tS.c.rpc('rate_meal', { p_meal: x.id, p_rating: 1 });
  // v1.8의 실시간 식단왕(monthly_kings)은 2.0에서 없앴다 — 달 마감 뒤 확정·공개 검증은 아래 '이달의 식단왕·운동왕'

  // 공유 식단
  const sid = webcrypto.randomUUID();
  const spath = `${mA.user.id}/${sid}.jpg`;
  await putPhoto(mA.c, spath);
  await mA.c.from('meals').insert({ id: sid, eaten_on: d0, eaten_at: '12:00', meal_type: '점심', food: '공유 검증 샐러드', note: '비밀 메모', photo_path: spath });
  const canSign = async (c) => !(await c.storage.from('meal-photos').createSignedUrl(spath, 60)).error;
  // 공유 사진은 서버 기능이 요청마다 권한을 확인해 내려준다(서명 주소 없음)
  const fetchPhoto = (c, id = sid) => photoVia(c, id);
  const sharedOf = async (c) => (await c.rpc('shared_meals', {})).data ?? [];
  check('동의 전에는 공유 거부', !!(await tS.c.rpc('share_meal', { p_meal: sid, p_on: true })).error);
  check('회원이 공유 칸을 직접 못 고침', !!(await mA.c.from('meals').update({ shared_at: new Date().toISOString() }).eq('id', sid)).error);
  check('공유 전 다른 회원은 사진 못 읽음', !(await canSign(mB.c)));
  check('회원이 공유 동의', !(await mA.c.rpc('set_share_consent', { p_on: true })).error);
  check('다른 트레이너는 공유 못 함', !!(await tO.c.rpc('share_meal', { p_meal: sid, p_on: true })).error);
  check('담당 트레이너가 공유', !(await tS.c.rpc('share_meal', { p_meal: sid, p_on: true })).error);
  const sB = await sharedOf(mB.c);
  check('같은 트레이너 회원에게 보임', sB.some((x) => x.id === sid && x.mine === false));
  check('닉네임은 보이고 남긴 말·회원 id는 없음', sB.every((x) => !('note' in x) && !('member_id' in x) && !JSON.stringify(x).includes('비밀 메모')) && sB.find((x) => x.id === sid)?.nickname.includes('zz검증'), JSON.stringify(sB[0]));
  check('닉네임 공개를 끔', !(await mA.c.rpc('set_award_public', { p_on: false })).error);
  const anonB = (await sharedOf(mB.c)).find((x) => x.id === sid), anonA = (await sharedOf(mA.c)).find((x) => x.id === sid);
  check("끄면 다른 사람에게는 '익명 회원', 본인에게는 자기 닉네임", anonB?.nickname === '익명 회원' && anonA?.nickname.includes('zz검증'), JSON.stringify([anonB?.nickname, anonA?.nickname]));
  await mA.c.rpc('set_award_public', { p_on: true });
  check('본인에게는 내 식단으로 보임', (await sharedOf(mA.c)).some((x) => x.id === sid && x.mine === true));
  check('공유된 사진은 같은 트레이너 회원이 서버 기능으로 받음', await fetchPhoto(mB.c));
  check('공유된 사진이라도 남의 사진 서명 주소는 못 만듦(철회 뒤 남는 주소 없음)', !(await canSign(mB.c)));
  check('다른 트레이너 회원에게는 안 보임', !(await sharedOf(mO.c)).some((x) => x.id === sid) && !(await fetchPhoto(mO.c)));
  check('비로그인은 공유 사진 못 받음', !(await fetchPhoto(client())));
  check('비로그인은 공유 목록 못 봄', !!(await client().rpc('shared_meals', {})).error);
  await mA.c.rpc('set_share_consent', { p_on: false });
  check('동의를 끄면 바로 사라짐(사진도 바로 거부)', !(await sharedOf(mB.c)).some((x) => x.id === sid) && !(await fetchPhoto(mB.c)));
  check('동의를 끄면 공유 표시도 풀림', (await tS.c.from('meals').select('shared_at').eq('id', sid).single()).data?.shared_at === null);
  // 사진 경로 바꿔치기(Codex v1.8.0 리뷰 1): B의 공유 식사 경로를 A의 사진으로 바꿔 A의 철회를 우회하지 못함
  const bid = webcrypto.randomUUID();
  const bpath = `${mB.user.id}/${bid}.jpg`;
  await putPhoto(mB.c, bpath);
  await mB.c.from('meals').insert({ id: bid, eaten_on: d0, eaten_at: '13:00', meal_type: '점심', food: '공유 검증 B', note: '', photo_path: bpath });
  await mB.c.rpc('set_share_consent', { p_on: true });
  await tS.c.rpc('share_meal', { p_meal: bid, p_on: true });
  check('남의 폴더 사진 경로로 바꾸기 거부', !!(await mB.c.from('meals').update({ photo_path: spath }).eq('id', bid)).error);
  check('남의 폴더 사진 경로로 새 식사 거부', !!(await mB.c.from('meals').insert({ eaten_on: d0, eaten_at: '14:00', meal_type: '간식', food: '경로 검증', note: '', photo_path: spath })).error);
  check('철회한 회원 사진은 바꿔치기 시도 뒤에도 거부(B 자기 공유 사진은 그대로)', !(await fetchPhoto(mB.c, sid)) && (await fetchPhoto(mB.c, bid)));
  await removePhoto(bpath);
  await mA.c.rpc('set_share_consent', { p_on: true });
  await tS.c.rpc('share_meal', { p_meal: sid, p_on: true });
  // 이번 주 추천 식단(2026-10-30 사용자 결정): 공유한 때부터 7일만 목록·사진 권한. 다시 공유하면 다시 7일(로컬 DB에서 공유 시각을 옮겨 시험)
  if (/127\.0\.0\.1|localhost/.test(URL)) {
    const { execFileSync } = await import('node:child_process');
    const at = (ago) => execFileSync('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', `update public.meals set shared_at = now() - interval '${ago}' where id = '${sid}'`]);
    at('6 days 23 hours');
    check('공유 7일 안은 목록·사진 그대로', (await sharedOf(mB.c)).some((x) => x.id === sid) && (await fetchPhoto(mB.c)));
    at('7 days 1 minute');
    check('공유 7일이 지나면 목록에서 내려감', !(await sharedOf(mB.c)).some((x) => x.id === sid) && !(await sharedOf(tS.c)).some((x) => x.id === sid));
    check('7일 지난 공유는 다른 회원 사진 권한도 끊김', !(await fetchPhoto(mB.c)));
    check('7일 지나도 본인·담당 트레이너는 그 사진을 봄', (await fetchPhoto(mA.c)) && (await fetchPhoto(tS.c)));
    check('트레이너가 다시 공유하면 다시 보임', !(await tS.c.rpc('share_meal', { p_meal: sid, p_on: true })).error && (await sharedOf(mB.c)).some((x) => x.id === sid) && (await fetchPhoto(mB.c)));
  }

  // 담당에서 내보내기
  check('내보내기 전: 담당 트레이너는 서버 기능으로 사진을 받고, 서명 주소는 못 만듦', (await fetchPhoto(tS.c)) && !(await canSign(tS.c)));
  check('다른 트레이너는 못 내보냄', !!(await tO.c.rpc('remove_member', { p_member: mA.user.id })).error);
  check('회원은 자기를 못 내보냄', !!(await mA.c.rpc('remove_member', { p_member: mA.user.id })).error);
  check('담당 트레이너가 내보냄', !(await tS.c.rpc('remove_member', { p_member: mA.user.id })).error);
  check('내보낸 뒤 트레이너는 그 회원 사진을 새로 못 받음(남는 서명 주소 없음)', !(await fetchPhoto(tS.c)));
  check('회원은 자기 사진 주소를 그대로 받음', await canSign(mA.c));
  check('내보낸 뒤 트레이너는 기록을 못 봄', ((await tS.c.from('meals').select('id').eq('member_id', mA.user.id)).data ?? []).length === 0);
  check('회원 기록은 그대로', ((await mA.c.from('meals').select('id')).data ?? []).length === 11);
  check('내보낸 뒤 알림 목록·좋아요 명단에서 빠짐',
    !((await tS.c.rpc('my_activity', { p_limit: 100 })).data ?? []).some((a) => a.actor === `zz검증소A${run}`) &&
    ((await tS.c.rpc('message_likers', { p_day: d0 })).data ?? []).length === 0);
  check('내보낸 뒤 공유 식단에서 빠짐', !(await sharedOf(mB.c)).some((x) => x.id === sid) && !(await fetchPhoto(mB.c)));
  check('회원에게 담당 트레이너 없음', ((await mA.c.from('assignments').select('trainer_id')).data ?? []).length === 0);
  check('담당 없는 회원은 좋아요 못 함', !!(await mA.c.rpc('set_message_like', { p_day: d0, p_on: true })).error);
  const choices = (await mA.c.rpc('trainers_for_me')).data ?? [];
  check('고를 트레이너 목록에 내보낸 트레이너 없음', !choices.some((t) => t.id === tS.user.id) && choices.some((t) => t.id === tO.user.id));
  check('내보낸 트레이너는 다시 못 고름', !!(await mA.c.rpc('choose_trainer', { p_trainer: tS.user.id })).error);
  check('트레이너는 회원용 함수로 담당을 못 만듦', !!(await tO.c.rpc('choose_trainer', { p_trainer: tS.user.id })).error);
  check('다른 트레이너를 고름', !(await mA.c.rpc('choose_trainer', { p_trainer: tO.user.id })).error);
  check('담당이 있으면 또 못 고름', !!(await mA.c.rpc('choose_trainer', { p_trainer: tO.user.id })).error);
  // 좋아요 조회는 지금 담당 트레이너 기준(Codex v1.8.0 리뷰 6): 옛 트레이너 좋아요는 새 트레이너 한마디 좋아요가 아님
  check('트레이너를 바꾸면 옛 좋아요는 안 눌린 것으로', (await mA.c.rpc('my_message_like', { p_day: d0 })).data === false);
  await tO.c.rpc('set_trainer_message', { p_day: d0, p_body: '새 트레이너 한마디' });
  await mA.c.rpc('set_message_like', { p_day: d0, p_on: true });
  check('새 트레이너 한마디 좋아요(옛 행이 남아도 조회 성공)', (await mA.c.rpc('my_message_like', { p_day: d0 })).data === true);
  check('새 트레이너가 기록을 봄', ((await tO.c.from('meals').select('id').eq('member_id', mA.user.id)).data ?? []).length === 11);
  const evs = (await ad.c.rpc('admin_security_events')).data ?? [];
  check('운영자 보안 기록에 내보내기(누가 누구를)', evs.some((e) => e.kind === 'member_removed' && e.nickname === `zz검증소A${run}` && e.actor === `zz검증소T${run}`), JSON.stringify(evs.filter((e) => e.kind === 'member_removed')));
  check('비로그인은 내보내기·고르기 못 함', !!(await client().rpc('remove_member', { p_member: mB.user.id })).error && !!(await client().rpc('choose_trainer', { p_trainer: tS.user.id })).error);
  await removePhoto(spath);
}

// ─── v1.8.2: 피드백 탭 '모두 읽음' — 보여 준 식사들만, 보여 준 가장 늦은 피드백 시각까지 ───
{
  const tR = await signUp(`zz검증읽T${run}`, { role: 'trainer', trainer_code: CODE });
  const mR = await signUp(`zz검증읽M${run}`, { role: 'member', trainer_id: tR.user.id });
  const mX2 = await signUp(`zz검증읽X${run}`, { role: 'member', trainer_id: tR.user.id });
  const mk = async (c, food) => (await c.from('meals').insert({ eaten_on: dk(0), eaten_at: '12:00', meal_type: '점심', food, note: '' }).select('id').single()).data.id;
  const r1 = await mk(mR.c, '읽음 검증 1'), r2 = await mk(mR.c, '읽음 검증 2'), other = await mk(mX2.c, '남의 식사');
  await tR.c.rpc('rate_meal', { p_meal: r1, p_rating: 1 });
  await tR.c.rpc('rate_meal', { p_meal: r2, p_rating: 2 });
  await tR.c.rpc('rate_meal', { p_meal: other, p_rating: 2 });
  const rows = async (c, ids) => (await c.from('meals').select('id, rated_at, member_seen_at').in('id', ids)).data ?? [];
  const shown = await rows(mR.c, [r1, r2]);
  const through = shown.map((x) => x.rated_at).sort().pop();
  await new Promise((r) => setTimeout(r, 50));
  await tR.c.from('comments').insert({ meal_id: r2, body: '보여 준 뒤에 온 답글' });
  const lateAt = (await mR.c.from('comments').select('created_at').eq('meal_id', r2).order('created_at', { ascending: false }).limit(1).single()).data.created_at;
  const res = await mR.c.rpc('mark_seen_many', { p_meals: [r1, r2, other], p_through: through });
  check('모두 읽음 저장', !res.error && res.data === 2, JSON.stringify(res.error ?? res.data));
  const after = await rows(mR.c, [r1, r2]);
  check('보여 준 평가까지 읽음으로', after.every((x) => Date.parse(x.member_seen_at) >= Date.parse(x.rated_at)), JSON.stringify(after));
  check('보여 준 뒤에 온 답글은 새 피드백으로 남음', after.every((x) => Date.parse(x.member_seen_at) < Date.parse(lateAt)));
  const otherRow = (await rows(mX2.c, [other]))[0];
  check('남의 식사는 읽음으로 바뀌지 않음', Date.parse(otherRow.member_seen_at) < Date.parse(otherRow.rated_at));
  check('읽음 시각을 미래로 못 보냄', (await mR.c.rpc('mark_seen_many', { p_meals: [r1], p_through: '2999-01-01T00:00:00Z' })).error === null && Date.parse((await rows(mR.c, [r1]))[0].member_seen_at) <= Date.now() + 5000);
  check('빈 목록·501건은 거부', !!(await mR.c.rpc('mark_seen_many', { p_meals: [], p_through: through })).error && !!(await mR.c.rpc('mark_seen_many', { p_meals: Array.from({ length: 501 }, () => webcrypto.randomUUID()), p_through: through })).error);
  check('비로그인은 못 함', !!(await client().rpc('mark_seen_many', { p_meals: [r1], p_through: through })).error);
  const act = ((await mR.c.rpc('my_activity', {})).data ?? []).filter((a) => a.meal_id === r1 || a.meal_id === r2);
  check('알림 목록: 읽은 평가는 확인함, 뒤에 온 답글은 미확인', act.filter((a) => a.kind === 'rated').every((a) => a.handled) && act.some((a) => a.kind === 'replied' && !a.handled), JSON.stringify(act.map((a) => [a.kind, a.handled])));
}

// ─── v2.0 운동: 루틴(판) · 운동 기록 · 기간 요약 ───
{
  const tW = await signUp(`zz검증운T${run}`, { role: 'trainer', trainer_code: CODE });
  const tW2 = await signUp(`zz검증운U${run}`, { role: 'trainer', trainer_code: CODE });
  const mW = await signUp(`zz검증운M${run}`, { role: 'member', trainer_id: tW.user.id });
  const mW2 = await signUp(`zz검증운N${run}`, { role: 'member', trainer_id: tW.user.id });
  const items = [{ day_no: 1, name: '레그 프레스', weight: '60', reps: '12', sets: 3, rest: '1', note: '' }, { day_no: 2, name: '플랭크', weight: '', reps: '40초', sets: 3, rest: '', note: '' }];
  const r1 = await tW.c.rpc('save_routine', { p_member: mW.user.id, p_title: '하체와 코어', p_goal: '자세 지키기', p_reason: '', p_items: items, p_source: 'manual' });
  check('담당 트레이너가 루틴 등록', !r1.error && typeof r1.data === 'string', r1.error?.message);
  check('다른 트레이너는 루틴 등록 못 함', !!(await tW2.c.rpc('save_routine', { p_member: mW.user.id, p_title: 'x', p_goal: '', p_reason: '', p_items: items })).error);
  check('회원은 루틴을 직접 못 만듦', !!(await mW.c.rpc('save_routine', { p_member: mW.user.id, p_title: 'x', p_goal: '', p_reason: '', p_items: items })).error);
  check('빈 운동 목록은 거부', !!(await tW.c.rpc('save_routine', { p_member: mW.user.id, p_title: 'x', p_goal: '', p_reason: '', p_items: [] })).error);
  check('표에 직접 못 넣음', !!(await tW.c.from('routines').insert({ member_id: mW.user.id, version: 9, title: 'x' })).error);
  const rs = async (c, id) => (await c.from('routines').select('id, version, items:routine_items(id, name, ord)').eq('member_id', id).order('version')).data ?? [];
  const mine = await rs(mW.c, mW.user.id);
  check('회원은 자기 루틴을 봄(운동 2개)', mine.length === 1 && mine[0].items.length === 2);
  check('같은 트레이너의 다른 회원은 못 봄', (await rs(mW2.c, mW.user.id)).length === 0);
  check('다른 트레이너는 못 봄', (await rs(tW2.c, mW.user.id)).length === 0);
  const legItem = mine[0].items.find((i) => i.name === '레그 프레스').id;
  const sid = webcrypto.randomUUID();
  const sets = [{ item_id: legItem, name: '레그 프레스', set_no: 1, kg: 60, reps: 12, done: true }, { item_id: legItem, name: '레그 프레스', set_no: 2, kg: 60, reps: 10, done: false }];
  const w1 = await mW.c.rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: r1.data, p_sets: sets, p_finished: false, p_save_id: webcrypto.randomUUID() });
  check('회원이 운동 기록 저장(새 수정 시각을 돌려줌)', !w1.error && typeof w1.data === 'string', w1.error?.message);
  const save2 = webcrypto.randomUUID();
  const w2 = await mW.c.rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: r1.data, p_sets: [...sets, { item_id: null, name: '런지', set_no: 1, kg: null, reps: 10, done: true }], p_finished: false, p_base: w1.data, p_save_id: save2 });
  check('읽은 수정 시각으로 다시 저장(세트는 새 값으로)', !w2.error && w2.data !== w1.data, w2.error?.message);
  const w2again = await mW.c.rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: r1.data, p_sets: [], p_finished: false, p_base: w1.data, p_save_id: save2 });
  check('응답이 끊겨 같은 저장을 다시 보내도 한 번만(내용은 처음 것)', !w2again.error && w2again.data === w2.data);
  // 두 기기 덮어쓰기(Codex v2.0.0 1차 리뷰 3): 오래된 수정 시각으로 저장하면 거부하고 먼저 고친 내용을 지킨다
  const stale = await mW.c.rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: r1.data, p_sets: [{ item_id: null, name: '레그 프레스', set_no: 1, kg: 40, reps: 10, done: true }], p_finished: true, p_base: w1.data, p_save_id: webcrypto.randomUUID() });
  check('다른 기기가 먼저 고친 기록을 오래된 값으로 덮어쓰지 않음(conflict)', /conflict/.test(stale.error?.message ?? ''), stale.error?.message ?? 'ok');
  check('새 기록인 척(수정 시각 없이) 덮어쓰기도 거부', /conflict/.test((await mW.c.rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: null, p_sets: [], p_finished: false, p_save_id: webcrypto.randomUUID() })).error?.message ?? ''));
  const sess = (await mW.c.from('workout_sessions').select('id, sets:workout_sets(name, done)').eq('member_id', mW.user.id)).data ?? [];
  check('세션 1개·세트 3개', sess.length === 1 && sess[0].sets.length === 3, JSON.stringify(sess));
  // v2.1(사용자 피드백 11-02): 중량·횟수는 글자 — 기호('10+8'·'8+8'·'10/10')를 그대로, 옛 앱이 보내는 숫자(60.5)도 글자로 저장
  {
    const symId = webcrypto.randomUUID();
    const sym = await mW.c.rpc('save_workout', { p_session: symId, p_day: dk(0), p_routine: null, p_sets: [{ item_id: null, name: '덤벨컬+해머컬', set_no: 1, kg: '10+8', reps: '8+8', done: true }, { item_id: null, name: '런지', set_no: 1, kg: 60.5, reps: 12, done: true }, { item_id: null, name: '런지', set_no: 2, kg: ' ', reps: '10/10', done: false }], p_finished: false, p_save_id: webcrypto.randomUUID() });
    const got = (await mW.c.from('workout_sets').select('name, set_no, kg, reps').eq('session_id', symId).order('ord')).data ?? [];
    check('기호가 든 중량·횟수를 글자 그대로 저장(옛 앱 숫자는 글자로, 빈칸은 비움)', !sym.error && JSON.stringify(got.map((x) => [x.kg, x.reps])) === JSON.stringify([['10+8', '8+8'], ['60.5', '12'], [null, '10/10']]), JSON.stringify(sym.error?.message ?? got));
    const long = await mW.c.rpc('save_workout', { p_session: webcrypto.randomUUID(), p_day: dk(0), p_routine: null, p_sets: [{ item_id: null, name: '런지', set_no: 1, kg: 'x'.repeat(31), reps: '1', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() });
    check('31자 넘는 중량 글자는 거부', !!long.error);
    await mW.c.rpc('delete_workout', { p_session: symId });
  }
  check('남의 세션 id로 덮어쓰기 거부', !!(await mW2.c.rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: null, p_sets: [], p_finished: false })).error);
  check('남의 루틴을 붙여 저장 거부', !!(await mW2.c.rpc('save_workout', { p_session: webcrypto.randomUUID(), p_day: dk(0), p_routine: r1.data, p_sets: [], p_finished: false })).error);
  check('먼 날짜에 새 기록은 거부', /bad_day/.test((await mW.c.rpc('save_workout', { p_session: webcrypto.randomUUID(), p_day: dk(-30), p_routine: null, p_sets: [], p_finished: false })).error?.message ?? ''));
  // 이미 있는 옛 기록은 날짜와 관계없이 고칠 수 있다(리뷰 4) — 8일 전 기록(지난 날짜라 SQL로 넣음)
  if (/127\.0\.0\.1|localhost/.test(URL)) {
    const { execFileSync } = await import('node:child_process');
    const oldId = webcrypto.randomUUID();
    execFileSync('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', `insert into public.workout_sessions (id, member_id, day) values ('${oldId}', '${mW.user.id}', current_date - 8)`]);
    const oldRow = (await mW.c.from('workout_sessions').select('updated_at, day').eq('id', oldId).single()).data;
    const oldSave = await mW.c.rpc('save_workout', { p_session: oldId, p_day: dk(0), p_routine: null, p_sets: [{ item_id: null, name: '런지', set_no: 1, kg: 10, reps: 10, done: true }], p_finished: true, p_base: oldRow.updated_at, p_save_id: webcrypto.randomUUID() });
    const after = (await mW.c.from('workout_sessions').select('day').eq('id', oldId).single()).data;
    check('8일 전 기록도 고칠 수 있고 날짜는 그대로', !oldSave.error && after.day === oldRow.day, JSON.stringify([oldSave.error?.message, oldRow.day, after.day]));
    const gone = webcrypto.randomUUID();
    check('그사이 지워진 기록에 오래된 저장은 gone', /gone/.test((await mW.c.rpc('save_workout', { p_session: gone, p_day: dk(0), p_routine: null, p_sets: [], p_finished: false, p_base: oldRow.updated_at, p_save_id: webcrypto.randomUUID() })).error?.message ?? ''));
    await mW.c.rpc('delete_workout', { p_session: oldId });
  }
  check('담당 트레이너는 회원 운동 기록을 봄', ((await tW.c.from('workout_sessions').select('id').eq('member_id', mW.user.id)).data ?? []).length === 1);
  check('다른 트레이너·다른 회원은 못 봄', ((await tW2.c.from('workout_sessions').select('id').eq('member_id', mW.user.id)).data ?? []).length === 0 && ((await mW2.c.from('workout_sets').select('name')).data ?? []).length === 0);
  // v2.3.0 3차 리뷰 1번: 트레이너 화면의 회원 운동은 문장 하나로 받는다 — 표 조회와 같은 기록·같은 권한, 서버의 행 상한(1,000) 없이 한 시점의 전부
  {
    const mL = await signUp(`zz검증운동목록${run}`, { role: 'member', trainer_id: tW.user.id });
    const listOf = async (c, ids) => c.rpc('members_workouts', { p_members: ids, p_from: dk(-14) });
    const rest = async (id) => (await tW.c.from('workout_sessions').select('id, member_id, routine_id, day_no, day, started_at, updated_at, finished, source, sheet_tab, sheet_col, sets:workout_sets(item_id, name, set_no, kg, reps, done, ord), cardio:workout_cardio(kind, minutes, km, speed, ord)').eq('id', id).single()).data;
    const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
    const byOrd = (a, b) => a.ord - b.ord;
    const norm = (x) => stable({ ...x, started_at: Date.parse(x.started_at), updated_at: Date.parse(x.updated_at), sets: [...x.sets].sort(byOrd), cardio: [...x.cardio].sort(byOrd) });
    const one = (await listOf(tW.c, [mW.user.id])).data ?? [];
    const sameAsTable = one.length === 1 && JSON.stringify(norm(one[0])) === JSON.stringify(norm(await rest(one[0].id)));
    check('회원 운동 목록: 표 조회와 같은 칸·같은 값', sameAsTable, JSON.stringify([one[0], await rest(one[0]?.id)]));
    check('회원 운동 목록: 다른 트레이너·다른 회원은 빈 목록 · 로그인 전은 부를 수 없음', ((await listOf(tW2.c, [mW.user.id])).data ?? []).length === 0 && ((await listOf(mW2.c, [mW.user.id])).data ?? []).length === 0 && !!(await listOf(client(), [mW.user.id])).error);
    const { execFileSync: execL } = await import('node:child_process');
    execL('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-Atqc', `insert into public.workout_sessions (id, member_id, day, started_at) select gen_random_uuid(), '${mL.user.id}', '${dk(-1)}', timestamptz '${dk(-1)} 10:00:00+09' + (i / 3) * interval '1 second' from generate_series(1, 1205) i`], { encoding: 'utf8' });
    const big = (await listOf(tW.c, [mL.user.id])).data ?? [];
    const ordered = big.every((x, i) => !i || big[i - 1].started_at > x.started_at || (big[i - 1].started_at === x.started_at && big[i - 1].id > x.id));
    check('회원 운동 목록: 1,205개가 서버의 행 상한 없이 한 번에 · 같은 시각의 기록도 빠짐·겹침 없이 차례대로', big.length === 1205 && new Set(big.map((x) => x.id)).size === 1205 && ordered, String(big.length));
  }
  // 루틴을 고치면 새 판, 끝낸 기록은 옛 판을 가리킨 채 그대로
  const r2 = await tW.c.rpc('save_routine', { p_member: mW.user.id, p_title: '하체와 코어 2', p_goal: '', p_reason: '레그 프레스 중량 올림', p_items: [{ day_no: 1, name: '레그 프레스', weight: '65', reps: '12', sets: 4, rest: '1', note: '' }] });
  const after = await rs(mW.c, mW.user.id);
  const oldSess = (await mW.c.from('workout_sessions').select('routine_id, sets:workout_sets(name, kg)').eq('id', sid).single()).data;
  check('고친 루틴은 새 판(2), 옛 판도 남음', !r2.error && after.length === 2 && after[1].version === 2);
  check('고친 루틴이 끝낸 운동 기록을 바꾸지 않음', oldSess.routine_id === r1.data && oldSess.sets.some((x) => x.name === '레그 프레스' && Number(x.kg) === 60), JSON.stringify(oldSess));
  const sum = await mW.c.rpc('workout_summary', { p_member: mW.user.id, p_from: dk(-1), p_to: dk(0) });
  check('기간 요약: 완료 세트가 있는 날 1일·완료 세트 2', !sum.error && sum.data?.days === 1 && sum.data?.done_sets === 2, JSON.stringify(sum.error ?? sum.data));
  check('요약도 다른 트레이너는 못 봄', !!(await tW2.c.rpc('workout_summary', { p_member: mW.user.id, p_from: dk(-1), p_to: dk(0) })).error);
  // v2.1 유산소(사용자 피드백 11-02): 시간 필수·거리/속도는 필요에 따라, 유산소만 한 날도 운동한 날, 옛 앱(유산소 없이 저장)은 유산소를 지우지 않음
  {
    const cid = webcrypto.randomUUID();
    const c1 = await mW.c.rpc('save_workout', { p_session: cid, p_day: dk(-1), p_routine: null, p_sets: [], p_finished: true, p_save_id: webcrypto.randomUUID(), p_cardio: [{ kind: 'run', minutes: 30, km: 5 }, { kind: 'cycle', minutes: 20, speed: 24.5 }] });
    const rows = (await mW.c.from('workout_cardio').select('kind, minutes, km, speed').eq('session_id', cid).order('ord')).data ?? [];
    const num = (v) => (v === null ? null : Number(v));
    check('유산소 저장: 거리만 적은 것·속도만 적은 것', !c1.error && JSON.stringify(rows.map((r) => [r.kind, num(r.minutes), num(r.km), num(r.speed)])) === JSON.stringify([['run', 30, 5, null], ['cycle', 20, null, 24.5]]), JSON.stringify(c1.error?.message ?? rows));
    const s2 = await mW.c.rpc('workout_summary', { p_member: mW.user.id, p_from: dk(-1), p_to: dk(0) });
    check('유산소만 한 날도 운동한 날 · 유산소 횟수·시간·거리(적은 거리만 더함)', !s2.error && s2.data?.days === 2 && s2.data?.done_sets === 2 && s2.data?.cardio_count === 2 && Number(s2.data?.cardio_minutes) === 50 && Number(s2.data?.cardio_km) === 5, JSON.stringify(s2.error ?? s2.data));
    const oldApp = await mW.c.rpc('save_workout', { p_session: cid, p_day: dk(-1), p_routine: null, p_sets: [], p_finished: true, p_base: c1.data, p_save_id: webcrypto.randomUUID() });
    const cnt = async (c) => ((await c.c.from('workout_cardio').select('id').eq('session_id', cid)).data ?? []).length;
    check('옛 앱처럼 유산소 없이 다시 저장해도 유산소 유지', !oldApp.error && (await cnt(mW)) === 2, oldApp.error?.message);
    check('남의 유산소 기록은 못 봄 · 담당 트레이너는 봄', (await cnt(mW2)) === 0 && (await cnt(tW2)) === 0 && (await cnt(tW)) === 2);
    const bad = async (c) => /bad_cardio/.test((await mW.c.rpc('save_workout', { p_session: webcrypto.randomUUID(), p_day: dk(0), p_routine: null, p_sets: [], p_finished: true, p_save_id: webcrypto.randomUUID(), p_cardio: [c] })).error?.message ?? '');
    check('유산소 잘못된 값 거부(모르는 유형·시간 없음·0분·거리 0)', (await bad({ kind: 'yoga', minutes: 10 })) && (await bad({ kind: 'run' })) && (await bad({ kind: 'run', minutes: 0 })) && (await bad({ kind: 'run', minutes: 10, km: 0 })));
    const clear = await mW.c.rpc('save_workout', { p_session: cid, p_day: dk(-1), p_routine: null, p_sets: [], p_finished: false, p_base: oldApp.data, p_save_id: webcrypto.randomUUID(), p_cardio: [] });
    check('빈 유산소 목록으로 저장하면 지움', !clear.error && (await cnt(mW)) === 0, clear.error?.message);
    await mW.c.rpc('delete_workout', { p_session: cid });
  }
  check('남의 기록 삭제 거부', !!(await mW2.c.rpc('delete_workout', { p_session: sid })).error);
  check('비로그인은 운동 함수를 못 부름', !!(await client().rpc('save_workout', { p_session: sid, p_day: dk(0), p_routine: null, p_sets: [], p_finished: false })).error && !!(await client().rpc('workout_summary', { p_member: mW.user.id, p_from: dk(-1), p_to: dk(0) })).error);
  check('회원이 자기 기록 삭제', !(await mW.c.rpc('delete_workout', { p_session: sid })).error && ((await mW.c.from('workout_sets').select('name')).data ?? []).length === 0);
  {
    const walk = webcrypto.randomUUID();
    await mW.c.rpc('save_workout', { p_session: walk, p_day: dk(0), p_routine: null, p_sets: [], p_finished: true, p_save_id: webcrypto.randomUUID(), p_cardio: [{ kind: 'walk', minutes: 40 }] });
    const pr = await mW.c.rpc('my_award_progress', { p_today: dk(0) });
    check('이번 달 참여 현황: 유산소만 한 날도 운동한 날', !pr.error && pr.data?.workout_days === 1, JSON.stringify(pr.error ?? pr.data));
    await mW.c.rpc('delete_workout', { p_session: walk });
  }
  // 내보내면 트레이너는 루틴·기록을 더 못 봄
  await tW.c.rpc('remove_member', { p_member: mW2.user.id });
  await tW.c.rpc('remove_member', { p_member: mW.user.id });
  // 루틴 시트 연결: 링크만 넣으면 바로(확인 코드 없음, 2026-10-30 사용자 결정 — 링크 유출 위험 감수) · 회원 본인·담당 트레이너만 · 시트 하나는 회원 한 명에게만
  const tX = await signUp(`zz검증운X${run}`, { role: 'trainer', trainer_code: CODE });
  const mX3 = await signUp(`zz검증운Y${run}`, { role: 'member', trainer_id: tX.user.id });
  const mX4 = await signUp(`zz검증운Z${run}`, { role: 'member', trainer_id: tX.user.id });
  const SHEET = `https://docs.google.com/spreadsheets/d/zz${run}AAAAAAAAAAAAAAAAAAAAAAAA/edit#gid=1`;
  const link1 = await mX3.c.rpc('set_routine_sheet', { p_member: mX3.user.id, p_sheet: SHEET });
  check('회원 본인이 링크만으로 자기 시트 연결', !link1.error && link1.data?.status === 'ok', JSON.stringify(link1.error ?? link1.data));
  check('링크에서 시트 id만 저장', ((await mX3.c.from('routine_sources').select('sheet_id').single()).data?.sheet_id ?? '') === `zz${run}AAAAAAAAAAAAAAAAAAAAAAAA`);
  check('담당 트레이너도 회원 시트를 연결·바꿀 수 있음', (await tX.c.rpc('set_routine_sheet', { p_member: mX4.user.id, p_sheet: `zz${run}BBBBBBBBBBBBBBBBBBBBBBBB` })).data?.status === 'ok');
  const taken = await tX.c.rpc('set_routine_sheet', { p_member: mX4.user.id, p_sheet: SHEET });
  check('이미 다른 회원에게 연결된 시트는 거절(taken)·원래 연결 그대로', taken.data?.status === 'taken' && ((await mX3.c.from('routine_sources').select('sheet_id').single()).data?.sheet_id ?? '').startsWith(`zz${run}A`), JSON.stringify(taken.error ?? taken.data));
  const evTaken = ((await ad.c.rpc('admin_security_events')).data ?? []).filter((e) => e.kind === 'sheet_taken');
  check('운영자 보안 기록에 시트 가로채기 시도(대상 회원·시도한 사람)', evTaken.some((e) => e.nickname === `zz검증운Z${run}` && e.actor === `zz검증운X${run}`), JSON.stringify(evTaken));
  check('다른 회원 시트는 연결 못 함', !!(await mX4.c.rpc('set_routine_sheet', { p_member: mX3.user.id, p_sheet: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzz' })).error);
  check('다른 트레이너는 연결 못 함', !!(await tW2.c.rpc('set_routine_sheet', { p_member: mX3.user.id, p_sheet: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyy' })).error);
  check('시트가 아닌 글은 거부', /bad_sheet/.test((await mX3.c.rpc('set_routine_sheet', { p_member: mX3.user.id, p_sheet: 'not a sheet' })).error?.message ?? ''));
  check('읽기 자격: 본인·담당 트레이너만 시트 id를 받음', (await mX3.c.rpc('routine_sheet_for', { p_member: mX3.user.id })).data && (await tX.c.rpc('routine_sheet_for', { p_member: mX3.user.id })).data && !(await tW2.c.rpc('routine_sheet_for', { p_member: mX3.user.id })).data && !(await mX4.c.rpc('routine_sheet_for', { p_member: mX3.user.id })).data);
  const callSheet = async (c, member) => { const token = (await c.auth.getSession()).data.session?.access_token; return (await fetch(`${URL}/functions/v1/sheet-import`, { method: 'POST', headers: { apikey: KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ member }) })).status; };
  check('서버 기능: 다른 트레이너·다른 회원은 시트를 못 읽음(구글에 묻기 전에 거부)', (await callSheet(tW2.c, mX3.user.id)) === 403 && (await callSheet(mX4.c, mX3.user.id)) === 403);
  // 시트 자동 반영(2026-10-30 사용자 결정): 서버 기능이 읽고 해석해 바뀌었을 때만 새 판. 로컬에서는 가짜 시트 서버(scripts/fake-sheets.mjs)를 읽는다
  if (/127\.0\.0\.1|localhost/.test(URL)) {
    const { startFakeSheets, sheetRows } = await import('./fake-sheets.mjs');
    const fake = await startFakeSheets();
    fakeSheetLogs = fake.all;
    const sid3 = `zz${run}AAAAAAAAAAAAAAAAAAAAAAAA`;
    const sync = async (c, member, force = true) => { const token = (await c.auth.getSession()).data.session?.access_token; const r = await fetch(`${URL}/functions/v1/sheet-import`, { method: 'POST', headers: { apikey: KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ member, force }) }); return { code: r.status, body: await r.json().catch(() => ({})) }; };
    const versions = async () => ((await mX3.c.from('routines').select('version, title, source, source_ref, warmup, items:routine_items(day_no, name, weight)').order('version')).data ?? []);
    try {
      fake.set(sid3, { tabs: ['2610', '2611', '메모'], rows: sheetRows('12.5') });
      const s1 = await sync(mX3.c, mX3.user.id);
      const v1 = await versions();
      check('연결한 회원이 읽으면 바로 루틴 저장(가장 최근 달 탭 2611)', s1.code === 200 && s1.body.status === 'updated' && v1.length === 1 && v1[0].source === 'sheet' && v1[0].source_ref === '2611' && v1[0].title === '26년 11월 루틴', JSON.stringify([s1, v1.map((v) => v.title)]));
      check('해석: 필수 동작·일차·중량 글자 그대로', v1[0]?.warmup.includes('폼롤링') && v1[0]?.items.length === 3 && v1[0]?.items.some((i) => i.day_no === 2 && i.name === '스미스 머신 스퀏') && v1[0]?.items.some((i) => i.weight === '12.5'), JSON.stringify(v1[0]?.items));
      const s2 = await sync(tX.c, mX3.user.id);
      check('담당 트레이너가 다시 읽어도 바뀐 것이 없으면 새 판 없음', s2.body.status === 'same' && (await versions()).length === 1, JSON.stringify(s2));
      const s3 = await sync(mX3.c, mX3.user.id, false);
      check('1시간 안에는 화면을 열어도 다시 읽지 않음(fresh)', s3.body.status === 'fresh', JSON.stringify(s3));
      // v2.1: 첫 회차 중량만 바뀌면(앱이 기록을 써 넣은 것 포함) 새 판 없이 지금 판의 목표 중량만 고친다. 운동 구성이 바뀌면 새 판
      fake.set(sid3, { tabs: ['2610', '2611'], rows: sheetRows('15') });
      const s4 = await sync(tX.c, mX3.user.id);
      const v4 = await versions();
      check('중량만 바뀌면 새 판 없이 지금 판의 목표 중량만 고침', s4.body.status === 'same' && v4.length === 1 && v4[0].items.some((i) => i.weight === '15') && !v4[0].items.some((i) => i.weight === '12.5'), JSON.stringify([s4, v4.map((v) => v.items.map((i) => i.weight))]));
      const fiveSets = sheetRows('15').map((r) => (r[1] === '크록 로우' ? r.map((c, j) => (j === 2 ? '5' : c)) : r));
      fake.set(sid3, { tabs: ['2610', '2611'], rows: fiveSets });
      const s4b = await sync(tX.c, mX3.user.id);
      const v4b = await versions();
      check('세트가 바뀌면 새 판(직전 판은 비교용으로 남음)', s4b.body.status === 'updated' && v4b.length === 2 && v4b[1].items.some((i) => i.weight === '15'), JSON.stringify(s4b));
      fake.set(sid3, { noAccess: true });
      const s5 = await sync(mX3.c, mX3.user.id);
      const src5 = (await mX3.c.from('routine_sources').select('last_error').single()).data;
      check('공유가 풀리면 no_access·마지막 루틴 그대로·이유 기록', s5.code === 403 && s5.body.error === 'no_access' && (await versions()).length === 2 && src5?.last_error === 'no_access', JSON.stringify([s5, src5]));
      const s5b = await sync(mX3.c, mX3.user.id, false);
      check('읽지 못한 뒤에는 1시간 안이어도 화면을 열면 다시 읽어 봄', s5b.code === 403, JSON.stringify(s5b));
      fake.set(sid3, { tabs: ['2611'], rows: [['메모만 있는 탭']] });
      const s6 = await sync(mX3.c, mX3.user.id);
      check('운동이 없는 탭이면 no_items·마지막 루틴 그대로', s6.code === 422 && s6.body.error === 'no_items' && (await versions()).length === 2, JSON.stringify(s6));
      fake.set(sid3, { tabs: ['2611'], rows: fiveSets });
      const s7 = await sync(mX3.c, mX3.user.id);
      check('다시 공유되면 같은 내용은 새 판 없이 오류만 지움', s7.body.status === 'same' && (await versions()).length === 2 && (await mX3.c.from('routine_sources').select('last_error').single()).data?.last_error === '', JSON.stringify(s7));
      check('앱에서 저장 함수를 직접 못 부름(서버 기능만)', !!(await mX3.c.rpc('sheet_sync_save', { p_member: mX3.user.id, p_sheet: sid3, p_tab: 'x', p_title: 'x', p_warmup: '', p_items: [{ name: 'x' }], p_hash: 'h' })).error && !!(await tX.c.rpc('sheet_sync_save', { p_member: mX3.user.id, p_sheet: sid3, p_tab: 'x', p_title: 'x', p_warmup: '', p_items: [{ name: 'x' }], p_hash: 'h' })).error);
      check('다른 트레이너는 자동 반영도 못 부름', (await sync(tW2.c, mX3.user.id)).code === 403);

      // v2.1 시트의 회차 기록(사용자 피드백 11-02): 가져오기(그 달 탭은 자동 반영 때, 지난 탭은 '지난 기록 가져오기') · 앱 기록을 시트에 쓰기
      const mR = await signUp(`zz검증기R${run}`, { role: 'member', trainer_id: tX.user.id });
      const mR2 = await signUp(`zz검증기S${run}`, { role: 'member', trainer_id: tX.user.id });
      const sidR = `zz${run}RRRRRRRRRRRRRRRRRRRRRRRR`;
      const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      const ym = (d) => `${d.slice(2, 4)}${d.slice(5, 7)}`;
      const tab = ym(dk(0));
      const prevMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`; })();
      const prevTab = ym(prevMonth);
      const recRows = () => [
        ['', '1'],
        ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
        ['', '가짜 스쿼트', '3', '10', '60', '', '', '', '2'],
        ['', '가짜 로우', '3', '12', '30', '32', '', '', '1'],
        ['', '', '', '운동한 날', md(dk(-3)), md(dk(-1))],
        ['', '2'],
        ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
        ['', '가짜 런지', '3', '12', '20', '', '', '', '1.5'],
        ['', '', '', '운동한 날', md(dk(-2))],
      ];
      const prevRows = [['', '1'], ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'], ['', '가짜 스쿼트', '3', '10', '55', '', '', '', '2'], ['', '', '', '운동한 날', md(prevMonth)]];
      fake.set(sidR, { tabs: [prevTab, tab], rowsByTab: { [prevTab]: prevRows, [tab]: recRows() } });
      check('기록 시험 회원이 시트 연결', !(await mR.c.rpc('set_routine_sheet', { p_member: mR.user.id, p_sheet: sidR })).error);
      // 호출마다 번호를 붙인다: 서버 기능이 가짜 시트 서버까지 넘겨, 실패 기록에서 호출 → 시트 요청 → 서버 로그를 잇는다
      const callFn = async (c, fn, body) => {
        const token = (await c.auth.getSession()).data.session?.access_token;
        const entry = { call: `${run}-${edgeCalls.length + 1}`, fn, start: Date.now(), end: null, code: null };
        edgeCalls.push(entry);
        const r = await fetch(`${URL}/functions/v1/${fn}`, { method: 'POST', headers: { apikey: KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-check-call': entry.call }, body: JSON.stringify(body) });
        const out = { code: r.status, body: await r.json().catch(() => null) };
        entry.end = Date.now();
        entry.code = r.status;
        if (!r.ok) entry.note = JSON.stringify(out.body).slice(0, 200);
        return out;
      };
      const sheetSessions = async (c) => ((await c.c.from('workout_sessions').select('id, day, day_no, source, sheet_tab, routine_id, sets:workout_sets(name, kg, reps, done)').eq('member_id', mR.user.id).eq('source', 'sheet').order('day')).data ?? []);
      const r1 = await callFn(mR.c, 'sheet-import', { member: mR.user.id, force: true });
      const g1 = await sheetSessions(mR);
      const cur = (await mR.c.from('routines').select('id, source_ref').eq('member_id', mR.user.id).order('version', { ascending: false }).limit(1).single()).data;
      const shape = (list) => list.map((x) => `${x.day}:${x.day_no}:${x.sets.map((y) => `${y.name}=${y.kg}/${y.reps}`).join(',')}`);
      check('자동 반영 때 그 달 탭의 회차 기록을 가져옴(회차마다 기록 하나, 세트 수는 계획대로, 칸 글자 그대로)', r1.code === 200 && r1.body?.records?.saved === 3 && JSON.stringify(shape(g1)) === JSON.stringify([
        `${dk(-3)}:1:가짜 스쿼트=60/10,가짜 스쿼트=60/10,가짜 스쿼트=60/10,가짜 로우=30/12,가짜 로우=30/12,가짜 로우=30/12`,
        `${dk(-2)}:2:가짜 런지=20/12,가짜 런지=20/12,가짜 런지=20/12`,
        `${dk(-1)}:1:가짜 로우=32/12,가짜 로우=32/12,가짜 로우=32/12`,
      ]) && g1.every((x) => x.sheet_tab === tab && x.routine_id === cur?.id), JSON.stringify([r1, shape(g1)]));
      check('가져온 기록: 담당 트레이너는 봄 · 다른 회원은 못 봄', (await sheetSessions(tX)).length === 3 && (await sheetSessions(mR2)).length === 0);
      const pv = await callFn(tX.c, 'sheet-import', { member: mR.user.id, mode: 'records_all', preview: true });
      check('지난 기록 미리보기: 탭마다 회차 수(저장 안 함)', pv.code === 200 && pv.body?.status === 'preview' && JSON.stringify(pv.body.tabs.map((t) => [t.tab, t.sessions])) === JSON.stringify([[tab, 3], [prevTab, 1]]) && (await sheetSessions(mR)).length === 3, JSON.stringify(pv.body));
      const im = await callFn(mR.c, 'sheet-import', { member: mR.user.id, mode: 'records_all' });
      const im2 = await callFn(mR.c, 'sheet-import', { member: mR.user.id, mode: 'records_all' });
      const g2 = await sheetSessions(mR);
      check('지난 기록 가져오기: 지난 탭까지 · 다시 가져와도 하나씩', im.body?.status === 'imported' && im2.body?.status === 'imported' && g2.length === 4 && g2[0].day === prevMonth && g2[0].routine_id === null, JSON.stringify([im.body, im2.body, shape(g2)]));
      const imported = g2[1];
      check('가져온 기록은 앱에서 못 고치고 못 지움(시트에서 고침)', /sheet_record/.test((await mR.c.rpc('save_workout', { p_session: imported.id, p_day: imported.day, p_routine: null, p_sets: [], p_finished: true, p_base: '2000-01-01T00:00:00Z', p_save_id: webcrypto.randomUUID() })).error?.message ?? '') && /sheet_record/.test((await mR.c.rpc('delete_workout', { p_session: imported.id })).error?.message ?? ''));
      check('가져오기 저장 함수는 앱에서 못 부름', !!(await mR.c.rpc('sheet_records_save', { p_member: mR.user.id, p_sheet: sidR, p_tab: tab, p_sessions: [] })).error && !!(await tX.c.rpc('sheet_records_save', { p_member: mR.user.id, p_sheet: sidR, p_tab: tab, p_sessions: [] })).error);
      // 앱 기록 → 시트: 루틴 1 블록의 날짜·운동 칸이 모두 빈 첫 열(G)에 완료 세트 무게와 오늘 날짜. 시트에 없는 운동은 앱에만
      const appId = webcrypto.randomUUID();
      const appSets = (row) => [{ name: '가짜 스쿼트', set_no: 1, kg: '62.5', reps: '10', done: true }, { name: '가짜 스쿼트', set_no: 2, kg: '65', reps: '8', done: true }, { name: '가짜 스쿼트', set_no: 3, kg: '65', reps: '6', done: false }, { name: '가짜 로우', set_no: 1, kg: row, reps: '12', done: true }, { name: '플랭크', set_no: 1, kg: null, reps: '60초', done: true }];
      const a1 = await mR.c.rpc('save_workout', { p_session: appId, p_day: dk(0), p_routine: cur.id, p_day_no: 1, p_sets: appSets('33'), p_finished: false, p_save_id: webcrypto.randomUUID() });
      const w1 = await callFn(mR.c, 'sheet-write', { session: appId });
      const writes1 = fake.writes(sidR).map((w) => `${w.cell}=${w.value}:${w.input}`);
      check('앱 기록을 시트에 씀: 빈 첫 열에 날짜 먼저(직접 친 것처럼)·완료 세트 가운데 가장 높은 무게(62.5·65 → 65, RAW), 시트에 없는 운동은 알림', !a1.error && w1.body?.status === 'partial' && w1.body?.col === 'G' && JSON.stringify(w1.body?.skipped) === JSON.stringify(['플랭크']) && JSON.stringify(writes1) === JSON.stringify([`G5=${md(dk(0))}:USER_ENTERED`, `G3=65:RAW`, `G4=33:RAW`]), JSON.stringify([a1.error?.message, w1, writes1]));
      const again = await callFn(mR.c, 'sheet-write', { session: appId });
      check('같은 기록을 다시 쓰면 같은 열, 바뀐 칸이 없으면 쓰지 않음', again.body?.col === 'G' && fake.writes(sidR).length === 3, JSON.stringify(again.body));
      await callFn(mR.c, 'sheet-import', { member: mR.user.id, force: true });
      check('앱이 쓴 열은 다시 가져오지 않음(기록이 두 번 생기지 않음)', (await sheetSessions(mR)).length === 4);
      // 트레이너가 앱이 쓴 칸을 고침 → 앱에서 다시 저장해도 그 칸은 덮지 않고, 앱이 쓴 그대로인 칸만 고친다
      fake.rowsOf(sidR, tab)[2][6] = '70';
      const base1 = (await mR.c.from('workout_sessions').select('updated_at').eq('id', appId).single()).data.updated_at;
      await mR.c.rpc('save_workout', { p_session: appId, p_day: dk(0), p_routine: cur.id, p_day_no: 1, p_sets: appSets('35'), p_finished: false, p_base: base1, p_save_id: webcrypto.randomUUID() });
      const w2 = await callFn(mR.c, 'sheet-write', { session: appId });
      check('다른 사람이 고친 칸은 두고(kept) 앱이 쓴 칸만 고침', w2.body?.status === 'partial' && JSON.stringify(w2.body?.kept) === JSON.stringify(['가짜 스쿼트']) && fake.rowsOf(sidR, tab)[2][6] === '70' && fake.rowsOf(sidR, tab)[3][6] === '35', JSON.stringify([w2.body, fake.rowsOf(sidR, tab)[2], fake.rowsOf(sidR, tab)[3]]));
      check('앱 기록에 쓴 탭·열 표시', (await mR.c.from('workout_sessions').select('sheet_tab, sheet_col').eq('id', appId).single()).data?.sheet_col === 6);
      await mR.c.rpc('delete_workout', { p_session: appId });
      await callFn(mR.c, 'sheet-import', { member: mR.user.id, force: true });
      check('앱에서 지운 기록은 시트 가져오기로 되살아나지 않음', (await sheetSessions(mR)).length === 4);
      check('남의 기록은 시트에 못 씀', (await callFn(mR2.c, 'sheet-write', { session: imported.id })).code === 403);
      // 서비스 계정이 '뷰어'면(쓰기 권한 없음) denied — 앱은 복사해서 붙여 넣기로 안내
      fake.set(sidR, { tabs: [prevTab, tab], rowsByTab: { [prevTab]: prevRows, [tab]: recRows() }, readOnly: true });
      const appId2 = webcrypto.randomUUID();
      await mR.c.rpc('save_workout', { p_session: appId2, p_day: dk(0), p_routine: cur.id, p_day_no: 2, p_sets: [{ name: '가짜 런지', set_no: 1, kg: '22', reps: '12', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() });
      check('편집 권한이 없으면 denied', (await callFn(mR.c, 'sheet-write', { session: appId2 })).body?.status === 'denied');
      check('시트에서 가져온 기록은 다시 쓰지 않음(not_sheet)', (await callFn(mR.c, 'sheet-write', { session: g2[0].id })).body?.status === 'not_sheet');

      // 적대 검토(2026-11-02) 재현 — 새 회원 P와 새 시트로 따로 시험한다
      const { execFileSync: execR, execFile: execA } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const runA = promisify(execA);
      // 가짜 시트 서버가 같은 프로세스에 있어 DB 명령은 비동기로 부른다 — 동기로 부르면 도는 동안 HTTP 응답이 멈춘다(v2.3.0 2차 리뷰). 1초 넘게 걸린 명령은 시각과 함께 남긴다
      const psqlR = async (q) => {
        const t0 = Date.now();
        const { stdout } = await runA('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', q], { encoding: 'utf8' });
        const ms = Date.now() - t0;
        if (ms > 1000) slowExec.push({ at: t0, ms, q: q.replace(/\s+/g, ' ').slice(0, 60) });
        return stdout.trim();
      };
      /** 시험이 흔들렸을 때 함께 남길 기록: 그 시트의 가짜 서버 요청 시각과 느린 DB 명령 */
      /** 그 시각 뒤 로컬 서버 기능의 오류 줄(시간 초과 등) — 실패한 요청이 시트에 닿지 못했는지 가르는 데 쓴다(Codex v2.2.0 3차 리뷰: 'Signal timed out' 한 건의 요청을 특정하지 못함) */
      const edgeErrors = (since) => {
        try {
          return execR('sh', ['-c', `docker logs --since ${new Date(since - 1000).toISOString()} supabase_edge_runtime_app 2>&1 | grep -iE 'timed out|error|fail|abort|unknown' | tail -20`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        } catch {
          return [];
        }
      };
      // edge(서버 기능 로그)는 docker를 동기로 불러 그동안 이 프로세스의 가짜 시트 서버도 멈춘다 — 실패한 뒤에만 붙인다(withEdge)
      const diag = (sid, since, withEdge = false) => ({ fake: fake.log(sid).filter((e) => e.at >= since), slowExec: slowExec.filter((e) => e.at >= since), ...(withEdge ? { edge: edgeErrors(since) } : {}) });
      /** 저장 도우미가 .data만 돌려주면 RPC 오류가 묻힌다(Codex v2.2.0 1차 리뷰) — 오류를 시각과 함께 남겨 실패 기록에 붙인다 */
      const rpcErrors = [];
      const rpcData = (r, label) => {
        if (r.error) rpcErrors.push({ at: Date.now(), label, error: r.error.message });
        return r.data;
      };
      const mP = await signUp(`zz검증기P${run}`, { role: 'member', trainer_id: tX.user.id });
      const sidP = `zz${run}PPPPPPPPPPPPPPPPPPPPPPPP`;
      const pRows = () => recRows();
      fake.set(sidP, { tabs: [prevTab, tab, `${tab}의 사본`], rowsByTab: { [prevTab]: prevRows.map((r) => [...r]), [tab]: pRows(), [`${tab}의 사본`]: pRows() } });
      await mP.c.rpc('set_routine_sheet', { p_member: mP.user.id, p_sheet: sidP });
      const pSheet = async () => ((await mP.c.from('workout_sessions').select('id, day, day_no, sheet_tab').eq('member_id', mP.user.id).eq('source', 'sheet').order('day')).data ?? []);
      // P1: 옛 방식의 id(md5(회원|탭|루틴|열))를 다른 회원이 미리 자기 기록으로 만들어 두어도 P의 시트 기록이 그쪽으로 새지 않는다
      const h = createHash('md5').update(`${mP.user.id}|${tab}|1|4`).digest('hex');
      const oldId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      const squat = await mR2.c.rpc('save_workout', { p_session: oldId, p_day: dk(0), p_routine: null, p_sets: [{ item_id: null, name: '내 운동', set_no: 1, kg: '1', reps: '1', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() });
      const sp = await callFn(mP.c, 'sheet-import', { member: mP.user.id, force: true });
      const theirs = (await mR2.c.from('workout_sets').select('name, kg').eq('session_id', oldId)).data ?? [];
      check('가져온 기록 id를 미리 차지해도 남의 시트 기록이 그 기록에 들어가지 않음(P는 자기 기록으로 받음)', !squat.error && sp.body?.records?.saved === 3 && JSON.stringify(theirs) === JSON.stringify([{ name: '내 운동', kg: '1' }]) && (await pSheet()).length === 3 && !(await pSheet()).some((x) => x.id === oldId), JSON.stringify([squat.error?.message, sp.body, theirs, await pSheet()]));
      // 사본 탭: 같은 달 정식 탭이 있으면 빼고(같은 회차가 두 번 들어오지 않음), 시트에서 지운 탭의 기록은 지난 기록 가져오기 때 지움
      const pv2 = await callFn(mP.c, 'sheet-import', { member: mP.user.id, mode: 'records_all', preview: true });
      check('지난 기록 미리보기: 같은 달 사본 탭은 뺌', JSON.stringify((pv2.body?.tabs ?? []).map((t) => t.tab)) === JSON.stringify([tab, prevTab]), JSON.stringify(pv2.body));
      await callFn(mP.c, 'sheet-import', { member: mP.user.id, mode: 'records_all' });
      check('지난 기록 가져오기: 사본 탭 회차가 겹쳐 들어오지 않음(4회)', (await pSheet()).length === 4 && !(await pSheet()).some((x) => x.sheet_tab.includes('사본')), JSON.stringify(await pSheet()));
      fake.set(sidP, { tabs: [tab], rowsByTab: { [tab]: pRows() } });
      await callFn(mP.c, 'sheet-import', { member: mP.user.id, mode: 'records_all' });
      check('시트에서 지운 탭의 가져온 기록은 다음 지난 기록 가져오기 때 지움', (await pSheet()).length === 3 && (await pSheet()).every((x) => x.sheet_tab === tab), JSON.stringify(await pSheet()));
      // 완료 세트가 없는 앱 기록은 같은 날 트레이너의 시트 회차를 가리지 않는다
      const routineP = (await mP.c.from('routines').select('id').eq('member_id', mP.user.id).order('version', { ascending: false }).limit(1).single()).data;
      await mP.c.rpc('save_workout', { p_session: webcrypto.randomUUID(), p_day: dk(-1), p_routine: routineP.id, p_day_no: 1, p_sets: [{ name: '가짜 로우', set_no: 1, kg: '30', reps: '12', done: false }], p_finished: false, p_save_id: webcrypto.randomUUID() });
      await callFn(mP.c, 'sheet-import', { member: mP.user.id, force: true });
      check('완료 세트가 없는 앱 기록은 같은 날 시트 회차를 가리지 않음', (await pSheet()).some((x) => x.day === dk(-1) && x.day_no === 1));
      // P4: 앱이 쓴 열의 날짜를 트레이너가 고침 → 새 빈 열로 옮겨 쓰고 옛 표시는 지움 → 그 뒤 무게를 고치면 새 열의 자기 칸을 고침(남의 칸으로 보지 않음)
      const pid = webcrypto.randomUUID();
      const pSets = (kg, done = true) => [{ name: '가짜 스쿼트', set_no: 1, kg, reps: '10', done }, { name: '가짜 로우', set_no: 1, kg: '30', reps: '12', done: true }];
      const saveP = async (sets, base) => rpcData(await mP.c.rpc('save_workout', { p_session: pid, p_day: dk(0), p_routine: routineP.id, p_day_no: 1, p_sets: sets, p_finished: true, p_base: base, p_save_id: webcrypto.randomUUID() }), 'save P');
      let baseP = await saveP(pSets('60'), null);
      const pw1 = await callFn(mP.c, 'sheet-write', { session: pid });
      const prow = () => fake.rowsOf(sidP, tab);
      prow()[4][6] = md(dk(-5)); // 트레이너가 G열 날짜를 다른 날로 고침
      baseP = await saveP(pSets('62.5'), baseP);
      const pw2 = await callFn(mP.c, 'sheet-write', { session: pid });
      baseP = await saveP(pSets('65'), baseP);
      const pw3 = await callFn(mP.c, 'sheet-write', { session: pid });
      const linksP = await psqlR(`select string_agg(tab || ':' || col, ',') from public.sheet_record_links where session_id = '${pid}'`);
      check('날짜가 바뀐 열은 두고 새 열로 옮겨 쓰고(표시 하나), 그 뒤 고친 무게는 자기 칸에 씀', pw1.body?.col === 'G' && pw2.body?.col === 'H' && pw3.body?.status === 'written' && (pw3.body?.kept ?? []).length === 0 && prow()[2][7] === '65' && prow()[2][6] === '60' && linksP === `${tab}:7`, JSON.stringify([pw1.body, pw2.body, pw3.body, prow()[2], linksP]));
      // P7: 완료를 끈 운동은 앱이 쓴 칸을 비우고, 모두 끄면 앱이 쓴 날짜와 표시도 지움
      baseP = await saveP([{ name: '가짜 스쿼트', set_no: 1, kg: '65', reps: '10', done: false }, { name: '가짜 로우', set_no: 1, kg: '30', reps: '12', done: true }], baseP);
      const pw4 = await callFn(mP.c, 'sheet-write', { session: pid });
      baseP = await saveP([{ name: '가짜 스쿼트', set_no: 1, kg: '65', reps: '10', done: false }, { name: '가짜 로우', set_no: 1, kg: '30', reps: '12', done: false }], baseP);
      const pw5 = await callFn(mP.c, 'sheet-write', { session: pid });
      check('완료를 끈 운동의 칸은 비우고, 모두 끄면 앱이 쓴 날짜·표시도 지움', prow()[2][7] === '' && prow()[3][7] === '' && prow()[4][7] === '' && pw4.body?.status === 'written' && pw5.body?.status === 'nothing' && await psqlR(`select count(*) from public.sheet_record_links where session_id = '${pid}'`) === '0', JSON.stringify([pw4.body, pw5.body, prow()[2], prow()[3], prow()[4]]));
      // P6: 먼저 시작한 쓰기가 늦게 끝나도 마지막 저장 값이 시트에 남음
      const qid = webcrypto.randomUUID();
      const saveQ = async (kg, base) => rpcData(await mP.c.rpc('save_workout', { p_session: qid, p_day: dk(0), p_routine: routineP.id, p_day_no: 2, p_sets: [{ name: '가짜 런지', set_no: 1, kg, reps: '12', done: true }], p_finished: true, p_base: base, p_save_id: webcrypto.randomUUID() }), 'save Q');
      let baseQ = await saveQ('20', null);
      fake.set(sidP, { tabs: [tab], rowsByTab: { [tab]: prow() }, delayFirstWriteMs: 2500 });
      const slow = callFn(mP.c, 'sheet-write', { session: qid });
      await new Promise((r) => setTimeout(r, 800));
      baseQ = await saveQ('24', baseQ);
      const fast = await callFn(mP.c, 'sheet-write', { session: qid });
      const late = await slow;
      const lungeCol = Number(await psqlR(`select col from public.sheet_record_links where session_id = '${qid}'`));
      check('먼저 시작한 쓰기가 늦게 끝나도 시트에는 마지막 저장 값(24)', prow()[7][lungeCol] === '24' && fast.code === 200 && late.code === 200, JSON.stringify([late.body, fast.body, prow()[7], lungeCol]));
      // Codex v2.1 1차 리뷰 P1: 원래 있던 값이 앱 값과 같아도 앱이 쓴 칸이 아니다 — 같은 날짜 열(H)에 트레이너가 스쿼트 40을 적어 둠, 로우는 빈 칸
      fake.set(sidP, { tabs: [tab], rowsByTab: { [tab]: prow() } });
      prow()[4][7] = md(dk(-2));
      prow()[2][7] = '40';
      const oid = webcrypto.randomUUID();
      const saveO = async (sq, sqDone, base) => rpcData(await mP.c.rpc('save_workout', { p_session: oid, p_day: dk(-2), p_routine: routineP.id, p_day_no: 1, p_sets: [{ name: '가짜 스쿼트', set_no: 1, kg: sq, reps: '10', done: sqDone }, { name: '가짜 로우', set_no: 1, kg: '30', reps: '12', done: true }], p_finished: true, p_base: base, p_save_id: webcrypto.randomUUID() }), 'save O');
      let baseO = await saveO('40', true, null);
      const ow1 = await callFn(mP.c, 'sheet-write', { session: oid });
      const ownCells = await psqlR(`select cells::text from public.sheet_record_links where session_id = '${oid}'`);
      baseO = await saveO('45', true, baseO);
      const ow2 = await callFn(mP.c, 'sheet-write', { session: oid });
      const afterEdit = prow()[2][7];
      baseO = await saveO('45', false, baseO);
      await callFn(mP.c, 'sheet-write', { session: oid });
      check('원래 있던 같은 값(스쿼트 40)은 앱 소유가 아님: 로우만 쓰고 표시도 로우만 · 그 뒤 스쿼트를 고치거나 완료를 꺼도 원래 40은 그대로', ow1.body?.col === 'H' && prow()[3][7] === '30' && ownCells === '{"가짜 로우": "30"}' && (ow2.body?.kept ?? []).includes('가짜 스쿼트') && afterEdit === '40' && prow()[2][7] === '40', JSON.stringify([ow1.body, ownCells, ow2.body, afterEdit, prow()[2][7]]));
      // Codex v2.1 1차 리뷰 P1: 서로 다른 기록 두 개가 동시에 쓰면 같은 빈 열을 차지하지 않는다(먼저 예약한 기록이 그 열, 다른 기록은 다음 빈 열)
      const sa = webcrypto.randomUUID(), sb = webcrypto.randomUUID();
      const saveDay = async (id, day, kg) => mP.c.rpc('save_workout', { p_session: id, p_day: day, p_routine: routineP.id, p_day_no: 2, p_sets: [{ name: '가짜 런지', set_no: 1, kg, reps: '12', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() });
      await saveDay(sa, dk(-4), '50');
      await saveDay(sb, dk(-6), '70');
      fake.set(sidP, { tabs: [tab], rowsByTab: { [tab]: prow() }, delayFirstWriteMs: 2500 });
      const slowA = callFn(mP.c, 'sheet-write', { session: sa });
      await new Promise((r) => setTimeout(r, 800));
      const wb = await callFn(mP.c, 'sheet-write', { session: sb });
      const wa = await slowA;
      const colsAB = [await psqlR(`select col from public.sheet_record_links where session_id = '${sa}'`), await psqlR(`select col from public.sheet_record_links where session_id = '${sb}'`)];
      check('다른 기록 두 개의 동시 쓰기: 서로 다른 열에 각자 무게·날짜(하나가 다른 하나를 덮지 않음)', wa.body?.status === 'written' && wb.body?.status === 'written' && colsAB[0] && colsAB[1] && colsAB[0] !== colsAB[1] && prow()[7][Number(colsAB[0])] === '50' && prow()[7][Number(colsAB[1])] === '70' && prow()[8][Number(colsAB[0])] === md(dk(-4)) && prow()[8][Number(colsAB[1])] === md(dk(-6)), JSON.stringify([wa.body, wb.body, colsAB, prow()[7], prow()[8]]));
      // Codex v2.1 2차 리뷰: 쓰기 차례(회원마다 한 작업)·연결 세대·쓰는 중 표시 — 회원마다 새 시트로 따로 시험한다
      const simpleRows = (filled = false) => [
        ['', '1'],
        ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
        ['', '가짜 스쿼트', '3', '10', filled ? '40' : '', '', '', '', '2'],
        ['', '가짜 로우', '3', '12', filled ? '30' : '', '', '', '', '1'],
        ['', '', '', '운동한 날', filled ? md(dk(0)) : ''],
      ];
      const sheetMember = async (letter, rows) => {
        const m = await signUp(`zz검증기${letter}${run}`, { role: 'member', trainer_id: tX.user.id });
        const sid = `zz${run}${letter.repeat(24)}`;
        const sh = { tabs: [tab], rowsByTab: { [tab]: rows } };
        fake.set(sid, sh);
        await m.c.rpc('set_routine_sheet', { p_member: m.user.id, p_sheet: sid });
        const first = await callFn(m.c, 'sheet-import', { member: m.user.id, force: true });
        const got = await m.c.from('routines').select('id').eq('member_id', m.user.id).order('version', { ascending: false }).limit(1).maybeSingle();
        // 준비가 실패하면 뒤의 시험이 빈 값으로 멈추지 않게 그 자리에서 원인을 남긴다(v2.3.0 3차 리뷰)
        if (first.code !== 200 || got.error || !got.data) throw new Error(`시험 준비 실패: 회원 ${letter} · 시트 ${sid} · sheet-import ${first.code} ${JSON.stringify(first.body)} · 호출 ${edgeCalls.at(-1)?.call} · 루틴 ${got.error?.message ?? (got.data ? '있음' : '없음')}`);
        return { m, sid, sh, routine: got.data, rows: () => fake.rowsOf(sid, tab) };
      };
      const saveS = async (x, id, day, sq, { base = null, done = true } = {}) =>
        rpcData(await x.m.c.rpc('save_workout', { p_session: id, p_day: day, p_routine: x.routine.id, p_day_no: 1, p_sets: [{ name: '가짜 스쿼트', set_no: 1, kg: sq, reps: '10', done }, { name: '가짜 로우', set_no: 1, kg: '30', reps: '12', done }], p_finished: true, p_base: base, p_save_id: webcrypto.randomUUID() }), `save ${id.slice(0, 8)}`);
      /** 가짜 시트의 한 번짜리 설정이 쓰였는지(요청이 그 단계에 들어감) */
      const started = async (sh, flag) => {
        for (let i = 0; i < 500 && sh[flag]; i++) await new Promise((r) => setTimeout(r, 10));
        return !sh[flag];
      };
      const linksOf = async (id) => JSON.parse(await psqlR(`select coalesce(json_agg(json_build_object('col', col, 'cells', cells, 'pending', pending)), '[]') from public.sheet_record_links where session_id = '${id}'`));
      /** 앱이 쓴 칸 비교(키 순서 무관) — 칸 이름은 운동 이름, 날짜는 '@date' */
      const sameCells = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());
      const SQ = '가짜 스쿼트', RW = '가짜 로우', DT = '@date';
      /** 결과를 모르는 쓰기 뒤 서버 기능이 쥔 쓰기 차례(60초) — 시험에서는 끝난 것으로 돌린다 */
      const turnHeld = async (m) => await psqlR(`select (until > now() + interval '45 seconds')::text from private.sheet_write_turns where member_id = '${m.user.id}'`) === 'true';
      const expireTurn = async (m) => await psqlR(`update private.sheet_write_turns set until = now() - interval '1 second' where member_id = '${m.user.id}'`);
      /** 다른 작업이 쓰기 차례를 쥐고 있게 만든다(초) */
      const holdTurn = async (m, sec) => await psqlR(`insert into private.sheet_write_turns (member_id, job, gen, until) select '${m.user.id}', gen_random_uuid(), link_gen, now() + interval '${sec} seconds' from public.routine_sources where member_id = '${m.user.id}' on conflict (member_id) do update set job = excluded.job, gen = excluded.gen, until = excluded.until`);
      // 2차 P1: 같은 기록의 다른 요청(완료를 모두 끔)이 쓰는 중인 열 예약을 지우고, 그 틈에 다른 기록 B가 같은 열에 쓰면 늦게 끝난 첫 쓰기가 B를 덮었다
      {
        const x = await sheetMember('Q', simpleRows());
        const sinceQ = Date.now();
        const a = webcrypto.randomUUID(), b = webcrypto.randomUUID();
        let baseA = await saveS(x, a, dk(0), '50');
        x.sh.delayFirstWriteMs = 2500;
        const slow = callFn(x.m.c, 'sheet-write', { session: a });
        const began = await started(x.sh, 'delayFirstWriteMs');
        baseA = await saveS(x, a, dk(0), '50', { base: baseA, done: false });
        const cancel = callFn(x.m.c, 'sheet-write', { session: a });
        await saveS(x, b, dk(-1), '70');
        const second = callFn(x.m.c, 'sheet-write', { session: b });
        const res = await Promise.all([slow, cancel, second]);
        const q = x.rows();
        const bl = (await linksOf(b));
        const bc = bl[0]?.col;
        check('2차 P1 재현: 쓰는 중인 열 예약을 같은 기록의 다른 요청이 지우지 못함 — 완료를 끈 A는 시트에서 빠지고, B의 값·날짜는 덮이지 않음(표시 = 시트)',
          began && res.every((w) => w.code === 200) && (await linksOf(a)).length === 0 && bl.length === 1 && bl[0].pending === null && q[2][bc] === '70' && q[3][bc] === '30' && q[4][bc] === md(dk(-1)) && !q[2].includes('50')
            && sameCells(bl[0].cells, { [SQ]: '70', [RW]: '30', [DT]: dk(-1) }),
          JSON.stringify([res.map((w) => w.body), q, bl, began, diag(x.sid, sinceQ)]));
      }
      // 2차 P1: 읽는 중·쓰는 중에 연결을 다른 시트로 바꾸거나 풀어도, 옛 요청이 새 연결에 소유 표시를 남기지 않는다.
      //  새 시트 B의 같은 날짜·같은 칸에 손으로 적은 40·30이 있음 — 옛 표시가 남으면 앱이 45로 고칠 때 B의 40을 덮었다
      for (const [phase, action, letter] of [['read', 'switch', 'Y'], ['write', 'switch', 'X'], ['read', 'unlink', 'U'], ['write', 'unlink', 'V']]) {
        const y = await sheetMember(letter, simpleRows());
        const id = webcrypto.randomUUID();
        let baseY = await saveS(y, id, dk(0), '40');
        const flag = phase === 'read' ? 'delayFirstReadMs' : 'delayFirstWriteMs';
        y.sh[flag] = 1600;
        const inFlight = callFn(y.m.c, 'sheet-write', { session: id });
        const began = await started(y.sh, flag);
        const sidB = `zz${run}${letter.toLowerCase().repeat(24)}`;
        fake.set(sidB, { tabs: [tab], rowsByTab: { [tab]: simpleRows(true) } });
        const sw = await y.m.c.rpc('set_routine_sheet', { p_member: y.m.user.id, p_sheet: action === 'switch' ? sidB : '' });
        const stale = await inFlight;
        const left = (await linksOf(id)).length;
        let ok = began && !sw.error && stale.code === 200 && left === 0;
        let after = null;
        if (action === 'switch') {
          baseY = await saveS(y, id, dk(0), '45', { base: baseY });
          after = await callFn(y.m.c, 'sheet-write', { session: id });
          const rB = fake.rowsOf(sidB, tab);
          ok &&= after.code === 200 && (after.body?.kept ?? []).includes('가짜 스쿼트') && rB[2][4] === '40' && rB[3][4] === '30' && (await linksOf(id)).length === 0;
        } else ok &&= stale.body?.status === 'no_sheet';
        // 읽는 중에 바뀌면 옛 시트에는 쓰지 않는다. 쓰는 중에 바뀌면 이미 보낸 날짜만 옛 시트에 남고 무게는 보내지 않는다(새 시트와 표시에는 영향 없음)
        ok &&= y.rows()[2][4] === '' && y.rows()[3][4] === '' && (phase === 'write' || y.rows()[4][4] === '');
        check(`2차 P1 재현: ${phase === 'read' ? '읽는' : '쓰는'} 중에 연결을 ${action === 'switch' ? '다른 시트로 바꿔도 새 시트의 손으로 적은 40은 앱이 45로 고쳐도 그대로' : '풀어도 표시가 남지 않음(no_sheet)'}`,
          ok, JSON.stringify([stale, left, after?.body, fake.rowsOf(sidB, tab), y.rows()]));
      }
      // 2차 P2: 시트에 쓰기는 됐는데 응답이 끊김 → 쓰는 중 표시(pending)가 남고, 다시 쓰면 앱이 쓴 칸으로 되찾아 그 뒤 수정·완료 해제도 된다
      {
        const z = await sheetMember('Z', simpleRows());
        const id = webcrypto.randomUUID();
        let baseZ = await saveS(z, id, dk(0), '40');
        z.sh.dropWriteResponse = 'RAW';
        const lost = await callFn(z.m.c, 'sheet-write', { session: id });
        const mid = (await linksOf(id));
        const held = (await turnHeld(z.m));
        const posMid = await psqlR(`select sheet_tab || ':' || coalesce(sheet_col::text, '') from public.workout_sessions where id = '${id}'`);
        (await expireTurn(z.m));
        const retry = await callFn(z.m.c, 'sheet-write', { session: id });
        const recovered = (await linksOf(id));
        baseZ = await saveS(z, id, dk(0), '45', { base: baseZ });
        const edit = await callFn(z.m.c, 'sheet-write', { session: id });
        const sq = z.rows()[2][4];
        baseZ = await saveS(z, id, dk(0), '45', { base: baseZ, done: false });
        const off = await callFn(z.m.c, 'sheet-write', { session: id });
        check('2차 P2 재현: 쓰기 뒤 응답이 끊기면 결과 모름(unknown)·쓰기 차례를 60초 더 쥠·기록에 쓰는 자리를 적음 → 다시 쓰면 앱이 쓴 칸으로 되찾음 → 45로 고치고 완료를 끄면 칸·날짜를 비움',
          lost.code === 200 && lost.body?.status === 'unknown' && held && posMid === `${tab}:4` && mid.length === 1 && mid[0].pending !== null && retry.code === 200 && recovered[0]?.pending === null && sameCells(recovered[0]?.cells, { [SQ]: '40', [RW]: '30', [DT]: dk(0) })
            && edit.body?.status === 'written' && sq === '45' && off.body?.status === 'nothing' && z.rows()[2][4] === '' && z.rows()[3][4] === '' && z.rows()[4][4] === '' && (await linksOf(id)).length === 0,
          JSON.stringify([lost, held, posMid, mid, retry.body, recovered, edit.body, sq, off.body, z.rows()]));
        // 시트가 거절한 쓰기는 쓰이지 않은 것: 첫 단계(날짜)에서 거절되면 예약을 풀고, 둘째 단계(무게)에서 거절되면 쓴 날짜만 앱이 쓴 칸으로 둔다
        const id2 = webcrypto.randomUUID();
        await saveS(z, id2, dk(-1), '50');
        z.sh.rejectWrite = { status: 400 };
        const r1 = await callFn(z.m.c, 'sheet-write', { session: id2 });
        const l1 = (await linksOf(id2));
        z.sh.rejectWrite = { status: 400, input: 'RAW' };
        const r2 = await callFn(z.m.c, 'sheet-write', { session: id2 });
        const l2 = (await linksOf(id2));
        const r3 = await callFn(z.m.c, 'sheet-write', { session: id2 });
        const c3 = (await linksOf(id2))[0]?.col;
        check('시트가 거절한 쓰기: 날짜에서 거절되면 예약을 풀고(표시 없음), 무게에서 거절되면 쓴 날짜만 확정 → 다음 쓰기가 같은 열에 무게를 씀',
          r1.code === 502 && l1.length === 0 && r2.code === 502 && l2.length === 1 && l2[0].pending === null && sameCells(l2[0].cells, { [DT]: dk(-1) })
            && r3.body?.status === 'written' && c3 === l2[0].col && z.rows()[2][c3] === '50' && z.rows()[4][c3] === md(dk(-1)),
          JSON.stringify([r1, l1, r2, l2, r3.body, z.rows()]));
        // 다른 작업이 쓰기 차례를 쥐고 있으면 기다린다 — 차례가 끝나면 이어서 쓰고, 12초 안에 끝나지 않으면 busy(앱은 복사 길로 안내)
        const id3 = webcrypto.randomUUID();
        await saveS(z, id3, dk(-2), '55');
        (await holdTurn(z.m, 3));
        const t0 = Date.now();
        const wWait = await callFn(z.m.c, 'sheet-write', { session: id3 });
        const waited = Date.now() - t0;
        const id4 = webcrypto.randomUUID();
        await saveS(z, id4, dk(-3), '57.5');
        (await holdTurn(z.m, 60));
        const wBusy = await callFn(z.m.c, 'sheet-write', { session: id4 });
        // 적대 검토 F10: 완료 세트도 쓴 칸도 없는 기록은 차례를 기다리지 않고 바로 nothing
        const id5 = webcrypto.randomUUID();
        await saveS(z, id5, dk(-4), '20', { done: false });
        const t5 = Date.now();
        const wNone = await callFn(z.m.c, 'sheet-write', { session: id5 });
        const fast = Date.now() - t5;
        await psqlR(`delete from private.sheet_write_turns where member_id = '${z.m.user.id}'`);
        check('쓰기 차례: 다른 작업이 쥐고 있으면 끝날 때까지 기다렸다 쓰고, 12초 안에 안 끝나면 busy(그 기록은 쓰지 않음)',
          waited >= 2500 && wWait.body?.status === 'written' && wBusy.code === 200 && wBusy.body?.status === 'busy' && (await linksOf(id4)).length === 0 && !z.rows()[2].includes('57.5'),
          JSON.stringify([waited, wWait.body, wBusy.body, z.rows()[2]]));
        check('적대 검토 F10: 다른 작업이 차례를 쥐고 있어도 완료 세트·쓴 칸이 없는 기록은 기다리지 않고 바로 nothing', wNone.body?.status === 'nothing' && fast < 3000, JSON.stringify([wNone.body, fast]));
        // 적대 검토 F9: 한도 초과(429)는 구글이 처리하지 않은 요청 — 결과 모름으로 차례를 쥐지 않고 예약을 풀어 바로 다시 쓸 수 있다
        const id6 = webcrypto.randomUUID();
        await saveS(z, id6, dk(-5), '25');
        z.sh.rejectWrite = { status: 429 };
        const r429 = await callFn(z.m.c, 'sheet-write', { session: id6 });
        const held429 = (await turnHeld(z.m));
        const l429 = (await linksOf(id6)).length;
        const again429 = await callFn(z.m.c, 'sheet-write', { session: id6 });
        check('적대 검토 F9: 429는 거절로 보고 차례를 쥐지 않음(예약 풂) · 바로 다시 쓰면 씀', r429.code === 502 && !held429 && l429 === 0 && again429.body?.status === 'written', JSON.stringify([r429, held429, l429, again429.body]));
      }
      // 적대 검토(2026-11-03) F1·F2: 서버 기능이 포기한(연결이 끊긴) 쓰기를 구글이 늦게 반영해도 — 결과를 모르면 쓰기 차례를 60초 더 쥐어,
      //  그사이 다른 기록이 그 열을 받거나(F1) 같은 기록의 새 값이 늦게 온 옛 값에 덮이지(F2) 않는다
      {
        const w = await sheetMember('L', simpleRows());
        const a = webcrypto.randomUUID(), b = webcrypto.randomUUID();
        await saveS(w, a, dk(0), '50');
        w.sh.lateWrite = { ms: 1500 }; // A의 첫 쓰기(날짜)는 끊긴 뒤 1.5초 늦게 반영
        const ra = await callFn(w.m.c, 'sheet-write', { session: a });
        const heldA = (await turnHeld(w.m));
        await saveS(w, b, dk(-1), '70');
        await new Promise((r) => setTimeout(r, 2000)); // 늦은 날짜가 E열에 들어옴
        (await expireTurn(w.m));
        const rb = await callFn(w.m.c, 'sheet-write', { session: b });
        const ca = (await linksOf(a)), cb = (await linksOf(b));
        const q = w.rows();
        check('적대 검토 F1: 결과를 모르는 쓰기(늦게 반영됨) 뒤 다른 기록은 그 열을 받지 않음 — A의 날짜 열(E)은 A의 것, B는 다음 빈 열',
          ra.body?.status === 'unknown' && heldA && rb.body?.status === 'written' && cb[0]?.col === 5 && q[4][4] === md(dk(0)) && q[2][4] === '' && q[2][5] === '70' && q[4][5] === md(dk(-1)) && ca.length === 1 && ca[0].col === 4,
          JSON.stringify([ra.body, heldA, rb.body, ca, cb, q]));
        // 같은 기록: A의 무게 쓰기가 늦게 반영되는 동안 45로 고쳐도, 차례가 끝난 뒤의 쓰기가 늦게 온 50을 앱이 쓴 칸으로 되찾아 45로 고친다
        let baseA = (await w.m.c.from('workout_sessions').select('updated_at').eq('id', a).single()).data.updated_at;
        (await expireTurn(w.m));
        w.sh.lateWrite = { ms: 1500, input: 'RAW' };
        const r1 = await callFn(w.m.c, 'sheet-write', { session: a }); // 날짜는 이미 있음 → 무게만, 늦게 반영
        baseA = await saveS(w, a, dk(0), '45', { base: baseA });
        const during = await callFn(w.m.c, 'sheet-write', { session: a }); // 차례를 쥐고 있어 기다렸다 busy(12초)
        (await expireTurn(w.m));
        const r2 = await callFn(w.m.c, 'sheet-write', { session: a });
        check('적대 검토 F2: 같은 기록의 옛 무게가 늦게 반영돼도 새 값(45)이 남고, 표시와 시트가 같음',
          r1.body?.status === 'unknown' && during.body?.status === 'busy' && r2.body?.status === 'written' && w.rows()[2][4] === '45' && w.rows()[3][4] === '30' && sameCells((await linksOf(a))[0]?.cells, { [SQ]: '45', [RW]: '30', [DT]: dk(0) }),
          JSON.stringify([r1.body, during.body, r2.body, w.rows(), (await linksOf(a))]));
      }
      // 적대 검토 F3: 트레이너가 앱이 쓴 무게를 모두 고친 열 — 다시 저장해도 앱이 쓴 날짜를 지우지 않고(그 열은 시트 쪽 기록), 다음 저장도 새 열을 만들지 않음.
      //  완료를 모두 끄면 앱이 쓴 칸만 비우고, 남의 값이 남으면 날짜는 두어 그 회차를 가져올 수 있다
      {
        const c = await sheetMember('C', simpleRows());
        const id = webcrypto.randomUUID();
        let base = await saveS(c, id, dk(0), '40');
        await callFn(c.m.c, 'sheet-write', { session: id });
        c.rows()[2][4] = '50';
        c.rows()[3][4] = '35';
        base = await saveS(c, id, dk(0), '40', { base });
        const again = await callFn(c.m.c, 'sheet-write', { session: id });
        base = await saveS(c, id, dk(0), '42', { base });
        const next = await callFn(c.m.c, 'sheet-write', { session: id });
        const q = c.rows();
        check('적대 검토 F3: 남이 모두 고친 열은 날짜를 지우지 않고 표시만 내려놓음 · 다음 저장도 같은 열에서 그대로 둠(새 열 없음)',
          again.body?.status === 'partial' && again.body.kept.length === 2 && next.body?.status === 'partial' && next.body.col === 'E' && q[2][4] === '50' && q[3][4] === '35' && q[4][4] === md(dk(0)) && q[2][5] === '' && (await linksOf(id)).length === 0,
          JSON.stringify([again.body, next.body, q, (await linksOf(id))]));
        const id2 = webcrypto.randomUUID();
        let base2 = await saveS(c, id2, dk(-1), '60');
        await callFn(c.m.c, 'sheet-write', { session: id2 });
        const col2 = (await linksOf(id2))[0]?.col;
        c.rows()[2][col2] = '62.5'; // 트레이너가 스쿼트만 고침
        base2 = await saveS(c, id2, dk(-1), '60', { base: base2, done: false });
        const off = await callFn(c.m.c, 'sheet-write', { session: id2 });
        const q2 = c.rows();
        await callFn(c.m.c, 'sheet-import', { member: c.m.user.id, mode: 'records_all' });
        const got = ((await c.m.c.from('workout_sessions').select('day, sets:workout_sets(name, kg)').eq('member_id', c.m.user.id).eq('source', 'sheet')).data ?? []).filter((x) => x.day === dk(-1));
        check('적대 검토 F3: 완료를 모두 끄면 앱이 쓴 로우만 비우고 날짜는 둠 → 트레이너가 고친 스쿼트 회차를 가져옴',
          off.body?.status === 'nothing' && q2[2][col2] === '62.5' && q2[3][col2] === '' && q2[4][col2] === md(dk(-1)) && (await linksOf(id2)).length === 0 && got.length === 1 && got[0].sets.every((x) => x.name === SQ && x.kg === '62.5'),
          JSON.stringify([off.body, q2, got]));
      }
      // 적대 검토 F4·F7: 트레이너가 블록에 줄을 끼워 넣어도 앱이 쓴 칸은 운동 이름으로 찾는다(밀린 줄의 남의 값을 지우지 않음).
      //  같은 날 다른 기록이 같은 값을 가진 열은 '이미 적힌 칸'으로 알린다('적었어요' 아님)
      {
        const f = await sheetMember('F', simpleRows());
        const id = webcrypto.randomUUID();
        let base = await saveS(f, id, dk(0), '30');
        await callFn(f.m.c, 'sheet-write', { session: id });
        f.rows().splice(2, 0, ['', '가짜 런지', '3', '12', '30', '', '', '', '1']); // 스쿼트 위에 런지 줄(E열 30)
        base = await saveS(f, id, dk(0), '32', { base });
        const w4 = await callFn(f.m.c, 'sheet-write', { session: id });
        const q = f.rows();
        check('적대 검토 F4: 끼워 넣은 줄의 남의 값(런지 30)은 그대로, 스쿼트만 32로 고침',
          w4.body?.status === 'written' && q[2][4] === '30' && q[3][4] === '32' && q[4][4] === '30' && sameCells((await linksOf(id))[0]?.cells, { [SQ]: '32', [RW]: '30', [DT]: dk(0) }),
          JSON.stringify([w4.body, q, (await linksOf(id))]));
        const twin = webcrypto.randomUUID();
        await f.m.c.rpc('save_workout', { p_session: twin, p_day: dk(0), p_routine: f.routine.id, p_day_no: 1, p_sets: [{ name: SQ, set_no: 1, kg: '32', reps: '10', done: true }, { name: RW, set_no: 1, kg: '30', reps: '12', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() });
        const w7 = await callFn(f.m.c, 'sheet-write', { session: twin });
        check("적대 검토 F7: 같은 값이 이미 적힌 남의 열은 '이미 적힌 칸'(partial·kept)으로 알리고 표시를 만들지 않음",
          w7.body?.status === 'partial' && w7.body.kept.length === 2 && (await linksOf(twin)).length === 0, JSON.stringify([w7.body, (await linksOf(twin))]));
      }
      // 적대 검토 F6: 기록의 루틴 번호를 바꾸면(앱 화면에서는 못 함, API로만) 옛 블록의 앱이 쓴 칸을 비우고 새 블록에 씀 — 가져오기에서 같은 운동이 또 생기지 않음
      {
        const twoBlocks = [...simpleRows(), ['', '2'], ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'], ['', '가짜 런지', '3', '12', '', '', '', '', '1.5'], ['', '', '', '운동한 날', '']];
        const d = await sheetMember('D', twoBlocks);
        const id = webcrypto.randomUUID();
        const base = await saveS(d, id, dk(0), '40');
        await callFn(d.m.c, 'sheet-write', { session: id });
        await d.m.c.rpc('save_workout', { p_session: id, p_day: dk(0), p_routine: d.routine.id, p_day_no: 2, p_sets: [{ name: '가짜 런지', set_no: 1, kg: '20', reps: '12', done: true }], p_finished: true, p_base: base, p_save_id: webcrypto.randomUUID() });
        const moved = await callFn(d.m.c, 'sheet-write', { session: id });
        const q = d.rows();
        const im = await callFn(d.m.c, 'sheet-import', { member: d.m.user.id, mode: 'records_all' });
        check('적대 검토 F6: 루틴 번호를 바꾸면 옛 블록의 앱 칸·날짜를 비우고 새 블록에 씀 · 가져오기에서 시트 기록이 생기지 않음',
          moved.body?.status === 'written' && q[2][4] === '' && q[3][4] === '' && q[4][4] === '' && q[7][4] === '20' && q[8][4] === md(dk(0)) && (await linksOf(id)).length === 1 && (await linksOf(id))[0].col === 4 && im.body?.saved === 0,
          JSON.stringify([moved.body, q, im.body, (await linksOf(id))]));
      }
      // 적대 검토 2회차(2026-11-03)
      // F11: 가져오기가 시트를 읽는 동안 앱이 완료를 모두 끄고 칸을 비우면, 가져오기는 읽어 둔 옛 칸을 저장하지 않고 다시 읽는다(시트 쓰기 번호 write_seq)
      {
        const g = await sheetMember('G', simpleRows());
        const sinceG = Date.now();
        const id = webcrypto.randomUUID();
        let base = await saveS(g, id, dk(0), '40');
        await callFn(g.m.c, 'sheet-write', { session: id });
        g.sh.delayFirstReadMs = 2000;
        const imp = callFn(g.m.c, 'sheet-import', { member: g.m.user.id, force: true });
        const began = await started(g.sh, 'delayFirstReadMs');
        base = await saveS(g, id, dk(0), '40', { base, done: false });
        const off = await callFn(g.m.c, 'sheet-write', { session: id });
        const ir = await imp;
        const ghosts = ((await g.m.c.from('workout_sessions').select('id').eq('member_id', g.m.user.id).eq('source', 'sheet')).data ?? []).length;
        check('적대 검토 F11: 가져오기가 읽는 사이 앱이 비운 칸은 옛 내용으로 가져오지 않음(시트 기록 0)',
          began && off.body?.status === 'nothing' && g.rows()[2][4] === '' && ir.code === 200 && ir.body?.records?.saved === 0 && ghosts === 0, JSON.stringify([off.body, ir.body, ghosts, g.rows(), began, diag(g.sid, sinceG)]));
      }
      // ─── Codex v2.1.0 3차 리뷰 ───
      // P2-1: 소수 표기(40.0)는 숫자로 보내 시트에 40으로 보인다 — 앱이 쓴 칸으로 적어 두는 값도 같은 꼴(40)이고, 칸이 40.0으로 보여도 같은 값으로 본다.
      //  40 · 40.0 · 040 · 12.50 각각 처음 쓰고 → 45로 고치고 → 완료를 끄면 비운다(고치기 전 코드: 40.0은 다음 수정에서 'kept'로 남았다)
      {
        const nm = await sheetMember('DN', simpleRows());
        const out = [];
        let k = 0;
        for (const v of ['40', '40.0', '040', '12.50']) {
          const id = webcrypto.randomUUID(), day = dk(-(++k));
          let base = await saveS(nm, id, day, v);
          const w1 = await callFn(nm.m.c, 'sheet-write', { session: id });
          const col = (await linksOf(id))[0]?.col;
          const first = col === undefined ? null : nm.rows()[2][col];
          base = await saveS(nm, id, day, '45', { base });
          const w2 = await callFn(nm.m.c, 'sheet-write', { session: id });
          const edited = col === undefined ? null : nm.rows()[2][col];
          await saveS(nm, id, day, '45', { base, done: false });
          const w3 = await callFn(nm.m.c, 'sheet-write', { session: id });
          out.push({ v, first, w2: w2.body?.status, kept: w2.body?.kept, edited, cleared: col === undefined ? null : nm.rows()[2][col], links: (await linksOf(id)).length, w1: w1.body?.status, w3: w3.body?.status });
        }
        check('3차 P2-1 재현: 40·40.0·040·12.50을 처음 쓴 뒤 45로 고치고 완료를 끄면 비움(소수 표기도 앱이 쓴 칸)',
          out.every((o) => o.w1 === 'written' && o.w2 === 'written' && !(o.kept ?? []).length && o.edited === '45' && o.cleared === '' && o.links === 0) && out.map((o) => o.first).join('|') === '40|40|40|12.5',
          JSON.stringify(out));
        // 칸의 표시 형식이 소수를 보이는 경우(40 → '40.0'로 보임)도 앱이 쓴 칸 · 응답이 끊긴 쓰기(pending)도 소수 표기로 되찾음
        const id = webcrypto.randomUUID(), day = dk(-6);
        let base = await saveS(nm, id, day, '40.0');
        await callFn(nm.m.c, 'sheet-write', { session: id });
        const col = (await linksOf(id))[0]?.col;
        nm.rows()[2][col] = '40.0'; // 시트가 소수 한 자리 형식으로 보임
        base = await saveS(nm, id, day, '42.5', { base });
        const shown = await callFn(nm.m.c, 'sheet-write', { session: id });
        const afterShown = nm.rows()[2][col];
        nm.sh.dropWriteResponse = 'RAW'; // 무게 쓰기는 됐는데 응답만 끊김 → 결과 모름(unknown), 앱이 쓴 칸은 '쓰는 중'으로만 남음
        base = await saveS(nm, id, day, '50.0', { base });
        const lost = await callFn(nm.m.c, 'sheet-write', { session: id });
        await psqlR(`delete from private.sheet_write_turns where member_id = '${nm.m.user.id}'`); // 결과 모름으로 쥔 차례(60초)를 끝낸 것으로
        base = await saveS(nm, id, day, '55', { base });
        const recovered = await callFn(nm.m.c, 'sheet-write', { session: id });
        check('3차 P2-1 재현: 칸이 40.0으로 보여도 앱이 쓴 칸으로 고침(42.5) · 응답이 끊긴 50.0 쓰기도 다음 쓰기에서 되찾아 55로 고침',
          shown.body?.status === 'written' && afterShown === '42.5' && lost.body?.status === 'unknown' && recovered.body?.status === 'written' && nm.rows()[2][col] === '55',
          JSON.stringify([shown.body, afterShown, lost.body, recovered.body, nm.rows()[2]]));
        // 원래 시트에 있던 같은 값(트레이너가 적은 40)은 앱이 40.0을 저장해도 앱 칸이 아니다 — 완료를 꺼도 남는다
        const manual = dk(-5); // 새 기록은 최근 7일 안 날짜로만 만든다
        const rowsM = nm.rows();
        const freeCol = rowsM[2].findIndex((c, i) => i >= 4 && i <= 7 && !c && !(rowsM[4][i] ?? ''));
        rowsM[2][freeCol] = '40';
        rowsM[4][freeCol] = md(manual);
        const idM = webcrypto.randomUUID();
        const bM = await saveS(nm, idM, manual, '40.0');
        const wm = await callFn(nm.m.c, 'sheet-write', { session: idM });
        await saveS(nm, idM, manual, '40.0', { base: bM, done: false });
        await callFn(nm.m.c, 'sheet-write', { session: idM });
        check('3차 P2-1: 트레이너가 먼저 적은 같은 값(40)은 앱이 40.0을 저장해도 앱 칸이 아님(이미 적힌 칸으로 알림 · 완료를 꺼도 남음)',
          freeCol >= 4 && wm.body?.status === 'partial' && (wm.body?.kept ?? []).includes(SQ) && wm.body?.owned === 1 && nm.rows()[2][freeCol] === '40',
          JSON.stringify([freeCol, wm.body, nm.rows()[2]]));
      }
      // P2-2: 늦게 끝난 옛 가져오기가 더 새 가져오기의 저장을 되돌리지 않는다(작업 번호 sheet_import_begin) — 응답 순서를 뒤집은 네 꼴과 탭 정리·다시 연결
      {
        const sheetCount = async (x) => ((await x.m.c.from('workout_sessions').select('id').eq('member_id', x.m.user.id).eq('source', 'sheet')).data ?? []).length;
        const versions = async (x) => ((await x.m.c.from('routines').select('id').eq('member_id', x.m.user.id)).data ?? []).length;
        const filled = () => { const r = simpleRows(); r[2][4] = '40'; r[3][4] = '30'; r[4][4] = md(dk(-2)); return r; };
        const race = async (letter, oldBody, newBody) => {
          const x = await sheetMember(letter, simpleRows()); // 옛 내용: 회차 없음
          x.sh.delayFirstReadMs = 2500; // 옛 작업의 첫 탭 읽기가 그 순간(빈 회차)을 담아 늦게 돌아옴
          const old = callFn(x.m.c, 'sheet-import', { member: x.m.user.id, ...oldBody });
          const began = await started(x.sh, 'delayFirstReadMs');
          x.sh.rowsByTab = { [tab]: filled() }; // 시트에 회차 하나를 적음
          const fresh = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, ...newBody });
          const mid = await sheetCount(x);
          const oldR = await old;
          return { began, fresh, mid, oldR, final: await sheetCount(x), x };
        };
        const all = { mode: 'records_all' }, auto = { force: true };
        const a = await race('IA', all, all);
        check('3차 P2-2 재현: 지난 기록 가져오기 둘 — 늦게 끝난 옛 작업은 superseded(409)로 끝나고 새 작업의 기록 1회가 남음',
          a.began && a.fresh.body?.status === 'imported' && a.mid === 1 && a.oldR.code === 409 && a.oldR.body?.error === 'superseded' && a.final === 1, JSON.stringify([a.fresh.body, a.mid, a.oldR, a.final]));
        const b = await race('IB', auto, auto);
        check('3차 P2-2: 자동 반영 둘 — 옛 작업은 superseded(200)로 끝나고 새 작업의 기록이 남음',
          b.began && b.fresh.code === 200 && b.mid === 1 && b.oldR.code === 200 && b.oldR.body?.status === 'superseded' && b.final === 1, JSON.stringify([b.fresh.body, b.mid, b.oldR, b.final]));
        const c = await race('IC', auto, all);
        check('3차 P2-2: 자동 반영(옛)·지난 기록 가져오기(새) — 옛 자동 반영이 새 기록을 지우지 않음', c.began && c.mid === 1 && c.oldR.body?.status === 'superseded' && c.final === 1, JSON.stringify([c.fresh.body, c.mid, c.oldR, c.final]));
        const d = await race('ID', all, auto);
        check('3차 P2-2: 지난 기록 가져오기(옛)·자동 반영(새) — 옛 가져오기가 새 기록을 지우지 않음', d.began && d.mid === 1 && d.oldR.body?.error === 'superseded' && d.final === 1, JSON.stringify([d.fresh.body, d.mid, d.oldR, d.final]));
        // 회차 고침·지움도 되돌리지 않음: 옛 작업은 회차 40을 읽었고, 새 작업은 45로 고친 뒤 저장 → 옛 작업이 끝나도 45
        {
          const x = await sheetMember('IE', filled());
          await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, force: true });
          x.sh.delayFirstReadMs = 2500;
          const old = callFn(x.m.c, 'sheet-import', { member: x.m.user.id, force: true });
          await started(x.sh, 'delayFirstReadMs');
          const r = filled(); r[2][4] = '45';
          x.sh.rowsByTab = { [tab]: r };
          await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, force: true });
          const oldR = await old;
          const kg = ((await x.m.c.from('workout_sessions').select('sets:workout_sets(name, kg)').eq('member_id', x.m.user.id).eq('source', 'sheet')).data ?? []).flatMap((s0) => s0.sets).find((y) => y.name === SQ)?.kg;
          check('3차 P2-2: 회차 고침(40 → 45)도 늦게 끝난 옛 작업이 되돌리지 않음', oldR.body?.status === 'superseded' && kg === '45', JSON.stringify([oldR.body, kg]));
        }
        // 새 탭의 기록을 옛 작업의 탭 정리가 지우지 않음: 옛 작업은 지금 탭만 읽었고, 새 작업은 새로 생긴 지난달 탭까지 읽어 저장
        {
          const x = await sheetMember('IF', simpleRows());
          x.sh.delayFirstReadMs = 2500;
          const old = callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all' });
          await started(x.sh, 'delayFirstReadMs');
          const pr = simpleRows(); pr[2][4] = '35'; pr[3][4] = '25'; pr[4][4] = md(prevMonth);
          x.sh.tabs = [prevTab, tab];
          x.sh.rowsByTab = { [prevTab]: pr, [tab]: simpleRows() };
          const fresh = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all' });
          const oldR = await old;
          const tabs = ((await x.m.c.from('workout_sessions').select('sheet_tab').eq('member_id', x.m.user.id).eq('source', 'sheet')).data ?? []).map((s0) => s0.sheet_tab);
          check('3차 P2-2: 새 탭(지난달)의 기록을 옛 작업의 탭 정리가 지우지 않음', fresh.body?.saved === 1 && oldR.body?.error === 'superseded' && tabs.join() === prevTab, JSON.stringify([fresh.body, oldR, tabs]));
        }
        // 연결을 풀었다 같은 시트로 다시 이은 뒤 끝난 옛 작업도 반영되지 않음(연결 세대)
        {
          const x = await sheetMember('IG', filled());
          const v0 = await versions(x);
          x.sh.delayFirstReadMs = 2500;
          const old = callFn(x.m.c, 'sheet-import', { member: x.m.user.id, force: true });
          await started(x.sh, 'delayFirstReadMs');
          await x.m.c.rpc('set_routine_sheet', { p_member: x.m.user.id, p_sheet: '' });
          await x.m.c.rpc('set_routine_sheet', { p_member: x.m.user.id, p_sheet: x.sid });
          const oldR = await old;
          check('3차 P2-2: 연결을 풀었다 다시 이은 뒤 끝난 옛 작업은 기록·루틴을 남기지 않음', oldR.body?.status === 'superseded' && (await sheetCount(x)) === 0 && (await versions(x)) === v0, JSON.stringify([oldR, await sheetCount(x), v0, await versions(x)]));
        }
        // 한 작업이 여러 탭을 저장해도 자기 저장 때문에 막히지 않음(작업 번호는 저장마다 늘지 않는다)
        {
          const x = await sheetMember('IH', filled());
          const twoBack = (() => { const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - 2); return `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-10`; })();
          const t2 = ym(prevMonth), t3 = ym(twoBack);
          const mk = (dd) => { const r = simpleRows(); r[2][4] = '35'; r[3][4] = '25'; r[4][4] = md(dd); return r; };
          x.sh.tabs = [t3, t2, tab];
          x.sh.rowsByTab = { [t3]: mk(twoBack), [t2]: mk(prevMonth), [tab]: filled() };
          const r = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all' });
          check('3차 P2-2: 탭 셋을 읽는 한 작업은 자기 저장 때문에 멈추지 않음(세 탭 모두 저장)', r.code === 200 && r.body?.status === 'imported' && (await sheetCount(x)) === 3, JSON.stringify([r, await sheetCount(x)]));
        }
        check('3차 P2-2: 작업 번호 함수는 앱에서 못 부름(서버 기능만)', !!(await mR.c.rpc('sheet_import_begin', { p_member: mR.user.id, p_sheet: sidR })).error);
      }
      // ─── Codex v2.1.0 4차 리뷰 P2-1: 미리보기의 지울 수·건너뛸 수가 실제 저장·정리와 같다(행 상한 1,000개 밖까지) ───
      {
        const pvM = await sheetMember('PV', simpleRows());
        // 가져온 기록 1,001개(시트에 없는 탭 2401) — 시트의 월별 탭에는 회차가 없다
        await psqlR(`insert into public.workout_sessions (id, member_id, day, started_at, updated_at, finished, day_no, source, sheet_tab, sheet_col)
               select gen_random_uuid(), '${pvM.m.user.id}', current_date - 400, now(), now(), true, (g % 10) + 1, 'sheet', '2401', g / 10 from generate_series(0, 1000) g`);
        const pv = await callFn(pvM.m.c, 'sheet-import', { member: pvM.m.user.id, mode: 'records_all', preview: true });
        const im = await callFn(pvM.m.c, 'sheet-import', { member: pvM.m.user.id, mode: 'records_all' });
        const left = await psqlR(`select count(*) from public.workout_sessions where member_id = '${pvM.m.user.id}' and source = 'sheet'`);
        check('4차 P2-1 재현: 가져온 기록 1,001개 — 미리보기의 지울 수(1001)와 실제로 지운 수(1001)가 같음', pv.body?.removes === 1001 && im.body?.removed === 1001 && left === '0', JSON.stringify([pv.body?.removes, im.body?.removed, left]));
        // 겹침 판정: 앱 운동 기록 1,001개·앱이 쓴 칸 표시 1,001개 가운데 시트 회차와 겹치는 것이 하나씩 — 미리보기도 둘 다 건너뜀으로 셈
        const rows = simpleRows(); rows[2][4] = '40'; rows[2][5] = '42'; rows[4][4] = md(dk(-2)); rows[4][5] = md(dk(-1));
        pvM.sh.rowsByTab = { [tab]: rows };
        const gen = await psqlR(`select link_gen from public.routine_sources where member_id = '${pvM.m.user.id}'`);
        await psqlR(`with s as (insert into public.workout_sessions (id, member_id, day, started_at, updated_at, finished, day_no, source)
                          select gen_random_uuid(), '${pvM.m.user.id}', current_date - 30 - g, now(), now(), true, 1, 'app' from generate_series(1, 1000) g returning id)
               insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord) select id, '가짜 스쿼트', 1, '30', '10', true, 1 from s`);
        await psqlR(`with s as (insert into public.workout_sessions (id, member_id, day, started_at, updated_at, finished, day_no, source) values (gen_random_uuid(), '${pvM.m.user.id}', '${dk(-2)}', now(), now(), true, 1, 'app') returning id)
               insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord) select id, '가짜 스쿼트', 1, '40', '10', true, 1 from s`);
        await psqlR(`insert into public.sheet_record_links (member_id, gen, tab, day_no, col, day) select '${pvM.m.user.id}', '${gen}', '2402', (g % 10) + 1, g / 10, current_date - 400 from generate_series(0, 999) g`);
        await psqlR(`insert into public.sheet_record_links (member_id, gen, tab, day_no, col, day) values ('${pvM.m.user.id}', '${gen}', '${tab}', 1, 5, '${dk(-1)}')`);
        const pv2 = await callFn(pvM.m.c, 'sheet-import', { member: pvM.m.user.id, mode: 'records_all', preview: true });
        const im2 = await callFn(pvM.m.c, 'sheet-import', { member: pvM.m.user.id, mode: 'records_all' });
        const t2 = (pv2.body?.tabs ?? []).find((x) => x.tab === tab);
        check('4차 P2-1: 앱 기록·쓴 칸 표시가 1,000개를 넘어도 겹치는 회차(앱 기록 1·쓴 칸 1)를 미리보기와 저장이 같이 건너뜀', t2?.sessions === 0 && t2?.skipped === 2 && im2.body?.saved === 0 && im2.body?.skipped === 2, JSON.stringify([pv2.body, im2.body]));
      }
      // ─── 3차 리뷰 반영 뒤 적대 검토(2026-11-03) ───
      // 칸의 표시 형식이 숫자를 바꿔 보여도(정수 형식 12.5 → '13' · 단위 형식 40 → '40kg') 시트 쓰기는 형식 없는 값으로 읽어 앱이 쓴 칸으로 알아봄
      for (const [label, display, v, v2] of [['정수 형식', (x) => String(Math.round(Number(x))), '12.5', '15'], ['단위 형식', (x) => `${x}kg`, '40', '45']]) {
        const x = await sheetMember(label === '정수 형식' ? 'FA' : 'FB', simpleRows());
        x.sh.display = display;
        const id = webcrypto.randomUUID(), day = dk(-1);
        // Codex v2.2.0 1차 리뷰: 이 사례가 한 번 원인 모르게 실패했다(가짜 시트에 15가 남음) — 저장·쓰기 응답 셋과 그 시트의 요청 기록을 모두 남긴다
        const since = Date.now(), errs0 = rpcErrors.length;
        // 저장이 성공했는지 단계마다 확인한 뒤 시트 쓰기로 넘어간다 — 저장 실패와 시트 쓰기 실패를 가른다(Codex v2.2.0 2차 리뷰 코드 품질)
        const b1 = await saveS(x, id, day, v);
        const w1 = b1 ? await callFn(x.m.c, 'sheet-write', { session: id }) : null;
        const col = (await linksOf(id))[0]?.col;
        const b2 = b1 ? await saveS(x, id, day, v2, { base: b1 }) : null;
        const ed = b2 ? await callFn(x.m.c, 'sheet-write', { session: id }) : null;
        const edited = col === undefined ? undefined : x.rows()[2][col];
        const b3 = b2 ? await saveS(x, id, day, v2, { base: b2, done: false }) : null;
        const w3 = b3 ? await callFn(x.m.c, 'sheet-write', { session: id }) : null;
        const saved = !!(b1 && b2 && b3);
        const ok = saved && col !== undefined && ed?.body?.status === 'written' && !(ed.body?.kept ?? []).length && edited === v2 && x.rows()[2][col] === '' && (await linksOf(id)).length === 0;
        check(`적대 검토(3차 뒤): 칸이 ${label}으로 보여도 앱이 쓴 숫자로 알아봐 고치고(${v} → ${v2}) 완료를 끄면 비움`, ok,
          JSON.stringify(ok ? [ed.body, edited, x.rows()[2]] : { stage: saved ? 'sheet-write' : 'save', saves: [b1, b2, b3], w1, ed, w3, edited, row: x.rows()[2], links: (await linksOf(id)), rpcErrors: rpcErrors.slice(errs0), ...diag(x.sid, since, true) }));
      }
      // 자동 반영을 지난 기록 가져오기가 밀어내도 시트의 루틴 변경은 저장됨(지난 기록 가져오기도 가장 최근 달 탭의 루틴 판을 반영)
      {
        const x = await sheetMember('IJ', simpleRows());
        const vers = async () => ((await x.m.c.from('routines').select('id').eq('member_id', x.m.user.id)).data ?? []).length;
        const v0 = await vers();
        const changed = simpleRows();
        changed.splice(4, 0, ['', '가짜 런지', '3', '12', '', '', '', '', '1']); // 운동 하나를 더함(구성 변경)
        x.sh.rowsByTab = { [tab]: changed };
        x.sh.delayFirstReadMs = 2500;
        const old = callFn(x.m.c, 'sheet-import', { member: x.m.user.id, force: true });
        await started(x.sh, 'delayFirstReadMs');
        const fresh = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all' });
        const oldR = await old;
        const names = ((await x.m.c.from('routines').select('version, items:routine_items(name)').eq('member_id', x.m.user.id).order('version', { ascending: false }).limit(1).single()).data?.items ?? []).map((i) => i.name);
        check('적대 검토(3차 뒤): 자동 반영이 지난 기록 가져오기에 밀려도 루틴 변경(새 운동)은 새 판으로 저장됨', fresh.body?.status === 'imported' && oldR.body?.status === 'superseded' && (await vers()) === v0 + 1 && names.includes('가짜 런지'), JSON.stringify([fresh.body, oldR.body, v0, await vers(), names]));
      }
      // 월별 탭이 MAX_TABS(36)개보다 많아 오래된 탭을 읽지 않아도, 시트에 그 탭이 있으면 그 탭에서 가져온 기록은 지우지 않음 · 같은 날 두 회차는 열 순서
      {
        const monthsBack = (n) => { const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - n); return `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-10`; };
        const oldDay = monthsBack(38), oldTab = ym(oldDay);
        const x = await sheetMember('IK', simpleRows());
        const since = Date.now();
        const oldRows = simpleRows(); oldRows[2][4] = '30'; oldRows[2][5] = '32'; oldRows[4][4] = md(oldDay); oldRows[4][5] = md(oldDay); // 같은 날 두 회차(E·F열)
        x.sh.tabs = [oldTab, tab];
        x.sh.rowsByTab = { [oldTab]: oldRows, [tab]: simpleRows() };
        const first = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all' });
        const order = await psqlR(`select string_agg(sheet_col::text, ',' order by started_at) from public.workout_sessions where member_id = '${x.m.user.id}' and source = 'sheet'`);
        const many = Array.from({ length: 37 }, (_, i) => ym(monthsBack(i)));
        x.sh.tabs = [oldTab, ...many];
        x.sh.rowsByTab = Object.fromEntries([[oldTab, oldRows], ...many.map((t0) => [t0, simpleRows()])]);
        const pv = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all', preview: true });
        const again = await callFn(x.m.c, 'sheet-import', { member: x.m.user.id, mode: 'records_all' });
        const left = await psqlR(`select count(*) from public.workout_sessions where member_id = '${x.m.user.id}' and source = 'sheet' and sheet_tab = '${oldTab}'`);
        const ok = first.body?.saved === 2 && order === '4,5' && pv.body?.removes === 0 && again.body?.status === 'imported' && again.body?.removed === 0 && left === '2';
        // 실패하면 어느 요청이 시트에 닿지 못했는지 볼 수 있게 응답 전부와 그 시트의 요청 기록·서버 기능 오류 줄을 남긴다
        check('적대 검토(3차 뒤): 36개 밖의 오래된 월별 탭 기록은 시트에 그 탭이 있으면 지우지 않음(미리보기·가져오기 모두 0) · 같은 날 두 회차는 시트의 열 순서(E → F)',
          ok, JSON.stringify(ok ? [first.body, order, pv.body, again.body, left] : { first, order, pv, again, left, ...diag(x.sid, since, true) }));
      }
      // F13: 같은 이름의 운동이 블록에 둘(준비 세트·본 세트) — 세트를 루틴 항목으로 갈라 각 줄에 그 값(40·80)
      {
        const dupRows = [['', '1'], ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'], ['', '가짜 스쿼트', '1', '10', '', '', '', '', '1'], ['', '가짜 스쿼트', '3', '5', '', '', '', '', '3'], ['', '', '', '운동한 날', '']];
        const h = await sheetMember('H', dupRows);
        const its = (await h.m.c.from('routine_items').select('id, ord').eq('routine_id', h.routine.id).order('ord')).data ?? [];
        const id = webcrypto.randomUUID();
        await h.m.c.rpc('save_workout', { p_session: id, p_day: dk(0), p_routine: h.routine.id, p_day_no: 1, p_sets: [{ item_id: its[0]?.id, name: SQ, set_no: 1, kg: '40', reps: '10', done: true }, { item_id: its[1]?.id, name: SQ, set_no: 1, kg: '80', reps: '5', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() });
        const wd = await callFn(h.m.c, 'sheet-write', { session: id });
        check('적대 검토 F13: 같은 이름 두 줄에 루틴 항목별 값(40·80)', its.length === 2 && wd.body?.status === 'written' && h.rows()[2][4] === '40' && h.rows()[3][4] === '80' && sameCells((await linksOf(id))[0]?.cells, { [SQ]: '40', [`${SQ}#2`]: '80', [DT]: dk(0) }),
          JSON.stringify([its, wd.body, h.rows(), (await linksOf(id))]));
      }
      // F14: 기록이 쓴 탭을 트레이너가 지운 뒤 기록을 새 탭의 판으로 다시 저장(API로만) — 옛 자리는 없는 것으로 보고 새 탭에 씀(실패가 이어지지 않음)
      {
        const k = await sheetMember('K', simpleRows());
        k.sh.tabs = [prevTab];
        k.sh.rowsByTab = { [prevTab]: simpleRows() };
        await callFn(k.m.c, 'sheet-import', { member: k.m.user.id, force: true });
        const oldR = (await k.m.c.from('routines').select('id, source_ref').eq('member_id', k.m.user.id).order('version', { ascending: false }).limit(1).single()).data;
        const id = webcrypto.randomUUID();
        const day = dk(-1);
        const base = (await k.m.c.rpc('save_workout', { p_session: id, p_day: day, p_routine: oldR.id, p_day_no: 1, p_sets: [{ name: SQ, set_no: 1, kg: '40', reps: '10', done: true }], p_finished: true, p_save_id: webcrypto.randomUUID() })).data;
        const w1 = await callFn(k.m.c, 'sheet-write', { session: id });
        fake.set(k.sid, { tabs: [tab], rowsByTab: { [tab]: simpleRows() }, strictTabs: true });
        await callFn(k.m.c, 'sheet-import', { member: k.m.user.id, force: true });
        const newR = (await k.m.c.from('routines').select('id, source_ref').eq('member_id', k.m.user.id).order('version', { ascending: false }).limit(1).single()).data;
        await k.m.c.rpc('save_workout', { p_session: id, p_day: day, p_routine: newR.id, p_day_no: 1, p_sets: [{ name: SQ, set_no: 1, kg: '40', reps: '10', done: true }], p_finished: true, p_base: base, p_save_id: webcrypto.randomUUID() });
        const w2 = await callFn(k.m.c, 'sheet-write', { session: id });
        check('적대 검토 F14: 옛 탭이 지워졌으면 옛 표시만 내려놓고 새 탭에 씀',
          oldR?.source_ref === prevTab && w1.body?.status === 'written' && newR?.source_ref === tab && w2.code === 200 && w2.body?.status === 'written' && fake.rowsOf(k.sid, tab)[2][4] === '40' && (await linksOf(id)).length === 1,
          JSON.stringify([oldR, w1.body, newR, w2, fake.rowsOf(k.sid, tab), (await linksOf(id))]));
      }
      // F15: 결과를 모르는 쓰기의 차례는 연결을 풀었다 같은 시트로 다시 이어도 남는다 — 늦게 반영된 날짜 열을 다른 기록이 받지 않음
      {
        const v = await sheetMember('T', simpleRows());
        const a = webcrypto.randomUUID(), b = webcrypto.randomUUID();
        await saveS(v, a, dk(0), '50');
        v.sh.lateWrite = { ms: 1500 };
        const ra = await callFn(v.m.c, 'sheet-write', { session: a });
        await v.m.c.rpc('set_routine_sheet', { p_member: v.m.user.id, p_sheet: '' });
        await v.m.c.rpc('set_routine_sheet', { p_member: v.m.user.id, p_sheet: v.sid });
        const heldAfter = (await turnHeld(v.m));
        await callFn(v.m.c, 'sheet-import', { member: v.m.user.id, force: true });
        v.routine = (await v.m.c.from('routines').select('id').eq('member_id', v.m.user.id).order('version', { ascending: false }).limit(1).single()).data;
        await saveS(v, b, dk(-1), '70');
        await new Promise((r) => setTimeout(r, 2000)); // 늦은 날짜가 E열에 들어옴
        (await expireTurn(v.m));
        const rb = await callFn(v.m.c, 'sheet-write', { session: b });
        const q = v.rows();
        check('적대 검토 F15: 연결을 풀었다 같은 시트로 다시 이어도 결과를 모르는 쓰기의 차례가 남음 → 늦은 날짜 열(E)은 비켜 B는 다음 열',
          ra.body?.status === 'unknown' && heldAfter && rb.body?.status === 'written' && rb.body.col === 'F' && q[4][4] === md(dk(0)) && q[2][5] === '70' && q[4][5] === md(dk(-1)),
          JSON.stringify([ra.body, heldAfter, rb.body, q]));
      }
      // 2차 P2: 마지막 월별 탭을 지워도(읽을 수 있는 '안내' 탭만 남음) 미리보기는 가져올 0회·지울 기록 수, 맞추면 가져온 기록을 지운다(실제 지운 수로 안내)
      {
        const n = await sheetMember('N', simpleRows(true));
        const nSheet = async () => ((await n.m.c.from('workout_sessions').select('id').eq('member_id', n.m.user.id).eq('source', 'sheet')).data ?? []).length;
        const before = await nSheet();
        fake.set(n.sid, { tabs: ['안내'], rowsByTab: { 안내: [['', '운동 시트 안내']] } });
        const pvN = await callFn(n.m.c, 'sheet-import', { member: n.m.user.id, mode: 'records_all', preview: true });
        const imN = await callFn(n.m.c, 'sheet-import', { member: n.m.user.id, mode: 'records_all' });
        const after = await nSheet();
        fake.set(n.sid, { noAccess: true });
        const denied = await callFn(n.m.c, 'sheet-import', { member: n.m.user.id, mode: 'records_all', preview: true });
        check('2차 P2 재현: 월별 탭이 하나도 없으면 미리보기 0회·지울 1회, 맞추면 가져온 기록을 지움(removed 1) · 공유가 끊긴 시트는 빈 시트로 보지 않음(403)',
          before === 1 && pvN.code === 200 && pvN.body?.tabs?.length === 0 && pvN.body?.removes === 1 && imN.code === 200 && imN.body?.removed === 1 && after === 0 && denied.code === 403,
          JSON.stringify([before, pvN, imN, after, denied]));
      }
      // 연결을 풀면 가져온 기록과 쓴 칸 표시를 지움(가져온 기록은 앱에서 지울 수 없으므로)
      await mP.c.rpc('set_routine_sheet', { p_member: mP.user.id, p_sheet: '' });
      check('시트 연결을 풀면 가져온 기록·쓴 칸 표시를 지움', (await pSheet()).length === 0 && await psqlR(`select count(*) from public.sheet_record_links where member_id = '${mP.user.id}'`) === '0');
    } finally {
      console.log(`가짜 시트 요청 ${fake.counts().requests}번 · 연결 ${fake.counts().connections}개`);
      await fake.close();
    }
  }
  check('회원이 연결을 풂', !(await mX3.c.rpc('set_routine_sheet', { p_member: mX3.user.id, p_sheet: '' })).error && ((await mX3.c.from('routine_sources').select('sheet_id')).data ?? []).length === 0);
  check('내보낸 뒤 트레이너는 루틴을 못 봄', (await rs(tW.c, mW.user.id)).length === 0);
}

// ─── 2.3 회원 성별: 한 번 고르면 고정 · 본인만 읽음 · 공개하지 않기는 끄고 켬 ───
{
  const mG = await signUp(`zz검증성별${run}`, { role: 'member', trainer_id: t1.user.id });
  const read = async () => (await mG.c.rpc('my_gender')).data;
  check('2.3 성별: 처음에는 비어 있고 공개하지 않기 꺼짐', (await read())?.gender === null && (await read())?.hidden === false, JSON.stringify(await read()));
  const bad = await mG.c.rpc('set_my_gender', { p_gender: 'other' });
  check('2.3 성별: 남자·여자 말고는 거절', /bad_gender/.test(bad.error?.message ?? ''), bad.error?.message);
  const s1 = await mG.c.rpc('set_my_gender', { p_gender: 'male', p_hidden: true });
  const s2 = await mG.c.rpc('set_my_gender', { p_gender: 'male' });
  const s3 = await mG.c.rpc('set_my_gender', { p_gender: 'female' });
  check('2.3 성별: 정하면 저장 · 같은 값 다시 보내면 통과(공개 설정은 그대로) · 다른 값은 gender_locked', s1.data === 'saved' && s2.data === 'same' && /gender_locked/.test(s3.error?.message ?? '') && (await read())?.gender === 'male' && (await read())?.hidden === true, JSON.stringify([s1.data, s2.data, s3.error?.message, await read()]));
  // 성별을 정하기 전에 공개하지 않기를 켰어도 그 값이 남는다
  const mH = await signUp(`zz검증성별H${run}`, { role: 'member', trainer_id: t1.user.id });
  await mH.c.rpc('set_gender_hidden', { p_on: true });
  await mH.c.rpc('set_my_gender', { p_gender: 'female' });
  check('2.3 성별: 정하기 전에 켠 공개하지 않기는 성별을 정해도 유지', (await mH.c.rpc('my_gender')).data?.hidden === true && (await mH.c.rpc('my_gender')).data?.gender === 'female', JSON.stringify((await mH.c.rpc('my_gender')).data));
  const off = await mG.c.rpc('set_gender_hidden', { p_on: false });
  check('2.3 성별: 공개하지 않기는 언제든 끄고 켬', !off.error && (await read())?.hidden === false, off.error?.message);
  // 담당 트레이너도 표로는 읽지 못한다(profiles에 칸을 더하면 표 전체 읽기 권한으로 읽혔다 — private 표로 옮긴 이유)
  const byProfile = await t1.c.from('profiles').select('gender').eq('id', mG.user.id);
  const byTable = await t1.c.from('member_gender').select('*');
  const bySchema = await t1.c.schema('private').from('member_gender').select('*');
  check('2.3 성별: 담당 트레이너가 표로 읽지 못함(profiles 칸 없음·private 표는 앱에 안 드러남)', !!byProfile.error && !!byTable.error && !!bySchema.error, JSON.stringify([byProfile.error?.code, byTable.error?.code, bySchema.error?.code]));
  const tr = await Promise.all([t1.c.rpc('my_gender'), t1.c.rpc('set_my_gender', { p_gender: 'male' }), t1.c.rpc('set_gender_hidden', { p_on: true })]);
  check('2.3 성별: 트레이너 계정은 not_allowed', tr.every((r) => /not_allowed/.test(r.error?.message ?? '')), JSON.stringify(tr.map((r) => r.error?.message)));
  const an = await Promise.all([anon.rpc('my_gender'), anon.rpc('set_my_gender', { p_gender: 'male' }), anon.rpc('set_gender_hidden', { p_on: true })]);
  check('2.3 성별: 로그인 전에는 못 부름', an.every((r) => !!r.error), JSON.stringify(an.map((r) => r.error?.code)));
}

// ─── 2.3 공복 체중: 하루 한 값 · 회원 본인만 쓰고 담당 트레이너까지 읽음 ───
{
  const mF = await signUp(`zz검증공복${run}`, { role: 'member', trainer_id: t1.user.id });
  const mO = await signUp(`zz검증공복남${run}`, { role: 'member', trainer_id: t1.user.id });
  const tO = await signUp(`zz검증공복T${run}`, { role: 'trainer', trainer_code: CODE });
  const day = dk(-1);
  const s1 = await mF.c.rpc('save_fasting_weight', { p_day: day, p_kg: 72.46 });
  const s2 = await mF.c.rpc('save_fasting_weight', { p_day: day, p_kg: 72 });
  const mine = (await mF.c.from('fasting_weights').select('day, kg').eq('member_id', mF.user.id)).data ?? [];
  check('2.3 공복 체중: 같은 날 다시 적으면 바뀌고 하루 한 값', !s1.error && !s2.error && mine.length === 1 && Number(mine[0].kg) === 72, JSON.stringify([s1.error?.message, mine]));
  await mF.c.rpc('save_fasting_weight', { p_day: dk(-2), p_kg: 72.46 });
  const rounded = (await mF.c.from('fasting_weights').select('kg').eq('day', dk(-2)).eq('member_id', mF.user.id).single()).data;
  check('2.3 공복 체중: 소수 첫째 자리로 저장', Number(rounded?.kg) === 72.5, JSON.stringify(rounded));
  const bad = await Promise.all([mF.c.rpc('save_fasting_weight', { p_day: day, p_kg: 10 }), mF.c.rpc('save_fasting_weight', { p_day: day, p_kg: 400 }), mF.c.rpc('save_fasting_weight', { p_day: dk(3), p_kg: 70 }), mF.c.rpc('save_fasting_weight', { p_day: dk(-400), p_kg: 70 })]);
  check('2.3 공복 체중: 범위 밖 체중·미래·1년 넘은 날은 거절', /bad_weight/.test(bad[0].error?.message ?? '') && /bad_weight/.test(bad[1].error?.message ?? '') && /bad_day/.test(bad[2].error?.message ?? '') && /bad_day/.test(bad[3].error?.message ?? ''), JSON.stringify(bad.map((b) => b.error?.message)));
  const seeT = (await t1.c.from('fasting_weights').select('kg').eq('member_id', mF.user.id)).data ?? [];
  const seeO = (await mO.c.from('fasting_weights').select('kg').eq('member_id', mF.user.id)).data ?? [];
  const seeOT = (await tO.c.from('fasting_weights').select('kg').eq('member_id', mF.user.id)).data ?? [];
  const seeA = await anon.from('fasting_weights').select('kg');
  check('2.3 공복 체중: 담당 트레이너는 읽고, 다른 회원·다른 트레이너는 0건, 로그인 전 거절', seeT.length === 2 && seeO.length === 0 && seeOT.length === 0 && (!!seeA.error || !(seeA.data ?? []).length), JSON.stringify([seeT.length, seeO.length, seeOT.length, seeA.error?.code]));
  const direct = await mF.c.from('fasting_weights').insert({ member_id: mF.user.id, day: dk(-3), kg: 70 });
  const tSave = await t1.c.rpc('save_fasting_weight', { p_day: day, p_kg: 70 });
  check('2.3 공복 체중: 표에 직접 쓰지 못함 · 트레이너는 적지 못함', !!direct.error && /not_allowed/.test(tSave.error?.message ?? ''), JSON.stringify([direct.error?.code, tSave.error?.message]));
  await mO.c.rpc('delete_fasting_weight', { p_day: day });
  const kept = (await mF.c.from('fasting_weights').select('kg').eq('member_id', mF.user.id)).data ?? [];
  await mF.c.rpc('delete_fasting_weight', { p_day: day });
  const left = (await mF.c.from('fasting_weights').select('day').eq('member_id', mF.user.id)).data ?? [];
  check('2.3 공복 체중: 지우기는 내 기록만', kept.length === 2 && left.length === 1 && left[0].day === dk(-2), JSON.stringify([kept.length, left]));
}

// ─── 2.3 트레이너 한마디 모아 보기: 운동 꿀팁 표시 · 옛 앱 호환 · 담당 회원만 읽음 ───
{
  const tW2 = await signUp(`zz검증한마디T${run}`, { role: 'trainer', trainer_code: CODE });
  const mW2 = await signUp(`zz검증한마디M${run}`, { role: 'member', trainer_id: tW2.user.id });
  const mX2 = await signUp(`zz검증한마디X${run}`, { role: 'member', trainer_id: t1.user.id });
  const s1 = await tW2.c.rpc('set_trainer_message', { p_day: dk(0), p_body: '꿀팁 하나', p_is_tip: true });
  const row = async () => (await mW2.c.from('trainer_messages').select('body, is_tip').eq('day', dk(0)).maybeSingle()).data;
  check('2.3 한마디: 운동 꿀팁 표시 저장 · 담당 회원이 읽음', !s1.error && (await row())?.is_tip === true, JSON.stringify([s1.error?.message, await row()]));
  const old = await tW2.c.rpc('set_trainer_message', { p_day: dk(0), p_body: '옛 앱에서 고침' });
  check('2.3 한마디: 옛 앱(인자 둘)으로 고쳐도 꿀팁 표시 유지', !old.error && (await row())?.body === '옛 앱에서 고침' && (await row())?.is_tip === true, JSON.stringify([old.error?.message, await row()]));
  const off = await tW2.c.rpc('set_trainer_message', { p_day: dk(0), p_body: '꿀팁 아님', p_is_tip: false });
  check('2.3 한마디: 표시를 끄면 꺼짐', !off.error && (await row())?.is_tip === false);
  const other = (await mX2.c.from('trainer_messages').select('body').eq('body', '꿀팁 아님')).data ?? [];
  check('2.3 한마디: 다른 트레이너의 회원은 읽지 못함', other.length === 0);
  const mem = await mW2.c.rpc('set_trainer_message', { p_day: dk(0), p_body: '회원이 씀', p_is_tip: true });
  check('2.3 한마디: 회원은 쓰지 못함', /not_allowed/.test(mem.error?.message ?? ''), mem.error?.message);
}

// ─── 2.3 이달의 중량왕: 정확한 이름·5회 세트만 · 남녀 나눠 동작마다 무게 왕·체중 대비 왕 · 후보 조건 ───
{
  const tK = await signUp(`zz검증중량T${run}`, { role: 'trainer', trainer_code: CODE });
  const tX = await signUp(`zz검증중량X${run}`, { role: 'trainer', trainer_code: CODE });
  const mem = async (tag, gender, hidden = false, trainer = tK) => {
    const m = await signUp(`zz검증중량${tag}${run}`, { role: 'member', trainer_id: trainer.user.id });
    if (gender) await m.c.rpc('set_my_gender', { p_gender: gender, p_hidden: hidden });
    return m;
  };
  const lift = (m, sets) => m.c.rpc('save_workout', { p_session: webcrypto.randomUUID(), p_day: dk(0), p_routine: null, p_sets: sets.map(([name, kg, reps, done = true], i) => ({ item_id: null, name, set_no: i + 1, kg, reps, done })), p_finished: true, p_save_id: webcrypto.randomUUID() });
  const month = `${dk(0).slice(0, 7)}-01`;
  const prevEnd = (() => { const d = new Date(`${month}T12:00:00`); d.setDate(0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const board = async (c, mth = month) => (await c.rpc('strength_kings', { p_month: mth, p_today: dk(0) })).data;
  const cell = (b, gender, name, metric) => b?.kings.find((k) => k.gender === gender && k.lift === name && k.metric === metric);
  const who = (k) => (k?.names ?? []).map((n) => n.nickname).join('|');
  const [a, b, c, d, e, f, x, g] = [await mem('가', 'male'), await mem('나', 'male'), await mem('다', 'male'), await mem('라', 'female'), await mem('마', 'male', true), await mem('바', null), await mem('사', 'male', false, tX), await mem('아', 'female')];
  const nick = (m, tag) => `zz검증중량${tag}${run}`;
  const saved = await Promise.all([
    lift(a, [['벤치 프레스', '100', '5']]),
    lift(b, [['벤치 프레스', '90', '5'], ['벤치프레스', '200', '5'], ['벤치 프레스', '200', '6'], ['벤치 프레스', '200', '5', false], ['벤치 프레스', '20+5', '5'], ['스쿼트', '120', '5회']]),
    lift(c, [['벤치 프레스', '100.0', '5']]),
    lift(d, [['스쿼트', '60', '5'], ['데드리프트', '80', '5']]),
    lift(g, [['스쿼트', '55', '5']]),
    lift(e, [['벤치 프레스', '300', '5']]),
    lift(f, [['벤치 프레스', '300', '5']]),
    lift(x, [['벤치 프레스', '300', '5']]),
  ]);
  check('2.3 중량왕 준비: 기록 저장', saved.every((r) => !r.error), JSON.stringify(saved.map((r) => r.error?.message)));
  // 가: 그달 마지막 값이 공복 체중 · 나: 그달 기록이 없어 지난달 마지막 값 · 다: 체중 기록 없음
  await a.c.from('inbody_records').insert({ member_id: a.user.id, measured_on: prevEnd, weight_kg: 90, source: 'manual' });
  await a.c.rpc('save_fasting_weight', { p_day: dk(0), p_kg: 72 });
  await b.c.from('inbody_records').insert({ member_id: b.user.id, measured_on: prevEnd, weight_kg: 60, source: 'manual' });
  await d.c.rpc('save_fasting_weight', { p_day: dk(0), p_kg: 40 });
  await g.c.rpc('save_fasting_weight', { p_day: dk(0), p_kg: 50 });
  const seen = await board(a.c);
  const kgKing = cell(seen, 'male', '벤치 프레스', 'kg'), pctKing = cell(seen, 'male', '벤치 프레스', 'pct');
  check('2.3 중량왕 무게: 정확한 이름·5회·완료·숫자 무게만 세고 같은 무게는 공동(100과 100.0)', kgKing?.value === 100 && who(kgKing) === `${nick(a, '가')}|${nick(c, '다')}`, JSON.stringify(kgKing));
  check('2.3 중량왕 체중 대비: 정수 퍼센트 · 그달 마지막 기록, 없으면 그 전 마지막 · 체중 기록이 없으면 후보 아님', pctKing?.value === 150 && who(pctKing) === nick(b, '나') && (await board(c.c)).mine[0].pct === null, JSON.stringify(pctKing));
  check('2.3 중량왕 남녀를 나눔 · 숫자 아닌 횟수("5회")는 세지 않음', cell(seen, 'female', '스쿼트', 'kg')?.value === 60 && !cell(seen, 'male', '스쿼트', 'kg'), JSON.stringify(seen?.kings.map((k) => [k.gender, k.lift, k.metric])));
  check('2.3 중량왕: 그 동작의 무게 왕은 체중 대비가 더 높아도(150%) 왕이 못 되고 다음 회원(110%)이 됨 · 후보가 무게 왕뿐이면 칸이 빔', who(cell(seen, 'female', '스쿼트', 'kg')) === nick(d, '라') && who(cell(seen, 'female', '스쿼트', 'pct')) === nick(g, '아') && cell(seen, 'female', '스쿼트', 'pct')?.value === 110 && who(cell(seen, 'female', '데드리프트', 'kg')) === nick(d, '라') && !cell(seen, 'female', '데드리프트', 'pct'), JSON.stringify(cell(seen, 'female', '스쿼트', 'pct')));
  check('2.3 중량왕 후보 제외: 공개하지 않기·성별 미정·다른 트레이너의 회원', !JSON.stringify(seen).includes(nick(e, '마')) && !JSON.stringify(seen).includes(nick(f, '바')) && !JSON.stringify(seen).includes(nick(x, '사')));
  const me = await board(a.c);
  check('2.3 중량왕 내 기록: 내 성별·순위·체중 대비(무게 왕이라 체중 대비 순위는 없음)', me.my_gender === 'male' && me.my_state === 'ok' && me.mine.length === 1 && me.mine[0].kg === 100 && me.mine[0].kg_rank === 1 && me.mine[0].pct === 139 && me.mine[0].pct_rank === null && me.mine[0].body_kg === 72, JSON.stringify(me.mine));
  const [he, fe, tr] = [await board(e.c), await board(f.c), await board(tK.c)];
  check('2.3 중량왕 내 상태: 공개하지 않기는 성별을 쓰지 않음 · 성별 미정 · 트레이너는 표만', he.my_state === 'hidden' && he.my_gender === null && he.mine.length === 0 && fe.my_state === 'no_gender' && tr.my_state === null && tr.mine.length === 0 && tr.kings.length === seen.kings.length, JSON.stringify([he.my_state, fe.my_state, tr.my_state]));
  await a.c.rpc('set_award_public', { p_on: false });
  const [anonView, selfView] = [await board(b.c), await board(a.c)];
  check("2.3 중량왕 닉네임 공개를 끄면 다른 사람에게는 '익명 회원', 나에게는 내 닉네임", who(cell(anonView, 'male', '벤치 프레스', 'kg')).includes('익명 회원') && !JSON.stringify(anonView).includes(nick(a, '가')) && who(cell(selfView, 'male', '벤치 프레스', 'kg')).includes(nick(a, '가')));
  await a.c.rpc('set_award_public', { p_on: true });
  await e.c.rpc('set_gender_hidden', { p_on: false });
  const shown = await board(a.c);
  check('2.3 중량왕 공개하지 않기를 끄면 바로 후보', cell(shown, 'male', '벤치 프레스', 'kg')?.value === 300 && who(cell(shown, 'male', '벤치 프레스', 'kg')) === nick(e, '마'), JSON.stringify(cell(shown, 'male', '벤치 프레스', 'kg')));
  check('2.3 중량왕 지난달: 이번 달 기록은 세지 않음', (await board(a.c, `${prevEnd.slice(0, 7)}-01`))?.kings.length === 0);
  const before = await a.c.rpc('strength_kings', { p_month: '2026-10-01', p_today: dk(0) });
  check('2.3 중량왕: 수상 시작 전 달(10월)은 세지 않음', before.data?.started === false && before.data?.kings.length === 0, JSON.stringify(before.data ?? before.error));
  const bad = await Promise.all([a.c.rpc('strength_kings', { p_month: dk(0).slice(8) === '01' ? `${dk(0).slice(0, 8)}02` : dk(0), p_today: dk(0) }), a.c.rpc('strength_kings', { p_month: '2999-01-01', p_today: dk(0) }), anon.rpc('strength_kings', { p_month: month, p_today: dk(0) })]);
  const direct = await a.c.schema('private').rpc('strength_board', { p_from: month, p_to: dk(0), p_trainer: tK.user.id });
  check('2.3 중량왕 거절: 1일이 아닌 달 · 앞으로의 달 · 로그인 전 · 집계 함수 직접 호출', /bad_month/.test(bad[0].error?.message ?? '') && /bad_month/.test(bad[1].error?.message ?? '') && !!bad[2].error && !!direct.error, JSON.stringify(bad.map((r) => r.error?.message)));
}

// ─── 2.3 변화 보고서: 날마다·끼니마다 평가 · 트레이너 총평(측정 하나에 하나, 담당 트레이너만 씀) ───
{
  const tR = await signUp(`zz검증보고T${run}`, { role: 'trainer', trainer_code: CODE });
  const tO = await signUp(`zz검증보고O${run}`, { role: 'trainer', trainer_code: CODE });
  const mR = await signUp(`zz검증보고${run}`, { role: 'member', trainer_id: tR.user.id });
  const mO = await signUp(`zz검증보고남${run}`, { role: 'member', trainer_id: tO.user.id });
  const day = dk(-2);
  const ins = await mR.c.from('meals').insert([['아침', '07:00:00'], ['점심', '12:00:00'], ['저녁', '19:00:00']].map(([meal_type, eaten_at]) => ({ eaten_on: day, eaten_at, meal_type, food: '검증', note: '' }))).select('id, meal_type');
  check('2.3 보고서 준비: 식사 기록', !ins.error, ins.error?.message);
  const byType = Object.fromEntries((ins.data ?? []).map((m) => [m.meal_type, m.id]));
  const r1 = await tR.c.rpc('rate_meal', { p_meal: byType['아침'], p_rating: 1 });
  const r2 = await tR.c.rpc('rate_meal', { p_meal: byType['점심'], p_rating: 3 });
  const args = { p_member: mR.user.id, p_from: dk(-5), p_to: dk(0) };
  const own = await mR.c.rpc('diet_period', args), tv = await tR.c.rpc('diet_period', args);
  const d0 = own.data?.days?.[0], types = Object.fromEntries((own.data?.types ?? []).map((t) => [t.meal_type, t]));
  check('2.3 식단 흐름: 그날 끼니 수·평가 수·점수 합(5·1점) · 끼니별 평가 · 트레이너도 같음', !r1.error && !r2.error && own.data?.days.length === 1 && d0.meals === 3 && d0.rated === 2 && d0.score_sum === 6 && types['아침'].great === 1 && types['점심'].care === 1 && types['저녁'].none === 1 && JSON.stringify(tv.data) === JSON.stringify(own.data), JSON.stringify(own.data ?? own.error));
  const denied = await Promise.all([mO.c.rpc('diet_period', args), tO.c.rpc('diet_period', args), anon.rpc('diet_period', args), mR.c.rpc('diet_period', { ...args, p_from: dk(1) })]);
  check('2.3 식단 흐름: 다른 회원·남의 트레이너·로그인 전 거절 · 뒤집힌 기간 거절', denied.slice(0, 3).every((r) => !!r.error) && /bad_range/.test(denied[3].error?.message ?? ''), JSON.stringify(denied.map((r) => r.error?.message)));
  const rec = await mR.c.from('inbody_records').insert({ member_id: mR.user.id, measured_on: dk(-1), weight_kg: 70, source: 'manual' }).select('id').single();
  const id = rec.data?.id;
  check('2.3 총평: 처음에는 없음', !(await mR.c.rpc('report_note', { p_inbody: id })).data);
  const save = await tR.c.rpc('save_report_note', { p_inbody: id, p_body: '  하체 무게가 꾸준히 올랐어요.  ' });
  const seen = (await mR.c.rpc('report_note', { p_inbody: id })).data;
  check('2.3 총평: 담당 트레이너가 쓰면 회원이 앞뒤 공백 없이 쓴 사람과 함께 봄', !save.error && seen?.body === '하체 무게가 꾸준히 올랐어요.' && seen?.trainer === `zz검증보고T${run}`, JSON.stringify(seen ?? save.error));
  const refused = await Promise.all([mR.c.rpc('save_report_note', { p_inbody: id, p_body: '내가 씀' }), tO.c.rpc('save_report_note', { p_inbody: id, p_body: '남이 씀' }), tR.c.rpc('save_report_note', { p_inbody: id, p_body: '가'.repeat(1001) }), anon.rpc('save_report_note', { p_inbody: id, p_body: '가' }), tO.c.rpc('report_note', { p_inbody: id }), mO.c.rpc('report_note', { p_inbody: id })]);
  check('2.3 총평: 회원·남의 트레이너·로그인 전은 못 쓰고 천 자를 넘으면 거절 · 남은 못 읽음', refused.every((r) => !!r.error) && /bad_note/.test(refused[2].error?.message ?? ''), JSON.stringify(refused.map((r) => r.error?.message)));
  await tR.c.rpc('save_report_note', { p_inbody: id, p_body: '\n  앞뒤 줄바꿈 \n' });
  const nl = (await mR.c.rpc('report_note', { p_inbody: id })).data?.body;
  await tR.c.rpc('save_report_note', { p_inbody: id, p_body: '하체 무게가 꾸준히 올랐어요.' });
  check('2.3 총평: 앞뒤 줄바꿈도 지움(앱의 다듬기와 같음)', nl === '앞뒤 줄바꿈', JSON.stringify(nl));
  await mR.c.from('inbody_records').update({ measured_on: dk(-3) }).eq('id', id);
  check('2.3 총평: 측정 날짜를 고쳐도 그대로', (await mR.c.rpc('report_note', { p_inbody: id })).data?.body === seen?.body);
  await tR.c.rpc('save_report_note', { p_inbody: id, p_body: ' \n ' });
  const cleared = (await mR.c.rpc('report_note', { p_inbody: id })).data;
  await tR.c.rpc('save_report_note', { p_inbody: id, p_body: '다시 씀' });
  const del = await mR.c.from('inbody_records').delete().eq('id', id);
  const { execSync } = await import('node:child_process');
  const left = execSync(`docker exec -i supabase_db_app psql -X -t -A -U postgres -d postgres -c "select count(*) from private.report_notes where inbody_id = '${id}'"`).toString().trim();
  check('2.3 총평: 빈 글은 지움 · 측정을 지우면 함께 지워짐', !cleared && !del.error && left === '0', JSON.stringify([cleared, left]));
}

// ─── v2.1 운동 기록 탭의 서버 집계(Codex v2.1.0 3차 리뷰 P2·P3): 앱이 받는 최근 30개 밖의 기록까지 센다 ───
//  이번 달 31회 넘게 · 같은 날 두 기록 · 30개보다 긴 연속 주 · 30개 밖의 더 무거운 기록 · 지금 판의 진행(판을 받기 전 기록은 빼고) · 권한
if (/127\.0\.0\.1|localhost/.test(URL)) {
  const { execFileSync: execO } = await import('node:child_process');
  const psqlO = (q) => execO('docker', ['exec', '-i', 'supabase_db_app', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-Atq'], { input: q, encoding: 'utf8' }).trim();
  const tO = await signUp(`zz검증집T${run}`, { role: 'trainer', trainer_code: CODE });
  const tQ = await signUp(`zz검증집Q${run}`, { role: 'trainer', trainer_code: CODE });
  const mO = await signUp(`zz검증집M${run}`, { role: 'member', trainer_id: tO.user.id });
  const mP = await signUp(`zz검증집P${run}`, { role: 'member', trainer_id: tO.user.id });
  const today = dk(0);
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStartO = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - d.getDay()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const shift = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const daysInMonth = Number(today.slice(8, 10));
  const sql = [];
  const made = [];
  const add = (member, day, hour, sets, extra = {}) => {
    const id = webcrypto.randomUUID();
    made.push({ id, member, day, hour, sets, ...extra });
    sql.push(`insert into public.workout_sessions (id, member_id, day, started_at, updated_at, finished, day_no, routine_id, source, sheet_tab, sheet_col) values ('${id}', '${member}', '${day}', '${day}T${String(hour).padStart(2, '0')}:00:00+09:00', now(), true, ${extra.day_no ?? 'null'}, ${extra.routine ? `'${extra.routine}'` : 'null'}, '${extra.sheet ? 'sheet' : 'app'}', '${extra.sheet ? `t${made.length}` : ''}', ${extra.sheet ? made.length : 'null'});`);
    sets.forEach(([name, kg, done], i) => sql.push(`insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord) values ('${id}', '${name}', 1, ${kg === null ? 'null' : `'${kg}'`}, '10', ${done}, ${i + 1});`));
    return id;
  };
  // 이번 달 32회(오늘까지의 날에 고루, 같은 날 여러 번) · 지난 10주는 주마다 한 번 · 60일 전 스쿼트 100kg · 완료 세트 없는 기록 하나(세지 않음)
  for (let i = 0; i < 32; i++) add(mO.user.id, shift(monthStart, i % daysInMonth), 6 + (i % 10), [['랫풀다운', '30', true]]);
  for (let w = 1; w <= 10; w++) add(mO.user.id, shift(weekStartO, -7 * w + 1), 7, [['랫풀다운', '30', true]]);
  add(mO.user.id, shift(today, -60), 7, [['스쿼트', '100', true]]);
  add(mO.user.id, monthStart, 5, [['랫풀다운', '30', false]]);
  // 전각 숫자로 적은 무게(４０) — 비교 함수가 멈추지 않아야 한다(적대 검토: \d가 전각 숫자도 잡아 numeric 변환 오류로 그 회원의 비교 전체가 실패)
  add(mO.user.id, shift(today, -40), 7, [['스쿼트', '４０', true]]);
  // 지금 판: 오늘 만든 판(루틴 1·2) — 어제 이 판을 가리키는 기록(시트에서 다시 가져온 옛 회차와 같은 꼴)은 판을 받기 전이라 세지 않는다
  const rid = psqlO(`insert into public.routines (member_id, trainer_id, version, title, source, warmup, source_ref) values ('${mO.user.id}', '${tO.user.id}', 1, '집계 루틴', 'manual', '', '') returning id;`).split('\n')[0];
  psqlO(`insert into public.routine_items (routine_id, ord, day_no, name, weight, reps, sets, rest, note) values ('${rid}', 1, 1, '스쿼트', '40', '10', 3, '', ''), ('${rid}', 2, 2, '랫풀다운', '30', '10', 3, '', ''), ('${rid}', 3, 3, '런지', '20', '10', 3, '', '');`);
  // 판(오늘 받음)을 가리키는 기록: 어제 시트 회차(다시 가져와 새 판을 가리킴 — 안 셈) · 오늘 시트 회차(판을 받은 날 — 옛 판인지 몰라 안 셈) · 이틀 전 앱 기록(앱은 고른 판을 믿음 — 셈)
  add(mO.user.id, shift(today, -1), 8, [['스쿼트', '30', true]], { day_no: 2, routine: rid, sheet: true });
  add(mO.user.id, today, 6, [['런지', '20', true]], { day_no: 3, routine: rid, sheet: true });
  add(mO.user.id, shift(today, -2), 9, [['런지', '20', true]], { day_no: 3, routine: rid });
  // 오늘 두 번: 오전 스쿼트 40(루틴 1) · 오후 50(루틴 2)
  const am = add(mO.user.id, today, 8, [['스쿼트', '40', true]], { day_no: 1, routine: rid });
  const pm = add(mO.user.id, today, 15, [['스쿼트', '50', true]], { day_no: 2, routine: rid });
  // 다른 회원: 30개 밖 무거운 기록 없이 같은 날 40 → 50
  const am2 = add(mP.user.id, today, 8, [['스쿼트', '40', true]]);
  const pm2 = add(mP.user.id, today, 15, [['스쿼트', '50', true]]);
  psqlO(sql.join('\n'));
  const workoutRows = made.filter((x) => x.member === mO.user.id && x.sets.some(([, , done]) => done));
  const expMonth = workoutRows.filter((x) => x.day >= monthStart && x.day <= today).length;
  const expWeek = workoutRows.filter((x) => x.day >= weekStartO && x.day <= today).length;
  const ov = await mO.c.rpc('workout_overview', { p_member: mO.user.id, p_today: today });
  const o = ov.data ?? {};
  check('3차 P2-3: 이번 달 횟수는 기록 수 그대로(31회 넘게, 같은 날 여러 번 · 완료 세트 없는 기록 빼고) · 이번 주 · 30개보다 긴 연속 주(11주)',
    !ov.error && o.this_month === expMonth && expMonth > 31 && o.this_week === expWeek && o.streak_weeks === 11, JSON.stringify([ov.error?.message, o.this_month, expMonth, o.this_week, expWeek, o.streak_weeks]));
  const inRange = workoutRows.filter((x) => x.day >= o.from && x.day <= today).length;
  check('3차 P2-3: 달력 기록은 그 기간 전부(최근 30개 제한 없음 — 이번 달 1일 기록도 있음)', (o.days ?? []).length === inRange && inRange > 30 && (o.days ?? []).some((x) => x.day === monthStart && x.strength), JSON.stringify([(o.days ?? []).length, inRange, o.from]));
  check('3차 P2-4·남은 적대 검토: 지금 판의 진행 — 앱 기록은 고른 판 그대로(이틀 전 루틴 3도 셈), 시트 회차는 판을 받은 다음 날부터(어제·오늘 시트 회차 안 셈) · 가장 최근 루틴은 오후의 루틴 2',
    o.routine?.id === rid && JSON.stringify(o.routine?.last) === JSON.stringify({ 1: today, 2: today, 3: shift(today, -2) }) && o.routine?.latest_day_no === 2 && o.today === today, JSON.stringify(o.routine));
  const cmpIs = (v, prior, prev) => JSON.stringify(v?.prior ?? null) === JSON.stringify(prior) && (v?.prev ?? null) === prev;
  const cmp = await mO.c.rpc('workout_compare', { p_member: mO.user.id, p_sessions: [am, pm] });
  const cp = cmp.data ?? {};
  check('3차 P2-3·P3: 비교는 그 앞의 모든 기록 — 오후 50은 30개 밖 100보다 가볍고(prior 100), 지난번은 같은 날 오전 40(prev 40) · 오전 40의 지난번은 어제 30',
    !cmp.error && cmpIs(cp[pm]?.['스쿼트'], [100], '40') && cmpIs(cp[am]?.['스쿼트'], [100], '30'),
    JSON.stringify([cmp.error?.message, cp]));
  const cmp2 = await mP.c.rpc('workout_compare', { p_member: mP.user.id, p_sessions: [pm2, am2] });
  check('3차 P3: 같은 날 오전 40 → 오후 50이면 오후의 prior는 40(앱은 최고로 표시) · 오전은 앞 기록이 없음(prior·prev 없음)',
    !cmp2.error && cmpIs(cmp2.data?.[pm2]?.['스쿼트'], [40], '40') && cmpIs(cmp2.data?.[am2]?.['스쿼트'], null, null), JSON.stringify([cmp2.error?.message, cmp2.data]));
  const anonO = client();
  const denied = [
    await mP.c.rpc('workout_overview', { p_member: mO.user.id, p_today: today }),
    await tQ.c.rpc('workout_overview', { p_member: mO.user.id, p_today: today }),
    await anonO.rpc('workout_overview', { p_member: mO.user.id, p_today: today }),
    await mP.c.rpc('workout_compare', { p_member: mO.user.id, p_sessions: [pm] }),
    await tQ.c.rpc('workout_compare', { p_member: mO.user.id, p_sessions: [pm] }),
    await anonO.rpc('workout_compare', { p_member: mO.user.id, p_sessions: [pm] }),
  ];
  const trainerOk = await tO.c.rpc('workout_overview', { p_member: mO.user.id, p_today: today });
  check('3차 P2-3: 요약·비교는 회원 본인과 담당 트레이너만(다른 회원·다른 트레이너·로그인 전 거부)', denied.every((r) => !!r.error) && !trainerOk.error && trainerOk.data?.this_month === expMonth, JSON.stringify(denied.map((r) => r.error?.message ?? 'ok')));
  const off = await mO.c.rpc('workout_overview', { p_member: mO.user.id, p_today: shift(today, 5) });
  check('남은 적대 검토: 기기 날짜가 서버 날짜와 이틀 넘게 다르면 거절하지 않고 서버 날짜로 셈(today로 알려 줌)', !off.error && off.data?.today === today && off.data?.this_month === expMonth, JSON.stringify([off.error?.message, off.data?.today]));
}

// ─── v2.0 이달의 식단왕·운동왕: 달이 끝난 뒤 확정·공개(로컬 DB에서 지난 달 2025-01로 시험) ───
if (/127\.0\.0\.1|localhost/.test(URL)) {
  const { execFileSync } = await import('node:child_process');
  const psql = (q) => execFileSync('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', q], { encoding: 'utf8' }).trim();
  const M0 = '2025-01-01';
  psql(`delete from private.award_runs where month = '${M0}'; delete from public.monthly_awards where month = '${M0}';`);
  const prevFrom = psql(`select value from public.app_settings where key = 'workout_award_from'`);
  const prevStart = psql(`select value from public.app_settings where key = 'award_from'`);
  psql(`update public.app_settings set value = '${M0}' where key = 'workout_award_from'`);
  psql(`update public.app_settings set value = '2025-02-01' where key = 'award_from'`); // 먼저 '시작 전 달'로 시험
  try {
    const tA = await signUp(`zz검증왕T${run}`, { role: 'trainer', trainer_code: CODE });
    const tB = await signUp(`zz검증왕U${run}`, { role: 'trainer', trainer_code: CODE });
    const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map((x) => signUp(`zz검증왕${x}${run}`, { role: 'member', trainer_id: tA.user.id })));
    const e = await signUp(`zz검증왕E${run}`, { role: 'member', trainer_id: tB.user.id });
    const tC = await signUp(`zz검증왕V${run}`, { role: 'trainer', trainer_code: CODE });
    const g = await signUp(`zz검증왕G${run}`, { role: 'member', trainer_id: tC.user.id });
    const jan = (n) => `2025-01-${String(n).padStart(2, '0')}`;
    const add = async (m, n) => (await m.c.from('meals').insert(Array.from({ length: n }, (_, i) => ({ eaten_on: jan(i + 1), eaten_at: '12:00', meal_type: '점심', food: `1월 ${i + 1}`, note: '' }))).select('id')).data ?? [];
    const aM = await add(a, 10), bM = await add(b, 10);
    await add(c, 9);
    const eM = await add(e, 12);
    const gM = await add(g, 5);
    for (const x of gM) await tC.c.rpc('rate_meal', { p_meal: x.id, p_rating: 1 });
    for (const x of aM) await tA.c.rpc('rate_meal', { p_meal: x.id, p_rating: 1 });
    for (const x of bM) await tA.c.rpc('rate_meal', { p_meal: x.id, p_rating: 2 });
    for (const x of eM) await tB.c.rpc('rate_meal', { p_meal: x.id, p_rating: 1 });
    // 운동 기록: d는 8일, c는 7일(조건 미달) — 지난 날짜라 SQL로 넣는다(앱 함수는 최근 7일만)
    for (const [m, days] of [[d, 8], [c, 7], [g, 3]])
      for (let i = 1; i <= days; i++) psql(`with s as (insert into public.workout_sessions (id, member_id, day) values (gen_random_uuid(), '${m.user.id}', '${jan(i)}') returning id) insert into public.workout_sets (session_id, name, set_no, done) select id, '스쿼트', 1, true from s`);
    check('이번 달은 아직 확정하지 않음(달이 끝나기 전)', psql(`select private.publish_monthly_awards(date_trunc('month', now() at time zone 'Asia/Seoul')::date)`) === '-1');
    // 수상 시작 전 달(10월처럼, 2026-10-30 사용자 결정)은 확정하지 않고, 화면에는 '시작 전'
    check('시작 전 달은 확정하지 않음(기록도 안 남김)', psql(`select private.publish_monthly_awards('${M0}')`) === '-2' && psql(`select count(*) from private.award_runs where month = '${M0}'`) === '0');
    const pre = (await c.c.rpc('awards_for_me', { p_month: M0 })).data;
    check('시작 전 달은 started=false·시작 달 안내', pre?.started === false && pre?.starts === '2025-02-01' && pre?.published === false && pre?.winners?.length === 0, JSON.stringify(pre));
    check('운영 기본 시작 달은 2026-11(10월 수상 없음) · 운동왕도 같은 달', prevStart === '2026-11-01' && prevFrom === '2026-11-01', JSON.stringify([prevStart, prevFrom]));
    psql(`update public.app_settings set value = '${M0}' where key = 'award_from'`);
    const n1 = psql(`select private.publish_monthly_awards('${M0}')`);
    check('지난달 확정: 수상 기록 생성', Number(n1) >= 4, n1);
    check('지난달 확정: 후보가 없는 트레이너의 회원은 순위 1위여도 왕이 되지 않음', psql(`select count(*) from public.monthly_awards where month = '${M0}' and trainer_id = '${tC.user.id}'`) === '0');
    check('같은 달을 다시 실행해도 겹치지 않음', psql(`select private.publish_monthly_awards('${M0}')`) === '0' && psql(`select count(*) from public.monthly_awards where month = '${M0}' and trainer_id = '${tA.user.id}'`) === '4');
    const view = async (m) => (await m.c.rpc('awards_for_me', { p_month: M0 })).data;
    const vC = await view(c);
    const names = (kind) => (vC?.winners ?? []).filter((w) => w.kind === kind).map((w) => w.nickname).sort().join(',');
    check('평가왕 = 10끼·평가 10끼 이상 중 평균 1등', names('rating') === `zz검증왕A${run}`, JSON.stringify(vC));
    check('꾸준왕 공동 수상(최장 연속·기록일 같음)', names('streak') === [`zz검증왕A${run}`, `zz검증왕B${run}`].sort().join(','));
    check('운동왕 = 운동한 날 8일 이상 1등(7일은 후보 아님)', names('workout') === `zz검증왕D${run}`);
    // v2.1: 유산소만 한 날도 운동한 날 — 7일 회원 C에게 유산소만 한 날을 하루 더하면 같은 규칙 함수에서 8일로 D와 공동 1위(확정한 결과는 그대로)
    try { psql(`with s as (insert into public.workout_sessions (id, member_id, day) values (gen_random_uuid(), '${c.user.id}', '${jan(20)}') returning id) insert into public.workout_cardio (session_id, ord, kind, minutes) select id, 1, 'run', 30 from s`); } catch { /* 표가 없으면 아래에서 실패 */ }
    const wk = psql(`select coalesce(string_agg(member_id::text || ':' || score::int || ':' || rk, ',' order by member_id::text), '') from private.award_ranking('${M0}', '2025-01-31', true, '${tA.user.id}') where kind = 'workout'`);
    check('운동왕 규칙: 유산소만 한 날도 운동한 날(근력 7일 + 유산소 1일 → 8일 후보)', wk === [`${c.user.id}:8:1`, `${d.user.id}:8:1`].sort().join(','), wk);
    check('9끼 회원은 식단왕 후보 아님', !(vC?.winners ?? []).some((w) => w.nickname === `zz검증왕C${run}`));
    check('공개 표시(published·started)', vC?.published === true && vC?.started === true);
    check('다른 트레이너 회원에게는 이 트레이너 결과가 안 보임', !((await view(e))?.winners ?? []).some((w) => w.nickname.startsWith(`zz검증왕A`)));
    check('다른 트레이너 범위의 평가왕은 그 트레이너 회원', ((await view(e))?.winners ?? []).some((w) => w.kind === 'rating' && w.nickname === `zz검증왕E${run}` && w.is_me));
    check('트레이너도 자기 회원 결과를 봄', ((await view(tA))?.winners ?? []).length === 4);
    // 닉네임 끄기
    check('회원이 수상 닉네임 공개를 끔', !(await a.c.rpc('set_award_public', { p_on: false })).error);
    const vC2 = await view(c), vA2 = await view(a);
    check('끄면 다른 사람에게는 익명 회원', (vC2?.winners ?? []).filter((w) => w.kind === 'rating').every((w) => w.nickname === '익명 회원'));
    check('본인에게는 자기 닉네임', (vA2?.winners ?? []).some((w) => w.kind === 'rating' && w.nickname === `zz검증왕A${run}` && w.is_me));
    check('트레이너는 공개 설정을 못 바꿈(회원 설정)', !!(await tA.c.rpc('set_award_public', { p_on: false })).error);
    check('수상 표를 직접 못 읽음', ((await c.c.from('monthly_awards').select('member_id')).data ?? []).length === 0);
    check('지난 수상 달 목록', ((await c.c.rpc('award_months')).data ?? []).some((r) => r.month === M0));
    const prog = await d.c.rpc('my_award_progress', { p_today: dk(0) });
    check('이번 달 내 참여 현황(내 숫자만)', !prog.error && typeof prog.data?.meals === 'number' && typeof prog.data?.workout_days === 'number', JSON.stringify(prog.error ?? prog.data));
    check('실시간 남의 순위 함수는 없앰', !!(await c.c.rpc('monthly_kings', { p_today: dk(0) })).error);
    check('비로그인은 수상 결과 못 봄', !!(await client().rpc('awards_for_me', { p_month: M0 })).error);
    check('앱에서 확정 함수를 못 부름', !!(await tA.c.rpc('publish_monthly_awards', { p_month: M0 })).error);

    // 이번 달 현재 순위(2026-11-01 사용자 결정, 16일부터 화면에): 확정과 같은 규칙 함수(private.award_ranking)로 오늘까지 순위
    const tS = await signUp(`zz검증순T${run}`, { role: 'trainer', trainer_code: CODE });
    const [s1, s2, s3, s4, s5] = await Promise.all(['1', '2', '3', '4', '5'].map((x) => signUp(`zz검증순${x}${run}`, { role: 'member', trainer_id: tS.user.id })));
    const today = dk(0);
    const addToday = async (m, n) => (await m.c.from('meals').insert(Array.from({ length: n }, (_, i) => ({ eaten_on: today, eaten_at: '12:00', meal_type: '간식', food: `순위 ${i + 1}`, note: '' }))).select('id')).data ?? [];
    const rateAll = async (list, r) => { for (const x of list) await tS.c.rpc('rate_meal', { p_meal: x.id, p_rating: r }); };
    // 평가 평균: s1·s4 5점(동점·기록한 날 같음 → 공동 1위), s2 3점(3위), s3 1점(4위), s5는 9끼라 후보 아님
    const [m1s, m2s, m3s, m4s] = await Promise.all([addToday(s1, 12), addToday(s2, 11), addToday(s3, 10), addToday(s4, 10)]);
    await addToday(s5, 9);
    await rateAll(m1s, 1); await rateAll(m2s.slice(0, 10), 2); await rateAll(m3s, 3); await rateAll(m4s, 1);
    const st = async (m) => { const r = await m.c.rpc('award_standings', { p_today: today }); if (r.error) throw r.error; return r.data; };
    const rk = (d, kind) => (d?.rows ?? []).filter((r) => r.kind === kind).map((r) => `${r.rank}:${r.nickname.replace(run, '')}${r.is_me ? '*' : ''}`).sort().join(',');
    const v3 = await st(s3);
    check('현재 순위: 평가왕 3위까지(공동 1위 둘·3위) + 4위인 나', rk(v3, 'rating') === ['1:zz검증순1', '1:zz검증순4', '3:zz검증순2', '4:zz검증순3*'].sort().join(','), rk(v3, 'rating'));
    check('현재 순위: 꾸준왕은 10끼 이상 넷이 모두 공동 1위(9끼는 빠짐)', rk(v3, 'streak') === ['1:zz검증순1', '1:zz검증순2', '1:zz검증순3*', '1:zz검증순4'].sort().join(','), rk(v3, 'streak'));
    check('현재 순위: 이번 달 시작·운동왕 시작 표시', v3?.started === true && v3?.workout_started === true && v3?.month === `${today.slice(0, 8)}01`, JSON.stringify([v3?.started, v3?.workout_started, v3?.month]));
    const v5 = await st(s5);
    const me5 = (v5?.rows ?? []).filter((r) => r.is_me);
    check('현재 순위: 후보가 아닌 회원도 후보 뒤에 순위가 있음(9끼 → 꾸준왕 5위) · 평가받은 식사가 없으면 평가왕 순위는 없음', me5.length === 1 && me5[0].kind === 'streak' && me5[0].rank === 5 && me5[0].qualified === false, JSON.stringify(me5));
    check('현재 순위: 후보는 qualified', (v5?.rows ?? []).filter((r) => r.kind === 'streak' && r.rank === 1).every((r) => r.qualified === true));
    {
      const tN = await signUp(`zz검증순N${run}`, { role: 'trainer', trainer_code: CODE });
      const n1 = await signUp(`zz검증순가${run}`, { role: 'member', trainer_id: tN.user.id });
      const n2 = await signUp(`zz검증순나${run}`, { role: 'member', trainer_id: tN.user.id });
      await addToday(n1, 3);
      await addToday(n2, 1);
      const rows = ((await st(n2))?.rows ?? []).filter((r) => r.kind === 'streak').map((r) => `${r.rank}:${r.qualified}:${r.is_me}`).sort();
      check('현재 순위: 후보가 아무도 없는 달 초에도 순위가 보임', rows.join(',') === '1:false:false,1:false:true', rows.join(','));
    }
    check('현재 순위: 트레이너도 자기 회원 순위를 봄', rk(await st(tS), 'rating') === ['1:zz검증순1', '1:zz검증순4', '3:zz검증순2'].sort().join(','));
    check('현재 순위: 다른 트레이너 회원에게는 안 보임', !((await st(e))?.rows ?? []).some((r) => r.nickname.startsWith('zz검증순')));
    check('회원 s1이 닉네임 공개를 끔', !(await s1.c.rpc('set_award_public', { p_on: false })).error);
    const v3b = await st(s3);
    check('현재 순위: 공개를 끈 회원은 다른 사람에게 익명 회원', rk(v3b, 'rating').includes('1:익명 회원') && !v3b.rows.some((r) => r.nickname === `zz검증순1${run}`), rk(v3b, 'rating'));
    check('현재 순위: 본인에게는 자기 닉네임', rk(await st(s1), 'rating').includes('1:zz검증순1*'));
    check('현재 순위: 비로그인은 못 봄', !!(await client().rpc('award_standings', { p_today: today })).error);
    check('현재 순위: 먼 날짜는 거부', !!(await s3.c.rpc('award_standings', { p_today: '2025-01-15' })).error);
    psql(`update public.app_settings set value = '2999-01-01' where key = 'award_from'`);
    const v0 = await st(s3);
    check('현재 순위: 수상 시작 전 달은 started=false·순위 없음', v0?.started === false && v0?.rows?.length === 0, JSON.stringify(v0));
    psql(`update public.app_settings set value = '${M0}' where key = 'award_from'`);
    check('앱에서 순위 규칙 함수를 직접 못 부름', !!(await s3.c.rpc('award_ranking', { p_from: today, p_to: today, p_workout: true })).error);
  } finally {
    psql(`update public.app_settings set value = '${prevStart}' where key = 'award_from'`);
    psql(`update public.app_settings set value = '${prevFrom}' where key = 'workout_award_from'; delete from private.award_runs where month = '${M0}'; delete from public.monthly_awards where month = '${M0}';`);
  }
}

// ─── v2.4 운동 찾기 · 운동별 기록 · 지난번 · 동작별 메모(supabase/migrations/20261109000001_exercise_history_memos.sql) ───
{
  const { execFileSync } = await import('node:child_process');
  const sql = (q) => execFileSync('docker', ['exec', 'supabase_db_app', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atqc', q], { encoding: 'utf8' }).trim();
  const tF = await signUp(`zz검증찾T${run}`, { role: 'trainer', trainer_code: CODE });
  const tF2 = await signUp(`zz검증찾U${run}`, { role: 'trainer', trainer_code: CODE });
  const mF = await signUp(`zz검증찾M${run}`, { role: 'member', trainer_id: tF.user.id });
  const mF2 = await signUp(`zz검증찾N${run}`, { role: 'member', trainer_id: tF.user.id });
  const id = mF.user.id;
  // 이틀마다 32번(최근 30개 밖 포함) 벤치 프레스 두 세트 완료 + 한 세트 미완료. 다섯째는 시트 기록, 가장 오래된 것은 띄어쓰기 없는 이름.
  // 무게는 최근일수록 무겁다. 미완료 세트만 있는 스쿼트 기록과 러닝 30분 기록 하나
  sql(`with d as (select g, current_date - g * 2 as day from generate_series(1, 32) g),
        s as (insert into public.workout_sessions (id, member_id, day, day_no, source, started_at)
              select gen_random_uuid(), '${id}', d.day, 1, case when d.g = 5 then 'sheet' else 'app' end, d.day + time '10:00' from d returning id, day)
        insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord)
        select s.id, case when s.day = current_date - 64 then '벤치프레스' else '벤치 프레스' end, n, (100 - (current_date - s.day))::text, '8', n < 3, n
          from s cross join generate_series(1, 3) n`);
  sql(`with s as (insert into public.workout_sessions (id, member_id, day, day_no) values (gen_random_uuid(), '${id}', current_date - 1, 2) returning id)
        insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord) select id, '스쿼트', 1, '80', '5', false, 1 from s`);
  sql(`with s as (insert into public.workout_sessions (id, member_id, day) values (gen_random_uuid(), '${id}', current_date - 3) returning id)
        insert into public.workout_cardio (session_id, ord, kind, minutes, km) select id, 1, 'run', 30, 5 from s`);
  check('비교용 이름(DB): 앱 exerciseKey와 같은 공백 글자(U+FEFF·U+0085·전각 공백·NBSP)를 지움', sql(`select private.exercise_key(E'벤치\\uFEFF 프레스\\u0085X') || '|' || private.exercise_key(E'Lat\\u3000Pull\\u00A0Down')`) === '벤치프레스x|latpulldown');
  const list = await mF.c.rpc('exercise_list', { p_member: id });
  const bench = list.data?.strength?.find((x) => x.key === '벤치프레스');
  check('운동 찾기 목록: 띄어쓰기만 다른 이름은 한 운동 · 32번 · 마지막 이름 · 완료 세트 없는 운동은 빠짐 · 유산소는 종류로',
    !list.error && list.data.strength.length === 1 && bench?.count === 32 && bench?.name === '벤치 프레스' && list.data.cardio?.[0]?.kind === 'run' && list.data.cardio[0].count === 1, JSON.stringify(list.data ?? list.error));
  const hist = await mF.c.rpc('exercise_history', { p_member: id, p_key: '벤치프레스' });
  const days = hist.data ?? [];
  const oldest = sql(`select (current_date - 64)::text`);
  check('운동별 기록: 32번 모두(최근 30개 밖의 가장 오래된 날 포함) · 완료한 세트만 · 시트 기록 포함 · 최근 것부터',
    days.length === 32 && days[31].day === oldest && days.every((d) => d.sets.length === 2) && days.some((d) => d.source === 'sheet') && days[0].day > days[1].day, JSON.stringify(days.slice(0, 2)));
  const cardio = await mF.c.rpc('exercise_history', { p_member: id, p_key: '', p_kind: 'run' });
  check('운동별 기록: 유산소 종류', cardio.data?.length === 1 && Number(cardio.data[0].cardio[0].minutes) === 30, JSON.stringify(cardio.data ?? cardio.error));
  check('운동별 기록: 담당 트레이너도 봄', ((await tF.c.rpc('exercise_history', { p_member: id, p_key: '벤치프레스' })).data ?? []).length === 32);
  check('운동 찾기·운동별 기록: 다른 트레이너·같은 트레이너의 다른 회원에게는 비어 있음',
    ((await tF2.c.rpc('exercise_list', { p_member: id })).data?.strength ?? []).length === 0 && ((await mF2.c.rpc('exercise_history', { p_member: id, p_key: '벤치프레스' })).data ?? []).length === 0);
  check('운동 찾기·운동별 기록·지난번: 비로그인은 못 부름',
    !!(await client().rpc('exercise_list', { p_member: id })).error && !!(await client().rpc('exercise_history', { p_member: id, p_key: '벤치프레스' })).error && !!(await client().rpc('last_exercise_sets', { p_member: id, p_names: ['벤치 프레스'], p_day: dk(0) })).error);
  const last = await mF.c.rpc('last_exercise_sets', { p_member: id, p_names: ['벤치프레스', '없는 운동', '스쿼트'], p_day: dk(0) });
  const lastDay = sql(`select (current_date - 2)::text`);
  check('지난번: 마지막으로 한 날과 완료 세트 · 한 적 없는 운동·완료 세트가 없는 운동은 없음 · 이름은 받은 그대로',
    !last.error && Object.keys(last.data).join() === '벤치프레스' && last.data['벤치프레스'].day === lastDay && last.data['벤치프레스'].sets.length === 2, JSON.stringify(last.data ?? last.error));
  const skip = await mF.c.rpc('last_exercise_sets', { p_member: id, p_names: ['벤치 프레스'], p_day: dk(0), p_session: last.data['벤치프레스'].id });
  check('지난번: 지금 적는 기록은 빼고 그 앞 기록', skip.data?.['벤치 프레스']?.day === sql(`select (current_date - 4)::text`), JSON.stringify(skip.data));
  const mid = await mF.c.rpc('last_exercise_sets', { p_member: id, p_names: ['벤치 프레스'], p_day: dk(0), p_session: skip.data?.['벤치 프레스']?.id });
  check('지난번: 지난 기록을 고칠 때는 그 기록보다 앞의 기록(뒤에 한 기록은 아님)', mid.data?.['벤치 프레스']?.day === sql(`select (current_date - 6)::text`), JSON.stringify(mid.data ?? mid.error));
  sql(`insert into public.workout_sessions (id, member_id, day, day_no, started_at) values ('aaaaaaaa-0000-4000-8000-${id.slice(-12)}', '${id}', current_date - 4, 1, (current_date - 4) + time '18:00')`);
  sql(`insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord) values ('aaaaaaaa-0000-4000-8000-${id.slice(-12)}', '벤치 프레스', 1, '99', '1', true, 1)`);
  const sameDay = await mF.c.rpc('last_exercise_sets', { p_member: id, p_names: ['벤치 프레스'], p_day: dk(0), p_session: skip.data?.['벤치 프레스']?.id });
  check('지난번: 같은 날 더 늦게 한 기록은 그 날 앞 기록의 지난번이 아님', sameDay.data?.['벤치 프레스']?.day === sql(`select (current_date - 6)::text`), JSON.stringify(sameDay.data));
  check('지난번: 다른 트레이너에게는 비어 있음', Object.keys((await tF2.c.rpc('last_exercise_sets', { p_member: id, p_names: ['벤치 프레스'], p_day: dk(0) })).data ?? {}).length === 0);

  const memo = (c, args) => c.rpc('save_exercise_memo', { p_base: null, ...args });
  const m1 = await memo(mF.c, { p_member: id, p_name: '벤치 프레스', p_body: '어깨를 내리고 들기' });
  check('메모: 회원이 자기 칸에 씀', !m1.error && typeof m1.data === 'string', m1.error?.message);
  const t1 = await memo(tF.c, { p_member: id, p_name: '벤치프레스', p_body: '팔꿈치 45도' });
  check('메모: 담당 트레이너는 트레이너 칸에 씀(띄어쓰기만 다른 이름도 같은 운동)', !t1.error, t1.error?.message);
  const rowsOf = async (c) => ((await c.from('exercise_memos').select('key, author, body').eq('member_id', id)).data ?? []).map((r) => `${r.key}:${r.author}:${r.body}`).sort().join('|');
  const both = '벤치프레스:member:어깨를 내리고 들기|벤치프레스:trainer:팔꿈치 45도';
  check('메모: 회원·담당 트레이너는 두 칸을 함께 봄', (await rowsOf(mF.c)) === both && (await rowsOf(tF.c)) === both, await rowsOf(mF.c));
  check('메모: 다른 트레이너·다른 회원·비로그인은 못 봄', (await rowsOf(tF2.c)) === '' && (await rowsOf(mF2.c)) === '' && (await rowsOf(client())) === '');
  check('메모: 다른 트레이너·다른 회원은 못 씀', /not_allowed/.test((await memo(tF2.c, { p_member: id, p_name: '벤치 프레스', p_body: 'x' })).error?.message ?? '') && /not_allowed/.test((await memo(mF2.c, { p_member: id, p_name: '벤치 프레스', p_body: 'x' })).error?.message ?? ''));
  check('메모: 다른 기기가 먼저 고친 칸에 옛 기준으로 쓰면 conflict(덮어쓰지 않음)', /conflict/.test((await memo(mF.c, { p_member: id, p_name: '벤치 프레스', p_body: '덮어쓰기' })).error?.message ?? '') && (await rowsOf(mF.c)) === both);
  const m2 = await memo(mF.c, { p_member: id, p_name: '벤치 프레스', p_body: '어깨를 내리고 천천히', p_base: m1.data });
  check('메모: 읽은 시각으로 고치면 저장', !m2.error && (await rowsOf(mF.c)).includes('member:어깨를 내리고 천천히'), m2.error?.message);
  check('메모: 200자 넘으면 too_long', /too_long/.test((await memo(mF.c, { p_member: id, p_name: '스쿼트', p_body: '가'.repeat(201) })).error?.message ?? ''));
  const del = await memo(mF.c, { p_member: id, p_name: '벤치 프레스', p_body: '  ', p_base: m2.data });
  check('메모: 비우고 저장하면 그 칸만 지움', !del.error && del.data === null && (await rowsOf(mF.c)) === '벤치프레스:trainer:팔꿈치 45도', del.error?.message);
  check('메모: 표에 직접 못 넣음', !!(await mF.c.from('exercise_memos').insert({ member_id: id, key: 'x', author: 'member', name: 'x', body: 'x' })).error);
  check('메모: 비로그인은 못 씀', !!(await memo(client(), { p_member: id, p_name: '벤치 프레스', p_body: 'x' })).error);
}

// 정리: 사진 삭제 (계정은 SQL로 지운다)
const rm = await removePhoto(`${m1id}/${mealId}.jpg`);
check('회원1 사진 삭제', !rm.error, rm.error?.message);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
