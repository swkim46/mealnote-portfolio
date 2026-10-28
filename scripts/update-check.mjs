// 새 버전 적용 검증(v1.4, 로컬 DB 전용). 개발 서버에서는 서비스워커가 돌지 않아 실제 빌드 두세 개를 번갈아 띄운다.
// 확인: 앱으로 돌아온 순간 입력 중이 아니면 조용히 새 버전으로 바뀌고 로그인·글씨 설정이 유지된다 /
//       입력 중이면 바뀌지 않고 띠가 뜨며, '지금 적용'을 누르면 바뀐다.
import { chromium, devices } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const { createClient } = require('@supabase/supabase-js');
const URL_ = process.env.VITE_SUPABASE_URL, KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY, CODE = process.env.TRAINER_CODE;
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(URL_ ?? '')) throw new Error('로컬 DB 전용 검증입니다.');
const OUT = 'dist-update-test', PORT = 5183, BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
// 한 단계가 멈춰도 전체 검증(npm run check)이 끝없이 기다리지 않게: 5분 넘으면 마지막 단계를 알리고 실패로 끝낸다
let step = '시작';
const mark = (name) => { step = name; if (process.env.UPDATE_STEPS) console.log('STEP', name); };
const watchdog = setTimeout(() => { console.log(`FAIL  시간 초과(5분) — 멈춘 단계: ${step}`); process.exit(1); }, 5 * 60 * 1000);
watchdog.unref();
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
const build = () => execSync(`npx vite build --mode development --outDir ${OUT} --emptyOutDir`, { stdio: 'ignore' });
const emailOf = (n) => createHash('sha256').update(n.normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 32) + '@users.mealnote.local';
const run = Date.now().toString(36).slice(-4);

async function signup(n, role, trainerId) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false } });
  const t = await c.rpc('begin_signup', { p_nickname: n, p_role: role, p_question: 1, p_answer: '업데이트 검증', p_trainer_code: role === 'trainer' ? CODE : null, p_trainer_id: trainerId ?? null });
  if (t.error) throw t.error;
  const r = await c.auth.signUp({ email: emailOf(n), password: '135790', options: { data: { nickname: n, signup_ticket: t.data } } });
  if (r.error) throw r.error;
  return r.data.user.id;
}

const tn = `zz검증UT${run}`, mn = `zz검증UM${run}`;
const tid = await signup(tn, 'trainer');
await signup(mn, 'member', tid);

