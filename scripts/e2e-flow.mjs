// 회원·트레이너 두 사람의 화면 흐름을 실제 브라우저(Playwright)로 확인한다.
// 기본: 개발 서버를 직접 띄워 로컬 Supabase에 대고 돈다.  npm run check:e2e
// 운영 주소 점검(배포 직후 필요할 때만): BASE=https://<운영 주소> node --env-file=.env.local scripts/e2e-flow.mjs
//   끝나면 반드시 sh scripts/cleanup-test-users.sh linked
// 시험 계정 닉네임은 "zz검증"으로 시작한다. 화면은 test-results/e2e/에 저장된다.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sheetHtml, SAMPLE } from './inbody-sheet.mjs';
import { startFakeSheets, sheetRows } from './fake-sheets.mjs';
import { failureLedger } from './failure-ledger.mjs';
execFileSync('node', ['scripts/copy-ocr-assets.mjs']); // 인바디 글자 인식 파일(public/ocr)

const PORT = 5179;
const CODE = process.env.TRAINER_CODE;
if (!CODE || !process.env.ADMIN_CODE) throw new Error('TRAINER_CODE·ADMIN_CODE가 없습니다(.env.local).');
const OUT = process.env.OUT || 'test-results/e2e';
mkdirSync(OUT, { recursive: true });

let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  // 휴대폰과 같은 조건(https 아님)으로 검증하려고 localhost 대신 맥의 와이파이 IP로 접속한다.
  // localhost는 브라우저가 안전한 주소로 취급해서, https에서만 되는 기능을 쓴 버그를 놓친다(2026-10-21 식단 저장 실패).
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  BASE = `http://${lan ? lan.address : 'localhost'}:${PORT}`;
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('개발 서버가 30초 안에 뜨지 않았습니다.')), 30000);
    server.stdout.on('data', (d) => { if (String(d).includes(`${PORT}`)) { clearTimeout(timer); resolve(); } });
    server.on('exit', (c) => reject(new Error('개발 서버 종료: ' + c)));
  });
}
const stopServer = () => { if (server) server.kill(); };
process.on('exit', stopServer);

// 실행 번호: check.sh가 주면 그것(정리를 이 실행 것만 하도록), 따로 돌리면 새로 만든다
const run = process.env.CHECK_RUN || Date.now().toString(36).slice(-4);
const T = `zz검증코치${run}`, M = `zz검증회원${run}`, PIN = '135790';
let pass = 0, fail = 0; const errors = [];
// 일부러 만든 실패 응답의 기록(Codex v2.0.2 1차 리뷰 P3): 여기 기록한 요청 하나의 오류만 '브라우저 오류 없음'에서 한 번 뺀다
const ledger = failureLedger();
/** 시험이 지어낸 실패 응답: 그 요청을 기록하고 실패로 돌려준다 */
const fakeFail = (route, status, message, why) => {
  ledger.allow({ method: route.request().method(), url: route.request().url(), status, why, message });
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message }) });
};
/** 서버가 실제로 돌려주는 실패(틀린 PIN 등): 돌려받은 함수로 닫을 때까지 그 주소·상태로 끝난 요청을 max번까지 기록한다(track의 응답 감시) */
const watching = [];
const expectFail = (path, status, why, max = 1) => {
  const w = { path, status, why, left: max };
  watching.push(w);
  return () => watching.splice(watching.indexOf(w), 1);
};
const check = (label, ok, extra='') => { ok ? pass++ : fail++; console.log(`${ok?'PASS':'FAIL'}  ${label}${extra?'  '+extra:''}`); };
const soft = async (label, fn) => { try { await fn(); check(label, true); } catch (e) { check(label, false, String(e.message).split('\n')[0]); } };

const browser = await chromium.launch();
// 2.0 시작 안내는 기기마다 처음 한 번 뜬다 — 안내를 시험하는 창 말고는 '이 기기에서 이미 봤음'으로 열어 다른 화면을 가리지 않게 한다
const newCtx = async (opts) => { const c = await browser.newContext(opts); await c.addInitScript(() => { try { localStorage.setItem('mealnote:start-guide', '2.0'); localStorage.setItem('mealnote:setup-nudge', '9999-12-31'); localStorage.setItem('mealnote:whats-new', '2.3'); } catch { /* 저장소 없음 */ } }); c.on('page', (p) => track(p)); return c; };
// 아이폰은 글씨가 16px보다 작은 입력칸에 초점이 가면 화면을 확대한다(v1.8.2): 보이는 입력칸이 모두 16px 이상인지
const smallInputs = (p) => p.evaluate(() => [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select")]
  .filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => `${e.getAttribute('aria-label') || e.labels?.[0]?.textContent?.trim().slice(0, 12) || e.tagName}:${getComputedStyle(e).fontSize}`));
