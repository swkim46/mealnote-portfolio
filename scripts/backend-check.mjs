// Supabase에 시험 계정을 만들어 가입·권한 규칙을 확인한다.
// 기본은 로컬 DB: npm run check:backend (끝나면 시험 계정을 자동으로 지운다)
// 시험 계정 닉네임은 모두 "zz검증"으로 시작한다. 사진은 스크립트가 마지막에 직접 지운다.
import { createClient } from '@supabase/supabase-js';
import { webcrypto } from 'node:crypto';

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const CODE = process.env.TRAINER_CODE;
if (!URL || !KEY || !CODE) throw new Error('VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, TRAINER_CODE 필요');

const run = Date.now().toString(36).slice(-4);
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const emailOf = async (nick) => {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(nick.normalize('NFC').trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32) + '@users.mealnote.local';
};
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

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
const up = await m1.c.storage.from('meal-photos').upload(`${m1id}/${mealId}.jpg`, jpeg, { contentType: 'image/jpeg' });
check('회원1 자기 폴더에 사진 업로드', !up.error, up.error?.message);
const upOther = await m2.c.storage.from('meal-photos').upload(`${m1id}/hack.jpg`, jpeg, { contentType: 'image/jpeg' });
check('회원2가 회원1 폴더에 업로드 거부', !!upOther.error);

const ins = await m1.c.from('meals').insert({ id: mealId, eaten_on: '2026-10-20', eaten_at: '12:30', meal_type: '점심', food: '현미밥, 닭가슴살', note: '', photo_path: `${m1id}/${mealId}.jpg` }).select().single();
check('회원1 식사 등록', !ins.error, ins.error?.message);
const insForged = await m1.c.from('meals').insert({ eaten_on: '2026-10-20', eaten_at: '12:30', meal_type: '점심', food: 'x', reviewed_at: new Date().toISOString() });
check('회원이 확인 시각을 직접 넣는 것 거부', !!insForged.error);
const insByTrainer = await t1.c.from('meals').insert({ eaten_on: '2026-10-20', eaten_at: '12:30', meal_type: '점심', food: 'x' });
check('트레이너의 식사 등록 거부', !!insByTrainer.error);

// 보이는 범위
const seen = async (c) => (await c.from('meals').select('id').eq('id', mealId)).data?.length ?? -1;
check('트레이너1(담당)은 회원1 식사를 봄', (await seen(t1.c)) === 1);
check('트레이너2(비담당)는 회원1 식사를 못 봄', (await seen(t2.c)) === 0);
check('회원2는 회원1 식사를 못 봄', (await seen(m2.c)) === 0);
check('로그인 안 한 사람은 못 봄', (await seen(anon)) <= 0);

const sig = async (c) => !(await c.storage.from('meal-photos').createSignedUrl(`${m1id}/${mealId}.jpg`, 60)).error;
check('트레이너1은 사진 주소를 받음', await sig(t1.c));
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
const leftIns = await m1b.from('meals').insert({ eaten_on: '2026-10-20', eaten_at: '09:00', meal_type: '아침', food: '남은 토큰' });
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
const nm = await m2.c.from('meals').insert({ eaten_on: '2026-10-20', eaten_at: '08:00', meal_type: '아침', food: '토스트', note: '' }).select().single();
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
    check('1주일 지난 소식은 목록에서 빠짐', ((await tX.c.rpc('my_activity', {})).data ?? []).length === 0);
  }
}

// 정리: 사진 삭제 (계정은 SQL로 지운다)
const rm = await m1.c.storage.from('meal-photos').remove([`${m1id}/${mealId}.jpg`]);
check('회원1 사진 삭제', !rm.error, rm.error?.message);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
