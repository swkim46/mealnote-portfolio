// 회원·트레이너 두 사람의 화면 흐름을 실제 브라우저(Playwright)로 확인한다.
// 기본: 개발 서버를 직접 띄워 로컬 Supabase에 대고 돈다.  npm run check:e2e
// 운영 주소 점검(배포 직후 필요할 때만): BASE=https://<운영 주소> node --env-file=.env.local scripts/e2e-flow.mjs
//   끝나면 반드시 sh scripts/cleanup-test-users.sh linked
// 시험 계정 닉네임은 "zz검증"으로 시작한다. 화면은 test-results/e2e/에 저장된다.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sheetHtml, SAMPLE } from './inbody-sheet.mjs';
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

const run = Date.now().toString(36).slice(-4);
const T = `zz검증코치${run}`, M = `zz검증회원${run}`, PIN = '135790';
let pass = 0, fail = 0; const errors = [];
const check = (label, ok, extra='') => { ok ? pass++ : fail++; console.log(`${ok?'PASS':'FAIL'}  ${label}${extra?'  '+extra:''}`); };
const soft = async (label, fn) => { try { await fn(); check(label, true); } catch (e) { check(label, false, String(e.message).split('\n')[0]); } };

const browser = await chromium.launch();
const mk = async () => { const c = await browser.newContext({ ...devices['iPhone 13'] }); const p = await c.newPage();
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
const noOverflow = (p, label) => soft(`가로 넘침 없음: ${label}`, async () => {
  const bad = await p.evaluate(() => [document.documentElement, ...document.querySelectorAll('.prototype, .app-main, dialog[open] .sheet-body, .bottom-nav, .summary-grid, .filters')]
    .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className || e.tagName} ${e.scrollWidth}>${e.clientWidth}`));
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
await t.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('틀린 등록 코드 → 안내 문구', () => t.getByText('트레이너 등록 코드가 맞지 않아요').waitFor({ timeout: 10000 }));
await t.getByLabel('트레이너 등록 코드').fill(CODE.toLowerCase());
await t.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('트레이너 가입 → 확인 목록 화면', () => t.getByRole('heading', { name: '확인할 식단' }).waitFor({ timeout: 15000 }));
await soft('트레이너 확인 목록 위에 기본 문구 카드(v1.4)', () => t.locator('.today-word', { hasText: '오늘 회원들에게 보이는 기본 문구' }).waitFor({ timeout: 10000 }));
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
await m.getByRole('button', { name: '가입하고 시작하기' }).click();
await soft('회원 가입 → 오늘의 식단', () => m.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));
await soft('오늘 맨 위에 오늘의 한마디(기본 문구)', () => m.locator('.today-word', { hasText: '오늘의 한마디' }).waitFor({ timeout: 10000 }));
await soft('기록 전 연속 기록 안내', () => m.getByTestId('streak').filter({ hasText: '오늘 한 끼를 남기면 연속 기록이 시작돼요' }).waitFor({ timeout: 10000 }));

// 2b. 화면 테마(v1.4.2): 라이트(오렌지·블랙) · 다크(라임·차콜). 기기마다 기억, 큰 글씨와 독립, 입력·열린 창 유지
const themeOf = (p) => p.evaluate(() => document.documentElement.dataset.theme);
const headerTheme = (p) => p.locator('.app-header .theme-toggle'); // 달 아이콘 버튼 하나: 누를 때마다 라이트↔다크
await soft('첫 방문 기본은 라이트', async () => { if ((await themeOf(m)) !== 'light') throw new Error(await themeOf(m)); });
await headerTheme(m).click();
await soft('상단에서 다크 선택 → 즉시 적용·저장·버튼 상태', async () => {
  const [t, saved, pressed] = await Promise.all([themeOf(m), m.evaluate(() => localStorage.getItem('mealnote:theme')), headerTheme(m).getAttribute('aria-pressed')]);
  if (t !== 'dark' || saved !== 'dark' || pressed !== 'true') throw new Error(JSON.stringify({ t, saved, pressed }));
});
await soft('테마를 바꿔도 큰 글씨는 그대로', async () => { const v = await m.evaluate(() => document.documentElement.dataset.text); if (v !== 'large') throw new Error(String(v)); });
await shot(m, '02b_member_dark');
await noOverflow(m, '다크 큰 글씨 오늘 화면');
await m.setViewportSize({ width: 320, height: 640 });
await noOverflow(m, '320px 다크 큰 글씨 상단 설정');
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
await headerTheme(other).click(); // 지금 다크 → 라이트
await soft('다른 탭에서 라이트로 바꾸면 이 탭도 따라가고 열린 창·입력은 그대로', async () => {
  await m.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 5000 });
  const v = await m.getByLabel('무엇을 드셨나요?').inputValue();
  if (v !== '테마 바꾸는 중 입력' || !(await m.locator('dialog[open]').count())) throw new Error(v);
});
await other.close();
await m.getByRole('button', { name: '창 닫기' }).click();
await m.locator('.bottom-nav .nav-item').filter({ hasText: /^내 정보/ }).click();
await m.getByRole('button', { name: '다크 · 라임' }).click();
await soft('내 정보 설정과 상단 버튼이 같은 상태', async () => {
  const [a, b] = await Promise.all([m.getByRole('button', { name: '다크 · 라임' }).getAttribute('aria-pressed'), headerTheme(m).getAttribute('aria-pressed')]);
  if (a !== 'true' || b !== 'true' || (await themeOf(m)) !== 'dark') throw new Error(JSON.stringify({ a, b }));
});
await shot(m, '02d_member_dark_me');
await m.reload({ waitUntil: 'domcontentloaded' });
await soft('새로고침해도 다크, 첫 화면부터(앱 코드가 뜨기 전에) 적용', async () => {
  const early = await themeOf(m);
  await m.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 });
  if (early !== 'dark' || (await themeOf(m)) !== 'dark') throw new Error(String(early));
});
await m.locator('.bottom-nav .nav-item').filter({ hasText: /^오늘/ }).click();
// 저장값이 이상하거나 저장할 수 없는 기기
await soft('알 수 없는 저장값은 라이트', async () => {
  const c = await browser.newContext({ ...devices['iPhone 13'] });
  await c.addInitScript(() => localStorage.setItem('mealnote:theme', 'purple'));
  const p = await c.newPage(); await p.goto(BASE); await p.waitForLoadState('domcontentloaded');
  const t = await themeOf(p); await c.close();
  if (t !== 'light') throw new Error(String(t));
});
await soft('저장할 수 없는 기기에서도 이번 화면은 바로 바뀜', async () => {
  const c = await browser.newContext({ ...devices['iPhone 13'] });
  await c.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; });
  const p = await c.newPage(); await p.goto(BASE); await p.getByRole('button', { name: /회원으로 시작/ }).waitFor({ timeout: 15000 });
  await p.locator('.auth .theme-toggle').click();
  const t = await themeOf(p); await c.close();
  if (t !== 'dark') throw new Error(String(t));
});

// 3. 회원 식단 등록 (사진 포함)
await m.getByRole('button', { name: '식단 기록하기' }).first().click();
await m.locator('input[type=file]').setInputFiles(`${OUT}/upload.png`);
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
  return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"network lost"}' });
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
await soft('첫 식사 뒤 연속 1일째', () => m.getByTestId('streak').filter({ hasText: '1일째 연속 기록 중이에요' }).waitFor({ timeout: 10000 }));
await noOverflow(m, '큰 글씨 오늘 화면');

// 4. 트레이너 확인
await t.reload();
await t.getByRole('button', { name: '한마디 쓰기' }).click();
await t.locator('.today-word textarea').fill('오늘은 물 2리터 도전해 봐요!');
await t.getByRole('button', { name: '저장', exact: true }).click();
await soft('트레이너 한마디 저장', () => t.locator('.today-word', { hasText: '오늘 회원들에게 보이는 내 한마디' }).filter({ hasText: '물 2리터' }).waitFor({ timeout: 10000 }));
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
  const w = await img.evaluate(el => el.complete ? el.naturalWidth : new Promise(r => el.onload = () => r(el.naturalWidth))); if (!(w > 0)) throw new Error('w=' + w); });
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
await soft('회원 오늘 화면에 트레이너 한마디', () => m.locator('.today-word', { hasText: `${T} 트레이너의 한마디` }).filter({ hasText: '물 2리터' }).waitFor({ timeout: 15000 }));
await soft('오늘의 한마디가 회원 모든 탭 맨 위에 보임', async () => {
  for (const tab of ['기록', '피드백', '내 정보', '오늘']) {
    await m.locator('.bottom-nav .nav-item').filter({ hasText: new RegExp(`^${tab}`) }).click();
    const first = await m.locator('.app-main > *').first().getAttribute('class');
    if (!/today-word/.test(first ?? '') || !(await m.locator('.today-word', { hasText: '물 2리터' }).isVisible())) throw new Error(`${tab} 탭: 맨 위 ${first}`);
  }
});
await noOverflow(m, '큰 글씨 오늘의 한마디');
await soft('피드백 탭에 빨간 점', () => m.locator('.nav-item .nav-dot').waitFor({ timeout: 15000 }));
await m.getByRole('button', { name: /피드백/ }).last().click();
await soft('피드백 카드에 NEW', () => m.locator('.feedback-card .new-badge').waitFor({ timeout: 5000 }));
await soft('피드백 카드에 트레이너 평가', () => m.locator('.feedback-card .rating-chip', { hasText: '아주 좋아요' }).waitFor({ timeout: 5000 }));
await shot(m, '07_member_feedback');
await noOverflow(m, '큰 글씨 피드백 탭');
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
await soft('읽은 뒤 피드백 탭 빨간 점 사라짐(기기·서버 시계가 달라도)', async () => { await m.waitForTimeout(500); const tabs = await m.locator('.nav-item:has(.nav-dot)').allInnerTexts(); if (tabs.some((t) => t.includes('피드백'))) throw new Error('dot on: ' + tabs.join('|')); });

// 6. 트레이너: 답변 대기
await t.reload();
await t.getByRole('button', { name: '답변 대기' }).click();
await soft('답변 대기 필터에 식사', () => t.locator('.meal-card', { hasText: M }).waitFor({ timeout: 15000 }));
await soft('트레이너 카드에 질문 내용이 바로 보임', () => t.locator('.meal-card.has-question .question-snippet', { hasText: '어떤 채소가 좋을까요' }).waitFor({ timeout: 5000 }));
await shot(t, '08b_trainer_question_card');
await t.locator('.meal-card', { hasText: M }).click();
await soft('상세 맨 위에 답변을 기다리는 질문', () => t.locator('.question-callout', { hasText: '어떤 채소가 좋을까요' }).waitFor({ timeout: 5000 }));
await shot(t, '08c_trainer_question_detail');
await t.getByRole('button', { name: '답변 없이 확인' }).click();
await soft('답변 없이 확인 → 안내', () => t.getByText('답변 없이 확인했어요').first().waitFor({ timeout: 5000 }));
await soft('확인 뒤 상세 맨 위 질문 강조가 사라짐', () => t.locator('.question-callout').waitFor({ state: 'detached', timeout: 5000 }));
await t.getByRole('button', { name: '창 닫기' }).click();
await soft('답변 대기 목록에서 빠짐', () => t.getByText('모두 확인했어요').waitFor({ timeout: 5000 }));
await m.reload();
await soft('회원 화면에서도 답변 대기가 풀림', async () => {
  await m.locator('.meal-card').first().waitFor({ timeout: 10000 });
  const st = await m.locator('.meal-card .status').first().innerText();
  if (st.includes('답변 대기')) throw new Error(st);
});
await t.getByRole('button', { name: '담당 회원' }).click();
await soft('담당 회원 목록에 회원', () => t.locator('.member-row', { hasText: M }).waitFor({ timeout: 10000 }));
await soft('담당 회원 목록에 연속 기록', () => t.locator('.member-row', { hasText: M }).filter({ hasText: '1일 연속' }).waitFor({ timeout: 10000 }));
await shot(t, '09_trainer_members');
await t.locator('.member-row', { hasText: M }).click();
await soft('회원별 기록 화면', () => t.getByRole('heading', { name: `${M} 회원` }).waitFor({ timeout: 5000 }));
await shot(t, '10_trainer_member_detail');

// 7. 회원: 수정 → 삭제
await m.getByRole('button', { name: '오늘', exact: true }).click();
await m.locator('.meal-card').first().click();
await m.getByRole('button', { name: '수정', exact: true }).click();
await m.getByLabel('무엇을 드셨나요?').fill('현미밥 반 공기, 닭가슴살, 샐러드, 방울토마토');
await m.getByRole('button', { name: '수정 저장하기' }).click();
await soft('수정 반영', () => m.locator('dialog .detail-food', { hasText: '방울토마토' }).waitFor({ timeout: 10000 }));
// Codex 재검토 P2: 사진을 안 바꾼 수정이 실제로 실패하면 실패로 알려야 한다
await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
const failPatch = (url) => new URL(url).pathname.endsWith('/rest/v1/meals');
await m.route(failPatch, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"db down"}' }) : route.continue()));
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
  return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"network lost"}' });
});
await m.locator('.toast.visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
await m.getByRole('button', { name: '수정', exact: true }).click();
await m.locator('input[type=file]').setInputFiles(`${OUT}/upload.png`);
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
});
await m.getByRole('button', { name: '삭제' }).click();
await m.getByRole('button', { name: '한 번 더 누르면 삭제돼요' }).click();
await soft('삭제 토스트', () => m.getByText('식단을 삭제했어요').waitFor({ timeout: 10000 }));
await soft('오늘 목록 비워짐', () => m.getByText('아직 기록한 식사가 없어요').waitFor({ timeout: 5000 }));

// 7c. v1.4 평가만으로 피드백: 트레이너가 확인 목록 카드에서 바로 고른다 → 회원에게 새 피드백
await m.getByRole('button', { name: '식단 기록하기' }).first().click();
await m.getByLabel('무엇을 드셨나요?').fill('그릭요거트와 블루베리');
await m.getByRole('button', { name: '식단 등록하기' }).click();
await m.locator('.toast.visible', { hasText: '식단을 등록했어요' }).waitFor({ timeout: 15000 }).catch(() => {});
await t.reload();
const snackCard = t.locator('.meal-card-wrap', { hasText: '그릭요거트' });
await soft('확인 목록 카드 아래에 평가 버튼 세 개', async () => { await snackCard.waitFor({ timeout: 15000 }); const n = await snackCard.locator('.rating-button').count(); if (n !== 3) throw new Error('n=' + n); });
await shot(t, '10c_trainer_quick_rating');
await noOverflow(t, '보통 글씨 평가 버튼 카드');
await snackCard.getByRole('button', { name: '조절이 필요해요' }).click();
await soft('카드에서 평가 → 안내', () => t.locator('.toast.visible', { hasText: '조절이 필요해요' }).waitFor({ timeout: 10000 }));
await soft('평가한 식사는 미확인에서 빠짐', () => t.getByText('모두 확인했어요').waitFor({ timeout: 10000 }));
await m.reload();
await soft('평가만 받아도 피드백 탭에 빨간 점', () => m.locator('.nav-item', { hasText: '피드백' }).locator('.nav-dot').waitFor({ timeout: 15000 }));
await m.getByRole('button', { name: /피드백/ }).last().click();
const ratedCard = m.locator('.feedback-card', { hasText: '그릭요거트' });
await soft('평가만 받은 식사도 피드백 목록에(NEW·평가)', async () => { await ratedCard.locator('.new-badge').waitFor({ timeout: 5000 }); await ratedCard.locator('.rating-chip', { hasText: '조절이 필요해요' }).waitFor({ timeout: 5000 }); });
await ratedCard.click();
await soft('회원 상세에 트레이너 평가', () => m.locator('dialog .rating-panel.member', { hasText: '조절이 필요해요' }).waitFor({ timeout: 5000 }));
await shot(m, '10d_member_rating_detail');
await noOverflow(m, '큰 글씨 평가 상세');
await m.getByRole('button', { name: '창 닫기' }).click(); // 이 식사(평가 '조절이 필요해요')는 아래 결산에 쓴다
await m.getByRole('button', { name: '오늘', exact: true }).click();

// 7d. v1.4 인바디: 사진은 기기 안에서 숫자만 읽고 버림(외부 요청·전송 없음) → 두 번 기록 → 변화 표시 → 트레이너가 읽기만
await m.getByRole('button', { name: '기록', exact: true }).click();
await m.getByRole('button', { name: '인바디', exact: true }).click();
await soft('인바디 첫 화면 안내', () => m.getByText('아직 인바디 기록이 없어요').waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '인바디 기록하기' }).click();
await soft('인바디 사진 업로드 화면에 사진 폐기 안내', () => m.getByTestId('inbody-privacy').filter({ hasText: '바로 버려요' }).filter({ hasText: '서버로 보내거나 앱에 저장하지 않아요' }).filter({ hasText: '측정일·체중·골격근량·체지방률만' }).waitFor({ timeout: 5000 }));
await noOverflow(m, '큰 글씨 인바디 기록 창');
await shot(m, '10e_member_inbody_form');
const ocrReqs = [];
const onReq = (r) => ocrReqs.push({ url: r.url(), method: r.method() });
m.on('request', onReq);
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
await m.getByRole('button', { name: '인바디 저장하기' }).click();
await soft('같은 날짜 두 번째 기록은 고치라고 안내', () => m.locator('.toast.visible', { hasText: '이 날짜의 기록이 이미 있어요' }).waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '창 닫기' }).click();
await m.getByRole('button', { name: /9월 15일 인바디 고치기/ }).click();
await m.getByLabel('골격근량 (kg)').fill('32.5');
await m.getByRole('button', { name: '고친 내용 저장하기' }).click();
await soft('인바디 고치기', () => m.locator('.inbody-row', { hasText: '32.5kg' }).waitFor({ timeout: 10000 }));
await shot(m, '10g_member_inbody_list');
await soft('지난 측정 이후의 변화 카드(평가 평균·변화·한 줄 정리)', async () => {
  await m.getByRole('heading', { name: /지난 측정 이후의 변화/ }).waitFor({ timeout: 10000 });
  const card = m.locator('.report-card').first();
  await card.filter({ hasText: '9월 16일 ~' }).waitFor({ timeout: 10000 });
  for (const t of ['식단 평가 평균', '1점 / 5점', '기록한 1끼 중 1끼 평가', '체지방률 ▼ 1.2%p', '조절 필요 1', '평가받은 식단 1끼는 5점 만점에 1점이에요', '다음 목표를 트레이너와 함께 정해 보세요']) await card.filter({ hasText: t }).waitFor({ timeout: 3000 });
});
await m.locator('.report-card').first().scrollIntoViewIfNeeded();
await shot(m, '10g2_member_report');
await noOverflow(m, '큰 글씨 인바디 목록');
await t.getByRole('button', { name: '담당 회원' }).click();
await t.locator('.member-row', { hasText: M }).click();
await t.getByRole('button', { name: '인바디', exact: true }).click();
await soft('트레이너도 회원 인바디를 봄(읽기만)', async () => {
  await t.locator('.inbody-row', { hasText: '72.1kg' }).waitFor({ timeout: 10000 });
  if (await t.getByRole('button', { name: '인바디 기록하기' }).count()) throw new Error('트레이너에게 기록 버튼이 보임');
});
await soft('트레이너도 같은 결산을 봄', () => t.locator('.report-card', { hasText: '1점 / 5점' }).waitFor({ timeout: 10000 }));
await shot(t, '10h_trainer_inbody');
await t.getByRole('button', { name: '식단', exact: true }).click();
await m.getByRole('button', { name: '오늘', exact: true }).click();

// 7b. 회원: 익명 의견 보내기
const FB = `zz검증 의견 ${run}: 사진 올릴 때 조금 느려요`;
await m.getByRole('button', { name: /의견 보내기/ }).click();
await soft('의견 창에 감사·익명 안내', async () => { await m.getByText('작은 의견 하나도 서비스를 만드는 데 큰 힘이 됩니다').waitFor({ timeout: 5000 }); await m.getByText('누가 보냈는지 남지 않으니 편하게 적어 주세요').waitFor({ timeout: 5000 }); });
await m.getByLabel('내용').fill(FB);
await shot(m, '10b_member_app_feedback');
await m.locator('form.app-feedback-form').getByRole('button', { name: '의견 보내기' }).click();
await soft('의견 보낸 뒤 감사 화면', () => m.getByText('보내 주셔서 고맙습니다').waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '닫기', exact: true }).click();

// 8. 로그아웃 → 틀린 PIN → 로그인
await soft('로그인 뒤 모든 화면 머리글에 큰 글씨 버튼(켜진 상태)', async () => {
  const b = m.locator('.app-header .text-size-toggle');
  await b.waitFor({ timeout: 5000 });
  if ((await b.getAttribute('aria-pressed')) !== 'true') throw new Error('not pressed');
});
await m.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
await soft('내 정보 탭에 담당 트레이너', () => m.getByText(`담당 트레이너 · ${T}`).waitFor({ timeout: 5000 }));
await shot(m, '11_member_account');
await noOverflow(m, '큰 글씨 내 정보');
await soft('내 정보에서 글씨 크기 크게가 선택돼 있음', async () => { const v = await m.locator('.text-size-row button[aria-pressed="true"]').innerText(); if (!v.includes('크게')) throw new Error(v); });
await m.locator('.text-size-row').getByRole('button', { name: '보통' }).click();
await soft('내 정보에서 보통으로 바꾸면 머리글 버튼도 꺼짐', async () => {
  const v = await m.locator('.app-header .text-size-toggle').getAttribute('aria-pressed');
  const d = await m.evaluate(() => document.documentElement.dataset.text);
  if (v !== 'false' || d === 'large') throw new Error(`${v} ${d}`);
});
await shot(m, '11e_member_account_normal');
await m.locator('.app-header .text-size-toggle').click();
await soft('머리글 버튼으로 다시 크게', async () => { const v = await m.locator('.text-size-row button[aria-pressed="true"]').innerText(); if (!v.includes('크게')) throw new Error(v); });
// 안 읽은 업데이트 소식 표시는 없앴다(2026-10-26 사용자 결정): 예전 버전만 본 기기여도 점·NEW가 없다
await m.evaluate(() => localStorage.setItem('mealnote:seen-version', '1.0'));
await m.reload(); await m.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 });
await soft('안 읽은 업데이트 소식이 있어도 내 정보 점·NEW 없음', async () => {
  const dot = await m.locator('.nav-item', { hasText: '내 정보' }).locator('.nav-dot').count();
  await m.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
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
await m.getByRole('button', { name: /^알림 설정/ }).click();
await soft('내 정보 → 알림 설정 창', () => m.locator('dialog .push-settings').waitFor({ timeout: 5000 }));
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
await m.getByRole('button', { name: /^알림 설정/ }).click();
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
  const [head, back] = await Promise.all([m.locator('dialog[open] #sheet-title').boundingBox(), m.locator('.guide-back').boundingBox()]);
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
await soft('막힐 때 도움말이 펼쳐짐', () => m.locator('.guide-help details[open]', { hasText: '설정 → 알림 → 식단노트' }).waitFor({ timeout: 3000 }));
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
  await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 });
  const memberId = await p.evaluate(() => JSON.parse(localStorage.getItem('mealnote:remember') ?? 'null')?.userId);
  const setPushOpen = (open, uid) => p.evaluate(([open, uid]) => new Promise((resolve, reject) => {
    const r = indexedDB.open('mealnote-push', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ open, uid, at: Date.now() }, 'open'); tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    r.onerror = () => reject(r.error);
  }), [open, uid]);
  const nudge = () => p.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'mealnote:push-open' } })));
  await p.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
  await p.getByRole('button', { name: /^알림 설정/ }).click();
  await soft('알림 권한을 거부한 기기는 휴대폰 설정에서 허용하라는 안내', () => p.locator('dialog .push-settings').getByText('휴대폰 설정 → 알림에서 식단노트를 허용해 주세요', { exact: false }).waitFor({ timeout: 10000 }));
  await p.getByRole('button', { name: '창 닫기' }).click();
  // 화면 없는 크롬은 알림 권한을 늘 '거부'로 돌려주므로, '아직 묻지 않음'과 허용 응답은 흉내 낸다
  await p.context().addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    Notification.requestPermission = async () => 'granted';
  });
  await p.reload();
  await p.getByRole('heading', { name: '내 정보' }).waitFor({ timeout: 15000 }).catch(() => {});
  await p.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
  await p.getByRole('button', { name: /^알림 설정/ }).click();
  await soft('알림을 켤 수 있는 화면은 이 기기 켜기 버튼', () => p.getByRole('button', { name: '이 기기에서 알림 받기' }).waitFor({ timeout: 10000 }));
  await p.getByRole('button', { name: '이 기기에서 알림 받기' }).click();
  await soft('기기 등록이 실패하면 켰다고 하지 않고 실패를 알림', async () => {
    await p.locator('dialog .field-error', { hasText: '이 기기에서 알림을 등록하지 못했어요' }).waitFor({ timeout: 15000 });
    if (await p.getByText('알림을 켰어요').count()) throw new Error('켰다고 표시됨');
  });
  await p.getByRole('button', { name: '창 닫기' }).click();
  // 작성 중 알림을 누름: 화면은 피드백으로 가고, 쓰던 식단 창과 입력은 그대로
  await p.locator('.bottom-nav').getByRole('button', { name: /오늘/ }).click();
  await p.getByRole('button', { name: '식단 기록하기' }).first().click();
  await p.getByLabel('무엇을 드셨나요?').fill('알림 누르기 전 쓰던 음식');
  await setPushOpen('feedback', memberId);
  await nudge();
  await soft('작성 중 알림을 눌러도 쓰던 내용이 남음', async () => { await p.waitForTimeout(800); const v = await p.getByLabel('무엇을 드셨나요?').inputValue(); if (v !== '알림 누르기 전 쓰던 음식') throw new Error(v); });
  await p.keyboard.press('Escape');
  await soft('알림을 누르면 피드백 화면', () => p.getByRole('heading', { name: '받은 피드백' }).waitFor({ timeout: 5000 }));
  // 다른 계정에게 온 알림이면 이동하지 않음
  await p.locator('.bottom-nav').getByRole('button', { name: /오늘/ }).click();
  await setPushOpen('feedback', '00000000-0000-4000-8000-000000000000');
  await nudge();
  await soft('다른 계정에게 온 알림이면 지금 화면 그대로', async () => { await p.waitForTimeout(800); await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 2000 }); });
  // 앱이 닫혀 있을 때 알림을 누름: 다시 열면 그 화면
  await setPushOpen('feedback', memberId);
  await p.reload();
  await soft('닫힌 앱을 알림으로 열면 그 화면', () => p.getByRole('heading', { name: '받은 피드백' }).waitFor({ timeout: 15000 }));
  await p.context().close();
}
// 트레이너: 요약 받는 횟수(하루 3회 기본 · 5회), 계정 전체 설정
await t.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
await t.getByRole('button', { name: /^알림 설정/ }).click();
await soft('트레이너 알림 창: 요약 켜기와 하루 3회 기본', async () => {
  await t.getByLabel('확인할 식사 기록·답할 질문 요약').waitFor({ timeout: 10000 });
  if ((await t.getByRole('button', { name: /하루 3회/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('3회가 기본이 아님');
});
await t.getByRole('button', { name: /하루 5회/ }).click();
await t.waitForTimeout(800);
await t.getByRole('button', { name: '창 닫기' }).click();
await t.getByRole('button', { name: /^알림 설정/ }).click();
await soft('하루 5회로 바꾸면 저장됨', async () => { await t.getByRole('button', { name: /하루 5회/ }).waitFor({ timeout: 10000 }); if ((await t.getByRole('button', { name: /하루 5회/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('저장 안 됨'); });
await shot(t, '11g_trainer_push_settings');
await t.getByRole('button', { name: '창 닫기' }).click();
await t.locator('.bottom-nav').getByRole('button', { name: /확인 목록/ }).click();
// 알림 모아보기(최근 1주일): 종 버튼의 점 → 목록 → 누르면 그 식사 상세 → 점 사라짐
await soft('회원: 새 소식이 있으면 머리글 종 버튼에 점', () => m.locator('.app-header .bell-toggle .bell-dot').waitFor({ timeout: 15000 }));
await m.locator('.app-header .bell-toggle').click();
await soft('회원 알림 목록에 트레이너 피드백(새 소식 강조)', () => m.locator('dialog .activity-item.new', { hasText: '트레이너가' }).first().waitFor({ timeout: 10000 }));
await soft('회원 알림 목록에 끼니 기록 알림은 없음', async () => { if (await m.locator('dialog .activity-item', { hasText: '식단을 남겨' }).count()) throw new Error('있음'); });
await noOverflow(m, '큰 글씨 알림 목록');
await shot(m, '11h_member_activity');
await m.locator('dialog .activity-item', { hasText: '트레이너가' }).first().click();
await soft('회원: 알림을 누르면 그 식사 상세', () => m.locator('dialog[open] #sheet-title', { hasText: '기록' }).waitFor({ timeout: 10000 }));
await m.getByRole('button', { name: '창 닫기' }).click();
await soft('회원: 목록을 연 뒤에는 종 버튼 점이 사라짐', () => m.locator('.app-header .bell-toggle .bell-dot').waitFor({ state: 'detached', timeout: 15000 }));
await t.reload();
await t.getByRole('heading', { name: '확인할 식단' }).waitFor({ timeout: 15000 });
await t.locator('.app-header .bell-toggle').click();
await soft('트레이너 알림 목록에 회원의 식사 기록', () => t.locator('dialog .activity-item', { hasText: `${M} 회원이` }).first().waitFor({ timeout: 10000 }));
await shot(t, '11i_trainer_activity');
await t.locator('dialog .activity-item', { hasText: `${M} 회원이` }).first().click();
await soft('트레이너: 알림을 누르면 그 식사 상세', () => t.locator('dialog[open] #sheet-title', { hasText: `${M}님의` }).waitFor({ timeout: 10000 }));
await t.getByRole('button', { name: '창 닫기' }).click();
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
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('틀린 PIN 안내', () => m.getByText('닉네임 또는 PIN이 맞지 않아요').waitFor({ timeout: 10000 }));
await m.getByLabel('PIN', { exact: true }).fill(PIN);
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('대소문자 달라도 닉네임+PIN 로그인', () => m.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));
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
await soft('맞는 답(띄어쓰기 달라도) → 바로 로그인', () => m2.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));
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
await m.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
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
await soft('바꾼 PIN으로 다시 로그인', () => m.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));

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
  await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 });
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
await m.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
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
await soft('새로 고치지 않아도 내 정보에 새 닉네임', () => m.locator('.profile-banner', { hasText: `${M2} 회원` }).waitFor({ timeout: 10000 }));
// 다른 기기: 새로 고침 → 새 이름 → 기억값도 새 이름 → 로그아웃 → 로그인 칸에 새 이름 → 지금 PIN으로 로그인(Codex v1.6 리뷰 P2)
// 로그아웃은 같은 계정의 모든 기기 세션을 끝내므로, 새로 고침 확인을 두 기기 모두 먼저 하고 로그아웃은 그다음에 한다.
const others = [['v1.6에서 로그인한 다른 기기', devB], ['옛 기억값(사용자 ID 없음)이 남은 다른 기기', devC]];
for (const [label, d] of others) {
  await d.reload();
  await soft(`${label}: 새로 고치면 새 닉네임`, () => d.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }).then(async () => {
    await d.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
    await d.locator('.profile-banner', { hasText: `${M2} 회원` }).waitFor({ timeout: 10000 });
  }));
  await soft(`${label}: 기억값도 새 닉네임`, () => d.waitForFunction((n) => JSON.parse(localStorage.getItem('mealnote:remember') ?? 'null')?.nickname === n, M2, { timeout: 10000 }));
}
// 확인 응답이 오기 전에 로그아웃: 응답이 늦게 와도 로그인 칸이 새 이름으로 바뀌어야 한다(D). 사람이 고쳐 쓴 이름은 그대로(E)
for (const d of [devD, devE]) {
  await d.reload();
  await d.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 });
  await d.locator('.bottom-nav').getByRole('button', { name: /내 정보/ }).click();
  await d.locator('.profile-banner', { hasText: `${M2} 회원` }).waitFor({ timeout: 10000 });
}
await soft('늦은 응답: 서버는 본인의 예전 닉네임이라고 답함', async () => { const a = await holdD.asked; if (a !== 'true') throw new Error(a); });
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
await soft('늦은 응답: 바뀐 이름 그대로 지금 PIN으로 로그인', () => devD.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));
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
  await soft(`${label}: 채워진 이름 그대로 지금 PIN으로 로그인`, () => d.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));
  await d.context().close();
}
await m.getByRole('button', { name: '로그아웃' }).click();
await soft('로그인 화면에 새 닉네임이 채워짐', async () => { const v = await m.getByLabel('닉네임', { exact: true }).inputValue(); if (v !== M2) throw new Error(v); });
await m.getByLabel('닉네임', { exact: true }).fill(M);
await m.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('옛 닉네임으로는 로그인 안 됨', () => m.getByText('닉네임 또는 PIN이 맞지 않아요').waitFor({ timeout: 10000 }));
await m.getByLabel('닉네임', { exact: true }).fill(M2);
await m.getByLabel('PIN', { exact: true }).fill(NEW_PIN);
await m.getByRole('button', { name: '로그인', exact: true }).last().click();
await soft('새 닉네임으로 로그인', () => m.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }));
await t.reload();
await t.getByRole('button', { name: '담당 회원' }).click();
await soft('트레이너 담당 회원 목록에 새 닉네임', () => t.locator('.member-row', { hasText: `${M2} 회원` }).waitFor({ timeout: 15000 }));
await t.getByRole('button', { name: '확인 목록' }).click().catch(() => {});
// 다른 사람의 기억값은 건드리지 않는다: 이 계정의 예전 이름이 아닌 옛 기억값, 다른 사용자 ID가 붙은 기억값
await soft('다른 사람의 기억값은 그대로', async () => {
  const p = await loginOn(M2);
  const others = [{ nickname: `zz검증남${run}`, role: 'trainer' }, { nickname: M, role: 'member', userId: '00000000-0000-4000-8000-000000000000' }];
  const seen = [];
  for (const v of others) {
    await p.evaluate((x) => localStorage.setItem('mealnote:remember', JSON.stringify(x)), v);
    await p.reload(); await p.getByRole('heading', { name: '오늘의 식단' }).waitFor({ timeout: 15000 }); await p.waitForTimeout(1500);
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

// 9. 새로 고침해도 로그인 유지
await t.reload();
await soft('새로 고침 뒤 세션 유지', () => t.getByRole('heading', { name: '확인할 식단' }).waitFor({ timeout: 15000 }));

console.log(`(접속 주소 ${BASE})`);
// 일부러 일으킨 실패(틀린 코드·PIN, 같은 날짜 인바디, 저장 실패·응답 끊김)와
// 다른 기기 로그아웃으로 이미 끝난 세션에서 다시 로그아웃할 때의 403(닉네임 바꾸기 다른 기기 확인) 제외
const real = errors.filter((e) => !/status of 400|status of 409|status of 500|db down|network lost/.test(e) && !/status of 403.*\/auth\/v1\/logout/.test(e));
check('브라우저 오류 없음', real.length === 0, real.slice(0, 3).join(' | '));
console.log(`\n${pass} PASS / ${fail} FAIL   (nick suffix ${run})`);
await browser.close();
stopServer();
process.exit(fail ? 1 : 0);