// 2.0 아래 탭으로 이동(회원 식단·운동·커뮤니티·설정 / 트레이너 확인·회원·커뮤니티·설정)
const goTab = (p, name) => p.locator('.bottom-nav .nav-item').filter({ hasText: new RegExp(`^${name}`) }).click();
// 설정 탭의 화면 테마·글씨 크기(2.0: 머리글 버튼 대신 설정에만, 로그인 화면은 그대로)
const setTheme = async (p, label) => { await goTab(p, '설정'); await p.getByRole('group', { name: '화면 테마' }).getByRole('button', { name: label }).click(); };
// 검증이 중간에 멈추면(잡히지 않은 오류) 그 순간의 화면·주소·최근 화면 이동·서버 요청을 남긴다(Codex v2.0.0 정식 2차 리뷰 후속 개선):
// 앱 상태 문제인지 검증 환경 문제인지 가르려고. 창마다 최근 기록만 고리처럼 25개씩 둔다
const tracked = [];
// 실패 응답(4xx·5xx)의 시각·페이지·본문: '브라우저 오류 없음'이 실패하면 함께 남겨 어느 단계의 무슨 거절인지 바로 보이게 한다(2026-11-02 meal_streak 400 진단)
const failedResponses = [];
const keep = (list, line) => { list.push(`${new Date().toISOString().slice(11, 23)} ${line}`); if (list.length > 25) list.shift(); };
// 기록 처리기의 예외가 검증을 멈추지 않게 한 번 감싼다(기록은 진단용이라 실패해도 넘어간다)
const safe = (fn) => (...a) => { try { fn(...a); } catch { /* 기록만 빠진다 */ } };
const track = (p) => {
  const log = { nav: [], req: [] };
  tracked.push({ p, log });
  p.on('framenavigated', safe((f) => { if (f === p.mainFrame()) keep(log.nav, f.url()); }));
  p.on('response', safe((r) => { if (/\/(rest|functions|auth|storage)\/v1\//.test(r.url())) keep(log.req, `${r.request().method()} ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 160)}`); }));
  p.on('requestfailed', safe((r) => { if (/\/(rest|functions|auth|storage)\/v1\//.test(r.url())) keep(log.req, `${r.method()} FAILED ${r.failure()?.errorText ?? ''} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 160)}`); }));
  p.on('response', (r) => {
    if (r.status() < 400 || !/\/(rest|functions)\/v1\//.test(r.url())) return;
    const at = new Date().toISOString().slice(11, 23), page = tracked.findIndex((x) => x.p === p);
    r.text().then((body) => failedResponses.push({ at, page, status: r.status(), method: r.request().method(), path: new URL(r.url()).pathname, body: body.slice(0, 200) }), () => {});
  });
  p.on('response', safe((r) => {
    if (r.status() < 400) return;
    const w = watching.find((x) => x.left > 0 && x.status === r.status() && new URL(r.url()).pathname.endsWith(x.path));
    if (!w) return;
    w.left--;
    ledger.allow({ method: r.request().method(), url: r.url(), status: r.status(), why: w.why });
  }));
};
let crashed = false;
const onCrash = async (e) => {
  if (crashed) return;
  crashed = true;
  const report = { error: String(e?.stack ?? e), pass, fail, base: BASE, browserErrors: errors.slice(-20), pages: [] };
  for (const [i, { p, log }] of tracked.entries()) {
    if (p.isClosed()) continue;
    const file = `${OUT}/crash-${i}.png`;
    await p.screenshot({ path: file, fullPage: true }).catch(() => {});
    report.pages.push({ index: i, url: p.url(), screenshot: file, dialogs: await p.locator('dialog[open]').count().catch(() => -1), ...log });
  }
  writeFileSync(`${OUT}/crash.json`, JSON.stringify(report, null, 2));
  console.log(`FAIL  검증이 중간에 멈춤: ${String(e?.message ?? e).split('\n')[0]}`);
  console.log(`      멈춘 순간 기록: ${OUT}/crash.json · 화면 ${report.pages.length}장(crash-N.png)`);
  console.log(`\n${pass} PASS / ${fail + 1} FAIL   (nick suffix ${run})`);
  await browser.close().catch(() => {});
  stopServer();
  process.exit(1);
};
process.on('uncaughtException', (e) => void onCrash(e));
process.on('unhandledRejection', (e) => void onCrash(e));
const mk = async () => { const c = await newCtx({ ...devices['iPhone 13'] }); const p = await c.newPage();
  p.on('pageerror', e => errors.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type()==='error') errors.push('console: ' + m.text() + (m.location()?.url ? ' @ ' + m.location().url : '')); }); return p; };
const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });
const ANSWER = '어바웃 타임';
const fillRecovery = async (p, answer = ANSWER, question = '가장 좋아하는 영화 제목은?') => {
  await p.getByLabel('PIN을 잊었을 때 쓸 질문').selectOption({ label: question });
  await p.getByLabel('답', { exact: true }).fill(answer);
};
const LOCAL = !process.env.BASE;
const sql = async (q) => { const { execSync } = await import('node:child_process'); execSync(`supabase db query --local "${q}"`, { stdio: 'ignore' }); };
// 글씨가 커져도 가로로 넘치는 곳이 없어야 한다(화면 전체·본문·시트)
// 아이폰 사파리는 날짜·시각 입력칸을 글자 폭만큼(약 160px) 그린다 — 크롬에서는 안 보여 베타 식단 탭 가로 스크롤을 놓쳤다(2026-10-30).
// 잴 때만 그 고유 폭을 우선순위 0(:where)으로 흉내 낸다: 앱이 최소 폭을 풀어 둔 칸은 영향이 없고, 방어가 빠진 칸만 넘친다
const noOverflow = (p, label) => soft(`가로 넘침 없음: ${label}`, async () => {
  const bad = await p.evaluate(async () => {
    const st = document.createElement('style');
    st.textContent = ':where(input[type=date], input[type=time]){min-width:160px}';
    document.head.append(st);
    await new Promise((r) => requestAnimationFrame(() => r()));
    const out = [document.documentElement, ...document.querySelectorAll('.prototype, .app-main, dialog[open] .sheet-body, .bottom-nav, .summary-grid, .filters')]
      .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className || e.tagName} ${e.scrollWidth}>${e.clientWidth}`);
    st.remove();
    return out;
  });
  if (bad.length) throw new Error(bad.join(', '));
});

// 사진용 PNG 만들기 (큰 이미지 → 앱이 800px로 줄이는지 확인)
const tmp = await mk();
await tmp.setViewportSize({ width: 1200, height: 900 });
await tmp.setContent('<body style="margin:0;background:linear-gradient(135deg,#f6c,#fc6 50%,#6cf)"><h1 style="font:bold 120px sans-serif;padding:200px">식단 사진</h1></body>');
await tmp.screenshot({ path: `${OUT}/upload.png` });
// 인바디 인식용 가짜 결과지(지어낸 값). 실제 결과지 사진은 쓰지 않는다.
await tmp.setViewportSize({ width: 1600, height: 2260 });
await tmp.setContent(sheetHtml(SAMPLE));
await tmp.screenshot({ path: `${OUT}/inbody_sheet.png` });
await tmp.context().close();

// 1. 트레이너 가입
const t = await mk();
await t.goto(BASE);
await t.getByRole('button', { name: /트레이너로 시작/ }).click();
await t.getByRole('button', { name: '처음이에요' }).click();
await soft('트레이너 가입 닉네임 안내', () => t.getByText('회원이 알아볼 수 있게 지어 주세요').waitFor({ timeout: 5000 }));
await t.getByLabel('닉네임', { exact: true }).fill(T);
await t.getByLabel('PIN', { exact: true }).fill(PIN);
await t.getByLabel('PIN 확인').fill(PIN);
await t.getByLabel('트레이너 등록 코드').fill('WRONG123');
await soft('가입 화면에 복구 질문과 경고', () => t.getByText('답을 잊으면 PIN을 되찾을 수 없어요').waitFor({ timeout: 5000 }));
await fillRecovery(t, '슬램덩크', '가장 좋아하는 책이나 만화 제목은?');
const wrongCode = expectFail('/rest/v1/rpc/begin_signup', 400, '틀린 트레이너 등록 코드');
await t.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('틀린 등록 코드 → 안내 문구', () => t.getByText('트레이너 등록 코드가 맞지 않아요').waitFor({ timeout: 10000 }));
wrongCode();
await t.getByLabel('트레이너 등록 코드').fill(CODE.toLowerCase());
await t.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('트레이너 가입 → 확인 탭', () => t.getByRole('heading', { name: '확인', exact: true }).waitFor({ timeout: 15000 }));
await goTab(t, '커뮤니티');
await soft('트레이너 커뮤니티 탭에 기본 문구 카드(2.0에서 확인 목록 위 → 커뮤니티)', () => t.locator('.today-word', { hasText: '오늘 회원들에게 보이는 기본 문구' }).waitFor({ timeout: 10000 }));
await goTab(t, '확인');
await shot(t, '01_trainer_empty');

// 2. 회원 가입 (트레이너 선택)
const m = await mk();
await m.goto(BASE);
// 회원은 큰 글씨로 진행한다(나이 있는 회원 시나리오)
await m.getByRole('button', { name: '큰 글씨로 보기' }).click();
await soft('로그인 화면에서 큰 글씨 켜짐', async () => { const v = await m.evaluate(() => document.documentElement.dataset.text); if (v !== 'large') throw new Error(String(v)); });
await shot(m, '01b_auth_large');
await noOverflow(m, '큰 글씨 첫 화면');
await m.getByRole('button', { name: /회원으로 시작/ }).click();
await m.getByRole('button', { name: '처음이에요' }).click();
await soft('가입 화면에 방금 가입한 트레이너가 보임', () => m.getByRole('radio', { name: T }).waitFor({ timeout: 10000 }));
await shot(m, '02_member_signup');
await soft('회원 가입 닉네임 안내', () => m.getByText('트레이너가 알아볼 수 있게 지어 주세요').waitFor({ timeout: 5000 }));
await m.getByLabel('닉네임', { exact: true }).fill(M);
await m.getByLabel('PIN', { exact: true }).fill(PIN);
await m.getByLabel('PIN 확인').fill(PIN);
await m.getByRole('radio', { name: T }).click();
await fillRecovery(m);
// 2.3 성별: 미리 골라 두지 않아 고르지 않으면 가입되지 않는다
await soft('가입 화면: 성별이 미리 골라져 있지 않음', async () => { const n = await m.getByRole('group', { name: '성별' }).locator('button[aria-pressed="true"]').count(); if (n !== 0) throw new Error(`${n}개`); });
await m.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('성별을 고르지 않으면 안내', () => m.getByText('성별을 선택해 주세요.').waitFor({ timeout: 5000 }));
await m.getByRole('group', { name: '성별' }).getByRole('button', { name: '여자' }).click();
await m.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('회원 가입 → 식단 탭', () => m.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));
await soft('식단 탭 맨 위에 오늘의 한마디 한 줄(기본 문구)', () => m.getByTestId('today-word').filter({ hasText: '오늘의 한마디' }).waitFor({ timeout: 10000 }));
await soft('기록 전 요약 한 줄: 오늘 0끼(연속 표시 없음)', async () => { const t = await m.getByTestId('streak').innerText({ timeout: 10000 }); if (!/오늘\s*0끼/.test(t) || /연속/.test(t)) throw new Error(t); });

// 2b. 화면 테마(v1.4.2, 2.0부터 두 테마 모두 라임 대표색): 라이트 · 다크. 기기마다 기억, 큰 글씨와 독립, 입력·열린 창 유지
const themeOf = (p) => p.evaluate(() => document.documentElement.dataset.theme);
const themeBtn = (p, label) => p.getByRole('group', { name: '화면 테마' }).getByRole('button', { name: label });
await soft('첫 방문 기본은 라이트', async () => { if ((await themeOf(m)) !== 'light') throw new Error(await themeOf(m)); });
await soft('머리글에는 제목과 종 버튼만(2.0 — 테마·글씨 버튼은 설정으로)', async () => { const n = await m.locator('.app-header .theme-toggle, .app-header .text-size-toggle').count(); if (n) throw new Error(`${n}개`); });
await setTheme(m, '다크');
await soft('설정에서 다크 선택 → 즉시 적용·저장·버튼 상태', async () => {
  const [t, saved, pressed] = await Promise.all([themeOf(m), m.evaluate(() => localStorage.getItem('mealnote:theme')), themeBtn(m, '다크').getAttribute('aria-pressed')]);
  if (t !== 'dark' || saved !== 'dark' || pressed !== 'true') throw new Error(JSON.stringify({ t, saved, pressed }));
});
await soft('테마를 바꿔도 큰 글씨는 그대로', async () => { const v = await m.evaluate(() => document.documentElement.dataset.text); if (v !== 'large') throw new Error(String(v)); });
await shot(m, '02b_member_dark');
await noOverflow(m, '다크 큰 글씨 설정 화면');
await goTab(m, '식단');
await noOverflow(m, '다크 큰 글씨 식단 화면');
await m.setViewportSize({ width: 320, height: 640 });
await noOverflow(m, '320px 다크 큰 글씨 식단 화면');
await soft('320px 큰 글씨에서도 상단 설정이 제목과 같은 줄', async () => {
  const [h, c] = await Promise.all([m.locator('.app-header h2').boundingBox(), m.locator('.app-header .header-controls').boundingBox()]);
  if (!h || !c || c.y > h.y + h.height || c.y + c.height < h.y) throw new Error(JSON.stringify({ h, c }));
});
await soft('320px에서 상단 설정이 화면 안에', async () => {
  const r = await m.locator('.app-header .header-controls').boundingBox();
  if (!r || r.x < 0 || r.x + r.width > 321) throw new Error(JSON.stringify(r));
});
await shot(m, '02c_member_dark_320');
await m.setViewportSize(devices['iPhone 13'].viewport);
// 열린 창에 입력 중일 때 다른 탭에서 테마를 바꿈 → 이 탭은 색만 바뀌고 창·입력은 그대로
await m.getByRole('button', { name: '식단 기록하기' }).first().click();
await m.getByLabel('무엇을 드셨나요?').fill('테마 바꾸는 중 입력');
const other = await m.context().newPage();
await other.goto(BASE);
await other.locator('.bottom-nav').waitFor({ timeout: 15000 });
await setTheme(other, '라이트'); // 지금 다크 → 라이트
await soft('다른 탭에서 라이트로 바꾸면 이 탭도 따라가고 열린 창·입력은 그대로', async () => {
  await m.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 5000 });
  const v = await m.getByLabel('무엇을 드셨나요?').inputValue();
  if (v !== '테마 바꾸는 중 입력' || !(await m.locator('dialog[open]').count())) throw new Error(v);
});
await other.close();
await m.getByRole('button', { name: '창 닫기' }).click();
await setTheme(m, '다크');
await soft('설정의 다크 버튼이 눌린 상태', async () => {
  const a = await themeBtn(m, '다크').getAttribute('aria-pressed');
  if (a !== 'true' || (await themeOf(m)) !== 'dark') throw new Error(JSON.stringify({ a }));
});
await shot(m, '02d_member_dark_me');
await m.reload({ waitUntil: 'domcontentloaded' });
await soft('새로고침해도 다크, 첫 화면부터(앱 코드가 뜨기 전에) 적용', async () => {
  const early = await themeOf(m);
  await m.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 });
  if (early !== 'dark' || (await themeOf(m)) !== 'dark') throw new Error(String(early));
});
await goTab(m, '식단');
// 저장값이 이상하거나 저장할 수 없는 기기
await soft('알 수 없는 저장값은 라이트', async () => {
  const c = await newCtx({ ...devices['iPhone 13'] });
  await c.addInitScript(() => localStorage.setItem('mealnote:theme', 'purple'));
  const p = await c.newPage(); await p.goto(BASE); await p.waitForLoadState('domcontentloaded');
  const t = await themeOf(p); await c.close();
  if (t !== 'light') throw new Error(String(t));
});
await soft('저장할 수 없는 기기에서도 이번 화면은 바로 바뀜', async () => {
  const c = await newCtx({ ...devices['iPhone 13'] });
  await c.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; });
  const p = await c.newPage(); await p.goto(BASE); await p.getByRole('button', { name: /회원으로 시작/ }).waitFor({ timeout: 15000 });
  await p.locator('.auth .theme-toggle').click();
  const t = await themeOf(p); await c.close();
  if (t !== 'dark') throw new Error(String(t));
});

// 3. 회원 식단 등록 (사진 포함)
await m.getByRole('button', { name: '식단 기록하기' }).first().click();
// 사진 찍기·앨범 고르기 나눔(2026-10-31 회원 의견 — 안드로이드 크롬은 이미지 칸에 카메라를 보이지 않음): 찍기 칸은 카메라를 바로 연다(capture)
await soft('사진 찍기 입력에 capture=environment 지정, 앨범 입력에는 미지정(실제 카메라 실행은 실기기 확인)', async () => {
  const cam = m.locator('input[aria-label="식사 사진 찍기"]'), album = m.locator('input[aria-label="식사 사진 선택"]');
  if ((await cam.getAttribute('capture')) !== 'environment' || (await cam.getAttribute('accept')) !== 'image/*' || (await album.getAttribute('capture')) !== null) throw new Error('속성');
});
await noOverflow(m, '큰 글씨 사진 찍기·앨범 버튼');
await m.locator('input[aria-label="식사 사진 찍기"]').setInputFiles(`${OUT}/upload.png`);
await soft('찍은 사진도 미리보기에 들어옴', () => m.getByAltText('선택한 식사 사진 미리보기').waitFor({ timeout: 10000 }));
await m.locator('input[aria-label="식사 사진 선택"]').setInputFiles(`${OUT}/upload.png`);
await soft('사진 미리보기 표시', () => m.getByAltText('선택한 식사 사진 미리보기').waitFor({ timeout: 10000 }));
await m.getByLabel('무엇을 드셨나요?').fill('현미밥 반 공기, 닭가슴살, 샐러드');
await m.getByLabel('트레이너에게 한마디').fill('드레싱은 조금만 했어요.');
await shot(m, '03_member_form');
await noOverflow(m, '큰 글씨 식단 등록');
// Codex 재검토 P2: 새 등록의 응답만 끊겨도 사진을 지우면 안 된다 — 서버엔 보내고 앱에는 실패만 돌려준다
let lostCreate = 0;
const mealsUrl = (url) => new URL(url).pathname.endsWith('/rest/v1/meals');
await m.route(mealsUrl, async (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  await route.fetch();
  lostCreate++;
  return fakeFail(route, 500, 'network lost', '식단 등록 응답 끊김(서버엔 저장)');
});
await m.getByRole('button', { name: '식단 등록하기' }).click();
await soft('등록 완료 토스트(응답이 끊겨도 실제 등록을 확인)', async () => {
  await m.locator('.toast.visible', { hasText: '식단을 등록했어요' }).waitFor({ timeout: 15000 });
  if (lostCreate < 1) throw new Error('응답 끊기 시험이 실제로 일어나지 않음');
});
await m.unroute(mealsUrl);
await soft('오늘 목록에 카드 + 사진', async () => {
  const img = m.locator('.meal-card .meal-image img').first();
  await img.waitFor({ timeout: 10000 });
  const w = await img.evaluate(el => el.complete ? el.naturalWidth : new Promise(r => el.onload = () => r(el.naturalWidth)));
  if (!(w > 0 && w <= 800)) throw new Error('naturalWidth=' + w);
});
await m.waitForTimeout(800);
await shot(m, '04_member_today');
await soft('첫 식사 뒤 요약 한 줄: 오늘 1끼 · 연속 1일', () => m.getByTestId('streak').filter({ hasText: '1끼' }).filter({ hasText: '연속 1일' }).waitFor({ timeout: 10000 }));
await soft('연속 기록은 라임 배지(오늘 남김)로 크게', async () => { const pill = m.getByTestId('streak').locator('.streak-pill.on'); await pill.waitFor({ timeout: 5000 }); const fs = await pill.locator('b').evaluate((e) => parseFloat(getComputedStyle(e).fontSize)); if (fs < 20) throw new Error(`숫자 ${fs}px`); });
await noOverflow(m, '큰 글씨 오늘 화면');

// 4. 트레이너 확인
await t.reload();
await goTab(t, '커뮤니티');
await t.getByRole('button', { name: '한마디 쓰기' }).click();
await t.locator('.today-word textarea').fill('오늘은 물 2리터 도전해 봐요!');
await t.getByRole('button', { name: '저장', exact: true }).click();
await soft('트레이너 한마디 저장', () => t.locator('.today-word', { hasText: '오늘 회원들에게 보이는 내 한마디' }).filter({ hasText: '물 2리터' }).waitFor({ timeout: 10000 }));
await goTab(t, '확인');
await soft('트레이너 확인 목록에 회원 식사가 뜸', () => t.locator('.meal-card', { hasText: M }).waitFor({ timeout: 15000 }));
await soft('확인 목록 탭에 건수 1', async () => { const txt = await t.locator('.nav-item').first().innerText(); if (!/1/.test(txt)) throw new Error(txt); });
await soft('등록 때 남긴 말이 답변 대기로 잡힘', () => t.locator('.meal-card .status', { hasText: '답변 대기' }).waitFor({ timeout: 5000 }));
await soft('카드에 등록 때 남긴 말이 바로 보임', () => t.locator('.meal-card.has-question .question-snippet', { hasText: '드레싱은 조금만' }).waitFor({ timeout: 5000 }));
await shot(t, '05_trainer_queue');
await noOverflow(t, '보통 글씨 확인 목록');
await t.locator('.meal-card', { hasText: M }).click();
await soft('상세 맨 위에 등록 때 남긴 말', () => t.locator('.question-callout', { hasText: '드레싱은 조금만' }).waitFor({ timeout: 5000 }));
await soft('대화 첫 메시지로 등록 때 남긴 말', () => t.locator('dialog .message.member', { hasText: '드레싱은 조금만' }).first().waitFor({ timeout: 5000 }));
await soft('상세에 사진이 보임', async () => { const img = t.locator('img.detail-photo'); await img.waitFor({ timeout: 10000 });
  const w = await img.evaluate(el => el.complete ? el.naturalWidth : new Promise(r => el.onload = () => r(el.naturalWidth))); if (!(w > 0)) throw new Error('w=' + w);
  const h = await img.evaluate((el) => el.getBoundingClientRect().height); if (h !== 260) throw new Error(`트레이너 상세 사진 영역 높이 ${h}`); });
await soft('보통 글씨 트레이너 상세의 입력칸도 16px 이상(아이폰 확대 방지, v1.8.2)', async () => { const small = await smallInputs(t); if (small.length) throw new Error(small.join(', ')); });
await t.getByLabel('회원에게 피드백').fill('단백질 좋아요. 저녁엔 채소를 더 곁들여 보세요.');
await t.getByRole('button', { name: '피드백 보내기' }).click();
await soft('피드백 전송 토스트', () => t.getByText('피드백을 남겼어요').waitFor({ timeout: 10000 }));
await soft('상세 상태 피드백 완료', () => t.locator('dialog .status', { hasText: '피드백 완료' }).waitFor({ timeout: 5000 }));
await t.locator('dialog .rating-panel').getByRole('button', { name: '아주 좋아요' }).click();
await soft('상세에서 평가 → 고른 버튼이 눌린 상태(v1.4)', () => t.locator('dialog .rating-button[aria-pressed=true]', { hasText: '아주 좋아요' }).waitFor({ timeout: 10000 }));
await shot(t, '06_trainer_detail');
await noOverflow(t, '보통 글씨 식사 상세');
await t.getByRole('button', { name: '창 닫기' }).click();
await soft('미확인 필터가 비워짐', () => t.getByText('모두 확인했어요').waitFor({ timeout: 5000 }));

// 5. 회원: 새 피드백 → 읽음 → 추가 질문
await m.reload();
await soft('회원 식단 탭 한마디 한 줄에 트레이너 한마디', () => m.getByTestId('today-word').filter({ hasText: `${T} 트레이너` }).filter({ hasText: '물 2리터' }).waitFor({ timeout: 15000 }));
await soft('한마디는 식단 탭 맨 위 한 곳에만(2.0 — 모든 탭 반복 배너를 줄임)', async () => {
  const first = await m.locator('.app-main > *').first().getAttribute('data-testid');
  if (first !== 'today-word') throw new Error(`맨 위 ${first}`);
  for (const tab of ['운동', '커뮤니티', '설정']) { await goTab(m, tab); if (await m.getByTestId('today-word').count()) throw new Error(`${tab} 탭에도 있음`); }
  await goTab(m, '식단');
});
await m.getByTestId('today-word').locator('.today-line-head').click();
await m.locator('[data-testid=today-word] .like-button').click();
await soft('한마디를 펼쳐 좋아요 → 눌린 상태(v1.8)', () => m.locator('[data-testid=today-word] .like-button[aria-pressed=true]').waitFor({ timeout: 10000 }));
await noOverflow(m, '큰 글씨 오늘의 한마디 펼침');
await soft('식단 탭에 빨간 점·받은 피드백 개수', async () => {
  await m.locator('.nav-item', { hasText: '식단' }).locator('.nav-dot').waitFor({ timeout: 15000 });
  await m.getByTestId('feedback-entry').locator('.count-badge').waitFor({ timeout: 5000 });
});
await m.getByTestId('feedback-entry').click();
await soft('피드백 카드에 NEW', () => m.locator('.feedback-card .new-badge').waitFor({ timeout: 5000 }));
await soft('피드백 카드에 트레이너 평가', () => m.locator('.feedback-card .rating-chip', { hasText: '아주 좋아요' }).waitFor({ timeout: 5000 }));
await shot(m, '07_member_feedback');
await noOverflow(m, '큰 글씨 받은 피드백');
await m.locator('.feedback-card').first().click();
await soft('상세에 트레이너 댓글', () => m.locator('dialog').getByText('단백질 좋아요').waitFor({ timeout: 5000 }));
await m.waitForTimeout(1500);
await m.getByLabel('트레이너에게 추가 질문').fill('저녁엔 어떤 채소가 좋을까요?');
await m.getByRole('button', { name: '질문 남기기' }).click();
await soft('질문 토스트', () => m.getByText('질문을 남겼어요').waitFor({ timeout: 10000 }));
await soft('상태 답변 대기', () => m.locator('dialog .status', { hasText: '답변 대기' }).waitFor({ timeout: 5000 }));
await shot(m, '08_member_detail');
await noOverflow(m, '큰 글씨 식사 상세');
await m.getByRole('button', { name: '창 닫기' }).click();
// 0.5초 뒤 한 번만 보면 읽음 저장 응답이 늦을 때 흔들린다(2026-10-30 1.8.3 검증에서 1회) → 최대 5초 동안 점이 사라지기를 기다린다
await soft('읽은 뒤 피드백 탭 빨간 점 사라짐(기기·서버 시계가 달라도)', async () => { let tabs = []; for (let i = 0; i < 20; i++) { tabs = await m.locator('.nav-item:has(.nav-dot)').allInnerTexts(); if (!tabs.some((t) => t.includes('식단'))) return; await m.waitForTimeout(250); } throw new Error('dot on: ' + tabs.join('|')); });

// 6. 트레이너: 답변 대기
await t.reload();
await goTab(t, '커뮤니티');
await soft('트레이너 한마디 카드에 좋아요 1명 → 누르면 이름(v1.8)', async () => {
  await t.locator('.today-word .like-count', { hasText: '1명' }).click({ timeout: 10000 });
  await t.getByTestId('likers').filter({ hasText: M }).waitFor({ timeout: 5000 });
});
await goTab(t, '확인');
await t.getByRole('button', { name: '답변 대기' }).click();
await soft('답변 대기 필터에 식사', () => t.locator('.meal-card', { hasText: M }).waitFor({ timeout: 15000 }));
await soft('트레이너 카드에 질문 내용이 바로 보임', () => t.locator('.meal-card.has-question .question-snippet', { hasText: '어떤 채소가 좋을까요' }).waitFor({ timeout: 5000 }));
await shot(t, '08b_trainer_question_card');
await t.locator('.meal-card', { hasText: M }).click();
await soft('상세 맨 위에 답변을 기다리는 질문', () => t.locator('.question-callout', { hasText: '어떤 채소가 좋을까요' }).waitFor({ timeout: 5000 }));
await shot(t, '08c_trainer_question_detail');
// '답변 없이 확인'(Codex v1.8.3 3차 리뷰): 저장 응답을 1.5초 늦추는 동안 위·아래 확인 버튼이 모두 잠기고 저장은 한 번만,
// 저장 직후 그 식사 다시 받기를 한 번 실패시켜도 '처리 실패'가 아니라 저장됐다는 안내, 3초 뒤 다시 받아 강조가 사라진다.
// 이 단계가 실패하면 저장·다시 받기 요청의 시각·상태를 함께 남긴다(6번 중 1번 났던 간헐 실패를 다시 만나면 원인을 보려고)
const ackLog = [];
const ackT0 = Date.now();
const ackAt = () => `${Date.now() - ackT0}ms`;
let ackSaves = 0, failNextMeal = false;
const isAckSave = (u) => new URL(u).pathname.endsWith('/rpc/mark_reviewed');
const isMealFetch = (u) => { const x = new URL(u); return x.pathname.endsWith('/rest/v1/meals') && x.searchParams.has('id'); };
await t.route(isAckSave, async (r) => {
  ackSaves++;
  ackLog.push(`저장 시작 ${ackAt()}`);
  await new Promise((x) => setTimeout(x, 1500));
  const resp = await r.fetch();
  ackLog.push(`저장 ${resp.status()} ${ackAt()}`);
  failNextMeal = true;
  return r.fulfill({ response: resp });
});
await t.route(isMealFetch, async (r) => {
  if (failNextMeal) {
    failNextMeal = false;
    ackLog.push(`다시 받기 500(일부러) ${ackAt()}`);
    return fakeFail(r, 500, 'down', '확인 처리 직후 식사 다시 받기 실패');
  }
  const resp = await r.fetch();
  ackLog.push(`다시 받기 ${resp.status()} ${ackAt()}`);
  return r.fulfill({ response: resp });
});
const withLog = (fn) => async () => { try { await fn(); } catch (e) { throw new Error(`${String(e?.message ?? e).split('\n')[0]} | ${ackLog.join(', ')}`); } };
// 위·아래 확인 버튼을 같은 순간 번갈아 누른다 — 버튼이 잠기기 전에 들어온 두 번째 누름도 실행 함수의 잠금이 막는지(Codex v1.8.4 1차 리뷰)
await t.locator('.question-ack').waitFor({ timeout: 5000 });
await t.evaluate(() => {
  const top = document.querySelector('.question-ack');
  const bottom = document.querySelector('.review-button');
  top.click();
  bottom.click();
  top.click();
});
await soft('확인 처리 중에는 위·아래 확인 버튼 모두 잠기고 확인 중 표시', withLog(async () => {
  await t.locator('.question-ack', { hasText: '확인 중…' }).waitFor({ timeout: 1000 });
  if (!(await t.locator('.question-ack').isDisabled()) || !(await t.locator('.review-button').isDisabled())) throw new Error('잠기지 않음');
}));
await soft('답변 없이 확인 → 저장 뒤 다시 받기가 실패해도 저장됐다는 안내(처리 실패 아님)', withLog(async () => {
  await t.locator('.toast.visible', { hasText: '답변 없이 확인했어요' }).filter({ hasText: '화면은 잠시 뒤 새로 받아요' }).waitFor({ timeout: 6000 });
  if (await t.getByText('처리하지 못했어요').count()) throw new Error('처리 실패 안내가 보임');
}));
check('위·아래 확인 버튼을 번갈아 눌러도 저장 요청은 한 번', ackSaves === 1, `${ackSaves}번 · ${ackLog.join(', ')}`);
await soft('확인 뒤 상세 맨 위 질문 강조가 사라짐(잠시 뒤 다시 받아 맞춤)', withLog(() => t.locator('.question-callout').waitFor({ state: 'detached', timeout: 8000 })));
await t.unroute(isAckSave);
await t.unroute(isMealFetch);
await t.getByRole('button', { name: '창 닫기' }).click();
await soft('답변 대기 목록에서 빠짐', () => t.getByText('모두 확인했어요').waitFor({ timeout: 5000 }));
await m.reload();
await soft('회원 화면에서도 답변 대기가 풀림', async () => {
  await m.locator('.meal-card').first().waitFor({ timeout: 10000 });
  const st = await m.locator('.meal-card .status').first().innerText();
  if (st.includes('답변 대기')) throw new Error(st);
});
await goTab(t, '회원');
await soft('담당 회원 목록에 회원', () => t.locator('.member-row', { hasText: M }).waitFor({ timeout: 10000 }));
await soft('담당 회원 목록에 연속 기록', () => t.locator('.member-row', { hasText: M }).filter({ hasText: '1일 연속' }).waitFor({ timeout: 10000 }));
await shot(t, '09_trainer_members');
await t.locator('.member-row', { hasText: M }).click();
await soft('회원별 기록 화면', () => t.getByRole('heading', { name: `${M} 회원` }).waitFor({ timeout: 5000 }));
await shot(t, '10_trainer_member_detail');

// 7. 회원: 수정 → 삭제
await m.getByRole('button', { name: '식단으로' }).click().catch(() => {});
await goTab(m, '식단');
await m.locator('.meal-card').first().click();
await m.getByRole('button', { name: '수정', exact: true }).click();
await m.getByLabel('무엇을 드셨나요?').fill('현미밥 반 공기, 닭가슴살, 샐러드, 방울토마토');
await m.getByRole('button', { name: '수정 저장하기' }).click();
await soft('수정 반영', () => m.locator('dialog .detail-food', { hasText: '방울토마토' }).waitFor({ timeout: 10000 }));
// Codex 재검토 P2: 사진을 안 바꾼 수정이 실제로 실패하면 실패로 알려야 한다
await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
const failPatch = (url) => new URL(url).pathname.endsWith('/rest/v1/meals');
await m.route(failPatch, (route) => (route.request().method() === 'PATCH' ? fakeFail(route, 500, 'db down', '글만 고친 수정의 저장 실패') : route.continue()));
await m.getByRole('button', { name: '수정', exact: true }).click();
await m.getByLabel('무엇을 드셨나요?').fill('저장되면 안 되는 내용');
await m.getByRole('button', { name: '수정 저장하기' }).click();
await soft('글만 고친 수정의 실제 실패는 실패로 안내', () => m.locator('.toast.visible', { hasText: '저장하지 못했어요' }).waitFor({ timeout: 15000 }));
await m.unroute(failPatch);
await m.getByRole('button', { name: '창 닫기' }).click();
await m.locator('.meal-card', { hasText: '방울토마토' }).first().click();
await soft('실패한 수정 내용은 남지 않음', () => m.locator('dialog .detail-food', { hasText: '방울토마토' }).waitFor({ timeout: 10000 }));

// Codex 재검토 P2: 저장은 됐는데 응답만 끊긴 경우 새 사진을 지우면 안 된다 — 서버엔 보내고 앱에는 실패만 돌려준다
let lostResponses = 0;
const mealsPatch = (url) => new URL(url).pathname.endsWith('/rest/v1/meals');
await m.route(mealsPatch, async (route) => {
  if (route.request().method() !== 'PATCH') return route.continue();
  await route.fetch();
  lostResponses++;
  return fakeFail(route, 500, 'network lost', '사진 바꾼 수정의 응답 끊김(서버엔 저장)');
});
await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
await m.getByRole('button', { name: '수정', exact: true }).click();
await m.locator('input[aria-label="식사 사진 선택"]').setInputFiles(`${OUT}/upload.png`);
await m.getByAltText('선택한 식사 사진 미리보기').waitFor({ timeout: 10000 });
await m.getByRole('button', { name: '수정 저장하기' }).click();
await soft('저장 응답이 끊겨도 실제 저장을 확인해 성공 처리', async () => {
  await m.locator('.toast.visible', { hasText: '수정했어요' }).waitFor({ timeout: 15000 });
  if (lostResponses < 1) throw new Error('응답 끊기 시험이 실제로 일어나지 않음');
});
await m.unroute(mealsPatch);
await soft('바꾼 사진이 남아 있음(끊긴 경로 아님)', async () => {
  const img = m.locator('img.detail-photo');
  await img.waitFor({ timeout: 10000 });
  const w = await img.evaluate((el) => (el.complete ? el.naturalWidth : new Promise((r) => { el.onload = () => r(el.naturalWidth); el.onerror = () => r(0); })));
  if (!(w > 0)) throw new Error('photo broken');
  const h = await img.evaluate((el) => el.getBoundingClientRect().height);
  if (h !== 260) throw new Error(`상세 사진 영역 높이 ${h}`);
});
await m.getByRole('button', { name: '삭제' }).click();
await m.getByRole('button', { name: '한 번 더 누르면 삭제돼요' }).click();
await soft('삭제 토스트', () => m.getByText('식단을 삭제했어요').waitFor({ timeout: 10000 }));
// 2.1: 빈 날은 끼니 네 칸이 모두 '그 끼니 기록하기'(따로 빈 화면 안내 없음)
await soft('오늘 목록 비워짐(끼니 네 칸 모두 기록하기)', async () => {
  for (const t of ['아침', '점심', '저녁', '간식']) await m.getByTestId(`meal-slot-${t}`).getByRole('button', { name: `${t} 기록하기` }).waitFor({ timeout: 5000 });
  if (await m.locator('.meal-slots .meal-card').count()) throw new Error('카드가 남음');
});

// 7g. 2.0 시작 안내(정식 배포 때 나감): 이 기기에서 처음 열면 한 번, 다섯 쪽, 그림 안내 다녀오기, 닫은 뒤 다시 안 뜸, 설정에서 다시 보기, 트레이너 내용
{
  const loginFresh = async (who, name) => {
    const c = await browser.newContext({ ...devices['iPhone 13'] }); // '봤음' 기록이 없는 새 기기
    await c.addInitScript(() => localStorage.setItem('mealnote:setup-nudge', '9999-12-31'));
    c.on('page', (p) => track(p));
    const p = await c.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await p.goto(BASE);
    await p.getByRole('button', { name: who === 'member' ? /회원으로 시작/ : /트레이너로 시작/ }).click();
    await p.getByLabel('닉네임', { exact: true }).fill(name);
    await p.getByLabel('PIN', { exact: true }).fill(PIN);
    await p.getByRole('button', { name: '로그인', exact: true }).last().click();
    return { c, p };
  };
  const { c: gc, p: g } = await loginFresh('member', M);
  const guide = g.getByTestId('start-guide');
  await soft('처음 열면 사용 안내가 뜸', () => guide.filter({ hasText: 'FITORY 사용 안내' }).waitFor({ timeout: 15000 }));
  await soft('첫 쪽: 앱 소개와 네 개 메뉴·다시 보는 곳(회원)', async () => { for (const x of ['식단과 운동 기록을 트레이너와 함께 관리해요', '식단', '운동', '커뮤니티', '설정', '받은 피드백', '나중에 다시 보려면 화면 맨 위의 사용 안내(?) 버튼']) await guide.filter({ hasText: x }).waitFor({ timeout: 3000 }); });
  await noOverflow(g, '보통 글씨 시작 안내 1쪽');
  await shot(g, '13a_start_guide_1');
  const titles = [];
  for (let i = 0; i < 6; i++) {
    titles.push((await guide.locator('h3').innerText()).trim());
    if (titles.at(-1) === '휴대폰 알림 받기') {
      await guide.getByRole('button', { name: '그림으로 알림 받는 방법 보기' }).click();
      await soft('알림 쪽: 설정 방법 그림 안내로 갔다가 안내로 돌아옴', async () => {
        await g.getByRole('button', { name: '← 안내로 돌아가기' }).click({ timeout: 5000 });
        await guide.locator('h3', { hasText: '휴대폰 알림 받기' }).waitFor({ timeout: 3000 });
      });
    }
    if (titles.at(-1) === '운동 시트 연결') {
      // 2026-11-03: 시트 쪽은 짧은 안내 + 연결 화면으로 바로 가는 버튼(이메일 복사는 연결 화면의 1단계)
      await soft('시트 쪽: 세 단계 요약 · 지금 연결하기 · 그림 안내', async () => { await guide.filter({ hasText: '① 이메일 복사 ② 링크 붙여 넣기 ③ 연결하기' }).waitFor({ timeout: 3000 }); for (const name of ['지금 연결하기', '그림으로 연결 방법 보기']) await guide.getByRole('button', { name }).waitFor({ timeout: 3000 }); });
    }
    await noOverflow(g, `보통 글씨 시작 안내 ${titles.at(-1)}`);
    const next = guide.getByRole('button', { name: /^(다음|시작하기)$/ });
    if ((await next.innerText()).trim() === '시작하기') break;
    await next.click();
  }
  check('안내 네 쪽 순서(홈 화면 다시 추가 쪽 없음)', titles.join('|') === 'FITORY 사용 안내|휴대폰 알림 받기|운동 시트 연결|인바디 기록', titles.join('|'));
  await guide.getByRole('button', { name: '시작하기' }).click();
  await soft('시작하기 → 안내가 닫힘', () => guide.waitFor({ state: 'detached', timeout: 5000 }));
  await g.reload();
  await g.locator('.bottom-nav').waitFor({ timeout: 15000 });
  await g.waitForTimeout(1500);
  check('한 번 본 뒤에는 다시 열어도 안 뜸', (await guide.count()) === 0);
  await goTab(g, '설정');
  check('설정에는 사용 안내 줄이 없음(맨 위 버튼으로 옮김)', (await g.locator('.settings-row', { hasText: '사용 안내' }).count()) === 0);
  await goTab(g, '운동');
  await g.getByTestId('help-button').click();
  await soft('맨 위 사용 안내(?) 버튼으로 다시 보기(어느 탭에서나)', () => guide.filter({ hasText: 'FITORY 사용 안내' }).waitFor({ timeout: 5000 }));
  for (let i = 0; i < 2; i++) await guide.getByRole('button', { name: '다음' }).click();
  await guide.getByRole('button', { name: '그림으로 연결 방법 보기' }).click();
  await soft('시작 안내 → 운동 시트 그림 안내(같은 창, 회원 문구)', () => g.getByTestId('sheet-guide').filter({ hasText: '운동 시트 연결 방법' }).filter({ hasText: '운동 → 루틴 → 운동 시트 연결' }).waitFor({ timeout: 5000 }));
  await soft('운동 시트 그림 안내: 이메일 복사가 1단계', async () => { const first = await g.getByTestId('sheet-guide').locator('.guide-step').first().innerText(); if (!first.includes('1. FITORY 이메일 복사') || !first.includes('이메일 복사') || !first.includes('iam.gserviceaccount.com')) throw new Error(first); if ((await g.getByTestId('sheet-guide').innerText()).includes('이 주소')) throw new Error('주소 표현이 남음'); });
await soft('운동 시트 그림 안내 이미지 다섯 장', async () => { const n = await g.getByTestId('sheet-guide').locator('img.guide-step-image').count(); if (n !== 5) throw new Error(`${n}장`); });
  await g.getByTestId('sheet-guide').getByRole('button', { name: '← 안내로 돌아가기' }).click();
  await soft('그림 안내에서 돌아오면 시트 쪽 그대로', () => guide.filter({ hasText: '운동 시트 연결' }).waitFor({ timeout: 3000 }));
  await gc.close();
  const { c: tc, p: tg } = await loginFresh('trainer', T);
  const tguide = tg.getByTestId('start-guide');
  await soft('트레이너도 처음 열면 안내(확인·회원 메뉴)', async () => { await tguide.filter({ hasText: 'FITORY 사용 안내' }).waitFor({ timeout: 15000 }); for (const x of ['확인', '회원 한 명의']) await tguide.filter({ hasText: x }).waitFor({ timeout: 3000 }); });
  for (let i = 0; i < 2; i++) await tguide.getByRole('button', { name: '다음' }).click();
  await soft('트레이너 시트 쪽: 회원을 고른 뒤 루틴에서 연결', () => tguide.filter({ hasText: '운동 시트 연결' }).filter({ hasText: '회원을 고른 뒤 루틴 → 운동 시트 연결' }).waitFor({ timeout: 3000 }));
  await tguide.getByRole('button', { name: '회원 고르러 가기' }).click();
  await soft("트레이너 '회원 고르러 가기' → 안내를 닫고 회원 탭 · 다음 할 일 안내", async () => {
    await tguide.waitFor({ state: 'detached', timeout: 5000 });
    await tg.locator('.nav-item.active', { hasText: '회원' }).waitFor({ timeout: 5000 });
    await tg.locator('.toast.visible', { hasText: '회원을 고른 뒤' }).waitFor({ timeout: 5000 });
  });
  await tc.close();
}

// 7c. v1.4 평가만으로 피드백: 트레이너가 확인 목록 카드에서 바로 고른다 → 회원에게 새 피드백
await m.getByRole('button', { name: '식단 기록하기' }).first().click();
await m.getByLabel('무엇을 드셨나요?').fill('그릭요거트와 블루베리');
// 식사 구분은 버튼 네 개(2026-10-30 회원 의견): 한 번 눌러 고르고, 하나만 눌린 상태
await m.getByRole('group', { name: '식사 구분' }).getByRole('button', { name: '간식', exact: true }).click();
await soft('식사 구분 버튼: 누른 것 하나만 선택', async () => {
  const g = m.getByRole('group', { name: '식사 구분' });
  if ((await g.getByRole('button').count()) !== 4) throw new Error('버튼 수');
  if ((await g.locator('button[aria-pressed=true]').count()) !== 1 || (await g.getByRole('button', { name: '간식', exact: true }).getAttribute('aria-pressed')) !== 'true') throw new Error('선택 상태');
});
await noOverflow(m, '큰 글씨 식사 구분 버튼');
await m.getByRole('button', { name: '식단 등록하기' }).click();
await m.locator('.toast.visible', { hasText: '식단을 등록했어요' }).waitFor({ timeout: 15000 }).catch(() => {});
await soft('고른 식사 구분(간식)으로 저장', () => m.locator('.meal-card', { hasText: '그릭요거트' }).filter({ hasText: '간식' }).first().waitFor({ timeout: 10000 }));
await t.reload();
const snackCard = t.locator('.meal-card-wrap', { hasText: '그릭요거트' });
await soft('확인 목록 카드 아래에 평가 버튼 세 개', async () => { await snackCard.waitFor({ timeout: 15000 }); const n = await snackCard.locator('.rating-button').count(); if (n !== 3) throw new Error('n=' + n); });
await shot(t, '10c_trainer_quick_rating');
await noOverflow(t, '보통 글씨 평가 버튼 카드');
await snackCard.getByRole('button', { name: '조절이 필요해요' }).click();
await soft('카드에서 평가 → 안내', () => t.locator('.toast.visible', { hasText: '조절이 필요해요' }).waitFor({ timeout: 10000 }));
await soft('평가한 식사는 미확인에서 빠짐', () => t.getByText('모두 확인했어요').waitFor({ timeout: 10000 }));
await m.reload();
await soft('평가만 받아도 식단 탭에 빨간 점', () => m.locator('.nav-item', { hasText: '식단' }).locator('.nav-dot').waitFor({ timeout: 15000 }));
await m.getByTestId('feedback-entry').click();
const ratedCard = m.locator('.feedback-card', { hasText: '그릭요거트' });
await soft('평가만 받은 식사도 피드백 목록에(NEW·평가)', async () => { await ratedCard.locator('.new-badge').waitFor({ timeout: 5000 }); await ratedCard.locator('.rating-chip', { hasText: '조절이 필요해요' }).waitFor({ timeout: 5000 }); });
await ratedCard.click();
await soft('회원 상세에 트레이너 평가', () => m.locator('dialog .rating-panel.member', { hasText: '조절이 필요해요' }).waitFor({ timeout: 5000 }));
await shot(m, '10d_member_rating_detail');
await noOverflow(m, '큰 글씨 평가 상세');
await m.getByRole('button', { name: '창 닫기' }).click(); // 이 식사(평가 '조절이 필요해요')는 아래 결산에 쓴다
await m.getByRole('button', { name: '식단으로' }).click();

// 7d. v1.4 인바디: 사진은 기기 안에서 숫자만 읽고 버림(외부 요청·전송 없음) → 두 번 기록 → 변화 표시 → 트레이너가 읽기만
await goTab(m, '운동');
await soft('운동 탭 첫 화면은 루틴(인바디는 옆 칸 — 2.0에서 기록 탭에서 옮김)', async () => { if ((await m.getByRole('button', { name: '루틴', exact: true }).getAttribute('aria-pressed')) !== 'true') throw new Error('루틴이 아님'); });
await m.getByRole('button', { name: '인바디', exact: true }).click();
await soft('인바디 첫 화면 안내', () => m.getByText('아직 인바디 기록이 없어요').waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '인바디 기록하기' }).click();
await soft('인바디 사진 업로드 화면에 사진 폐기 안내', () => m.getByTestId('inbody-privacy').filter({ hasText: '바로 버려요' }).filter({ hasText: '서버로 보내거나 앱에 저장하지 않아요' }).filter({ hasText: '측정일·체중·골격근량·체지방률만' }).waitFor({ timeout: 5000 }));
await noOverflow(m, '큰 글씨 인바디 기록 창');
await shot(m, '10e_member_inbody_form');
const ocrReqs = [];
const onReq = (r) => ocrReqs.push({ url: r.url(), method: r.method() });
m.on('request', onReq);
await soft('인바디: 결과지 찍기 입력에 capture=environment 지정, 앨범에서 고르기 입력도 있음(실제 카메라 실행은 실기기 확인)', async () => {
  if ((await m.locator('input[aria-label="인바디 결과지 사진 찍기"]').getAttribute('capture')) !== 'environment' || !(await m.locator('input[aria-label="인바디 결과지 사진 선택"]').count())) throw new Error('속성');
});
await m.locator('input[aria-label="인바디 결과지 사진 선택"]').setInputFiles(`${OUT}/inbody_sheet.png`);
await soft('결과지 사진에서 네 값을 읽어 채움', async () => {
  await m.locator('.read-note').waitFor({ timeout: 90000 });
  const vals = await Promise.all(['측정일', '체중 (kg)', '골격근량 (kg)', '체지방률 (%)'].map((l) => m.getByLabel(l, { exact: true }).inputValue()));
  if (vals.join('|') !== '2026-09-15|73.3|32.4|23.6') throw new Error(vals.join('|'));
});
m.off('request', onReq);
await soft('인식 중 다른 주소로 가는 요청·사진 전송 없음', async () => {
  const origin = new URL(BASE).origin;
  const bad = ocrReqs.filter((r) => (!r.url.startsWith(origin) && !/^(data|blob):/.test(r.url)) || r.method !== 'GET');
  if (bad.length) throw new Error(JSON.stringify(bad.slice(0, 3)));
});
await shot(m, '10f_member_inbody_read');
await m.getByRole('button', { name: '인바디 저장하기' }).click();
await soft('인바디 저장 → 최근 측정 카드', () => m.locator('.inbody-latest', { hasText: '73.3kg' }).waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '인바디 기록하기' }).click();
await m.getByLabel('체중 (kg)').fill('72.1');
await m.getByLabel('골격근량 (kg)').fill('32.8');
await m.getByLabel('체지방률 (%)').fill('22.4');
await m.getByRole('button', { name: '인바디 저장하기' }).click();
await soft('직접 입력 두 번째 기록 → 직전 대비 변화', async () => {
  const card = m.locator('.inbody-latest');
  await card.filter({ hasText: '72.1kg' }).waitFor({ timeout: 10000 });
  for (const t of ['▼ 1.2kg', '▲ 0.4kg', '▼ 1.2%p']) await card.filter({ hasText: t }).waitFor({ timeout: 3000 });
});
await m.getByRole('button', { name: '인바디 기록하기' }).click();
await m.getByLabel('체중 (kg)').fill('72.0');
const sameDay = expectFail('/rest/v1/inbody_records', 409, '같은 날짜 인바디 중복');
await m.getByRole('button', { name: '인바디 저장하기' }).click();
await soft('같은 날짜 두 번째 기록은 고치라고 안내', () => m.locator('.toast.visible', { hasText: '이 날짜의 기록이 이미 있어요' }).waitFor({ timeout: 10000 }));
sameDay();
await m.getByRole('button', { name: '창 닫기' }).click();
await m.getByRole('button', { name: /9월 15일 인바디 고치기/ }).click();
await m.getByLabel('골격근량 (kg)').fill('32.5');
await m.getByRole('button', { name: '고친 내용 저장하기' }).click();
await soft('인바디 고치기', () => m.locator('.inbody-row', { hasText: '32.5kg' }).waitFor({ timeout: 10000 }));
await shot(m, '10g_member_inbody_list');
await noOverflow(m, '큰 글씨 인바디 목록');
// 2.1: 변화 카드는 인바디 탭 안(그래프·최근 측정 아래) — 따로 누를 탭이 없다
await soft('인바디 탭에 체중 그래프(두 번 측정한 뒤)', () => m.getByTestId('inbody-chart').filter({ hasText: '최근 2번 측정' }).waitFor({ timeout: 10000 }));
await soft('지난 측정 이후의 변화 카드(평가 평균·변화·한 줄 정리)', async () => {
  await m.getByRole('heading', { name: /지난 측정 이후의 변화/ }).waitFor({ timeout: 10000 });
  const card = m.locator('.report-card').first();
  await card.filter({ hasText: '9월 16일 ~' }).waitFor({ timeout: 10000 });
  for (const t of ['식단 평가 평균', '1점 / 5점', '기록한 1끼 중 1끼 평가', '체지방률 ▼ 1.2%p', '조절 필요 1', '평가받은 식단 1끼는 5점 만점에 1점이에요', '다음 목표를 트레이너와 함께 정해 보세요']) await card.filter({ hasText: t }).waitFor({ timeout: 3000 });
});
await m.locator('.report-card').first().scrollIntoViewIfNeeded();
await shot(m, '10g2_member_report');
await noOverflow(m, '큰 글씨 변화');
await goTab(t, '회원');
await t.locator('.member-row', { hasText: M }).click();
await t.getByRole('button', { name: '인바디', exact: true }).click();
await soft('트레이너도 회원 인바디를 봄(읽기만)', async () => {
  await t.locator('.inbody-row', { hasText: '72.1kg' }).waitFor({ timeout: 10000 });
  if (await t.getByRole('button', { name: '인바디 기록하기' }).count()) throw new Error('트레이너에게 기록 버튼이 보임');
});
await soft('트레이너도 같은 결산을 봄', () => t.locator('.report-card', { hasText: '1점 / 5점' }).waitFor({ timeout: 10000 }));
await shot(t, '10h_trainer_inbody');
// 7e. v2.0 운동: 트레이너가 시트에서 복사한 루틴을 붙여 넣어 등록 → 회원이 실제 수행 기록 → 트레이너가 봄 → 변화 카드에 운동한 날
await t.getByRole('button', { name: '루틴', exact: true }).click();
await soft('회원 화면 루틴: 루틴 없음 안내', () => t.getByText('아직 등록한 루틴이 없어요').waitFor({ timeout: 10000 }));
await t.getByTestId('edit-routine').click();
await t.getByLabel('루틴 이름').fill('하체와 코어');
await t.getByLabel('이번 목표').fill('자세를 지키며 횟수 채우기');
await t.getByRole('button', { name: '시트에서 복사해 붙여넣기' }).click();
await t.locator('.paste-box textarea').fill('1\n\tSET\tREPS\t중량\n레그 프레스\t2\t12\t60\n플랭크 홀드 (코어 버티기, 팔꿈치 아래 정렬 유지)\t1\t40초\t-');
await t.getByRole('button', { name: '표로 읽기' }).click();
await soft('붙여 넣은 표를 운동 칸으로 읽음', async () => { if ((await t.getByLabel('1번 운동 이름').inputValue()) !== '레그 프레스' || (await t.getByLabel('1번 중량').inputValue()) !== '60' || (await t.getByLabel('2번 횟수').inputValue()) !== '40초' || (await t.getByLabel('2번 중량').inputValue()) !== '') throw new Error('읽기 실패'); });
await noOverflow(t, '보통 글씨 루틴 등록');
await shot(t, '10i_trainer_routine_form');
await t.getByRole('button', { name: '루틴 저장' }).click();
await soft('루틴 저장 → 회원 화면 루틴에 루틴', async () => { await t.getByTestId('routine-card').filter({ hasText: '하체와 코어' }).waitFor({ timeout: 10000 }); await t.getByTestId('routine-day-1').filter({ hasText: '레그 프레스' }).waitFor({ timeout: 3000 }); });
await goTab(m, '운동');
await m.getByRole('button', { name: '루틴', exact: true }).click();
await soft('회원 운동 탭에 받은 루틴과 목표', () => m.getByTestId('routine-card').filter({ hasText: '자세를 지키며' }).waitFor({ timeout: 15000 }));
await noOverflow(m, '큰 글씨 운동 루틴');
await shot(m, '10j_member_routine');
// 2.1: 기록 줄은 '운동 기록' 탭 — 이 흐름의 기록 시험은 그 탭에서 한다(루틴이 하나면 시작 버튼이 바로 그 루틴으로 연다)
await m.getByRole('button', { name: '운동 기록', exact: true }).click();
await m.getByTestId('start-workout').click();
await soft('운동 시작: 루틴의 목표가 세트마다 채워짐(계획)', async () => { if ((await m.getByLabel('레그 프레스 1세트 중량').inputValue()) !== '60' || (await m.getByLabel('레그 프레스 2세트 횟수').inputValue()) !== '12') throw new Error('목표가 안 채워짐'); });
await m.getByLabel('레그 프레스 2세트 횟수').fill('10'); // 실제로 한 값
await m.getByLabel('레그 프레스 1세트 완료').check();
await m.getByLabel('레그 프레스 2세트 완료').check();
await noOverflow(m, '큰 글씨 운동 기록');
await shot(m, '10k_member_workout_form');
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await soft('운동 기록 저장 → 최근 기록에 완료 2/3세트', async () => {
  await m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 });
  await m.locator('.workout-row', { hasText: '완료 2/3세트' }).waitFor({ timeout: 10000 });
});
// 기록 줄의 운동 이름 요약이 화면보다 길어도 본문이 가로로 밀리지 않음(2026-10-30 베타 — 격자 칸이 글자 최소 폭만큼 넓어졌다)
await noOverflow(m, '큰 글씨 운동 기록 목록(긴 운동 이름)');
await soft('오늘 기록이 있으면 버튼이 이어서 기록', () => m.getByTestId('start-workout').filter({ hasText: '이어서' }).waitFor({ timeout: 5000 }));
// 두 기기: 이 기기가 기록을 연 뒤 다른 기기가 먼저 고침 → 덮어쓰지 않고 알림, 그쪽 기록 불러오기(Codex v2.0.0 1차 리뷰 3)
await m.getByTestId('start-workout').click();
await sql(`update public.workout_sets x set kg = 65 from public.workout_sessions s join public.profiles p on p.id = s.member_id where x.session_id = s.id and p.nickname = '${M}' and x.set_no = 1`);
await sql(`update public.workout_sessions s set updated_at = clock_timestamp() from public.profiles p where p.id = s.member_id and p.nickname = '${M}'`);
await m.getByLabel('레그 프레스 1세트 중량').fill('62');
const clash1 = expectFail('/rest/v1/rpc/save_workout', 400, '다른 기기가 먼저 고친 운동 기록의 충돌');
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await soft('다른 기기가 먼저 고쳤으면 덮어쓰지 않고 알림(내 입력 유지)', async () => {
  await m.getByTestId('workout-clash').filter({ hasText: '다른 기기에서 이 기록을 먼저 고쳤어요' }).waitFor({ timeout: 10000 });
  if ((await m.getByLabel('레그 프레스 1세트 중량').inputValue()) !== '62') throw new Error('내 입력이 사라짐');
});
clash1();
await noOverflow(m, '큰 글씨 운동 기록 충돌 안내');
await m.getByRole('button', { name: '그쪽 기록 불러오기' }).click();
await soft('그쪽 기록 불러오기 → 먼저 고친 값', async () => { if ((await m.getByLabel('레그 프레스 1세트 중량').inputValue()) !== '65') throw new Error(await m.getByLabel('레그 프레스 1세트 중량').inputValue()); });
await m.getByRole('button', { name: '창 닫기' }).click();
// 9일 전 기록도 열어 고칠 수 있음(새 기록만 최근 7일, 리뷰 4)
await sql(`with s as (insert into public.workout_sessions (id, member_id, day) select gen_random_uuid(), p.id, current_date - 9 from public.profiles p where p.nickname = '${M}' returning id) insert into public.workout_sets (session_id, name, set_no, kg, reps, done) select id, '옛 런지', 1, 10, 10, true from s`);
await m.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await m.locator('.workout-row', { hasText: '옛 런지' }).click({ timeout: 10000 });
await m.getByLabel('옛 런지 1세트 중량').fill('12');
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await soft('9일 전 기록도 고쳐 저장', () => m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 }));
// 저장 응답을 기다리는 동안: 입력 전체가 잠기고(보낸 내용과 화면이 달라지지 않게), 끝난 저장은 자기 창만 닫는다(Codex v2.0.0 3차 리뷰 1·2)
{
  const rpc = (url) => new URL(url).pathname.endsWith('/rpc/save_workout');
  const holdOnce = async () => {
    let release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    let used = false;
    await m.route(rpc, async (r) => { if (used) return r.fallback(); used = true; const res = await r.fetch(); started(); await gate; return r.fulfill({ response: res }); });
    return { release, start };
  };
  await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await m.locator('.workout-row', { hasText: '옛 런지' }).click({ timeout: 10000 });
  let h = await holdOnce();
  await m.getByLabel('옛 런지 1세트 중량').fill('13');
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  await h.start;
  await soft('저장을 기다리는 동안 세트 입력·완료·세트 추가가 잠김', async () => {
    const locked = await Promise.all([m.getByLabel('옛 런지 1세트 중량').isDisabled(), m.getByLabel('옛 런지 1세트 완료').isDisabled(), m.getByRole('button', { name: '세트 추가' }).first().isDisabled()]);
    if (locked.some((x) => !x)) throw new Error(JSON.stringify(locked));
  });
  h.release();
  await m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 });
  await m.unroute(rpc);
  await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await m.locator('.workout-row', { hasText: '옛 런지' }).click({ timeout: 10000 });
  h = await holdOnce();
  await m.getByLabel('옛 런지 1세트 중량').fill('14');
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  await h.start;
  await m.getByRole('button', { name: '창 닫기' }).click();
  await goTab(m, '식단');
  await m.getByRole('button', { name: '식단 기록하기' }).first().click();
  await m.getByLabel('무엇을 드셨나요?').fill('새로 쓰던 식단 초안');
  h.release();
  await soft('이전 운동 저장이 끝나도 새로 연 식단 초안 창은 그대로', async () => {
    await m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 });
    await m.waitForTimeout(500);
    if (!(await m.locator('dialog[open]').count())) throw new Error('식단 창이 닫힘');
    if ((await m.getByLabel('무엇을 드셨나요?').inputValue()) !== '새로 쓰던 식단 초안') throw new Error('초안이 사라짐');
  });
  await m.unroute(rpc);
  await m.getByRole('button', { name: '창 닫기' }).click();
  await goTab(m, '운동');
}
await t.getByRole('button', { name: '식단', exact: true }).click();
await t.getByRole('button', { name: '운동 기록', exact: true }).click();
await soft('트레이너도 회원의 실제 기록을 봄(실제 횟수 10)', async () => {
  await t.locator('.workout-row', { hasText: '완료 2/3세트' }).click({ timeout: 10000 });
  if ((await t.getByLabel('레그 프레스 2세트 횟수').inputValue()) !== '10') throw new Error('실제 값이 아님');
  if (!(await t.getByLabel('레그 프레스 2세트 횟수').isDisabled())) throw new Error('트레이너가 고칠 수 있음');
});
await t.getByRole('button', { name: '창 닫기' }).click();
// v2.3.0 3차 리뷰: 트레이너 화면의 회원 운동은 서버 함수 하나로 받는다 — 실제 DB에서 회원 카드의 운동 줄까지
await t.getByRole('button', { name: /담당 회원으로/ }).click();
await soft('회원 카드의 운동 줄: 서버 함수로 받은 오늘 운동', () => t.getByTestId('member-day').filter({ hasText: M }).locator('.member-day-workout.is-today', { hasText: '완료 2/3세트' }).waitFor({ timeout: 10000 }));
await t.getByTestId('member-day').filter({ hasText: M }).locator('.member-day-main').click();
await m.getByRole('button', { name: '인바디', exact: true }).click();
await soft('변화 카드에 그 기간 운동한 날(오늘·9일 전 기록 — 완료 세트가 있는 날)', () => m.getByTestId('report-workout').first().filter({ hasText: '운동한 날 2일' }).waitFor({ timeout: 10000 }));
// 7f. v2.0 시트 연결 → 자동 반영(2026-10-30 사용자 결정). 서버 기능이 가짜 시트 서버(scripts/fake-sheets.mjs — 실제 시트 양식을 본뜬 칸)를 읽는다
const fakeSheets = await startFakeSheets();
const e2eSheet = `zze2e${run}AAAAAAAAAAAAAAAAAAAA`;
fakeSheets.set(e2eSheet, { tabs: ['2610', '2611'], rows: sheetRows('12.5') });
await t.getByRole('button', { name: '루틴', exact: true }).click();
await t.getByTestId('sheet-line').getByRole('button', { name: '연결', exact: true }).click();
await soft('시트 연결 창에 서비스 계정 주소와 공유 안내', () => t.locator('.sheet-account', { hasText: 'iam.gserviceaccount.com' }).waitFor({ timeout: 5000 }));
await t.getByLabel('시트 링크').fill(`https://docs.google.com/spreadsheets/d/${e2eSheet}/edit#gid=1`);
// 그림 안내(2026-11-01): 같은 창 안에서 열고, 돌아오면 쓰던 링크가 그대로(트레이너 문구)
// 2026-11-03 사용자 요청(설명이 복잡하고 연결 화면과 이어져 있지 않음): 연결 창 한 장에 세 단계, 단계마다 그림을 그 자리에서 펼친다
await soft('시트 연결 창: 세 단계 · 1단계 그림(공유·편집자 두 장)을 그 자리에서 펼쳐도 붙여 넣은 링크가 그대로', async () => {
  const form = t.getByTestId('sheet-link-form');
  if ((await form.locator('.sheet-step').count()) !== 3) throw new Error('단계 수');
  await form.getByRole('button', { name: '그림으로 보기' }).first().click();
  await form.locator('.sheet-step-pics img').nth(1).waitFor({ timeout: 5000 });
  if ((await form.locator('.sheet-step-pics img').count()) !== 2) throw new Error('그림 수');
  if (!(await t.getByLabel('시트 링크').inputValue()).includes(e2eSheet)) throw new Error('링크가 사라짐');
});
await t.getByRole('button', { name: '시트 연결하기' }).click();
await soft('링크만 넣으면 바로 연결하고 루틴을 가져옴(확인 코드·미리보기 없음)', () => t.locator('.toast.visible', { hasText: '시트를 연결하고 루틴을 가져왔어요' }).waitFor({ timeout: 15000 }));
await soft('가져온 루틴 판: 가장 최근 달 탭·루틴별 카드·필수 동작·바뀐 점(한 바퀴 전이라 카드 위)', async () => {
  const card = t.getByTestId('routine-card').filter({ hasText: '26년 11월 루틴' });
  await card.waitFor({ timeout: 10000 });
  for (const x of ['본 운동 전 필수 동작', '시트 2611 탭']) await card.filter({ hasText: x }).waitFor({ timeout: 3000 });
  await t.getByTestId('routine-day-1').filter({ hasText: '루틴 1' }).filter({ hasText: '등' }).waitFor({ timeout: 3000 });
  await t.getByTestId('routine-day-2').filter({ hasText: '하체' }).waitFor({ timeout: 3000 });
  await t.getByTestId('routine-track').filter({ hasText: '12.5kg' }).waitFor({ timeout: 3000 });
  const upd = t.getByTestId('routine-update').filter({ hasText: '루틴이 바뀌었어요' });
  await upd.waitFor({ timeout: 3000 });
  if ((await upd.boundingBox()).y > (await t.getByTestId('routine-track').boundingBox()).y) throw new Error('바뀐 점이 카드 아래');
});
await soft('시트 줄에 자동 반영 안내와 마지막으로 읽은 때', () => t.getByTestId('sheet-line').filter({ hasText: '자동으로 반영돼요' }).waitFor({ timeout: 5000 }));
await noOverflow(t, '보통 글씨 시트 자동 반영');
await shot(t, '10l_trainer_sheet_synced');
// 시트의 첫 회차 중량만 바뀌면(v2.1) 새 판 없이 지금 판의 목표 중량만 고친다 — 앱이 기록을 써 넣을 때마다 새 판이 생기지 않게
const verText = () => t.getByTestId('routine-card').locator('.routine-head .tiny').innerText();
const verBefore = await verText().catch(() => '');
fakeSheets.set(e2eSheet, { tabs: ['2610', '2611'], rows: sheetRows('15') });
await t.getByTestId('sync-sheet').click();
await soft('시트의 중량만 고치고 다시 읽으면 새 판 없이 목표 중량만 바뀜', async () => {
  await t.getByTestId('routine-track').filter({ hasText: '15kg' }).waitFor({ timeout: 15000 });
  if ((await verText()) !== verBefore) throw new Error(`${verBefore} → ${await verText()}`);
});
// 공유가 풀리면 마지막 루틴은 그대로 두고 이유를 알림
fakeSheets.set(e2eSheet, { noAccess: true });
const noAccess = expectFail('/functions/v1/sheet-import', 403, '시트 공유가 풀린 경우의 no_access');
await t.getByTestId('sync-sheet').click();
await soft('읽지 못하면 공유 안내·마지막 루틴 유지', async () => {
  await t.locator('.toast.visible', { hasText: 'iam.gserviceaccount.com' }).waitFor({ timeout: 15000 });
  await t.getByTestId('sheet-line').filter({ hasText: '시트를 읽을 수 없어요' }).waitFor({ timeout: 10000 });
  await t.getByTestId('routine-track').filter({ hasText: '15kg' }).waitFor({ timeout: 3000 });
});
noAccess();
fakeSheets.set(e2eSheet, { tabs: ['2610', '2611'], rows: sheetRows('15') });
await t.getByTestId('sync-sheet').click();
await soft('다시 공유되면 안내가 풀림(같은 내용이라 새 판 없음)', () => t.getByTestId('sheet-line').filter({ hasText: '자동으로 반영돼요' }).waitFor({ timeout: 15000 }));
// 회원: 오늘 기록을 지운 뒤 새로 시작하면 오늘 할 루틴부터 고른다(2026-10-30 사용자 요청 — 미리 고르지 않는다. 다음 차례 표시는 11-06 사용자 결정으로 삭제)
await m.getByRole('button', { name: '루틴', exact: true }).click();
await soft('회원도 새 루틴(루틴별 칸·필수 동작)을 봄', () => m.getByTestId('routine-card').filter({ hasText: '26년 11월 루틴' }).filter({ hasText: '본 운동 전 필수 동작' }).waitFor({ timeout: 15000 }));
await soft('회원 화면에도 시트 연결·자동 반영 표시', () => m.getByTestId('sheet-line').filter({ hasText: '자동으로 반영돼요' }).waitFor({ timeout: 10000 }));
// 2.1: 루틴 탭의 시작 버튼은 보이는 카드의 루틴(처음엔 루틴 1). 이어서 기록할 오늘 기록이 있으면 그 기록
await soft('루틴 탭 시작 버튼은 오늘 기록이 있으면 이어서', () => m.getByTestId('start-workout').filter({ hasText: '오늘 운동 이어서 기록하기' }).waitFor({ timeout: 5000 }));
await m.getByRole('button', { name: '운동 기록', exact: true }).click();
await m.locator('.workout-row').first().click();
await m.getByRole('button', { name: '이 기록 지우기' }).click();
await m.getByRole('button', { name: '한 번 더 누르면 이 기록을 지워요' }).click();
await soft('운동 기록 지우기', () => m.locator('.toast.visible', { hasText: '운동 기록을 지웠어요' }).waitFor({ timeout: 10000 }));
await m.getByTestId('start-workout').click();
await soft('루틴이 둘 이상이면 새 기록은 오늘 할 루틴부터 고름(미리 고르지 않음·다음 차례 표시 없음)', async () => {
  const g = m.getByRole('group', { name: '오늘 할 루틴' });
  await g.waitFor({ timeout: 5000 });
  await g.filter({ hasText: '오늘 할 루틴을 골라 주세요' }).waitFor({ timeout: 3000 });
  if ((await g.locator('button[aria-pressed=true]').count()) !== 0) throw new Error('미리 골라져 있음');
  if ((await g.innerText()).includes('다음 차례')) throw new Error('다음 차례 표시가 남아 있음');
  await g.getByRole('button', { name: /루틴 2/ }).filter({ hasText: '하체' }).waitFor({ timeout: 3000 }); // 운동 이름으로 정한 주요 부위
  if ((await m.getByLabel('데드버그+풀오버 1세트 중량').count()) || (await m.getByRole('button', { name: '운동 기록 저장' }).count())) throw new Error('고르기 전에 세트·저장이 보임');
});
await noOverflow(m, '큰 글씨 오늘 할 루틴 고르기');
await m.getByRole('group', { name: '오늘 할 루틴' }).getByRole('button', { name: /루틴 1/ }).click();
await soft('루틴 1을 고르면 그 루틴의 목표로 채움', () => m.getByLabel('데드버그+풀오버 1세트 중량').waitFor({ timeout: 3000 }));
// 같은 시작에서 반대 선택지 — '그쪽 기록 불러오기'를 고르면 세트뿐 아니라 루틴까지 서버 기록(루틴 1)으로 돌아오고, 다시 저장해도 섞이지 않는다(Codex v2.0.0 4차 리뷰)
{
  const rpcA = (url) => new URL(url).pathname.endsWith('/rpc/save_workout');
  let lostA = 0;
  await m.route(rpcA, async (r) => { if (lostA++ === 0) { await r.fetch(); return fakeFail(r, 500, 'network lost', '운동 기록 저장 응답 끊김(그쪽 기록 불러오기 시험)'); } return r.fallback(); });
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  await m.locator('.toast.visible', { hasText: '저장하지 못했어요' }).waitFor({ timeout: 10000 });
  await m.getByRole('group', { name: '오늘 할 루틴' }).getByRole('button', { name: /루틴 2/ }).click();
  const clash2 = expectFail('/rest/v1/rpc/save_workout', 400, '응답이 끊긴 저장 뒤 루틴을 바꾼 저장의 충돌');
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  await m.getByTestId('workout-clash').waitFor({ timeout: 10000 });
  clash2();
  await m.getByRole('button', { name: '그쪽 기록 불러오기' }).click();
  await soft('그쪽 기록 불러오기 → 세트와 루틴이 함께 서버 기록(루틴 1)으로', async () => {
    if ((await m.getByRole('group', { name: '오늘 할 루틴' }).getByRole('button', { name: /루틴 1/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('루틴 2로 남음');
    await m.getByLabel('데드버그+풀오버 1세트 중량').waitFor({ timeout: 3000 });
  });
  await m.unroute(rpcA);
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  // 2.1 기록 카드는 완료한 세트의 운동만 줄로 보이므로(이 기록은 완료 세트 없음) 운동 구성은 기록을 열어 확인한다
  await soft('불러온 기록을 다시 저장해도 루틴·운동이 섞이지 않음(루틴 1·데드버그)', async () => {
    await m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 });
    const row = m.locator('.workout-row').filter({ hasText: '오늘' }).first();
    await row.filter({ hasText: '루틴 1' }).waitFor({ timeout: 10000 });
    await row.click();
    await m.getByLabel('데드버그+풀오버 1세트 중량').waitFor({ timeout: 5000 });
    if (await m.getByLabel('스미스 머신 스퀏 1세트 중량').count()) throw new Error('루틴 2 운동이 섞임');
  });
  // 다음 시험을 위해 이 기록을 지우고 새로 시작(위에서 열지 못했으면 연다)
  if (!(await m.getByRole('button', { name: '이 기록 지우기' }).count())) await m.locator('.workout-row', { hasText: '루틴 1' }).first().click();
  await m.getByRole('button', { name: '이 기록 지우기' }).click();
  await m.getByRole('button', { name: '한 번 더 누르면 이 기록을 지워요' }).click();
  await m.locator('.toast.visible', { hasText: '운동 기록을 지웠어요' }).waitFor({ timeout: 10000 });
  await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await m.getByTestId('start-workout').click();
  await m.getByRole('group', { name: '오늘 할 루틴' }).getByRole('button', { name: /루틴 1/ }).click({ timeout: 5000 });
}
// 저장 응답이 끊김(서버엔 저장됨) → 루틴을 바꿔 다시 저장: 이전 저장의 성공으로 덮이지 않고 '먼저 저장된 기록'으로 알림(Codex v2.0.0 2차 리뷰 2)
const saveRpc = (url) => new URL(url).pathname.endsWith('/rpc/save_workout');
let lost = 0;
await m.route(saveRpc, async (r) => { if (lost++ === 0) { await r.fetch(); return fakeFail(r, 500, 'network lost', '운동 기록 저장 응답 끊김(루틴을 바꿔 다시 저장)'); } return r.fallback(); });
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await soft('저장 응답이 끊기면 실패로 안내', () => m.locator('.toast.visible', { hasText: '저장하지 못했어요' }).waitFor({ timeout: 10000 }));
await m.getByRole('group', { name: '오늘 할 루틴' }).getByRole('button', { name: /루틴 2/ }).click();
await soft('루틴 2를 고르면 그 루틴의 목표로 채움', async () => { if ((await m.getByLabel('스미스 머신 스퀏 1세트 중량').inputValue()) !== '70') throw new Error('루틴 2 아님'); });
const clash3 = expectFail('/rest/v1/rpc/save_workout', 400, '응답이 끊긴 저장 뒤 루틴을 바꾼 저장의 충돌');
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await soft('루틴을 바꾼 저장은 이전 저장의 성공으로 처리되지 않고 충돌 안내(내 입력 유지)', async () => {
  await m.getByTestId('workout-clash').waitFor({ timeout: 10000 });
  if ((await m.getByLabel('스미스 머신 스퀏 1세트 중량').inputValue()) !== '70') throw new Error('입력이 바뀜');
});
clash3();
await m.getByRole('button', { name: '내 입력으로 저장' }).click();
await soft('내 입력으로 저장 → 루틴 2 기록', async () => {
  await m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 });
  await m.locator('.workout-row', { hasText: '루틴 2' }).waitFor({ timeout: 10000 });
});
await m.unroute(saveRpc);
// 같은 내용을 응답이 끊긴 뒤 다시 누르면 한 번만 저장(같은 요청)
await m.locator('.workout-row', { hasText: '루틴 2' }).first().click();
await m.getByLabel('스미스 머신 스퀏 1세트 완료').check();
let lost2 = 0;
await m.route(saveRpc, async (r) => { if (lost2++ === 0) { await r.fetch(); return fakeFail(r, 500, 'network lost', '운동 기록 저장 응답 끊김(같은 내용 다시 저장)'); } return r.fallback(); });
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await m.locator('.toast.visible', { hasText: '저장하지 못했어요' }).waitFor({ timeout: 10000 }).catch(() => {});
await m.getByRole('button', { name: '운동 기록 저장' }).click();
await soft('같은 내용을 다시 저장하면 충돌 없이 성공(한 번만 반영)', async () => {
  await m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 });
  if (await m.getByTestId('workout-clash').count()) throw new Error('충돌로 처리됨');
});
await m.unroute(saveRpc);
await m.getByTestId('start-workout').click();
await noOverflow(m, '큰 글씨 오늘 할 루틴 고르기(기록이 있는 뒤)');
await m.getByRole('button', { name: '창 닫기' }).click();
// 7g. v2.1 시트의 회차 기록(사용자 피드백 11-02): 저장한 앱 기록은 시트의 빈 회차 칸에 · 지난 기록 가져오기 · 편집 권한이 없으면 복사 · 유산소
{
  const now = new Date();
  const mdToday = `${now.getMonth() + 1}/${now.getDate()}`;
  // 이 흐름에서 완료 세트가 있는 기록은 루틴 2(스미스 머신 스퀏 1세트 완료)뿐 — 완료 세트가 없는 루틴 1 기록은 시트에 쓰지 않는다
  await soft('저장한 운동 기록을 시트의 빈 회차 칸(F열)에 씀: 날짜 먼저(직접 친 것처럼), 무게는 RAW(완료 세트가 있는 루틴 2만)', async () => {
    const w = fakeSheets.writes(e2eSheet);
    const got = w.map((x) => `${x.cell}=${x.value}`);
    // 날짜는 트레이너가 친 것처럼(USER_ENTERED) 먼저, 무게는 글자 그대로(RAW)
    const okInput = w.every((x) => x.tab === '2611' && x.input === (x.value === mdToday ? 'USER_ENTERED' : 'RAW'));
    if (!got.includes('F12=70') || !got.includes(`F13=${mdToday}`) || got.some((x) => x.startsWith('F9=')) || !okInput || got.indexOf(`F13=${mdToday}`) > got.indexOf('F12=70')) throw new Error(JSON.stringify(w));
  });
  // 지난 기록: 2611 탭 루틴 1의 첫 회차(E열)에 11/1을 적고, 2610 탭에 10/15 회차 하나. 앱이 쓴 F열은 앱 기록이 원본이라 빼고 센다
  const cur = fakeSheets.rowsOf(e2eSheet, '2611');
  cur[8][4] = '11/1';
  const oct = [['', '1'], ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'], ['', '데드버그+풀오버', '3', '20', '8', '', '', '', '-'], ['', '', '', '운동한 날', '10/15']];
  fakeSheets.set(e2eSheet, { tabs: ['2610', '2611'], rowsByTab: { 2610: oct, 2611: cur } });
  await m.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
  await soft('지난 기록 미리보기: 탭마다 가져올 회차 수(앱이 쓴 회차는 뺌)', () => m.getByTestId('sheet-records').filter({ hasText: '2611 탭 · 1회' }).filter({ hasText: '2610 탭 · 1회' }).waitFor({ timeout: 15000 }));
  await noOverflow(m, '큰 글씨 지난 기록 미리보기');
  await shot(m, '10m_member_sheet_records');
  await m.getByTestId('sheet-records').getByRole('button', { name: '가져오기' }).click();
  await soft('지난 기록 가져오기 → 최근 기록에 시트 기록 2개', async () => {
    await m.locator('.toast.visible', { hasText: '2회를 가져왔어요' }).waitFor({ timeout: 15000 });
    await m.locator('.workout-row', { hasText: '시트 기록' }).nth(1).waitFor({ timeout: 10000 });
  });
  await m.locator('.workout-row', { hasText: '시트 기록' }).first().click();
  await soft('가져온 기록은 읽기만(시트에서 고친다는 안내, 저장·지우기 없음)', async () => {
    await m.getByTestId('workout-form').filter({ hasText: '시트에서 가져온 기록이에요' }).waitFor({ timeout: 5000 });
    if ((await m.getByRole('button', { name: '운동 기록 저장' }).count()) || (await m.getByRole('button', { name: '이 기록 지우기' }).count())) throw new Error('고칠 수 있음');
  });
  await m.getByRole('button', { name: '창 닫기' }).click();
  await m.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
  await m.getByTestId('sheet-records').getByRole('button', { name: '가져오기' }).click();
  await soft('다시 가져와도 시트 기록은 그대로 2개', async () => {
    await m.locator('.toast.visible', { hasText: '를 가져왔어요' }).waitFor({ timeout: 15000 });
    const n = await m.locator('.workout-row', { hasText: '시트 기록' }).count();
    if (n !== 2) throw new Error(`${n}개`);
  });
  // 편집 권한이 없으면(뷰어 공유) 저장은 되고, 창을 닫지 않은 채 이유와 시트에 붙여 넣을 값을 보인다
  fakeSheets.set(e2eSheet, { tabs: ['2610', '2611'], rowsByTab: { 2610: oct, 2611: cur }, readOnly: true });
  await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await m.locator('.workout-row', { hasText: '루틴 2' }).filter({ hasNotText: '시트 기록' }).first().click();
  await m.getByLabel('스미스 머신 스퀏 1세트 중량').fill('72');
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  await soft('편집 권한이 없으면 편집자 안내와 붙여 넣을 값(완료 세트 무게)', async () => {
    await m.getByTestId('sheet-fail').filter({ hasText: '편집자' }).waitFor({ timeout: 15000 });
    const v = await m.getByTestId('sheet-fail').locator('textarea').inputValue();
    if (v !== '72') throw new Error(JSON.stringify(v));
  });
  await noOverflow(m, '큰 글씨 시트에 쓰지 못함');
  await shot(m, '10n_member_sheet_denied');
  await m.getByTestId('sheet-fail').getByRole('button', { name: '닫기' }).click();
  await soft('닫으면 저장 완료 안내', () => m.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 10000 }));
  fakeSheets.set(e2eSheet, { tabs: ['2610', '2611'], rowsByTab: { 2610: oct, 2611: cur } });
  // 유산소: 오늘 기록에 러닝 30분 · 5km를 더해 저장 → 최근 기록에 함께 보임(시트에는 칸이 없어 쓰지 않음)
  await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await m.getByTestId('start-workout').click();
  await m.getByRole('button', { name: '유산소 추가' }).click();
  await m.getByLabel('유산소 1 시간(분)').fill('30');
  await m.getByLabel('유산소 1 거리(km)').fill('5');
  await noOverflow(m, '큰 글씨 유산소 입력');
  await shot(m, '10o_member_cardio');
  await m.getByRole('button', { name: '운동 기록 저장' }).click();
  await soft('유산소를 더한 기록 저장 → 최근 기록에 러닝 30분 · 5km', async () => {
    await m.locator('.toast.visible', { hasText: '유산소 1개' }).waitFor({ timeout: 15000 });
    await m.locator('.workout-row', { hasText: '러닝 30분 · 5km' }).waitFor({ timeout: 10000 });
  });
}
await fakeSheets.close();
// v2.0 커뮤니티 수상 칸(2.3부터 한 달 내내 지난달 결과와 이번 달 참여 현황을 함께) · 설정의 수상 닉네임 공개
await goTab(m, '커뮤니티');
await soft('커뮤니티에 순위 줄과 지난 수상 줄', async () => { await m.getByTestId('standing-workout').waitFor({ timeout: 5000 }); const n = await m.locator('[data-testid=award-standings], [data-testid=awards]').count(); if (n !== 2) throw new Error(`${n}개`); });
await m.getByTestId('standing-workout').click();
await soft('순위 줄을 누르면 그 상의 창과 기준', () => m.locator('dialog .award-rules', { hasText: '8일 이상' }).waitFor({ timeout: 5000 }));
await m.getByRole('button', { name: '창 닫기' }).click();
await m.getByTestId('awards').getByRole('button').click();
await soft('지난 수상 줄을 누르면 지난 수상 창', () => m.locator('dialog [data-testid=award-history]').waitFor({ timeout: 5000 }));
await m.getByRole('button', { name: '창 닫기' }).click();
await goTab(m, '설정');
await soft('가입 때 고른 성별이 설정에 고정으로 보임(고르는 칸 없음)', async () => { await m.locator('.settings-row', { hasText: '성별' }).filter({ hasText: '여자' }).first().waitFor({ timeout: 10000 }); const n = await m.getByRole('group', { name: '성별' }).count(); if (n !== 0) throw new Error(`고르는 칸 ${n}개`); });
await m.getByRole('switch', { name: '수상·식단 닉네임 공개', checked: true }).click({ timeout: 10000 });
await soft('수상·식단 닉네임 공개 끄기', () => m.locator('.toast.visible', { hasText: '익명 회원' }).waitFor({ timeout: 10000 }));
await m.getByRole('switch', { name: '수상·식단 닉네임 공개', checked: false }).click({ timeout: 10000 });
await goTab(m, '운동');
await t.getByRole('button', { name: '식단', exact: true }).click();
await goTab(m, '식단');

// 7b. 회원: 익명 의견 보내기
const FB = `zz검증 의견 ${run}: 사진 올릴 때 조금 느려요`;
await goTab(m, '설정'); // 2.0: 의견 보내기는 설정의 도움말에만
await m.getByRole('button', { name: /의견 보내기/ }).click();
await soft('의견 창에 감사·익명 안내', async () => { await m.getByText('작은 의견 하나도 서비스를 만드는 데 큰 힘이 됩니다').waitFor({ timeout: 5000 }); await m.getByText('누가 보냈는지 남지 않으니 편하게 적어 주세요').waitFor({ timeout: 5000 }); });
await m.getByLabel('내용').fill(FB);
await shot(m, '10b_member_app_feedback');
await m.locator('form.app-feedback-form').getByRole('button', { name: '의견 보내기' }).click();
await soft('의견 보낸 뒤 감사 화면', () => m.getByText('보내 주셔서 고맙습니다').waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '닫기', exact: true }).click();

// 8. 로그아웃 → 틀린 PIN → 로그인
const sizeGroup = m.getByRole('group', { name: '글씨 크기' });
await m.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
await soft('설정 탭에 담당 트레이너', () => m.getByText(`담당 트레이너 · ${T}`).waitFor({ timeout: 5000 }));
await shot(m, '11_member_account');
await noOverflow(m, '큰 글씨 설정');
await soft('설정에서 글씨 크기 크게가 선택돼 있음(로그인 화면에서 고른 값)', async () => { if ((await sizeGroup.getByRole('button', { name: '크게' }).getAttribute('aria-pressed')) !== 'true') throw new Error('크게 아님'); });
await sizeGroup.getByRole('button', { name: '보통' }).click();
await soft('설정에서 보통으로 바꾸면 바로 적용', async () => { const d = await m.evaluate(() => document.documentElement.dataset.text); if (d === 'large') throw new Error(String(d)); });
await shot(m, '11e_member_account_normal');
await sizeGroup.getByRole('button', { name: '크게' }).click();
await soft('설정에서 다시 크게', async () => { const d = await m.evaluate(() => document.documentElement.dataset.text); if (d !== 'large') throw new Error(String(d)); });
// 안 읽은 업데이트 소식 표시는 없앴다(2026-10-26 사용자 결정): 예전 버전만 본 기기여도 점·NEW가 없다
await m.evaluate(() => localStorage.setItem('mealnote:seen-version', '1.0'));
await m.reload(); await m.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 });
await soft('안 읽은 업데이트 소식이 있어도 설정 점·NEW 없음', async () => {
  const dot = await m.locator('.nav-item', { hasText: '설정' }).locator('.nav-dot').count();
  await m.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
  const badges = await m.locator('.app-main .new-badge').count();
  if (dot || badges) throw new Error(`점 ${dot} · NEW ${badges}`);
});
await m.locator('.app-main').getByRole('button', { name: /업데이트 소식/ }).click();
await soft('업데이트 소식에 지금 버전', () => m.locator('.release-head', { hasText: '지금 버전' }).waitFor({ timeout: 5000 }));
await soft('업데이트 소식은 최신 1개만 펼쳐짐', async () => { const n = await m.locator('dialog .release').count(); if (n !== 1) throw new Error('보이는 버전 ' + n); });
await m.getByRole('button', { name: /이전 업데이트 보기/ }).click();
await soft('이전 업데이트 보기로 지난 내역이 열림', async () => { const n = await m.locator('dialog .release').count(); if (n < 2) throw new Error('보이는 버전 ' + n); });
await shot(m, '11c_member_releases');
await m.getByRole('button', { name: '창 닫기' }).click();
// 8e. v1.7 알림: 설정 화면(종류는 계정 전체), 알림을 눌러 연 화면으로 이동(서비스워커가 남긴 요청을 흉내 냄)
await m.getByRole('button', { name: '알림', exact: true }).click();
await soft('설정 → 알림 창', () => m.locator('dialog .push-settings').waitFor({ timeout: 5000 }));
await soft('서비스워커가 없는 아이폰 화면(브라우저 탭)은 홈 화면 추가 안내', async () => {
  await m.locator('dialog .push-settings').getByText('홈 화면에 추가한 앱에서 알림을 켤 수 있어요', { exact: false }).waitFor({ timeout: 10000 });
  await m.getByLabel(/아침 응원/).waitFor();
  await m.getByLabel('트레이너가 남긴 피드백').waitFor();
  await m.getByLabel(/식단 기록 알림/).waitFor();
});
await noOverflow(m, '큰 글씨 알림 창');
await shot(m, '11f_member_push_settings');
await m.getByLabel(/식단 기록 알림/).uncheck();
await m.waitForTimeout(800);
await m.getByRole('button', { name: '창 닫기' }).click();
await m.getByRole('button', { name: '알림', exact: true }).click();
await soft('알림 종류는 저장돼 다시 열어도 그대로', async () => { await m.getByLabel('트레이너가 남긴 피드백').waitFor({ timeout: 10000 }); if (await m.getByLabel(/식단 기록 알림/).isChecked()) throw new Error('다시 켜져 있음'); });
await m.getByLabel(/식단 기록 알림/).check();
await m.waitForTimeout(500);
// 알림 설정 그림 안내: 같은 창 안에서 열림 · 기종 선택 · 단계 글과 그림 · 막힐 때 · 돌아가기(설정은 그대로)
await m.getByRole('button', { name: '알림 설정 방법 보기' }).click();
await soft('알림 설정 방법 보기 → 같은 창 안에 그림 안내(아이폰 화면은 아이폰이 기본)', async () => {
  await m.locator('dialog[open] .notification-guide').waitFor({ timeout: 5000 });
  if ((await m.getByRole('button', { name: '아이폰', exact: true }).getAttribute('aria-pressed')) !== 'true') throw new Error('아이폰이 기본이 아님');
  const n = await m.locator('.guide-step').count(); if (n !== 8) throw new Error('단계 ' + n);
});
await soft('안내를 열면 돌아가기 버튼과 제목이 창 제목줄에 가리지 않음', async () => {
  const [head, back] = await Promise.all([m.locator('dialog[open] .sheet-top h2').boundingBox(), m.locator('.guide-back').boundingBox()]);
  if (!head || !back || back.y < head.y + head.height - 1) throw new Error(JSON.stringify({ head, back }));
});
await noOverflow(m, '큰 글씨 알림 그림 안내');
await shot(m, '11j_member_push_guide');
await soft('그림 안내 이미지 16장이 모두 열림', async () => {
  const bad = await m.evaluate(async () => {
    const out = [];
    for (const p of ['ios', 'android']) for (let i = 1; i <= 8; i++) {
      const url = `/guides/notifications/${p}-0${i}.png`;
      const r = await fetch(url);
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('image')) out.push(url);
    }
    return out;
  });
  if (bad.length) throw new Error(bad.join(','));
  const first = m.locator('.guide-step-image').first();
  await first.scrollIntoViewIfNeeded();
  await m.waitForFunction(() => document.querySelector('.guide-step-image')?.complete && document.querySelector('.guide-step-image').naturalWidth > 0, null, { timeout: 10000 });
});
await soft('그림마다 무엇을 누르는지 글(alt)이 있음', async () => {
  const alts = await m.locator('.guide-step-image').evaluateAll((els) => els.map((e) => e.getAttribute('alt') ?? ''));
  if (alts.length !== 8 || alts.some((a) => a.length < 10 || a.includes('<b>'))) throw new Error(JSON.stringify(alts.slice(0, 2)));
});
await m.getByRole('button', { name: '안드로이드', exact: true }).click();
await soft('안드로이드로 바꾸면 Chrome 안내 8단계(설치 없이 5단계부터)', async () => {
  await m.locator('.notification-guide', { hasText: '설치 없이 알림만 켜려면 5단계부터' }).waitFor({ timeout: 3000 });
  const t = await m.locator('.guide-step-title').first().innerText(); if (!t.includes('Chrome')) throw new Error(t);
  if ((await m.locator('.guide-step').count()) !== 8) throw new Error('단계 수');
});
await m.locator('.guide-help summary', { hasText: '허용 안 함' }).click();
await soft('막힐 때 도움말이 펼쳐짐', () => m.locator('.guide-help details[open]', { hasText: '설정 → 알림 → FITORY(예전에 추가했다면 식단노트)' }).waitFor({ timeout: 3000 }));
await m.getByRole('button', { name: '알림 설정으로 돌아가기' }).first().click();
await soft('돌아가면 알림 설정 화면, 안내를 열어도 설정은 그대로', async () => {
  await m.getByLabel(/식단 기록 알림/).waitFor({ timeout: 5000 });
  if (!(await m.getByLabel(/식단 기록 알림/).isChecked())) throw new Error('설정이 바뀜');
});
await m.getByRole('button', { name: '창 닫기' }).click();
// 알림을 눌러 열기는 서비스워커가 있는 주소(localhost)에서 본다
{
  const LOCALBASE = BASE.replace(/\/\/[^:/]+/, '//localhost');
  const p = await mk();
  await p.goto(LOCALBASE);
  await p.getByRole('button', { name: /회원으로 시작/ }).click();
  await p.getByLabel('닉네임', { exact: true }).fill(M); await p.getByLabel('PIN', { exact: true }).fill(PIN);
  await p.getByRole('button', { name: '로그인', exact: true }).last().click();
  await p.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 });
  const memberId = await p.evaluate(() => JSON.parse(localStorage.getItem('mealnote:remember') ?? 'null')?.userId);
  const setPushOpen = (open, uid) => p.evaluate(([open, uid]) => new Promise((resolve, reject) => {
    const r = indexedDB.open('mealnote-push', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ open, uid, at: Date.now() }, 'open'); tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    r.onerror = () => reject(r.error);
  }), [open, uid]);
  const nudge = () => p.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'mealnote:push-open' } })));
  await p.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
  await p.getByRole('button', { name: '알림', exact: true }).click();
  await soft('알림 권한을 거부한 기기는 휴대폰 설정에서 허용하라는 안내', () => p.locator('dialog .push-settings').getByText('휴대폰 설정 → 알림에서 FITORY(예전에 추가했다면 식단노트)를 허용해 주세요', { exact: false }).waitFor({ timeout: 10000 }));
  await p.getByRole('button', { name: '창 닫기' }).click();
  // 화면 없는 크롬은 알림 권한을 늘 '거부'로 돌려주므로, '아직 묻지 않음'과 허용 응답은 흉내 낸다
  await p.context().addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    Notification.requestPermission = async () => 'granted';
  });
  await p.reload();
  await p.getByRole('heading', { name: '설정', exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
  await p.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
  await p.getByRole('button', { name: '알림', exact: true }).click();
  await soft('알림을 켤 수 있는 화면은 이 기기 켜기 버튼', () => p.getByRole('button', { name: '이 기기에서 알림 받기' }).waitFor({ timeout: 10000 }));
  await p.getByRole('button', { name: '이 기기에서 알림 받기' }).click();
  await soft('기기 등록이 실패하면 켰다고 하지 않고 실패를 알림', async () => {
    await p.locator('dialog .field-error', { hasText: '이 기기에서 알림을 등록하지 못했어요' }).waitFor({ timeout: 15000 });
    if (await p.getByText('알림을 켰어요').count()) throw new Error('켰다고 표시됨');
  });
  await p.getByRole('button', { name: '창 닫기' }).click();
  // 작성 중 알림을 누름: 화면은 피드백으로 가고, 쓰던 식단 창과 입력은 그대로
  await p.locator('.bottom-nav').getByRole('button', { name: /^식단/ }).click();
  await p.getByRole('button', { name: '식단 기록하기' }).first().click();
  await p.getByLabel('무엇을 드셨나요?').fill('알림 누르기 전 쓰던 음식');
  await setPushOpen('feedback', memberId);
  await nudge();
  await soft('작성 중 알림을 눌러도 쓰던 내용이 남음', async () => { await p.waitForTimeout(800); const v = await p.getByLabel('무엇을 드셨나요?').inputValue(); if (v !== '알림 누르기 전 쓰던 음식') throw new Error(v); });
  p.once('dialog', (d) => void d.accept()); // 쓰던 내용이 있어 닫기 전에 묻는다(2.3)
  await p.keyboard.press('Escape');
  await soft('알림을 누르면 식단 탭의 받은 피드백', () => p.getByRole('heading', { name: /받은 피드백/ }).waitFor({ timeout: 5000 }));
  // 다른 계정에게 온 알림이면 이동하지 않음
  await p.locator('.bottom-nav').getByRole('button', { name: /^식단/ }).click();
  await setPushOpen('feedback', '00000000-0000-4000-8000-000000000000');
  await nudge();
  await soft('다른 계정에게 온 알림이면 지금 화면 그대로', async () => { await p.waitForTimeout(800); await p.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 2000 }); });
  // 앱이 닫혀 있을 때 알림을 누름: 다시 열면 그 화면
  await setPushOpen('feedback', memberId);
  await p.reload();
  await soft('닫힌 앱을 알림으로 열면 그 화면', () => p.getByRole('heading', { name: /받은 피드백/ }).waitFor({ timeout: 15000 }));
  await p.context().close();
}
// 트레이너: 요약 받는 횟수(하루 3회 기본 · 5회), 계정 전체 설정
await t.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
await t.getByRole('button', { name: '알림', exact: true }).click();
await soft('트레이너 알림 창: 요약 켜기와 하루 3회 기본', async () => {
  await t.getByLabel('확인할 식사 기록·답할 질문 요약').waitFor({ timeout: 10000 });
  if ((await t.getByRole('button', { name: /하루 3회/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('3회가 기본이 아님');
});
await t.getByRole('button', { name: /하루 5회/ }).click();
await t.waitForTimeout(800);
await t.getByRole('button', { name: '창 닫기' }).click();
await t.getByRole('button', { name: '알림', exact: true }).click();
await soft('하루 5회로 바꾸면 저장됨', async () => { await t.getByRole('button', { name: /하루 5회/ }).waitFor({ timeout: 10000 }); if ((await t.getByRole('button', { name: /하루 5회/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('저장 안 됨'); });
await shot(t, '11g_trainer_push_settings');
await t.getByRole('button', { name: '창 닫기' }).click();
await t.locator('.bottom-nav').getByRole('button', { name: /^확인/ }).click();
// 알림 모아보기(최근 1주일): 종 버튼의 점 → 목록 → 누르면 그 식사 상세 → 점 사라짐
// 회원은 지금까지의 피드백을 모두 읽었다(v1.8: 따로 읽은 소식은 점에서 빠진다). 한 식사를 아직 안 읽은 상태로 되돌린다
await sql(`update public.meals m set member_seen_at = m.created_at from public.profiles p where p.id = m.member_id and p.nickname = '${M}' and m.rated_at is not null`);
await m.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await soft('회원: 새 소식이 있으면 머리글 종 버튼에 점', () => m.locator('.app-header .bell-toggle .bell-dot').waitFor({ timeout: 15000 }));
await m.locator('.app-header .bell-toggle').click();
await soft('회원 알림 목록에 트레이너 피드백(새 소식 강조)', () => m.locator('dialog .activity-item.new', { hasText: '트레이너가' }).first().waitFor({ timeout: 10000 }));
await soft('회원 알림 목록에 끼니 기록 알림은 없음', async () => { if (await m.locator('dialog .activity-item', { hasText: '식단을 남겨' }).count()) throw new Error('있음'); });
await noOverflow(m, '큰 글씨 알림 목록');
await shot(m, '11h_member_activity');
await m.locator('dialog .activity-item', { hasText: '트레이너가' }).first().click();
await soft('회원: 알림을 누르면 그 식사 상세', () => m.locator('dialog[open] .sheet-top h2', { hasText: '기록' }).waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '창 닫기' }).click();
await soft('회원: 목록을 연 뒤에는 종 버튼 점이 사라짐', () => m.locator('.app-header .bell-toggle .bell-dot').waitFor({ state: 'detached', timeout: 15000 }));
await t.reload();
await t.getByRole('heading', { name: '확인', exact: true }).waitFor({ timeout: 15000 });
await t.locator('.app-header .bell-toggle').click();
await soft('트레이너 알림 목록에 회원의 식사 기록', () => t.locator('dialog .activity-item', { hasText: `${M} 회원이` }).first().waitFor({ timeout: 10000 }));
await shot(t, '11i_trainer_activity');
await t.locator('dialog .activity-item', { hasText: `${M} 회원이` }).first().click();
await soft('트레이너: 알림을 누르면 그 식사 상세', () => t.locator('dialog[open] .sheet-top h2', { hasText: `${M}님의` }).waitFor({ timeout: 10000 }));
await t.getByRole('button', { name: '창 닫기' }).click();
await goTab(m, '설정');
await m.getByRole('button', { name: '로그아웃' }).click();
await soft('로그아웃 뒤 역할 선택 없이 닉네임이 채워진 로그인 화면', async () => {
  const input = m.getByLabel('닉네임', { exact: true });
  await input.waitFor({ timeout: 10000 });
  const v = await input.inputValue();
  if (v !== M) throw new Error('nickname=' + v);
});
await shot(m, '11d_member_relogin');
await soft('로그아웃 뒤 로그인 화면도 고른 테마(다크)', async () => { const t = await themeOf(m); if (t !== 'dark') throw new Error(String(t)); });
await m.getByLabel('닉네임', { exact: true }).fill(M.toUpperCase());
await m.getByLabel('PIN', { exact: true }).fill('000000');
const wrongPin = expectFail('/auth/v1/token', 400, '틀린 PIN 로그인');
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('틀린 PIN 안내', () => m.getByText('닉네임 또는 PIN이 맞지 않아요').waitFor({ timeout: 10000 }));
wrongPin();
await m.getByLabel('PIN', { exact: true }).fill(PIN);
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('대소문자 달라도 닉네임+PIN 로그인', () => m.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));
await soft('다시 로그인해도 테마 유지', async () => { const t = await themeOf(m); if (t !== 'dark') throw new Error(String(t)); });

// 8b. 운영자: 가입 → 받은 의견 → 처리 완료
const ADMIN = process.env.ADMIN_CODE;
const a = await mk();
await a.goto(BASE);
await a.getByRole('button', { name: /트레이너로 시작/ }).click();
await a.getByRole('button', { name: '처음이에요' }).click();
await a.getByLabel('닉네임', { exact: true }).fill(`zz검증운영${run}`);
await a.getByLabel('PIN', { exact: true }).fill(PIN);
await a.getByLabel('PIN 확인').fill(PIN);
await a.getByLabel('트레이너 등록 코드').fill(ADMIN);
await fillRecovery(a, '아이유', '가장 좋아하는 가수나 배우는?');
await a.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('운영자 코드로 가입 → 받은 의견 화면', () => a.getByRole('heading', { name: '받은 의견' }).waitFor({ timeout: 15000 }));
await soft('회원이 보낸 의견이 보임(작성자 없이)', async () => {
  const card = a.locator('.admin-feedback', { hasText: FB });
  await card.waitFor({ timeout: 10000 });
  const txt = await card.innerText();
  if (txt.includes(M)) throw new Error('작성자 닉네임이 보임');
});
await shot(a, '11b_admin_feedback');
await a.locator('.admin-feedback', { hasText: FB }).getByRole('button', { name: '처리 완료' }).click();
await soft('처리 완료하면 처리할 의견에서 빠짐', () => a.locator('.admin-feedback', { hasText: FB }).waitFor({ state: 'detached', timeout: 5000 }));
await a.context().close();

// 8c. PIN을 잊었을 때(v1.3): 다른 기기에서 복구 질문 답 → 바로 새 PIN → 로그인해 둔 기기에 알림 → '제가 바꾼 게 아니에요' → 되찾기
const NEW_PIN = '864201';
await soft('트레이너 화면에 PIN 재설정 기능이 없음', async () => {
  await t.reload();
  if (await t.getByText('PIN 재설정 요청').count()) throw new Error('trainer pin reset UI still exists');
});
const m2 = await mk();
await m2.goto(BASE);
await m2.getByRole('button', { name: /회원으로 시작/ }).click();
await m2.getByRole('button', { name: 'PIN을 잊으셨나요?' }).click();
await m2.getByLabel('닉네임', { exact: true }).fill(M);
await m2.getByRole('button', { name: '다음' }).click();
await soft('PIN 찾기: 가입 때 고른 질문이 보임', () => m2.getByText('가장 좋아하는 영화 제목은?').waitFor({ timeout: 10000 }));
await m2.getByLabel('답', { exact: true }).fill('타이타닉');
await m2.getByLabel('새 PIN', { exact: true }).fill(NEW_PIN);
await m2.getByLabel('새 PIN 확인').fill(NEW_PIN);
await m2.getByRole('button', { name: '새 PIN으로 바꾸기' }).click();
await soft('틀린 답 → 남은 횟수 안내', () => m2.getByText('4번 더 틀리면 하루 동안 막혀요').waitFor({ timeout: 10000 }));
await shot(m2, '12_forgot_wrong');
await m2.getByLabel('답', { exact: true }).fill('어바웃타임');
await m2.getByRole('button', { name: '새 PIN으로 바꾸기' }).click();
await soft('맞는 답(띄어쓰기 달라도) → 바로 로그인', () => m2.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));
await soft('방금 바꾼 기기에는 PIN 변경 알림이 안 뜸', async () => { await m2.waitForTimeout(1500); if (await m2.getByText('PIN이 바뀌었어요').count()) throw new Error('alert on changing device'); });

await m.reload();
await soft('로그인해 둔 기기에 PIN 변경 알림', () => m.getByText('직접 바꾸신 게 맞나요?').waitFor({ timeout: 15000 }));
await shot(m, '13_pin_changed_alert');
await m.getByRole('button', { name: '제가 바꾼 게 아니에요' }).click();
await m.getByLabel('새 PIN', { exact: true }).fill(PIN);
await m.getByLabel('새 PIN 확인').fill(PIN);
await fillRecovery(m, '밤양갱', '가장 좋아하는 노래 제목은?');
await shot(m, '14_reclaim');
await m.getByRole('button', { name: '계정 되찾기' }).click();
await soft('되찾기 완료', () => m.getByText('계정을 되찾았어요').waitFor({ timeout: 15000 }));
await soft('되찾은 뒤 알림이 다시 안 뜸', async () => { await m.reload(); await m.waitForTimeout(2000); if (await m.getByText('직접 바꾸신 게 맞나요?').count()) throw new Error('alert again'); });
await m2.context().close();

// 다른 사람이 PIN 찾기에서 답을 틀리면 로그인해 둔 기기에 알림
const x = await mk();
await x.goto(BASE);
await x.getByRole('button', { name: /회원으로 시작/ }).click();
await x.getByRole('button', { name: 'PIN을 잊으셨나요?' }).click();
await x.getByLabel('닉네임', { exact: true }).fill(M);
await x.getByRole('button', { name: '다음' }).click();
await x.getByLabel('답', { exact: true }).fill('모르는 답');
await x.getByLabel('새 PIN', { exact: true }).fill('999999');
await x.getByLabel('새 PIN 확인').fill('999999');
await x.getByRole('button', { name: '새 PIN으로 바꾸기' }).click();
await x.getByText('번 더 틀리면').waitFor({ timeout: 10000 });
await x.context().close();
await m.reload();
await soft('틀린 시도 알림', () => m.getByText('PIN 찾기에서 복구 질문의 답을 틀렸어요').waitFor({ timeout: 15000 }));
await m.getByRole('button', { name: '확인했어요' }).click();

// 로그인 상태에서 '지금 PIN이 기억나지 않아요' → 복구 답으로 PIN 바꾸기
await m.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
await m.getByRole('button', { name: /PIN 바꾸기/ }).click();
await m.getByRole('button', { name: '지금 PIN이 기억나지 않아요' }).click();
await m.getByLabel('답', { exact: true }).fill('밤 양갱');
await m.getByLabel('새 PIN', { exact: true }).fill(NEW_PIN);
await m.getByLabel('새 PIN 확인').fill(NEW_PIN);
await m.locator('dialog').getByRole('button', { name: 'PIN 바꾸기' }).click();
await soft('복구 답으로 PIN 바꾸기', () => m.getByText('PIN을 바꿨어요').waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '닫기', exact: true }).click();
await m.getByRole('button', { name: '로그아웃' }).click();
await m.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('바꾼 PIN으로 다시 로그인', () => m.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));

// 복구 질문이 없는 기존 계정: 정하라는 안내(로컬 DB에서만 질문을 지워 본다)
if (LOCAL) {
  await sql(`update private.account_security set question = null, answer_hash = null where user_id = (select id from public.profiles where nickname = '${M}');`);
  await m.reload();
  await soft('복구 질문이 없으면 정하라는 안내', () => m.getByRole('heading', { name: '복구 질문을 정해 주세요' }).waitFor({ timeout: 15000 }));
  await shot(m, '15_recovery_setup');
  await fillRecovery(m, '제주도', '가장 기억에 남는 여행지는?');
  await m.getByLabel('지금 PIN').fill(NEW_PIN);
  await m.getByRole('button', { name: '저장하기' }).click();
  await soft('복구 질문 저장', () => m.getByText('복구 질문을 정했어요').waitFor({ timeout: 10000 }));
  await m.getByRole('button', { name: '닫기', exact: true }).click();
}

// 8d. v1.6 닉네임 바꾸기: 지금 PIN 확인 → 바로 새 이름으로 보임 → 로그인 화면에 새 닉네임 → 새 닉네임으로 로그인 → 트레이너에게도 새 이름
const M2 = `${M}새`;
// 같은 계정으로 로그인해 둔 다른 기기 두 대: v1.6에서 로그인한 기기(기억값에 사용자 ID)와 v1.5 때 로그인한 기기(ID 없는 옛 기억값)
const loginOn = async (nick) => {
  const p = await mk(); await p.goto(BASE);
  await p.getByRole('button', { name: /회원으로 시작/ }).click();
  await p.getByLabel('닉네임', { exact: true }).fill(nick); await p.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
  await p.getByRole('button', { name: '로그인', exact: true }).last().click();
  await p.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 });
  return p;
};
const rememberedOf = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mealnote:remember') ?? 'null'));
const devB = await loginOn(M), devC = await loginOn(M), devD = await loginOn(M), devE = await loginOn(M);
await soft('로그인하면 기억값에 사용자 ID도 남김', async () => { const r = await rememberedOf(devB); if (!r?.userId || r.nickname !== M) throw new Error(JSON.stringify(r)); });
for (const d of [devC, devD, devE]) await d.evaluate(() => { const r = JSON.parse(localStorage.getItem('mealnote:remember')); delete r.userId; localStorage.setItem('mealnote:remember', JSON.stringify(r)); });
// D·E: '예전 닉네임인지' 서버 응답(실제 응답)을 받아 두고 앱에는 로그아웃한 뒤에 넘긴다(Codex v1.6 재리뷰 P2)
const holdFormer = async (d) => {
  let sent, release; const asked = new Promise((r) => (sent = r)); const gate = new Promise((r) => (release = r));
  await d.route('**/rest/v1/rpc/is_my_former_nickname', async (route) => { const res = await route.fetch(); sent(await res.text()); await gate; await route.fulfill({ response: res }); });
  return { asked, release };
};
const holdD = await holdFormer(devD), holdE = await holdFormer(devE);
await m.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
await m.getByRole('button', { name: /닉네임 바꾸기/ }).click();
await m.getByLabel('새 닉네임').fill(T);
await m.getByLabel('지금 PIN').fill(NEW_PIN);
await m.locator('dialog').getByRole('button', { name: '닉네임 바꾸기' }).click();
await soft('이미 쓰는 닉네임이면 안내', () => m.locator('dialog .field-error', { hasText: '이미 다른 분이 쓰는 닉네임' }).waitFor({ timeout: 10000 }));
await m.getByLabel('새 닉네임').fill(M2);
await m.getByLabel('지금 PIN').fill('000000');
await m.locator('dialog').getByRole('button', { name: '닉네임 바꾸기' }).click();
await soft('PIN이 틀리면 안내', () => m.locator('dialog .field-error', { hasText: '지금 PIN이 맞지 않아요' }).waitFor({ timeout: 10000 }));
await shot(m, '16_nickname_form');
await noOverflow(m, '큰 글씨 닉네임 바꾸기 창');
await m.getByLabel('지금 PIN').fill(NEW_PIN);
await m.locator('dialog').getByRole('button', { name: '닉네임 바꾸기' }).click();
await soft('닉네임을 바꿨다는 안내', () => m.getByText('닉네임을 바꿨어요').waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '닫기', exact: true }).click();
await soft('새로 고치지 않아도 내 정보에 새 닉네임', () => m.locator('.profile-line', { hasText: `${M2} 회원` }).waitFor({ timeout: 10000 }));
// 다른 기기: 새로 고침 → 새 이름 → 기억값도 새 이름 → 로그아웃 → 로그인 칸에 새 이름 → 지금 PIN으로 로그인(Codex v1.6 리뷰 P2)
// 로그아웃은 같은 계정의 모든 기기 세션을 끝내므로, 새로 고침 확인을 두 기기 모두 먼저 하고 로그아웃은 그다음에 한다.
const others = [['v1.6에서 로그인한 다른 기기', devB], ['옛 기억값(사용자 ID 없음)이 남은 다른 기기', devC]];
for (const [label, d] of others) {
  await d.reload();
  await soft(`${label}: 새로 고치면 새 닉네임`, () => d.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }).then(async () => {
    await d.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
    await d.locator('.profile-line', { hasText: `${M2} 회원` }).waitFor({ timeout: 10000 });
  }));
  await soft(`${label}: 기억값도 새 닉네임`, () => d.waitForFunction((n) => JSON.parse(localStorage.getItem('mealnote:remember') ?? 'null')?.nickname === n, M2, { timeout: 10000 }));
}
// 확인 응답이 오기 전에 로그아웃: 응답이 늦게 와도 로그인 칸이 새 이름으로 바뀌어야 한다(D). 사람이 고쳐 쓴 이름은 그대로(E)
for (const d of [devD, devE]) {
  await d.reload();
  await d.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 });
  await d.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
  await d.locator('.profile-line', { hasText: `${M2} 회원` }).waitFor({ timeout: 10000 });
}
await soft('늦은 응답: 서버는 본인의 예전 닉네임이라고 답함', async () => { const a = await holdD.asked; if (a !== 'true') throw new Error(a); });
// 로그아웃은 같은 계정의 모든 세션을 끝낸다 — 이어지는 기기들의 로그아웃(D·E·B·C·처음 기기, 5번)은 이미 끝난 세션이라 403일 수 있다
const loggedOut = expectFail('/auth/v1/logout', 403, '다른 기기의 로그아웃으로 이미 끝난 세션에서 다시 로그아웃', 5);
// 같은 이유로, 아직 열려 있던 기기가 로그아웃 전에 연속 기록을 한 번 더 조회하면 끝난 세션이라 not_allowed(400)다 — 조회 시점이 그때그때 달라 있을 때만 뺀다(2026-11-02 실패 응답 기록으로 확인)
const streakRevoked = expectFail('/rest/v1/rpc/meal_streak', 400, '다른 기기의 로그아웃으로 끝난 세션의 연속 기록 조회(not_allowed)', 8);
await devD.getByRole('button', { name: '로그아웃' }).click();
await soft('늦은 응답: 응답 전 로그인 칸은 아직 옛 닉네임', async () => { const v = await devD.getByLabel('닉네임', { exact: true }).inputValue(); if (v !== M) throw new Error(v); });
holdD.release();
await soft('늦은 응답: 응답이 오면 로그인 칸도 새 닉네임', async () => {
  const field = devD.getByLabel('닉네임', { exact: true });
  for (let i = 0; i < 40 && (await field.inputValue()) !== M2; i++) await devD.waitForTimeout(250);
  const v = await field.inputValue(); if (v !== M2) throw new Error(v);
});
await devD.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
await devD.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('늦은 응답: 바뀐 이름 그대로 지금 PIN으로 로그인', () => devD.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));
await devD.context().close();
await holdE.asked;
await devE.getByRole('button', { name: '로그아웃' }).click();
await devE.getByLabel('닉네임', { exact: true }).fill(`${M2}직접`);
holdE.release();
await soft('늦은 응답: 기억값은 새 닉네임으로', () => devE.waitForFunction((n) => JSON.parse(localStorage.getItem('mealnote:remember') ?? 'null')?.nickname === n, M2, { timeout: 10000 }));
await soft('늦은 응답: 사람이 고쳐 쓴 로그인 칸은 그대로', async () => { await devE.waitForTimeout(500); const v = await devE.getByLabel('닉네임', { exact: true }).inputValue(); if (v !== `${M2}직접`) throw new Error(v); });
await devE.context().close();
for (const [label, d] of others) {
  await d.getByRole('button', { name: '로그아웃' }).click();
  await soft(`${label}: 로그인 칸에 새 닉네임`, async () => { const v = await d.getByLabel('닉네임', { exact: true }).inputValue(); if (v !== M2) throw new Error(v); });
  await d.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
  await d.getByRole('button', { name: '로그인', exact: true }).last().click();
  await soft(`${label}: 채워진 이름 그대로 지금 PIN으로 로그인`, () => d.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));
  await d.context().close();
}
await m.getByRole('button', { name: '로그아웃' }).click();
await soft('로그인 화면에 새 닉네임이 채워짐', async () => { const v = await m.getByLabel('닉네임', { exact: true }).inputValue(); if (v !== M2) throw new Error(v); });
loggedOut();
streakRevoked();
await m.getByLabel('닉네임', { exact: true }).fill(M);
await m.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
const oldName = expectFail('/auth/v1/token', 400, '옛 닉네임으로 로그인');
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('옛 닉네임으로는 로그인 안 됨', () => m.getByText('닉네임 또는 PIN이 맞지 않아요').waitFor({ timeout: 10000 }));
oldName();
await m.getByLabel('닉네임', { exact: true }).fill(M2);
await m.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('새 닉네임으로 로그인', () => m.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }));
await t.reload();
await goTab(t, '회원');
await soft('트레이너 담당 회원 목록에 새 닉네임', () => t.locator('.member-row', { hasText: `${M2} 회원` }).waitFor({ timeout: 15000 }));
await goTab(t, '확인');
// 다른 사람의 기억값은 건드리지 않는다: 이 계정의 예전 이름이 아닌 옛 기억값, 다른 사용자 ID가 붙은 기억값
await soft('다른 사람의 기억값은 그대로', async () => {
  const p = await loginOn(M2);
  const others = [{ nickname: `zz검증남${run}`, role: 'trainer' }, { nickname: M, role: 'member', userId: '00000000-0000-4000-8000-000000000000' }];
  const seen = [];
  for (const v of others) {
    await p.evaluate((x) => localStorage.setItem('mealnote:remember', JSON.stringify(x)), v);
    await p.reload(); await p.getByRole('heading', { name: '식단', exact: true }).waitFor({ timeout: 15000 }); await p.waitForTimeout(1500);
    seen.push(await rememberedOf(p));
  }
  await p.context().close();
  if (JSON.stringify(seen) !== JSON.stringify(others)) throw new Error(JSON.stringify(seen));
});
// 운영자 화면 보안 기록에 닉네임 변경
await soft('운영자 화면 보안 기록에 닉네임 변경', async () => {
  const p = await mk(); await p.goto(BASE);
  await p.getByRole('button', { name: /트레이너로 시작/ }).click();
  await p.getByLabel('닉네임', { exact: true }).fill(`zz검증운영${run}`); await p.getByLabel('PIN', { exact: true }).fill(PIN);
  await p.getByRole('button', { name: '로그인', exact: true }).last().click();
  await p.locator('.security-events p', { hasText: `${M2} · 닉네임을 바꿈` }).waitFor({ timeout: 15000 });
  await p.context().close();
});