build();
const server = spawn('npx', ['vite', 'preview', '--mode', 'development', '--outDir', OUT, '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const browser = await chromium.launch();
try {
  await new Promise((r) => setTimeout(r, 2500));
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const buildId = () => p.evaluate(() => document.documentElement.dataset.build);
  const resume = () => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 앱으로 돌아온 순간 흉내
  await p.goto(BASE);
  await p.getByRole('button', { name: /회원으로 시작/ }).click();
  await p.getByLabel('닉네임', { exact: true }).fill(mn);
  await p.getByLabel('PIN', { exact: true }).fill('135790');
  await p.getByRole('button', { name: '로그인', exact: true }).last().click();
  await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 });
  await p.locator('.app-header .text-size-toggle').click();
  await p.evaluate(() => navigator.serviceWorker.ready);
  const a = await buildId();

  mark('1 조용히 적용');
  // 1) 입력 중이 아닐 때: 돌아온 순간 조용히 새 버전
  build();
  await resume();
  let b = a;
  for (let i = 0; i < 60 && (!b || b === a); i++) { await p.waitForTimeout(250); b = await buildId().catch(() => undefined); } // 새로고침 중의 빈 값은 건너뛴다
  check('앱으로 돌아오면 입력 중이 아닐 때 새 버전으로 바뀜', !!b && b !== a, `${a} → ${b}`);
  await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }).catch(() => {});
  check('바뀐 뒤에도 로그인 유지', (await p.getByRole('heading', { name: '오늘의 식단' }).count()) === 1);
  check('바뀐 뒤에도 큰 글씨 설정 유지', (await p.evaluate(() => document.documentElement.dataset.text)) === 'large');
  check('조용히 바뀔 때는 띠가 안 남음', (await p.locator('.update-banner').count()) === 0);

  mark('2 입력 중 띠');
  // 2) 입력 중일 때: 바뀌지 않고 띠, '지금 적용'으로 바뀜
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.getByRole('button', { name: '식단 기록하기' }).first().click();
  await p.getByLabel('무엇을 드셨나요?').fill('입력 중');
  build();
  await resume();
  await p.locator('.update-banner').waitFor({ timeout: 15000 }).catch(() => {});
  check('입력 중이면 띠만 뜸', (await p.locator('.update-banner', { hasText: '새 버전이 준비됐어요' }).count()) === 1);
  await p.waitForTimeout(1500);
  check('입력 중에는 바뀌지 않음(입력 내용 유지)', (await buildId()) === b && (await p.getByLabel('무엇을 드셨나요?').inputValue()) === '입력 중');
  // 입력 창이 떠 있는 동안에는 창 바깥(띠 포함)을 누를 수 없다 → 다 쓰고 창을 닫은 뒤 띠를 누르는 흐름
  await p.getByRole('button', { name: '창 닫기' }).click();
  check('창을 닫으면 띠가 보이고 누를 수 있음', await p.getByRole('button', { name: '지금 적용' }).isEnabled());
  await p.getByRole('button', { name: '지금 적용' }).click();
  let c = b;
  for (let i = 0; i < 60 && (!c || c === b); i++) { await p.waitForTimeout(250); c = await buildId().catch(() => undefined); }
  check("'지금 적용'을 누르면 새 버전", !!c && c !== b, `${b} → ${c}`);
  await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }).catch(() => {});
  check('적용 뒤에도 로그인 유지', (await p.getByRole('heading', { name: '오늘의 식단' }).count()) === 1);

  mark('3 다음 복귀 때 적용');
  // 3) 띠를 누르지 않고 두면: 다음에 앱으로 돌아올 때 자동으로 바뀐다
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.getByRole('button', { name: '식단 기록하기' }).first().click();
  await p.getByLabel('무엇을 드셨나요?').fill('입력 중');
  build();
  await resume();
  await p.locator('.update-banner').waitFor({ timeout: 15000 }).catch(() => {});
  await p.getByRole('button', { name: '창 닫기' }).click();
  await p.waitForTimeout(500);
  const before = await buildId();
  await resume(); // 다른 앱에 다녀온 뒤 돌아옴
  let d = before;
  for (let i = 0; i < 60 && (!d || d === before); i++) { await p.waitForTimeout(250); d = await buildId().catch(() => undefined); }
  check('띠를 그냥 두면 다음에 돌아올 때 자동으로 바뀜', !!d && d !== before, `${before} → ${d}`);

  mark('4a 로그인 칸');
  // 4) 시트 밖에서 쓰던 글(Codex 리뷰 v1.4 P2): 트레이너 한마디를 쓰다 커서를 옮겨도, 저장 전이면 바뀌지 않는다
  const tctx = await browser.newContext({ ...devices['iPhone 13'] });
  const t = await tctx.newPage();
  // 화면이 새로 고쳐지는 순간의 evaluate는 응답 없이 멈출 수 있다 → 3초 제한(Codex 재검토·자체 재현에서 이 단계가 멈춤)
  const timed = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate 3초 초과')), 3000))]);
  const tBuild = () => timed(t.evaluate(() => document.documentElement.dataset.build));
  const tResume = () => timed(t.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))).catch(() => {});
  if (process.env.UPDATE_STEPS) { t.on('crash', () => console.log('CRASH 화면 프로세스 죽음')); t.on('close', () => console.log('CLOSE')); t.on('request', (r) => r.isNavigationRequest() && console.log('NAVREQ', new Date().toISOString().slice(17, 23), r.url())); t.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText)); }
  if (process.env.UPDATE_STEPS) { t.on('framenavigated', (f) => f === t.mainFrame() && console.log('NAV', new Date().toISOString().slice(17, 23), f.url())); t.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 120))); }
  // 새로 고치는 순간 페이지 쪽 대기가 끊길 수 있어 대기는 Node에서 한다(Codex 재검토에서 이 단계가 멈춤)
  const waitChange = async (from) => { let x = from; for (let i = 0; i < 80 && (!x || x === from); i++) { await new Promise((r) => setTimeout(r, 250)); x = await tBuild().catch((e) => (process.env.UPDATE_STEPS && console.log('BUILD?', e.message), undefined)); } return x; };
  await t.goto(BASE);
  await t.getByRole('button', { name: /트레이너로 시작/ }).click();
  await t.getByLabel('닉네임', { exact: true }).fill(tn);
  await t.getByLabel('PIN', { exact: true }).fill('135790');
  // 로그인 칸에 입력한 채 다른 앱에 다녀와도 화면이 새로 고쳐지지 않는다
  await t.evaluate(() => navigator.serviceWorker.ready);
  build();
  const loginBuild = await tBuild();
  await t.locator('body').click({ position: { x: 5, y: 5 } }); // 커서를 입력칸 밖으로
  await tResume();
  await t.locator('.update-banner').waitFor({ timeout: 15000 }).catch(() => {});
  await t.waitForTimeout(5000); // 서비스워커가 아직 맡지 않은 화면은 적용 3초 뒤에 새로 고쳐진다 → 그보다 길게 본다
  check('로그인 칸에 입력한 채 돌아와도 바뀌지 않음(입력 유지·띠만)', (await tBuild()) === loginBuild && (await t.getByLabel('PIN', { exact: true }).inputValue()) === '135790' && (await t.locator('.update-banner').count()) === 1);
  if (await t.getByLabel('PIN', { exact: true }).count() === 0 || !(await t.getByLabel('PIN', { exact: true }).inputValue())) {
    await t.getByRole('button', { name: /트레이너로 시작/ }).click().catch(() => {});
    await t.getByLabel('닉네임', { exact: true }).fill(tn);
    await t.getByLabel('PIN', { exact: true }).fill('135790');
  }
  mark('4b 트레이너 로그인');
  await t.getByRole('button', { name: '로그인', exact: true }).last().click();
  await t.getByRole('heading', { name: '확인할 식단' }).waitFor({ timeout: 15000 });
  mark('4c 서비스워커 준비');
  await t.evaluate(() => navigator.serviceWorker.ready);
  mark('4d 한마디 초안');
  await t.getByRole('button', { name: '한마디 쓰기' }).click();
  await t.locator('.today-word textarea').fill('아직 저장하지 않은 한마디');
  await t.getByRole('heading', { name: '확인할 식단' }).click(); // 커서를 입력칸 밖으로
  build();
  const t0 = await tBuild();
  await tResume();
  await t.locator('.update-banner').waitFor({ timeout: 15000 }).catch(() => {});
  await t.waitForTimeout(5000);
  const kept = (await t.locator('.today-word textarea').count()) === 1 && (await t.locator('.today-word textarea').inputValue()) === '아직 저장하지 않은 한마디';
  check('커서가 떠나도 저장 전 한마디가 있으면 바뀌지 않음(띠만)', (await tBuild()) === t0 && kept && (await t.locator('.update-banner').count()) === 1);
  if (!kept) throw new Error('한마디 초안이 사라짐 — 이후 단계 생략');
  mark('4e 한마디 저장 뒤 적용');
  await t.getByRole('button', { name: '저장', exact: true }).click();
  await t.locator('.today-word', { hasText: '오늘 회원들에게 보이는 내 한마디' }).waitFor({ timeout: 10000 });
  await tResume();
  const t1 = await waitChange(t0);
  check('한마디를 저장한 뒤 돌아오면 새 버전으로 바뀜', !!t1 && t1 !== t0, `${t0} → ${t1}`);
  if (!t1 || t1 === t0) {
    // 진단: 화면 상태를 못 읽은 순간의 주소·화면·직접 읽기(10초 제한)를 남긴다
    const probe = await Promise.race([t.evaluate(() => ({ ready: document.readyState, build: document.documentElement.dataset.build, sw: !!navigator.serviceWorker.controller })), new Promise((r) => setTimeout(() => r('10초 무응답'), 10000))]).catch((e) => e.message);
    console.log('DIAG', t.url(), JSON.stringify(probe));
    const sws = tctx.serviceWorkers().map((w) => w.url());
    const other = await tctx.newPage();
    const fresh = await Promise.race([other.goto(BASE).then(() => other.evaluate(() => ({ build: document.documentElement.dataset.build, sw: !!navigator.serviceWorker.controller }))), new Promise((r) => setTimeout(() => r('새 탭도 10초 무응답'), 10000))]).catch((e) => e.message);
    console.log('DIAG2 서비스워커', JSON.stringify(sws), '같은 컨텍스트 새 탭', JSON.stringify(fresh));
    await Promise.race([t.screenshot({ path: 'test-results/update-stuck.png' }), new Promise((r) => setTimeout(r, 10000))]).catch(() => {});
  }
  await tctx.close();

  // 5) 두 탭(Codex 재검토 v1.4 r3 P2): 같은 브라우저에서 입력 없는 탭이 새 버전을 적용해도, 입력 중인 다른 탭은 새로 고치지 않는다.
  //    서비스워커·새로고침은 실제 그대로 둔다(가로채지 않음). 미룬 탭은 '지금 적용'으로 최신 빌드가 열린다.
  mark('5 두 탭');
  const two = await browser.newContext({ ...devices['iPhone 13'] });
  const A = await two.newPage();
  const B = await two.newPage();
  const bounded = (pr, ms = 5000) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`${ms / 1000}초 초과`)), ms))]);
  const buildOf = (pg) => bounded(pg.evaluate(() => document.documentElement.dataset.build)).catch(() => undefined);
  const controlled = (pg) => bounded(pg.evaluate(() => !!navigator.serviceWorker.controller)).catch(() => false);
  await A.goto(BASE);
  await A.evaluate(() => navigator.serviceWorker.ready);
  await A.reload(); // 서비스워커가 이미 맡은 화면으로
  await A.waitForLoadState('networkidle');
  await A.getByRole('button', { name: /트레이너로 시작/ }).click();
  await A.getByLabel('닉네임', { exact: true }).fill('저장전닉네임');
  await A.getByLabel('PIN', { exact: true }).fill('135790');
  await A.locator('body').click({ position: { x: 5, y: 5 } }); // 커서를 입력칸 밖으로
  await B.goto(BASE);
  await B.waitForLoadState('networkidle');
  const aBefore = await buildOf(A);
  check('두 탭 모두 서비스워커가 맡은 화면', (await controlled(A)) && (await controlled(B)));
  build();
  await B.bringToFront();
  await bounded(B.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))).catch(() => {});
  let bAfter = aBefore;
  for (let i = 0; i < 80 && (!bAfter || bAfter === aBefore); i++) { await new Promise((r) => setTimeout(r, 250)); bAfter = await buildOf(B); }
  check('입력 없는 탭은 새 버전으로 바뀜', !!bAfter && bAfter !== aBefore, `${aBefore} → ${bAfter}`);
  await new Promise((r) => setTimeout(r, 4000));
  const aAfter = await buildOf(A);
  const nick = (await A.getByLabel('닉네임', { exact: true }).count()) ? await A.getByLabel('닉네임', { exact: true }).inputValue() : null;
  check('다른 탭이 적용해도 입력 중인 탭은 새로 고치지 않음(입력 유지·띠)', aAfter === aBefore && nick === '저장전닉네임' && (await A.locator('.update-banner').count()) === 1, JSON.stringify({ aBefore, aAfter, nick }));
  await A.bringToFront();
  await A.getByRole('button', { name: '지금 적용' }).click().catch(() => {});
  let aNew = aBefore;
  for (let i = 0; i < 80 && (!aNew || aNew === aBefore); i++) { await new Promise((r) => setTimeout(r, 250)); aNew = await buildOf(A); }
  check("미룬 탭에서 '지금 적용'을 누르면 최신 빌드", !!aNew && aNew === bAfter, `${aBefore} → ${aNew} (B ${bAfter})`);
  await Promise.race([two.close(), new Promise((r) => setTimeout(r, 10000))]);
} finally {
  await browser.close();
  server.kill();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