// 8e. v1.8 공유 식단: 회원 동의 → 트레이너가 식사 공유 → 회원 '오늘'의 추천 식단(사진은 서버 기능으로) → 동의 끄면 사라짐
const memberTab = (name) => goTab(m, name);
await m.reload();
await memberTab('식단');
await m.getByRole('button', { name: '식단 기록하기' }).first().click();
await m.locator('input[aria-label="식사 사진 선택"]').setInputFiles(`${OUT}/upload.png`);
await m.getByLabel('무엇을 드셨나요?').fill('공유 검증 연어 포케');
await m.getByRole('button', { name: '식단 등록하기' }).click();
await soft('공유할 사진 식사 등록', () => m.getByText('식단을 등록했어요').waitFor({ timeout: 15000 }));
await memberTab('설정');
await m.getByRole('switch', { name: '내 식단 공유 허용' }).click({ timeout: 15000 });
await soft('회원이 식단 공유 허용', () => m.getByText('트레이너가 고른 식단을 다른 회원에게 보여 줄 수 있어요').waitFor({ timeout: 10000 }));
await t.reload();
await goTab(t, '회원');
await t.locator('.member-row', { hasText: M2 }).click();
await t.locator('.meal-card', { hasText: '공유 검증 연어 포케' }).click({ timeout: 15000 });
await t.getByTestId('share-meal').filter({ hasText: '좋은 식단으로 공유' }).click({ timeout: 10000 });
await soft('트레이너가 식사를 추천 식단으로 공유', () => t.getByText('추천 식단으로 공유했어요').waitFor({ timeout: 10000 }));
await soft('공유하면 일주일 뒤 날짜까지 보인다는 안내(이번 주 추천 식단)', async () => {
  const end = new Date(Date.now() + 7 * 86_400_000);
  await t.getByTestId('share-note').filter({ hasText: `${end.getMonth() + 1}월 ${end.getDate()}일까지 보여요` }).waitFor({ timeout: 5000 });
});
await t.locator('dialog .rating-panel').getByRole('button', { name: '아주 좋아요' }).click();
await t.locator('dialog .rating-button[aria-pressed=true]').waitFor({ timeout: 10000 });
await t.getByRole('button', { name: '창 닫기' }).click();
// v1.8.2 피드백 탭 '모두 읽음': 새 피드백(평가만 받은 식사)을 하나씩 열지 않고 읽음으로
await m.reload();
await memberTab('식단');
await m.getByTestId('feedback-entry').click();
await soft('받은 피드백에 모두 읽음 버튼', () => m.getByTestId('mark-all-read').waitFor({ timeout: 15000 }));
await m.getByTestId('mark-all-read').click();
await soft('모두 읽음 → NEW·탭 빨간 점·버튼이 사라짐', async () => {
  await m.getByText('피드백을 모두 읽음으로 표시했어요').waitFor({ timeout: 10000 });
  await m.waitForTimeout(500);
  const left = { news: await m.locator('.feedback-card .new-badge').count(), dots: await m.locator('.nav-item:has(.nav-dot)').filter({ hasText: '식단' }).count(), btn: await m.getByTestId('mark-all-read').count() };
  if (left.news || left.dots || left.btn) throw new Error(JSON.stringify(left));
});
await m.reload();
await memberTab('커뮤니티');
await soft('커뮤니티 탭 추천 식단에 내 식단(사진 포함, 2.0에서 오늘 화면 → 커뮤니티)', async () => {
  const item = m.locator('[data-testid=shared-meals] .shared-item', { hasText: '내 식단' });
  await item.waitFor({ timeout: 15000 });
  await item.scrollIntoViewIfNeeded(); // 남의 사진 칸은 화면에 들어올 때 받는다
  await item.locator('img').waitFor({ timeout: 10000 });
});
await noOverflow(m, '큰 글씨 추천 식단');
await m.locator('[data-testid=shared-meals] .shared-item', { hasText: '내 식단' }).click();
await soft('추천 식단을 누르면 사진을 크게(음식·평가·날짜만)', async () => {
  const d = m.getByTestId('shared-detail');
  await d.locator('img.detail-photo').waitFor({ timeout: 10000 });
  const w = await d.locator('img.detail-photo').evaluate((el) => (el.complete ? el.naturalWidth : new Promise((r) => { el.onload = () => r(el.naturalWidth); el.onerror = () => r(0); })));
  if (!(w > 0)) throw new Error('사진 없음');
  const h = await d.locator('img.detail-photo').evaluate((el) => el.getBoundingClientRect().height);
  if (h !== 260) throw new Error(`추천 식단 상세 사진 영역 높이 ${h}`);
  await d.filter({ hasText: '공유 검증 연어 포케' }).waitFor({ timeout: 3000 });
});
await noOverflow(m, '큰 글씨 추천 식단 크게 보기');
await shot(m, '12_member_shared_detail');
await m.getByRole('button', { name: '창 닫기' }).click();
await memberTab('설정');
await m.getByRole('switch', { name: '내 식단 공유 허용', checked: true }).click({ timeout: 10000 });
await soft('동의 끄기 안내', () => m.getByText('공유를 껐어요').waitFor({ timeout: 10000 }));
await m.reload();
await memberTab('커뮤니티');
await soft('동의를 끄면 추천 식단에서 사라짐', () => m.locator('[data-testid=shared-meals]', { hasText: '트레이너가 좋은 식단을 고르면' }).waitFor({ timeout: 15000 }));

// 8f. v1.8 담당에서 내보내기 → 회원은 트레이너 다시 고르기(내보낸 트레이너 없음)
await t.reload();
await goTab(t, '회원');
await t.locator('.member-row', { hasText: M2 }).click();
await t.getByTestId('remove-member').click({ timeout: 10000 });
await t.getByTestId('remove-member').filter({ hasText: '한 번 더' }).click();
await soft('트레이너가 회원을 담당에서 내보냄', () => t.getByText('담당에서 내보냈어요').waitFor({ timeout: 10000 }));
await soft('내보낸 회원은 담당 회원 목록에서 빠짐', async () => { await t.waitForTimeout(800); if (await t.locator('.member-row', { hasText: M2 }).count()) throw new Error('남아 있음'); });
await m.reload();
await soft('내보내진 회원에게 트레이너 다시 고르기 화면', () => m.getByTestId('choose-trainer').waitFor({ timeout: 15000 }));
await soft('다시 고르기 목록에 내보낸 트레이너 없음', async () => {
  await m.waitForTimeout(1000);
  const opts = await m.locator('[data-testid=choose-trainer] option').allInnerTexts();
  if (opts.includes(T)) throw new Error(opts.join(','));
});
await noOverflow(m, '큰 글씨 트레이너 다시 고르기');

// 8g. v1.8.2 로그인 화면 입력칸도 16px 이상(아이폰 확대 방지, 보통 글씨)
await soft('보통 글씨 로그인 화면의 입력칸도 16px 이상(아이폰 확대 방지)', async () => {
  const p = await mk(); await p.goto(BASE);
  await p.getByRole('button', { name: /회원으로 시작/ }).click();
  await p.getByLabel('PIN', { exact: true }).waitFor({ timeout: 10000 });
  const small = await smallInputs(p);
  await p.context().close();
  if (small.length) throw new Error(small.join(', '));
});

// 9. 새로 고침해도 로그인 유지
await t.reload();
await soft('새로 고침 뒤 세션 유지', () => t.getByRole('heading', { name: '확인', exact: true }).waitFor({ timeout: 15000 }));

console.log(`(접속 주소 ${BASE})`);
// 일부러 만든 실패 응답(기록한 요청)의 오류만 하나에 한 번 뺀다 — 같은 API라도 기록에 없는 실패는 '브라우저 오류'로 센다(Codex v2.0.2 1차 리뷰 P3)
const { excluded, real, unused } = ledger.split(errors);
writeFileSync(`${OUT}/excluded-errors.json`, JSON.stringify({ excluded, unused }, null, 1)); // 뺀 오류와 그 실패를 만든 시험, 오류가 찍히지 않은 기록
check('브라우저 오류 없음', real.length === 0, real.slice(0, 3).join(' | '));
writeFileSync(`${OUT}/failed-responses.json`, JSON.stringify(failedResponses, null, 1));
if (real.length) console.log(`      실패 응답 ${failedResponses.length}건(시각·페이지·본문): ${OUT}/failed-responses.json`);
console.log(`\n${pass} PASS / ${fail} FAIL   (nick suffix ${run})`);
await browser.close();
stopServer();
process.exit(fail ? 1 : 0);
