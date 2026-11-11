// 화면 조각 경계 상황 검증(DB 없이, 서버·인식기 응답을 가로채 정함). Codex 리뷰 v1.4에서 재현된 오류 4건을 막는다.
//  1) 회원을 빨리 바꾸면 이전 회원의 늦은 응답이 현재 화면을 덮음  2) 앱으로 돌아와도 인바디를 다시 안 불러옴
//  3) 사진을 다시 고르면 이전 사진의 수치가 남음  4) 식단 평가가 바뀌어도 변화 카드의 평가 평균이 그대로
// v1.7 알림(Codex 품질 리뷰 2026-10-27): 5) 설정 조회 실패 6) 설정 연속 저장 7) 목록 조회 실패 중 읽음 8) 늦은 조회 응답
// 실행: npm run check (또는 sh scripts/check.sh component)
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 5184, BASE = `http://127.0.0.1:${PORT}/scripts/component-harness.html`;
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('개발 서버가 30초 안에 뜨지 않았습니다.')), 30000);
  server.stdout.on('data', (d) => { if (String(d).includes(`${PORT}`)) { clearTimeout(timer); resolve(); } });
});
process.on('exit', () => server.kill());

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
// ONLY=<글자>: 이름에 그 글자가 든 묶음만 돌린다(고친 곳만 빨리 볼 때). 마지막 확인은 전체로
const soft = async (label, fn) => { if (process.env.ONLY && !label.includes(process.env.ONLY)) return; try { await fn(); } catch (e) { check(label, false, String(e.message).split('\n')[0]); } };
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const row = (member, w) => ({ id: 'record-' + member, member_id: member, measured_on: '2026-10-22', weight_kg: w, smm_kg: 30, pbf_pct: 22, source: 'manual' });
const fulfill = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
const state = async (p) => JSON.parse(await p.getByTestId('state').textContent());
const open = async (ctx, mode) => {
  const p = await ctx.newPage();
  return { p, go: async () => { await p.goto(`${BASE}?mode=${mode}`); await p.waitForLoadState('networkidle'); } };
};

const browser = await chromium.launch();
// 2.0 시작 안내는 기기마다 처음 한 번 뜬다 — 안내를 시험하는 창 말고는 '이 기기에서 이미 봤음'으로 열어 다른 화면을 가리지 않게 한다
const newCtx = async (opts) => { const c = await browser.newContext(opts); await c.addInitScript(() => { try { localStorage.setItem('mealnote:start-guide', '2.0'); localStorage.setItem('mealnote:setup-nudge', '9999-12-31'); localStorage.setItem('mealnote:whats-new', '2.3'); } catch { /* 저장소 없음 */ } }); return c; };
const ctx = await newCtx({ ...devices['iPhone 13'] });
// 시험마다 시계가 달라 앞 시험이 적은 새 운동 기준 시각이 뒤 시험을 가린다: 새 페이지는 그 값 없이 시작한다(같은 페이지의 새로 고침에서는 남는다)
await ctx.addInitScript(() => {
  if (sessionStorage.getItem('seen-reset')) return;
  sessionStorage.setItem('seen-reset', '1');
  for (const k of Object.keys(localStorage)) if (k.startsWith('mealnote:workouts-seen:')) localStorage.removeItem(k);
});
// 개발 서버가 처음 의존성을 정리하며 한 번 새로 고칠 수 있어 미리 한 번 연다
{ const w = await ctx.newPage(); await w.goto(`${BASE}?mode=reports`); await w.waitForLoadState('networkidle'); await w.waitForTimeout(1500); await w.close(); }
try {
  // 1) A 조회가 B 조회보다 늦게 끝남
  await soft('회원 전환 경쟁', async () => {
    const { p } = await open(ctx, 'hook');
    let releaseA, startedA;
    const gateA = new Promise((r) => (releaseA = r)), startA = new Promise((r) => (startedA = r));
    await p.route('**/rest/v1/inbody_records*', async (route) => {
      if (route.request().url().includes(a)) { startedA(); await gateA; await fulfill(route, [row(a, 70)]); } else await fulfill(route, [row(b, 80)]);
    });
    await p.goto(`${BASE}?mode=hook`);
    await startA;
    await p.getByRole('button', { name: '회원 B' }).click();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).loaded === true);
    releaseA();
    await p.waitForTimeout(500);
    const s = await state(p);
    check('회원을 빨리 바꿔도 이전 회원의 늦은 응답이 현재 화면을 덮지 않음', s.id === b && s.loaded && s.records[0]?.weight_kg === 80, JSON.stringify({ id: s.id, loaded: s.loaded, w: s.records[0]?.weight_kg }));
    await p.close();
  });

  // 2) 다른 기기에서 바뀐 뒤 앱으로 돌아옴
  await soft('앱 복귀 갱신', async () => {
    const { p, go } = await open(ctx, 'hook');
    let weight = 70;
    await p.route('**/rest/v1/inbody_records*', (route) => fulfill(route, [row(a, weight)]));
    await go();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).loaded);
    weight = 68;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(800);
    const s = await state(p);
    check('앱으로 돌아오면 인바디를 다시 불러옴(다른 기기에서 바꾼 값)', s.records[0]?.weight_kg === 68, String(s.records[0]?.weight_kg));
    await p.close();
  });

  // 3) 사진 A는 네 값 모두, 사진 B는 측정일·체중만 읽힘(인식기만 모의)
  await soft('사진 다시 고르기', async () => {
    const { p, go } = await open(ctx, 'form');
    let saved;
    await p.route('**/src/lib/inbodyOcr.ts*', (route) => route.fulfill({ contentType: 'application/javascript', body: "let n=0; export async function readInbodyPhoto(){ return ++n===1 ? { measured_on:'2026-09-15',weight_kg:73.3,smm_kg:32.4,pbf_pct:23.6 } : { measured_on:'2026-10-22',weight_kg:72.1,smm_kg:null,pbf_pct:null }; }" }));
    await p.route('**/rest/v1/inbody_records*', (route) => { saved = route.request().postDataJSON(); return fulfill(route, null); });
    await go();
    const file = p.getByLabel('인바디 결과지 사진 선택');
    await file.setInputFiles({ name: 'A.png', mimeType: 'image/png', buffer: Buffer.from('A') });
    await p.getByText('읽은 값이 결과지와 같은지 확인한 뒤 저장해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    await file.setInputFiles({ name: 'B.png', mimeType: 'image/png', buffer: Buffer.from('B') });
    await p.getByText('읽지 못한 항목: 골격근량, 체지방률.', { exact: false }).waitFor({ timeout: 10000 });
    const fields = await Promise.all(['측정일', '체중 (kg)', '골격근량 (kg)', '체지방률 (%)'].map((l) => p.getByLabel(l, { exact: true }).inputValue()));
    check('사진을 다시 고르면 네 칸 모두 새 사진 결과로(못 읽은 칸은 비움)', fields.join('|') === '2026-10-22|72.1||', fields.join('|'));
    await p.getByRole('button', { name: '인바디 저장하기' }).click();
    await p.getByText('인바디를 기록했어요.', { exact: true }).waitFor({ timeout: 10000 });
    check('저장 요청에 이전 사진 수치가 섞이지 않음', saved?.weight_kg === 72.1 && saved?.smm_kg === null && saved?.pbf_pct === null && saved?.measured_on === '2026-10-22', JSON.stringify(saved));
    await p.close();
  });

  // 4) 평가가 바뀌면(식단 변경 신호) · 앱으로 돌아오면 변화 카드 다시 받기
  await soft('변화 카드 갱신', async () => {
    const { p, go } = await open(ctx, 'reports');
    let score = 1, calls = 0;
    await p.route('**/rest/v1/rpc/diet_report', (route) => { calls++; return fulfill(route, { days: 37, logged_days: 1, meals: 1, great: score === 5 ? 1 : 0, good: score === 3 ? 1 : 0, care: score === 1 ? 1 : 0, rated: 1, score }); });
    await go();
    await p.locator('.report-score strong', { hasText: '1점' }).waitFor({ timeout: 10000 });
    score = 5;
    await p.getByRole('button', { name: '평가 바뀜' }).click();
    await p.locator('.report-score strong', { hasText: '5점 /' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('식단 평가가 바뀌면 평가 평균을 다시 받음', (await p.locator('.report-score strong').textContent()) === '5점 / 5점');
    score = 3;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.locator('.report-score strong', { hasText: '3점 /' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('앱으로 돌아오면 평가 평균을 다시 받음', (await p.locator('.report-score strong').textContent()) === '3점 / 5점', `요청 ${calls}번`);
    check('다시 받는 동안 이전 카드를 지우지 않음', (await p.getByText('불러오는 중…').count()) === 0);
    await p.close();
  });

  // 5) 알림 설정 조회 실패 → 기본값으로 채우지 않고 막음 → 다시 받기 → 바꾼 항목만 저장(Codex v1.7 품질 리뷰 1)
  const PREF_KEYS = ['digest', 'digest_times', 'feedback', 'reminder', 'morning'];
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => PREF_KEYS.includes(k)));
  await soft('알림 설정 조회 실패', async () => {
    const { p, go } = await open(ctx, 'prefs');
    let failRead = true;
    const saves = [];
    await p.route('**/rest/v1/push_prefs*', async (route) => {
      const r = route.request();
      if (r.method() === 'GET') return failRead ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"db down"}' }) : fulfill(route, [{ digest: true, digest_times: '3', feedback: false, reminder: true, morning: true, updates: true }]);
      const body = r.postDataJSON();
      saves.push(pick(Array.isArray(body) ? body[0] : body));
      return fulfill(route, { digest: true, digest_times: '3', feedback: false, reminder: true, updates: true, ...pick(Array.isArray(body) ? body[0] : body) });
    });
    await go();
    await p.getByText('알림 종류를 불러오지 못했어요', { exact: false }).waitFor({ timeout: 10000 });
    check('알림 설정 조회가 실패하면 기본값으로 채우지 않고 바꿀 수 없음', (await p.getByLabel('트레이너가 남긴 피드백').count()) === 0 && saves.length === 0);
    failRead = false;
    await p.getByRole('button', { name: '다시 불러오기' }).click();
    await p.getByLabel(/식단 기록 알림/).waitFor({ timeout: 10000 });
    check('다시 불러오면 서버 값(피드백 알림 꺼짐)', !(await p.getByLabel('트레이너가 남긴 피드백').isChecked()));
    await p.getByLabel(/식단 기록 알림/).uncheck();
    await p.waitForTimeout(600);
    check('바꾼 항목만 저장해 다른 항목(다른 기기에서 바꾼 값)을 덮지 않음', saves.length === 1 && JSON.stringify(saves[0]) === JSON.stringify({ reminder: false }), JSON.stringify(saves));
    await p.close();
  });

  // 6) 알림 설정을 빠르게 연달아 바꿈: 저장 중엔 다른 항목을 잠그고, 끝나면 화면과 서버가 같음(Codex v1.7 품질 리뷰 2)
  await soft('알림 설정 연속 저장', async () => {
    const { p, go } = await open(ctx, 'prefs');
    const server = { digest: true, digest_times: '3', feedback: true, reminder: true, morning: true, updates: true };
    let release, n = 0;
    const gate = new Promise((r) => (release = r));
    await p.route('**/rest/v1/push_prefs*', async (route) => {
      const r = route.request();
      if (r.method() === 'GET') return fulfill(route, [server]);
      const body = r.postDataJSON();
      if (++n === 1) await gate;
      Object.assign(server, pick(Array.isArray(body) ? body[0] : body));
      return fulfill(route, { ...server });
    });
    await go();
    await p.getByLabel('트레이너가 남긴 피드백').waitFor({ timeout: 10000 });
    await p.getByLabel('트레이너가 남긴 피드백').uncheck();
    check('저장하는 동안 다른 항목은 바꿀 수 없음', await p.getByLabel(/식단 기록 알림/).isDisabled());
    release();
    await p.waitForFunction(() => !document.querySelector('.push-settings input[type=checkbox]:disabled'), null, { timeout: 5000 });
    await p.getByLabel(/식단 기록 알림/).uncheck();
    await p.waitForFunction(() => !document.querySelector('.push-settings input[type=checkbox]:disabled'), null, { timeout: 5000 });
    const ui = { feedback: await p.getByLabel('트레이너가 남긴 피드백').isChecked(), reminder: await p.getByLabel(/식단 기록 알림/).isChecked() };
    check('연달아 바꿔도 화면과 서버 설정이 같음', !ui.feedback && !ui.reminder && server.feedback === false && server.reminder === false, JSON.stringify({ ui, server }));
    await p.close();
  });

  const item = { key: 'recorded:33333333-3333-4333-8333-333333333333', kind: 'recorded', at: '2026-10-27T01:00:00Z', meal_id: '33333333-3333-4333-8333-333333333333', eaten_on: '2026-10-27', meal_type: '점심', actor: '검증회원', handled: false };
  // 7) 알림 목록을 못 불러왔는데 읽음 처리하지 않음(Codex v1.7 품질 리뷰 3)
  await soft('알림 목록 조회 실패', async () => {
    const { p, go } = await open(ctx, 'activity');
    let marks = 0;
    await p.route('**/rest/v1/rpc/my_activity*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"db down"}' }));
    await p.route('**/rest/v1/activity_seen*', (route) => fulfill(route, []));
    await p.route('**/rest/v1/rpc/mark_activity_seen*', (route) => { marks++; return fulfill(route, null); });
    await go();
    await p.getByRole('button', { name: '목록 열기' }).click();
    await p.getByText('알림을 불러오지 못했어요', { exact: false }).waitFor({ timeout: 10000 });
    await p.waitForTimeout(800);
    check('알림 목록을 못 불러오면 읽음 처리하지 않음', marks === 0, `읽음 요청 ${marks}번`);
    await p.close();
  });

  // 8) 늦게 끝난 옛 조회가 읽음 표시를 되돌리지 않음(Codex v1.7 품질 리뷰 4)
  await soft('알림 목록 늦은 응답', async () => {
    const { p, go } = await open(ctx, 'activity');
    let seenCalls = 0, releaseA, startedA;
    const gateA = new Promise((r) => (releaseA = r)), startA = new Promise((r) => (startedA = r));
    const OLD = [{ seen_at: '2026-10-26T00:00:00Z' }], NEW = [{ seen_at: '2026-10-27T02:00:00Z' }];
    await p.route('**/rest/v1/rpc/my_activity*', (route) => fulfill(route, [item]));
    await p.route('**/rest/v1/activity_seen*', async (route) => {
      const n = ++seenCalls;
      if (n === 1) return fulfill(route, OLD); // 처음 조회
      if (n === 2) { startedA(); await gateA; return fulfill(route, OLD); } // 늦게 끝날 옛 조회 A
      return fulfill(route, NEW); // 읽음 저장 뒤 조회 B
    });
    await p.route('**/rest/v1/rpc/mark_activity_seen*', (route) => fulfill(route, null));
    await go();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).unread === 1, null, { timeout: 10000 });
    await p.getByRole('button', { name: '다시 조회' }).click();
    await startA;
    await p.getByRole('button', { name: '읽음 저장' }).click();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).unread === 0, null, { timeout: 10000 });
    releaseA();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('늦게 끝난 옛 조회가 읽음 표시를 되돌리지 않음', st.unread === 0, JSON.stringify(st));
    await p.close();
  });

  // 9~11) 알림 목록: 첫 조회 → 서버 데이터 변경 → 다시 조회 → 더 받기(Codex v1.7 재리뷰). 서버는 실제 SQL과 같은 정렬·커서로 흉내 낸다
  const fakeServer = (p) => {
    const sv = { items: [], seen: '2026-10-27T02:00:00Z', marks: 0, hold: null, failMarks: 0, markHold: null };
    const ord = (x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.key < y.key ? 1 : x.key > y.key ? -1 : 0);
    p.route('**/rest/v1/rpc/my_activity*', (route) => {
      const b = route.request().postDataJSON() ?? {};
      const list = [...sv.items].sort(ord).filter((i) => !b.p_before_at || i.at < b.p_before_at || (i.at === b.p_before_at && i.key < (b.p_before_key ?? '')));
      const body = list.slice(0, b.p_limit ?? 50);
      // 응답을 붙잡아 둘 요청(첫 쪽 / 더 받기)을 검증이 정한다
      const kind = b.p_before_at ? 'more' : 'head';
      if (sv.hold && sv.hold.kind === kind) { const h = sv.hold; sv.hold = null; h.started(); return h.gate.then(() => fulfill(route, body)); }
      return fulfill(route, body);
    });
    p.route('**/rest/v1/activity_seen*', (route) => fulfill(route, [{ seen_at: sv.seen }]));
    p.route('**/rest/v1/rpc/mark_activity_seen*', async (route) => {
      sv.marks++;
      const t = route.request().postDataJSON()?.p_through;
      // 응답을 붙잡아 둘 읽음 저장(검증이 정함): apply면 서버에는 먼저 저장, fail이면 늦게 실패로 응답
      if (sv.markHold) {
        const h = sv.markHold; sv.markHold = null;
        if (h.apply && t && t > sv.seen) sv.seen = t;
        h.started(); await h.gate;
        return h.fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' }) : fulfill(route, null);
      }
      if (sv.failMarks > 0) { sv.failMarks--; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' }); }
      if (t && t > sv.seen) sv.seen = t;
      return fulfill(route, null);
    });
    return sv;
  };
  const ev = (n, at) => ({ key: `recorded:${String(n).padStart(3, '0')}`, kind: 'recorded', at, meal_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, eaten_on: '2026-10-27', meal_type: '점심', actor: '검증회원', handled: false });
  const waitState = (p, fn) => p.waitForFunction((f) => new Function('s', `return ${f}`)(JSON.parse(document.querySelector('[data-testid=state]').textContent)), String(fn), { timeout: 10000 });

  await soft('같은 소식 시각이 바뀜', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [{ ...ev(1, '2026-10-27T01:00:00Z'), key: 'rated:meal-1', kind: 'rated' }];
    await go();
    await waitState(p, 's.loaded && s.count === 1');
    sv.items = [{ ...sv.items[0], at: '2026-10-27T03:00:00Z' }]; // 다른 기기에서 같은 식사를 다시 평가
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('같은 식사를 다시 평가하면 새 시각으로 바뀌고 새 소식이 됨', st.ats['rated:meal-1'] === '2026-10-27T03:00:00Z' && st.unread === 1, JSON.stringify({ at: st.ats['rated:meal-1'], unread: st.unread }));
    await p.close();
  });

  await soft('조회 사이 새 소식이 많이 들어옴', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = Array.from({ length: 50 }, (_, i) => ev(i, `2026-10-26T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z`));
    await go();
    await waitState(p, 's.loaded && s.count === 50');
    for (let i = 0; i < 60; i++) sv.items.push(ev(100 + i, `2026-10-27T0${Math.floor(i / 10)}:${String((i % 10) * 5).padStart(2, '0')}:00Z`));
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(800);
    for (let i = 0; i < 4; i++) {
      const st = await state(p);
      if (!st.hasMore) break;
      await p.getByRole('button', { name: '더 받기' }).click();
      await p.waitForTimeout(600);
    }
    const st = await state(p);
    check('조회 사이 새 소식 60건이 들어와도 더 받기로 110건 모두 도달', st.count === 110 && new Set(st.keys).size === 110 && !st.hasMore, JSON.stringify({ count: st.count, hasMore: st.hasMore }));
    await p.close();
  });

  await soft('서버에서 소식이 사라짐', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [ev(1, '2026-10-27T03:00:00Z')];
    await go();
    await waitState(p, 's.loaded && s.count === 1 && s.unread === 1');
    sv.items = []; // 식사 삭제·1주일 지남
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('서버에서 사라진 소식은 목록과 새 소식 점에서도 빠짐', st.count === 0 && st.unread === 0, JSON.stringify({ count: st.count, unread: st.unread }));
    // 뒤쪽까지 펼친 상태에서 앞쪽 소식이 사라짐
    sv.items = Array.from({ length: 70 }, (_, i) => ev(i, `2026-10-27T0${Math.floor(i / 10)}:${String((i % 10) * 5).padStart(2, '0')}:00Z`));
    await p.getByRole('button', { name: '다시 조회' }).click();
    await waitState(p, 's.count === 50 && s.hasMore');
    await p.getByRole('button', { name: '더 받기' }).click();
    await waitState(p, 's.count === 70');
    sv.items = sv.items.filter((i) => i.key !== 'recorded:065');
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(800);
    const st2 = await state(p);
    check('펼친 목록을 다시 받아도 펼친 범위를 유지하고 사라진 소식만 빠짐', st2.count === 69 && !st2.keys.includes('recorded:065'), JSON.stringify({ count: st2.count, hasMore: st2.hasMore }));
    await p.close();
  });

  const hold = (sv, kind) => { let release, started; const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r)); sv.hold = { kind, gate, started }; return { release, start }; };
  const evAt = (n) => ev(n, `2026-10-26T${String(10 + Math.floor(n / 6)).padStart(2, '0')}:${String((n % 6) * 10).padStart(2, '0')}:00Z`);

  await soft('갱신 중 더 받기', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = Array.from({ length: 80 }, (_, i) => evAt(i));
    await go();
    await waitState(p, 's.loaded && s.count === 50 && s.hasMore');
    for (let i = 0; i < 3; i++) sv.items.push(ev(200 + i, `2026-10-27T05:0${i}:00Z`));
    // 갱신을 먼저 시작(첫 쪽 응답을 붙잡음) → 옛 화면에서 더 받기 → 갱신 먼저 끝냄 → 더 받기 끝냄
    const h = hold(sv, 'head');
    await p.getByRole('button', { name: '다시 조회' }).click();
    await h.start;
    const m = hold(sv, 'more');
    await p.getByRole('button', { name: '더 받기' }).click();
    await p.waitForTimeout(300);
    h.release();
    await waitState(p, 's.count === 50 && s.keys.includes("recorded:200")');
    m.release();
    await p.waitForTimeout(600);
    let st = await state(p);
    check('갱신 중 시작한 더 받기가 최신 목록을 옛 목록으로 덮지 않음', st.keys.includes('recorded:202') && st.hasMore, JSON.stringify({ count: st.count, hasMore: st.hasMore }));
    sv.hold = null;
    for (let i = 0; i < 3 && st.hasMore; i++) { await p.getByRole('button', { name: '더 받기' }).click(); await p.waitForTimeout(500); st = await state(p); }
    check('그 뒤 더 받기로 83건 모두 도달', st.count === 83 && new Set(st.keys).size === 83 && !st.hasMore, JSON.stringify({ count: st.count }));
    // 반대 순서: 더 받기 먼저 시작 → 갱신 시작 → 더 받기 먼저 끝냄 → 갱신 끝냄
    sv.items.push(ev(300, '2026-10-27T06:00:00Z'));
    const m2 = hold(sv, 'more');
    await p.getByRole('button', { name: '더 받기' }).click().catch(() => {});
    const h2 = hold(sv, 'head');
    await p.getByRole('button', { name: '다시 조회' }).click();
    m2.release();
    await p.waitForTimeout(300);
    h2.release();
    await p.waitForTimeout(800);
    st = await state(p);
    check('더 받기 중 시작한 갱신이 끝나면 최신 목록(84건)', st.count === 84 && st.keys.includes('recorded:300'), JSON.stringify({ count: st.count }));
    await p.close();
  });

  await soft('열린 목록의 같은 개수 갱신', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [{ ...ev(1, '2026-10-27T01:00:00Z'), key: 'rated:meal-1', kind: 'rated' }];
    await go();
    await p.getByRole('button', { name: '목록 열기' }).click();
    await waitState(p, 's.loaded && s.count === 1');
    await p.waitForTimeout(500);
    const before = sv.marks;
    sv.items = [{ ...sv.items[0], at: '2026-10-27T03:00:00Z' }]; // 목록을 연 채로 같은 식사 재평가
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(1000);
    let st = await state(p);
    check('열린 목록에 새로 보여 준 소식(개수 같음)은 읽음 처리', sv.marks === before + 1 && sv.seen === '2026-10-27T03:00:00Z' && st.unread === 0, JSON.stringify({ marks: sv.marks - before, seen: sv.seen, unread: st.unread }));
    // 50건 꽉 찬 목록(모두 이미 읽은 소식)에서 새 한 건이 오래된 한 건을 밀어냄
    sv.items = Array.from({ length: 50 }, (_, i) => ev(i, `2026-10-27T00:${String(i + 5).padStart(2, '0')}:00Z`));
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(1000);
    const mid = sv.marks;
    sv.items.push(ev(99, '2026-10-27T04:30:00Z'));
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(1000);
    st = await state(p);
    check('50건 목록에 새 한 건이 들어와도(개수 같음) 읽음 처리', sv.marks === mid + 1 && st.unread === 0 && st.count === 50, JSON.stringify({ marks: sv.marks - mid, unread: st.unread }));
    // 바뀐 것이 없는 반복 조회는 읽음 요청을 다시 보내지 않음
    const after = sv.marks;
    for (let i = 0; i < 3; i++) { await p.getByRole('button', { name: '다시 조회' }).click(); await p.waitForTimeout(400); }
    check('바뀐 것이 없으면 읽음 요청을 반복하지 않음', sv.marks === after, `추가 요청 ${sv.marks - after}번`);
    await p.close();
  });

  // 13) 읽음 저장이 실패했다가 연결이 회복됨: 앱 복귀·다시 시도로 저장, 계속 실패해도 요청이 쏟아지지 않음(Codex v1.7 운영 배포 후 리뷰 2)
  await soft('읽음 저장 실패 뒤 회복', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [ev(1, '2026-10-27T03:00:00Z')];
    sv.failMarks = 1;
    await go();
    await p.getByRole('button', { name: '목록 열기' }).click();
    await waitState(p, 's.loaded && s.count === 1');
    await p.waitForTimeout(800);
    const first = sv.marks;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 앱으로 돌아옴(연결 회복)
    await p.waitForTimeout(1000);
    let st = await state(p);
    check('읽음 저장이 한 번 실패해도 앱으로 돌아오면 다시 저장해 점이 사라짐', first === 1 && sv.marks === 2 && sv.seen === '2026-10-27T03:00:00Z' && st.unread === 0, JSON.stringify({ first, marks: sv.marks, seen: sv.seen, unread: st.unread }));
    // 계속 실패: 새 소식 하나 더 → 저장 실패가 이어져도 계기(복귀·다시 시도) 없이는 다시 보내지 않음
    sv.items.push(ev(2, '2026-10-27T04:00:00Z'));
    sv.failMarks = 99;
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(800);
    const m1 = sv.marks;
    await p.waitForTimeout(2500);
    check('계속 실패해도 저절로 반복 요청하지 않음', sv.marks === m1, `${sv.marks - m1}번 더`);
    await p.getByRole('button', { name: '다시 시도' }).click();
    await p.waitForTimeout(600);
    check('실패하면 다시 시도 버튼으로 한 번 더 보냄', sv.marks === m1 + 1, `${sv.marks - m1}번`);
    sv.failMarks = 0;
    await p.getByRole('button', { name: '다시 시도' }).click();
    await p.waitForTimeout(1000);
    st = await state(p);
    check('회복되면 저장하고 다시 시도 안내가 사라짐', st.unread === 0 && (await p.getByRole('button', { name: '다시 시도' }).count()) === 0, JSON.stringify({ unread: st.unread }));
    await p.close();
  });

  // 13b) 읽음 저장 두 개가 겹치고 응답 순서가 뒤바뀜: 마지막에 보낸 저장만 오류·다시 시도 표시를 정함(Codex v1.7.1 리뷰)
  const markHold = (sv, opts) => { let release, started; const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r)); sv.markHold = { ...opts, gate, started }; return { release, start }; };
  await soft('읽음 저장 응답 역전', async () => {
    if (!process.env.ONLY_B) { // ONLY_B=1: 두 번째 순서만(고치기 전 코드에서 B가 실패하는지 따로 볼 때)
    // A) 옛 저장은 서버에 반영됐지만 응답이 늦음 → 새 소식 → 최신 저장 B 실패 → 늦은 A 성공 응답
    {
      const { p, go } = await open(ctx, 'activity');
      const sv = fakeServer(p);
      sv.items = [ev(1, '2026-10-27T03:00:00Z')];
      const hA = markHold(sv, { apply: true, fail: false });
      await go();
      await p.getByRole('button', { name: '목록 열기' }).click();
      await hA.start;
      sv.items.push(ev(2, '2026-10-27T04:00:00Z'));
      sv.failMarks = 1;
      await p.getByRole('button', { name: '다시 조회' }).click();
      await p.getByRole('button', { name: '다시 시도' }).waitFor({ timeout: 5000 });
      const respA = p.waitForResponse((r) => r.url().includes('mark_activity_seen') && r.status() === 200);
      hA.release();
      await respA;
      await p.waitForTimeout(200);
      const st = await state(p);
      check('옛 저장의 늦은 성공이 최신 저장의 실패 안내·다시 시도를 지우지 않음', (await p.getByRole('button', { name: '다시 시도' }).count()) === 1 && st.unread === 1, JSON.stringify({ unread: st.unread }));
      await p.getByRole('button', { name: '다시 시도' }).click();
      await p.waitForTimeout(1000);
      check('그 다시 시도로 최신 소식까지 읽음', sv.seen === '2026-10-27T04:00:00Z' && (await state(p)).unread === 0, sv.seen);
      await p.close();
    }
    }
    // B) 옛 저장 응답이 늦음 → 새 소식 → 최신 저장 B 성공 → 늦은 A 실패 응답
    {
      const { p, go } = await open(ctx, 'activity');
      const sv = fakeServer(p);
      sv.items = [ev(1, '2026-10-27T03:00:00Z')];
      const hA = markHold(sv, { apply: false, fail: true });
      await go();
      await p.getByRole('button', { name: '목록 열기' }).click();
      await hA.start;
      sv.items.push(ev(2, '2026-10-27T04:00:00Z'));
      await p.getByRole('button', { name: '다시 조회' }).click();
      await waitState(p, 's.unread === 0');
      const respA = p.waitForResponse((r) => r.url().includes('mark_activity_seen') && r.status() === 503);
      hA.release();
      await respA;
      await p.waitForTimeout(200);
      check('최신 저장이 성공했으면 옛 저장의 늦은 실패로 안내·다시 시도가 생기지 않음', (await p.getByRole('button', { name: '다시 시도' }).count()) === 0 && sv.seen === '2026-10-27T04:00:00Z', sv.seen);
      await p.close();
    }
  });

  // 13c) 이 기기의 읽음 저장이 늦는 사이 다른 기기에서 읽음 → 다시 받아 새 소식 0 → 늦은 실패: 안내·다시 시도가 생기지 않음(Codex v1.7.2 리뷰 P3)
  await soft('다른 기기 읽음 뒤 늦은 실패', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [ev(1, '2026-10-27T03:00:00Z')];
    const hA = markHold(sv, { apply: false, fail: true });
    await go();
    await p.getByRole('button', { name: '목록 열기' }).click();
    await hA.start;
    sv.seen = '2026-10-27T03:00:00Z'; // 다른 기기에서 같은 소식까지 읽음
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 이 기기로 돌아와 다시 받음
    await waitState(p, 's.unread === 0');
    const respA = p.waitForResponse((r) => r.url().includes('mark_activity_seen') && r.status() === 503);
    hA.release();
    await respA;
    await p.waitForTimeout(200);
    check('다른 기기에서 이미 읽었으면 늦은 저장 실패로 안내·다시 시도가 생기지 않음', (await p.getByRole('button', { name: '다시 시도' }).count()) === 0 && (await p.getByText('읽음 표시를 저장하지 못했어요').count()) === 0);
    await p.close();
  });

  // 13d) 저장 실패 → 다른 기기에서 모두 읽음 → 새 소식: 새 저장이 진행 중일 때 옛 실패 안내가 다시 나타나지 않음(Codex v1.7.2 재리뷰 P3)
  await soft('옛 실패가 새 소식에 다시 나타남', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [ev(1, '2026-10-27T03:00:00Z')];
    sv.failMarks = 1;
    await go();
    await p.getByRole('button', { name: '목록 열기' }).click();
    await p.getByRole('button', { name: '다시 시도' }).waitFor({ timeout: 5000 }); // 저장 A 실패
    sv.seen = '2026-10-27T03:00:00Z'; // 다른 기기에서 모두 읽음
    await p.getByRole('button', { name: '다시 조회' }).click();
    await waitState(p, 's.unread === 0');
    sv.items.push(ev(2, '2026-10-27T04:00:00Z')); // 새 소식 → 새 저장 B(응답 보류)
    const hB = markHold(sv, { apply: true, fail: false }); // 성공하는 저장은 서버에 읽음 시각을 남긴다
    await p.getByRole('button', { name: '다시 조회' }).click();
    await hB.start;
    check('새 저장이 진행 중일 때 옛 저장의 실패 안내가 다시 나타나지 않음', (await p.getByText('읽음 표시를 저장하지 못했어요').count()) === 0 && (await p.getByRole('button', { name: '다시 시도' }).count()) === 0);
    const done_ = p.waitForResponse((r) => r.url().includes('mark_activity_seen'));
    hB.release();
    await done_;
    await waitState(p, 's.unread === 0').catch(() => {});
    check('새 저장이 성공하면 새 소식 0, 안내 없음', (await state(p)).unread === 0 && (await p.getByText('읽음 표시를 저장하지 못했어요').count()) === 0);
    await p.close();
  });

  // 15) 알림 목록을 열지 않고 그 식사만 따로 확인함(피드백 탭·확인 목록) → 종 버튼 점이 사라짐(v1.8 사용자 요청)
  await soft('따로 확인한 소식', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = [{ ...ev(1, '2026-10-27T03:00:00Z'), key: 'rated:meal-1', kind: 'rated', handled: false }];
    await go();
    await waitState(p, 's.loaded && s.unread === 1');
    sv.items = [{ ...sv.items[0], handled: true }]; // 피드백 탭에서 그 식사를 읽음(서버가 확인함으로 돌려줌)
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('알림 목록을 열지 않아도 그 식사를 확인했으면 새 소식에서 빠짐', st.unread === 0, JSON.stringify({ unread: st.unread }));
    check('그때 읽음 저장 요청은 보내지 않음(목록을 열지 않았으므로)', sv.marks === 0, `${sv.marks}번`);
    await p.close();
  });

  // 15b) handled가 섞인 첫 쪽: 첫 쪽의 가장 오래된 소식은 확인함, 아직 안 받은 51번째는 미확인 → 뒤쪽을 받기 전엔 읽음 저장 안 함(Codex v1.8.0 리뷰 5)
  await soft('handled 섞인 쪽 경계', async () => {
    const { p, go } = await open(ctx, 'activity');
    const sv = fakeServer(p);
    sv.items = Array.from({ length: 51 }, (_, i) => ({ ...ev(i, new Date(Date.parse('2026-10-27T10:00:00Z') - i * 60000).toISOString()), handled: i === 49 }));
    await go();
    await waitState(p, 's.loaded && s.count === 50 && s.hasMore');
    await p.getByRole('button', { name: '목록 열기' }).click();
    await p.waitForTimeout(800);
    check('아직 안 받은 뒤쪽 소식이 남았으면 읽음 저장 안 함(첫 쪽 마지막이 확인한 소식이어도)', sv.marks === 0, `${sv.marks}번`);
    await p.getByRole('button', { name: '더 받기' }).click();
    await waitState(p, 's.count === 51');
    await p.waitForTimeout(800);
    const st = await state(p);
    check('뒤쪽까지 받은 뒤에 읽음 저장(51번째도 보여 준 뒤)', sv.marks === 1 && sv.seen === '2026-10-27T10:00:00.000Z', JSON.stringify({ marks: sv.marks, seen: sv.seen, unread: st.unread }));
    await p.close();
  });

  // 16) 좋아요 저장 중 앱 복귀 조회가 옛 값(false)을 받아도 저장 결과가 이김(Codex v1.8.0 리뷰 7)
  await soft('좋아요 저장과 복귀 조회', async () => {
    const { p, go } = await open(ctx, 'like');
    let liked = false, release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    const sent = [];
    await p.route('**/rest/v1/trainer_messages*', (route) => fulfill(route, { body: '오늘도 화이팅' }));
    await p.route('**/rest/v1/rpc/my_message_like*', (route) => fulfill(route, liked));
    await p.route('**/rest/v1/rpc/set_message_like*', async (route) => {
      const on = route.request().postDataJSON().p_on;
      sent.push(on);
      if (sent.length === 1) { started(); await gate; }
      liked = on;
      return fulfill(route, null);
    });
    await go();
    await p.locator('.today-line-head').click(); // 2.0: 한마디 한 줄을 펼치면 좋아요
    const btn = p.locator('.like-button');
    await p.locator('.like-button:not([disabled])').waitFor({ timeout: 10000 });
    await btn.click();
    await start;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 저장 전 값(false)을 받는 조회
    await p.waitForTimeout(500);
    release();
    await p.locator('.like-button[aria-pressed=true]:not([disabled])').waitFor({ timeout: 5000 });
    await btn.click();
    await p.locator('.like-button[aria-pressed=false]:not([disabled])').waitFor({ timeout: 5000 });
    check('저장 중 복귀 조회가 끼어도 눌린 상태로 남고, 다음 누름은 취소를 보냄', JSON.stringify(sent) === '[true,false]' && liked === false, JSON.stringify(sent));
    await p.close();
  });

  // 17) 공유 동의 조회 실패 → 꺼진 스위치로 보이지 않고 안내·다시 불러오기, 앱 복귀에도 다시 받음(Codex v1.8.0 리뷰 8)
  // 수동 '다시 불러오기'는 클라이언트가 스스로 다시 시도하지 않는 500으로 본다 — 503(GET)은 supabase-js가 몇 번 다시 시도해, 그사이 회복되면
  // 버튼이 사라진 정상 화면에서 클릭을 기다리게 된다(Codex v2.0.1 3차 리뷰 P3). 503 자동 회복은 아래에서 따로 최종 상태만 본다
  await soft('공유 동의 조회 실패', async () => {
    const { p, go } = await open(ctx, 'consent');
    let down = true, calls = 0;
    await p.route('**/rest/v1/profiles*', (route) => { calls++; return down ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }) : fulfill(route, { share_consent: true }); });
    await go();
    await p.getByText('설정을 불러오지 못했어요.').waitFor({ timeout: 10000 });
    check('실패하면 스위치를 그리지 않음(꺼짐으로 보이지 않음)', (await p.getByRole('switch').count()) === 0);
    const before = calls;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    for (let i = 0; i < 40 && calls === before; i++) await p.waitForTimeout(100);
    await p.waitForTimeout(300); // 다시 조회가 실패로 끝나 버튼이 남아 있는 상태
    check('앱으로 돌아오면 다시 조회(실패면 안내 그대로)', calls > before && (await p.getByRole('button', { name: '다시 불러오기' }).count()) === 1, `${before} → ${calls}번`);
    down = false;
    await p.getByRole('button', { name: '다시 불러오기' }).click();
    await p.getByRole('switch').waitFor({ timeout: 5000 });
    check('다시 불러오면 서버 값(켜짐)으로', await p.getByRole('switch').isChecked());
    await p.close();
  });
  await soft('공유 동의 일시 장애 자동 회복', async () => {
    const { p, go } = await open(ctx, 'consent');
    let fails = 1;
    await p.route('**/rest/v1/profiles*', (route) => (fails-- > 0 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"busy"}' }) : fulfill(route, { share_consent: true })));
    await go();
    await p.getByRole('switch').waitFor({ timeout: 15000 });
    check('일시 장애(503) 뒤 클라이언트 재시도로 회복하면 서버 값(켜짐)·실패 안내 없음', (await p.getByRole('switch').isChecked()) && (await p.getByText('설정을 불러오지 못했어요.').count()) === 0);
    await p.close();
  });

  // 18) v2.0 식단왕·운동왕 칸: 15일까지는 지난달 결과, 16일부터(회원)는 이번 달 참여 현황 · 집계 전 안내 · 실패는 다시 불러오기
  await soft('식단왕 칸 날짜별 표시', async () => {
    const p = await ctx.newPage();
    let calls = { awards: [], progress: 0 }, published = false, down = true, started = true;
    await p.route('**/rest/v1/rpc/awards_for_me*', (r) => { calls.awards.push(r.request().postDataJSON().p_month); return down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }) : fulfill(r, { month: '2026-10-01', published, started, starts: '2026-11-01', winners: published ? [{ kind: 'streak', nickname: '검증회원', score: 12, is_me: false }, { kind: 'streak', nickname: '다른회원', score: 12, is_me: true }] : [] }); });
    await p.route('**/rest/v1/rpc/my_award_progress*', (r) => { calls.progress++; return fulfill(r, { meals: 12, rated: 4, days: 9, best_streak: 5, workout_days: 3 }); });
    await p.route('**/rest/v1/rpc/award_months*', (r) => fulfill(r, published ? [{ month: '2026-10-01' }] : []));
    await p.goto(`${BASE}?mode=awards&today=2026-11-10`);
    const lastMonth = p.getByTestId('awards-2026-10-01');
    await lastMonth.getByText('수상 결과를 불러오지 못했어요').waitFor({ timeout: 10000 });
    down = false;
    await lastMonth.getByRole('button', { name: '다시 불러오기' }).click();
    await p.getByText('지난달 결과를 집계하고 있어요').waitFor({ timeout: 5000 });
    for (let i = 0; i < 30 && !calls.progress; i++) await p.waitForTimeout(100);
    check('11월 10일(달 초반): 지난달(10월) 결과와 집계 전 안내 · 남은 조건과 현재 순위도 함께', calls.awards.every((m) => m === '2026-10-01') && calls.progress > 0 && (await p.getByTestId('award-standings').count()) === 1, JSON.stringify(calls));
    // 수상 시작 전 달(10월, 2026-10-30 사용자 결정): '조건을 채운 회원이 없었어요'가 아니라 시작 안내
    started = false;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.getByTestId('awards-not-started').filter({ hasText: '11월 기록부터 뽑아요. 11월 결과는 12월 1일' }).waitFor({ timeout: 5000 });
    check('시작 전 달은 시작 달 안내(수상자 없음 문구 아님)', (await p.getByText('수상 조건을 채운 회원이 없었어요').count()) === 0);
    started = true;
    published = true;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await lastMonth.filter({ hasText: '다른회원 (나) 외 1명' }).waitFor({ timeout: 5000 });
    check('공동 수상은 이름 하나와 외 n명, 내가 있으면 내 이름이 앞', (await lastMonth.getByText('검증회원').count()) === 0);
    await p.goto(`${BASE}?mode=awards&today=2026-11-10`);
    await p.getByTestId('awards').filter({ hasText: '10월 수상자' }).filter({ hasText: '다른회원 (나) 외 1명' }).waitFor({ timeout: 5000 });
    check('첫 화면: 가장 최근 수상자 한 줄', true);
    // 달 후반에도 지난달 결과가 남는다(2.3 사용자 결정 11-05). 내 기록 현황 + 이번 달 현재 순위. 순위는 3위까지(동점은 한 줄), 3위 밖이면 내 순위, 후보 전이면 조건
    let standDown = true, standCalls = [];
    await p.route('**/rest/v1/rpc/award_standings*', (r) => {
      standCalls.push(r.request().postDataJSON().p_today);
      if (standDown) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
      return fulfill(r, { month: '2026-11-01', started: true, starts: '2026-11-01', workout_started: false, workout_starts: '2026-12-01', rows: [
        { kind: 'rating', rank: 1, nickname: '가회원', score: 5, is_me: false, qualified: true }, { kind: 'rating', rank: 1, nickname: '익명 회원', score: 5, is_me: false, qualified: true },
        { kind: 'rating', rank: 3, nickname: '다회원', score: 3.4, is_me: false, qualified: false }, { kind: 'rating', rank: 5, nickname: '검증', score: 2.2, is_me: true, qualified: false },
      ] });
    });
    await p.goto(`${BASE}?mode=awards&today=2026-11-16`);
    await p.getByTestId('award-standings').getByText('현재 순위를 불러오지 못했어요').waitFor({ timeout: 10000 });
    check('11월 16일(달 후반, 회원): 지난달 결과와 현재 순위가 함께 보임', (await p.getByTestId('awards').count()) === 1 && standCalls.every((d) => d === '2026-11-16'), JSON.stringify(standCalls));
    standDown = false;
    await p.getByTestId('award-standings').getByRole('button', { name: '다시 불러오기' }).click();
    await p.getByTestId('standing-rating').filter({ hasText: '가회원 외 1명' }).filter({ hasText: '나 5위' }).waitFor({ timeout: 5000 });
    check('첫 화면 한 줄: 1위 이름과 외 n명 · 내 순위', true);
    await p.reload();
    const rating = p.getByTestId('board-rating');
    await rating.locator('li', { hasText: '1위' }).filter({ hasText: '가회원 외 1명' }).waitFor({ timeout: 5000 });
    check('현재 순위: 공동 1위는 한 줄, 다음은 3위, 3위 밖이면 내 행', (await rating.locator('ol li').count()) === 3 && (await rating.locator('ol li', { hasText: '3위' }).filter({ hasText: '다회원' }).count()) === 1);
    const ruleBox = await rating.locator('.award-rules li').first().evaluate((el) => ({ h: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
    check('상의 창: 기준 줄은 순위 행 배치를 받지 않음(글자가 세로로 갈리지 않음)', ruleBox.h <= ruleBox.line * 2.2, JSON.stringify(ruleBox));
    check('현재 순위: 3위 밖이면 내 행을 강조', (await rating.locator('li.me', { hasText: '5위' }).filter({ hasText: '검증 (나)' }).filter({ hasText: '평가 평균 2.2점' }).count()) === 1);
    check('현재 순위: 후보가 아닌 회원도 순위에 들고 후보 전 표시', (await rating.locator('li', { hasText: '다회원' }).getByText('조건 미달').count()) === 1 && (await rating.locator('li', { hasText: '가회원' }).getByText('조건 미달').count()) === 0);
    check('현재 순위: 후보까지 남은 양(기록 12끼·평가 4끼 → 평가왕은 평가 6끼 · 꾸준왕은 기록을 채워 조건만)', (await p.getByTestId('need-rating').innerText()) === '후보까지 식단 평가 6끼 남았어요.' && (await p.getByTestId('need-streak').innerText()) === '식사를 10끼 이상 기록하면 후보가 돼요.', await p.getByTestId('need-rating').innerText());
    check('현재 순위: 운동왕은 시작 달 안내(12월)', (await p.getByTestId('board-workout').getByText('12월 기록부터 순위를 매겨요').count()) === 1 && (await p.getByTestId('standing-workout').getByText('12월부터').count()) === 1);
    await p.goto(`${BASE}?mode=awards&today=2026-11-16&role=trainer`);
    await p.getByTestId('board-rating').locator('li', { hasText: '다회원' }).waitFor({ timeout: 5000 });
    check('트레이너: 지난달 결과와 현재 순위(남은 조건·내 순위 없음)', (await p.getByTestId('awards').count()) === 1 && (await p.getByTestId('need-rating').count()) === 0 && (await p.getByText(/나 \d+위/).count()) === 0);
    await p.goto(`${BASE}?mode=awards&today=2026-01-05`);
    await p.getByTestId('awards-2025-12-01').waitFor({ timeout: 8000 });
    for (let i = 0; i < 30 && !calls.awards.includes('2025-12-01'); i++) await p.waitForTimeout(100);
    check('1월에는 지난해 12월 결과', calls.awards.includes('2025-12-01'), JSON.stringify(calls.awards.slice(-3)));
    await p.close();
  });

  // 18d) 2.3.2 수상 줄의 경계: 수상 이력이 없을 때 · 익명 수상자 · 긴 닉네임이 320폭에서 제목을 밀지 않음 · 후보인 회원에게는 남은 조건 실패 안내가 없음
  await soft('2.3.2 수상 줄 경계', async () => {
    const p = await ctx.newPage();
    let months = [], winners = [];
    const long = '아주아주아주아주아주아주긴닉네임회원';
    await p.route('**/rest/v1/rpc/award_months*', (r) => fulfill(r, months));
    await p.route('**/rest/v1/rpc/awards_for_me*', (r) => fulfill(r, { month: '2026-10-01', published: true, started: true, starts: '2026-10-01', winners }));
    await p.route('**/rest/v1/rpc/my_award_progress*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await p.route('**/rest/v1/rpc/strength_kings*', (r) => fulfill(r, { month: '2026-11-01', started: true, my_gender: null, my_state: 'ok', kings: [], mine: [] }));
    await p.route('**/rest/v1/rpc/award_standings*', (r) => fulfill(r, { month: '2026-11-01', started: true, starts: '2026-11-01', workout_started: true, workout_starts: '2026-11-01', rows: [{ kind: 'rating', rank: 1, nickname: long, score: 4.5, is_me: false, qualified: true }, { kind: 'rating', rank: 2, nickname: '검증', score: 4, is_me: true, qualified: true }] }));
    await p.goto(`${BASE}?mode=awards&today=2026-11-16`);
    await p.getByTestId('awards').filter({ hasText: '아직 없어요' }).waitFor({ timeout: 8000 });
    check('수상 이력이 없으면 지난 수상 줄에 아직 없어요', (await p.getByTestId('awards').innerText()).includes('지난 수상'));
    check('후보를 채운 회원에게는 남은 조건 실패 안내가 뜨지 않음(후보 전인 상에는 뜸)', (await p.getByTestId('board-rating').getByText('남은 조건을 불러오지 못했어요').count()) === 0 && (await p.getByTestId('need-rating').count()) === 0 && (await p.getByTestId('board-streak').getByText('남은 조건을 불러오지 못했어요').count()) === 1);
    await p.setViewportSize({ width: 320, height: 640 });
    await p.evaluate(() => document.documentElement.style.setProperty('--ts', '1.25'));
    await p.waitForTimeout(100);
    const row = await p.getByTestId('standing-rating').evaluate((el) => { const b = el.querySelector('b').getBoundingClientRect(), v = el.querySelector('small').getBoundingClientRect(); return { oneLine: b.height <= parseFloat(getComputedStyle(el.querySelector('b')).fontSize) * 1.8, apart: b.right <= v.left, inside: el.scrollWidth <= el.clientWidth }; });
    check('긴 닉네임: 320폭·큰 글씨에서 상 이름은 한 줄이고 값과 겹치지 않음', row.oneLine && row.apart && row.inside, JSON.stringify(row));
    months = [{ month: '2026-10-01' }];
    winners = ['rating', 'streak', 'workout'].map((kind) => ({ kind, nickname: '익명 회원', score: 5, is_me: false }));
    await p.goto(`${BASE}?mode=awards&today=2026-11-16`);
    await p.getByTestId('awards').filter({ hasText: '10월 수상자' }).filter({ hasText: '익명 회원 외 2명' }).waitFor({ timeout: 8000 });
    check('익명 수상자는 이름이 같아도 상마다 셈', true);
    await p.close();
  });

  // 18e) v2.0.1(2026-11-02 사용자 요청): 운동 탭 '변화'가 비면 고장처럼 보였다 — 불러오는 중·실패·기록 없음·하나뿐을 각각 보인다
  await soft('변화 칸 상태', async () => {
    const p = await ctx.newPage();
    const at = async (q) => { await p.goto(`${BASE}?mode=reportsState&${q}`); await p.waitForLoadState('networkidle'); };
    await at('n=0&state=ok');
    await p.getByText('아직 인바디 기록이 없어요').waitFor({ timeout: 10000 });
    check('변화: 인바디 기록이 없으면 안내(빈 화면 아님)', (await p.getByText('인바디를 두 번 이상 기록하면').count()) === 1);
    await at('n=1&state=ok');
    await p.getByText('비교할 측정이 하나 더 필요해요').waitFor({ timeout: 5000 });
    check('변화: 기록이 하나면 그 측정 날짜와 다음 측정 안내', (await p.getByText(/10월 22일.*측정과 비교해/).count()) === 1);
    await at('n=0&state=loading');
    check('변화: 불러오는 중 표시', (await p.locator('.state-panel.loading').count()) === 1 && (await p.getByText('아직 인바디 기록이 없어요').count()) === 0);
    await at('n=0&state=failed');
    await p.getByText('인바디 기록을 불러오지 못했어요').waitFor({ timeout: 5000 });
    await p.getByRole('button', { name: '다시 불러오기' }).click();
    check('변화: 불러오지 못하면 실패 안내·다시 불러오기', (await p.evaluate(() => window.__reloaded)) === 1);
    await at('n=2&state=ok');
    await p.getByText('지난 측정 이후의 변화').waitFor({ timeout: 10000 });
    check('변화: 기록이 둘이면 변화 카드(안내 없음)', (await p.getByText('비교할 측정이 하나 더 필요해요').count()) === 0);
    await p.close();
  });

  // 18e-2) Codex v2.0.1 2차 리뷰: 실제 훅과 화면을 이어서 — 다른 회원의 기록을 넘기지 않고, 재조회 실패는 기록 개수와 관계없이 알린다
  await soft('인바디 회원 전환·재조회 실패', async () => {
    const p = await ctx.newPage();
    const rec = (m, id, day, w) => ({ id, member_id: m, measured_on: day, weight_kg: w, smm_kg: 30, pbf_pct: 22, source: 'manual', created_at: `${day}T01:00:00Z` });
    const ctl = { [a]: { ok: true, rows: [rec(a, 'a2', '2026-10-22', 71.7), rec(a, 'a1', '2026-09-15', 73.9)] }, [b]: { ok: false, rows: [] } };
    await p.route('**/rest/v1/inbody_records*', (route) => {
      const m = /member_id=eq\.([0-9a-f-]+)/.exec(route.request().url())?.[1];
      const c = ctl[m];
      // 503은 클라이언트가 몇 번 다시 시도해 실패가 늦게 드러난다 — 바로 실패로 끝나는 500으로 흉내 낸다
      return c?.ok ? fulfill(route, c.rows) : route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
    });
    await p.route('**/rest/v1/rpc/**', (route) => fulfill(route, null));
    await p.goto(`${BASE}?mode=inbodyLive`);
    const panel = p.getByTestId('live-panel'), reports = p.getByTestId('live-reports');
    await reports.getByText('지난 측정 이후의 변화').waitFor({ timeout: 10000 });
    // 1) A를 본 뒤 B 첫 조회 실패: A의 측정값을 B 화면에 보이지 않는다
    await p.getByRole('button', { name: '회원 B' }).click();
    await reports.getByText('인바디 기록을 불러오지 못했어요').waitFor({ timeout: 15000 });
    check('회원 B 조회 실패: 회원 A의 측정값을 보이지 않음(인바디 칸·변화 칸)', (await p.getByText('71.7').count()) === 0 && (await p.getByText('지난 측정 이후의 변화').count()) === 0 && (await panel.getByText('인바디 기록을 불러오지 못했어요').count()) === 1);
    // 2) 같은 회원 재조회 실패: 마지막 값은 두고 실패 안내·다시 불러오기
    await p.getByRole('button', { name: '회원 A' }).click();
    await reports.getByText('지난 측정 이후의 변화').waitFor({ timeout: 15000 });
    ctl[a].ok = false;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await reports.locator('.stale-notice', { hasText: '최신 인바디 기록' }).waitFor({ timeout: 15000 });
    check('같은 회원 재조회 실패: 변화·인바디 칸 모두 마지막 값과 새로 받지 못함 안내', (await reports.getByText('지난 측정 이후의 변화').count()) === 1 && (await panel.locator('.stale-notice', { hasText: '최신 인바디 기록' }).count()) === 1 && (await panel.getByText('71.7').count()) >= 1);
    ctl[a].ok = true;
    await reports.locator('.stale-notice', { hasText: '최신 인바디 기록' }).getByRole('button', { name: '다시 불러오기' }).click();
    await reports.locator('.stale-notice', { hasText: '최신 인바디 기록' }).waitFor({ state: 'detached', timeout: 15000 });
    check('다시 불러오기에 성공하면 안내가 사라짐', true);
    // 3) 기록이 하나인 회원의 재조회 실패: 비교 안내와 함께 실패 안내·다시 불러오기
    ctl[a].rows = [rec(a, 'a2', '2026-10-22', 71.7)];
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await reports.getByText('비교할 측정이 하나 더 필요해요').waitFor({ timeout: 15000 });
    ctl[a].ok = false;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await reports.locator('.stale-notice', { hasText: '최신 인바디 기록' }).waitFor({ timeout: 15000 });
    check('기록 하나 + 재조회 실패: 비교 안내와 함께 다시 불러오기', (await reports.getByText('비교할 측정이 하나 더 필요해요').count()) === 1 && (await reports.locator('.stale-notice', { hasText: '최신 인바디 기록' }).getByRole('button', { name: '다시 불러오기' }).count()) === 1);
    await p.close();
  });

  // 18e-3) Codex v2.0.1 4차 리뷰: 실제 회원 화면 — 오늘 기록이 반영돼 다시 센 연속 기록(8일)을, 먼저 시작해 늦게 끝난 옛 조회(어제까지 7일)가 덮지 않는다
  await soft('연속 기록 응답 순서', async () => {
    const p = await ctx.newPage();
    let phase = 0, calls = 0, releaseOld, startedOld;
    const oldGate = new Promise((r) => (releaseOld = r)), oldStarted = new Promise((r) => (startedOld = r));
    const days = await p.evaluate(() => Array.from({ length: 8 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }));
    const rows = days.map((day, i) => ({ id: `44444444-4444-4444-8444-${String(i + 1).padStart(12, '0')}`, member_id: a, eaten_on: day, eaten_at: '12:00:00', meal_type: '점심', food: '연속 기록 식사', note: '', photo_path: null, created_at: `${day}T03:00:00Z`, reviewed_at: null, member_seen_at: null, note_updated_at: null, member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: '검증 회원' } }));
    await p.route('**/rest/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(route, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/meals')) return fulfill(route, phase ? rows : rows.slice(1)); // 처음엔 어제까지 7일, 다음엔 오늘 식사 포함
      if (path.endsWith('/rpc/meal_streak')) {
        calls++;
        if (calls === 1) { startedOld(); await oldGate; return fulfill(route, { current: 7, best: 7, today_logged: false }); }
        return fulfill(route, { current: 8, best: 8, today_logged: true });
      }
      return fulfill(route, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await oldStarted;
    phase = 1;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.getByTestId('streak').filter({ hasText: '연속 8일' }).waitFor({ timeout: 15000 });
    releaseOld();
    await p.waitForTimeout(1000);
    const t = await p.getByTestId('streak').innerText();
    check('늦게 끝난 옛 연속 기록 조회가 최신 배지(연속 8일)를 덮지 않음', t.includes('연속 8일') && !t.includes('어제까지'), t.replace(/\s+/g, ' '));
    await p.close();
  });

  // 18e-4) Codex v2.0.1 4차 리뷰: 변화 카드 — 식단 결산·운동 요약은 따로 보이고, 한쪽 실패가 다른 쪽과 체성분 변화를 가리지 않는다. 다시 불러오기는 요약을 실제로 다시 받는다
  await soft('변화 카드 부분 실패', async () => {
    const p = await ctx.newPage();
    const rec = (id, day, w) => ({ id, member_id: a, measured_on: day, weight_kg: w, smm_kg: 30, pbf_pct: 22, source: 'manual', created_at: `${day}T01:00:00Z` });
    const ctl = { diet: false, workout: true, dietCalls: 0 };
    const diet = { days: 37, logged_days: 20, meals: 30, rated: 25, great: 10, good: 10, care: 5, score: 3.4 };
    await p.route('**/rest/v1/inbody_records*', (route) => fulfill(route, [rec('a2', '2026-10-22', 71.7), rec('a1', '2026-09-15', 73.9)]));
    await p.route('**/rest/v1/rpc/diet_report*', (route) => { ctl.dietCalls++; return ctl.diet ? fulfill(route, diet) : route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }); });
    await p.route('**/rest/v1/rpc/workout_summary*', (route) => (ctl.workout ? fulfill(route, { days: 2, done_sets: 7 }) : route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' })));
    await p.goto(`${BASE}?mode=inbodyLive`);
    const reports = p.getByTestId('live-reports');
    await reports.getByText('식단 평가를 불러오지 못했어요').waitFor({ timeout: 15000 });
    check('식단 결산만 실패: 운동 요약·체성분 변화는 그대로 보임', (await reports.getByText('운동한 날 2일 · 완료한 세트 7').count()) === 1 && (await reports.getByText(/체중 ▼ 2\.2kg/).count()) === 1);
    const n = ctl.dietCalls;
    ctl.diet = true;
    await reports.locator('.stale-notice', { hasText: '식단 평가·운동 기록' }).getByRole('button', { name: '다시 불러오기' }).click();
    await reports.locator('.report-score', { hasText: '3.4점' }).waitFor({ timeout: 15000 });
    check('요약 다시 불러오기: 식단 결산을 실제로 다시 받고 안내가 사라짐', ctl.dietCalls > n && (await reports.locator('.stale-notice', { hasText: '식단 평가·운동 기록' }).count()) === 0, JSON.stringify({ before: n, after: ctl.dietCalls }));
    ctl.diet = false; ctl.workout = false;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await reports.locator('.stale-notice', { hasText: '식단 평가·운동 기록' }).waitFor({ timeout: 15000 });
    check('다시 받다 실패: 마지막 식단·운동 값과 체성분은 두고 실패 안내', (await reports.locator('.report-score', { hasText: '3.4점' }).count()) === 1 && (await reports.getByText('운동한 날 2일 · 완료한 세트 7').count()) === 1 && (await reports.getByText(/체중 ▼ 2\.2kg/).count()) === 1);
    await p.close();
    // 운동 요약만 실패(처음부터): 식단 결산·체성분은 보임
    const q = await ctx.newPage();
    await q.route('**/rest/v1/inbody_records*', (route) => fulfill(route, [rec('a2', '2026-10-22', 71.7), rec('a1', '2026-09-15', 73.9)]));
    await q.route('**/rest/v1/rpc/diet_report*', (route) => fulfill(route, diet));
    await q.route('**/rest/v1/rpc/workout_summary*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }));
    await q.goto(`${BASE}?mode=inbodyLive`);
    const r2 = q.getByTestId('live-reports');
    await r2.getByText('운동 기록을 불러오지 못했어요').waitFor({ timeout: 15000 });
    check('운동 요약만 실패: 식단 결산·체성분 변화는 그대로 보임', (await r2.locator('.report-score', { hasText: '3.4점' }).count()) === 1 && (await r2.getByText(/체중 ▼ 2\.2kg/).count()) === 1);
    await q.close();
  });

  // 18e-5) Codex v2.0.2 1차 리뷰 P2: 조회 하나가 끝나지 않아도 끝난 조회는 바로 보이고, 제한 시간이 지나면 그 칸만 실패·다시 불러오기
  await soft('변화 카드 지연 요청', async () => {
    const p = await ctx.newPage();
    await p.clock.install();
    const rec = (id, day, w) => ({ id, member_id: a, measured_on: day, weight_kg: w, smm_kg: 30, pbf_pct: 22, source: 'manual', created_at: `${day}T01:00:00Z` });
    const diet = { days: 37, logged_days: 20, meals: 30, rated: 25, great: 10, good: 10, care: 5, score: 3.4 };
    // 과거 기간(~09-15)의 식단 결산만 붙잡아 둔다. hold()가 돌려준 함수로 그 요청을 끝낸다
    const ctl = { hold: null, held: 0 };
    const hold = () => { let end; const gate = new Promise((r) => (end = r)); ctl.hold = gate; return (ok) => { ctl.hold = null; end(ok); }; };
    await p.route('**/rest/v1/inbody_records*', (route) => fulfill(route, [rec('a3', '2026-10-22', 71.7), rec('a2', '2026-09-15', 73.9), rec('a1', '2026-08-15', 75.0)]));
    await p.route('**/rest/v1/rpc/diet_report*', async (route) => {
      const gate = ctl.hold;
      if (gate && route.request().postDataJSON()?.p_to === '2026-09-15') {
        ctl.held++;
        return (await gate) ? fulfill(route, { ...diet, score: 4.1 }) : route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"late"}' });
      }
      return fulfill(route, { ...diet, score: route.request().postDataJSON()?.p_to === '2026-09-15' ? 4.1 : 3.4 });
    });
    await p.route('**/rest/v1/rpc/workout_summary*', (route) => fulfill(route, { days: 2, done_sets: 7 }));
    const endFirst = hold();
    await p.goto(`${BASE}?mode=inbodyLive`);
    const reports = p.getByTestId('live-reports');
    const cards = reports.locator('.report-card');
    const notice = reports.locator('.stale-notice', { hasText: '식단 평가·운동 기록' });
    const older = cards.nth(1).locator('.report-score');
    await cards.nth(0).locator('.report-score', { hasText: '3.4점' }).waitFor({ timeout: 10000 });
    await reports.getByText('운동한 날 2일 · 완료한 세트 7').nth(1).waitFor({ timeout: 5000 });
    check('과거 기간의 식단 결산 하나가 끝나지 않아도 최신 기간 식단·두 기간 운동 요약은 바로 보임', ctl.held === 1 && (await older.getByText('불러오는 중…').count()) === 1 && (await notice.count()) === 0, JSON.stringify({ held: ctl.held }));
    await p.clock.fastForward(16_000);
    await older.getByText('식단 평가를 불러오지 못했어요').waitFor({ timeout: 5000 });
    check('제한 시간이 지나면 그 칸만 실패로 보이고 다시 불러오기', (await notice.count()) === 1 && (await cards.nth(0).locator('.report-score', { hasText: '3.4점' }).count()) === 1 && (await reports.getByText('운동한 날 2일 · 완료한 세트 7').count()) === 2);
    endFirst(true);
    await older.filter({ hasText: '4.1점' }).waitFor({ timeout: 5000 });
    check('제한 시간 뒤에라도 응답이 오면 그 값을 보이고 안내가 사라짐', (await notice.count()) === 0);
    // 다시 받는 조회가 끝나지 않으면: 마지막 값은 그대로, 제한 시간 뒤 안내 → 다시 불러오기로 새로 받음 → 먼저 보낸 조회가 뒤늦게 실패해도 덮지 않음
    const endSecond = hold();
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    for (let i = 0; i < 50 && ctl.held < 2; i++) await p.waitForTimeout(100);
    check('다시 받는 동안에는 마지막 값을 그대로 보임', ctl.held === 2 && (await older.filter({ hasText: '4.1점' }).count()) === 1 && (await notice.count()) === 0, JSON.stringify({ held: ctl.held }));
    await p.clock.fastForward(16_000);
    await notice.waitFor({ timeout: 5000 });
    check('다시 받다 제한 시간이 지나면 마지막 값과 안내를 함께', (await older.filter({ hasText: '4.1점' }).count()) === 1);
    // 새 조회는 바로 답하고, 먼저 보낸 조회는 계속 붙잡아 둔다
    const heldBefore = ctl.held;
    ctl.hold = null;
    await notice.getByRole('button', { name: '다시 불러오기' }).click();
    await notice.waitFor({ state: 'detached', timeout: 5000 });
    endSecond(false);
    await p.waitForTimeout(500);
    check('다시 불러오기 뒤 먼저 보낸 조회가 뒤늦게 실패로 끝나도 새 값을 덮지 않음', ctl.held === heldBefore && (await notice.count()) === 0 && (await older.filter({ hasText: '4.1점' }).count()) === 1, JSON.stringify({ held: ctl.held }));
    await p.close();
  });

  // 18f) v2.0.1: 시작 안내 '휴대폰 알림 받기' — 홈 화면 앱에서도 그림 안내 버튼(운동 시트 연결처럼), 알림 설정에는 업데이트 소식 줄 없음
  await soft('홈 화면 앱의 알림 그림 안내', async () => {
    const c = await newCtx({ ...devices['iPhone 13'] });
    await c.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
    const p = await c.newPage();
    await p.goto(`${BASE}?mode=guide`);
    await p.getByRole('button', { name: '다음', exact: true }).click();
    await p.getByRole('heading', { name: '휴대폰 알림 받기' }).waitFor({ timeout: 10000 });
    check('홈 화면 앱: 설정 안내 문구(설정 → 알림)', (await p.getByText('이 기기에서 알림 받기', { exact: false }).count()) >= 1);
    await p.getByRole('button', { name: '그림으로 알림 받는 방법 보기' }).click();
    await p.getByRole('heading', { name: '휴대폰에서 새 소식 받기' }).waitFor({ timeout: 5000 });
    await p.getByRole('button', { name: '← 안내로 돌아가기' }).first().click();
    await p.getByRole('heading', { name: '휴대폰 알림 받기' }).waitFor({ timeout: 5000 });
    check('홈 화면 앱: 그림 안내로 갔다가 같은 쪽으로 돌아옴', true);
    await c.close();
  });
  await soft('알림 설정에 업데이트 소식 줄 없음', async () => {
    const { p, go } = await open(ctx, 'prefs');
    await p.route('**/rest/v1/push_prefs*', (route) => fulfill(route, [{ digest: true, digest_times: '3', feedback: true, reminder: true, morning: true, updates: false }]));
    await go();
    await p.getByLabel('트레이너가 남긴 피드백').waitFor({ timeout: 10000 });
    check('알림 설정: 앱 업데이트 소식을 끄고 켜는 줄이 없음(운영자가 보냄)', (await p.getByText('앱 업데이트 소식').count()) === 0);
    await p.close();
  });

  // 18b) v2.0 정식 1차 리뷰(2026-11-01 Codex): 16일 이후 커뮤니티에서 알림 목록 → 식사 평가 → 창 닫기만 해도 현재 순위를 다시 받는다(앱 복귀 없이).
  //      다시 받기가 실패하면 마지막 순위는 두고 '새로 받지 못함'과 다시 불러오기를 보인다. 화면 날짜만 11월 16일로 바꾼다(기기·DB 시계는 그대로)
  await soft('평가 뒤 현재 순위 다시 받기', async () => {
    const p = await ctx.newPage();
    const mid = '11111111-1111-4111-8111-111111111111', mealId = '44444444-4444-4444-8444-444444444444';
    const row = { id: mealId, member_id: mid, eaten_on: '2026-11-16', eaten_at: '12:00:00', meal_type: '점심', food: '순위 갱신 식사', note: '', photo_path: null, created_at: '2026-11-16T03:00:00Z', reviewed_at: null, member_seen_at: null, note_updated_at: null, member_msg_at: null, trainer_msg_at: null, rating: 3, rated_at: '2026-11-16T03:00:00Z', shared_at: null, comments: [], member: { nickname: '순위 회원' } };
    const st = { calls: 0, rates: 0, fail: false };
    await p.route('**/src/lib/dates.ts*', async (r) => {
      const body = (await (await r.fetch()).text()).replace('export const todayKey = () => dateKey(new Date());', "export const todayKey = () => '2026-11-16';");
      if (!body.includes("'2026-11-16'")) throw new Error('todayKey 바꾸기 실패');
      return r.fulfill({ status: 200, contentType: 'application/javascript', body });
    });
    await p.route('**/rest/v1/**', async (r) => {
      const u = new URL(r.request().url()), path = u.pathname;
      if (path.endsWith('/assignments')) return fulfill(r, [{ member_id: mid, member: { nickname: '순위 회원' } }]);
      if (path.endsWith('/profiles')) return fulfill(r, [{ id: mid, share_consent: true }]);
      if (path.endsWith('/meals')) return fulfill(r, u.searchParams.has('id') ? row : [row]);
      if (path.endsWith('/rpc/my_activity')) return fulfill(r, [{ key: 'recorded:' + mealId, kind: 'recorded', at: '2026-11-16T03:00:00Z', meal_id: mealId, eaten_on: '2026-11-16', meal_type: '점심', actor: '순위 회원', handled: false }]);
      if (path.endsWith('/rpc/award_standings')) {
        st.calls++;
        if (st.fail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
        return fulfill(r, { month: '2026-11-01', started: true, starts: '2026-11-01', workout_started: false, workout_starts: '2026-12-01', rows: [{ kind: 'rating', rank: 1, nickname: '순위 회원', score: row.rating === 1 ? 1.4 : 1, is_me: false }] });
      }
      if (path.endsWith('/rpc/rate_meal')) { st.rates++; row.rating = r.request().postDataJSON().p_rating; row.reviewed_at = '2026-11-16T04:00:00Z'; return fulfill(r, null); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=trainer`);
    await p.waitForLoadState('networkidle');
    await p.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
    const card = p.getByTestId('standing-rating');
    await card.getByText('순위 회원').waitFor({ timeout: 10000 });
    const before = st.calls;
    await p.getByRole('button', { name: /알림 목록/ }).click();
    await p.locator('.activity-list button').first().click();
    await p.getByRole('group', { name: '식단 평가' }).getByRole('button', { name: '아주 좋아요', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('[aria-label="식단 평가"] button[aria-pressed="true"]')?.textContent === '아주 좋아요');
    await p.getByRole('button', { name: '창 닫기' }).click();
    for (let i = 0; i < 50 && st.calls <= before; i++) await p.waitForTimeout(100);
    check('평가 저장 뒤 현재 순위를 다시 받음(앱 복귀·탭 이동 없이)', st.rates === 1 && st.calls > before, JSON.stringify({ ...st, before }));
    st.fail = true;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.getByTestId('award-standings').getByText('최신 순위를 불러오지 못했어요', { exact: false }).waitFor({ timeout: 5000 });
    check('다시 받기 실패: 마지막 순위는 그대로, 새로 받지 못함 안내', (await card.innerText()).includes('순위 회원'));
    st.fail = false;
    const n = st.calls;
    await p.getByTestId('award-standings').getByRole('button', { name: '다시 불러오기' }).click();
    await p.waitForFunction(() => !document.querySelector('[data-testid="award-standings"] .stale-notice'));
    check('다시 불러오기를 누르면 다시 받고 안내가 사라짐', st.calls === n + 1, JSON.stringify(st));
    await p.close();
  });

  // 18c) 형식이 어긋난 순위·수상·참여 현황 응답은 그대로 그리지 않고 '불러오지 못했어요'로(Codex 정식 1차 리뷰 품질 의견)
  await soft('어긋난 수상 응답', async () => {
    const p = await ctx.newPage();
    await p.route('**/rest/v1/rpc/my_award_progress*', (r) => fulfill(r, { meals: 'x', rated: 1, days: 1, best_streak: 1, workout_days: 1 }));
    await p.route('**/rest/v1/rpc/award_standings*', (r) => fulfill(r, { month: '2026-11-01', started: true, starts: '2026-11-01', workout_started: false, workout_starts: '2026-12-01', rows: [{ kind: 'bogus', rank: 1, nickname: '누구', score: 1, is_me: false }] }));
    await p.route('**/rest/v1/rpc/awards_for_me*', (r) => fulfill(r, { month: '2026-10-01', published: true, started: true, starts: '2026-10-01', winners: [{ kind: 'rating', nickname: '누구', score: 'NaN', is_me: false }] }));
    await p.route('**/rest/v1/rpc/award_months*', (r) => fulfill(r, [{ month: '2026-10-01' }]));
    await p.goto(`${BASE}?mode=awards&today=2026-11-16`);
    await p.getByTestId('award-standings').getByText('현재 순위를 불러오지 못했어요').waitFor({ timeout: 10000 });
    await p.goto(`${BASE}?mode=awards&today=2026-11-05`);
    await p.getByText('수상 결과를 불러오지 못했어요').first().waitFor({ timeout: 10000 });
    check('어긋난 순위·수상 응답은 실패로 보임(NaN·빈 칸을 그리지 않음)', (await p.getByText('NaN').count()) === 0);
    await p.close();
  });

  // 18d) 주소 복사: 복사 기능이 없는 환경(https가 아닌 주소 — navigator.clipboard 없음)과 권한 거절 모두 화면 오류 없이 수동 복사 안내로(Codex 정식 1차 리뷰 2)
  await soft('주소 복사 실패 안내', async () => {
    for (const how of ['없음', '거절']) {
      const c = await newCtx({ ...devices['iPhone 13'] });
      await c.addInitScript((h) => {
        if (h === '없음') Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        else Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }, configurable: true });
      }, how);
      const p = await c.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(`${BASE}?mode=guide`);
      // 2026-11-03: 시작 안내의 시트 쪽은 짧은 안내 + 연결 화면·그림 안내로 가는 버튼 — 주소 복사는 그림 안내(와 연결 화면)에서
      for (let i = 0; i < 6 && !(await p.getByRole('button', { name: '그림으로 연결 방법 보기', exact: true }).count()); i++) await p.getByRole('button', { name: '다음', exact: true }).click();
      await p.getByRole('button', { name: '그림으로 연결 방법 보기', exact: true }).click();
      await p.getByRole('button', { name: '이메일 복사', exact: true }).click();
      await p.getByText('복사하지 못했어요. 이메일을 길게 눌러 복사해 주세요.').waitFor({ timeout: 3000 });
      await p.goto(`${BASE}?mode=notiguide`);
      await p.getByRole('button', { name: /주소 복사/ }).first().click();
      await p.getByText('복사하지 못했어요.', { exact: false }).waitFor({ timeout: 3000 });
      check(`주소 복사(복사 기능 ${how}): 시작 안내·알림 안내 모두 수동 복사 안내, 화면 오류 없음`, errors.length === 0, errors.join(' | '));
      await c.close();
    }
  });

  // 19~21) v1.8 재리뷰: 실제 트레이너 화면·추천 식단(모든 서버 응답은 가로채 정함)
  const trainerPage = async (count = 2, init) => {
    const p = await ctx.newPage();
    if (init) await p.addInitScript(init);
    const ctrl = { members: Array.from({ length: count }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`, nickname: `검증 회원 ${i + 1}` })), removed: [], hold: null, loads: 0 };
    await p.route('**/rest/v1/**', async (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) {
        ctrl.loads++;
        const body = ctrl.members.map((m) => ({ member_id: m.id, member: { nickname: m.nickname } }));
        if (ctrl.hold) { const h = ctrl.hold; ctrl.hold = null; h.started(); await h.gate; }
        return fulfill(r, body);
      }
      if (path.endsWith('/profiles')) return fulfill(r, ctrl.members.map((m) => ({ id: m.id, share_consent: true })));
      if (path.endsWith('/rpc/remove_member')) { const id = r.request().postDataJSON().p_member; ctrl.removed.push(id); ctrl.members = ctrl.members.filter((m) => m.id !== id); return fulfill(r, null); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=trainer`);
    await p.waitForLoadState('networkidle');
    await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
    await p.locator('.member-row').first().waitFor({ timeout: 10000 });
    return { p, ctrl };
  };

  // 19) A에서 내보내기를 한 번 누름 → B를 봤다가 A로 돌아옴 → 확인이 풀려 있어 한 번 눌러서는 안 나감(Codex v1.8.0 재리뷰 2)
  await soft('내보내기 확인 취소', async () => {
    const { p, ctrl } = await trainerPage();
    await p.locator('.member-row', { hasText: '검증 회원 1' }).click();
    await p.getByTestId('remove-member').click();
    await p.getByRole('button', { name: '담당 회원으로', exact: true }).click();
    await p.locator('.member-row', { hasText: '검증 회원 2' }).click();
    await p.getByRole('button', { name: '담당 회원으로', exact: true }).click();
    await p.locator('.member-row', { hasText: '검증 회원 1' }).click();
    const label = await p.getByTestId('remove-member').textContent();
    await p.getByTestId('remove-member').click();
    await p.waitForTimeout(500);
    check('다른 회원을 봤다가 돌아오면 내보내기 확인이 풀려 있음(한 번 눌러서는 안 나감)', label === '담당에서 내보내기' && ctrl.removed.length === 0, JSON.stringify({ label, removed: ctrl.removed.length }));
    await p.close();
  });

  // 20) 내보내기 전에 시작한 늦은 회원 조회가 내보낸 회원을 목록에 되살리지 않음(재리뷰 3)
  await soft('늦은 회원 조회', async () => {
    const { p, ctrl } = await trainerPage(1);
    await p.locator('.member-row').click();
    let release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    ctrl.hold = { gate, started };
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await start;
    await p.getByTestId('remove-member').click();
    const fresh = p.waitForResponse((r) => r.url().includes('/rest/v1/assignments'));
    await p.getByTestId('remove-member').click();
    await fresh;
    await p.waitForTimeout(300);
    release();
    await p.waitForTimeout(800);
    const rows = await p.locator('.member-row').count();
    check('늦게 끝난 옛 회원 조회가 내보낸 회원을 다시 보이지 않음', ctrl.members.length === 0 && rows === 0, JSON.stringify({ server: ctrl.members.length, rows }));
    await p.close();
  });

  // 21) 추천 식단 사진이 한 번 실패 → 서버 회복 → 앱 복귀에 같은 사진을 다시 받음(재리뷰 4)
  await soft('공유 사진 다시 받기', async () => {
    const p = await ctx.newPage();
    let downloads = 0;
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    await p.route('**/rest/v1/rpc/shared_meals*', (r) => fulfill(r, [{ id: '33333333-3333-4333-8333-333333333333', eaten_on: '2026-10-29', meal_type: '점심', food: '검증 공유 식단', rating: 1, photo_path: 'owner/photo.jpg', shared_at: '2026-10-29T01:00:00Z', mine: false }]));
    await p.route('**/functions/v1/meal-photo*', (r) => { downloads++; return downloads === 1 ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' }) : r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg }); });
    await p.goto(`${BASE}?mode=shared`);
    await p.locator('.shared-item').waitFor({ timeout: 10000 });
    await p.waitForTimeout(800);
    const first = await p.locator('.shared-item img').count();
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.locator('.shared-item img').waitFor({ timeout: 5000 });
    check('사진 받기가 한 번 실패해도 앱 복귀 때 같은 사진을 다시 받아 보임', first === 0 && downloads === 2, JSON.stringify({ first, downloads }));
    await p.close();
  });

  // 22) 남의 사진 임시 주소(blob:) 수명(Codex v1.8.0 3차 리뷰 1): 함께 쓰는 동안 유지 · 바꾼 사진·닫은 화면은 해제 · 쉬는 사진 상한 · 계정 전환 · 늦은 응답
  await soft('사진 임시 주소 수명', async () => {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      const live = new Set(); window.__blob = { live, made: 0, freed: 0 };
      const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (b) => { const u = mk(b); live.add(u); window.__blob.made++; return u; };
      URL.revokeObjectURL = (u) => { if (live.delete(u)) window.__blob.freed++; rv(u); };
    });
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    let hold = null;
    await p.route('**/functions/v1/meal-photo*', async (r) => { if (hold) { const h = hold; hold = null; h.started(); await h.gate; } return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg }); });
    await p.goto(`${BASE}?mode=photos`);
    await p.waitForLoadState('networkidle');
    const blob = () => p.evaluate(() => ({ made: window.__blob.made, freed: window.__blob.freed, live: window.__blob.live.size, imgs: document.querySelectorAll('.meal-image img').length }));
    const click = async (name) => { await p.getByRole('button', { name, exact: true }).click(); await p.waitForTimeout(400); };
    await click('같은 사진 둘');
    await p.locator('.meal-image img').nth(1).waitFor({ timeout: 5000 });
    await click('하나만');
    const one = await blob();
    check('같은 사진을 쓰던 화면 하나를 닫아도 남은 화면의 사진은 그대로', one.made === 1 && one.freed === 0 && one.imgs === 1, JSON.stringify(one));
    await click('사진 바꾸기');
    await p.locator('.meal-image img').waitFor({ timeout: 5000 });
    const swapped = await blob();
    check('사진을 바꾸면 옛 사진 주소를 해제', swapped.made === 2 && swapped.freed === 1 && swapped.live === 1, JSON.stringify(swapped));
    await click('다른 사진 50장');
    await p.waitForFunction(() => document.querySelectorAll('.meal-image img').length >= 50, null, { timeout: 15000 });
    await click('모두 닫기');
    const closed = await blob();
    check('화면을 모두 닫으면 쉬는 사진은 상한(40장)까지만 남음', closed.imgs === 0 && closed.live <= 40 && closed.freed >= closed.made - 40, JSON.stringify(closed));
    // 진행 중 요청을 붙잡아 둔 채 계정 전환 → 늦게 도착한 응답은 캐시에 넣지 않고 해제
    let release, started; const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    hold = { gate, started };
    await click('사진 바꾸기'); // 이미 b.jpg라 그대로 — 새 요청을 만들려고 50장 중 하나가 아닌 새 화면을 연다
    await p.getByRole('button', { name: '하나만', exact: true }).click();
    await click('계정 전환');
    const cleared = await blob();
    await start.catch(() => {});
    release();
    await p.waitForTimeout(600);
    const late = await blob();
    check('계정을 바꾸면 받은 사진을 모두 해제', cleared.live === 0, JSON.stringify(cleared));
    check('계정 전환 뒤 늦게 도착한 사진은 남기지 않음', late.live === 0, JSON.stringify(late));
    await p.close();
  });

  // 23) 트레이너 확인 목록: 사진 첫 요청 실패 → 서버 회복 → 앱을 보고 있는 채로 1분 자동 갱신 → 사진이 보임(3차 리뷰 2)
  await soft('트레이너 목록 갱신 때 사진 다시 받기', async () => {
    const p = await ctx.newPage();
    await p.clock.install();
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const meal = { id: '55555555-5555-4555-8555-555555555555', member_id: '11111111-1111-4111-8111-000000000001', eaten_on: today, eaten_at: '12:00', meal_type: '점심', food: '사진 검증 식사', note: '', photo_path: '11111111-1111-4111-8111-000000000001/p.jpg', created_at: d.toISOString(), reviewed_at: null, member_seen_at: d.toISOString(), note_updated_at: d.toISOString(), member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: '검증 회원 1' } };
    let mealLoads = 0, photos = 0;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/meals')) { mealLoads++; return fulfill(r, [meal]); }
      return fulfill(r, []);
    });
    await p.route('**/functions/v1/meal-photo*', (r) => { photos++; return photos === 1 ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' }) : r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg }); });
    await p.goto(`${BASE}?mode=trainer`);
    await p.locator('.meal-card', { hasText: '사진 검증 식사' }).waitFor({ timeout: 10000 });
    await p.waitForFunction(() => true);
    for (let i = 0; i < 20 && photos < 1; i++) await p.waitForTimeout(100);
    const before = { mealLoads, photos };
    await p.clock.fastForward(61_000);
    await p.locator('.meal-card .meal-image img').waitFor({ timeout: 5000 });
    check('앱을 보고 있는 채로 목록이 자동 갱신되면 실패했던 사진만 다시 받아 보임', before.photos === 1 && mealLoads > before.mealLoads && photos === 2, JSON.stringify({ before, mealLoads, photos }));
    await p.close();
  });

  // 24) 회원 정보 조회 실패는 숨기지 않음: 마지막 목록은 두고 안내·다시 불러오기(3차 리뷰 후속 개선)
  await soft('회원 정보 조회 실패 안내', async () => {
    const { p, ctrl } = await trainerPage(1);
    await p.unroute('**/rest/v1/**');
    let down = true;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      // 500(supabase-js는 503을 스스로 다시 시도한다)
      if (path.endsWith('/assignments')) return down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }) : fulfill(r, ctrl.members.map((m) => ({ member_id: m.id, member: { nickname: m.nickname } })));
      return fulfill(r, []);
    });
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.getByText('회원 목록을 새로 불러오지 못했어요').waitFor({ timeout: 5000 });
    const kept = await p.locator('.member-row').count();
    down = false;
    await p.getByRole('button', { name: '다시 불러오기' }).click();
    await p.getByText('회원 목록을 새로 불러오지 못했어요').waitFor({ state: 'detached', timeout: 5000 });
    check('회원 목록 갱신이 실패하면 마지막 목록은 두고 안내, 다시 불러오면 사라짐', kept === 1, `${kept}명`);
    await p.close();
  });

  // 25) v2.0 시트 자동 반영: A에서 '다시 읽기'를 누르고 응답 전에 다른 회원으로 옮김 → 늦게 온 A의 실패 안내가 지금 화면에 뜨지 않음(Codex v2.0.0 1차 리뷰 2를 자동 반영으로 옮김)
  // 화면을 열 때의 자동 읽기(force 아님)는 바로 'fresh'로 답하고, 직접 누른 다시 읽기(force)만 붙잡아 둔다
  await soft('늦은 시트 다시 읽기', async () => {
    const run = async (moves, bSheet = true) => {
      const p = await ctx.newPage();
      const members = [{ id: '11111111-1111-4111-8111-00000000000a', nickname: '검증 A' }, { id: '11111111-1111-4111-8111-00000000000b', nickname: '검증 B' }];
      const calls = [];
      let release, started;
      const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/assignments')) return fulfill(r, members.map((m) => ({ member_id: m.id, member: { nickname: m.nickname } })));
        if (path.endsWith('/profiles')) return fulfill(r, members.map((m) => ({ id: m.id, share_consent: true })));
        if (path.endsWith('/routine_sources')) return fulfill(r, !bSheet && r.request().url().includes('00000000000b') ? null : { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-10-30T00:00:00Z', last_error: '' });
        return fulfill(r, []);
      });
      await p.route('**/functions/v1/sheet-import*', async (r) => {
        const body = r.request().postDataJSON();
        calls.push(body);
        if (!body.force) return fulfill(r, { status: 'fresh', version: null });
        started();
        await gate;
        return r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"failed"}' });
      });
      await p.goto(`${BASE}?mode=trainer`);
      await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
      const open = async (name) => { await p.locator('.member-row', { hasText: name }).click(); await p.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '루틴', exact: true }).click(); };
      await open('검증 A');
      await p.getByTestId('sync-sheet').click({ timeout: 10000 });
      await start;
      for (const name of moves) { await p.getByRole('button', { name: '담당 회원으로', exact: true }).click(); await open(name); }
      await p.getByTestId('edit-routine').waitFor({ timeout: 10000 });
      release();
      await p.waitForTimeout(1000);
      const r = { toasts: await p.locator('.toast.visible', { hasText: '시트를 읽지 못했어요' }).count(), auto: calls.filter((c) => !c.force).map((c) => c.member.slice(-1)).join(''), busy: bSheet ? await p.getByTestId('sync-sheet').isDisabled() : null, linkText: await p.getByTestId('sheet-line').innerText() };
      await p.close();
      return r;
    };
    const ab = await run(['검증 B']);
    check('화면을 열면 그 회원 시트를 자동으로 읽어 봄(A·B 각각)', ab.auto === 'ab', JSON.stringify(ab));
    check('A에서 누른 다시 읽기가 B 화면에서 실패로 끝나도 안내를 띄우지 않고 B 버튼도 잠기지 않음', ab.toasts === 0 && !ab.busy, JSON.stringify(ab));
    const noB = await run(['검증 B'], false);
    check('시트가 없는 회원으로 옮기면 읽는 중 표시가 남지 않음(연결 안내)', noB.toasts === 0 && noB.auto === 'a' && !noB.linkText.includes('읽고 있어요') && noB.linkText.includes('연결'), JSON.stringify(noB));
    const aba = await run(['검증 B', '검증 A']);
    check('A → B → A로 돌아와도 이전 화면에서 시작한 실패는 버림', aba.toasts === 0 && !aba.busy, JSON.stringify(aba));
  });

  // 14) 그림 안내를 보며 휴대폰 설정에서 알림 차단을 풂 → 앱 복귀·안내에서 돌아오면 켜기 버튼(Codex v1.7 운영 배포 후 리뷰 1)
  const permStub = async (p, initial) => {
    await p.addInitScript((perm) => {
      window.__perm = perm;
      Object.defineProperty(Notification, 'permission', { get: () => window.__perm });
      Notification.requestPermission = async () => window.__perm;
    }, initial);
  };
  const prefsRoute = (p) => p.route('**/rest/v1/push_prefs*', (route) => fulfill(route, [{ digest: true, digest_times: '3', feedback: true, reminder: true, morning: true, updates: true }]));
  await soft('알림 권한 바뀜 동기화', async () => {
    const { p, go } = await open(ctx, 'prefs');
    await permStub(p, 'denied');
    await prefsRoute(p);
    await go();
    await p.getByText('휴대폰 설정 → 알림에서 FITORY(예전에 추가했다면 식단노트)를 허용해 주세요', { exact: false }).waitFor({ timeout: 10000 });
    await p.getByRole('button', { name: '알림 설정 방법 보기' }).click();
    await p.evaluate(() => { window.__perm = 'default'; document.dispatchEvent(new Event('visibilitychange')); }); // 휴대폰 설정에서 차단을 풀고 돌아옴
    await p.getByRole('button', { name: '알림 설정으로 돌아가기' }).first().click();
    await p.waitForTimeout(800);
    check('안내를 보며 차단을 풀고 돌아오면 이 기기 켜기 버튼이 보임', (await p.getByRole('button', { name: '이 기기에서 알림 받기' }).count()) === 1);
    await p.evaluate(() => { window.__perm = 'denied'; document.dispatchEvent(new Event('visibilitychange')); }); // 반대로 다시 차단
    await p.waitForTimeout(800);
    check('앱 밖에서 다시 차단하고 돌아오면 허용하라는 안내로 바뀜', (await p.getByText('휴대폰 설정 → 알림에서 FITORY(예전에 추가했다면 식단노트)를 허용해 주세요', { exact: false }).count()) === 1);
    await p.close();
  });

  // 12) 식사 목록: 확인 처리 뒤 그 식사를 다시 받았는데, 그 전에 시작된 전체 조회가 늦게 끝나 옛 값으로 되돌림(2026-10-27 화면 흐름 검증 간헐 실패)
  await soft('식사 목록 늦은 전체 조회', async () => {
    const { p, go } = await open(ctx, 'store');
    const MEAL = '44444444-4444-4444-8444-444444444444';
    const mealRow = (reviewed) => ({ id: MEAL, member_id: a, eaten_on: '2026-10-27', eaten_at: '12:00:00', meal_type: '점심', food: '샐러드', note: '질문 있어요', photo_path: null, created_at: '2026-10-27T03:00:00Z', reviewed_at: reviewed, member_seen_at: '2026-10-27T03:00:00Z', note_updated_at: '2026-10-27T03:00:00Z', member_msg_at: '2026-10-27T03:00:00Z', trainer_msg_at: null, rating: null, rated_at: null, comments: [], member: { nickname: '검증회원' } });
    let listCalls = 0, releaseOld, startedOld;
    const gateOld = new Promise((r) => (releaseOld = r)), startOld = new Promise((r) => (startedOld = r));
    await p.route('**/rest/v1/meals*', async (route) => {
      if (route.request().url().includes('id=eq.')) return fulfill(route, [mealRow('2026-10-27T04:00:00Z')]); // 하나 다시 받기: 확인됨
      const n = ++listCalls;
      if (n === 2) { startedOld(); await gateOld; } // 확인 전에 시작해 늦게 끝나는 전체 조회
      return fulfill(route, [mealRow(null)]);
    });
    await go();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).loaded, null, { timeout: 10000 });
    await p.getByRole('button', { name: '전체 다시 받기' }).click();
    await startOld;
    await p.getByRole('button', { name: '하나 다시 받기' }).click();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).reviewed !== null, null, { timeout: 10000 });
    releaseOld();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('늦게 끝난 전체 조회가 방금 확인한 식사를 옛 값으로 되돌리지 않음', st.reviewed === '2026-10-27T04:00:00Z', JSON.stringify(st));
    await p.close();
  });

  // 13～15) 식사 하나 다시 받기의 응답 순서(Codex v1.8.4 1차 리뷰): 어떤 조회가 먼저 끝나도 나중에 시작한 조회의 값이 남는다
  const storeCase = async (handler) => {
    const { p, go } = await open(ctx, 'store');
    const MEAL = '44444444-4444-4444-8444-444444444444';
    const row = (reviewed) => ({ id: MEAL, member_id: a, eaten_on: '2026-10-27', eaten_at: '12:00:00', meal_type: '점심', food: '샐러드', note: '질문 있어요', photo_path: null, created_at: '2026-10-27T03:00:00Z', reviewed_at: reviewed, member_seen_at: '2026-10-27T03:00:00Z', note_updated_at: '2026-10-27T03:00:00Z', member_msg_at: '2026-10-27T03:00:00Z', trainer_msg_at: null, rating: null, rated_at: null, comments: [], member: { nickname: '검증회원' } });
    const ctl = { single: 0, list: 0 };
    await p.route('**/rest/v1/meals*', (route) => handler(route, route.request().url().includes('id=eq.') ? ++ctl.single : (++ctl.list, 0), row, ctl));
    await go();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).loaded, null, { timeout: 10000 });
    return { p, ctl, waitReviewed: (v) => p.waitForFunction((x) => JSON.parse(document.querySelector('[data-testid=state]').textContent).reviewed === x, v, { timeout: 10000 }) };
  };
  await soft('식사 하나 다시 받기 두 번이 역순으로 끝남', async () => {
    let release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    const { p, waitReviewed } = await storeCase(async (route, single, row) => {
      if (!single) return fulfill(route, [row(null)]);
      if (single === 1) { started(); await gate; return fulfill(route, [row('2026-10-27T04:00:00Z')]); } // 먼저 시작한 옛 응답(늦게 도착)
      return fulfill(route, [row('2026-10-27T05:00:00Z')]); // 나중에 시작한 새 응답
    });
    await p.getByRole('button', { name: '하나 다시 받기' }).click();
    await start;
    await p.getByRole('button', { name: '하나 다시 받기' }).click();
    await waitReviewed('2026-10-27T05:00:00Z');
    release();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('먼저 시작한 식사 조회가 늦게 끝나도 나중 조회의 값을 덮지 않음', st.reviewed === '2026-10-27T05:00:00Z', JSON.stringify(st));
    await p.close();
  });
  await soft('식사 하나 다시 받기가 뒤에 시작한 전체 조회보다 늦게 끝남', async () => {
    let release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    const { p, waitReviewed } = await storeCase(async (route, single, row, ctl) => {
      if (single) { started(); await gate; return fulfill(route, [row('2026-10-27T04:00:00Z')]); }
      return fulfill(route, [row(ctl.list >= 2 ? '2026-10-27T05:00:00Z' : null)]);
    });
    await p.getByRole('button', { name: '하나 다시 받기' }).click();
    await start;
    await p.getByRole('button', { name: '전체 다시 받기' }).click();
    await waitReviewed('2026-10-27T05:00:00Z');
    release();
    await p.waitForTimeout(800);
    const st = await state(p);
    check('먼저 시작한 식사 조회가 늦게 끝나도 뒤에 시작한 전체 조회의 값을 덮지 않음', st.reviewed === '2026-10-27T05:00:00Z', JSON.stringify(st));
    await p.close();
  });
  // 16～18) 지워진 식사(Codex v1.8.4 2차 리뷰): 최신 조회에서 빠진 식사를 그 전에 시작한 옛 식사 조회가 되살리지 않는다 — 빈 목록·일부만·직접 지움
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const goneCase = async (label, after) => {
    let release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    let deleted = false;
    const { p } = await storeCase(async (route, single, row) => {
      if (single) { started(); await gate; return fulfill(route, [row('2026-10-27T04:00:00Z')]); } // 지우기 전에 받은 옛 응답
      const other = { ...row(null), id: OTHER, food: '다른 식사' };
      return fulfill(route, deleted ? (after === 'partial' ? [other] : []) : [row(null), other]);
    });
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).ids === '4444,5555', null, { timeout: 10000 });
    await p.getByRole('button', { name: '하나 다시 받기' }).click();
    await start;
    deleted = true; // 다른 기기에서 지움
    const want = after === 'partial' ? '5555' : after === 'local' ? '5555' : '';
    if (after === 'local') await p.getByRole('button', { name: '화면에서 지우기' }).click();
    else await p.getByRole('button', { name: '전체 다시 받기' }).click();
    await p.waitForFunction((w) => JSON.parse(document.querySelector('[data-testid=state]').textContent).ids === w, want, { timeout: 10000 });
    release();
    await p.waitForTimeout(800);
    const st = await state(p);
    check(label, st.ids === want, JSON.stringify(st));
    await p.close();
  };
  await soft('지운 식사(빈 목록)', () => goneCase('최신 전체 조회가 빈 목록이면, 그 전에 시작한 옛 식사 조회가 늦게 와도 지운 식사가 다시 나타나지 않음', 'empty'));
  await soft('지운 식사(일부)', () => goneCase('최신 전체 조회에서 그 식사만 빠져도 옛 식사 조회가 되살리지 않음(남은 식사는 그대로)', 'partial'));
  await soft('직접 지운 식사', () => goneCase('이 화면에서 직접 지운 식사도 옛 식사 조회가 되살리지 않음', 'local'));
  // 19～21) 아직 목록에 없던 식사를 처음 받는 조회(알림에서 열기, Codex v1.8.4 3차 리뷰): 응답이 늦는 사이 그 뒤에 시작한 전체 조회가 그 식사 없이 끝나면
  // 한 번 더 받아 확정한다 — 지워졌으면 없음(상세를 열지 않음), 전체 조회 범위 밖이라 빠졌을 뿐이면 그대로 보임
  const firstOpenCase = async (label, { deleted, inFull }) => {
    let release, started;
    const gate = new Promise((r) => (release = r)), start = new Promise((r) => (started = r));
    let afterReload = false;
    const { p } = await storeCase(async (route, single, row) => {
      const other = { ...row(null), id: OTHER, food: '다른 식사' };
      if (single === 1) { started(); await gate; return fulfill(route, [row(null)]); } // 지우기 전에 받은 첫 응답(늦게 도착)
      if (single) return fulfill(route, deleted ? [] : [row(null)]); // 다시 받아 확정
      return fulfill(route, afterReload && inFull ? [row(null), other] : [other]); // 처음 목록에는 이 식사가 없다
    });
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).ids === '5555', null, { timeout: 10000 });
    await p.getByRole('button', { name: '알림에서 열기' }).click();
    await start;
    afterReload = true;
    await p.getByRole('button', { name: '전체 다시 받기' }).click();
    await p.waitForTimeout(500);
    release();
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).opened !== '', null, { timeout: 10000 });
    await p.waitForTimeout(300);
    const st = await state(p);
    const want = deleted ? { ids: '5555', opened: 'none' } : { ids: '4444,5555', opened: 'shown' };
    check(label, st.ids === want.ids && st.opened === want.opened, JSON.stringify(st));
    await p.close();
  };
  await soft('처음 여는 식사가 그사이 지워짐', () => firstOpenCase('알림에서 처음 연 식사가 응답 전에 지워지면, 늦게 온 옛 응답으로 카드·상세가 생기지 않음(없음으로 돌려줌)', { deleted: true, inFull: false }));
  await soft('처음 여는 식사가 범위 밖', () => firstOpenCase('뒤의 전체 조회에 없지만 실제로는 있는 식사(조회 범위 밖)는 다시 받아 그대로 보임', { deleted: false, inFull: false }));
  await soft('처음 여는 식사가 전체 조회에 있음', () => firstOpenCase('뒤의 전체 조회에도 있는 식사는 그대로 보임', { deleted: false, inFull: true }));
  // 22) 재확인 한도(Codex v1.8.4 4차 리뷰): 첫 조회와 재확인 두 번이 모두 전체 조회와 겹치고 마지막 응답 전에 지워짐 →
  // 한도에 닿아도 확인 못 한 옛 응답을 쓰거나 돌려주지 않는다(지금 화면에 없으니 '확인 못 함' — 알림 진입은 '볼 수 없어요')
  await soft('재확인 한도', async () => {
    const releasers = [], starters = [];
    const gateP = [0, 1, 2].map(() => { let r; const pr = new Promise((x) => (r = x)); releasers.push(r); return pr; });
    const startP = [0, 1, 2].map(() => { let r; const pr = new Promise((x) => (r = x)); starters.push(r); return pr; });
    const { p } = await storeCase(async (route, single, row) => {
      const other = { ...row(null), id: OTHER, food: '다른 식사' };
      if (single >= 1 && single <= 3) { starters[single - 1](); await gateP[single - 1]; return fulfill(route, [row(null)]); } // 세 번 모두 지우기 전에 받은 응답
      if (single) return fulfill(route, []);
      return fulfill(route, [other]); // 전체 조회에는 이 식사가 없다(범위 밖이거나 지워짐)
    });
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).ids === '5555', null, { timeout: 10000 });
    await p.getByRole('button', { name: '알림에서 열기' }).click();
    for (let i = 0; i < 3; i++) {
      await startP[i];
      await p.getByRole('button', { name: '전체 다시 받기' }).click(); // 응답이 오기 전에 시작해 먼저 끝나는 전체 조회
      await p.waitForTimeout(400);
      releasers[i]();
    }
    await p.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=state]').textContent).opened !== '', null, { timeout: 10000 });
    await p.waitForTimeout(300);
    const s1 = await state(p);
    check('재확인 한도에 닿아도 확인 못 한 옛 응답으로 카드·상세가 생기지 않음', s1.ids === '5555' && s1.opened !== 'shown', JSON.stringify(s1));
    await p.close();
  });
  await soft('저장 뒤 다시 받기 재시도', async () => {
    const times = [];
    const t0 = Date.now();
    const { p, waitReviewed, ctl } = await storeCase(async (route, single, row) => {
      if (!single) return fulfill(route, [row(null)]);
      times.push(Date.now() - t0);
      if (single === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
      return fulfill(route, [row('2026-10-27T04:00:00Z')]);
    });
    await p.getByRole('button', { name: '저장 뒤 다시 받기' }).click();
    await waitReviewed('2026-10-27T04:00:00Z');
    const afterFirst = ctl.single;
    await p.waitForTimeout(9000); // 예전에는 10초 예약도 따로 걸려 있었다
    check('다시 받기 실패 뒤 재시도는 한 번에 하나(3초 뒤)·성공하면 다음 예약 없음', afterFirst === 2 && ctl.single === 2, JSON.stringify({ afterFirst, total: ctl.single, times }));
    await p.close();
  });

  // 26) v2.1 운동 기록(사용자 피드백 11-02): 쉬는 시간 표시·타이머, 기호 입력(일반 키보드 전환), 중량·횟수를 글자 그대로 저장
  await soft('쉬는 시간·기호 입력', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const item = (ord, name, weight, reps, sets, rest) => ({ id: `item-${ord}`, ord, day_no: 1, name, weight, reps, sets, rest, note: '' });
    const routine = { id: 'routine-1', member_id: a, version: 1, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'manual', source_ref: '', created_at: '2026-11-01T01:00:00Z',
      items: [item(1, '스쿼트', '60', '12', 2, '1.5'), item(2, '덤벨컬+해머컬', '10+8', '8+8', 1, '1'), item(3, '플랭크', '', '60초', 1, 'x')] };
    let sent = null;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [routine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/save_workout')) { sent = r.request().postDataJSON(); return fulfill(r, '2026-11-03T01:00:00Z'); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    const card = p.getByTestId('routine-day-1');
    await card.waitFor({ timeout: 15000 });
    const cardText = await card.innerText();
    check('루틴 카드에 쉬는 시간(분 단위 1.5 → 1분 30초), 쉬는 시간 없음(x)은 표시 안 함', cardText.includes('목표 60kg · 12회 · 쉬는 시간 1분 30초') && cardText.includes('쉬는 시간 1분') && !/플랭크\s*\n?.*쉬는 시간/.test(cardText.split('덤벨컬+해머컬')[1] ?? ''), cardText.replace(/\s+/g, ' '));
    await p.getByTestId('start-workout').click();
    await p.getByTestId('workout-form').waitFor();
    const mode = (label) => p.getByLabel(label).getAttribute('inputmode');
    const val = (label) => p.getByLabel(label).inputValue();
    const first = { sqKg: [await mode('스쿼트 1세트 중량'), await val('스쿼트 1세트 중량')], curl: [await mode('덤벨컬+해머컬 1세트 중량'), await val('덤벨컬+해머컬 1세트 중량'), await val('덤벨컬+해머컬 1세트 횟수')], plank: await val('플랭크 1세트 횟수') };
    check('목표를 글자 그대로 채움 · 숫자 목표는 숫자 키패드, 기호 목표(10+8·8+8)는 처음부터 일반 키보드', JSON.stringify(first) === JSON.stringify({ sqKg: ['decimal', '60'], curl: ['text', '10+8', '8+8'], plank: '60초' }), JSON.stringify(first));
    await p.getByRole('button', { name: '스쿼트 기호 입력' }).click();
    check('기호 버튼을 누르면 그 운동의 칸이 일반 키보드로 바뀜', (await mode('스쿼트 1세트 횟수')) === 'text' && (await mode('스쿼트 1세트 중량')) === 'text');
    await p.getByLabel('스쿼트 1세트 횟수').fill('10/10');
    // 2.3 쉬는 시간 끝 소리: 소리 장치를 흉내 내 언제 몇 번 울렸는지 센다(2.4.1부터 짧은 삐 네 번 × 세 묶음 — 사용자가 고른 소리)
    await p.evaluate(() => {
      window.__beeps = [];
      const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
      window.AudioContext = class { state = 'running'; currentTime = 0; destination = {}; resume() { return Promise.resolve(); } createGain() { return { gain: param(), connect() {} }; } createBiquadFilter() { return { type: '', frequency: param(), connect() {} }; } createOscillator() { return { frequency: param(), type: '', connect() {}, start(at) { window.__beeps.push(at); }, stop() {} }; } };
    });
    const timer = p.getByTestId('rest-timer');
    await p.getByLabel('스쿼트 1세트 완료').check();
    await timer.filter({ hasText: '쉬는 시간 1:30' }).waitFor({ timeout: 3000 });
    // 사용자 제보(11-03, 아이폰): 카드가 기록 창 아래 끝(bottom:0)에 붙어 아랫부분이 잘리고 남은 시간 막대만 형광색 줄로 비쳤다 —
    // 카드 전체가 창 아래 끝보다 위에 있고(홈 표시줄 높이·최소 12px 띄움), 막대는 카드 안의 바탕 줄 위에 있다
    {
      const card = await timer.boundingBox(), sheet = await p.locator('dialog[open]').boundingBox();
      const bar = await timer.locator('.rest-timer-track').boundingBox();
      check('쉬는 시간 카드는 기록 창 아래 끝에서 띄워 다 보이고, 남은 시간 막대는 카드 안 바탕 줄에', !!card && !!sheet && !!bar && card.y + card.height <= sheet.y + sheet.height - 10 && bar.y + bar.height <= card.y + card.height - 2 && bar.x > card.x,
        JSON.stringify({ cardBottom: card && card.y + card.height, sheetBottom: sheet && sheet.y + sheet.height, barBottom: bar && bar.y + bar.height }));
    }
    await p.clock.fastForward(60_000);
    const mid = await timer.innerText();
    // 화면을 끈 채 시간이 지난 것처럼: 남은 시간은 끝나는 시각으로 다시 계산된다
    await p.clock.fastForward(31_000);
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const end = await timer.innerText();
    await p.clock.fastForward(5_500);
    const gone = await timer.count();
    check('세트 완료 → 쉬는 시간 1:30부터 줄고, 시간이 지나면 끝 표시 뒤 닫힘', /쉬는 시간 0:30/.test(mid) && /쉬는 시간 끝/.test(end) && gone === 0, JSON.stringify({ mid, end, gone }));
    {
      const at = await p.evaluate(() => window.__beeps);
      const groups = at.reduce((g, t, i) => g + (i === 0 || t - at[i - 1] > 0.2 ? 1 : 0), 0);
      check('2.3 쉬는 시간이 끝나면 소리가 세 묶음(2.4.1 짧은 삐 네 번씩 · 그 뒤 더 울리지 않음)', at.length === 12 && groups === 3, JSON.stringify(at));
    }
    await p.getByLabel('덤벨컬+해머컬 1세트 완료').check();
    await timer.filter({ hasText: '쉬는 시간 1:00' }).waitFor({ timeout: 3000 });
    await timer.getByRole('button', { name: '+30초' }).click();
    await p.clock.fastForward(1_000);
    const plus = await timer.innerText();
    await timer.getByRole('button', { name: '건너뛰기' }).click();
    await p.getByLabel('플랭크 1세트 완료').check();
    await p.clock.fastForward(1_000);
    check('+30초는 늘리고 건너뛰기는 닫음 · 쉬는 시간 없는 운동(x)은 타이머 없음', /쉬는 시간 1:29/.test(plus) && (await timer.count()) === 0, plus);
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.locator('.toast.visible', { hasText: '운동 기록을 저장했어요' }).waitFor({ timeout: 5000 });
    const sets = (sent?.p_sets ?? []).map((x) => [x.name, x.set_no, x.kg, x.reps, x.done]);
    check('중량·횟수를 적은 글자 그대로 보냄(10/10 · 10+8 · 8+8 · 60초)', JSON.stringify(sets) === JSON.stringify([['스쿼트', 1, '60', '10/10', true], ['스쿼트', 2, '60', '12', false], ['덤벨컬+해머컬', 1, '10+8', '8+8', true], ['플랭크', 1, null, '60초', true]]), JSON.stringify(sets));
    await p.close();
  });

  // 27) v2.1 유산소(사용자 피드백 11-02): '유산소만' 고르기, 시간 필수·거리/속도는 필요에 따라, 기록 목록·변화 카드 표시
  await soft('유산소 기록', async () => {
    const p = await ctx.newPage();
    const item = (ord, day_no, name) => ({ id: `item-${ord}`, ord, day_no, name, weight: '20', reps: '12', sets: 3, rest: '1', note: '' });
    const routine = { id: 'routine-2', member_id: a, version: 1, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'manual', source_ref: '', created_at: '2026-11-01T01:00:00Z', items: [item(1, 1, '스쿼트'), item(2, 2, '랫풀다운')] };
    const walkSession = { id: 'session-walk', member_id: a, routine_id: null, day_no: null, day: '2026-11-01', started_at: '2026-11-01T01:00:00Z', updated_at: '2026-11-01T01:00:00Z', finished: true, sets: [], cardio: [{ kind: 'walk', minutes: '40.0', km: '3.20', speed: null, ord: 1 }] };
    let sent = null;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [routine]);
      if (path.endsWith('/workout_sessions')) return fulfill(r, [walkSession]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/save_workout')) { sent = r.request().postDataJSON(); return fulfill(r, '2026-11-03T01:00:00Z'); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    const row = p.locator('.workout-row').first();
    await row.waitFor({ timeout: 15000 });
    const rowText = (await row.innerText()).replace(/\s+/g, ' ');
    check('기록 목록: 유산소만 한 기록은 부위 대신 유산소, 종류·시간·거리 한 줄(걷기 40분 · 3.2km, 같은 시간을 두 번 쓰지 않음)', rowText.includes('유산소') && rowText.includes('걷기 40분 · 3.2km') && rowText.split('40분').length === 2, rowText);
    await p.getByTestId('start-workout').click();
    await p.getByRole('button', { name: '유산소만' }).click();
    check('유산소만: 근력 세트 없이 유산소 칸 하나', (await p.locator('.set-row').count()) === 0 && (await p.getByLabel('유산소 1 종류').inputValue()) === 'run');
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.locator('.toast.visible', { hasText: '러닝 시간을 1～600분 사이로' }).waitFor({ timeout: 5000 });
    check('시간을 안 적으면 저장 전에 알림(서버에 안 보냄)', sent === null);
    await p.getByLabel('유산소 1 시간(분)').fill('30');
    await p.getByLabel('유산소 1 거리(km)').fill('5');
    await p.getByRole('button', { name: '유산소 추가' }).click();
    await p.getByLabel('유산소 2 종류').selectOption('cycle');
    await p.getByLabel('유산소 2 시간(분)').fill('20');
    await p.getByLabel('유산소 2 속도(km/h)').fill('24.5');
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.locator('.toast.visible', { hasText: '유산소 2개' }).waitFor({ timeout: 5000 });
    const body = { routine: sent?.p_routine, dayNo: sent?.p_day_no, sets: sent?.p_sets, finished: sent?.p_finished, cardio: sent?.p_cardio };
    check('유산소만 저장: 루틴 없이, 거리만·속도만 적은 것 그대로, 완료로', JSON.stringify(body) === JSON.stringify({ routine: null, dayNo: null, sets: [], finished: true, cardio: [{ kind: 'run', minutes: 30, km: 5, speed: null }, { kind: 'cycle', minutes: 20, km: null, speed: 24.5 }] }), JSON.stringify(body));
    await p.close();
    // 변화 카드: 유산소 합계 한 줄(거리는 적은 것만)
    const q = await ctx.newPage();
    const rec = (id, day, w) => ({ id, member_id: a, measured_on: day, weight_kg: w, smm_kg: 30, pbf_pct: 22, source: 'manual', created_at: `${day}T01:00:00Z` });
    await q.route('**/rest/v1/inbody_records*', (route) => fulfill(route, [rec('c2', '2026-10-22', 71.7), rec('c1', '2026-09-15', 73.9)]));
    await q.route('**/rest/v1/rpc/diet_report*', (route) => fulfill(route, { days: 37, logged_days: 20, meals: 30, rated: 25, great: 10, good: 10, care: 5, score: 3.4 }));
    await q.route('**/rest/v1/rpc/workout_summary*', (route) => fulfill(route, { days: 3, done_sets: 7, cardio_count: 2, cardio_minutes: '50.0', cardio_km: '5.00' }));
    await q.goto(`${BASE}?mode=inbodyLive`);
    const cardioLine = q.getByTestId('live-reports').getByTestId('report-cardio');
    await cardioLine.waitFor({ timeout: 15000 });
    check('변화 카드에 유산소 합계 한 줄(유산소 2회 · 50분 · 5km)', (await cardioLine.innerText()).trim() === '유산소 2회 · 50분 · 5km', await cardioLine.innerText());
    await q.close();
  });

  // 28) 적대 검토(2026-11-02) 화면 재현: 오늘 시트 기록만 있으면 새 운동 시작 · '유산소만'에서 루틴으로 돌아오면 빈 유산소 칸 없음 · 시트 쓰기 20초 넘김은 '아직 모름'으로
  await soft('시트 기록·유산소 전환·시트 쓰기 지연', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const item = (ord, day_no, name) => ({ id: `item-${ord}`, ord, day_no, name, weight: '20', reps: '12', sets: 1, rest: '', note: '' });
    const routine = { id: 'routine-3', member_id: a, version: 1, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'sheet', source_ref: '2611', created_at: '2026-11-01T01:00:00Z', items: [item(1, 1, '스쿼트'), item(2, 2, '랫풀다운')] };
    const sheetToday = { id: 'session-sheet', member_id: a, routine_id: 'routine-3', day_no: 1, day: '2026-11-03', started_at: '2026-11-03T01:00:00Z', updated_at: '2026-11-03T01:00:00Z', finished: true, source: 'sheet', sheet_tab: '2611', sheet_col: 4, sets: [{ item_id: null, name: '스쿼트', set_no: 1, kg: '60', reps: '12', done: true, ord: 1 }], cardio: [] };
    let sent = null, writeCalls = 0;
    await p.route('**/functions/v1/sheet-write*', () => { writeCalls++; /* 응답하지 않음(서버 쓰기가 오래 걸림) */ });
    await p.route('**/functions/v1/sheet-import*', (r) => fulfill(r, { status: 'fresh', version: null }));
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [routine]);
      if (path.endsWith('/workout_sessions')) return fulfill(r, [sheetToday]);
      if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/save_workout')) { sent = r.request().postDataJSON(); return fulfill(r, '2026-11-03T01:10:00Z'); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    const start = p.getByTestId('start-workout');
    await start.waitFor({ timeout: 15000 });
    check('오늘 시트 기록만 있으면 이어서가 아니라 새 운동 시작', (await start.innerText()).includes('운동 시작') && !(await start.innerText()).includes('이어서'), await start.innerText());
    await start.click();
    const pick = p.getByRole('group', { name: '오늘 할 루틴' });
    await pick.getByRole('button', { name: '유산소만' }).click();
    await pick.getByRole('button', { name: /루틴 1/ }).click();
    check("'유산소만'에서 루틴으로 돌아오면 빈 유산소 칸이 남지 않음", (await p.locator('.cardio-row').count()) === 0);
    await p.getByLabel('스쿼트 1세트 완료').check();
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.getByText('시트에도 적는 중이에요').waitFor({ timeout: 5000 });
    await p.clock.fastForward(21_000);
    const fail = p.getByTestId('sheet-fail');
    await fail.waitFor({ timeout: 5000 });
    check('시트 쓰기가 20초를 넘기면 못 썼다고 단정하지 않고 시트를 먼저 확인하라고 안내', (await fail.innerText()).includes('결과를 아직 확인하지 못했어요') && sent?.p_sets?.length === 1 && writeCalls === 1, (await fail.innerText()).slice(0, 80));
    await p.close();
  });

  // 29) Codex v2.1 1차 리뷰 P2 화면 재현: 자동 반영이 same이어도 다시 받음 · 옛 판 기록도 시트에 씀 · 가져올 것 0개여도 지울 것이 있으면 맞추기
  await soft('자동 반영 same·옛 판 기록·0개 맞추기', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const item = (w) => ({ id: 'item-s', ord: 1, day_no: 1, name: '스쿼트', weight: w, reps: '12', sets: 1, rest: '', note: '' });
    const routineOf = (w) => ({ id: 'routine-now', member_id: a, version: 5, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'sheet', source_ref: '2611', created_at: '2026-11-01T01:00:00Z', items: [item(w)] });
    // 옛 판(지금·직전 판 밖)의 앱 기록 — 시트에 이미 쓴 기록
    const oldSession = { id: 'session-old', member_id: a, routine_id: 'routine-old', day_no: 1, day: '2026-10-31', started_at: '2026-10-31T01:00:00Z', updated_at: '2026-10-31T01:00:00Z', finished: true, source: 'app', sheet_tab: '2609', sheet_col: 5, sets: [{ item_id: null, name: '런지', set_no: 1, kg: '40', reps: '12', done: true, ord: 1 }], cardio: [] };
    const ctl = { routines: 0, sessions: 0, writes: 0, imports: [] };
    await p.route('**/functions/v1/sheet-write*', (r) => { ctl.writes++; return fulfill(r, { status: 'written', tab: '2609', col: 'F', skipped: [], kept: [] }); });
    await p.route('**/functions/v1/sheet-import*', (r) => {
      const b = r.request().postDataJSON();
      // 저장 응답의 removed(2)는 미리보기의 removes(1)와 다르다 — 그사이 시트가 바뀐 경우. 안내는 저장 때 실제로 지운 수로(Codex v2.1 2차 리뷰)
      if (b.mode === 'records_all') { ctl.imports.push(b.preview ? 'preview' : 'save'); return fulfill(r, b.preview ? { status: 'preview', removes: 1, tabs: [{ tab: '2610', sessions: 0, skipped: 0, problems: [] }] } : { status: 'imported', saved: 0, skipped: 0, removed: 2, problems: [] }); }
      return fulfill(r, { status: 'same', version: null, tab: '2611', problems: [] });
    });
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) { ctl.routines++; return fulfill(r, r.request().url().includes('routine-old') ? null : [routineOf(ctl.routines > 1 ? '45' : '40')]); }
      if (path.endsWith('/workout_sessions')) { ctl.sessions++; return fulfill(r, ctl.sessions > 1 ? [oldSession] : []); }
      if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: null, last_error: '' });
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/save_workout')) return fulfill(r, '2026-11-03T01:10:00Z');
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    const card = p.getByTestId('routine-day-1');
    await card.filter({ hasText: '목표 45kg' }).waitFor({ timeout: 15000 }).catch(() => {});
    const cardText = (await card.innerText()).replace(/\s+/g, ' ');
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await p.locator('.workout-row', { hasText: '런지' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('자동 반영이 same이어도 다시 받아 바뀐 중량·가져온 기록이 보임', cardText.includes('목표 45kg') && (await p.locator('.workout-row', { hasText: '런지' }).count()) === 1, JSON.stringify({ routines: ctl.routines, sessions: ctl.sessions, card: cardText.slice(0, 60) }));
    await p.locator('.workout-row', { hasText: '런지' }).click();
    await p.getByLabel('런지 1세트 중량').fill('45');
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.locator('.toast.visible', { hasText: '시트 2609 탭 F열' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('지금·직전 판보다 오래된 판의 기록도 고치면 시트에 씀', ctl.writes === 1 && (await p.locator('.toast.visible', { hasText: '시트 2609 탭 F열' }).count()) === 1, JSON.stringify(ctl));
    await p.locator('.toast.visible').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
    await p.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
    const box = p.getByTestId('sheet-records');
    await box.waitFor({ timeout: 5000 });
    const sync = box.getByRole('button', { name: '시트와 맞추기' });
    const enabled = await sync.isEnabled();
    await sync.click();
    await p.locator('.toast.visible', { hasText: '시트와 맞췄어요' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('가져올 회차가 0개여도 시트에서 없어진 기록이 있으면 맞추기를 할 수 있음 · 지운 수는 저장 때 실제로 지운 수(2회)', enabled && (await box.count()) === 0 && JSON.stringify(ctl.imports) === '["preview","save"]' && (await p.locator('.toast.visible', { hasText: '없어진 2회는 앱에서도 지웠어요' }).count()) === 1, JSON.stringify({ enabled, imports: ctl.imports }));
    await p.close();
  });

  // 30) Codex v2.1 2차 리뷰 화면 재현: 다른 기기의 시트 쓰기가 끝나지 않아 busy면 복사 길로 안내 · 월별 탭이 하나도 없는 시트도 맞추기를 할 수 있음
  await soft('시트 쓰기 busy·월별 탭 없음', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const routine = { id: 'routine-4', member_id: a, version: 1, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'sheet', source_ref: '2611', created_at: '2026-11-01T01:00:00Z', items: [{ id: 'item-1', ord: 1, day_no: 1, name: '스쿼트', weight: '20', reps: '12', sets: 1, rest: '', note: '' }] };
    const imports = [];
    let writeReply = { status: 'busy', tab: '2611' }, writeCalls = 0, sessions = [];
    await p.route('**/functions/v1/sheet-write*', (r) => { writeCalls++; return fulfill(r, writeReply); });
    await p.route('**/functions/v1/sheet-import*', (r) => {
      const b = r.request().postDataJSON();
      if (b.mode === 'records_all') { imports.push(b.preview ? 'preview' : 'save'); return fulfill(r, b.preview ? { status: 'preview', removes: 1, tabs: [] } : { status: 'imported', saved: 0, skipped: 0, removed: 1, problems: [] }); }
      return fulfill(r, { status: 'fresh', version: null });
    });
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [routine]);
      if (path.endsWith('/workout_sessions')) return fulfill(r, sessions);
      if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/save_workout')) return fulfill(r, '2026-11-03T01:10:00Z');
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await p.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
    const box = p.getByTestId('sheet-records');
    await box.waitFor({ timeout: 15000 });
    const note = await box.innerText();
    const sync = box.getByRole('button', { name: '시트와 맞추기' });
    const enabled = await sync.isEnabled();
    await sync.click();
    await p.locator('.toast.visible', { hasText: '없어진 1회는 앱에서도 지웠어요' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('월별 탭이 없는 시트: 탭이 없다고 알리고 맞추기로 가져온 기록을 정리', note.includes('연월로 시작하는 탭이 없어요') && note.includes('없어진 기록 1회') && enabled && JSON.stringify(imports) === '["preview","save"]' && (await p.locator('.toast.visible', { hasText: '없어진 1회는 앱에서도 지웠어요' }).count()) === 1, JSON.stringify({ note: note.replace(/\s+/g, ' '), enabled, imports }));
    await p.locator('.toast.visible').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
    await p.getByTestId('start-workout').click();
    await p.getByLabel('스쿼트 1세트 완료').check();
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    const fail = p.getByTestId('sheet-fail');
    await fail.waitFor({ timeout: 5000 });
    check('먼저 보낸 시트 쓰기가 끝나지 않아 busy면 기록은 저장했다고 하고 다시 저장·붙여 넣기로 안내(다른 기기라고 단정하지 않음)', (await fail.innerText()).includes('먼저 보낸 시트 쓰기가 아직 끝나지 않아') && (await fail.locator('textarea').inputValue()).startsWith('20'), (await fail.innerText()).slice(0, 120));
    // 서버가 보낸 쓰기의 결과를 모름(unknown): 시트를 먼저 확인하라고 안내 — 같은 창에서 다시 저장(새 기록 창이라 받아 둔 기록이 없음)
    writeReply = { status: 'unknown', tab: '2611' };
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.getByTestId('sheet-fail').filter({ hasText: '결과를 아직 확인하지 못했어요' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('보낸 쓰기의 결과를 모르면(unknown) 이미 적혔을 수 있으니 시트를 먼저 확인하라고 안내 · 같은 창에서 다시 저장해도 시트 쓰기를 부름', (await p.getByTestId('sheet-fail').filter({ hasText: '결과를 아직 확인하지 못했어요' }).count()) === 1 && writeCalls === 2, JSON.stringify({ writeCalls, text: (await p.getByTestId('sheet-fail').innerText().catch(() => '')).slice(0, 120) }));
    await p.close();
  });

  // 31) 적대 검토(2026-11-03) F5: 이미 저장한 기록의 완료를 모두 끄고 다시 저장하면, 화면에 받아 둔 '시트에 쓴 자리'가 없어도 시트 쓰기를 부른다
  //     (결과를 모른 채 끝난 쓰기는 자리가 늦게 적힌다 — 부르지 않으면 시트에 남은 앱 값을 비우지 못했다)
  await soft('완료를 모두 끈 기록도 시트 쓰기', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const routine = { id: 'routine-5', member_id: a, version: 1, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'sheet', source_ref: '2611', created_at: '2026-11-01T01:00:00Z', items: [{ id: 'item-1', ord: 1, day_no: 1, name: '스쿼트', weight: '20', reps: '12', sets: 1, rest: '', note: '' }] };
    const mine = { id: 'session-app', member_id: a, routine_id: 'routine-5', day_no: 1, day: '2026-11-03', started_at: '2026-11-03T01:00:00Z', updated_at: '2026-11-03T01:00:00Z', finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets: [{ item_id: 'item-1', name: '스쿼트', set_no: 1, kg: '40', reps: '12', done: true, ord: 1 }], cardio: [] };
    let writes = 0;
    await p.route('**/functions/v1/sheet-write*', (r) => { writes++; return fulfill(r, { status: 'nothing', tab: '2611', col: 'E', skipped: [], kept: [] }); });
    await p.route('**/functions/v1/sheet-import*', (r) => fulfill(r, { status: 'fresh', version: null }));
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [routine]);
      if (path.endsWith('/workout_sessions')) return fulfill(r, [mine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/save_workout')) return fulfill(r, '2026-11-03T01:10:00Z');
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    const start = p.getByTestId('start-workout');
    await start.waitFor({ timeout: 15000 });
    await start.click();
    await p.getByLabel('스쿼트 1세트 완료').uncheck();
    await p.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.locator('.toast.visible').waitFor({ timeout: 5000 }).catch(() => {});
    check("완료를 모두 끈 기록도 다시 저장하면 시트 쓰기를 부름(받아 둔 '시트에 쓴 자리'가 없어도)", writes === 1, JSON.stringify({ writes }));
    await p.close();
  });

  // 32) v2.1 운동 탭 '루틴'(2026-11-03 사용자 확정 시안 4): 바뀐 점은 새 루틴을 한 바퀴 돌기 전엔 카드 위·4건 넘는 루틴은 접힘,
  //     돈 뒤엔 카드 아래로 내려가 접힘 · 카드는 가로로 넘기고 보이는 카드가 아래 버튼의 루틴(처음엔 루틴 1)
  const item21 = (day_no, name, weight, reps = '10', sets = 3) => ({ id: `item-${day_no}-${name}`, ord: day_no * 10 + name.length, day_no, name, weight, reps, sets, rest: '', note: '' });
  const rt21 = (id, version, items) => ({ id, member_id: a, version, title: `${version === 2 ? '11월' : '10월'} 루틴`, goal: '', reason: '', warmup: '', source: 'manual', source_ref: '', created_at: version === 2 ? '2026-11-01T01:00:00Z' : '2026-10-01T01:00:00Z', items });
  const prev21 = rt21('r-old', 1, [item21(1, '스쿼트', '65'), item21(1, '레그 익스텐션', '30'), item21(2, '랫풀다운', '50')]);
  const cur21 = rt21('r-new', 2, [item21(1, '스쿼트', '70'), item21(1, '런지', '20'), item21(1, '레그 프레스', '100'), item21(1, '레그 컬', '30'), item21(1, '카프 레이즈', '40'), item21(2, '랫풀다운', '50'), item21(2, '시티드 로우', '40')]);
  const set21 = (name, kg, reps, done = true) => ({ item_id: null, name, set_no: 1, kg, reps, done, ord: 1 });
  const ses21 = (id, day, day_no, sets, routine_id = 'r-new', cardio = []) => ({ id, member_id: a, routine_id, day_no, day, started_at: `${day}T01:00:00Z`, updated_at: `${day}T01:00:00Z`, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets, cardio });
  const workoutPage = async (sessions, extra, at = '2026-11-03T10:00:00+09:00') => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date(at) });
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (extra) { const v = extra(path, r); if (v !== undefined) return v; }
      if (path.endsWith('/routines')) return fulfill(r, [cur21, prev21]);
      if (path.endsWith('/workout_sessions')) return fulfill(r, sessions);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    return p;
  };
  await soft('2.1 루틴 탭', async () => {
    const p = await workoutPage([ses21('s1', '2026-11-02', 1, [set21('스쿼트', '70', '8')])]);
    const upd = p.getByTestId('routine-update');
    await upd.waitFor({ timeout: 15000 });
    const track = p.getByTestId('routine-track');
    const above = (await upd.boundingBox()).y < (await track.boundingBox()).y;
    const head = await upd.innerText();
    check('한 바퀴 전: 루틴 카드 위에 바뀐 점(새 7 · 빠짐 1 · 목표 1), 한 바퀴 칸에 한 루틴 표시', above && head.includes('루틴이 바뀌었어요') && head.includes('새 운동 5') && head.includes('빠진 운동 1') && head.includes('목표 바뀜 1') && /루틴 1 ✓/.test(head) && !/루틴 2 ✓/.test(head), head.replace(/\s+/g, ' ').slice(0, 160));
    const d1 = p.getByTestId('update-day-1'), d2 = p.getByTestId('update-day-2');
    check('4건 넘게 바뀐 루틴은 숫자만, 적은 루틴은 펼친 채', (await d1.locator('li').count()) === 0 && (await d1.innerText()).includes('빠짐 1 · 새로 4 · 목표 1') && (await d2.locator('li').count()) === 1, (await d1.innerText()).replace(/\s+/g, ' '));
    await d1.getByRole('button', { name: /펼치기/ }).click();
    check('펼치면 그 루틴의 바뀐 운동 전부(지난 값 → 새 값)', (await d1.locator('li').count()) === 6 && (await d1.innerText()).includes('65kg → 70kg'));
    const cardText = (await p.getByTestId('routine-day-1').innerText()).replace(/\s+/g, ' ');
    check('루틴 카드에는 지금 루틴만(바뀐 표시 없음) · 운동 수·세트·마지막 한 날', !/빠짐|새로|→/.test(cardText) && cardText.includes('운동 5개 · 15세트') && cardText.includes('마지막 11월 2일'), cardText.slice(0, 120));
    check('루틴 카드에 다음 차례 표시 없음(사용자 11-06)', !(await p.getByTestId('routine-day-1').innerText()).includes('다음 차례') && !(await p.getByTestId('routine-day-2').innerText()).includes('다음 차례'));
    const cta = p.getByTestId('start-workout');
    const first = (await cta.innerText()).trim();
    await track.evaluate((el) => el.scrollTo({ left: el.children[1].offsetLeft - el.children[0].offsetLeft }));
    await cta.filter({ hasText: '루틴 2로 운동 시작' }).waitFor({ timeout: 5000 }).catch(() => {});
    const second = (await cta.innerText()).trim();
    await cta.click();
    await p.getByTestId('workout-form').waitFor({ timeout: 5000 });
    check('처음엔 루틴 1 · 카드를 넘기면 버튼이 그 루틴으로 바뀌고 누르면 그 루틴으로 기록 창', first.endsWith('루틴 1로 운동 시작') && second.endsWith('루틴 2로 운동 시작') && (await p.getByLabel('시티드 로우 1세트 완료').count()) === 1 && (await p.getByLabel('스쿼트 1세트 완료').count()) === 0, JSON.stringify({ first, second }));
    // 남은 적대 검토(11-03): 루틴 2 카드를 보다가 운동 기록 탭에 갔다 오면 카드는 루틴 1부터 — 버튼이 한 순간도 '루틴 2'를 보이지 않음
    await p.getByRole('button', { name: '창 닫기' }).click();
    await track.evaluate((el) => el.scrollTo({ left: el.children[1].offsetLeft - el.children[0].offsetLeft }));
    await cta.filter({ hasText: '루틴 2로 운동 시작' }).waitFor({ timeout: 5000 });
    const seg = p.getByRole('group', { name: '운동 화면' });
    await seg.getByRole('button', { name: '운동 기록', exact: true }).click();
    await cta.filter({ hasText: '운동 기록하기' }).waitFor({ timeout: 5000 });
    await p.evaluate(() => {
      window.__ctaTexts = [];
      const el = document.querySelector('[data-testid=start-workout]');
      new MutationObserver(() => window.__ctaTexts.push(el.textContent)).observe(el, { subtree: true, childList: true, characterData: true });
    });
    await seg.getByRole('button', { name: '루틴', exact: true }).click();
    await cta.filter({ hasText: '루틴 1로 운동 시작' }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(300);
    const seen = await p.evaluate(() => window.__ctaTexts);
    check('탭을 오가면 버튼은 카드와 같이 루틴 1부터(옛 루틴 2를 한 순간도 보이지 않음)', !seen.some((t) => t.includes('루틴 2')), JSON.stringify(seen));
    await p.close();
    const q = await workoutPage([ses21('s2', '2026-11-02', 2, [set21('랫풀다운', '50', '10')]), ses21('s1', '2026-11-01', 1, [set21('스쿼트', '70', '8')])]);
    const past = q.getByTestId('routine-update');
    await past.waitFor({ timeout: 15000 });
    const below = (await past.boundingBox()).y > (await q.getByTestId('routine-track').boundingBox()).y;
    check('한 바퀴 돈 뒤: 카드 아래로 내려가 접힘(지난 루틴 업데이트)', below && (await past.innerText()).includes('지난 루틴 업데이트') && (await past.locator('li').count()) === 0 && (await past.getByRole('button', { name: /바뀐 운동 7개 보기/ }).count()) === 1, (await past.innerText()).replace(/\s+/g, ' ').slice(0, 100));
    await q.close();
  });

  // 33) v2.1 운동 탭 '운동 기록'(시안 3): 꾸준함 숫자 · 최근 5주 달력 · 주 단위 한 줄 기록(요일·며칠 전·가장 무거운 세트·최고 기록) · 골라 보기 · 달력 → 그날 기록
  // 2.3 성별(설정 → 계정): 아직 안 정한 회원은 고르고 확인 창을 거쳐 정함 · 정하면 고정 · 다른 값이 거절되면 안내
  await soft('2.3 설정의 성별', async () => {
    const ctl = { gender: null, hidden: false, calls: [], lock: false };
    const p = await workoutPage([], (path, r) => {
      if (path.endsWith('/rpc/my_gender')) return fulfill(r, { gender: ctl.gender, hidden: ctl.hidden });
      if (path.endsWith('/rpc/set_my_gender')) {
        ctl.calls.push(r.request().postDataJSON());
        if (ctl.lock) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'gender_locked' }) });
        ctl.gender = r.request().postDataJSON().p_gender;
        return fulfill(r, 'saved');
      }
      if (path.endsWith('/rpc/set_gender_hidden')) { ctl.hidden = r.request().postDataJSON().p_on; return fulfill(r, null); }
      return undefined;
    });
    await p.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
    const pick = p.getByRole('group', { name: '성별' });
    await pick.waitFor({ timeout: 10000 });
    await pick.getByRole('button', { name: '남자' }).click();
    const dlg = p.getByTestId('gender-confirm');
    await dlg.waitFor({ timeout: 3000 });
    const text = (await dlg.innerText()).replace(/\s+/g, ' ');
    await dlg.getByRole('button', { name: '취소' }).click();
    check('2.3 성별: 고르면 확인 창(바꿀 수 없음·의견 보내기·공개하지 않기 안내) · 취소하면 저장하지 않음', text.includes('성별을 ‘남자’로 정할까요?') && text.includes('저장한 뒤에는 앱에서 바꿀 수 없어요') && text.includes('의견 보내기') && ctl.calls.length === 0 && (await pick.count()) === 1, text);
    ctl.lock = true; // 다른 기기에서 이미 정한 경우
    await pick.getByRole('button', { name: '여자' }).click();
    await dlg.getByRole('button', { name: '여자로 정하기' }).click();
    await p.locator('.toast.visible', { hasText: '이미 성별을 정했어요' }).waitFor({ timeout: 3000 }).catch(() => {});
    check('2.3 성별: 다른 기기에서 이미 정해 거절되면 안내', (await p.locator('.toast.visible', { hasText: '이미 성별을 정했어요' }).count()) === 1);
    ctl.lock = false;
    await pick.getByRole('button', { name: '남자' }).click();
    await dlg.getByRole('button', { name: '남자로 정하기' }).click();
    await pick.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    const row = (await p.locator('.settings-row', { hasText: '성별' }).first().innerText()).replace(/\s+/g, ' ');
    check('2.3 성별: 정하면 값만 보이고 고르는 칸이 사라짐(바꿀 수 없음 표시 없음)', ctl.gender === 'male' && (await pick.count()) === 0 && row.includes('남자') && !row.includes('바꿀 수 없'), row);
    await p.getByRole('switch', { name: '성별 공개하지 않기' }).click();
    await p.locator('.toast.visible', { hasText: '성별을 비공개로 바꿨어요' }).waitFor({ timeout: 3000 }).catch(() => {});
    check('2.3 성별 공개하지 않기: 켜면 저장 · 잘못 고른 경우 안내가 설정에 보임', ctl.hidden === true && (await p.getByText('성별 수정이 필요하면 ‘의견 보내기’로 알려 주세요.').count()) === 1);
    await p.close();
  });

  // 2.3 공복 체중: 기록 · 같은 날 고치기 · 지우기 · 체중 그래프의 빈 점 · 다른 항목 그래프에는 없음
  await soft('2.3 공복 체중', async () => {
    const ctl = { list: [{ day: '2026-11-01', kg: 73.5 }, { day: '2026-10-20', kg: 74 }], saves: [], dels: [] };
    const ib = [{ id: 'i2', member_id: a, measured_on: '2026-11-02', weight_kg: 73, smm_kg: 32, pbf_pct: 22, source: 'manual', created_at: '2026-11-02T01:00:00Z' }, { id: 'i1', member_id: a, measured_on: '2026-10-05', weight_kg: 75, smm_kg: 31, pbf_pct: 24, source: 'manual', created_at: '2026-10-05T01:00:00Z' }];
    const p = await workoutPage([], (path, r) => {
      if (path.endsWith('/inbody_records')) return fulfill(r, ib);
      if (path.endsWith('/fasting_weights')) return fulfill(r, ctl.list);
      if (path.endsWith('/rpc/diet_report')) return fulfill(r, { days: 28, logged_days: 20, meals: 40, rated: 30, great: 15, good: 10, care: 5, score: 4 });
      if (path.endsWith('/rpc/workout_summary')) return fulfill(r, { days: 10, done_sets: 100, cardio_count: 0, cardio_minutes: '0', cardio_km: '0' });
      if (path.endsWith('/rpc/save_fasting_weight')) { const b = r.request().postDataJSON(); ctl.saves.push(b); ctl.list = [{ day: b.p_day, kg: b.p_kg }, ...ctl.list.filter((w) => w.day !== b.p_day)].sort((x, y) => (x.day < y.day ? 1 : -1)); return fulfill(r, null); }
      if (path.endsWith('/rpc/delete_fasting_weight')) { const b = r.request().postDataJSON(); ctl.dels.push(b.p_day); ctl.list = ctl.list.filter((w) => w.day !== b.p_day); return fulfill(r, null); }
      return undefined;
    });
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
    const card = p.getByTestId('fasting-card');
    await card.waitFor({ timeout: 15000 });
    await p.getByTestId('inbody-chart').waitFor({ timeout: 5000 });
    await p.getByTestId('fasting-point').first().waitFor({ state: 'attached', timeout: 5000 });
    check('체중 그래프에 공복 체중 빈 점 두 개 · 범례', (await p.getByTestId('fasting-point').count()) === 2 && (await p.locator('.inbody-chart-legend').innerText()).includes('공복 체중'));
    await p.getByRole('group', { name: '그래프 항목' }).getByRole('button', { name: '골격근량' }).click();
    check('다른 항목 그래프에는 공복 체중 없음', (await p.getByTestId('fasting-point').count()) === 0);
    await p.getByRole('group', { name: '그래프 항목' }).getByRole('button', { name: '체중' }).click();
    await card.getByLabel('공복 체중(kg)').fill('10');
    await card.getByRole('button', { name: '기록' }).click();
    await p.locator('.toast.visible', { hasText: '20～300kg' }).waitFor({ timeout: 3000 }).catch(() => {});
    check('범위 밖 체중은 저장하지 않고 안내', ctl.saves.length === 0 && (await p.locator('.toast.visible', { hasText: '20～300kg' }).count()) === 1);
    await card.getByLabel('공복 체중(kg)').fill('72.4');
    await card.getByRole('button', { name: '기록' }).click();
    await card.getByRole('button', { name: '11/3 72.4' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('기록하면 오늘 날짜로 저장 · 칸 비움 · 최근 목록에 보임', ctl.saves.length === 1 && ctl.saves[0].p_day === '2026-11-03' && (await card.getByLabel('공복 체중(kg)').inputValue()) === '' && (await card.getByRole('button', { name: '11/3 72.4' }).count()) === 1, JSON.stringify(ctl.saves));
    await card.getByRole('button', { name: '11/1 73.5' }).click();
    const loaded = [await card.getByLabel('공복 체중 날짜').inputValue(), await card.getByLabel('공복 체중(kg)').inputValue()].join('|');
    await card.getByRole('button', { name: '11/1 기록 지우기' }).click();
    await card.getByRole('button', { name: '11/1 73.5' }).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    check('최근 값을 누르면 그 날짜·값을 불러오고 지울 수 있음', loaded === '2026-11-01|73.5' && ctl.dels.join() === '2026-11-01' && (await card.getByRole('button', { name: '11/1 73.5' }).count()) === 0, loaded);
    await p.close();
  });

  // 2.3 트레이너 한마디 모아 보기: 커뮤니티 칸(최근 세 개·꿀팁 표시) · 모두 보기 창(달별 · 꿀팁만) · 쓴 한마디가 없으면 칸 없음
  await soft('2.3 트레이너 한마디', async () => {
    const list = [{ day: '2026-11-03', body: '바를 정강이에 붙여요', is_tip: true }, { day: '2026-11-02', body: '한 끼만 더', is_tip: false }, { day: '2026-11-01', body: '첫날 힘내요', is_tip: false }, { day: '2026-10-31', body: '무릎은 발끝 방향', is_tip: true }];
    const p = await workoutPage([], (path, r) => (path.endsWith('/trainer_messages') ? fulfill(r, r.request().url().includes('lte') ? list : null) : undefined));
    await p.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
    const card = p.getByTestId('trainer-words');
    await card.waitFor({ timeout: 15000 });
    const text = (await card.innerText()).replace(/\s+/g, ' ');
    check('커뮤니티 칸: 최신 글 한 줄만', text.includes('바를 정강이에 붙여요') && !text.includes('한 끼만 더'), text);
    await card.getByRole('button', { name: /트레이너 한마디/ }).click();
    const all = p.getByTestId('trainer-words-all');
    await all.waitFor({ timeout: 5000 });
    const heads = await all.locator('h3').allInnerTexts();
    await all.getByRole('button', { name: '운동 꿀팁 2' }).click();
    const tipCount = await all.locator('.trainer-word').count();
    check('모두 보기: 달별 묶음 · 전체 4개 중 운동 꿀팁 2개만 골라 봄', heads.join('|') === '11월|10월' && tipCount === 2 && (await all.getByRole('button', { name: '전체 4' }).count()) === 1, JSON.stringify({ heads, tipCount }));
    await p.close();
    const q = await workoutPage([], (path, r) => (path.endsWith('/trainer_messages') ? fulfill(r, r.request().url().includes('lte') ? [] : null) : undefined));
    await q.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
    await q.waitForTimeout(800);
    check('쓴 한마디가 없으면 칸이 보이지 않음', (await q.getByTestId('trainer-words').count()) === 0);
    await q.close();
  });

  await soft('2.1 운동 기록 탭', async () => {
    const sessions = [
      ses21('s1', '2026-11-02', 1, [set21('스쿼트', '70', '8'), set21('스쿼트', '65', '10'), set21('런지', '20', '12'), set21('레그 프레스', '100', '10'), set21('레그 컬', '30', '12')]),
      ses21('s4', '2026-11-01', null, [], null, [{ kind: 'walk', minutes: '40.0', km: '3.20', speed: null, ord: 1 }]),
      ses21('s2', '2026-10-30', 1, [set21('스쿼트', '65', '10')], 'r-old'),
    ];
    // 꾸준함·달력·최고 기록은 서버 집계(workout_overview·workout_compare, Codex 3차 리뷰 P2) — 그 응답을 흉내 낸다
    const overview = { this_week: 2, this_month: 2, streak_weeks: 2, from: '2026-10-04', routine: null,
      days: [{ day: '2026-10-30', day_no: 1, started_at: '2026-10-30T01:00:00Z', strength: true, cardio: false }, { day: '2026-11-01', day_no: null, started_at: '2026-11-01T01:00:00Z', strength: false, cardio: true }, { day: '2026-11-02', day_no: 1, started_at: '2026-11-02T01:00:00Z', strength: true, cardio: false }] };
    const compare = { s1: { 스쿼트: { prior: [65], prev: '65' }, 런지: { prior: null, prev: null }, '레그 프레스': { prior: null, prev: null }, '레그 컬': { prior: null, prev: null } }, s2: { 스쿼트: { prior: null, prev: null } } };
    const p = await workoutPage(sessions, (path, r) => (path.endsWith('/rpc/workout_overview') ? fulfill(r, overview) : path.endsWith('/rpc/workout_compare') ? fulfill(r, compare) : undefined));
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    const sum = p.getByTestId('records-summary');
    await sum.waitFor({ timeout: 15000 });
    const tiles = (await sum.locator('.records-tiles').innerText()).replace(/\s+/g, ' ');
    check('꾸준함: 이번 주 2회 · 연속 2주 · 11월 2회', tiles === '이번 주 2회 연속 2주 11월 2회', tiles);
    const cell = (d) => sum.locator('.records-cell').filter({ has: p.locator('b', { hasText: new RegExp(`^${d}$`) }) }).first();
    check('달력: 루틴 한 날은 채우고 번호, 유산소만 한 날은 테두리 · 오늘 표시', (await cell('2').getAttribute('class')).includes('is-routine') && (await cell('2').innerText()).includes('루틴1') && (await cell('11/1').getAttribute('class')).includes('is-cardio') && (await cell('3').getAttribute('class')).includes('is-today'));
    // 2026-11-03 정돈: 큰 카드 대신 주 단위로 묶은 한 줄 기록 · 루틴별 골라 보기 · 달력의 운동한 날 → 그날 기록
    const rows = p.locator('.record-row');
    // 최고·오름 표시는 서버 비교가 지금 기록에 맞을 때만 붙는다(Codex v2.2.0 1차 리뷰 P2-2) — 비교가 도착한 뒤 읽는다
    await rows.nth(0).locator('.record-pr').first().waitFor({ timeout: 5000 }).catch(() => {});
    const c1 = (await rows.nth(0).innerText()).replace(/\s+/g, ' ');
    check('한 줄 기록: 날짜·요일(읽어 주는 글)·어제 · 루틴 이름 · 완료 세트 · 운동 두 개의 가장 무거운 세트(최고 먼저) · 나머지는 수만', c1.includes('11월 2일 월요일') && c1.includes('어제') && c1.includes('루틴 1') && c1.includes('완료 5/5세트') && c1.includes('스쿼트 70kg × 8최고') && c1.includes('외 2개') && c1.includes('최고 1'), c1);
    const c2 = (await rows.nth(1).innerText()).replace(/\s+/g, ' ');
    check('유산소만 한 기록: 제목 유산소 · 종류·시간·거리 한 줄', c2.includes('유산소') && c2.includes('걷기 40분 · 3.2km') && c2.includes('2일 전'), c2);
    const heads = async () => (await p.locator('.records-group h4').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim()).join('|');
    check('주 단위로 묶음(이번 주 2회 · 지난주 1회)', (await heads()) === '이번 주 2회|지난주 1회', await heads());
    const chips = p.getByRole('group', { name: '루틴별로 보기' });
    check('골라 보기: 전체 · 루틴 1 · 유산소', (await chips.getByRole('button').allInnerTexts()).join('|') === '전체|루틴 1|유산소', (await chips.getByRole('button').allInnerTexts()).join('|'));
    await chips.getByRole('button', { name: '루틴 1' }).click();
    check('루틴 1만 고르면 루틴 1 기록 두 개(유산소 기록은 숨김)', (await rows.count()) === 2 && (await heads()) === '이번 주 1회|지난주 1회', await heads());
    await chips.getByRole('button', { name: '유산소' }).click();
    await sum.getByRole('button', { name: /10월 30일.*기록 보기/ }).click();
    const jumped = p.locator('.record-row[data-day="2026-10-30"]');
    await jumped.waitFor({ timeout: 3000 });
    check('달력에서 운동한 날을 누르면 골라 보기를 풀고 그날 기록을 표시', (await jumped.getAttribute('class')).includes('is-flash') && (await chips.getByRole('button', { name: '전체' }).getAttribute('aria-pressed')) === 'true' && (await rows.count()) === 3);
    check('운동하지 않은 날은 누르는 버튼이 아님', (await sum.getByRole('button', { name: /11월 3일/ }).count()) === 0);
    await rows.nth(0).click();
    await p.getByRole('dialog').waitFor({ timeout: 5000 });
    check('한 줄 기록을 누르면 그 기록을 연다', (await p.getByRole('dialog').innerText()).includes('스쿼트'));
    await p.getByRole('button', { name: '창 닫기' }).click();
    check("운동 기록 탭의 아래 버튼은 '운동 기록하기'", (await p.getByTestId('start-workout').innerText()).trim().endsWith('운동 기록하기'));
    await p.close();
  });

  // 33b) Codex v2.1.0 3차 리뷰: 최근 30개 목록이 아니라 서버 집계로 — 이번 달 31회 · 30개 밖 기록이 있는 달력 날 · 30개 밖 100kg 때문에 50kg은 최고가 아님(같은 날 오전 40보다 ↑10)
  //      · 집계를 못 받으면 틀린 숫자 대신 다시 불러오기
  await soft('2.1 운동 기록 서버 집계', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => {
      const day = `2026-11-${String(30 - Math.floor(i / 2)).padStart(2, '0')}`;
      return { ...ses21(`t${i}`, day, 1, [set21('랫풀다운', '30', '12')]), started_at: `${day}T0${i % 2 ? 1 : 6}:00:00Z` };
    });
    // 맨 앞(가장 최근) 둘: 같은 날 오전 40 → 오후 50
    thirty[0] = { ...ses21('pm', '2026-11-30', 1, [set21('스쿼트', '50', '8')]), started_at: '2026-11-30T06:00:00Z' };
    thirty[1] = { ...ses21('am', '2026-11-30', 1, [set21('스쿼트', '40', '8')]), started_at: '2026-11-30T01:00:00Z' };
    const ov = { this_week: 3, this_month: 31, streak_weeks: 9, from: '2026-10-26', routine: { id: cur21.id, last: {}, latest_day_no: null },
      days: [{ day: '2026-11-01', day_no: 1, started_at: '2026-11-01T01:00:00Z', strength: true, cardio: false }, ...thirty.map((x) => ({ day: x.day, day_no: 1, started_at: x.started_at, strength: true, cardio: false }))] };
    const cmp = { pm: { 스쿼트: { prior: [100], prev: '40' } }, am: { 스쿼트: { prior: [100], prev: '100' } } };
    const p = await workoutPage(thirty, (path, r) => {
      if (path.endsWith('/rpc/workout_overview')) return fulfill(r, ov);
      if (path.endsWith('/rpc/workout_compare')) return fulfill(r, cmp);
      return undefined;
    });
    await p.clock.setFixedTime(new Date('2026-11-30T20:00:00+09:00'));
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    const sum = p.getByTestId('records-summary');
    await sum.waitFor({ timeout: 15000 });
    const tiles = (await sum.locator('.records-tiles').innerText()).replace(/\s+/g, ' ');
    const day1 = sum.locator('.records-cell', { has: p.locator('b', { hasText: /^11\/1$/ }) }).first();
    const pmCard = p.locator('.record-row').first();
    const pmText = (await pmCard.innerText()).replace(/\s+/g, ' ');
    check('1차 리뷰 후속: 목록 밖의 운동한 날(11월 1일)은 누르는 버튼이 아니고, 누를 수 있는 날을 안내', (await day1.evaluate((el) => el.tagName)) === 'SPAN' && (await sum.innerText()).includes('최근 30개 기록에 있는 날을 누르면 그날 기록으로'));
    check('3차 P2-3: 이번 달 31회(최근 30개가 아니라 서버 집계) · 30개 밖 11월 1일도 달력에 운동한 날 · 30개 밖 100kg 때문에 50kg은 최고 아님, 같은 날 오전 40보다 ↑10 · 목록이 30개면 그 사실을 알림',
      tiles.includes('11월 31회') && (await day1.getAttribute('class')).includes('is-routine') && pmText.includes('스쿼트 50kg × 8') && !pmText.includes('최고') && pmText.includes('↑10') && (await p.getByText('최근 30개 기록이에요').count()) === 1,
      JSON.stringify({ tiles, day1: await day1.getAttribute('class'), pmText: pmText.slice(0, 120) }));
    await p.close();
    // 집계를 받지 못하면 틀린 숫자(최근 30개로 센 값) 대신 다시 불러오기 · 카드는 그대로
    const q = await workoutPage(thirty, (path, r) => (path.endsWith('/rpc/workout_overview') || path.endsWith('/rpc/workout_compare') ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }) : undefined));
    await q.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await q.locator('.stale-notice', { hasText: '운동 횟수·달력을' }).waitFor({ timeout: 15000 });
    // 요약·비교는 따로 끝난다 — 비교 실패 안내도 기다린 뒤 본다(Codex v2.2.0 2차 리뷰 P3)
    await q.locator('.stale-notice', { hasText: '최고 기록·이전 기록보다' }).waitFor({ timeout: 15000 });
    check('3차 P2-3: 집계 실패면 요약·달력을 그리지 않고 다시 불러오기 · 기록 카드는 보이되 최고·오름 표시 없음(그 이유도 안내)',
      (await q.getByTestId('records-summary').count()) === 0 && (await q.locator('.record-row').count()) === 30 && (await q.locator('.record-pr, .record-up').count()) === 0 && (await q.locator('.stale-notice', { hasText: '최고 기록·이전 기록보다' }).count()) === 1);
    await q.close();
    // 비교만 실패: 요약·달력은 그대로, 최고 표시가 없는 이유만 안내(요약 안내에 '최고 기록'을 넣지 않음)
    const r2 = await workoutPage(thirty, (path, r) => (path.endsWith('/rpc/workout_overview') ? fulfill(r, ov) : path.endsWith('/rpc/workout_compare') ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : undefined));
    await r2.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await r2.locator('.stale-notice', { hasText: '최고 기록·이전 기록보다' }).waitFor({ timeout: 15000 });
    check('적대 검토(3차 뒤): 비교만 실패하면 요약은 그대로 · 최고 표시가 없는 이유를 따로 안내', (await r2.getByTestId('records-summary').count()) === 1 && (await r2.locator('.stale-notice', { hasText: '운동 횟수·달력을' }).count()) === 0);
    await r2.close();
  });
  // Codex v2.2.0 1차 리뷰 P2 세 건(문서/코드리뷰/v2.2/개발 AI_전달용_v2_2_0_1차_리뷰_20261103.md) — 리뷰의 재현 순서를 그대로 유지 검증으로
  const recordsTab = (p) => p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
  const refresh = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // P2-1: 시트 기록을 가져오면 목록뿐 아니라 이번 주·이번 달·달력도 새 자료로
  await soft('2.2 1차 리뷰 P2-1 가져오기 뒤 요약 갱신', async () => {
    {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      let imported = false, overCalls = 0;
      const ov = (n) => ({ this_week: n, this_month: n, streak_weeks: n ? 1 : 0, from: '2026-10-04', today: '2026-11-03', routine: null, days: n ? [{ day: '2026-11-02', day_no: 1, started_at: '2026-11-02T01:00:00Z', strength: true, cardio: false }, { day: '2026-11-02', day_no: 2, started_at: '2026-11-02T03:00:00Z', strength: true, cardio: false }] : [] });
      const sheetRow = (id, n) => ({ ...ses21(id, '2026-11-02', n, [set21('스쿼트', '50', '10')], null), started_at: `2026-11-02T0${n * 2 - 1}:00:00Z`, source: 'sheet', sheet_tab: '2611', sheet_col: 4 + n });
      await p.route('**/functions/v1/sheet-import*', (r) => {
        const b = r.request().postDataJSON();
        if (b.mode === 'records_all') {
          if (b.preview) return fulfill(r, { status: 'preview', removes: 0, tabs: [{ tab: '2611', sessions: 2, skipped: 0, problems: [] }] });
          imported = true;
          return fulfill(r, { status: 'imported', saved: 2, skipped: 0, removed: 0, problems: [] });
        }
        return fulfill(r, { status: 'fresh', version: null });
      });
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routines')) return fulfill(r, []);
        if (path.endsWith('/workout_sessions')) return fulfill(r, imported ? [sheetRow('i2', 2), sheetRow('i1', 1)] : []);
        if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
        if (path.endsWith('/rpc/workout_overview')) { overCalls++; return fulfill(r, ov(imported ? 2 : 0)); }
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await recordsTab(p);
      const sum = p.getByTestId('records-summary');
      await sum.waitFor({ timeout: 15000 });
      const before = (await sum.locator('.records-tiles').innerText()).replace(/\s+/g, ' ');
      await p.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
      await p.getByTestId('sheet-records').getByRole('button', { name: '가져오기', exact: true }).click();
      await p.locator('.record-row').nth(1).waitFor({ timeout: 5000 });
      await sum.locator('.records-tiles', { hasText: '이번 주 2회' }).waitFor({ timeout: 5000 }).catch(() => {});
      const after = (await sum.locator('.records-tiles').innerText()).replace(/\s+/g, ' ');
      const cell = sum.locator('.records-cell', { has: p.locator('b', { hasText: /^2$/ }) }).first();
      check('P2-1: 시트 기록을 가져오면 목록·이번 주·이번 달·달력이 함께 새 자료로', before.startsWith('이번 주 0회') && after === '이번 주 2회 연속 1주 11월 2회' && (await cell.getAttribute('class')).includes('is-routine') && overCalls >= 2, JSON.stringify({ before, after, overCalls }));
      await p.close();
    }
  });
  // P2-2: 한 번 받은 뒤 다시 받기가 실패해도 안내·다시 불러오기를 보이고, 바뀐 기록에 옛 비교로 최고를 붙이지 않는다
  await soft('2.2 1차 리뷰 P2-2 다시 받기 실패 안내', async () => {
    {
      const ctl = { fail: false, past: '40' };
      const rows = () => [ses21('n1', '2026-11-02', 1, [set21('스쿼트', '50', '10')]), ses21('p1', '2026-11-01', 1, [set21('스쿼트', ctl.past, '10')])];
      const ov = { this_week: 2, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', routine: null, days: [{ day: '2026-11-01', day_no: 1, started_at: '2026-11-01T01:00:00Z', strength: true, cardio: false }, { day: '2026-11-02', day_no: 1, started_at: '2026-11-02T01:00:00Z', strength: true, cardio: false }] };
      const cmpFor = () => ({ n1: { 스쿼트: { prior: [Number(ctl.past)], prev: ctl.past } }, p1: { 스쿼트: { prior: null, prev: null } } });
      const p = await workoutPage([], (path, r) => {
        if (path.endsWith('/workout_sessions')) return fulfill(r, rows());
        if (path.endsWith('/rpc/workout_overview') || path.endsWith('/rpc/workout_compare')) {
          if (ctl.fail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
          return fulfill(r, path.endsWith('/rpc/workout_overview') ? ov : cmpFor());
        }
        return undefined;
      });
      await recordsTab(p);
      const n1 = p.locator('.record-row[data-day="2026-11-02"]');
      await n1.locator('.record-lift .record-pr').waitFor({ timeout: 15000 });
      // ① 기록은 그대로인데 다시 받기만 실패(앱 복귀): 이전 값과 최고 표시를 두고 그 사실을 알림
      ctl.fail = true;
      await refresh(p);
      const both = p.locator('.stale-notice', { hasText: '운동 횟수·달력과 최고 기록·오른 무게를 새로 불러오지 못해' });
      await both.waitFor({ timeout: 5000 }).catch(() => {});
      check('P2-2: 받은 뒤 다시 받기가 실패하면 이전 값(요약·최고)을 두고 안내와 다시 불러오기를 보임', (await both.count()) === 1 && (await both.getByRole('button').count()) >= 1 && (await p.getByTestId('records-summary').count()) === 1 && (await n1.locator('.record-lift .record-pr').count()) === 1);
      // ② 예전 기록을 40 → 60으로 고친 뒤 다시 받기 실패: 50에 옛 비교의 '최고'를 붙이지 않음
      ctl.past = '60';
      await refresh(p);
      await p.locator('.record-row[data-day="2026-11-01"]', { hasText: '60kg' }).waitFor({ timeout: 5000 });
      await p.locator('.stale-notice', { hasText: '최고 기록·이전 기록보다 오른 무게를 불러오지 못했어요' }).waitFor({ timeout: 5000 }).catch(() => {});
      const n1Text = (await n1.innerText()).replace(/\s+/g, ' ');
      check('P2-2: 예전 기록을 40에서 60으로 고친 뒤 비교를 새로 받지 못하면 50kg을 최고로 표시하지 않고 그 이유를 알림', !n1Text.includes('최고') && (await p.locator('.stale-notice', { hasText: '최고 기록·이전 기록보다 오른 무게를 불러오지 못했어요' }).count()) === 1 && (await p.locator('.stale-notice', { hasText: '운동 횟수·달력을 새로 불러오지 못해' }).count()) === 1, n1Text);
      // ③ 다시 불러오기가 성공하면 안내가 사라지고 새 비교로(60보다 가벼운 50은 최고 아님)
      ctl.fail = false;
      await p.locator('.stale-notice').first().getByRole('button').click();
      await p.locator('.stale-notice').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      check('P2-2: 다시 불러오기에 성공하면 안내가 사라지고 새 비교로 표시', (await p.locator('.stale-notice').count()) === 0 && !(await n1.innerText()).includes('최고'));
      await p.close();
    }
  });
  // P2-3: 고른 루틴의 마지막 기록이 사라지면 전체로 — 남은 기록을 볼 수 있고, 같은 종류가 다시 생겨도 저절로 다시 골라지지 않음
  await soft('2.2 1차 리뷰 P2-3 사라진 골라 보기', async () => {
    {
      const ctl = { list: [ses21('a1', '2026-11-02', 1, [set21('스쿼트', '50', '10')]), ses21('b2', '2026-11-01', 2, [set21('랫풀다운', '40', '10')])] };
      const p = await workoutPage([], (path, r) => (path.endsWith('/workout_sessions') ? fulfill(r, ctl.list) : undefined));
      await recordsTab(p);
      const chips = p.getByRole('group', { name: '루틴별로 보기' });
      await chips.getByRole('button', { name: '루틴 2' }).click();
      const keep = ctl.list[0], gone = ctl.list[1];
      ctl.list = [keep];
      await refresh(p);
      await p.locator('.record-row').filter({ hasText: '루틴 1' }).waitFor({ timeout: 5000 }).catch(() => {});
      const rowsAfter = await p.locator('.record-row').count();
      ctl.list = [keep, gone];
      await refresh(p);
      await chips.waitFor({ timeout: 5000 }).catch(() => {});
      const pressed = await chips.locator('button[aria-pressed="true"]').allInnerTexts();
      check('P2-3: 고른 루틴 2의 마지막 기록이 사라지면 남은 루틴 1 기록이 보이고, 루틴 2가 다시 생기면 전체가 골라져 있음', rowsAfter === 1 && (await p.locator('.record-row').count()) === 2 && pressed.join('|') === '전체', JSON.stringify({ rowsAfter, pressed }));
      // 기록이 모두 사라졌다가 다른 종류(유산소)가 생기는 경우
      await chips.getByRole('button', { name: '루틴 2' }).click();
      ctl.list = [];
      await refresh(p);
      await p.getByText('아직 운동 기록이 없어요').waitFor({ timeout: 5000 }).catch(() => {});
      ctl.list = [keep, ses21('c1', '2026-10-31', null, [], null, [{ kind: 'run', minutes: '30.0', km: '5.00', speed: null, ord: 1 }])];
      await refresh(p);
      await p.locator('.record-row').nth(1).waitFor({ timeout: 5000 }).catch(() => {});
      check('P2-3: 모두 사라졌다가 다른 종류가 생겨도 고를 길이 있고 전체로 보임', (await p.locator('.record-row').count()) === 2 && (await chips.locator('button[aria-pressed="true"]').allInnerTexts()).join('|') === '전체');
      await p.close();
    }
  });
  // 1차 리뷰 반영 뒤 적대 검토: 루틴 탭은 요약 실패를 몰라 저장 뒤 마지막 한 날이 옛 값이었다 · 종류가 하나만 남아 고르는 칸이 숨으면 고른 것도 풀림
  await soft('2.2 1차 리뷰 뒤 적대 검토: 요약 실패 뒤 루틴 진행 · 숨은 골라 보기', async () => {
    const ctl = { list: [ses21('s1', '2026-11-02', 1, [set21('스쿼트', '70', '8')])], fail: false };
    const ov = { this_week: 1, this_month: 1, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [{ day: '2026-11-02', day_no: 1, started_at: '2026-11-02T01:00:00Z', strength: true, cardio: false }], routine: { id: cur21.id, last: { 1: '2026-11-02' }, latest_day_no: 1 } };
    const p = await workoutPage([], (path, r) => {
      if (path.endsWith('/workout_sessions')) return fulfill(r, ctl.list);
      if (path.endsWith('/rpc/workout_overview')) return ctl.fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, ov);
      if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
      return undefined;
    });
    const card2 = p.getByTestId('routine-day-2');
    await card2.locator('.routine-slide-meta').waitFor({ timeout: 15000 });
    await p.waitForTimeout(300);
    // 오늘 루틴 2를 했는데(다른 기기·저장) 요약을 다시 받지 못함 → 받아 둔 기록으로 루틴 2는 '마지막 11월 3일'
    ctl.list = [ses21('s2', '2026-11-03', 2, [set21('랫풀다운', '50', '10')]), ...ctl.list];
    ctl.fail = true;
    await refresh(p);
    await card2.filter({ hasText: '마지막 11월 3일' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('요약을 다시 받지 못해도 새로 받은 기록으로 루틴 진행(루틴 2 마지막 11월 3일)', (await card2.innerText()).includes('마지막 11월 3일'), (await card2.innerText()).replace(/\s+/g, ' ').slice(0, 80));
    // 루틴 1을 고른 뒤 루틴 2 기록만 목록에서 빠지면(종류 하나) 고르는 칸이 숨고 고른 것도 풀림 → 나중에 생긴 루틴 2 기록이 가려지지 않음
    ctl.fail = false;
    await recordsTab(p);
    const chips = p.getByRole('group', { name: '루틴별로 보기' });
    await chips.getByRole('button', { name: '루틴 1' }).click();
    const [s2, s1] = ctl.list;
    ctl.list = [s1];
    await refresh(p);
    await chips.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    ctl.list = [s2, s1];
    await refresh(p);
    await p.locator('.record-row').nth(1).waitFor({ timeout: 5000 }).catch(() => {});
    check('고른 루틴만 남아 고르는 칸이 숨으면 고른 것도 풀림(새 루틴 2 기록이 보이고 전체가 골라져 있음)', (await p.locator('.record-row').count()) === 2 && (await chips.locator('button[aria-pressed="true"]').allInnerTexts()).join('|') === '전체');
    await p.close();
  });
  // Codex v2.2.0 2차 리뷰 P2-1: 지운 기록을 옛 요약에서 되살림 · 요약을 기다리는 동안 같은 날의 순서를 옛 요약으로
  await soft('2.2 2차 리뷰 P2-1 옛 요약과 루틴 진행', async () => {
    const ses2 = (id, day, n, hour) => ({ ...ses21(id, day, n, [set21(n === 1 ? '스쿼트' : '랫풀다운', '50', '10')]), started_at: `${day}T0${hour}:00:00Z` });
    const ovOf = (last, latest) => ({ this_week: 2, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: { id: cur21.id, last, latest_day_no: latest } });
    // ① 11월 1일 루틴 1 · 11월 2일 루틴 2 → 루틴 2 기록을 지움(목록은 반영) · 요약 다시 받기는 실패
    {
      const ctl = { list: [ses2('d2', '2026-11-02', 2, 1), ses2('d1', '2026-11-01', 1, 1)], fail: false };
      const p = await workoutPage([], (path, r) => {
        if (path.endsWith('/workout_sessions')) return fulfill(r, ctl.list);
        if (path.endsWith('/rpc/workout_overview')) return ctl.fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, ovOf({ 1: '2026-11-01', 2: '2026-11-02' }, 2));
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        return undefined;
      });
      await p.getByTestId('routine-day-1').locator('.routine-slide-meta').waitFor({ timeout: 15000 });
      await p.waitForTimeout(300);
      ctl.list = [ctl.list[1]];
      ctl.fail = true;
      await refresh(p);
      const card2 = p.getByTestId('routine-day-2');
      await card2.filter({ hasText: '아직 안 함' }).waitFor({ timeout: 5000 }).catch(() => {});
      const t2 = (await card2.innerText()).replace(/\s+/g, ' ');
      check('2차 P2-1: 지운 루틴 2 기록을 옛 요약에서 되살리지 않음(루틴 2 아직 안 함)', t2.includes('아직 안 함') && !t2.includes('마지막 11월 2일'), t2.slice(0, 80));
      await p.close();
    }
    // ② 같은 날 루틴 1(오전) → 루틴 2(오후)를 받아 둠 · 새 요약은 아직 오지 않음(보류)
    {
      let release = () => {};
      const ctl = { list: [ses2('e1', '2026-11-03', 1, 1)], hold: false };
      const p = await workoutPage([], (path, r) => {
        if (path.endsWith('/workout_sessions')) return fulfill(r, ctl.list);
        if (path.endsWith('/rpc/workout_overview')) {
          if (!ctl.hold) return fulfill(r, ovOf({ 1: '2026-11-03' }, 1));
          return new Promise((res) => (release = res)).then(() => fulfill(r, ovOf({ 1: '2026-11-03', 2: '2026-11-03' }, 2)));
        }
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        return undefined;
      });
      await p.getByTestId('routine-day-2').locator('.routine-slide-meta').waitFor({ timeout: 15000 });
      await p.waitForTimeout(300);
      ctl.list = [ses2('e2', '2026-11-03', 2, 5), ctl.list[0]];
      ctl.hold = true;
      await refresh(p);
      await p.getByTestId('routine-day-2').filter({ hasText: '마지막 11월 3일' }).waitFor({ timeout: 5000 }).catch(() => {});
      const pendingCard = await p.getByTestId('routine-day-2').innerText();
      release();
      check('2차 P2-1: 요약을 기다리는 동안에도 받아 둔 기록으로 같은 날의 루틴 진행을 보임', pendingCard.includes('마지막 11월 3일'), pendingCard.replace(/\s+/g, ' ').slice(0, 80));
      await p.close();
    }
  });
  // Codex v2.2.0 2차 리뷰 P2-2: 최근 30개 밖의 이력을 바꾼 가져오기 뒤 비교를 새로 받지 못하면 옛 최고 표시를 쓰지 않음
  await soft('2.2 2차 리뷰 P2-2 목록 밖 이력 변경 뒤 비교 실패', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const thirty = Array.from({ length: 30 }, (_, i) => ses21(`h${i}`, `2026-1${i < 2 ? '1-0' + (2 - i) : '0-' + String(31 - i).padStart(2, '0')}`, 1, [set21('스쿼트', i === 0 ? '50' : '30', '10')]));
    const ctl = { imported: false, fail: false, cmpCalls: 0 };
    await p.route('**/functions/v1/sheet-import*', (r) => {
      const b = r.request().postDataJSON();
      if (b.mode === 'records_all') {
        if (b.preview) return fulfill(r, { status: 'preview', removes: 0, tabs: [{ tab: '2609', sessions: 1, skipped: 0, problems: [] }] });
        ctl.imported = true;
        ctl.fail = true;
        return fulfill(r, { status: 'imported', saved: 1, skipped: 0, removed: 0, problems: [] });
      }
      return fulfill(r, { status: 'fresh', version: null });
    });
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [cur21, prev21]);
      if (path.endsWith('/workout_sessions')) return fulfill(r, thirty);
      if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
      if (path.endsWith('/rpc/workout_overview')) return fulfill(r, { this_week: 1, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: null });
      if (path.endsWith('/rpc/workout_compare')) {
        ctl.cmpCalls++;
        if (ctl.fail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        // 가져오기 전에는 목록 밖 최고가 40 → 50이 최고 · 가져온 뒤(목록 밖 9월 기록이 60)에는 최고 아님
        return fulfill(r, { h0: { 스쿼트: { prior: [ctl.imported ? 60 : 40], prev: '30' } } });
      }
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await recordsTab(p);
    const top = p.locator('.record-row').first();
    await top.locator('.record-lift .record-pr').waitFor({ timeout: 15000 });
    await p.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
    await p.getByTestId('sheet-records').getByRole('button', { name: '가져오기', exact: true }).click();
    const failNote = p.locator('.stale-notice', { hasText: '최고 기록·이전 기록보다 오른 무게를 불러오지 못했어요' });
    await failNote.waitFor({ timeout: 5000 }).catch(() => {});
    const afterFail = (await top.innerText()).replace(/\s+/g, ' ');
    check('2차 P2-2: 최근 30개는 그대로인데 목록 밖 이력이 바뀐 가져오기 뒤 비교가 실패하면 50kg에 옛 최고를 붙이지 않고 그 이유를 알림', !afterFail.includes('최고') && (await failNote.count()) === 1 && ctl.cmpCalls >= 2, JSON.stringify({ afterFail: afterFail.slice(0, 90), cmpCalls: ctl.cmpCalls }));
    ctl.fail = false;
    await failNote.getByRole('button').click();
    await failNote.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    check('2차 P2-2: 다시 불러오기에 성공하면 새 비교(목록 밖 60kg)로 — 50kg은 최고 아님, 안내 사라짐', (await failNote.count()) === 0 && !(await top.innerText()).includes('최고'));
    await p.close();
  });
  // 2차 리뷰 반영 뒤 적대 검토: 시트 연결을 풀면(목록 밖 시트 기록 삭제) 비교를 새로 받음 · 저장 한 번에 요약·비교도 한 번씩 · 목록 밖 진행을 못 받으면 루틴 탭에도 알림
  await soft('2.2 2차 리뷰 뒤 적대 검토: 연결 변경·저장 뒤 보조 조회', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => ses21(`k${i}`, `2026-1${i < 2 ? '1-0' + (2 - i) : '0-' + String(31 - i).padStart(2, '0')}`, 1, [set21('스쿼트', i === 0 ? '50' : '30', '10')]));
    // ① 연결 풀기: 최근 30개는 그대로 · 서버에서는 목록 밖 시트 기록(60kg)이 지워져 50kg이 최고가 됨
    {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      const ctl = { linked: true, cmp: 0 };
      await p.route('**/functions/v1/sheet-import*', (r) => fulfill(r, { status: 'fresh', version: null }));
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routines')) return fulfill(r, [cur21, prev21]);
        if (path.endsWith('/workout_sessions')) return fulfill(r, thirty);
        if (path.endsWith('/routine_sources')) return fulfill(r, ctl.linked ? { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' } : null);
        if (path.endsWith('/rpc/set_routine_sheet')) { ctl.linked = false; return fulfill(r, { status: 'ok' }); }
        if (path.endsWith('/rpc/workout_overview')) return fulfill(r, { this_week: 1, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: null });
        if (path.endsWith('/rpc/workout_compare')) { ctl.cmp++; return fulfill(r, { k0: { 스쿼트: { prior: [ctl.linked ? 60 : 40], prev: '30' } } }); }
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await p.getByTestId('sheet-line').getByRole('button', { name: '바꾸기' }).click();
      await p.getByTestId('sheet-link-form').getByRole('button', { name: '연결 풀기' }).click();
      await p.getByTestId('sheet-link-form').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await recordsTab(p);
      const top = p.locator('.record-row').first();
      await top.locator('.record-lift .record-pr').waitFor({ timeout: 5000 }).catch(() => {});
      check('적대 검토 F1: 시트 연결을 풀면(목록 밖 시트 기록 삭제) 최근 30개가 같아도 비교를 새로 받아 50kg이 최고', (await top.locator('.record-lift .record-pr').count()) === 1 && ctl.cmp >= 2, JSON.stringify({ cmp: ctl.cmp, row: (await top.innerText()).replace(/\s+/g, ' ').slice(0, 80) }));
      await p.close();
    }
    // ② 저장 한 번: 요약·비교를 한 번씩만 다시 받음(저장 뒤 version과 목록 내용이 차례로 바뀌어 두 번씩 받던 것)
    {
      const ctl = { kg: '50', ov: 0, cmp: 0 };
      const p = await workoutPage([], (path, r) => {
        if (path.endsWith('/workout_sessions')) return fulfill(r, [ses21('w1', '2026-11-03', 1, [set21('스쿼트', ctl.kg, '10')])]);
        if (path.endsWith('/rpc/workout_overview')) { ctl.ov++; return fulfill(r, { this_week: 1, this_month: 1, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: null }); }
        if (path.endsWith('/rpc/workout_compare')) { ctl.cmp++; return fulfill(r, {}); }
        if (path.endsWith('/rpc/save_workout')) { ctl.kg = '55'; return fulfill(r, '2026-11-03T02:00:00Z'); }
        return undefined;
      });
      await recordsTab(p);
      await p.locator('.record-row').first().waitFor({ timeout: 15000 });
      await p.waitForTimeout(600);
      const before = { ov: ctl.ov, cmp: ctl.cmp };
      await p.locator('.record-row').first().click();
      await p.getByLabel('스쿼트 1세트 중량').fill('55');
      await p.getByRole('button', { name: '운동 기록 저장' }).click();
      await p.locator('.record-row', { hasText: '55kg' }).waitFor({ timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(800);
      check('적대 검토 F3: 저장 한 번에 요약·비교를 한 번씩만 다시 받음', ctl.ov - before.ov === 1 && ctl.cmp - before.cmp === 1, JSON.stringify({ before, after: { ov: ctl.ov, cmp: ctl.cmp } }));
      await p.close();
    }
    // ③ 기록이 30개를 넘는 회원: 시트 가져오기 뒤 요약을 받지 못하면 목록 밖 진행(루틴 2 10월 1일)을 옛 요약으로 쓰지 않고 루틴 탭에도 알림
    {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      const ctl = { fail: false };
      await p.route('**/functions/v1/sheet-import*', (r) => {
        const b = r.request().postDataJSON();
        if (b.mode === 'records_all') {
          if (b.preview) return fulfill(r, { status: 'preview', removes: 1, tabs: [] });
          ctl.fail = true;
          return fulfill(r, { status: 'imported', saved: 0, skipped: 0, removed: 1, problems: [] });
        }
        return fulfill(r, { status: 'fresh', version: null });
      });
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routines')) return fulfill(r, [{ ...cur21, created_at: '2026-09-01T01:00:00Z' }, prev21]); // 9월에 받은 판 — 목록 밖(10월 1일)에도 이 판의 기록이 있을 수 있음
        if (path.endsWith('/workout_sessions')) return fulfill(r, thirty);
        if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
        if (path.endsWith('/rpc/workout_overview')) return ctl.fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, { this_week: 1, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: { id: cur21.id, last: { 1: '2026-11-02', 2: '2026-10-01' }, latest_day_no: 1 } });
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      const card2 = p.getByTestId('routine-day-2');
      await card2.filter({ hasText: '마지막 10월 1일' }).waitFor({ timeout: 15000 });
      await recordsTab(p);
      await p.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
      await p.getByTestId('sheet-records').getByRole('button', { name: '시트와 맞추기' }).click();
      await p.locator('.stale-notice', { hasText: '운동 횟수·달력을' }).waitFor({ timeout: 5000 }).catch(() => {});
      await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '루틴', exact: true }).click();
      const note = p.locator('.stale-notice', { hasText: '최근 30개 밖의 운동 진행을 불러오지 못해' });
      await note.waitFor({ timeout: 5000 }).catch(() => {});
      const t2 = (await card2.innerText()).replace(/\s+/g, ' ');
      check('적대 검토 F4: 시트 맞추기 뒤 요약을 받지 못하면 목록 밖 진행(옛 요약의 루틴 2 10월 1일)을 쓰지 않고 루틴 탭에 알림', !t2.includes('마지막 10월 1일') && (await note.count()) === 1, t2.slice(0, 80));
      await p.close();
    }
  });
  // Codex v2.2.0 3차 리뷰 P2: 목록 밖 기록을 바꾼 시트 맞추기 뒤 새 요약을 기다리는 동안 옛 요약의 진행(마지막 날·한 바퀴)을 쓰지 않음
  //  · 기다리는 동안 '확인 중' · 받으면 실제로 남은 목록 밖 진행을 되살림 · 늦게 끝난 이전 세대의 응답은 버림
  await soft('2.2 3차 리뷰 P2 목록 밖 진행 확인 중', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => ses21(`q${i}`, `2026-1${i < 2 ? '1-0' + (2 - i) : '0-' + String(31 - i).padStart(2, '0')}`, 1, [set21('스쿼트', '30', '10')]));
    const ovOf = (last) => ({ this_week: 1, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: { id: cur21.id, last, latest_day_no: 1 } });
    const withR2 = ovOf({ 1: '2026-11-02', 2: '2026-10-01' }), noR2 = ovOf({ 1: '2026-11-02' });
    const run = async (label, answers) => {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      // 요약 요청마다 차례로: 첫 요청은 바로 withR2, 그 뒤는 answers의 지시(hold = 붙잡았다가 release로 풂)
      const queue = [{ body: withR2 }, ...answers];
      const held = [];
      await p.route('**/functions/v1/sheet-import*', (r) => {
        const b = r.request().postDataJSON();
        if (b.mode === 'records_all') return fulfill(r, b.preview ? { status: 'preview', removes: 1, tabs: [] } : { status: 'imported', saved: 0, skipped: 0, removed: 1, problems: [] });
        return fulfill(r, { status: 'fresh', version: null });
      });
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routines')) return fulfill(r, [{ ...cur21, created_at: '2026-09-01T01:00:00Z' }, prev21]); // 9월에 받은 판 — 목록 밖(10월 1일)에도 이 판의 기록이 있을 수 있음
        if (path.endsWith('/workout_sessions')) return fulfill(r, thirty);
        if (path.endsWith('/routine_sources')) return fulfill(r, { sheet_id: 'zzcheckaaaaaaaaaaaaaaaaaaaa', last_read_at: '2026-11-03T00:30:00Z', last_error: '' });
        if (path.endsWith('/rpc/workout_overview')) {
          const a = queue.shift() ?? { body: withR2 };
          if (!a.hold) return fulfill(r, a.body);
          return new Promise((res) => held.push(res)).then(() => fulfill(r, a.body));
        }
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      const card2 = p.getByTestId('routine-day-2');
      await card2.filter({ hasText: '마지막 10월 1일' }).waitFor({ timeout: 15000 });
      const sync = async () => {
        await recordsTab(p);
        await p.getByRole('button', { name: '시트의 지난 기록 가져오기' }).click();
        await p.getByTestId('sheet-records').getByRole('button', { name: '시트와 맞추기' }).click();
        await p.getByTestId('sheet-records').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '루틴', exact: true }).click();
      };
      return { p, card2, held, sync, text: async () => (await card2.innerText()).replace(/\s+/g, ' '), update: async () => ((await p.getByTestId('routine-update').count()) ? (await p.getByTestId('routine-update').innerText()).replace(/\s+/g, ' ') : '') };
    };
    // ① 지운 경우: 기다리는 동안 '확인 중'·한 바퀴로 치지 않음 → 받으면 '아직 안 함'
    {
      const t = await run('deleted', [{ hold: true, body: noR2 }]);
      await t.sync();
      await t.card2.filter({ hasText: '확인 중' }).waitFor({ timeout: 5000 }).catch(() => {});
      const pending = await t.text(), upd = await t.update();
      t.held.forEach((f) => f());
      await t.card2.filter({ hasText: '아직 안 함' }).waitFor({ timeout: 5000 }).catch(() => {});
      check('3차 P2: 시트 맞추기 뒤 새 요약을 기다리는 동안 목록 밖 진행은 확인 중(옛 마지막 10월 1일·한 바퀴 완료를 쓰지 않음 · 한 바퀴 칸도 확인 중) → 받으면 아직 안 함', pending.includes('확인 중') && !pending.includes('마지막 10월 1일') && !upd.includes('지난 루틴 업데이트') && upd.includes('루틴 2 · 확인 중') && (await t.text()).includes('아직 안 함'), JSON.stringify({ pending: pending.slice(0, 60), upd: upd.slice(0, 40), after: (await t.text()).slice(0, 60) }));
      await t.p.close();
    }
    // ② 남아 있는 경우: 기다리는 동안 확인 중 → 받으면 목록 밖 진행(10월 1일)을 되살림
    {
      const t = await run('kept', [{ hold: true, body: withR2 }]);
      await t.sync();
      await t.card2.filter({ hasText: '확인 중' }).waitFor({ timeout: 5000 }).catch(() => {});
      const pending = await t.text();
      t.held.forEach((f) => f());
      await t.card2.filter({ hasText: '마지막 10월 1일' }).waitFor({ timeout: 5000 }).catch(() => {});
      check('3차 P2: 새 요약을 받으면 실제로 남은 목록 밖 진행(루틴 2 마지막 10월 1일)을 되살림', pending.includes('확인 중') && (await t.text()).includes('마지막 10월 1일'));
      await t.p.close();
    }
    // ③ 늦게 끝난 이전 세대의 응답: 첫 맞추기의 요약(옛 값)을 붙잡아 둔 채 두 번째 맞추기의 요약(지운 값)이 먼저 오면, 늦게 온 옛 값은 버림
    {
      const t = await run('late', [{ hold: true, body: withR2 }, { body: noR2 }]);
      await t.sync();
      await t.sync();
      await t.card2.filter({ hasText: '아직 안 함' }).waitFor({ timeout: 5000 }).catch(() => {});
      t.held.forEach((f) => f());
      await t.p.waitForTimeout(600);
      check('3차 P2: 이전 세대의 요약이 늦게 와도 버림(루틴 2 아직 안 함 유지)', (await t.text()).includes('아직 안 함') && !(await t.text()).includes('마지막 10월 1일'), (await t.text()).slice(0, 60));
      await t.p.close();
    }
  });
  // Codex v2.2.0 4차 리뷰 P2: 최근 30개가 유산소뿐이고 이 판의 루틴 기록은 그 밖에만 있으면, 요약을 받기 전 카드는 '확인 중'
  //  · 요약 대기 중에 연 기록 창은 요약이 와도 적던 값 그대로 · 기록 창에도 다음 차례 표시 없음(사용자 11-06)
  await soft('2.2 4차 리뷰 P2 목록 밖 진행과 기록 창', async () => {
    const r10 = { ...cur21, created_at: '2026-10-01T01:00:00Z' };
    const cardioOnly = Array.from({ length: 30 }, (_, i) => ({ ...ses21(`c${i}`, `2026-1${i < 2 ? '1-0' + (2 - i) : '0-' + String(31 - i).padStart(2, '0')}`, null, [], null, [{ kind: 'run', minutes: '30.0', km: null, speed: null, ord: 1 }]) }));
    const ov = { this_week: 1, this_month: 2, streak_weeks: 1, from: '2026-10-04', today: '2026-11-03', days: [], routine: { id: r10.id, last: { 1: '2026-10-01' }, latest_day_no: 1 } }; // 최근 30개(10월 2일～11월 2일) 밖
    const page = async (mode) => {
      let release = () => {};
      const p = await workoutPage([], (path, r) => {
        if (path.endsWith('/routines')) return fulfill(r, [r10, prev21]);
        if (path.endsWith('/workout_sessions')) return fulfill(r, cardioOnly);
        if (path.endsWith('/rpc/workout_overview')) {
          if (mode === 'fail') return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          return new Promise((res) => (release = res)).then(() => fulfill(r, ov));
        }
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        return undefined;
      });
      await p.getByTestId('routine-day-1').waitFor({ timeout: 15000 });
      return { p, release: () => release() };
    };
    // ① 요약 대기·도착 모두 기록 창에 다음 차례 없음 · 적던 무게와 고른 루틴은 그대로
    {
      const { p, release } = await page('hold');
      await p.waitForTimeout(400);
      const card1 = (await p.getByTestId('routine-day-1').innerText()).replace(/\s+/g, ' ');
      await p.getByTestId('start-workout').click();
      const pick = p.getByRole('group', { name: '오늘 할 루틴' });
      await pick.waitFor({ timeout: 5000 });
      const formBefore = await pick.innerText();
      await p.getByLabel('스쿼트 1세트 중량').fill('77');
      release();
      await p.waitForFunction(() => !document.querySelector('[data-testid="routine-day-1"]')?.textContent?.includes('확인 중'), null, { timeout: 5000 }).catch(() => {});
      const formAfter = await pick.innerText();
      const kept = await p.getByLabel('스쿼트 1세트 중량').inputValue();
      const cardAfter = (await p.getByTestId('routine-day-1').innerText()).replace(/\s+/g, ' ');
      check('4차 P2: 요약 대기 중 카드는 확인 중 · 기록 창에 다음 차례 없음', card1.includes('확인 중') && !formBefore.includes('다음 차례'), JSON.stringify({ formBefore, card1: card1.slice(0, 60) }));
      check('4차 P2: 요약이 와도 기록 창에 다음 차례 없음 · 적던 무게(77)와 고른 루틴은 그대로', !cardAfter.includes('확인 중') && !formAfter.includes('다음 차례') && kept === '77' && (await pick.getByRole('button', { name: /루틴 1/ }).getAttribute('aria-pressed')) === 'true', JSON.stringify({ formAfter, kept, cardAfter: cardAfter.slice(0, 60) }));
      await p.getByRole('button', { name: '창 닫기' }).click();
      const discard = p.getByRole('button', { name: /버리고 닫기|닫기/ });
      if (await p.getByRole('dialog').count()) await discard.first().click().catch(() => {});
      await p.close();
    }
    // ② 요약 실패: 루틴 탭에 다시 불러오기 안내
    {
      const { p } = await page('fail');
      const note = p.locator('.stale-notice', { hasText: '최근 30개 밖의 운동 진행을 불러오지 못해' });
      await note.waitFor({ timeout: 5000 }).catch(() => {});
      check('4차 P2: 요약을 받지 못하면 루틴 탭에 다시 불러오기', (await note.count()) === 1);
      await p.close();
    }
  });
  // Codex 4차 리뷰 P2: 보조 조회(요약·비교)가 늦어도 루틴·기록·운동 시작은 바로 쓴다 · 앱을 켜 둔 채 달이 바뀌면 새 달로 다시 받아 지난달 횟수를 새 달 이름 아래 보이지 않는다
  await soft('2.1 보조 조회 지연·날짜 바뀜', async () => {
    const sessions = [ses21('s1', '2026-11-30', 1, [set21('스쿼트', '70', '8')])];
    for (const hold of ['workout_overview', 'workout_compare']) {
      let release;
      const gate = new Promise((r) => (release = r));
      const p = await workoutPage(sessions, (path, r) => {
        if (path.endsWith(`/rpc/${hold}`)) return gate.then(() => fulfill(r, hold === 'workout_overview' ? { this_week: 1, this_month: 1, streak_weeks: 1, from: '2026-10-26', today: '2026-11-03', days: [], routine: null } : {}));
        if (path.endsWith('/rpc/workout_overview')) return fulfill(r, { this_week: 1, this_month: 1, streak_weeks: 1, from: '2026-10-26', today: '2026-11-03', days: [], routine: null });
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        return undefined;
      });
      const t0 = Date.now();
      await p.getByTestId('routine-day-1').waitFor({ timeout: 5000 });
      const startReady = await p.getByTestId('start-workout').isEnabled();
      await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
      await p.locator('.record-row').first().waitFor({ timeout: 5000 });
      const ms = Date.now() - t0;
      const loadingNote = hold === 'workout_overview' ? await p.getByTestId('records-summary-loading').count() : await p.getByTestId('records-summary').count();
      check(`4차 P2-2: ${hold === 'workout_overview' ? '요약' : '비교'} 응답을 붙잡아 둬도 루틴 카드·운동 시작·기록 카드가 바로 보임(그 칸만 읽는 중)`, startReady && ms < 4000 && loadingNote === 1, JSON.stringify({ ms, loadingNote }));
      release();
      await p.close();
    }
    // 11월 30일 23:59:50에 운동 기록을 보는 중 자정을 넘김 → 새 날짜로 요약을 다시 받는다(그사이 '12월 31회'를 한 번도 보이지 않음)
    const calls = [];
    const p = await workoutPage(sessions, (path, r) => {
      if (path.endsWith('/rpc/workout_overview')) {
        const day = r.request().postDataJSON()?.p_today;
        calls.push(day);
        return fulfill(r, day === '2026-11-30' ? { this_week: 2, this_month: 31, streak_weeks: 5, from: '2026-10-26', today: day, days: [], routine: null } : { this_week: 0, this_month: 0, streak_weeks: 5, from: '2026-11-02', today: day, days: [], routine: null });
      }
      if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
      return undefined;
    }, '2026-11-30T23:59:50+09:00');
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    const tiles = p.getByTestId('records-summary').locator('.records-tiles');
    await tiles.filter({ hasText: '11월31회' }).or(tiles.filter({ hasText: '11월 31회' })).first().waitFor({ timeout: 5000 }).catch(() => {});
    const before = (await tiles.innerText()).replace(/\s+/g, ' ');
    await p.evaluate(() => {
      window.__tiles = [];
      const el = document.querySelector('[data-testid=records-summary] .records-tiles');
      new MutationObserver(() => window.__tiles.push(el.textContent)).observe(el, { subtree: true, childList: true, characterData: true });
    });
    await p.clock.fastForward(15_000);
    await tiles.filter({ hasText: '12월' }).waitFor({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(300);
    const after = (await tiles.innerText()).replace(/\s+/g, ' ');
    const seen = await p.evaluate(() => window.__tiles);
    check("4차 P2-3: 앱을 켜 둔 채 자정을 넘기면 새 날짜로 다시 받아 '12월 0회'(그사이 '12월 31회'를 보이지 않음)",
      before.includes('11월 31회') && after.includes('12월 0회') && calls.join() === '2026-11-30,2026-12-01' && !seen.some((x) => /12월\s*31회/.test(x)), JSON.stringify({ before, after, calls, seen }));
    await p.close();
  });

  // Codex 3차 리뷰 P2-4: 새 판(11/1)을 받기 전 시트 회차(10/31, 다시 가져와 새 판의 루틴 1을 가리킴)·완료하지 않은 초안(11/2 루틴 1)
  //  — 진행에 세지 않아 카드는 '아직 안 함' · 기록 창에 다음 차례 표시 없음(사용자 11-06)
  await soft('2.1 판을 받기 전 기록과 기록 창', async () => {
    const fresh = { ...cur21, created_at: '2026-11-01T01:00:00Z' };
    const sheetOld = { ...ses21('old-sheet', '2026-10-31', 1, [set21('스쿼트', '70', '8')]), source: 'sheet', sheet_tab: '2611', sheet_col: 4 };
    const draft = ses21('draft', '2026-11-02', 1, [set21('스쿼트', '45', '12', false)]); // 완료하지 않은 초안
    for (const [label, overview] of [['서버 요약 있음', { this_week: 1, this_month: 1, streak_weeks: 1, from: '2026-10-05', days: [], routine: { id: fresh.id, last: {}, latest_day_no: null } }], ['서버 요약 없음(받아 둔 기록으로)', null]]) {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routines')) return fulfill(r, [fresh, prev21]);
        if (path.endsWith('/workout_sessions')) return fulfill(r, [draft, sheetOld]);
        if (path.endsWith('/rpc/workout_overview')) return overview ? fulfill(r, overview) : r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        if (path.endsWith('/rpc/workout_compare')) return fulfill(r, {});
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await p.getByTestId('routine-day-1').waitFor({ timeout: 15000 });
      const cardMeta = await p.getByTestId('routine-day-1').locator('.routine-slide-meta').innerText();
      await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
      await p.getByTestId('start-workout').click();
      const pick = p.getByRole('group', { name: '오늘 할 루틴' });
      await pick.waitFor({ timeout: 5000 });
      const formText = await pick.innerText();
      check(`3차 P2-4(${label}): 판을 받기 전 시트 회차·완료 안 한 초안은 빼고 카드는 '아직 안 함' · 기록 창에 다음 차례 없음 · 미리 고르지 않음`,
        cardMeta.includes('아직 안 함') && !formText.includes('다음 차례') && (await pick.locator('button[aria-pressed=true]').count()) === 0, JSON.stringify({ cardMeta, formText }));
      await p.close();
    }
  });

  // 34) v2.1 인바디 탭(변화 카드와 합침): 두 번 이상 측정하면 그래프 — 항목을 바꾸면 그 값으로, 값을 비운 측정은 그 항목에서 뺌
  await soft('2.1 인바디 그래프', async () => {
    const rec = (id, day, w, smm, pbf) => ({ id, member_id: a, measured_on: day, weight_kg: w, smm_kg: smm, pbf_pct: pbf, source: 'manual', created_at: `${day}T01:00:00Z` });
    const p = await workoutPage([], (path, r) => {
      if (path.endsWith('/inbody_records')) return fulfill(r, [rec('i3', '2026-10-22', 71.7, 31.2, null), rec('i2', '2026-10-01', 72.5, 30.8, 23.1), rec('i1', '2026-09-15', 73.9, 30.1, 24.0)]);
      if (path.endsWith('/rpc/diet_report')) return fulfill(r, { days: 37, logged_days: 20, meals: 30, rated: 25, great: 10, good: 10, care: 5, score: 3.4 });
      if (path.endsWith('/rpc/workout_summary')) return fulfill(r, { days: 2, done_sets: 7, cardio_count: 0, cardio_minutes: '0', cardio_km: '0' });
      return undefined;
    });
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
    const chart = p.getByTestId('inbody-chart');
    await chart.waitFor({ timeout: 15000 });
    const w = await chart.locator('svg').getAttribute('aria-label');
    await chart.getByRole('button', { name: '체지방률' }).click();
    const pbf = await chart.innerText();
    const pbfLabel = await chart.locator('svg').getAttribute('aria-label');
    check('체중 그래프(오래된 측정부터 3점) · 체지방률로 바꾸면 값이 있는 2점만', w === '체중 변화: 09/15 73.9, 10/01 72.5, 10/22 71.7' && pbf.includes('최근 2번 측정') && pbfLabel === '체지방률 변화: 09/15 24, 10/01 23.1', JSON.stringify({ w, pbfLabel }));
    await p.getByText(/운동한 날 2일/).first().waitFor({ timeout: 10000 }).catch(() => {});
    check('같은 탭에 그래프 · 변화 카드 · 측정 기록', (await p.getByText(/운동한 날 2일/).count()) >= 1 && (await p.getByText('날짜별 기록').count()) === 1);
    await p.close();
  });

  // 35) v2.1 식단 탭(2026-11-03 사용자 확정 시안): 끼니 칸 · 빈 끼니로 바로 기록 · 하루 평가 요약 · 날짜 띠 평가 색 · 아래 버튼과 아래 탭 사이 틈 없음(사용자 제보)
  await soft('2.1 식단 끼니 칸', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const meal = (n, day, type, rating, extra = {}) => ({ id: `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`, member_id: a, eaten_on: day, eaten_at: `${String(7 + n).padStart(2, '0')}:00:00`, meal_type: type, food: `${type} 검증 식사 ${n}`, note: '', photo_path: null, created_at: `${day}T0${n}:00:00Z`, reviewed_at: rating ? `${day}T09:00:00Z` : null, member_seen_at: null, note_updated_at: null, member_msg_at: null, trainer_msg_at: null, rating, rated_at: rating ? `${day}T09:00:00Z` : null, shared_at: null, comments: [], member: { nickname: '검증 회원' }, ...extra });
    const rows = [meal(1, '2026-11-03', '점심', 1), meal(2, '2026-11-03', '간식', null), meal(3, '2026-11-03', '간식', null), meal(4, '2026-11-02', '저녁', 3), meal(5, '2026-11-02', '점심', 1)];
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/meals')) return fulfill(r, rows);
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 2, best: 2, today_logged: true });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    const lunch = p.getByTestId('meal-slot-점심');
    await lunch.waitFor({ timeout: 15000 });
    check('끼니 칸: 기록한 끼니는 카드, 같은 끼니 여럿은 수, 빈 끼니는 그 끼니로 기록하는 칸', (await lunch.innerText()).includes('점심 검증 식사 1') && (await p.getByTestId('meal-slot-간식').innerText()).includes('2끼') && (await p.getByTestId('meal-slot-아침').getByRole('button', { name: '아침 기록하기' }).count()) === 1 && (await p.getByTestId('meal-slot-저녁').getByRole('button', { name: '저녁 기록하기' }).count()) === 1);
    const ratings = (await p.getByTestId('day-ratings').innerText()).replace(/\s+/g, ' ');
    check('하루 평가 요약: 평가별 수 · 확인 대기', ratings.includes('오늘 평가') && ratings.includes('아주 좋아요 1') && ratings.includes('확인 대기 2'), ratings);
    const dotOf = async (day) => p.locator('.week-strip .day-button').filter({ hasText: new RegExp(`^\\D*${day}\\D*$`) }).locator('.day-dot').first().getAttribute('class');
    const dots = { d3: await dotOf(3), d2: await dotOf(2) };
    check('날짜 띠: 평가한 날은 색 막대(조절 필요가 있으면 그 색) · 색 설명', dots.d3.includes('great') && dots.d2.includes('care') && (await p.locator('.tone-legend').count()) === 1, JSON.stringify(dots));
    // 아래 버튼(사용자 제보 두 번, 11-03): 본문 스크롤 영역 밖, 아래 탭 바로 위 칸에 있다 — 스크롤 중에도 카드와 겹치지 않고(틈·바탕색 띠 없음),
    // 목록이 짧아도 글 아래에 떠 있지 않는다
    await p.locator('.app-main').evaluate((el) => el.scrollTo(0, 120));
    await p.waitForTimeout(200);
    const lay = await p.evaluate(() => {
      const m = document.querySelector('.app-main').getBoundingClientRect(), bar = document.querySelector('.action-bar').getBoundingClientRect(), nav = document.querySelector('.bottom-nav').getBoundingClientRect();
      return { mainToBar: Math.round(bar.top - m.bottom), barToNav: Math.round(nav.top - bar.bottom), inMain: !!document.querySelector('.app-main [data-testid=add-meal]') };
    });
    check('아래 버튼은 본문 밖, 본문 끝과 아래 탭 사이 칸에 붙어 있음(겹침·틈 없음)', Math.abs(lay.mainToBar) <= 1 && Math.abs(lay.barToNav) <= 1 && !lay.inMain && (await p.getByTestId('add-meal').count()) === 1, JSON.stringify(lay));
    await p.getByTestId('meal-slot-아침').getByRole('button', { name: '아침 기록하기' }).click();
    await p.getByRole('button', { name: '아침', pressed: true }).waitFor({ timeout: 5000 });
    check('빈 끼니 칸을 누르면 그 끼니가 골라진 기록 창', (await p.getByRole('button', { name: '아침', pressed: true }).count()) === 1);
    await p.close();
  });

  // 2026-11-03 사용자 제보(안드로이드 — 등록·수정 모두 사진이 안 들어감): 사진을 열지 못하면 이유가 사진 칸 아래와 맨 위층 안내에 보이고
  //  (예전에는 짧은 안내가 기록 창 뒤에 가려 아무 반응이 없는 것처럼 보였다), 같은 사진을 다시 골라도 다시 읽고, 열 수 있는 사진은 미리보기가 생긴다
  await soft('사진을 열지 못하면 보이는 안내', async () => {
    const p = await ctx.newPage();
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.getByTestId('add-meal').click();
    const input = p.getByLabel('식사 사진 선택');
    const heic = { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not an image') };
    await input.setInputFiles(heic);
    const err = p.getByTestId('photo-error');
    await err.waitFor({ timeout: 5000 });
    const msg = await err.innerText();
    const onTop = await p.evaluate(() => { const t = document.querySelector('.toast'); return !!t && typeof t.showPopover === 'function' ? t.matches(':popover-open') : 'no-popover'; });
    const cleared = await input.inputValue();
    await p.evaluate(() => (window.__picks = 0));
    await input.setInputFiles(heic); // 같은 사진을 다시 골라도 다시 읽는다
    await err.waitFor({ timeout: 5000 });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await input.setInputFiles({ name: 'meal.png', mimeType: 'image/png', buffer: png });
    await p.locator('.meal-photo-has img').waitFor({ timeout: 5000 });
    check('사진을 열지 못하면 사진 칸 아래에 이유(HEIC면 할 일) · 안내는 기록 창 위층 · 같은 사진을 다시 골라도 읽음 · 열 수 있는 사진은 미리보기',
      msg.includes('HEIC') && (onTop === true || onTop === 'no-popover') && cleared === '' && (await err.count()) === 0, JSON.stringify({ msg, onTop, cleared }));
    await p.close();
  });

  // 2026-11-03 사용자 요청: 사용 안내의 '운동 시트 연결'에서 바로 연결 화면으로(회원) — 그림 안내에서도
  await soft('사용 안내 → 시트 연결 화면', async () => {
    const p = await ctx.newPage();
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.getByTestId('help-button').click();
    const guide = p.getByTestId('start-guide');
    for (let i = 0; i < 6 && !(await guide.getByRole('button', { name: '지금 연결하기' }).count()); i++) await guide.getByRole('button', { name: '다음' }).click();
    await guide.getByRole('button', { name: '그림으로 연결 방법 보기' }).click();
    const fromPictures = await p.getByTestId('sheet-guide').getByRole('button', { name: '지금 연결하기' }).count();
    await p.getByTestId('sheet-guide').getByRole('button', { name: '지금 연결하기' }).click();
    await p.getByTestId('sheet-link-form').waitFor({ timeout: 5000 });
    check("사용 안내의 시트 쪽·그림 안내에서 '지금 연결하기'로 연결 화면(세 단계)이 바로 열림", fromPictures === 1 && (await p.locator('.sheet-step').count()) === 3 && (await p.getByLabel('시트 링크').count()) === 1);
    await p.close();
  });

  // 36) v2.1 트레이너 회원 탭(시안): 회원별 하루 카드(끼니 사진 네 칸·미확인·답변 대기·연속) · 질문 많은 회원부터 · 오늘 기록 없는 회원에게 기록 알림(하루 한 번)
  await soft('2.1 트레이너 회원 하루 카드', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const m1 = '11111111-1111-4111-8111-0000000000c1', m2 = '11111111-1111-4111-8111-0000000000c2', m3 = '11111111-1111-4111-8111-0000000000c3';
    const members = [{ id: m1, nickname: '가 회원' }, { id: m2, nickname: '나 회원' }, { id: m3, nickname: '다 회원' }];
    const meal = (n, member, nick, type, extra = {}) => ({ id: `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`, member_id: member, eaten_on: '2026-11-03', eaten_at: `0${n}:30:00`, meal_type: type, food: `${nick} ${type}`, note: '', photo_path: null, created_at: `2026-11-03T0${n}:00:00Z`, reviewed_at: null, member_seen_at: null, note_updated_at: null, member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: nick }, ...extra });
    // 나 회원: 질문 하나(답할 것) — 맨 위 · 가 회원: 확인할 식사 하나 · 다 회원: 오늘 기록 없음 — 맨 아래
    const meals = [meal(1, m1, '가 회원', '아침'), meal(2, m2, '나 회원', '점심', { note: '닭가슴살 대신 두부 괜찮을까요?', member_msg_at: '2026-11-03T02:00:00Z' })];
    const nudges = [];
    let reply = 'sent', mealLoads = 0;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, members.map((m) => ({ member_id: m.id, member: { nickname: m.nickname } })));
      if (path.endsWith('/profiles')) return fulfill(r, members.map((m) => ({ id: m.id, share_consent: true })));
      if (path.endsWith('/meals')) { mealLoads++; return fulfill(r, meals); }
      if (path.endsWith('/rpc/member_streaks')) return fulfill(r, [{ member_id: m1, current_streak: 5, today_logged: true }, { member_id: m3, current_streak: 3, today_logged: false }]);
      if (path.endsWith('/rpc/nudge_member')) { nudges.push(r.request().postDataJSON().p_member); return fulfill(r, reply); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=trainer`);
    await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
    const cards = p.getByTestId('member-day');
    await cards.first().waitFor({ timeout: 15000 });
    const names = (await cards.locator('.member-day-head strong').allInnerTexts()).join('|');
    check('답할 질문이 있는 회원 → 확인할 식사가 있는 회원 → 오늘 기록 없는 회원 순서', names === '나 회원 회원|가 회원 회원|다 회원 회원', names);
    const ga = (await cards.nth(1).innerText()).replace(/\s+/g, ' ');
    check('하루 카드: 오늘 끼니 수 · 미확인 · 연속 일수 · 끼니 네 칸(빈 칸은 끼니 이름)', ga.includes('오늘 1끼') && ga.includes('미확인 1') && ga.includes('5일 연속') && (await cards.nth(1).locator('.member-day-cell').count()) === 4 && (await cards.nth(1).locator('.member-day-cell.is-empty').count()) === 3, ga);
    check('질문이 있는 끼니 칸에 ? 표시 · 답변 대기 수', (await cards.nth(0).locator('.member-day-q').count()) === 1 && (await cards.nth(0).innerText()).includes('답변 대기 1'));
    check('오늘 기록이 있는 회원에게는 기록 알림 버튼 없음, 없는 회원(어제까지 연속 3일)에게만', (await cards.nth(0).getByRole('button', { name: '기록 알림 보내기' }).count()) === 0 && (await cards.nth(1).getByRole('button', { name: '기록 알림 보내기' }).count()) === 0 && (await cards.nth(2).innerText()).includes('어제까지 3일 연속') && (await cards.nth(2).innerText()).includes('오늘 기록 없음'));
    reply = 'no_device';
    const btn = cards.nth(2).getByRole('button', { name: '기록 알림 보내기' });
    await btn.click();
    await p.locator('.toast.visible', { hasText: '알림을 켜지 않아서' }).waitFor({ timeout: 5000 });
    const afterNoDevice = await btn.isEnabled();
    // 적대 검토(2026-11-03) 6: 그사이 회원이 기록했으면(logged) '보냄'으로 잠그지 않고 식사 목록을 다시 받는다
    reply = 'logged';
    await p.locator('.toast.visible').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
    const loadsBefore = mealLoads;
    await btn.click();
    await p.locator('.toast.visible', { hasText: '오늘 기록이 이미 있어요' }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(500);
    check("기록 알림: 서버가 '오늘 기록 있음'이면 보냄으로 잠그지 않고 식사를 다시 받음", (await btn.isEnabled()) && (await btn.innerText()).includes('기록 알림 보내기') && mealLoads > loadsBefore, JSON.stringify({ loadsBefore, mealLoads }));
    reply = 'sent';
    await p.locator('.toast.visible').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
    await btn.click();
    await p.locator('.toast.visible', { hasText: '기록 알림을 보냈어요' }).waitFor({ timeout: 5000 });
    const done = cards.nth(2).getByRole('button', { name: '오늘 알림 보냄' });
    check('기록 알림: 기기가 없으면 알리고 다시 누를 수 있음 · 보내면 오늘은 잠김 · 그 회원에게만', afterNoDevice && (await done.isDisabled()) && JSON.stringify(nudges) === JSON.stringify([m3, m3, m3]), JSON.stringify({ afterNoDevice, nudges }));
    // 2.3 회원 목록: 담당 회원 수 · 이름순 · 초성 칸 · 바로 가기 · 돌아오면 그 회원 카드부터
    {
      const head = (await p.locator('.member-list-head').innerText()).replace(/\s+/g, ' ');
      const count = await cards.count();
      await p.getByRole('group', { name: '회원 정렬' }).getByRole('button', { name: '이름순' }).click();
      const byName = await cards.locator('.member-day-head strong').allInnerTexts();
      const sortedNames = [...byName].sort((x, y) => x.localeCompare(y, 'ko'));
      const heads = await p.locator('.member-cho').allInnerTexts();
      check('2.3 회원 탭: 담당 회원 수 · 이름순 정렬 · 초성 머리말 · 초성 칸 단추(없는 초성은 못 누름)', head.startsWith(`담당 회원 ${count}명`) && byName.join('|') === sortedNames.join('|') && heads.length >= 1 && (await p.getByRole('group', { name: '초성으로 이동' }).getByRole('button', { name: 'ㅋ', exact: true }).isDisabled()), JSON.stringify({ head, byName, heads }));
      await cards.last().getByRole('group').getByRole('button', { name: '운동 기록' }).click();
      const mode = await p.getByRole('group', { name: '회원 화면' }).locator('button[aria-pressed="true"]').innerText();
      check('2.3 카드 아래 바로 가기: 회원 화면의 그 칸(운동 기록)으로 바로', mode === '운동 기록', mode);
      await p.getByRole('button', { name: /담당 회원으로/ }).click();
      await cards.last().waitFor({ timeout: 5000 });
      const top = await cards.last().boundingBox(), main = await p.locator('.app-main').boundingBox();
      check('2.3 회원 화면에서 돌아오면 그 회원 카드가 보임', !!top && !!main && top.y >= main.y - 2 && top.y < main.y + main.height, JSON.stringify({ top, main }));
      await p.getByRole('group', { name: '회원 정렬' }).getByRole('button', { name: '확인할 것 많은 순' }).click();
    }
    await cards.nth(1).locator('.member-day-main').click();
    await p.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
    const tabs = (await p.getByRole('group', { name: '회원 화면' }).getByRole('button').allInnerTexts()).join('|');
    check('카드를 누르면 그 회원 화면 · 탭은 식단·루틴·운동 기록·인바디', tabs === '식단|루틴|운동 기록|인바디', tabs);
    await p.close();
  });

  // 36-0) 2.3.1 공복 체중 한 줄(사용자 화면 11-06: 날짜 칸이 체중 칸을 덮고 kg가 두 줄로 갈렸다). 좁은 화면·큰 글씨에서도 칸이 겹치지 않는다
  await soft('2.3.1 공복 체중 칸 배치', async () => {
    const records = [{ id: 'one', member_id: 'x', measured_on: '2026-10-02', weight_kg: 69, smm_kg: 30, pbf_pct: 22.6, source: 'manual' }];
    const p = await workoutPage([], (path, r) => (path.endsWith('/inbody_records') ? fulfill(r, records) : path.endsWith('/fasting_weights') ? fulfill(r, []) : undefined));
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디' }).click();
    const card = p.getByTestId('fasting-card');
    await card.waitFor({ timeout: 15000 });
    const measure = () => card.evaluate((el) => {
      const box = (q) => el.querySelector(q).getBoundingClientRect();
      const day = box('.fasting-day'), kg = box('.fasting-kg'), btn = box('.fasting-row button');
      const unit = box('.fasting-kg small'), row = box('.fasting-row');
      const line = parseFloat(getComputedStyle(el.querySelector('.fasting-kg small')).fontSize) * 1.8;
      const clash = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return { apart: !clash(day, kg) && !clash(kg, btn) && !clash(day, btn), inside: Math.max(day.right, kg.right, btn.right) <= row.right + 0.5, oneLine: unit.height <= line, field: kg.width };
    });
    const results = {};
    for (const [w, ts] of [[390, 1], [320, 1], [320, 1.3]]) {
      await p.setViewportSize({ width: w, height: 800 });
      await p.evaluate((v) => document.documentElement.style.setProperty('--ts', String(v)), ts);
      await p.waitForTimeout(50);
      results[`${w}/${ts}`] = await measure();
    }
    await card.getByLabel('공복 체중 날짜').fill('2025-12-30');
    await p.waitForTimeout(50);
    results.lastYear = await measure();
    await card.getByLabel('공복 체중 날짜').fill('2026-11-03');
    check('2.3.1 공복 체중: 390·320폭과 큰 글씨, 작년 날짜에서도 날짜·체중·기록 칸이 겹치지 않고 kg가 한 줄', Object.values(results).every((r) => r.apart && r.inside && r.oneLine && r.field >= 88), JSON.stringify(results));
    await p.evaluate(() => document.documentElement.style.removeProperty('--ts'));
    const label = () => card.locator('.fasting-day span').innerText();
    const today = await label();
    await card.getByLabel('공복 체중 날짜').fill('2026-11-01');
    const picked = await label();
    check('2.3.1 공복 체중: 날짜 칸은 오늘 또는 고른 날을 보여 줌', today === '오늘' && picked === '11/1', JSON.stringify({ today, picked }));
    await p.close();
  });
  // 36-1) 2.3 공복 체중: 앱을 켜 둔 채 날이 바뀌어도 어제 기록을 덮어쓰지 않음 · 뒤로 가기로 탭을 떠날 때 쓰던 체중을 지킴 · 인바디가 적어도 항목 칩이 사라지지 않음
  await soft('2.3 공복 체중 경계', async () => {
    const records = [{ id: 'i1', member_id: a, measured_on: '2026-10-20', weight_kg: 74, smm_kg: null, pbf_pct: null, source: 'manual', created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-20T01:00:00Z' }];
    const p = await workoutPage([], (path, r) => (path.endsWith('/inbody_records') ? fulfill(r, records) : path.endsWith('/fasting_weights') ? fulfill(r, [{ day: '2026-11-02', kg: 72 }, { day: '2026-10-25', kg: 73 }]) : undefined));
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
    const card = p.getByTestId('fasting-card');
    await card.waitFor({ timeout: 15000 });
    await p.getByRole('group', { name: '그래프 항목' }).getByRole('button', { name: '골격근량' }).click();
    check('2.3 그래프: 인바디가 하나여도 다른 항목을 누르면 칩이 남아 돌아올 수 있음', (await p.getByRole('group', { name: '그래프 항목' }).count()) === 1 && (await p.getByTestId('inbody-chart').innerText()).includes('기록이 두 개 이상이면'));
    const was = await card.getByLabel('공복 체중 날짜').inputValue();
    await p.clock.fastForward('24:00:00');
    await card.getByLabel('공복 체중(kg)').fill('72.5');
    const now = await card.getByLabel('공복 체중 날짜').inputValue();
    check('2.3 공복 체중: 앱을 켜 둔 채 날이 바뀌면 날짜도 오늘로', was === '2026-11-03' && now === '2026-11-04', JSON.stringify([was, now]));
    let asked = 0;
    p.on('dialog', (d) => { asked++; void d.dismiss(); });
    await p.evaluate(() => history.back());
    await p.waitForTimeout(400);
    check('2.3 뒤로 가기: 화면 밖 입력도 물어보고 취소하면 그 화면에 남음', asked === 1 && (await card.count()) === 1 && (await card.getByLabel('공복 체중(kg)').inputValue()) === '72.5', String(asked));
    await p.close();
  });

  // 36-1a) 좁은 화면의 서비스 계정 주소: 마지막 글자만 혼자 내려가지 않음 · 주소 글자는 그대로(Codex 11-05 안내 출력 때 발견)
  await soft('시트 주소 줄바꿈', async () => {
    const p = await workoutPage([]);
    await p.getByTestId('sheet-line').getByRole('button', { name: '연결', exact: true }).click();
    const code = p.locator('dialog .sheet-account').first();
    await code.waitFor({ timeout: 10000 });
    for (const width of [340, 320]) {
      await p.setViewportSize({ width, height: 800 });
      await p.waitForTimeout(150);
      const r = await code.evaluate((el) => {
        const lines = new Map();
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) for (let i = 0; i < n.length; i++) {
          const g = document.createRange();
          g.setStart(n, i);
          g.setEnd(n, i + 1);
          const top = Math.round(g.getBoundingClientRect().top);
          lines.set(top, (lines.get(top) ?? '') + n.data[i]);
        }
        return { text: el.textContent, lines: [...lines.values()] };
      });
      check(`시트 주소 ${width}px: 줄마다 두 글자 이상 · 주소 글자는 그대로`, r.text === 'fitory-sheets@example.com' && r.lines.every((l) => l.length > 1), JSON.stringify(r.lines));
    }
    await p.close();
  });

  // 36-1c) v2.3.0 1차 리뷰 재현: 체중 그래프는 두 출처를 합쳐 그린다 · 200건 뒤의 자료에 닿는다 · 저장 중에는 기록 칸을 잠근다 · 한마디 조회 실패를 숨기지 않는다
  await soft('2.3 1차 리뷰 공복 체중·한마디', async () => {
    const ib = (measured_on, weight_kg) => ({ id: `i-${measured_on}`, member_id: a, measured_on, weight_kg, smm_kg: null, pbf_pct: null, source: 'manual', created_at: `${measured_on}T01:00:00Z`, updated_at: `${measured_on}T01:00:00Z` });
    const chart = async (records, weights) => {
      const p = await workoutPage([], (path, r) => (path.endsWith('/inbody_records') ? fulfill(r, records) : path.endsWith('/fasting_weights') ? fulfill(r, weights) : undefined));
      await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
      await p.getByTestId('fasting-card').waitFor({ timeout: 15000 });
      await p.waitForTimeout(500);
      const r = await p.evaluate(() => ({ charts: document.querySelectorAll('[data-testid=inbody-chart]').length, path: document.querySelector('.inbody-chart-line')?.getAttribute('d') ?? '', dates: document.querySelectorAll('.inbody-chart-svg text.date').length }));
      await p.close();
      return r;
    };
    const one = await chart([ib('2026-11-01', 73)], [{ day: '2026-11-02', kg: 72.5 }]);
    check('1차 리뷰 2번: 인바디 한 번과 공복 체중 한 번이면 체중 그래프가 나옴(선·날짜 포함)', one.charts === 1 && one.path.includes('L') && one.dates >= 2, JSON.stringify(one));
    const before = await chart([ib('2026-11-02', 73)], [{ day: '2026-11-01', kg: 72.5 }]);
    check('1차 리뷰 2번: 공복 체중이 인바디보다 앞서도 이어서 그림', before.charts === 1 && before.path.includes('L'), JSON.stringify(before));
    // 측정 다음 날의 공복 체중: 날짜 글자가 겹치지 않는다(가까우면 최근 것만 남긴다)
    {
      const p = await workoutPage([], (path, r) => {
        if (path.endsWith('/inbody_records')) return fulfill(r, [ib('2026-11-02', 72), ib('2026-10-01', 74)]);
        if (path.endsWith('/fasting_weights')) return fulfill(r, [{ day: '2026-11-03', kg: 71.2 }]);
        if (path.endsWith('/rpc/diet_report')) return fulfill(r, { days: 30, logged_days: 0, meals: 0, rated: 0, great: 0, good: 0, care: 0, score: null });
        if (path.endsWith('/rpc/workout_summary')) return fulfill(r, { days: 0, done_sets: 0, cardio_count: 0, cardio_minutes: 0, cardio_km: 0 });
        return undefined;
      });
      await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
      await p.getByTestId('inbody-chart').waitFor({ timeout: 15000 });
      await p.waitForTimeout(400);
      const xs = await p.evaluate(() => [...document.querySelectorAll('.inbody-chart-svg text.date')].map((t) => Number(t.getAttribute('x'))).sort((a, b) => a - b));
      const dates = await p.locator('.inbody-chart-svg text.date').allTextContents();
      check('적대 검토: 측정 다음 날 공복 체중의 날짜 글자가 겹치지 않고 최근 측정의 글자가 남음', xs.length === 2 && xs.every((x, i) => !i || x - xs[i - 1] >= 30) && dates.includes('11/2') && !dates.includes('11/3'), JSON.stringify({ xs, dates }));
      await p.close();
    }
    const only = await chart([], [{ day: '2026-11-02', kg: 72.5 }, { day: '2026-11-01', kg: 73 }]);
    check('1차 리뷰 2번: 공복 체중 두 번만 있어도 선과 날짜가 그려짐', only.charts === 1 && only.path.includes('L') && only.dates >= 2, JSON.stringify(only));

    // 201건: 앱이 페이지를 넘겨 받아 가장 오래된 날짜도 찾는다
    const day0 = Date.UTC(2026, 3, 19);
    const rows = Array.from({ length: 201 }, (_, i) => ({ day: new Date(day0 + (200 - i) * 86_400_000).toISOString().slice(0, 10), kg: 70 + (i % 5) }));
    const page = (r, list) => { const u = new URL(r.request().url()); const from = Number(u.searchParams.get('offset') ?? 0), n = Number(u.searchParams.get('limit') ?? list.length); return fulfill(r, list.slice(from, from + n)); };
    const old = rows.at(-1);
    let release, saves = 0;
    const p = await workoutPage([], (path, r) => {
      if (path.endsWith('/inbody_records')) return fulfill(r, []);
      if (path.endsWith('/fasting_weights')) return page(r, rows);
      if (path.endsWith('/rpc/save_fasting_weight')) { saves++; return new Promise((go) => { release = () => go(fulfill(r, null)); }); }
      return undefined;
    });
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
    const card = p.getByTestId('fasting-card');
    await card.waitFor({ timeout: 15000 });
    await p.waitForTimeout(600);
    await card.getByLabel('공복 체중 날짜').fill(old.day);
    await p.waitForTimeout(200);
    const holder = await card.getByLabel('공복 체중(kg)').getAttribute('placeholder');
    check('1차 리뷰 6번: 201번째 공복 체중도 날짜를 고르면 값이 보이고 지울 수 있음', holder === String(old.kg) && (await card.getByRole('button', { name: /기록 지우기/ }).count()) === 1, JSON.stringify({ holder, old }));
    // 저장 중에는 최근 기록 칸을 눌러 입력을 바꿀 수 없다
    await card.getByLabel('공복 체중(kg)').fill('73');
    await card.getByRole('button', { name: '기록', exact: true }).click();
    await p.waitForTimeout(200);
    const firstChip = card.locator('.fasting-list button').first();
    check('1차 리뷰 8번: 저장 중에는 기록 칸이 잠겨 고른 값이 응답에 지워지지 않음', saves === 1 && (await firstChip.isDisabled()), String(saves));
    release?.();
    await p.close();

    const words = Array.from({ length: 201 }, (_, i) => ({ day: new Date(Date.UTC(2026, 10, 3) - i * 86_400_000).toISOString().slice(0, 10), body: `한마디 ${i + 1}`, is_tip: false }));
    const q = await workoutPage([], (path, r) => (path.endsWith('/trainer_messages') ? (r.request().url().includes('lte') ? page(r, words) : fulfill(r, null)) : undefined));
    await q.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
    await q.getByTestId('trainer-words').getByRole('button', { name: /트레이너 한마디/ }).click();
    const all = q.getByTestId('trainer-words-all');
    await all.waitFor({ timeout: 5000 });
    const wordsTotal = await all.getByRole('group', { name: '한마디 골라 보기' }).innerText();
    check('1차 리뷰 6번: 지난 한마디 모두 보기가 201번째까지 받음', wordsTotal.includes('전체 201') && (await all.getByText('한마디 201', { exact: true }).count()) === 1, JSON.stringify([wordsTotal, await all.getByText('한마디 201', { exact: true }).count(), await all.locator('.trainer-word').count()]));
    await q.close();

    // 해가 넘어가면 달 이름에 연도를 적는다
    {
      const two = [{ day: '2026-11-03', body: '올해 한마디', is_tip: false }, { day: '2025-11-03', body: '작년 한마디', is_tip: false }, { day: '2025-10-03', body: '더 오래된 한마디', is_tip: false }, { day: '2025-09-03', body: '넷째 한마디', is_tip: false }];
      const y = await workoutPage([], (path, r) => (path.endsWith('/trainer_messages') ? (r.request().url().includes('lte') ? page(r, two) : fulfill(r, null)) : undefined));
      await y.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
      await y.getByTestId('trainer-words').getByRole('button', { name: /트레이너 한마디/ }).click();
      await y.getByTestId('trainer-words-all').waitFor({ timeout: 5000 });
      const heads = await y.getByTestId('trainer-words-all').locator('h3').allInnerTexts();
      check('적대 검토: 해가 다른 한마디는 달 이름에 연도가 붙어 같은 이름이 둘 생기지 않음', heads.join('|') === '2026년 11월|2025년 11월|2025년 10월|2025년 9월', heads.join('|'));
      await y.close();
    }
    const down = { on: true };
    const w = await workoutPage([], (path, r) => (path.endsWith('/trainer_messages') ? (r.request().url().includes('lte') ? (down.on ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, [{ day: '2026-11-03', body: '다시 받은 한마디', is_tip: false }])) : fulfill(r, null)) : undefined));
    await w.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
    await w.getByText('한마디를 불러오지 못했어요').waitFor({ timeout: 8000 });
    down.on = false;
    await w.getByRole('button', { name: '다시 불러오기' }).first().click();
    await w.getByTestId('trainer-words').getByText('다시 받은 한마디').waitFor({ timeout: 5000 });
    check('1차 리뷰 정리: 한마디 조회 실패를 숨기지 않고 다시 받을 수 있음', true);
    await w.close();
  });

  // 36-1d) v2.3.0 1차 리뷰 재현: 성별 확인 창도 뒤로 가기 층에 든다
  await soft('2.3 1차 리뷰 성별 확인 창', async () => {
    const p = await workoutPage([], (path, r) => (path.endsWith('/rpc/my_gender') ? fulfill(r, { gender: null, hidden: false }) : undefined));
    await p.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
    await p.getByRole('group', { name: '성별' }).getByRole('button', { name: '남자' }).click();
    const dlg = p.getByTestId('gender-confirm');
    await dlg.waitFor({ timeout: 5000 });
    await p.evaluate(() => history.back());
    await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(300);
    const tab = await p.locator('.bottom-nav .nav-item.active').innerText();
    check('1차 리뷰 7번: 뒤로 가기는 성별 확인 창만 닫고 설정에 남음', (await dlg.count()) === 0 && tab.startsWith('설정'), tab);
    await p.close();
    // 저장 중에는 Esc를 거듭 눌러도 창이 남는다(브라우저가 막지 못하게 해도 다시 연다)
    const q = await workoutPage([], (path, r) => (path.endsWith('/rpc/my_gender') ? fulfill(r, { gender: null, hidden: false }) : path.endsWith('/rpc/set_my_gender') ? new Promise(() => {}) : undefined));
    await q.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
    await q.getByRole('group', { name: '성별' }).getByRole('button', { name: '남자' }).click();
    const d2 = q.getByTestId('gender-confirm');
    await d2.waitFor({ timeout: 5000 });
    await d2.getByRole('button', { name: /남자로 정하기/ }).click();
    for (let i = 0; i < 4; i++) { await q.keyboard.press('Escape'); await q.waitForTimeout(150); }
    check('적대 검토: 저장 중인 성별 확인 창은 Esc를 거듭 눌러도 닫히지 않음', (await d2.count()) === 1 && (await d2.evaluate((el) => el.open)));
    await q.close();
  });

  // 36-1g) v2.3.0 2차 리뷰 재현: 인바디 조회의 실패·지연이 공복 체중을 막지 않는다
  await soft('2.3 2차 리뷰 인바디와 공복 체중', async () => {
    const rec = (id, measured_on, weight_kg) => ({ id, member_id: a, measured_on, weight_kg, smm_kg: 31, pbf_pct: 22, source: 'manual', created_at: `${measured_on}T01:00:00Z`, updated_at: `${measured_on}T01:00:00Z` });
    const ctl = { inbody: 'fail', release: null };
    const p = await workoutPage([], (path, r) => {
      if (path.endsWith('/inbody_records')) {
        if (ctl.inbody === 'fail') return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        if (ctl.inbody === 'hold') return new Promise((go) => { ctl.release = () => go(fulfill(r, [rec('i1', '2026-10-20', 74)])); });
        return fulfill(r, [rec('i1', '2026-10-20', 74)]);
      }
      if (path.endsWith('/fasting_weights')) return fulfill(r, [{ day: '2026-11-02', kg: 72 }, { day: '2026-11-01', kg: 73 }]);
      return undefined;
    });
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디', exact: true }).click();
    const card = p.getByTestId('fasting-card');
    await card.waitFor({ timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    check('2차 리뷰 1번: 인바디 조회가 실패해도 공복 체중 입력과 그래프가 남음', (await card.count()) === 1 && (await p.getByTestId('inbody-chart').count()) === 1 && (await p.getByText('인바디 기록을 불러오지 못했어요').count()) === 1);
    if (await card.count()) await card.getByLabel('공복 체중(kg)').fill('71.5');
    ctl.inbody = 'hold';
    if (await card.count()) await p.getByRole('button', { name: '다시 불러오기' }).first().click();
    await p.waitForTimeout(300);
    const during = await card.count();
    ctl.release?.();
    await p.getByText('최근 측정').waitFor({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(200);
    check('2차 리뷰 1번: 인바디를 다시 받는 동안에도 체중 칸이 있고 쓰던 값이 남음', during === 1 && (await card.count()) === 1 && (await card.getByLabel('공복 체중(kg)').inputValue().catch(() => '')) === '71.5', String(during));
    await p.close();
  });

  // 36-1h) v2.3.0 2차 리뷰 재현: 식단 조회의 실패가 트레이너의 운동·회원 진입을 막지 않는다 · 400개 밖의 새 수정도 보인다
  await soft('2.3 2차 리뷰 트레이너 부분 실패', async () => {
    const m = '11111111-1111-4111-8111-0000000000f1';
    const ses = (id, day, at) => ({ id, member_id: m, routine_id: null, day_no: 1, day, started_at: at, updated_at: at, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets: [{ item_id: null, name: '스쿼트', set_no: 1, kg: '50', reps: '5', done: true, ord: 1 }], cardio: [] });
    const open = async (rows, ctl) => {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      await p.route('**/rest/v1/**', (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith('/assignments')) return fulfill(r, [{ member_id: m, member: { nickname: '가 회원' } }]);
        if (u.pathname.endsWith('/profiles')) return fulfill(r, [{ id: m, share_consent: true }]);
        if (u.pathname.endsWith('/meals') && ctl.mealsDown) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        if (u.pathname.endsWith('/workout_sessions') || u.pathname.endsWith('/rpc/members_workouts')) return fulfill(r, rows);
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=trainer`);
      return p;
    };
    const ctl = { mealsDown: true };
    const p = await open([ses('w1', '2026-11-03', '2026-11-02T22:40:00Z')], ctl);
    await p.getByTestId('new-workouts').waitFor({ timeout: 10000 }).catch(() => {});
    check('2차 리뷰 2번: 식단만 실패해도 확인 탭의 새 운동 기록이 보이고 식단 실패도 알림', (await p.getByTestId('new-workouts').count()) === 1 && (await p.getByText('기록을 불러오지 못했어요').count()) === 1);
    await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
    const cardEl = p.getByTestId('member-day').first();
    await cardEl.waitFor({ timeout: 5000 }).catch(() => {});
    const txt = (await cardEl.count()) ? (await cardEl.innerText()).replace(/\s+/g, ' ') : '';
    check('2차 리뷰 2번: 회원 카드가 보이고 식단을 모르면 기록 없음·빈 끼니 칸·기록 알림을 말하지 않음', txt.includes('가 회원') && !txt.includes('오늘 기록 없음') && !txt.includes('기록 알림') && (await cardEl.locator('.member-day-cell').count()) === 0, txt);
    if (await cardEl.count()) await cardEl.getByRole('group').getByRole('button', { name: '운동 기록' }).click();
    await p.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 }).catch(() => {});
    const mode = await p.getByRole('group', { name: '회원 화면' }).locator('button[aria-pressed="true"]').innerText().catch(() => '');
    check('2차 리뷰 2번: 식단이 실패해도 회원의 운동 기록으로 들어감', mode === '운동 기록', mode);
    if (mode) await p.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '식단' }).click();
    await p.waitForTimeout(200);
    check('2차 리뷰 2번: 회원 화면의 식단 칸은 실패를 기록 없음으로 말하지 않음', (await p.getByText('기록을 불러오지 못했어요').count()) === 1);
    await p.close();

    // 적대 검토(2차 뒤): 전체 조회가 실패한 채 회원 한 명의 식사만 받아도 전체를 아는 것으로 보지 않는다 · 회원 조회가 실패하면 기록 없음이라 하지 않는다
    {
      const two = '11111111-1111-4111-8111-0000000000f2';
      const c = await ctx.newPage();
      await c.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      const meal = { id: '66666666-6666-4666-8666-0000000000f1', member_id: m, eaten_on: '2026-11-03', eaten_at: '08:30:00', meal_type: '아침', food: '가 회원 아침', note: '', photo_path: null, created_at: '2026-11-03T00:00:00Z', reviewed_at: null, member_seen_at: null, note_updated_at: null, member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: '가 회원' } };
      await c.route('**/rest/v1/**', (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith('/assignments')) return fulfill(r, [{ member_id: m, member: { nickname: '가 회원' } }, { member_id: two, member: { nickname: '나 회원' } }]);
        if (u.pathname.endsWith('/profiles')) return fulfill(r, [{ id: m, share_consent: true }, { id: two, share_consent: true }]);
        if (u.pathname.endsWith('/meals')) {
          const q = decodeURIComponent(r.request().url());
          if (q.includes(`member_id=eq.${m}`)) return fulfill(r, [meal]);
          return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        }
        return fulfill(r, []);
      });
      await c.goto(`${BASE}?mode=trainer`);
      await c.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
      const cards = c.getByTestId('member-day');
      await cards.first().waitFor({ timeout: 10000 });
      await cards.filter({ hasText: '가 회원' }).locator('.member-day-main').click();
      await c.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
      await c.getByText('가 회원 아침').first().waitFor({ timeout: 5000 }).catch(() => {});
      const own = await c.getByText('가 회원 아침').count();
      await c.getByRole('button', { name: /담당 회원으로/ }).click();
      await cards.first().waitFor({ timeout: 5000 });
      await c.waitForTimeout(300);
      const other = (await cards.filter({ hasText: '나 회원' }).innerText()).replace(/\s+/g, ' ');
      check('적대 검토: 전체 조회 실패 뒤 회원 하나의 식사만 받아도 다른 회원을 기록 없음이라 하지 않음 · 그 회원 식사는 회원 화면에 보임', own >= 1 && !other.includes('오늘 기록 없음') && !other.includes('기록 알림'), JSON.stringify({ own, other }));
      await cards.filter({ hasText: '나 회원' }).locator('.member-day-main').click();
      await c.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
      await c.waitForTimeout(400);
      check('적대 검토: 회원 조회가 실패하면 아직 기록이 없어요라고 하지 않고 다시 불러오기를 보임', (await c.getByText('아직 기록이 없어요').count()) === 0 && (await c.getByText('기록을 불러오지 못했어요').count()) === 1);
      await c.close();
    }
    const rows = Array.from({ length: 420 }, (_, i) => {
      const day = i < 400 ? '2026-11-02' : '2026-10-23';
      return ses(`r${i}`, day, '2026-10-20T01:00:00Z');
    });
    rows[419] = { ...rows[419], updated_at: '2026-11-03T00:30:00Z' };
    const q = await open(rows, { mealsDown: false });
    await q.evaluate(() => {});
    await q.getByTestId('new-workouts').waitFor({ timeout: 10000 }).catch(() => {});
    check('2차 리뷰 4번: 날짜순 400개 밖의 새 수정도 새 운동 기록에 나옴', (await q.getByTestId('new-workouts').locator('.new-workout').count()) === 1);
    await q.close();
  });

  // 36-1i) v2.3.0 3차 리뷰 재현: 새 운동 기록은 한 시점의 전부를 받는다 · 회원 식단을 다시 받으면 실패 화면이 풀린다
  await soft('2.3 3차 리뷰 조회와 복구', async () => {
    const m = '11111111-1111-4111-8111-0000000000f3';
    const seenOf = (p) => p.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('mealnote:workouts-seen:'))?.[1]);
    const ses = (id, updated) => ({ id, member_id: m, routine_id: null, day_no: 1, day: '2026-11-02', started_at: '2026-10-20T01:00:00Z', updated_at: updated, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets: [{ item_id: null, name: '스쿼트', set_no: 1, kg: '50', reps: '5', done: true, ord: 1 }], cardio: [] });
    // P2: 600개 중 501·502번째만 새 수정. 쪽 번호로 받으면 첫 쪽 뒤 앞쪽 기록 하나가 지워질 때 501번째를 건너뛰고, 못 본 01시 기록이 02시까지 본 것으로 넘어갔다
    {
      const all = Array.from({ length: 600 }, (_, i) => ses(`p${i}`, i === 500 ? '2026-11-03T01:00:00Z' : i === 501 ? '2026-11-03T02:00:00Z' : '2026-10-20T01:00:00Z'));
      let rows = all, calls = 0, pages = 0;
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T12:00:00+09:00') });
      await p.route('**/rest/v1/**', (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith('/assignments')) return fulfill(r, [{ member_id: m, member: { nickname: '가 회원' } }]);
        if (u.pathname.endsWith('/profiles')) return fulfill(r, [{ id: m, share_consent: true }]);
        if (u.pathname.endsWith('/rpc/members_workouts')) { calls++; return fulfill(r, rows); }
        if (u.pathname.endsWith('/workout_sessions')) {
          pages++;
          const from = Number(u.searchParams.get('offset') ?? 0), n = Number(u.searchParams.get('limit') ?? 1000);
          if (from === 500 && rows === all) rows = all.slice(1);
          return fulfill(r, rows.slice(from, from + n));
        }
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=trainer`);
      const box = p.getByTestId('new-workouts');
      await box.waitFor({ timeout: 10000 }).catch(() => {});
      check('3차 리뷰 1번: 새 수정 두 건이 모두 보이고 목록은 요청 한 번으로 받음(쪽 사이가 없음)', (await box.locator('.new-workout').count()) === 2 && calls === 1 && pages === 0, JSON.stringify({ shown: await box.locator('.new-workout').count(), calls, pages }));
      await p.getByRole('button', { name: '모두 봤어요', exact: true }).click().catch(() => {});
      await p.waitForTimeout(200);
      rows = all;
      await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await p.waitForTimeout(400);
      const marks = JSON.parse((await seenOf(p)) ?? '{}').marks ?? {};
      check('3차 리뷰 1번: 모두 봤어요는 받은 기록 두 건만 적음 · 보여 주지 않은 기록은 없음', Object.keys(marks).sort().join() === 'p500,p501' && marks.p501 === '2026-11-03T02:00:00.000Z' && (await box.count()) === 0, JSON.stringify({ marks, left: await box.count() }));
      await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mealnote:workouts-seen:')).forEach((k) => localStorage.removeItem(k)));
      await p.close();
    }
    // P3: 회원 조회가 한 번 실패한 뒤 자동 재조회가 성공하면 버튼 없이 맞는 화면으로
    const meal = { id: '66666666-6666-4666-8666-0000000000f3', member_id: m, eaten_on: '2026-11-03', eaten_at: '08:30:00', meal_type: '아침', food: '다시 받은 아침', note: '', photo_path: null, created_at: '2026-11-03T00:00:00Z', reviewed_at: null, member_seen_at: null, note_updated_at: null, member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: '가 회원' } };
    const open = async (ctl) => {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      await p.route('**/rest/v1/**', async (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith('/assignments')) return fulfill(r, [{ member_id: m, member: { nickname: '가 회원' } }]);
        if (u.pathname.endsWith('/profiles')) return fulfill(r, [{ id: m, share_consent: true }]);
        if (u.pathname.endsWith('/meals')) {
          if (decodeURIComponent(r.request().url()).includes(`member_id=eq.${m}`)) {
            const hold = ctl.hold;
            ctl.hold = null;
            if (hold) await hold;
            if (ctl.down || hold) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          }
          return fulfill(r, ctl.meals());
        }
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=trainer`);
      await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
      await p.getByTestId('member-day').first().waitFor({ timeout: 10000 });
      await p.getByTestId('member-day').first().locator('.member-day-main').click();
      await p.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
      return p;
    };
    const again = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const failedText = (p) => p.getByText('기록을 불러오지 못했어요');
    {
      const ctl = { down: true, meals: () => [] };
      const p = await open(ctl);
      await failedText(p).waitFor({ timeout: 5000 }).catch(() => {});
      const before = await failedText(p).count();
      ctl.down = false;
      await again(p);
      await p.getByText('아직 기록이 없어요').waitFor({ timeout: 5000 }).catch(() => {});
      check('3차 리뷰 2번: 회원 조회 실패 뒤 자동 재조회가 성공하면 버튼 없이 기록 없음으로 돌아옴', before === 1 && (await failedText(p).count()) === 0 && (await p.getByText('아직 기록이 없어요').count()) === 1, String(before));
      await p.close();
    }
    {
      let list = [];
      const ctl = { down: true, meals: () => list };
      const p = await open(ctl);
      await failedText(p).waitFor({ timeout: 5000 }).catch(() => {});
      ctl.down = false;
      list = [meal];
      await again(p);
      await p.getByText('다시 받은 아침').first().waitFor({ timeout: 5000 }).catch(() => {});
      check('3차 리뷰 2번: 재조회로 기록을 받으면 실패 없이 기록을 보임', (await failedText(p).count()) === 0 && (await p.getByText('다시 받은 아침').count()) >= 1);
      await p.close();
    }
    {
      const ctl = { down: true, meals: () => [] };
      const p = await open(ctl);
      await failedText(p).waitFor({ timeout: 5000 }).catch(() => {});
      ctl.down = false;
      await p.getByRole('button', { name: '다시 불러오기' }).first().click();
      await p.getByText('아직 기록이 없어요').waitFor({ timeout: 5000 }).catch(() => {});
      check('3차 리뷰 2번: 다시 불러오기로도 돌아옴', (await failedText(p).count()) === 0 && (await p.getByText('아직 기록이 없어요').count()) === 1);
      await p.close();
    }
    {
      // 전체 조회로 받은 식사는 있고 회원 60일 조회만 실패: 받은 것은 보이되 전부가 아니라고 알린다(적대 검토, 3차 뒤)
      const ctl = { down: true, meals: () => [meal] };
      const p = await open(ctl);
      const notice = p.getByText('최근 60일 식단 기록을 모두 불러오지 못했어요.');
      await notice.waitFor({ timeout: 5000 }).catch(() => {});
      const seen = { notice: await notice.count(), meal: await p.getByText('다시 받은 아침').count() };
      ctl.down = false;
      await p.getByRole('button', { name: '다시 불러오기' }).first().click().catch(() => {});
      await p.waitForTimeout(300);
      check('적대 검토(3차 뒤): 회원 조회가 실패해도 받은 식사는 보이고 전부가 아니라고 알림 · 다시 받으면 안내가 사라짐', seen.notice === 1 && seen.meal >= 1 && (await notice.count()) === 0, JSON.stringify(seen));
      await p.close();
    }
    {
      // 회원 화면을 열 때의 조회가 응답을 끌다가, 뒤에 시작한 전체 재조회가 성공한 다음에 실패로 끝난다
      let release;
      const ctl = { down: false, meals: () => [], hold: new Promise((res) => { release = res; }) };
      const p = await open(ctl);
      await p.waitForTimeout(200);
      await again(p);
      await p.getByText('아직 기록이 없어요').waitFor({ timeout: 5000 }).catch(() => {});
      const settled = await p.getByText('아직 기록이 없어요').count();
      release();
      await p.waitForTimeout(400);
      check('3차 리뷰 2번: 옛 회원 조회가 새 재조회보다 늦게 실패해도 실패 화면으로 되돌아가지 않음', settled === 1 && (await failedText(p).count()) === 0 && (await p.getByText('아직 기록이 없어요').count()) === 1, String(settled));
      await p.close();
    }
  });

  // 36-1j) v2.3.0 4차 리뷰 재현: 본 처리는 받은 기록·그 판에만 적용한다. 시각 하나를 앞으로 옮기면 명단이 늦거나 저장이 늦게 끝난 기록까지 넘어갔다
  await soft('2.3 4차 리뷰 본 처리', async () => {
    const A = '11111111-1111-4111-8111-0000000000a1', B = '11111111-1111-4111-8111-0000000000a2';
    const names = { [A]: '가 회원', [B]: '나 회원' };
    const ses = (id, member, updated, extra = {}) => ({ id, member_id: member, routine_id: null, day_no: 1, day: '2026-11-03', started_at: '2026-11-02T22:00:00Z', updated_at: updated, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets: [{ item_id: null, name: '스쿼트', set_no: 1, kg: '50', reps: '5', done: true, ord: 1 }], cardio: [], ...extra });
    const open = async (ctl) => {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-03T12:00:00+09:00') });
      await p.route('**/rest/v1/**', async (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith('/assignments')) {
          const hold = ctl.holdRoster;
          ctl.holdRoster = null;
          if (hold) await hold;
          if (ctl.rosterDown) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          return fulfill(r, ctl.roster.map((id) => ({ member_id: id, member: { nickname: names[id] } })));
        }
        if (u.pathname.endsWith('/profiles')) return ctl.consentDown ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, ctl.roster.map((id) => ({ id, share_consent: true })));
        if (u.pathname.endsWith('/rpc/member_streaks') && ctl.streaksDown) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        if (u.pathname.endsWith('/rpc/members_workouts')) {
          const ids = r.request().postDataJSON().p_members;
          return fulfill(r, ctl.rows().filter((x) => ids.includes(x.member_id)));
        }
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=trainer`);
      await p.getByTestId('new-workouts').waitFor({ timeout: 10000 }).catch(() => {});
      return p;
    };
    const again = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const rowsOf = (p) => p.getByTestId('new-workouts').locator('.new-workout');
    const done = (p) => p.getByRole('button', { name: '모두 봤어요', exact: true });
    const clearSeen = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mealnote:workouts-seen:')).forEach((k) => localStorage.removeItem(k)));
    const a = ses('a1', A, '2026-11-03T02:00:00Z'), b = ses('b1', B, '2026-11-03T01:00:00Z');
    // 1번: 명단 재조회 대기 → 옛 명단의 운동만 성공 → 본 처리 → 새 회원 포함 완료
    {
      let release;
      const ctl = { roster: [A], rows: () => [a, b] };
      const p = await open(ctl);
      ctl.holdRoster = new Promise((res) => { release = res; });
      ctl.roster = [A, B];
      await again(p);
      await p.waitForTimeout(300);
      await done(p).click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(200);
      const pressed = await rowsOf(p).count();
      release();
      await rowsOf(p).first().waitFor({ timeout: 5000 }).catch(() => {});
      const left = await rowsOf(p).allInnerTexts();
      check('4차 리뷰 1번: 명단을 받는 중에 눌러도 뒤에 들어온 회원의 못 본 기록은 새 기록으로 남음', pressed === 0 && left.length === 1 && left[0].includes('나 회원'), JSON.stringify({ pressed, left }));
      await clearSeen(p);
      await p.close();
    }
    // 1번의 실패 쪽: 명단 조회가 실패해도 누를 수 있고, 명단이 돌아오면 빠졌던 회원의 기록이 뜬다
    {
      const ctl = { roster: [A], rows: () => [a, b] };
      const p = await open(ctl);
      ctl.rosterDown = true;
      ctl.roster = [A, B];
      await again(p);
      await p.getByText('회원 목록을 새로 불러오지 못했어요.').waitFor({ timeout: 5000 }).catch(() => {});
      const during = { button: await done(p).count(), notice: await p.getByText('회원 목록을 새로 불러오지 못했어요.').count() };
      await done(p).click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(200);
      ctl.rosterDown = false;
      await again(p);
      await rowsOf(p).first().waitFor({ timeout: 5000 }).catch(() => {});
      const left = await rowsOf(p).allInnerTexts();
      check('4차 리뷰 1번: 명단 조회가 실패하면 이유를 알리고, 보인 기록은 본 처리되고 빠졌던 회원의 기록은 남음', during.button === 1 && during.notice === 1 && left.length === 1 && left[0].includes('나 회원') && (await p.getByText('회원 목록을 새로 불러오지 못했어요.').count()) === 0, JSON.stringify({ during, left }));
      await clearSeen(p);
      await p.close();
    }
    // 2번: 먼저 시작해 늦게 끝난 저장(시각이 더 이름)
    {
      let list = [ses('b2', B, '2026-11-03T02:00:00Z')];
      const ctl = { roster: [A, B], rows: () => list };
      const p = await open(ctl);
      await done(p).click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(200);
      const pressed = await rowsOf(p).count();
      list = [ses('a2', A, '2026-11-03T01:59:59Z'), ...list];
      await again(p);
      await rowsOf(p).first().waitFor({ timeout: 5000 }).catch(() => {});
      const left = await rowsOf(p).allInnerTexts();
      check('4차 리뷰 2번: 본 처리 뒤에 끝난 저장은 시각이 더 일러도 새 기록으로 보임', pressed === 0 && left.length === 1 && left[0].includes('가 회원'), JSON.stringify({ pressed, left }));
      await clearSeen(p);
      await p.close();
    }
    // 같은 기록의 새 판 · 시트 기록의 자동 반영 · 다시 열어도 그대로
    {
      const sheet = ses('s1', A, '2026-11-03T02:30:00Z', { source: 'sheet', sheet_tab: '2611', sheet_col: 5, started_at: '2026-11-02T15:05:00Z' });
      let list = [a, sheet];
      const ctl = { roster: [A], rows: () => list };
      const p = await open(ctl);
      await done(p).click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(200);
      await p.reload();
      await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).waitFor({ timeout: 15000 });
      await p.waitForTimeout(600);
      const reopened = await rowsOf(p).count();
      list = [a, { ...sheet, updated_at: '2026-11-03T02:45:00Z' }];
      await again(p);
      await p.waitForTimeout(400);
      const synced = await rowsOf(p).count();
      list = [{ ...a, updated_at: '2026-11-03T02:50:00Z' }, { ...sheet, updated_at: '2026-11-03T02:45:00Z' }];
      await again(p);
      await rowsOf(p).first().waitFor({ timeout: 5000 }).catch(() => {});
      check('4차 리뷰: 본 기록은 다시 열어도 없고 · 시트 자동 반영만으로 다시 뜨지 않고 · 같은 기록이 새 판으로 고쳐지면 다시 뜸', reopened === 0 && synced === 0 && (await rowsOf(p).count()) === 1, JSON.stringify({ reopened, synced, after: await rowsOf(p).count() }));
      await clearSeen(p);
      await p.close();
    }
    // 3번: 연속 기록만 실패
    {
      const ctl = { roster: [A], rows: () => [a], streaksDown: true };
      const p = await open(ctl);
      await done(p).waitFor({ timeout: 5000 }).catch(() => {});
      const button = await done(p).count();
      await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
      await p.getByTestId('member-day').first().waitFor({ timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(300);
      const notice = { streak: await p.getByText('연속 기록 정보를 새로 불러오지 못했어요.').count(), roster: await p.getByText('회원 목록을 새로 불러오지 못했어요').count() };
      await p.locator('.bottom-nav').getByRole('button', { name: /^확인/ }).click();
      await done(p).click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(200);
      check('4차 리뷰 3번: 연속 기록만 실패하면 운동 본 처리는 그대로 되고 연속 기록 실패만 알림', button === 1 && notice.streak === 1 && notice.roster === 0 && (await rowsOf(p).count()) === 0, JSON.stringify({ button, notice }));
      await clearSeen(p);
      await p.close();
    }
    // 공유 동의만 실패
    {
      const ctl = { roster: [A], rows: () => [a], consentDown: true };
      const p = await open(ctl);
      await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
      await p.getByText('공유 동의 정보를 새로 불러오지 못했어요.').waitFor({ timeout: 5000 }).catch(() => {});
      check('적대 검토(4차 뒤): 공유 동의만 실패하면 그 이름만 알림', (await p.getByText('공유 동의 정보를 새로 불러오지 못했어요.').count()) === 1 && (await p.getByText('회원 목록을 새로 불러오지 못했어요').count()) === 0);
      await clearSeen(p);
      await p.close();
    }
    // 첫 명단 조회가 실패: 확인 중이라고 하지 않는다
    {
      const ctl = { roster: [A], rows: () => [a], rosterDown: true };
      const p = await open(ctl);
      await p.getByText('회원 목록을 불러오지 못했어요.').waitFor({ timeout: 5000 }).catch(() => {});
      const notice = await p.getByText('회원 목록을 불러오지 못했어요.').count();
      await p.locator('.bottom-nav').getByRole('button', { name: /^설정/ }).click();
      await p.waitForTimeout(300);
      const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
      check('적대 검토(4차 뒤): 첫 명단 조회가 실패하면 확인 탭에 알리고 설정 탭도 확인 중이라고 하지 않음', notice === 1 && !body.includes('담당 회원 확인 중') && body.includes('담당 회원을 불러오지 못했어요'), JSON.stringify({ notice }));
      await clearSeen(p);
      await p.close();
    }
    // 처음 정한 기준 시각은 누르기 전에도 그대로: 뜨던 기록이 며칠 뒤 말없이 사라지지 않는다
    {
      const ctl = { roster: [A], rows: () => [ses('k1', A, '2026-11-01T02:00:00Z', { day: '2026-11-01' })] };
      const p = await open(ctl);
      const first = await rowsOf(p).count();
      await p.clock.setSystemTime(new Date('2026-11-08T12:00:00+09:00'));
      await p.reload();
      await p.getByTestId('new-workouts').waitFor({ timeout: 10000 }).catch(() => {});
      check('적대 검토(4차 뒤): 누르지 않은 기록은 며칠 뒤에 열어도 새 기록으로 남음', first === 1 && (await rowsOf(p).count()) === 1, String(first));
      await clearSeen(p);
      await p.close();
    }
  });

  // 36-1f) 적대 검토(1차 리뷰 뒤): 칸을 건드리지 않은 변경도 폼이 창에 알린다 — 세트 완료 · 끼니 버튼 · 표로 읽은 루틴
  await soft('2.3 창의 쓰던 내용(폼 신호)', async () => {
    const back = async (p) => {
      let n = 0;
      const h = (d) => { n++; void d.dismiss(); };
      p.on('dialog', h);
      await p.evaluate(() => history.back());
      await p.waitForTimeout(400);
      p.off('dialog', h);
      return n;
    };
    const p = await workoutPage([]);
    await p.getByTestId('start-workout').click();
    await p.getByLabel('스쿼트 1세트 완료').click();
    const asked = await back(p);
    check('적대 검토: 세트 완료만 표시한 운동 기록도 뒤로 가기에서 묻고 취소하면 그대로', asked === 1 && (await p.locator('dialog[open]').count()) === 1, String(asked));
    await p.close();
    const q = await workoutPage([]);
    await q.locator('.bottom-nav').getByRole('button', { name: '식단', exact: true }).click();
    await q.getByRole('button', { name: '식단 기록하기' }).first().click();
    await q.getByRole('dialog').locator('.meal-type-buttons button[aria-pressed=false]').first().click();
    const mealAsked = await back(q);
    check('적대 검토: 끼니 버튼만 바꾼 식단도 뒤로 가기에서 물음', mealAsked === 1 && (await q.locator('dialog[open]').count()) === 1, String(mealAsked));
    await q.close();
    // 사진 고르기를 취소하면 파일 칸의 cancel이 창까지 올라온다: 창을 닫으라는 뜻이 아니고, 그 뒤에 창이 다시 열려서도 안 된다
    {
      const c = await workoutPage([]);
      await c.locator('.bottom-nav').getByRole('button', { name: '식단', exact: true }).click();
      await c.getByRole('button', { name: '식단 기록하기' }).first().click();
      await c.getByLabel('무엇을 드셨나요?').fill('쓰던 음식');
      let asked2 = 0;
      c.on('dialog', (d) => { asked2++; void d.dismiss(); });
      await c.evaluate(() => document.querySelector('dialog[open] input[type=file]').dispatchEvent(new Event('cancel', { bubbles: true })));
      await c.waitForTimeout(200);
      const held = await c.locator('dialog[open]').count();
      await c.getByRole('button', { name: '창 닫기' }).click();
      await c.waitForTimeout(300);
      check('적대 검토: 사진 고르기를 취소해도 묻지 않고, 닫은 창이 빈 채로 다시 열리지 않음', asked2 === 0 && held === 1 && (await c.locator('dialog[open]').count()) === 0, JSON.stringify({ asked2, held }));
      await c.close();
    }
    // 운동 이름 칸에 적고 추가를 누르지 않은 것도 쓰던 내용이다 · 시트에 쓰는 중에 ✕로 닫아도 저장 안내가 빠지지 않는다
    {
      const c = await workoutPage([], (path, x) => (path.endsWith('/rpc/save_workout') ? fulfill(x, '2026-11-03T01:00:00Z') : undefined));
      let release;
      await c.route('**/functions/v1/sheet-write', (x) => new Promise((go) => { release = () => go(fulfill(x, { status: 'busy', tab: '2611' })); }));
      await c.route('**/rest/v1/routines*', (x) => fulfill(x, [{ ...cur21, source: 'sheet', source_ref: '2611' }, prev21]));
      await c.reload();
      await c.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await c.getByTestId('start-workout').click();
      await c.getByLabel('운동 이름').fill('런지');
      const named = await back(c);
      check('적대 검토: 운동 이름 칸에 적고 추가하지 않은 것도 물음', named === 1, String(named));
      await c.getByLabel('운동 이름').fill('');
      await c.getByLabel('스쿼트 1세트 완료').check();
      await c.getByRole('button', { name: '운동 기록 저장' }).click();
      await c.waitForTimeout(400);
      await c.getByRole('button', { name: '창 닫기' }).click();
      await c.waitForTimeout(200);
      release?.();
      await c.locator('.toast.visible', { hasText: '저장했어요' }).waitFor({ timeout: 3000 }).catch(() => {});
      check('적대 검토: 시트에 쓰는 중에 ✕로 닫아도 쓰기가 실패하면 저장 안내가 나옴', (await c.locator('.toast.visible', { hasText: '저장했어요' }).count()) === 1);
      await c.close();
    }
    const { p: t } = await trainerPage(1);
    await t.locator('.member-row').first().click();
    await t.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '루틴' }).click();
    await t.getByRole('button', { name: /루틴 등록하기/ }).click();
    await t.getByRole('button', { name: '시트에서 복사해 붙여넣기' }).click();
    await t.getByRole('dialog').locator('.paste-box textarea').fill('운동\tSET\tREPS\t중량\n스쿼트\t3\t10\t40\n로우\t3\t12\t30');
    await t.getByRole('button', { name: '표로 읽기' }).click();
    await t.waitForTimeout(200);
    const routineAsked = await back(t);
    check('적대 검토: 표로 읽은 루틴도 뒤로 가기에서 물음', routineAsked === 1 && (await t.locator('dialog[open]').count()) === 1, String(routineAsked));
    await t.close();
    // 시트 쓰기만 실패한 화면: 기록은 저장됐으니 묻지 않고, 뒤로 닫아도 저장 안내가 나온다
    const r = await workoutPage([], (path, x) => (path.endsWith('/rpc/save_workout') ? fulfill(x, '2026-11-03T01:00:00Z') : undefined));
    await r.route('**/functions/v1/sheet-write', (x) => fulfill(x, { status: 'busy', tab: '2611' }));
    await r.route('**/rest/v1/routines*', (x) => fulfill(x, [{ ...cur21, source: 'sheet', source_ref: '2611' }, prev21]));
    await r.reload();
    await r.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await r.getByTestId('start-workout').click();
    await r.getByLabel('스쿼트 1세트 완료').check();
    await r.getByRole('button', { name: '운동 기록 저장' }).click();
    await r.getByTestId('sheet-fail').waitFor({ timeout: 5000 });
    // 같은 창에서 다시 저장해 시트 쓰기까지 되면 저장 안내는 한 번만
    {
      const q = await workoutPage([], (path, x) => (path.endsWith('/rpc/save_workout') ? fulfill(x, '2026-11-03T01:00:00Z') : undefined));
      let reply = { status: 'busy', tab: '2611' };
      await q.route('**/functions/v1/sheet-write', (x) => fulfill(x, reply));
      await q.route('**/rest/v1/routines*', (x) => fulfill(x, [{ ...cur21, source: 'sheet', source_ref: '2611' }, prev21]));
      await q.reload();
      await q.evaluate(() => {
        window.__toasts = [];
        new MutationObserver(() => document.querySelectorAll('.toast.visible').forEach((t) => { if (!window.__toasts.includes(t.textContent)) window.__toasts.push(t.textContent); })).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      });
      await q.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await q.getByTestId('start-workout').click();
      await q.getByLabel('스쿼트 1세트 완료').check();
      await q.getByRole('button', { name: '운동 기록 저장' }).click();
      await q.getByTestId('sheet-fail').waitFor({ timeout: 5000 });
      reply = { status: 'written', tab: '2611', col: 'E', skipped: [], kept: [], owned: 1 };
      await q.getByRole('button', { name: '운동 기록 저장' }).click();
      await q.locator('dialog[open]').waitFor({ state: 'detached', timeout: 5000 });
      await q.waitForTimeout(300);
      const toasts = await q.evaluate(() => window.__toasts.filter((t) => t.includes('저장했어요')));
      check('적대 검토: 같은 창에서 다시 저장해 끝나면 저장 안내는 한 번만', toasts.length === 1, JSON.stringify(toasts));
      await q.close();
    }
    const failAsked = await back(r);
    await r.locator('.toast.visible').first().waitFor({ timeout: 3000 }).catch(() => {});
    check('적대 검토: 시트 쓰기만 실패한 화면은 묻지 않고 닫히며 저장 안내가 나옴', failAsked === 0 && (await r.locator('dialog[open]').count()) === 0 && (await r.locator('.toast.visible').count()) >= 1, String(failAsked));
    await r.close();
  });

  // 36-1e) v2.3.0 1차 리뷰 재현: 저장 전 총평을 전부 지운 상태도 쓰던 내용이다
  await soft('2.3 1차 리뷰 총평 삭제 초안', async () => {
    const { p } = await trainerPage(1);
    const rec = (id, measured_on) => ({ id, member_id: 'm', measured_on, weight_kg: 72, smm_kg: 31, pbf_pct: 22, source: 'manual', created_at: `${measured_on}T01:00:00Z`, updated_at: `${measured_on}T01:00:00Z` });
    await p.route('**/rest/v1/inbody_records*', (r) => fulfill(r, [rec('i2', '2026-11-03'), rec('i1', '2026-10-06')]));
    await p.route('**/rest/v1/rpc/report_note', (r) => fulfill(r, { body: '원래 총평', trainer: '검증', updated_at: '2026-11-03T01:00:00Z' }));
    await p.route('**/rest/v1/rpc/diet_report', (r) => fulfill(r, { days: 28, logged_days: 1, meals: 1, rated: 0, great: 0, good: 0, care: 0, score: null }));
    await p.route('**/rest/v1/rpc/workout_summary', (r) => fulfill(r, { days: 0, done_sets: 0, cardio_count: 0, cardio_minutes: 0, cardio_km: 0 }));
    await p.route('**/rest/v1/rpc/diet_period', (r) => fulfill(r, { days: [], types: [] }));
    await p.locator('.member-row').first().click();
    await p.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '인바디' }).click();
    await p.getByRole('button', { name: /자세히 보기/ }).first().click();
    const note = p.getByLabel('트레이너 총평');
    await note.waitFor({ timeout: 10000 });
    await p.waitForTimeout(300);
    await note.fill('');
    let asked = 0;
    p.on('dialog', (d) => { asked++; void d.dismiss(); });
    await p.evaluate(() => history.back());
    await p.waitForTimeout(400);
    const afterBack = await p.locator('dialog[open]').count();
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    check('1차 리뷰 5번: 총평을 지운 초안도 뒤로·Esc에서 물어보고 취소하면 그대로', asked === 2 && afterBack === 1 && (await p.locator('dialog[open]').count()) === 1 && (await note.inputValue()) === '', JSON.stringify({ asked, afterBack }));
    // 저장 뒤 다시 받기가 실패해도 저장한 글은 쓰던 내용이 아니다
    await p.route('**/rest/v1/rpc/save_report_note', (r) => fulfill(r, null));
    await p.unroute('**/rest/v1/rpc/report_note');
    await p.route('**/rest/v1/rpc/report_note', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await note.fill('다시 받기 실패 글');
    await p.getByRole('button', { name: '총평 저장' }).click();
    await p.waitForTimeout(500);
    const before5 = asked;
    await p.evaluate(() => history.back());
    await p.waitForTimeout(400);
    check('적대 검토: 총평 저장 뒤 다시 받기가 실패해도 저장한 글로 묻지 않음', asked === before5 && (await p.locator('dialog[open]').count()) === 0, String(asked - before5));
    await p.getByRole('button', { name: /자세히 보기/ }).first().click();
    await note.waitFor({ timeout: 5000 }).catch(() => {});
    await p.unroute('**/rest/v1/rpc/report_note');
    await p.route('**/rest/v1/rpc/report_note', (r) => fulfill(r, { body: '원래 총평', trainer: '검증', updated_at: '2026-11-03T01:00:00Z' }));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(500);
    // 저장 뒤 처음 글로 되돌린 것도 저장 전 변경이다
    await p.route('**/rest/v1/rpc/save_report_note', (r) => fulfill(r, null));
    await p.unroute('**/rest/v1/rpc/report_note');
    await p.route('**/rest/v1/rpc/report_note', (r) => fulfill(r, { body: '새 글', trainer: '검증', updated_at: '2026-11-03T02:00:00Z' }));
    await note.fill('새 글');
    await p.getByRole('button', { name: '총평 저장' }).click();
    await p.waitForTimeout(500);
    await note.fill('원래 총평');
    const was = asked;
    await p.evaluate(() => history.back());
    await p.waitForTimeout(400);
    check('적대 검토: 저장 뒤 처음 글로 되돌린 총평도 물음', asked === was + 1, String(asked - was));
    await p.close();
  });

  // 36-1b) 2.3 운동 꿀팁 표시: 취소하면 저장된 값으로 · 읽지 못했으면 저장할 때 표시를 건드리지 않음
  await soft('2.3 운동 꿀팁 표시', async () => {
    const open = async (fail) => {
      const { p } = await trainerPage(1);
      const sent = [];
      await p.route('**/rest/v1/trainer_messages*', (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, null)));
      await p.route('**/rest/v1/rpc/set_trainer_message', (r) => { sent.push(r.request().postDataJSON()); return fulfill(r, null); });
      await p.reload();
      await p.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
      await p.getByRole('button', { name: '한마디 쓰기' }).waitFor({ timeout: 10000 });
      return { p, sent };
    };
    // 2차 리뷰 3번: 표시만 바꾼 것도 쓰던 내용이다
    {
      const { p: e } = await trainerPage(1);
      await e.route('**/rest/v1/trainer_messages*', (r) => fulfill(r, { day: '2026-11-04', body: '있던 한마디', is_tip: false }));
      await e.reload();
      await e.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
      await e.getByRole('button', { name: '고치기' }).click();
      let asked = 0;
      e.on('dialog', (d) => { asked++; void d.dismiss(); });
      const tip = e.getByLabel('운동 꿀팁으로 표시');
      await tip.check();
      await e.evaluate(() => history.back());
      await e.waitForTimeout(300);
      check('2차 리뷰 3번: 꿀팁 표시만 바꿔도 뒤로 가기에서 묻고 취소하면 그대로', asked === 1 && (await tip.isChecked()), String(asked));
      await tip.uncheck();
      await e.evaluate(() => history.back());
      await e.waitForTimeout(300);
      const tab = await e.locator('.bottom-nav .nav-item.active').innerText();
      check('2차 리뷰 3번: 표시를 원래대로 되돌리면 묻지 않음', asked === 1 && tab.startsWith('확인'), JSON.stringify({ asked, tab }));
      await e.close();
    }
    const { p, sent } = await open(false);
    await p.getByRole('button', { name: '한마디 쓰기' }).click();
    await p.getByLabel('운동 꿀팁으로 표시').check();
    await p.locator('.today-word').getByRole('button', { name: '취소' }).click();
    await p.getByRole('button', { name: '한마디 쓰기' }).click();
    const reset = await p.getByLabel('운동 꿀팁으로 표시').isChecked();
    await p.getByLabel('운동 꿀팁으로 표시').check();
    await p.locator('.today-word textarea').fill('무릎은 발끝 방향으로');
    await p.locator('.today-word').getByRole('button', { name: '저장' }).click();
    await p.getByRole('button', { name: '지우기' }).click();
    await p.getByRole('button', { name: '한마디 쓰기' }).click();
    check('2.3 꿀팁 표시: 취소하면 되돌림 · 지운 뒤 새로 쓰면 꺼져 있음', !reset && sent[0]?.p_is_tip === true && !(await p.getByLabel('운동 꿀팁으로 표시').isChecked()), JSON.stringify({ reset, sent }));
    await p.close();
    const q = await open(true);
    await q.p.getByRole('button', { name: '한마디 쓰기' }).click();
    await q.p.locator('.today-word textarea').fill('다시 씀');
    await q.p.locator('.today-word').getByRole('button', { name: '저장' }).click();
    await q.p.waitForTimeout(400);
    check('2.3 꿀팁 표시: 저장된 값을 읽지 못했으면 표시를 건드리지 않음(null)', q.sent[0]?.p_is_tip === null, JSON.stringify(q.sent));
    await q.p.close();
  });

  // 36-2) 2.3 이달의 중량왕 칸: 자기 성별 탭 먼저 · 탭마다 세 동작 × 두 칸 · 빈 칸 · 내 기록 · 안내
  await soft('2.3 이달의 중량왕', async () => {
    const king = (gender, lift, metric, value, names) => ({ gender, lift, metric, value, names: names.map((n) => ({ nickname: n.replace(' (나)', ''), is_me: n.endsWith(' (나)') })) });
    const open = async (reply) => {
      const p = await workoutPage([], (path, r) => (path.endsWith('/rpc/strength_kings') ? (reply === 'fail' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, reply)) : undefined));
      await p.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
      await p.getByTestId('standing-strength').click();
      const card = p.getByTestId('strength-kings');
      await card.waitFor({ timeout: 10000 });
      return { p, card };
    };
    const data = { month: '2026-11-01', my_gender: 'female', my_state: 'ok', kings: [king('male', '벤치 프레스', 'kg', 82.5, ['신지호']), king('female', '벤치 프레스', 'kg', 45, ['강민지 (나)', '최예린']), king('female', '벤치 프레스', 'pct', 78, ['강민지 (나)'])], mine: [{ lift: '스쿼트', kg: 40, kg_rank: 3, pct: null, pct_rank: null, body_kg: null }, { lift: '벤치 프레스', kg: 45, kg_rank: 2, pct: 78, pct_rank: 1, body_kg: 57.5 }, { lift: '데드리프트', kg: 70, kg_rank: 1, pct: 122, pct_rank: null, body_kg: 57.5 }] };
    const { p, card } = await open(data);
    await card.getByRole('group', { name: '성별' }).waitFor({ timeout: 5000 });
    const female = (await card.innerText()).replace(/\s+/g, ' ');
    const cols = await card.evaluate((el) => { const left = (n) => n.getBoundingClientRect().left; return { head: [...el.querySelectorAll('.strength-cols span')].slice(1).map(left), cells: [...[...el.querySelectorAll('.strength-row')].at(-1).querySelectorAll('.strength-king')].map(left) }; });
    check('2.3.3 중량왕: 무게·체중 대비 머리글이 아래 칸과 같은 자리에서 시작', cols.cells.length === 2 && cols.head.every((x, i) => Math.abs(x - cols.cells[i]) <= 1), JSON.stringify(cols));
    const pressed = await card.getByRole('group', { name: '성별' }).locator('button[aria-pressed="true"]').innerText();
    check('2.3 중량왕: 내 성별 탭 먼저 · 무게 kg(× 5 없음) · 체중 대비 % · 공동은 이름 하나와 외 n명 · 내 칸 표시 · 빈 칸은 아직 없어요', pressed === '여자' && (await p.getByRole('heading', { name: '11월 중량왕' }).count()) === 1 && female.includes('강민지 (나) 외 1명 45kg') && female.includes('78%') && !female.includes('× 5') && (await card.locator('.strength-king.is-me').count()) === 2 && (await card.locator('.strength-king.is-empty').count()) === 4, female);
    const mine = (await card.getByTestId('strength-mine').innerText()).replace(/\s+/g, ' ');
    check('2.3 중량왕 내 기록: 동작 순서대로 한 줄씩 · 순위 · 무게 왕은 체중 대비 순위 없음', mine.includes('벤치 프레스 45kg 2위 체중 대비 78% 1위 데드리프트 70kg 1위 체중 대비 122% 스쿼트 40kg 3위') && !mine.includes('122% 1위'), mine);
    await card.getByRole('button', { name: '남자', exact: true }).click();
    const male = (await card.innerText()).replace(/\s+/g, ' ');
    check('2.3 중량왕 다른 탭: 그 성별의 왕 · 소수 무게 · 내 기록은 내 성별 탭에만', male.includes('신지호') && male.includes('82.5kg') && (await card.getByTestId('strength-mine').count()) === 0, male);
    const box = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    check('2.3 중량왕: 가로로 넘치지 않음', box[0] <= box[1], JSON.stringify(box));
    await p.close();
    const hidden = await open({ ...data, my_gender: null, my_state: 'hidden', mine: [] });
    await hidden.card.locator('.strength-note').waitFor({ timeout: 5000 });
    check('2.3 중량왕 공개하지 않은 회원: 남자 탭부터 · 후보에서 빠졌다는 안내', (await hidden.card.getByRole('group', { name: '성별' }).locator('button[aria-pressed="true"]').innerText()) === '남자' && (await hidden.card.locator('.strength-note').innerText()).includes('비공개로 설정해'));
    await hidden.p.close();
    const none = await open({ ...data, my_gender: null, my_state: 'no_gender', mine: [] });
    await none.card.locator('.strength-note').waitFor({ timeout: 5000 });
    check('2.3 중량왕 성별을 정하지 않은 회원: 어디서 정하는지 안내', (await none.card.locator('.strength-note').innerText()).includes('설정 → 계정'));
    await none.p.close();
    // 수상을 시작하기 전 달(10월)은 지난 수상에 중량왕 카드를 만들지 않는다
    {
      const q = await workoutPage([], (path, r) => (path.endsWith('/rpc/strength_kings') ? fulfill(r, r.request().postDataJSON().p_month === '2026-11-01' ? data : { month: r.request().postDataJSON().p_month, started: false, kings: [], mine: [], my_gender: null, my_state: null }) : undefined));
      await q.locator('.bottom-nav').getByRole('button', { name: '커뮤니티', exact: true }).click();
      await q.getByTestId('awards').getByRole('button').click();
      await q.getByTestId('award-history').waitFor({ timeout: 5000 });
      await q.waitForTimeout(500);
      check('2.3 중량왕: 수상 시작 전 달(10월)은 지난 수상에 카드 없음', (await q.getByTestId('strength-last').count()) === 0);
      await q.close();
    }
    const failed = await open('fail');
    await failed.card.getByText('중량왕을 불러오지 못했어요').waitFor({ timeout: 5000 });
    check('2.3 중량왕 실패: 칸 안에서만 알림', true);
    await failed.p.close();
  });

  // 36-3) 2.3 인바디 변화 보고서: 회원은 읽기만 · 칸마다 따로 실패 · 트레이너는 총평을 쓴다
  await soft('2.3 변화 보고서', async () => {
    const ib = (id, measured_on, weight_kg, smm_kg, pbf_pct) => ({ id, member_id: a, measured_on, weight_kg, smm_kg, pbf_pct, source: 'manual', created_at: `${measured_on}T01:00:00Z`, updated_at: `${measured_on}T01:00:00Z` });
    const records = [ib('i2', '2026-11-03', 72.1, 31.6, 22.8), ib('i1', '2026-10-06', 73.8, 31.2, 24.1)];
    const period = { days: [{ day: '2026-10-07', meals: 3, rated: 2, score_sum: 10 }, { day: '2026-10-15', meals: 2, rated: 2, score_sum: 2 }], types: [{ meal_type: '점심', great: 1, good: 0, care: 2, none: 1 }, { meal_type: '아침', great: 1, good: 0, care: 0, none: 0 }] };
    const set = (name, kg) => ({ item_id: null, name, set_no: 1, kg, reps: '5', done: true, ord: 1 });
    const list = [ses21('s3', '2026-10-28', 1, [set('스쿼트', '72.5')]), ses21('s2', '2026-10-20', null, [], 'r-new', [{ kind: 'run', minutes: 30, km: 5, speed: null, ord: 1 }]), ses21('s1', '2026-10-07', 1, [set('스쿼트', '65')])];
    const open = async ({ failPeriod = false, note = { body: '하체 무게가 올랐어요.', trainer: '검증 코치', updated_at: '2026-11-03T16:00:00Z' } } = {}) => {
      const p = await workoutPage(list, (path, r) => {
        if (path.endsWith('/inbody_records')) return fulfill(r, records);
        if (path.endsWith('/rpc/diet_report')) return fulfill(r, { days: 28, logged_days: 24, meals: 61, rated: 55, great: 30, good: 20, care: 5, score: 4.1 });
        if (path.endsWith('/rpc/workout_summary')) return fulfill(r, { days: 13, done_sets: 186, cardio_count: 3, cardio_minutes: 90, cardio_km: 12 });
        if (path.endsWith('/rpc/diet_period')) return failPeriod ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, period);
        if (path.endsWith('/rpc/report_note')) return fulfill(r, note);
        if (path.endsWith('/fasting_weights')) return fulfill(r, r.request().url().includes('day=gte.2026-10-07') && r.request().url().includes('day=lte.2026-11-03') ? [{ day: '2026-10-20', kg: 73 }, { day: '2026-11-01', kg: 72 }] : []);
        return undefined;
      }, '2026-11-05T10:00:00+09:00');
      await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디' }).click();
      await p.getByRole('button', { name: /자세히 보기/ }).first().click();
      const box = p.getByTestId('change-report');
      await box.waitFor({ timeout: 10000 });
      return { p, box };
    };
    {
      // 1차 리뷰 1번: 요약 응답이 끝나지 않으면 15초 뒤 알리고 다시 받는다
      const hold = { on: true };
      const q = await workoutPage(list, (path, r) => {
        if (path.endsWith('/inbody_records')) return fulfill(r, records);
        if (path.endsWith('/rpc/diet_report') || path.endsWith('/rpc/workout_summary')) {
          if (hold.on) return new Promise(() => {});
          return fulfill(r, path.endsWith('diet_report') ? { days: 28, logged_days: 24, meals: 61, rated: 55, great: 30, good: 20, care: 5, score: 4.1 } : { days: 13, done_sets: 186, cardio_count: 0, cardio_minutes: 0, cardio_km: 0 });
        }
        if (path.endsWith('/rpc/diet_period')) return fulfill(r, period);
        if (path.endsWith('/rpc/report_note')) return fulfill(r, null);
        return undefined;
      }, '2026-11-05T10:00:00+09:00');
      await q.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디' }).click();
      await q.getByRole('button', { name: /자세히 보기/ }).first().click();
      const rep = q.getByTestId('change-report');
      await rep.waitFor({ timeout: 10000 });
      await q.clock.fastForward('00:16');
      await q.waitForTimeout(300);
      const retry = rep.getByRole('button', { name: '다시 불러오기' });
      check('1차 리뷰 1번: 요약 응답이 없으면 15초 뒤 로딩이 끝나고 다시 불러오기가 보임', (await retry.count()) >= 1 && !(await rep.innerText()).includes('불러오는 중'), (await rep.innerText()).slice(0, 160));
      hold.on = false;
      if (await retry.count()) await retry.first().click();
      await rep.getByText(/평가 평균 4.1점/).waitFor({ timeout: 5000 }).catch(() => {});
      check('1차 리뷰 1번: 다시 불러오면 요약이 들어옴', (await rep.innerText()).includes('평가 평균 4.1점') && (await rep.innerText()).includes('운동한 날 13일'));
      await q.close();
    }
    const { p, box } = await open();
    await box.getByTestId('period-calendar').waitFor({ timeout: 5000 });
    await box.getByText('하체 무게가 올랐어요.').waitFor({ timeout: 5000 });
    const text = (await box.innerText()).replace(/\s+/g, ' ');
    check('2.3 보고서 회원: 기간 · 한눈에 · 체성분 값과 증감 · 기간 안 공복 체중만', text.includes('10월 7일 ～ 11월 3일') && text.includes('평가 평균 4.1점 / 5점') && text.includes('운동한 날 13일 · 완료 186세트 · 유산소 3회 90분 12km') && text.includes('체중·체지방률이 내려가고 골격근량이 늘었어요') && text.includes('72.1kg') && text.includes('-1.7kg') && text.includes('+0.4kg') && text.includes('-1.3%p') && text.includes('공복 체중 2번: 73.0 → 72.0kg'), text);
    check('2.3 보고서 달력: 평가 색과 운동 표시', (await box.locator('[data-day="2026-10-07"] .tone-great').count()) === 1 && (await box.locator('[data-day="2026-10-15"] .tone-care').count()) === 1 && (await box.locator('[data-day="2026-10-07"] em').count()) === 1 && (await box.locator('[data-day="2026-10-20"] em.is-cardio').count()) === 1);
    check('2.3 보고서 식단 흐름: 주별 막대 · 끼니는 아침·점심 순서', (await box.getByTestId('report-weeks').locator('> div').count()) === 4 && (await box.getByTestId('report-types').locator('b').allInnerTexts()).join('|') === '아침|점심');
    check('2.3 보고서 운동 변화: 횟수 · 처음 → 끝', text.includes('루틴 1 2회') && text.includes('유산소 1회') && (await box.getByTestId('report-lifts').innerText()).replace(/\s+/g, ' ').includes('65 → 72.5kg+7.5'), text);
    check('2.3 보고서 총평(회원): 읽기만 · 쓴 사람과 한국 날짜', text.includes('검증 코치 트레이너 · 11월 4일') && (await box.getByRole('textbox').count()) === 0, text);
    const size = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    check('2.3 보고서: 가로로 넘치지 않음', size[0] <= size[1], JSON.stringify(size));
    await p.close();
    {
      // 적대 검토: 공복 체중만 실패해도 다시 불러오기가 있고 · 15초 뒤 늦게 온 요약도 받아 넣는다
      let release;
      const hold = new Promise((go) => { release = go; });
      const q = await workoutPage(list, (path, r) => {
        if (path.endsWith('/inbody_records')) return fulfill(r, records);
        if (path.endsWith('/rpc/diet_report')) return hold.then(() => fulfill(r, { days: 28, logged_days: 24, meals: 61, rated: 55, great: 30, good: 20, care: 5, score: 4.1 }));
        if (path.endsWith('/rpc/workout_summary')) return fulfill(r, { days: 13, done_sets: 186, cardio_count: 0, cardio_minutes: 0, cardio_km: 0 });
        if (path.endsWith('/rpc/diet_period')) return fulfill(r, period);
        if (path.endsWith('/rpc/report_note')) return fulfill(r, null);
        if (path.endsWith('/fasting_weights')) return r.request().url().includes('gte') ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, []);
        return undefined;
      }, '2026-11-05T10:00:00+09:00');
      await q.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '인바디' }).click();
      await q.getByRole('button', { name: /자세히 보기/ }).first().click();
      const rep = q.getByTestId('change-report');
      await rep.waitFor({ timeout: 10000 });
      await q.waitForTimeout(400);
      check('적대 검토: 공복 체중 첫 조회가 실패해도 다시 불러오기가 있음', (await rep.getByRole('button', { name: '다시 불러오기' }).count()) >= 1);
      await q.clock.fastForward('00:16');
      await q.waitForTimeout(200);
      release();
      await rep.getByText(/평가 평균 4.1점/).waitFor({ timeout: 5000 }).catch(() => {});
      check('적대 검토: 15초 뒤 늦게 온 요약도 받아 넣음(기존 변화 카드와 같음)', (await rep.innerText()).includes('평가 평균 4.1점'));
      await q.close();
    }
    const failed = await open({ failPeriod: true, note: null });
    await failed.box.getByText('식단 평가를 불러오지 못했어요').waitFor({ timeout: 5000 });
    await failed.box.getByText('아직 총평이 없어요.').waitFor({ timeout: 5000 });
    check('2.3 보고서 칸 하나가 실패해도 나머지는 보임', (await failed.box.getByTestId('report-lifts').count()) === 1 && (await failed.box.innerText()).includes('평가 평균 4.1점'));
    await failed.p.close();
  });

  // 36-3b) 2.3.1 받은 피드백의 뒤로 · 아이폰 홈 화면 앱의 탭(사용자 지적 11-06: 피드백은 화살표로만 돌아가고, 운동 탭은 밀어서 식단으로 갔다)
  await soft('2.3.1 받은 피드백과 탭의 뒤로', async () => {
    const memberPage = async (init) => {
      const p = await ctx.newPage();
      if (init) await p.addInitScript(init);
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.getByTestId('feedback-entry').waitFor({ timeout: 15000 });
      return p;
    };
    const depth = (p) => p.evaluate(() => history.state?.backDepth ?? 0);
    const tab = (p, name) => p.locator('.bottom-nav').getByRole('button', { name, exact: true }).click();
    const onTab = (p) => p.locator('.bottom-nav .nav-item.active').innerText();
    const feedback = (p) => p.getByRole('heading', { name: '받은 피드백' });
    const openFeedback = async (p) => { await p.getByTestId('feedback-entry').click(); await feedback(p).waitFor({ timeout: 5000 }); };
    const swipeOn = (p) => (from, to, { hold = false } = {}) => p.evaluate(async ({ from, to, hold }) => {
      const fire = (type, x) => {
        const t = new Touch({ identifier: 7, target: document.body, clientX: x, clientY: 300 });
        document.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
      };
      fire('touchstart', from);
      for (let i = 1; i <= 8; i++) { fire('touchmove', from + ((to - from) * i) / 8); await new Promise((r) => setTimeout(r, 50)); }
      if (!hold) fire('touchend', to);
    }, { from, to, hold });
    {
      const p = await memberPage(() => Object.defineProperty(navigator, 'standalone', { value: true }));
      const swipe = swipeOn(p);
      const before = await p.evaluate(() => history.length);
      await tab(p, '운동');
      await p.getByRole('group', { name: '운동 화면' }).waitFor({ timeout: 5000 });
      await tab(p, '설정');
      await p.waitForTimeout(100);
      const after = await p.evaluate(() => history.length);
      check('2.3.1 아이폰 홈 화면 앱: 탭을 옮겨도 기록에 칸이 생기지 않아 시스템 밀기가 살아나지 않음', after === before && (await depth(p)) === 0, JSON.stringify({ before, after }));
      await swipe(5, 300);
      await p.waitForTimeout(350);
      check('2.3.1 아이폰 홈 화면 앱: 탭에서 왼쪽 끝을 밀어도 탭이 바뀌지 않음', (await onTab(p)).startsWith('설정'), await onTab(p));
      await p.getByTestId('help-button').click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      const sheetDepth = await depth(p);
      await p.evaluate(() => history.back());
      await p.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(400);
      check('2.3.1 아이폰 홈 화면 앱: 창은 칸을 두어 시스템 밀기로 닫고 탭은 그대로', sheetDepth === 1 && (await p.locator('dialog[open]').count()) === 0 && (await onTab(p)).startsWith('설정') && (await depth(p)) === 0, JSON.stringify({ sheetDepth }));
      await tab(p, '식단');
      await openFeedback(p);
      const open = await depth(p);
      await swipe(5, 300, { hold: true });
      await p.locator('.swipe-under [data-testid=feedback-entry]').waitFor({ timeout: 3000 });
      await p.evaluate(() => { const t = new Touch({ identifier: 7, target: document.body, clientX: 300, clientY: 300 }); document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t] })); });
      await p.locator('[data-testid=feedback-entry]:not(.swipe-under *)').waitFor({ timeout: 5000 });
      await p.waitForTimeout(400);
      check('2.3.1 받은 피드백: 왼쪽 끝을 밀면 아래에 식단 화면이 보이고 식단으로 돌아감 · 아이폰은 기록 칸 없이', open === 0 && (await feedback(p).count()) === 0 && (await p.locator('.swipe-under').count()) === 0 && (await depth(p)) === 0, JSON.stringify({ open }));
      await openFeedback(p);
      await p.getByRole('button', { name: /식단으로/ }).click();
      await p.getByTestId('feedback-entry').waitFor({ timeout: 5000 });
      await p.waitForTimeout(400);
      check('2.3.1 받은 피드백: 위 화살표로 돌아가도 기록에 칸이 남지 않음', (await depth(p)) === 0, String(await depth(p)));
      await openFeedback(p);
      await tab(p, '운동');
      await p.waitForTimeout(400);
      const left = await depth(p);
      await tab(p, '식단');
      await feedback(p).waitFor({ timeout: 5000 });
      await p.waitForTimeout(300);
      check('2.3.1 받은 피드백: 아이폰은 탭을 오가도 기록 칸이 없음', left === 0 && (await depth(p)) === 0, JSON.stringify({ left }));
      // 11-06 사용자 지적: 알림으로 받은 피드백을 열고 밀면 빈 화면. 앱이 켜져 있을 때와 알림으로 새로 켤 때 모두 칸 없이 앱의 밀기로 돌아간다
      const pushPending = () => p.evaluate(async (uid) => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open('mealnote-push', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ open: 'feedback', uid, at: Date.now() }, 'open'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        db.close();
      }, a);
      const backFromPush = async (label) => {
        await feedback(p).waitFor({ timeout: 15000 });
        await p.waitForTimeout(300);
        const entry = await depth(p);
        await swipe(5, 300, { hold: true });
        await p.locator('.swipe-under [data-testid=feedback-entry]').waitFor({ timeout: 3000 });
        await p.evaluate(() => { const t = new Touch({ identifier: 7, target: document.body, clientX: 300, clientY: 300 }); document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t] })); });
        await p.locator('[data-testid=feedback-entry]:not(.swipe-under *)').waitFor({ timeout: 5000 });
        await p.waitForTimeout(300);
        check(`2.3.3 아이폰 ${label}: 받은 피드백에 기록 칸이 없고, 밀면 아래에 식단 화면이 보이며 식단으로 돌아감`, entry === 0 && (await feedback(p).count()) === 0 && (await p.locator('.swipe-under').count()) === 0 && (await depth(p)) === 0, JSON.stringify({ entry }));
      };
      await p.getByRole('button', { name: /식단으로/ }).click();
      await tab(p, '운동');
      await p.getByRole('group', { name: '운동 화면' }).waitFor({ timeout: 5000 });
      await pushPending();
      await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await backFromPush('켜져 있는 앱에서 알림');
      await pushPending();
      await p.reload();
      await backFromPush('알림으로 새로 켠 앱');
      await p.close();
    }
    {
      const p = await memberPage();
      await tab(p, '운동');
      await p.getByRole('group', { name: '운동 화면' }).waitFor({ timeout: 5000 });
      await p.waitForTimeout(100);
      const tabDepth = await depth(p);
      await p.evaluate(() => history.back());
      await p.getByTestId('feedback-entry').waitFor({ timeout: 5000 });
      await p.waitForTimeout(300);
      check('2.3.1 안드로이드: 시스템 뒤로는 그대로 첫 탭으로 감', tabDepth === 1 && (await onTab(p)).startsWith('식단') && (await depth(p)) === 0, JSON.stringify({ tabDepth }));
      await openFeedback(p);
      await p.evaluate(() => history.back());
      await p.getByTestId('feedback-entry').waitFor({ timeout: 5000 });
      check('2.3.1 안드로이드: 받은 피드백에서 시스템 뒤로는 식단 화면으로', (await feedback(p).count()) === 0);
      await p.close();
    }
  });

  // 36-3d) 2.3.3 아직 안 한 설정을 하루 한 번 알림 · 식단 사진은 잘리지 않음
  await soft('2.3.3 하루 한 번 설정 권유', async () => {
    const c = await browser.newContext({ ...devices['iPhone 13'] });
    await c.addInitScript(() => { localStorage.setItem('mealnote:start-guide', '2.0'); localStorage.setItem('mealnote:whats-new', '2.3'); });
    const open = async (sheet) => {
      const p = await c.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routine_sources')) return sheet(r);
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        // 2.4: 설정 권유는 서버에서 로그인이 살아 있는 기기(자기 프로필이 보임)에만
        if (path.endsWith('/profiles')) return fulfill(r, [{ id: 'me' }]);
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.getByTestId('feedback-entry').waitFor({ timeout: 15000 });
      return p;
    };
    const stored = (p) => p.evaluate(() => localStorage.getItem('mealnote:setup-nudge'));
    const wake = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const box = (p) => p.getByTestId('setup-nudge');
    {
      const p = await open((r) => fulfill(r, null));
      await box(p).waitFor({ timeout: 5000 });
      check('시트를 연결하지 않은 회원: 창에 운동 시트 연결', (await box(p).getByRole('button', { name: /운동 시트 연결/ }).count()) === 1 && (await stored(p)) === '2026-11-03', await stored(p));
      await p.getByRole('button', { name: '나중에 할게요' }).click();
      await p.reload();
      await p.getByTestId('feedback-entry').waitFor({ timeout: 15000 });
      await p.waitForTimeout(700);
      check('같은 날 다시 열어도 뜨지 않음', (await box(p).count()) === 0);
      await p.clock.setSystemTime(new Date('2026-11-04T10:00:00+09:00'));
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      await box(p).getByRole('button', { name: /운동 시트 연결/ }).click();
      await p.getByTestId('sheet-link-form').waitFor({ timeout: 5000 });
      check('다음 날 다시 뜨고, 줄을 누르면 연결 창으로 감', (await stored(p)) === '2026-11-04', await stored(p));
      await p.close();
    }
    await c.clearCookies();
    await c.addInitScript(() => { if (!sessionStorage.getItem('fresh')) { sessionStorage.setItem('fresh', '1'); localStorage.removeItem('mealnote:setup-nudge'); } });
    {
      const p = await open((r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
      await p.waitForTimeout(900);
      const items = await box(p).locator('.setup-row').allInnerTexts();
      check('시트 조회가 실패하면 시트를 안 했다고 말하지 않음', !items.join(' ').includes('운동 시트'), JSON.stringify(items));
      await p.close();
    }
    {
      let release, held = false;
      const p = await open((r) => { if (held) return fulfill(r, null); held = true; return new Promise((go) => { release = () => go(fulfill(r, null)); }); });
      await p.getByTestId('help-button').click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      for (let i = 0; i < 30 && !release; i++) await p.waitForTimeout(100);
      release?.();
      await p.waitForTimeout(500);
      const during = { box: await box(p).count(), key: await stored(p) };
      await p.getByRole('button', { name: '창 닫기' }).click();
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      check('다른 창이 열려 있으면 두고, 앱으로 돌아올 때 띄움', during.box === 0 && during.key === null, JSON.stringify(during));
      const fit = await p.evaluate(() => { const make = (cls, tag) => { const e = document.createElement(tag); e.className = cls; document.body.append(e); return e; }; const wrap = make('meal-image', 'span'); const img = document.createElement('img'); wrap.append(img); const big = make('detail-photo', 'img'); return [getComputedStyle(img).objectFit, getComputedStyle(big).objectFit]; });
      check('식단 사진은 칸과 상세에서 잘리지 않음', fit.every((v) => v === 'contain'), JSON.stringify(fit));
      const area = await p.evaluate(async () => {
        const shot = async (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').fillRect(0, 0, w, h); const e = new Image(); e.className = 'detail-photo'; e.src = c.toDataURL(); await e.decode(); document.body.append(e); return e.getBoundingClientRect().height; };
        const none = document.createElement('div'); none.className = 'placeholder-photo'; document.body.append(none);
        return [await shot(900, 1600), await shot(1600, 900), await shot(1600, 400), none.getBoundingClientRect().height];
      });
      check('상세 사진 영역은 세로·가로·파노라마·사진 없음 모두 같은 높이(260px)', area.every((v) => v === 260), JSON.stringify(area));
      // 닫힘 소식은 다음 화면 틀에 온다. 그 전에 연 창이 앞 창의 소식에 닫히면 안 된다
      await p.evaluate(async () => { document.querySelector('dialog[open] [aria-label="창 닫기"]').click(); await null; document.querySelector('[data-testid=help-button]').click(); }); // 두 번 누름 사이에 화면이 그려지게 한다
      await p.waitForTimeout(300);
      check('창을 닫고 바로 연 창은 앞 창의 늦은 닫힘 소식에 닫히지 않음', (await p.locator('dialog[open]').count()) === 1, String(await p.locator('dialog[open]').count()));
      await p.close();
    }
    await c.close();
  });

  // 36-3b2) v2.3.3 1차 리뷰 재현: 설정을 끝내기 전에 시작한 확인이 늦게 와도 끝낸 설정을 다시 권하지 않는다
  await soft('2.3.3 설정을 끝낸 뒤 늦은 권유 확인', async () => {
    const LINK = { sheet_id: '1ExampleWorkoutSheet2611', last_read_at: '2026-11-03T01:00:00Z', last_error: '' };
    const open = async ({ held, saveFails = false, holdSave = false, holdTest = false }) => {
      const c = await browser.newContext({ ...devices['iPhone 13'] });
      await c.addInitScript(() => {
        localStorage.setItem('mealnote:start-guide', '2.0');
        localStorage.setItem('mealnote:whats-new', '2.3');
        const sub = { endpoint: 'https://push.example/late', toJSON: () => ({ keys: { p256dh: 'k', auth: 'a' } }) };
        window.__on = false;
        window.__seen = 'visible';
        Object.defineProperty(document, 'visibilityState', { get: () => window.__seen });
        Object.defineProperty(Notification, 'permission', { get: () => (window.__on ? 'granted' : 'default') });
        Notification.requestPermission = async () => { window.__on = true; return 'granted'; };
        const reg = { pushManager: { getSubscription: async () => (window.__on ? sub : null), subscribe: async () => sub } };
        Object.defineProperty(navigator.serviceWorker, 'ready', { value: Promise.resolve(reg) });
        navigator.serviceWorker.getRegistration = async () => reg;
      });
      const p = await c.newPage();
      await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
      const st = { linked: false, release: null, finish: null };
      let first = true;
      await p.route('**/functions/v1/**', (r) => fulfill(r, { status: 'unchanged' }));
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/routine_sources')) {
          if (first) { first = false; return new Promise((go) => { st.release = () => go(fulfill(r, held)); }); }
          return fulfill(r, st.linked ? LINK : null);
        }
        if (path.endsWith('/rpc/set_routine_sheet')) {
          if (saveFails) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          st.linked = true;
          if (holdSave) return new Promise((go) => { st.finish = () => go(fulfill(r, {})); });
          return fulfill(r, {});
        }
        if (path.endsWith('/rpc/register_push')) return fulfill(r, { status: 'ok' });
        if (path.endsWith('/rpc/push_test')) {
          if (holdTest) return new Promise((go) => { st.finish = () => go(fulfill(r, { status: 'ok' })); });
          return fulfill(r, { status: 'ok' });
        }
        if (path.endsWith('/rpc/push_registered')) return fulfill(r, true);
        if (path.endsWith('/push_prefs')) return fulfill(r, [{ digest: true, digest_times: '3', feedback: true, reminder: true, morning: true, updates: true }]);
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        // 2.4: 설정 권유는 서버에서 로그인이 살아 있는 기기(자기 프로필이 보임)에만
        if (path.endsWith('/profiles')) return fulfill(r, [{ id: 'me' }]);
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.getByTestId('feedback-entry').waitFor({ timeout: 15000 });
      for (let i = 0; i < 30 && !st.release; i++) await p.waitForTimeout(100);
      return { c, p, st };
    };
    const box = (p) => p.getByTestId('setup-nudge');
    const rows = async (p) => (await box(p).count()) ? (await box(p).locator('.setup-row b').allInnerTexts()).join(',') : '';
    const stored = (p) => p.evaluate(() => localStorage.getItem('mealnote:setup-nudge'));
    const wake = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const until = async (p, st, key) => { for (let i = 0; i < 50 && !st[key]; i++) await p.waitForTimeout(100); };
    const closeNow = async (p) => {
      await p.getByRole('button', { name: '창 닫기' }).click();
      await p.locator('dialog[open]').waitFor({ state: 'hidden', timeout: 5000 });
    };
    const toPush = async (p) => {
      await p.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
      await p.getByRole('button', { name: '알림', exact: true }).click();
      await p.getByRole('button', { name: '이 기기에서 알림 받기' }).click();
    };
    const toSheet = async (p) => {
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await p.getByTestId('sheet-line').getByRole('button', { name: '연결', exact: true }).click();
      await p.getByLabel('시트 링크').fill('https://docs.google.com/spreadsheets/d/1ExampleWorkoutSheet2611/edit');
      await p.getByRole('button', { name: '시트 연결하기', exact: true }).click();
    };
    {
      const { c, p, st } = await open({ held: null });
      await toSheet(p);
      await p.locator('dialog[open]').waitFor({ state: 'hidden', timeout: 5000 });
      st.release();
      await p.waitForTimeout(500);
      const late = { linked: st.linked, rows: await rows(p), key: await stored(p) };
      check('시트를 연결한 뒤 늦게 온 옛 응답으로 연결을 다시 권하지 않고 오늘 표시도 남기지 않음', late.linked && late.rows === '' && late.key === null, JSON.stringify(late));
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      const next = await rows(p);
      check('앱으로 돌아오면 지금 상태로 다시 확인해 남은 알림 설정만 권함', next === '알림 켜기', next);
      await c.close();
    }
    {
      const { c, p, st } = await open({ held: LINK });
      await toPush(p);
      await p.getByText('알림을 켰어요', { exact: false }).first().waitFor({ timeout: 5000 });
      await closeNow(p);
      st.release();
      await p.waitForTimeout(500);
      const late = { rows: await rows(p), key: await stored(p) };
      check('알림을 켠 뒤 늦게 온 옛 확인으로 알림을 다시 권하지 않음', late.rows === '' && late.key === null, JSON.stringify(late));
      await c.close();
    }
    {
      const { c, p, st } = await open({ held: null, holdSave: true });
      await toSheet(p);
      await until(p, st, 'finish');
      await closeNow(p);
      st.release();
      await p.waitForTimeout(500);
      const late = { rows: await rows(p), key: await stored(p) };
      st.finish();
      await p.waitForTimeout(300);
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      const next = await rows(p);
      check('저장 응답을 기다리는 동안 창을 닫아도 옛 응답으로 연결을 다시 권하지 않음', late.rows === '' && late.key === null && next === '알림 켜기', JSON.stringify({ ...late, next }));
      await c.close();
    }
    {
      const { c, p, st } = await open({ held: LINK, holdTest: true });
      await toPush(p);
      await until(p, st, 'finish');
      await closeNow(p);
      st.release();
      await p.waitForTimeout(500);
      const late = { rows: await rows(p), key: await stored(p) };
      st.finish();
      check('시험 알림 응답을 기다리는 동안 창을 닫아도 옛 확인으로 알림을 다시 권하지 않음', late.rows === '' && late.key === null, JSON.stringify(late));
      await c.close();
    }
    {
      const { c, p, st } = await open({ held: null, saveFails: true });
      await toSheet(p);
      await p.getByText('저장하지 못했어요', { exact: false }).first().waitFor({ timeout: 5000 });
      await closeNow(p);
      st.release();
      await p.waitForTimeout(500);
      const late = await rows(p);
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      const next = await rows(p);
      check('연결에 실패하면 앱으로 돌아올 때 지금 상태로 연결을 다시 권함', late === '' && next.includes('운동 시트 연결'), JSON.stringify({ late, next }));
      await c.close();
    }
    {
      const { c, p, st } = await open({ held: null });
      await p.evaluate(() => { window.__seen = 'hidden'; });
      st.release();
      await p.waitForTimeout(500);
      const hidden = { rows: await rows(p), key: await stored(p) };
      await p.evaluate(() => { window.__seen = 'visible'; });
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      check('앱이 숨은 동안 응답이 오면 오늘 표시를 남기지 않고 돌아올 때 띄움', hidden.rows === '' && hidden.key === null, JSON.stringify(hidden));
      await c.close();
    }
    {
      const { c, p, st } = await open({ held: null });
      await p.evaluate(() => { const e = document.createElement('input'); e.id = 'typing'; document.body.append(e); e.focus(); });
      st.release();
      await p.waitForTimeout(500);
      const typing = { rows: await rows(p), key: await stored(p) };
      await p.evaluate(() => document.getElementById('typing').remove());
      await wake(p);
      await box(p).waitFor({ timeout: 5000 });
      check('입력 칸을 쓰는 중이면 끊지 않고 돌아올 때 띄움', typing.rows === '' && typing.key === null, JSON.stringify(typing));
      await c.close();
    }
  });

  // 36-3c) v2.3.1 2차 리뷰 재현: 뒤로는 맨 위의 창을 닫는다 · 틀이 사라져도 밀던 상태가 남지 않는다 · 창은 자기 제목으로 불린다
  await soft('2.3.2 창 차례와 밀기 정리', async () => {
    const open = async () => {
      const p = await ctx.newPage();
      const st = { changed: false, assigned: true };
      await p.addInitScript((id) => {
        Object.defineProperty(navigator, 'standalone', { value: true });
        localStorage.setItem(`mealnote:security-ack:${id}`, JSON.stringify({ pin: '2026-11-06T00:00:00Z', fail: null }));
      }, a);
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/assignments')) return fulfill(r, st.assigned ? { trainer: { nickname: '검증 코치' } } : null);
        if (path.endsWith('/rpc/my_security_status')) return fulfill(r, { has_recovery: true, question: 1, pin_changed_at: st.changed ? '2026-11-06T01:00:00Z' : '2026-11-06T00:00:00Z', failed_count: 0, last_failed_at: null, locked_until: null, can_reclaim: true });
        if (path.endsWith('/rpc/my_gender')) return fulfill(r, { gender: null, hidden: false });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
        return fulfill(r, []);
      });
      await p.goto(`${BASE}?mode=member&security=1`);
      await p.getByTestId('feedback-entry').waitFor({ timeout: 15000 });
      const wake = () => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      return { p, st, wake, notice: async () => { st.changed = true; await wake(); await p.getByRole('dialog', { name: 'PIN이 바뀌었어요', exact: true }).waitFor({ timeout: 5000 }); } };
    };
    const noticeOn = (p) => p.getByRole('dialog', { name: 'PIN이 바뀌었어요', exact: true });
    for (const action of ['기록 뒤로', 'Esc']) {
      const { p, notice } = await open();
      await p.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
      await p.getByRole('group', { name: '성별', exact: true }).getByRole('button', { name: '남자', exact: true }).click();
      await p.getByTestId('gender-confirm').waitFor({ timeout: 5000 });
      await notice();
      const named = await noticeOn(p).count();
      if (action === 'Esc') await p.keyboard.press('Escape'); else await p.evaluate(() => history.back());
      await p.waitForTimeout(500);
      const first = { gender: await p.getByTestId('gender-confirm').count(), notice: await noticeOn(p).count() };
      check(`2.3.2 창 차례(${action}): 뒤에 뜬 보안 알림이 먼저 닫히고 성별 확인 창은 남음 · 창이 자기 제목으로 불림`, named === 1 && first.gender === 1 && first.notice === 0, JSON.stringify({ named, ...first }));
      if (action === 'Esc') await p.keyboard.press('Escape'); else await p.evaluate(() => history.back());
      await p.waitForTimeout(500);
      check(`2.3.2 창 차례(${action}): 한 번 더 뒤로 가면 성별 확인 창이 닫힘`, (await p.getByTestId('gender-confirm').count()) === 0);
      await p.close();
    }
    {
      const { p, notice } = await open();
      await p.getByTestId('help-button').click();
      await p.getByRole('button', { name: '다음', exact: true }).click();
      await p.getByRole('button', { name: '그림으로 알림 받는 방법 보기' }).click();
      const inner = p.getByRole('heading', { name: '휴대폰에서 새 소식 받기' });
      await inner.waitFor({ timeout: 5000 });
      await notice();
      await p.evaluate(() => history.back());
      await p.waitForTimeout(500);
      const one = { notice: await noticeOn(p).count(), inner: await inner.count() };
      await p.evaluate(() => history.back());
      await p.waitForTimeout(500);
      const two = { inner: await inner.count(), guide: await p.getByRole('heading', { name: '휴대폰 알림 받기' }).count() };
      check('2.3.2 창 차례: 안내 위 보안 알림 → 안내 → 그 창 차례로 닫힘', one.notice === 0 && one.inner === 1 && two.inner === 0 && two.guide === 1, JSON.stringify({ one, two }));
      await p.close();
    }
    const fire = (p, type, x) => p.evaluate(({ type, x }) => {
      const t = new Touch({ identifier: 7, target: document.body, clientX: x, clientY: 300 });
      document.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
    }, { type, x });
    const hold = async (p) => { await fire(p, 'touchstart', 5); for (const x of [40, 80, 120]) await fire(p, 'touchmove', x); await p.locator('.swipe-under').waitFor({ timeout: 3000 }); };
    const swap = async ({ p, st, wake }) => {
      st.assigned = false;
      await wake();
      await p.getByTestId('choose-trainer').waitFor({ timeout: 5000 });
      await p.waitForTimeout(300);
      st.assigned = true;
      await wake();
      await p.locator('.bottom-nav').waitFor({ timeout: 5000 });
      await p.waitForTimeout(300);
      return p.evaluate(() => ({ under: document.querySelectorAll('.swipe-under').length, moving: document.querySelectorAll('.edge-moving').length, main: document.querySelector('.app-main').style.transform }));
    };
    {
      const o = await open();
      await o.p.getByTestId('feedback-entry').click();
      await o.p.getByRole('heading', { name: '받은 피드백' }).waitFor({ timeout: 5000 });
      await hold(o.p);
      const left = await swap(o);
      check('2.3.2 밀기 정리: 반쯤 민 채로 틀이 사라졌다 돌아와도 깔개·밀린 화면이 남지 않음(손 떼는 신호 없음)', left.under === 0 && left.moving === 0 && left.main === '', JSON.stringify(left));
      await o.p.close();
    }
    {
      const o = await open();
      await o.p.getByTestId('feedback-entry').click();
      await o.p.getByRole('heading', { name: '받은 피드백' }).waitFor({ timeout: 5000 });
      await hold(o.p);
      await fire(o.p, 'touchend', 120);
      const left = await swap(o);
      check('2.3.2 밀기 정리: 손을 뗀 직후 틀이 사라져도 늦은 완료가 남지 않음', left.under === 0 && left.moving === 0 && left.main === '', JSON.stringify(left));
      await o.p.close();
    }
  });

  // 36-4) 2.3 뒤로 가기: 시스템 뒤로 · ✕로 닫아도 기록이 쌓이지 않음 · 쓰던 내용 보호 · 홈 화면 앱의 왼쪽 끝 밀기
  await soft('2.3 뒤로 가기', async () => {
    const onList = (p) => p.locator('.member-list-head').waitFor({ timeout: 5000 });
    const depth = (p) => p.evaluate(() => history.state?.backDepth ?? 0);
    {
      const { p } = await trainerPage(2);
      await p.locator('.member-row', { hasText: '검증 회원 1' }).click();
      await p.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
      await p.getByTestId('help-button').click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      await p.goBack().catch(() => {});
      await p.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      const sheetClosed = !(await p.locator('dialog[open]').count()) && (await p.getByRole('group', { name: '회원 화면' }).count()) === 1;
      await p.goBack().catch(() => {});
      await onList(p);
      await p.goBack().catch(() => {});
      await p.getByRole('button', { name: '확인', exact: true }).first().waitFor({ timeout: 5000 });
      await p.waitForTimeout(300);
      const onHome = await p.locator('.bottom-nav .nav-item.active').innerText();
      check('2.3 시스템 뒤로: 창 → 회원 화면 → 회원 목록 → 첫 탭 차례로', sheetClosed && onHome.startsWith('확인') && (await depth(p)) === 0, JSON.stringify({ sheetClosed, onHome }));
      await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
      await p.locator('.member-row', { hasText: '검증 회원 1' }).click();
      await p.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
      await p.getByTestId('help-button').click();
      await p.getByRole('button', { name: '창 닫기' }).click();
      await p.getByRole('button', { name: /담당 회원으로/ }).click();
      await onList(p);
      await p.waitForTimeout(300);
      check('2.3 ✕·위 화살표로 닫으면 기록에 칸이 남지 않음(뒤로를 두 번 누를 일 없음)', (await depth(p)) === 1, String(await depth(p)));
      await p.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
      await p.getByRole('button', { name: /의견 보내기/ }).first().click();
      const box = p.getByRole('dialog').getByRole('textbox').first();
      await box.fill('쓰던 내용');
      let answer = false, asked = 0;
      p.on('dialog', (d) => { asked++; void (answer ? d.accept() : d.dismiss()); });
      await p.evaluate(() => history.back());
      await p.waitForTimeout(500);
      const kept = (await p.locator('dialog[open]').count()) === 1 && (await box.inputValue()) === '쓰던 내용';
      answer = true;
      await p.evaluate(() => history.back());
      await p.waitForTimeout(500);
      check('2.3 쓰던 내용: 뒤로 가면 물어보고, 취소하면 그대로 · 확인하면 닫힘', kept && asked === 2 && (await p.locator('dialog[open]').count()) === 0, JSON.stringify({ kept, asked }));
      await p.close();
    }
    {
      const { p } = await trainerPage(2, () => Object.defineProperty(navigator, 'standalone', { value: true }));
      const swipe = (from, to, { y = 0, ms = 400, hold = false } = {}) => p.evaluate(async ({ from, to, y, ms, hold }) => {
        const fire = (type, x, yy) => {
          const t = new Touch({ identifier: 7, target: document.body, clientX: x, clientY: 300 + yy });
          document.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
        };
        fire('touchstart', from, 0);
        for (let i = 1; i <= 8; i++) { fire('touchmove', from + ((to - from) * i) / 8, (y * i) / 8); await new Promise((r) => setTimeout(r, ms / 8)); }
        if (!hold) fire('touchend', to, y);
      }, { from, to, y, ms, hold });
      await p.locator('.member-row', { hasText: '검증 회원 1' }).click();
      const screen = p.getByRole('group', { name: '회원 화면' });
      await screen.waitFor({ timeout: 5000 });
      await p.waitForTimeout(100);
      check('2.3.3 아이폰 회원 화면에는 기록 칸이 없음(앱의 밀기로만 돌아감)', (await depth(p)) === 0, String(await depth(p)));
      await swipe(5, 120);
      await p.waitForTimeout(350);
      const short = await screen.count();
      await swipe(120, 390);
      await p.waitForTimeout(350);
      await swipe(5, 30, { y: 200 });
      await p.waitForTimeout(350);
      const stay = await screen.count();
      await swipe(5, 300, { hold: true });
      await p.locator('.swipe-under .member-list-head').waitFor({ timeout: 3000 });
      const moved = await p.locator('.app-main:not(.swipe-under *)').evaluate((el) => el.style.transform);
      await p.evaluate(() => { const t = new Touch({ identifier: 7, target: document.body, clientX: 300, clientY: 300 }); document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t] })); });
      await onList(p);
      await p.waitForTimeout(300);
      const clean = await p.locator('.app-main').first().evaluate((el) => el.style.transform);
      check('2.3 왼쪽 끝 밀기: 덜 밀면 제자리 · 끝이 아닌 곳·세로 밀기는 무시 · 밀 때 화면이 따라오고 아래에 회원 목록 · 절반 넘기면 돌아감', short === 1 && stay === 1 && moved.includes('translateX') && clean === '' && (await p.locator('.swipe-under').count()) === 0, JSON.stringify({ short, stay, moved, clean }));
      await p.locator('.member-row', { hasText: '검증 회원 2' }).click();
      await screen.waitFor({ timeout: 5000 });
      await p.getByTestId('help-button').click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      await swipe(5, 200, { ms: 120 });
      await p.waitForTimeout(500);
      check('2.3 왼쪽 끝 밀기: 빠르게 밀면 절반이 안 돼도 돌아감 · 창이 열려 있으면 창부터 닫음', (await p.locator('dialog[open]').count()) === 0 && (await screen.count()) === 1);
      await p.waitForTimeout(400);
      await p.getByTestId('help-button').click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      await p.waitForTimeout(100);
      const sheetOnScreen = await depth(p);
      await p.evaluate(() => history.back());
      await p.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(400);
      check('2.3.3 아이폰 회원 화면 위의 창은 칸 한 개 · 시스템 밀기로 창만 닫고 회원 화면은 그대로', sheetOnScreen === 1 && (await p.locator('dialog[open]').count()) === 0 && (await screen.count()) === 1 && (await depth(p)) === 0, JSON.stringify({ sheetOnScreen }));
      // 밀던 중 다른 손가락이 닿고 다 떼면: 화면이 밀린 채 남지 않음
      await swipe(5, 120, { hold: true });
      await p.evaluate(() => {
        const a = new Touch({ identifier: 7, target: document.body, clientX: 120, clientY: 300 }), b = new Touch({ identifier: 8, target: document.body, clientX: 200, clientY: 400 });
        document.body.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [a, b], changedTouches: [b] }));
        document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [a, b] }));
      });
      await p.waitForTimeout(350);
      const stuck = await p.evaluate(() => ({ t: document.querySelector('.app-main').style.transform, c: document.querySelectorAll('.edge-moving').length, u: document.querySelectorAll('.swipe-under').length }));
      check('2.3 왼쪽 끝 밀기: 밀던 중 다른 손가락이 닿으면 취소되고 화면이 밀린 채 남지 않음', stuck.t === '' && stuck.c === 0 && stuck.u === 0 && (await screen.count()) === 1, JSON.stringify(stuck));
      await p.close();
    }
    {
      const { p } = await trainerPage(1);
      await p.locator('.member-row').first().click();
      await p.getByRole('group', { name: '회원 화면' }).waitFor({ timeout: 5000 });
      await p.evaluate(() => { const t = new Touch({ identifier: 1, target: document.body, clientX: 5, clientY: 300 }); document.body.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t], changedTouches: [t] })); const m = new Touch({ identifier: 1, target: document.body, clientX: 300, clientY: 300 }); document.body.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [m], changedTouches: [m] })); document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [m] })); });
      await p.waitForTimeout(400);
      check('2.3 브라우저 안에서는 앱의 밀기를 쓰지 않음(브라우저 몸짓과 겹치지 않게)', (await p.getByRole('group', { name: '회원 화면' }).count()) === 1);
      // 창을 닫고 바로 새 창을 열어 약 1초 뒤에 닫아도 회원 화면까지 닫히지 않음(앞선 이동의 안전 시간이 뒤 이동을 건드리지 않음)
      const closeHelp = async () => { await p.getByTestId('help-button').click(); await p.getByRole('button', { name: '창 닫기' }).click(); };
      await closeHelp();
      await p.waitForTimeout(600);
      await closeHelp();
      await p.waitForTimeout(1500);
      check('2.3 창을 연달아 열고 닫아도 층이 더 닫히지 않음', (await p.getByRole('group', { name: '회원 화면' }).count()) === 1 && (await depth(p)) === 2, String(await depth(p)));
      // 느린 기기: 코드가 시킨 기록 이동이 늦게 도착해도 사용자의 뒤로로 보지 않아 방금 연 창이 닫히지 않음
      await p.evaluate(() => { const go = history.go.bind(history); window.__go = go; history.go = (n) => { setTimeout(() => go(n), 1500); }; });
      await closeHelp();
      await p.getByTestId('help-button').click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      await p.waitForTimeout(2500);
      const slowOpen = await p.locator('dialog[open]').count(), slowDepth = await depth(p);
      await p.evaluate(() => { history.go = window.__go; });
      await p.getByRole('button', { name: '창 닫기' }).click();
      await p.waitForTimeout(400);
      check('2.3 느린 기기: 기록 이동이 늦어도 방금 연 창이 닫히지 않고 칸 수가 맞음', slowOpen === 1 && slowDepth === 3 && (await depth(p)) === 2, JSON.stringify({ slowOpen, slowDepth }));
      // Esc(안드로이드 뒤로와 같은 경로): 창 안의 안내만 닫고 창은 남김
      await p.getByTestId('help-button').click();
      const guide = p.getByTestId('start-guide');
      for (let i = 0; i < 6 && !(await guide.getByRole('button', { name: '그림으로 연결 방법 보기' }).count()); i++) await guide.getByRole('button', { name: '다음' }).click();
      await guide.getByRole('button', { name: '그림으로 연결 방법 보기' }).click();
      await p.getByTestId('sheet-guide').waitFor({ timeout: 5000 });
      await p.keyboard.press('Escape');
      await p.getByTestId('sheet-guide').waitFor({ state: 'detached', timeout: 5000 });
      await p.waitForTimeout(300);
      check('2.3 Esc·안드로이드 뒤로: 창 안의 그림 안내만 닫고 창은 남음', (await p.locator('dialog[open]').count()) === 1 && (await guide.count()) === 1 && (await depth(p)) === 3, String(await depth(p)));
      await p.getByRole('button', { name: '창 닫기' }).click();
      // 쓰던 내용: Esc를 거듭 눌러 브라우저가 닫기를 막지 못하게 해도 취소하면 내용이 남음
      await p.getByRole('button', { name: /담당 회원으로/ }).click();
      await p.locator('.bottom-nav').getByRole('button', { name: '설정', exact: true }).click();
      await p.getByRole('button', { name: /의견 보내기/ }).first().click();
      const box = p.getByRole('dialog').getByRole('textbox').first();
      await box.fill('쓰던 내용');
      p.on('dialog', (d) => void d.dismiss());
      for (let i = 0; i < 4; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(200); }
      check('2.3 쓰던 내용: Esc를 거듭 눌러도 취소하면 창과 내용이 남음', (await p.locator('dialog[open]').count()) === 1 && (await box.inputValue()) === '쓰던 내용');
      await p.close();
    }
  });

  // 36-5) 2.3 새 기능 소개: 업데이트 뒤 처음 열 때 한 번 · 처음 쓰는 기기는 시작 안내만 · 눌러서 그 기능으로
  await soft('2.3 새 기능 소개', async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('mealnote:start-guide', '2.0'); localStorage.setItem('mealnote:setup-nudge', '9999-12-31'); } });
    const p = await c.newPage();
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    const news = p.getByTestId('whats-new');
    await news.waitFor({ timeout: 10000 });
    const text = (await news.innerText()).replace(/\s+/g, ' ');
    check('2.3 새 기능 소개(회원): 제목 · 기능마다 바로 가기 · 다시 보는 곳', (await p.locator('dialog[open] .sheet-top h2').innerText()) === '새 기능 안내 · 2.3' && text.includes('이달의 중량왕') && text.includes('공복 체중 기록') && text.includes('변화 보고서') && text.includes('설정 → 업데이트 소식'), text);
    await news.getByRole('button', { name: /인바디에서 적기/ }).click();
    await p.getByRole('group', { name: '운동 화면' }).waitFor({ timeout: 5000 });
    const mode = await p.getByRole('group', { name: '운동 화면' }).locator('button[aria-pressed="true"]').innerText();
    check('2.3 새 기능 소개: 누르면 창이 닫히고 그 기능으로', mode === '인바디' && (await p.locator('dialog[open]').count()) === 0, mode);
    await p.reload();
    await p.locator('.bottom-nav').waitFor({ timeout: 10000 });
    await p.waitForTimeout(500);
    check('2.3 새 기능 소개: 한 번 본 뒤에는 뜨지 않음', (await p.locator('dialog[open]').count()) === 0);
    await c.close();
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c2.addInitScript(() => localStorage.setItem('mealnote:setup-nudge', '9999-12-31'));
    const q = await c2.newPage();
    await q.route('**/rest/v1/**', (r) => fulfill(r, []));
    await q.goto(`${BASE}?mode=trainer`);
    await q.getByTestId('start-guide').waitFor({ timeout: 10000 });
    await q.getByRole('button', { name: '창 닫기' }).click();
    await q.reload();
    await q.locator('.bottom-nav').waitFor({ timeout: 10000 });
    await q.waitForTimeout(500);
    check('2.3 처음 쓰는 기기는 시작 안내만(소개가 이어서 뜨지 않음)', (await q.locator('dialog[open]').count()) === 0);
    await c2.close();
  });

  // 37) 2.3 트레이너 화면의 회원 운동: 카드의 운동 줄(오늘·최근·없음·최고 표시) · 확인 탭의 새 운동 기록(열기·모두 봤어요)
  await soft('2.3 트레이너 운동 줄·새 운동 기록', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const m1 = '11111111-1111-4111-8111-0000000000d1', m2 = '11111111-1111-4111-8111-0000000000d2', m3 = '11111111-1111-4111-8111-0000000000d3';
    const members = [{ id: m1, nickname: '가 회원' }, { id: m2, nickname: '나 회원' }, { id: m3, nickname: '다 회원' }];
    const set = (name, kg, reps) => ({ item_id: null, name, set_no: 1, kg, reps, done: true, ord: 1 });
    const ses = (id, member, day, at, sets, cardio = []) => ({ id, member_id: member, routine_id: null, day_no: sets.length ? 2 : null, day, started_at: at, updated_at: at, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets, cardio });
    const today = ses('w1', m1, '2026-11-03', '2026-11-02T22:40:00Z', [set('랫풀다운', '50', '10')]);
    const older = ses('w2', m2, '2026-11-01', '2026-10-20T10:00:00Z', [set('스쿼트', '70', '5')]);
    const run = ses('w3', m2, '2026-11-02', '2026-11-02T10:05:00Z', [], [{ kind: 'run', minutes: 30, km: 5, speed: null, ord: 1 }]);
    let failCompare = false, listBody = null;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, members.map((m) => ({ member_id: m.id, member: { nickname: m.nickname } })));
      if (path.endsWith('/profiles')) return fulfill(r, members.map((m) => ({ id: m.id, share_consent: true })));
      if (path.endsWith('/rpc/members_workouts')) listBody = r.request().postDataJSON();
      if (path.endsWith('/rpc/members_workouts') || path.endsWith('/workout_sessions')) return fulfill(r, [today, run, older]);
      if (path.endsWith('/rpc/workout_compare')) return failCompare ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, r.request().postDataJSON().p_member === m1 ? { w1: { 랫풀다운: { prior: [45], prev: '45' } } } : {});
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=trainer`);
    const box = p.getByTestId('new-workouts');
    await box.waitFor({ timeout: 15000 });
    const rows = box.locator('.new-workout');
    const first = (await rows.nth(0).innerText()).replace(/\s+/g, ' ');
    await rows.nth(0).locator('.record-pr').waitFor({ timeout: 5000 });
    check('2.3 확인 탭: 새 운동 기록 수 · 최근 것부터 · 문장·시각 · 최고 표시 · 사흘 넘은 기록은 처음에 안 뜸', (await rows.count()) === 2 && first.includes('가 회원 회원') && first.includes('루틴 2') && first.includes('랫풀다운 50kg × 10') && first.includes('오늘 07:40') && (await rows.nth(1).innerText()).includes('유산소 · 러닝 30분 · 5km'), first);
    check('2.3 담당 회원의 최근 2주만 한 번에 받음', listBody?.p_from === '2026-10-20' && listBody?.p_members?.includes(m1) && listBody?.p_members?.includes(m3), JSON.stringify(listBody));
    await rows.nth(0).click();
    await p.getByRole('dialog').getByText('랫풀다운').first().waitFor({ timeout: 5000 });
    check('2.3 확인 탭에서 연 운동 기록: 제목에 그 회원 이름', (await p.locator('dialog[open] .sheet-top h2').innerText()) === '가 회원 회원의 운동 기록', await p.locator('dialog[open] .sheet-top h2').innerText());
    await p.keyboard.press('Escape');
    await p.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(async () => { await p.getByRole('button', { name: '닫기' }).first().click(); });
    await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
    const cards = p.getByTestId('member-day');
    await cards.first().waitFor({ timeout: 10000 });
    const line = (name) => cards.filter({ hasText: name }).locator('.member-day-workout').innerText().then((t) => t.replace(/\s+/g, ' '));
    const l1 = await line('가 회원'), l2 = await line('나 회원'), l3 = await line('다 회원');
    check('2.3 회원 카드 운동 줄: 오늘 · 최근 운동한 날 · 2주 안 기록 없음', l1.startsWith('오늘 루틴 2') && l1.includes('완료 1/1세트') && l1.includes('최고 1') && l2.includes('(어제)') && l2.includes('유산소') && l3 === '최근 2주 운동 기록 없음', JSON.stringify({ l1, l2, l3 }));
    await p.locator('.bottom-nav').getByRole('button', { name: '확인', exact: true }).click();
    await box.getByRole('button', { name: '모두 봤어요' }).click();
    await box.waitFor({ state: 'detached', timeout: 5000 });
    const mark = await p.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('mealnote:workouts-seen:'))?.[1]);
    const seenMarks = JSON.parse(mark ?? '{}').marks ?? {};
    check('2.3 모두 봤어요: 화면에 보인 기록만 그 판의 시각으로 적음', Object.keys(seenMarks).sort().join() === 'w1,w3' && seenMarks.w1 === new Date('2026-11-02T22:40:00Z').toISOString(), String(mark));
    await p.reload();
    await p.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).waitFor({ timeout: 15000 });
    await p.waitForTimeout(800);
    check('2.3 모두 봤어요: 사라지고 다시 열어도 그대로', (await box.count()) === 0);
    await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mealnote:workouts-seen:')).forEach((k) => localStorage.removeItem(k)));
    failCompare = true;
    await p.reload();
    await box.waitFor({ timeout: 15000 });
    await p.waitForTimeout(800);
    check('2.3 최고 비교를 받지 못해도 새 운동 기록은 그대로(최고 표시만 없음 · 못 받았다고 알림)', (await box.locator('.new-workout').count()) === 2 && (await box.locator('.record-pr').count()) === 0 && (await box.getByText('최고 기록 여부를 확인하지 못했어요').count()) === 1);
    await p.close();
  });

  // 37-1) v2.3.0 1차 리뷰 재현: 새 운동 기록 여섯 건 모두에 닿고 · 조회 실패를 알리고 다시 받는다
  await soft('2.3 1차 리뷰 새 운동 기록', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    const m = '11111111-1111-4111-8111-0000000000e1';
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, member_id: m, routine_id: null, day_no: 1, day: '2026-11-03', started_at: `2026-11-02T2${i}:00:00Z`.replace('2026-11-02T2', i < 4 ? '2026-11-02T2' : '2026-11-02T1'), updated_at: `2026-11-02T1${9 - i}:00:00Z`, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets: [{ item_id: null, name: `운동${i + 1}`, set_no: 1, kg: '50', reps: '5', done: true, ord: 1 }], cardio: [] }));
    const down = { on: false };
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, [{ member_id: m, member: { nickname: '가 회원' } }]);
      if (path.endsWith('/profiles')) return fulfill(r, [{ id: m, share_consent: true }]);
      if (path.endsWith('/rpc/members_workouts') || path.endsWith('/workout_sessions')) return down.on ? r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : fulfill(r, six);
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=trainer`);
    const box = p.getByTestId('new-workouts');
    await box.waitFor({ timeout: 15000 });
    const rows = box.locator('.new-workout');
    const more = box.getByRole('button', { name: /더 보기/ });
    check('1차 리뷰 3번: 다섯 건 뒤에 더 보기가 있고, 숨은 기록이 있으면 모두 봤어요를 누를 수 없음', (await rows.count()) === 5 && (await more.count()) === 1 && (await box.getByRole('button', { name: '모두 봤어요' }).count()) === 0, JSON.stringify([await rows.count(), await more.count()]));
    if (await more.count()) await more.click();
    check('1차 리뷰 3번: 더 보기로 여섯 건 모두 열 수 있고 그때 모두 봤어요가 나옴', (await rows.count()) === 6 && (await box.getByRole('button', { name: '모두 봤어요' }).count()) === 1);
    await p.close();

    const q = await ctx.newPage();
    await q.clock.install({ time: new Date('2026-11-03T10:00:00+09:00') });
    await q.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, [{ member_id: m, member: { nickname: '가 회원' } }]);
      if (path.endsWith('/profiles')) return fulfill(r, [{ id: m, share_consent: true }]);
      if (path.endsWith('/rpc/members_workouts') || path.endsWith('/workout_sessions')) return down.on ? r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : fulfill(r, six);
      return fulfill(r, []);
    });
    down.on = true;
    await q.goto(`${BASE}?mode=trainer`);
    const notice = q.getByText('운동 기록을 불러오지 못했어요');
    await notice.first().waitFor({ timeout: 10000 }).catch(() => {});
    check('1차 리뷰 4번: 운동 조회 실패를 확인 탭에서 알림', (await notice.count()) === 1);
    await q.locator('.bottom-nav').getByRole('button', { name: '회원', exact: true }).click();
    await q.getByTestId('member-day').first().waitFor({ timeout: 10000 });
    await q.waitForTimeout(400);
    check('1차 리뷰 4번: 회원 탭에서도 알림', (await notice.count()) === 1);
    down.on = false;
    if (await notice.count()) await q.getByRole('button', { name: '다시 불러오기' }).first().click();
    await q.getByTestId('member-day').first().locator('.member-day-workout').waitFor({ timeout: 5000 }).catch(() => {});
    check('1차 리뷰 4번: 다시 불러오면 운동 줄이 들어오고 안내가 사라짐', (await q.getByTestId('member-day').first().locator('.member-day-workout').count()) === 1 && (await notice.count()) === 0);
    await q.close();
  });

  // ─── 2.4(문서/기획/2_4_결정할것_261108.md) ───
  // 식단 등록 한 화면(결정 1-1·1-2·1-3): 칸 순서 · 필수 표시 · 사진 버튼 두 개 · 미리보기 160px(사진 비율과 관계없이) · 기준 크기 390×797에서 등록 버튼까지 한 화면
  await soft('2.4 식단 등록 칸 순서와 한 화면', async () => {
    const c = await newCtx({ ...devices['iPhone 13'], viewport: { width: 390, height: 797 } });
    const p = await c.newPage();
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.getByTestId('add-meal').click();
    const d = p.locator('dialog[open]');
    await d.locator('form.meal-form').waitFor({ timeout: 10000 });
    const tops = await p.evaluate(() => {
      const f = document.querySelector('dialog[open] form.meal-form');
      const y = (sel) => f.querySelector(sel).getBoundingClientRect().top;
      return [y('input[type=date]'), y('.meal-type-buttons'), y('input[placeholder^="예:"]'), y('.meal-photo-pick'), y('textarea')];
    });
    const ordered = tops.every((t, i) => i === 0 || t > tops[i - 1]);
    const foodLabel = await d.locator('label.field', { hasText: '무엇을 드셨나요?' }).innerText();
    const dateLabelExtra = await d.locator('label.field:has(input[type=date])').evaluate((l) => l.getBoundingClientRect().height - l.querySelector('input').getBoundingClientRect().height);
    check('식단 등록: 날짜·시각 → 식사 구분 → 무엇을 드셨나요(필수) → 사진 → 한마디 · 날짜·시각·식사 구분은 칸 이름 없이(읽어 주는 이름은 남음)',
      ordered && foodLabel.includes('필수') && dateLabelExtra < 4 && (await p.getByLabel('먹은 날짜').count()) === 1 && (await p.getByRole('group', { name: '식사 구분' }).count()) === 1, JSON.stringify({ tops, foodLabel, dateLabelExtra }));
    check('사진 버튼 두 개(사진 찍기·앨범에서 고르기) · 사진과 한마디는 선택',
      (await d.locator('.meal-photo-pick .photo-button').allInnerTexts()).map((x) => x.trim()).join() === '사진 찍기,앨범에서 고르기' && (await d.getByText('식사 사진 선택').count()) === 1);
    const fit = () => p.evaluate(() => { const dd = document.querySelector('dialog[open]'); return { hidden: dd.scrollHeight - dd.clientHeight, room: Math.floor(innerHeight * 0.93 - dd.scrollHeight) }; });
    const atOpen = await fit();
    const png = async (w, h) => Buffer.from(await p.evaluate(([w, h]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.fillStyle = '#c84'; g.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h]), 'base64');
    await p.getByLabel('식사 사진 선택').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: await png(800, 200) });
    await d.locator('.meal-photo-has img').waitFor({ timeout: 5000 });
    const wideH = await d.locator('.meal-photo-has').evaluate((e) => e.getBoundingClientRect().height);
    const afterPhoto = await fit();
    await p.getByLabel('식사 사진 찍기').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: await png(200, 800) });
    await p.waitForTimeout(600);
    const tallH = await d.locator('.meal-photo-has').evaluate((e) => e.getBoundingClientRect().height);
    check('사진을 고르면 그 자리가 160px 미리보기(가로·세로 사진 같은 높이) · 다시 찍기·다시 고르기',
      wideH === 160 && tallH === 160 && (await d.getByText('다시 찍기').count()) === 1 && (await d.getByText('다시 고르기').count()) === 1, JSON.stringify({ wideH, tallH }));
    check('기준 크기(390×797): 창을 열 때와 사진을 고른 뒤 모두 등록 버튼까지 한 화면(아이폰 아래 여백 34px만큼 남음)',
      atOpen.hidden === 0 && afterPhoto.hidden === 0 && afterPhoto.room >= 10, JSON.stringify({ atOpen, afterPhoto }));
    const note = d.getByLabel('트레이너에게 한마디');
    const h1 = await note.evaluate((e) => e.getBoundingClientRect().height);
    await note.fill('첫 줄\n둘째 줄\n셋째 줄');
    await p.waitForTimeout(100);
    const h2 = await note.evaluate((e) => e.getBoundingClientRect().height);
    check('한마디 칸은 한 줄로 시작하고 쓰면 늘어남', h1 <= 46 && h2 > h1 + 20, JSON.stringify({ h1, h2 }));
    await d.getByRole('button', { name: '사진 빼기' }).click();
    check('사진을 빼면 버튼 두 개로 돌아감', (await d.locator('.meal-photo-pick .photo-button').count()) === 2);
    await c.close();
  });

  // 4-1: 사진이 있는 식사인데 받지 못하면 '사진 없이 기록한 식사'가 아니라 실패 안내와 다시 불러오기
  await soft('2.4 사진을 받지 못한 식사 상세', async () => {
    const p = await ctx.newPage();
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const meal = { id: '55555555-5555-4555-8555-555555555566', member_id: '11111111-1111-4111-8111-000000000001', eaten_on: today, eaten_at: '12:00', meal_type: '점심', food: '사진 실패 검증 식사', note: '', photo_path: '11111111-1111-4111-8111-000000000001/q.jpg', created_at: d0.toISOString(), reviewed_at: null, member_seen_at: d0.toISOString(), note_updated_at: d0.toISOString(), member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: '검증 회원 1' } };
    let down = true;
    await p.route('**/rest/v1/**', (r) => (new URL(r.request().url()).pathname.endsWith('/meals') ? fulfill(r, [meal]) : fulfill(r, [])));
    await p.route('**/functions/v1/meal-photo*', (r) => (down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }) : r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg })));
    await p.goto(`${BASE}?mode=trainer`);
    await p.locator('.meal-card', { hasText: '사진 실패 검증 식사' }).click();
    const failed = p.getByTestId('photo-failed');
    await failed.waitFor({ timeout: 10000 });
    const text = await failed.innerText();
    down = false;
    await failed.getByRole('button', { name: '다시 불러오기' }).click();
    await p.locator('dialog[open] img.detail-photo').waitFor({ timeout: 5000 });
    check("사진을 받지 못하면 '사진을 불러오지 못했어요'와 다시 불러오기 · 누르면 다시 받아 보임", text.includes('사진을 불러오지 못했어요') && !text.includes('사진 없이') && (await p.getByTestId('photo-failed').count()) === 0, text);
    await p.close();
  });

  // 서버에서 로그인이 끊긴 기기(자기 프로필이 안 보임)에는 설정 권유를 띄우지 않는다
  await soft('2.4 로그인이 끊긴 기기의 설정 권유', async () => {
    const c = await browser.newContext({ ...devices['iPhone 13'] });
    await c.addInitScript(() => { localStorage.setItem('mealnote:start-guide', '2.0'); localStorage.setItem('mealnote:whats-new', '2.3'); });
    const p = await c.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/profiles')) return fulfill(r, null);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.getByTestId('feedback-entry').waitFor({ timeout: 15000 });
    await p.waitForTimeout(1200);
    check('서버에서 로그인이 끊긴 기기: 시트 미연결로 보여도 설정 권유를 띄우지 않고 표시도 남기지 않음', (await p.getByTestId('setup-nudge').count()) === 0 && (await p.evaluate(() => localStorage.getItem('mealnote:setup-nudge'))) === null);
    await c.close();
  });

  // 운동 찾기 · 운동별 기록(결정 2-1 나): 목록 제목 줄 오른쪽 → 자주 한 운동 → 띄어쓰기 없이 찾기 → 운동별 기록 → 돌아오면 찾던 글자 그대로
  const exRoutes = (p, ctrl) => p.route('**/rest/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    const body = r.request().postDataJSON?.() ?? null;
    if (path.endsWith('/routines')) return fulfill(r, ctrl.routines ?? []);
    if (path.endsWith('/routine_sources')) return fulfill(r, null);
    if (path.endsWith('/assignments')) return fulfill(r, ctrl.trainerView ? [{ member_id: a, member: { nickname: '하늘' } }] : { trainer: { nickname: '검증 코치' } });
    if (path.endsWith('/profiles')) return fulfill(r, [{ id: a, share_consent: true }]);
    if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
    if (path.endsWith('/rpc/exercise_list')) { ctrl.lists = (ctrl.lists ?? 0) + 1; return fulfill(r, { strength: [{ key: '스쿼트', name: '스쿼트', count: 24, last: '2026-11-05' }, { key: '벤치프레스', name: '벤치 프레스', count: 12, last: '2026-11-03' }, { key: '인클라인벤치프레스', name: '인클라인 벤치 프레스', count: 3, last: '2026-10-20' }], cardio: [{ kind: 'run', count: 2, last: '2026-11-01' }] }); }
    if (path.endsWith('/rpc/exercise_history')) { ctrl.history = body; return fulfill(r, [{ id: 'w2', day: '2026-11-05', day_no: 1, source: 'app', sets: [{ name: '스쿼트', set_no: 1, kg: '60', reps: '10' }, { name: '스쿼트', set_no: 2, kg: '70', reps: '8' }] }, { id: 'w1', day: '2026-10-28', day_no: 1, source: 'sheet', sets: [{ name: '스쿼트', set_no: 1, kg: '65', reps: '8' }] }]); }
    if (path.endsWith('/rpc/last_exercise_sets')) { ctrl.last = body; return fulfill(r, { 스쿼트: { id: 'w2', day: '2026-11-05', sets: [{ set_no: 1, kg: '60', reps: '10' }, { set_no: 2, kg: '70', reps: '8' }] } }); }
    if (path.endsWith('/exercise_memos')) return fulfill(r, ctrl.memos ?? []);
    if (path.endsWith('/rpc/save_exercise_memo') && ctrl.memoHold) return ctrl.memoHold.then(() => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }));
    if (path.endsWith('/rpc/save_exercise_memo')) { ctrl.saved = body; ctrl.memos = [...(ctrl.memos ?? []).filter((m) => m.author !== (ctrl.trainerView ? 'trainer' : 'member')), { key: '스쿼트', author: ctrl.trainerView ? 'trainer' : 'member', name: body.p_name, body: body.p_body, updated_at: '2026-11-09T01:00:00Z' }]; return fulfill(r, '2026-11-09T01:00:00Z'); }
    return fulfill(r, []);
  });
  const exRoutine = { id: 'routine-24', member_id: a, version: 1, title: '11월 루틴', goal: '', reason: '', warmup: '', source: 'manual', source_ref: '', created_at: '2026-11-01T01:00:00Z',
    items: [{ id: 'i1', ord: 1, day_no: 1, name: '스쿼트', weight: '70', reps: '8', sets: 2, rest: '2', note: '' }, { id: 'i2', ord: 2, day_no: 1, name: '레그 프레스', weight: '100', reps: '12', sets: 1, rest: '1', note: '' }] };

  await soft('2.4 운동 찾기와 운동별 기록', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctrl = { routines: [exRoutine], memos: [{ key: '스쿼트', author: 'trainer', name: '스쿼트', body: '무릎이 안쪽으로 모이지 않게', updated_at: '2026-11-08T01:00:00Z' }] };
    await exRoutes(p, ctrl);
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await p.getByTestId('find-exercise').click();
    const find = p.getByTestId('exercise-find');
    await find.locator('.find-row').first().waitFor({ timeout: 10000 });
    const first = (await find.locator('.find-row strong').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
    await find.getByRole('searchbox').fill('벤치프레');
    const found = (await find.locator('.find-row strong').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
    const marked = await find.locator('.find-row mark').first().innerText();
    check('운동 찾기: 처음엔 자주 한 운동(유산소 포함) · 띄어쓰기 없이 쳐도 이름에 든 운동만 · 친 글자 강조',
      first.length === 4 && first[0] === '스쿼트' && JSON.stringify(found) === JSON.stringify(['벤치 프레스', '인클라인 벤치 프레스']) && marked === '벤치 프레', JSON.stringify({ first, found, marked }));
    await find.getByRole('searchbox').fill('스쿼');
    await find.locator('.find-row', { hasText: '스쿼트' }).click();
    const hist = p.getByTestId('exercise-history');
    await hist.locator('.history-row').first().waitFor({ timeout: 5000 });
    const tiles = (await hist.locator('.history-tiles').innerText()).replace(/\s+/g, ' ');
    const rowsText = (await hist.locator('.history-row').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
    check('운동별 기록: 가장 무거운 무게·기록 수·마지막 날 · 날짜별 세트 · 최고 · 시트 기록 · 트레이너 메모(회원은 읽기만, 내 메모 추가)',
      tiles.includes('최고 중량 70kg') && tiles.includes('기록 수 2건') && tiles.includes('최근 운동일 11월 5일') && rowsText[0].includes('60kg × 10 · 70kg × 8') && rowsText[0].includes('최고') && rowsText[1].includes('시트 기록')
        && (await hist.locator('.memo-slot.is-coach', { hasText: '무릎이 안쪽으로' }).count()) === 1 && (await hist.getByRole('button', { name: /내 메모 추가/ }).count()) === 1 && ctrl.history?.p_key === '스쿼트', JSON.stringify({ tiles, rowsText }));
    await hist.getByRole('button', { name: '← 운동 찾기로' }).click();
    check('운동 찾기로 돌아오면 찾던 글자 그대로', (await find.getByRole('searchbox').inputValue()) === '스쿼');
    await find.locator('.find-row', { hasText: '스쿼트' }).click();
    await p.goBack().catch(() => {});
    await p.waitForTimeout(300);
    check('뒤로 가기는 운동별 기록만 닫음(찾기 창은 남음)', (await p.getByTestId('exercise-history').count()) === 0 && (await p.getByTestId('exercise-find').count()) === 1);
    await p.close();
  });

  // 지난번(결정 2-2 다) · 세트 아래 메모(결정 3-1～3-3): 운동 이름 아래 '지난번 날짜 · 가장 무거운 세트' → 누르면 창 안에서 운동별 기록, 돌아와도 쓰던 입력 그대로
  await soft('2.4 운동 기록 창의 지난번과 메모', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctrl = { routines: [exRoutine], memos: [{ key: '스쿼트', author: 'trainer', name: '스쿼트', body: '무릎이 안쪽으로 모이지 않게', updated_at: '2026-11-08T01:00:00Z' }] };
    await exRoutes(p, ctrl);
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    const card = p.getByTestId('routine-day-1');
    await card.waitFor({ timeout: 15000 });
    check('루틴 카드에 트레이너 메모(운동 아래)', (await card.locator('.routine-memo.is-coach', { hasText: '무릎이 안쪽으로' }).count()) === 1);
    const groupHeight = async () => p.locator('.workout-group[aria-label="레그 프레스"] .workout-group-head').evaluate((e) => e.getBoundingClientRect().height);
    await p.getByTestId('start-workout').click();
    const form = p.getByTestId('workout-form');
    await form.waitFor();
    const lastBtn = form.getByRole('button', { name: /스쿼트 이전 기록 보기/ });
    await lastBtn.waitFor({ timeout: 5000 });
    const lastText = await lastBtn.innerText();
    check('지난번: 마지막 날과 가장 무거운 세트 · 한 적 없는 운동은 줄 없음 · 지금 적는 기록은 빼고 물음',
      lastText.includes('이전 기록 11월 5일 · 70kg × 8') && (await form.getByRole('button', { name: /레그 프레스 이전 기록 보기/ }).count()) === 0 && ctrl.last?.p_session && ctrl.last.p_names.includes('스쿼트'), JSON.stringify({ lastText, last: ctrl.last }));
    const headWith = await p.locator('.workout-group[aria-label="스쿼트"] .workout-group-head').evaluate((e) => e.getBoundingClientRect().height);
    const headWithout = await groupHeight();
    check('지난번 줄은 운동 이름 칸 높이를 늘리지 않음(기호·세트 추가 버튼 높이 안)', headWith <= headWithout + 1, JSON.stringify({ headWith, headWithout }));
    await form.getByLabel('스쿼트 1세트 중량').fill('72.5');
    await lastBtn.click();
    const hist = p.getByTestId('exercise-history');
    await hist.locator('.history-row').first().waitFor({ timeout: 5000 });
    const hidden = await form.isHidden();
    const dayButtons = await hist.locator('button.history-row').count();
    await hist.getByRole('button', { name: '← 운동 기록으로' }).click();
    check('지난번을 누르면 창 안에서 운동별 기록(날짜는 누르지 않음 — 쓰던 기록을 떠나지 않게) · 돌아오면 쓰던 입력 그대로',
      hidden && dayButtons === 0 && (await form.getByLabel('스쿼트 1세트 중량').inputValue()) === '72.5', JSON.stringify({ hidden, dayButtons }));
    const group = p.locator('.workout-group[aria-label="스쿼트"]');
    check('세트 아래 트레이너 메모 · 내 메모 추가', (await group.locator('.memo-slot.is-coach', { hasText: '무릎이 안쪽으로' }).count()) === 1 && (await group.getByRole('button', { name: /내 메모 추가/ }).count()) === 1);
    await group.getByRole('button', { name: /내 메모 추가/ }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('허리 말지 않기');
    await group.getByRole('button', { name: '저장', exact: true }).click();
    await group.locator('.memo-slot', { hasText: '허리 말지 않기' }).waitFor({ timeout: 5000 });
    check('내 메모 저장: 운동 이름·글·처음 쓰는 칸(base 없음)으로 보내고 바로 보임 · 운동 기록의 입력은 그대로',
      ctrl.saved?.p_name === '스쿼트' && ctrl.saved?.p_body === '허리 말지 않기' && ctrl.saved?.p_base === null && ctrl.saved?.p_member === a && (await form.getByLabel('스쿼트 1세트 중량').inputValue()) === '72.5', JSON.stringify(ctrl.saved));
    await p.close();
  });

  // 메모 저장의 경계: 저장 뒤 목록을 다시 받기 전에 또 고치면 방금 받은 수정 시각을 기준으로 보냄 · 다시 받기가 실패해도 저장한 글이 보임
  await soft('2.4 메모 저장 직후 다시 고치기·다시 받기 실패', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const sent = [];
    let memoLoads = 0, failLoads = false;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [exRoutine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/exercise_memos')) { memoLoads++; return failLoads ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, []); }
      if (path.endsWith('/rpc/save_exercise_memo')) { const b = r.request().postDataJSON(); sent.push(b); return fulfill(r, `2026-11-09T01:00:0${sent.length}.000000+00:00`); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByTestId('start-workout').click();
    const group = p.locator('.workout-group[aria-label="스쿼트"]');
    await group.getByRole('button', { name: /내 메모 추가/ }).waitFor({ timeout: 10000 });
    failLoads = true; // 저장 뒤 다시 받기가 실패한다
    await group.getByRole('button', { name: /내 메모 추가/ }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('첫 메모');
    await group.getByRole('button', { name: '저장', exact: true }).click();
    await group.locator('.memo-slot', { hasText: '첫 메모' }).waitFor({ timeout: 5000 });
    for (let i = 0; i < 20 && memoLoads < 2; i++) await p.waitForTimeout(100);
    await group.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('고친 메모');
    await group.getByRole('button', { name: '저장', exact: true }).click();
    await group.locator('.memo-slot', { hasText: '고친 메모' }).waitFor({ timeout: 5000 });
    check('저장 뒤 다시 받기가 실패해도 저장한 글이 보이고, 곧바로 고치면 방금 받은 수정 시각을 기준으로 보냄(옛 기준으로 거절되지 않음)',
      sent.length === 2 && sent[0].p_base === null && sent[1].p_base === '2026-11-09T01:00:01.000000+00:00' && memoLoads >= 2, JSON.stringify({ sent: sent.map((x) => x.p_base), memoLoads }));
    await p.close();
  });

  // 메모를 받지 못하면 '메모 없음'처럼 보이지 않게: 루틴 탭과 기록 창에 안내 · 다시 불러오면 메모가 들어옴
  await soft('2.4 메모 조회 실패 안내', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    let down = true;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [exRoutine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/exercise_memos')) return down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : fulfill(r, [{ key: '스쿼트', author: 'trainer', name: '스쿼트', body: '무릎 방향', updated_at: '2026-11-08T01:00:00Z' }]);
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    const notice = p.getByText('운동 메모를 불러오지 못했어요.');
    await notice.first().waitFor({ timeout: 10000 });
    const onTab = await notice.count();
    await p.getByTestId('start-workout').click();
    await p.getByTestId('workout-form').waitFor();
    // 기록 창은 열릴 때 메모를 새로 받는다 — 그 요청이 실패한 뒤에 안내가 뜬다(바로 세면 요청 전이라 0일 수 있다)
    await p.getByTestId('workout-form').getByText('운동 메모를 불러오지 못했어요.').waitFor({ timeout: 5000 }).catch(() => {});
    const inForm = await p.getByTestId('workout-form').getByText('운동 메모를 불러오지 못했어요.').count();
    down = false;
    await p.getByTestId('workout-form').getByRole('button', { name: '다시 불러오기' }).click();
    await p.locator('.workout-group[aria-label="스쿼트"] .memo-slot', { hasText: '무릎 방향' }).waitFor({ timeout: 5000 });
    check('메모를 받지 못하면 루틴 탭·기록 창에 안내(없음처럼 보이지 않음) · 다시 불러오면 메모가 들어옴', onTab === 1 && inForm === 1 && (await p.getByTestId('workout-form').getByText('운동 메모를 불러오지 못했어요.').count()) === 0, JSON.stringify({ onTab, inForm }));
    await p.close();
  });

  // 넘기기 전 적대 검토 B·C: 쓰는 도중 목록이 새로 와도 기준은 쓰기 시작할 때의 수정 시각 → 다른 기기의 글을 덮지 않고 conflict ·
  // 거절 뒤 새로 받은 최신 글을 칸 위에 보이고, 그 뒤 저장은 그 글의 수정 시각으로
  await soft('2.4 메모 충돌: 기준 고정과 최신 글 보이기', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const T1 = '2026-11-09T01:00:01.000000+00:00', T2 = '2026-11-09T01:00:02.000000+00:00', T3 = '2026-11-09T01:00:03.000000+00:00';
    let server = { body: 'A 기기 글', at: T1 };
    const sent = [];
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [exRoutine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/exercise_memos')) return fulfill(r, server ? [{ key: '스쿼트', author: 'member', name: '스쿼트', body: server.body, updated_at: server.at }] : []);
      if (path.endsWith('/rpc/save_exercise_memo')) {
        const b = r.request().postDataJSON();
        sent.push(b.p_base);
        if (b.p_base !== (server?.at ?? null)) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'conflict' }) });
        server = { body: b.p_body, at: T3 };
        return fulfill(r, T3);
      }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByTestId('start-workout').click();
    const group = p.locator('.workout-group[aria-label="스쿼트"]');
    await group.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('A 기기에서 고친 글');
    server = { body: 'B 기기에서 고친 글', at: T2 }; // 그사이 다른 기기가 고침
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 앱으로 돌아와 목록을 새로 받음
    await p.waitForTimeout(400);
    await group.getByRole('button', { name: '저장', exact: true }).click();
    const latest = group.getByTestId('memo-latest');
    await latest.waitFor({ timeout: 5000 });
    const latestText = await latest.innerText();
    const kept = await group.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    await group.getByRole('button', { name: '저장', exact: true }).click();
    await group.locator('.memo-slot', { hasText: 'A 기기에서 고친 글' }).waitFor({ timeout: 5000 });
    check('메모 충돌: 쓰는 도중 목록이 새로 와도 쓰기 시작할 때의 기준(T1)으로 보내 거절 · 최신 글(B)을 칸 위에 보이고 쓰던 글은 남김 · 다시 저장은 최신 글의 기준(T2)으로',
      sent[0] === T1 && latestText.includes('B 기기에서 고친 글') && kept === 'A 기기에서 고친 글' && sent[1] === T2, JSON.stringify({ sent, latestText, kept }));
    await p.close();
  });

  // 검토 A·F·E·D: 쓰던 메모는 층 닫기(뒤로 가기)·운동 기록 저장 전에 묻는다 · 지난번에서 돌아오면 보던 자리 · 찾던 글자는 쓰던 내용이 아님
  await soft('2.4 쓰던 메모 보호와 기록 창 위치', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctrl = { routines: [exRoutine], memos: [] };
    let saves = 0;
    await exRoutes(p, ctrl);
    await p.route('**/rest/v1/rpc/save_workout*', (r) => { saves++; return fulfill(r, '2026-11-09T01:00:00Z'); });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByTestId('start-workout').click();
    const form = p.getByTestId('workout-form');
    await form.waitFor();
    // F: 메모를 쓰다가 운동 기록 저장 → 묻고, 취소하면 저장하지 않음
    const group = p.locator('.workout-group[aria-label="스쿼트"]');
    await group.getByRole('button', { name: /내 메모 추가/ }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('저장 안 한 메모');
    let asked = '';
    p.once('dialog', (d) => { asked = d.message(); return d.dismiss(); });
    await form.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.waitForTimeout(300);
    check('쓰던 메모가 있으면 운동 기록 저장 전에 묻고, 취소하면 저장하지 않음', asked.includes('저장하지 않은 메모') && saves === 0 && (await group.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue()) === '저장 안 한 메모', JSON.stringify({ asked, saves }));
    await group.getByRole('button', { name: '취소', exact: true }).click();
    // E: 아래 운동의 지난번을 눌렀다 돌아오면 보던 자리
    const legGroup = p.locator('.workout-group[aria-label="레그 프레스"]');
    await p.evaluate(() => { const d = document.querySelector('dialog[open]'); d.scrollTop = d.scrollHeight; });
    await p.waitForTimeout(150);
    const before = await p.evaluate(() => document.querySelector('dialog[open]').scrollTop);
    await p.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).evaluate((b) => b.click());
    const hist = p.getByTestId('exercise-history');
    await hist.locator('.history-row').first().waitFor({ timeout: 5000 });
    const histTop = await p.evaluate(() => document.querySelector('dialog[open]').scrollTop);
    // A2: 운동별 기록에서 메모를 쓰다가 뒤로 가기 → 묻고, 취소하면 그대로
    await hist.getByRole('button', { name: /내 메모 추가/ }).click();
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('층에서 쓰던 메모');
    let askedBack = '';
    p.once('dialog', (d) => { askedBack = d.message(); return d.dismiss(); });
    await p.goBack().catch(() => {});
    await p.waitForTimeout(400);
    const stillOpen = (await p.getByTestId('exercise-history').count()) === 1 && (await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue()) === '층에서 쓰던 메모';
    p.once('dialog', (d) => d.accept());
    await hist.getByRole('button', { name: '← 운동 기록으로' }).click();
    await form.waitFor({ state: 'visible', timeout: 5000 });
    await p.waitForTimeout(150);
    const after = await p.evaluate(() => document.querySelector('dialog[open]').scrollTop);
    check('운동별 기록 층: 메모를 쓰다 뒤로 가기면 묻고 취소하면 그대로 · 열 때 맨 위 · 돌아오면 보던 자리',
      askedBack.includes('메모를 저장하지 않고') && stillOpen && histTop === 0 && before > 200 && Math.abs(after - before) <= 2 && (await legGroup.count()) === 1, JSON.stringify({ askedBack, stillOpen, histTop, before, after }));
    await p.getByRole('button', { name: '창 닫기' }).click();
    // D: 운동 찾기에서 친 글자는 쓰던 내용이 아니다 — 뒤로 가기로 묻지 않고 닫힘
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await p.getByTestId('find-exercise').click();
    await p.getByTestId('exercise-find').getByRole('searchbox').fill('스쿼');
    let askedFind = '';
    p.once('dialog', (d) => { askedFind = d.message(); return d.dismiss(); });
    await p.goBack().catch(() => {});
    await p.waitForTimeout(400);
    check('운동 찾기의 찾던 글자는 닫을 때 묻지 않음', askedFind === '' && (await p.getByTestId('exercise-find').count()) === 0, askedFind);
    await p.close();
  });

  // 검토 7·8: 트레이너 '메모 추가'로 연 기록의 돌아가기는 창을 닫음 · 로그인이 끊겨 비어 온 운동 목록은 '기록 없음'이 아니라 실패
  await soft('2.4 트레이너 메모 창 닫기·끊긴 로그인의 빈 목록', async () => {
    const { p } = await trainerPage(1);
    const ctrl = { trainerView: true, routines: [{ ...exRoutine, member_id: '11111111-1111-4111-8111-000000000001' }], memos: [] };
    await exRoutes(p, ctrl);
    await p.locator('.member-row').first().click();
    await p.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '루틴', exact: true }).click();
    await p.getByTestId('routine-day-1').getByRole('button', { name: '스쿼트 메모 추가' }).click();
    const hist = p.getByTestId('exercise-history');
    await hist.waitFor({ timeout: 5000 });
    const label = await hist.locator('.guide-back').innerText();
    await hist.locator('.guide-back').click();
    await p.waitForTimeout(300);
    check("트레이너 '메모 추가'로 연 기록: 돌아가기는 '루틴으로'이고 창을 닫음(열지 않은 찾기 목록으로 가지 않음)", label.includes('루틴으로') && (await p.locator('dialog[open]').count()) === 0, label);
    await p.close();

    const q = await ctx.newPage();
    await q.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/exercise_list')) return fulfill(r, { strength: [], cardio: [] });
      return fulfill(r, []); // 프로필도 비어 있음 = 서버에서 로그인이 끊김
    });
    await q.goto(`${BASE}?mode=member`);
    await q.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await q.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await q.getByTestId('find-exercise').click();
    await q.getByText('운동 목록을 불러오지 못했어요').waitFor({ timeout: 5000 });
    check("로그인이 끊겨 비어 온 운동 목록은 '기록 없음'이 아니라 불러오지 못함", (await q.getByText('아직 완료한 운동 기록이 없어요.').count()) === 0);
    await q.close();
  });

  // 검토 9: 서명 주소를 받지 못해도 상세처럼 수정 창에 지금 사진이 보이고 ✕로 뺄 수 있다
  await soft('2.4 식단 수정 창의 지금 사진', async () => {
    const c = await newCtx({ ...devices['iPhone 13'] });
    const p = await c.newPage();
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const meal = { id: '55555555-5555-4555-8555-555555555577', member_id: a, eaten_on: today, eaten_at: '12:00', meal_type: '점심', food: '수정 사진 검증', note: '', photo_path: `${a}/m.jpg`, created_at: d0.toISOString(), reviewed_at: null, member_seen_at: d0.toISOString(), note_updated_at: d0.toISOString(), member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [] };
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 1, best: 1, today_logged: true });
      if (path.endsWith('/meals')) return fulfill(r, new URL(r.request().url()).searchParams.has('id') ? meal : [meal]);
      return fulfill(r, []);
    });
    await p.route('**/storage/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }));
    await p.route('**/functions/v1/meal-photo*', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg }));
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.meal-card', { hasText: '수정 사진 검증' }).first().click();
    await p.locator('dialog[open] img.detail-photo').waitFor({ timeout: 10000 });
    await p.locator('dialog[open]').getByRole('button', { name: '수정', exact: true }).click();
    await p.locator('dialog[open] .meal-photo-has img').waitFor({ timeout: 5000 });
    const x = await p.locator('dialog[open]').getByRole('button', { name: '사진 빼기' }).count();
    check('서명 주소가 없어도 수정 창에 지금 사진이 보이고 ✕로 뺄 수 있음(상세와 같음)', x === 1);
    await c.close();
  });

  // 넘기기 전 적대 검토 2차: N2(충돌 칸은 보인 판 그대로) · N4(저장 중 떠나기는 묻지 않음 — 2차 리뷰부터 막지도 않음) · N6(충돌 화면의 저장도 쓰던 메모를 물음) · P(찾기 목록 위치)
  await soft('2.4 적대 검토 2차 경계(메모 충돌 판·저장 중·충돌 저장·목록 위치)', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const T = (n) => `2026-11-09T01:00:0${n}.000000+00:00`;
    let server = { body: '처음 글', at: T(1) };
    const sent = [];
    let hold = null, workoutSaves = 0;
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `운동${i + 1}`, name: `운동 ${i + 1}`, count: 40 - i, last: '2026-11-05' }));
    await p.route('**/rest/v1/**', async (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [exRoutine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/profiles')) return fulfill(r, [{ id: a }]);
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/exercise_list')) return fulfill(r, { strength: [{ key: '스쿼트', name: '스쿼트', count: 50, last: '2026-11-05' }, ...many], cardio: [] });
      if (path.endsWith('/rpc/exercise_history')) return fulfill(r, [{ id: 'w2', day: '2026-11-05', day_no: 1, source: 'app', sets: [{ name: '스쿼트', set_no: 1, kg: '60', reps: '10' }] }]);
      if (path.endsWith('/exercise_memos')) return fulfill(r, server ? [{ key: '스쿼트', author: 'member', name: '스쿼트', body: server.body, updated_at: server.at }] : []);
      if (path.endsWith('/rpc/save_exercise_memo')) {
        const b = r.request().postDataJSON();
        sent.push(b.p_base);
        if (hold) { const h = hold; hold = null; await h; }
        if (b.p_base !== (server?.at ?? null)) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'conflict' }) });
        server = { body: b.p_body, at: T(9) };
        return fulfill(r, T(9));
      }
      if (path.endsWith('/rpc/save_workout')) { workoutSaves++; return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'gone' }) }); }
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByTestId('start-workout').click();
    const form = p.getByTestId('workout-form');
    const group = p.locator('.workout-group[aria-label="스쿼트"]');
    // N2: 충돌 칸이 보인 뒤 다른 기기가 또 고쳐도 보이는 글은 그대로, 다음 저장은 보인 판(T2)으로 → 다시 거절되면 새 판(T3)
    await group.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('내 글');
    server = { body: '둘째 기기 글', at: T(2) };
    await group.getByRole('button', { name: '저장', exact: true }).click();
    const box = group.getByTestId('memo-latest');
    await box.filter({ hasText: '둘째 기기 글' }).waitFor({ timeout: 5000 });
    server = { body: '셋째 기기 글', at: T(3) };
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(400);
    const stillShown = await box.innerText();
    await group.getByRole('button', { name: '저장', exact: true }).click();
    await box.filter({ hasText: '셋째 기기 글' }).waitFor({ timeout: 5000 });
    check('메모 충돌 칸: 그 뒤 또 바뀌어도 보인 글이 몰래 바뀌지 않고, 다음 저장은 보인 판(T2)으로 → 거절되면 새 판(T3)을 보임',
      stillShown.includes('둘째 기기 글') && JSON.stringify(sent) === JSON.stringify([T(1), T(2)]), JSON.stringify({ sent, stillShown }));
    // N4: 저장 중에 운동 기록을 저장해도 '저장하지 않은 메모'를 묻지 않음
    let release;
    hold = new Promise((res) => (release = res));
    await group.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(200);
    let asked = '';
    const onDialog = (d) => { asked = d.message(); void d.dismiss(); };
    p.on('dialog', onDialog);
    await form.getByRole('button', { name: '운동 기록 저장' }).click();
    await p.waitForTimeout(300);
    const askedWhileSaving = asked;
    // 2차 리뷰 1절(사용자 결정 11-09): 메모 저장 중에도 운동 기록 저장은 그대로 진행한다(이 시험의 서버는 gone이라 창이 남는다)
    const proceeded = workoutSaves === 1 && (await p.locator('.toast', { hasText: '메모를 저장하는 중이에요' }).count()) === 0;
    release();
    await group.locator('.memo-slot', { hasText: '내 글' }).waitFor({ timeout: 5000 });
    // N6: 지워진 기록 화면의 '오늘 새 기록으로 저장'도 쓰던 메모를 물음
    await form.getByText('오늘 새 기록으로 저장').waitFor({ timeout: 5000 }).catch(() => {});
    const goneShown = await form.getByRole('button', { name: '오늘 새 기록으로 저장' }).count();
    await group.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await group.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('또 쓰는 메모');
    asked = '';
    const before = workoutSaves;
    if (goneShown) await form.getByRole('button', { name: '오늘 새 기록으로 저장' }).click();
    await p.waitForTimeout(300);
    p.off('dialog', onDialog);
    check('메모 저장 중에도 운동 기록 저장은 묻지 않고 진행 · 지워진 기록 화면의 새 기록 저장은 쓰던 메모를 묻고 취소하면 저장 안 함',
      askedWhileSaving === '' && proceeded && goneShown === 1 && asked.includes('저장하지 않은 메모') && workoutSaves === before, JSON.stringify({ askedWhileSaving, proceeded, goneShown, asked, workoutSaves, before }));
    await group.getByRole('button', { name: '취소', exact: true }).click();
    await p.getByRole('button', { name: '창 닫기' }).click();
    p.once('dialog', (d) => d.accept());
    await p.waitForTimeout(300);
    // P: 운동 찾기 목록을 내려 운동을 열었다 돌아오면 보던 위치
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await p.getByTestId('find-exercise').click();
    const find = p.getByTestId('exercise-find');
    await find.locator('.find-row').nth(30).waitFor({ timeout: 5000 });
    await find.locator('.find-row').nth(30).scrollIntoViewIfNeeded();
    const top0 = await p.evaluate(() => document.querySelector('dialog[open]').scrollTop);
    await find.locator('.find-row').nth(30).click();
    await p.getByTestId('exercise-history').locator('.history-row').first().waitFor({ timeout: 5000 });
    await p.getByTestId('exercise-history').getByRole('button', { name: '← 운동 찾기로' }).click();
    await find.waitFor();
    await p.waitForTimeout(150);
    const top1 = await p.evaluate(() => document.querySelector('dialog[open]').scrollTop);
    check('운동 찾기: 아래 운동을 열었다 돌아오면 목록의 보던 위치', top0 > 300 && Math.abs(top1 - top0) <= 2, JSON.stringify({ top0, top1 }));
    await p.close();
  });

  // 2차 N5: 수정 창을 연 뒤에 서명 주소가 와도 사진이 '불러오는 중'에 멈추지 않음
  await soft('2.4 수정 창을 연 뒤 온 서명 주소', async () => {
    const c = await newCtx({ ...devices['iPhone 13'] });
    const p = await c.newPage();
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const meal = { id: '55555555-5555-4555-8555-555555555588', member_id: a, eaten_on: today, eaten_at: '12:00', meal_type: '점심', food: '늦은 서명 검증', note: '', photo_path: `${a}/n.jpg`, created_at: d0.toISOString(), reviewed_at: null, member_seen_at: d0.toISOString(), note_updated_at: d0.toISOString(), member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [] };
    let signOk = false;
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 1, best: 1, today_logged: true });
      if (path.endsWith('/meals')) return fulfill(r, new URL(r.request().url()).searchParams.has('id') ? meal : [meal]);
      return fulfill(r, []);
    });
    await p.route('**/storage/v1/**', (r) => {
      if (r.request().method() === 'GET') return r.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg });
      if (!signOk) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
      return fulfill(r, [{ path: meal.photo_path, signedURL: `/object/sign/meal-photos/${meal.photo_path}?token=t`, error: null }]);
    });
    await p.route('**/functions/v1/meal-photo*', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg }));
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.meal-card', { hasText: '늦은 서명 검증' }).first().click();
    await p.locator('dialog[open] img.detail-photo').waitFor({ timeout: 10000 });
    await p.locator('dialog[open]').getByRole('button', { name: '수정', exact: true }).click();
    await p.locator('dialog[open] .meal-photo-has img').waitFor({ timeout: 5000 });
    signOk = true;
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 앱으로 돌아와 다시 서명
    await p.waitForTimeout(1200);
    const st = await p.evaluate(() => { const box = document.querySelector('dialog[open] .meal-photo-has'); const img = box?.querySelector('img'); return { img: !!img, src: img?.getAttribute('src')?.slice(0, 40) ?? '', loading: !!box?.textContent?.includes('불러오는 중') }; });
    check("수정 창을 연 뒤 서명 주소가 와도 사진이 보임('불러오는 중'에 멈추지 않음)", st.img && !st.loading, JSON.stringify(st));
    await c.close();
  });

  // ─── Codex v2.4.0 1차 리뷰 반영 ───
  const wsess = (id, day) => ({ id, member_id: a, routine_id: null, day_no: 1, day, started_at: `${day}T10:00:00+00:00`, updated_at: `${day}T11:00:00+00:00`, finished: true, source: 'app', sheet_tab: '', sheet_col: null,
    sets: [{ item_id: null, name: '스쿼트', set_no: 1, kg: '60', reps: '10', done: true, ord: 1 }], cardio: [] });
  const twoDays = { ...exRoutine, items: [...exRoutine.items, { id: 'i3', ord: 3, day_no: 2, name: '벤치 프레스', weight: '45', reps: '8', sets: 2, rest: '2', note: '' }] };
  const findRoutes = async (p, opts = {}) => {
    const ctl = { holds: {}, memoHold: null, memoFail: false, workoutSaves: 0, workoutConflict: false, deletes: 0 };
    await p.route('**/rest/v1/**', async (r) => {
      const u = new URL(r.request().url());
      const path = u.pathname;
      if (path.endsWith('/routines')) return fulfill(r, [opts.routine ?? exRoutine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/profiles')) return fulfill(r, [{ id: a }]);
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/exercise_list')) return fulfill(r, { strength: [{ key: '스쿼트', name: '스쿼트', count: 2, last: '2026-11-05' }, { key: '벤치프레스', name: '벤치 프레스', count: 1, last: '2026-11-03' }], cardio: [] });
      if (path.endsWith('/rpc/exercise_history')) return fulfill(r, [{ id: 'w2', day: '2026-11-05', day_no: 1, source: 'app', sets: [{ name: '스쿼트', set_no: 1, kg: '60', reps: '10' }] }, { id: 'w1', day: '2026-10-28', day_no: 1, source: 'app', sets: [{ name: '스쿼트', set_no: 1, kg: '55', reps: '10' }] }]);
      if (path.endsWith('/workout_sessions') && u.searchParams.get('id')) {
        const id = u.searchParams.get('id').replace('eq.', '');
        if (ctl.holds[id]) await ctl.holds[id];
        return fulfill(r, wsess(id, id === 'w2' ? '2026-11-05' : '2026-10-28'));
      }
      if (path.endsWith('/exercise_memos')) return fulfill(r, []);
      if (path.endsWith('/rpc/save_exercise_memo')) {
        if (ctl.memoHold) await ctl.memoHold;
        if (ctl.memoFail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
        return fulfill(r, '2026-11-09T01:00:00.000000+00:00');
      }
      if (path.endsWith('/rpc/save_workout')) { ctl.workoutSaves++; return ctl.workoutConflict ? r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'conflict' }) }) : fulfill(r, '2026-11-09T01:00:00Z'); }
      if (path.endsWith('/rpc/delete_workout')) { ctl.deletes++; return fulfill(r, null); }
      return fulfill(r, []);
    });
    return ctl;
  };
  const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };

  // P2-1: 날짜를 누른 뒤 늦게 온 응답은 그사이 다른 운동으로 갔거나 메모를 쓰기 시작했으면 버리고, 연속으로 고르면 마지막 날짜만 연다
  await soft('2.4 리뷰 1차 P2-1 늦은 날짜 응답', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctl = await findRoutes(p);
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await p.getByTestId('find-exercise').click();
    const find = p.getByTestId('exercise-find');
    const hist = p.getByTestId('exercise-history');
    // 다른 운동으로 이동 + 메모
    await find.locator('.find-row', { hasText: '스쿼트' }).click();
    const g1 = gate(); ctl.holds.w2 = g1.p;
    await hist.locator('button.history-row').first().click();
    await hist.getByRole('button', { name: '← 운동 찾기로' }).click();
    await find.locator('.find-row', { hasText: '벤치 프레스' }).click();
    await hist.getByRole('button', { name: /내 메모 추가/ }).click();
    await hist.getByRole('textbox', { name: '벤치 프레스 내 메모' }).fill('벤치 메모');
    g1.open();
    await p.waitForTimeout(500);
    const kept1 = (await hist.getByRole('heading', { name: '벤치 프레스' }).count()) === 1 && (await hist.getByRole('textbox', { name: '벤치 프레스 내 메모' }).inputValue()) === '벤치 메모' && (await p.getByTestId('workout-form').count()) === 0;
    // 같은 운동에서 메모를 쓰기 시작
    await hist.getByRole('button', { name: '취소', exact: true }).click();
    await hist.getByRole('button', { name: '← 운동 찾기로' }).click();
    await find.locator('.find-row', { hasText: '스쿼트' }).click();
    const g2 = gate(); ctl.holds.w2 = g2.p;
    await hist.locator('button.history-row').first().click();
    await hist.getByRole('button', { name: /내 메모 추가/ }).click();
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('스쿼트 메모');
    g2.open();
    await p.waitForTimeout(500);
    const kept2 = (await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue()) === '스쿼트 메모' && (await p.getByTestId('workout-form').count()) === 0;
    await hist.getByRole('button', { name: '취소', exact: true }).click();
    // 날짜 두 개를 연속으로: 먼저 고른 날의 응답이 먼저 와도 마지막에 고른 날만 열린다
    const g3 = gate(), g4 = gate(); ctl.holds.w2 = g3.p; ctl.holds.w1 = g4.p;
    await hist.locator('button.history-row').nth(0).click();
    await hist.locator('button.history-row').nth(1).click();
    g3.open();
    await p.waitForTimeout(400);
    const notYet = (await p.getByTestId('workout-form').count()) === 0;
    g4.open();
    await p.getByTestId('workout-form').waitFor({ timeout: 5000 });
    const opened = await p.getByTestId('workout-form').locator('.workout-form-head').innerText();
    check('날짜를 누른 뒤 다른 운동으로 가 메모를 쓰거나, 같은 운동에서 메모를 쓰기 시작하면 늦은 응답이 화면과 메모를 덮지 않음 · 연속으로 고르면 마지막 날짜만 열림',
      kept1 && kept2 && notYet && opened.includes('10월 28일'), JSON.stringify({ kept1, kept2, notYet, opened }));
    await p.close();
  });

  // P2-2: 루틴·유산소 바꾸기는 쓰던 메모를 묻고 · 2차 리뷰 1절(사용자 결정 11-09): 메모 저장 중에는 루틴 바꾸기·운동 기록 저장·층 이동을 막지 않고,
  // 칸이 닫힌 뒤 저장이 실패하면 알리고 그 운동의 메모 칸에서 저장하지 못한 글을 보여 준다(운동 기록 저장 성공과 별개)
  await soft('2.4 리뷰 1차 P2-2 · 2차 저장 중 이동', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctl = await findRoutes(p, { routine: twoDays });
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByTestId('start-workout').click();
    const form = p.getByTestId('workout-form');
    const squat = p.locator('.workout-group[aria-label="스쿼트"]');
    await squat.getByRole('button', { name: /내 메모 추가/ }).click();
    await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('루틴 메모');
    const asked = [];
    p.on('dialog', (d) => { asked.push(d.message()); void d.dismiss(); });
    await form.getByRole('button', { name: /루틴 2/ }).click();
    await form.getByRole('button', { name: '유산소만' }).click();
    await p.waitForTimeout(300);
    const kept = (await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue()) === '루틴 메모' && (await p.locator('.workout-group[aria-label="벤치 프레스"]').count()) === 0;
    const askedDirty = asked.splice(0);
    // 저장 중: 루틴을 바꾸고 운동 기록을 저장해도 묻지 않고 진행. 그 뒤 메모 저장이 실패하면 알림
    const hold = gate(); ctl.memoHold = hold.p; ctl.memoFail = true;
    await squat.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(200);
    await form.getByRole('button', { name: /루틴 2/ }).click();
    await p.locator('.workout-group[aria-label="벤치 프레스"]').waitFor({ timeout: 5000 });
    await form.getByRole('button', { name: '운동 기록 저장' }).click();
    await form.waitFor({ state: 'detached', timeout: 5000 });
    const savedWhileMemo = ctl.workoutSaves;
    hold.open();
    const failToast = p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' });
    await failToast.waitFor({ timeout: 5000 });
    ctl.memoHold = null; ctl.memoFail = false;
    p.removeAllListeners('dialog');
    // 다시 운동을 시작하면 스쿼트 메모 칸에 저장하지 못한 글이 바로 들어가 있다(3차 리뷰: 카드·버튼 없이)
    await p.getByTestId('start-workout').click();
    const back0 = p.locator('.workout-group[aria-label="스쿼트"]').getByRole('textbox', { name: '스쿼트 내 메모' });
    await back0.waitFor({ timeout: 5000 });
    const unsentText = await back0.inputValue();
    const noteText = await p.locator('.workout-group[aria-label="스쿼트"] .field-error').innerText().catch(() => '');
    check('루틴 2·유산소만으로 바꾸면 쓰던 메모를 묻고 취소하면 그대로 · 메모 저장 중에는 루틴 바꾸기·운동 기록 저장을 묻지 않고 진행 · 그 뒤 메모 저장이 실패하면 알리고 그 운동의 메모 칸에 저장하지 못한 글을 바로 되돌림',
      kept && askedDirty.length === 2 && askedDirty.every((m) => m.includes('저장하지 않은 메모')) && asked.length === 0 && savedWhileMemo === 1 && unsentText === '루틴 메모' && noteText.includes('저장하지 못한 메모예요'),
      JSON.stringify({ kept, askedDirty, asked, savedWhileMemo, unsentText, noteText }));
    await p.close();

    // 운동별 기록 층: 저장 중에도 ← 운동 찾기로 바로 떠나고, 실패하면 알림 · 다시 열면 저장하지 못한 글
    const q = await ctx.newPage();
    await q.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const c2 = await findRoutes(q);
    await q.goto(`${BASE}?mode=member`);
    await q.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await q.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    await q.getByTestId('find-exercise').click();
    await q.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
    const hist = q.getByTestId('exercise-history');
    await hist.getByRole('button', { name: /내 메모 추가/ }).click();
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('층 메모');
    const h2 = gate(); c2.memoHold = h2.p; c2.memoFail = true;
    let askedQ = '';
    q.on('dialog', (d) => { askedQ = d.message(); void d.dismiss(); });
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await q.waitForTimeout(200);
    await hist.getByRole('button', { name: '← 운동 찾기로' }).click();
    const left = (await q.getByTestId('exercise-find').count()) === 1 && (await q.getByTestId('exercise-history').count()) === 0;
    h2.open();
    await q.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    c2.memoHold = null; c2.memoFail = false;
    await q.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
    const back = await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue().catch(() => '');
    check('운동별 기록 층: 메모 저장 중에도 묻지 않고 바로 떠나고, 저장이 실패하면 알림 · 다시 열면 저장하지 못한 글이 편집 칸에', askedQ === '' && left && back === '층 메모', JSON.stringify({ askedQ, left, back }));
    await q.close();
  });

  // 적대 검토 3차 R1·R3·R2: 그쪽 기록 불러오기·기록 지우기도 쓰던 메모를 묻고 · 창 ✕ 뒤 메모 저장이 실패하면 글을 맡겨 두었다가 그 운동의 메모 칸에서 보여 줌
  await soft('2.4 리뷰 1차 뒤 적대 검토 3차(불러오기·지우기·✕ 뒤 실패)', async () => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctl = await findRoutes(p);
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    const openRecord = async () => {
      await p.getByTestId('find-exercise').click();
      await p.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
      await p.getByTestId('exercise-history').locator('button.history-row').first().click();
      await p.getByTestId('workout-form').waitFor({ timeout: 5000 });
    };
    await openRecord();
    const form = p.getByTestId('workout-form');
    const squat = p.locator('.workout-group[aria-label="스쿼트"]');
    // R1: 저장이 충돌해 '그쪽 기록 불러오기'가 나온 뒤 메모를 쓰고 누르면 묻는다
    await form.getByLabel('스쿼트 1세트 중량').fill('62.5');
    ctl.workoutConflict = true;
    await form.getByRole('button', { name: '운동 기록 저장' }).click();
    await form.getByRole('button', { name: '그쪽 기록 불러오기' }).waitFor({ timeout: 5000 });
    await squat.getByRole('button', { name: /내 메모 추가/ }).click();
    await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('충돌 중 메모');
    const asked = [];
    p.on('dialog', (d) => { asked.push(d.message()); void d.dismiss(); });
    await form.getByRole('button', { name: '그쪽 기록 불러오기' }).click();
    await p.waitForTimeout(300);
    const keptR1 = (await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue()) === '충돌 중 메모';
    // R3: 기록 지우기(두 번 누름)도 묻고, 취소하면 지우지 않음
    await form.getByRole('button', { name: '이 기록 지우기' }).click();
    await form.getByRole('button', { name: '한 번 더 누르면 이 기록을 지워요' }).click();
    await p.waitForTimeout(300);
    p.removeAllListeners('dialog');
    check("'그쪽 기록 불러오기'와 기록 지우기는 쓰던 메모를 묻고, 취소하면 글이 남고 지우지 않음",
      keptR1 && asked.length === 2 && asked[0].includes('그쪽 기록') && asked[1].includes('이 기록을 지울까요') && ctl.deletes === 0 && (await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue()) === '충돌 중 메모', JSON.stringify({ keptR1, asked, deletes: ctl.deletes }));
    // R2: 메모 저장 중에 창 ✕로 닫고 저장이 실패하면, 그 운동의 메모 칸을 다시 열 때 저장하지 못한 글을 편집 칸에 바로 되돌림(3차 리뷰: 카드·버튼 없이)
    const hold = gate(); ctl.memoHold = hold.p; ctl.memoFail = true;
    await squat.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(200);
    await p.getByRole('button', { name: '창 닫기' }).click();
    hold.open();
    await p.waitForTimeout(500);
    ctl.memoHold = null; ctl.memoFail = false; ctl.workoutConflict = false;
    await p.getByTestId('find-exercise').click();
    await p.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
    const hist = p.getByTestId('exercise-history');
    const box = hist.getByRole('textbox', { name: '스쿼트 내 메모' });
    await box.waitFor({ timeout: 5000 });
    const back = await box.inputValue();
    const note = await hist.getByText('저장하지 못한 메모예요').count();
    check('메모 저장 중 창 ✕로 닫은 뒤 저장이 실패하면, 그 운동의 메모 칸을 다시 열 때 편집 칸에 바로 되돌리고 알림', back === '충돌 중 메모' && note === 1, JSON.stringify({ back, note }));
    await p.close();
  });

  // 2차 리뷰 P2-1·P3-1: 저장하지 못한 메모는 보낼 때의 저장 기준과 함께 남고(다른 기기의 최신 글을 몰래 덮지 않음), 더 나중의 저장이 있으면 앞선 실패를 되살리지 않으며,
  // 실패가 오기 전에 다시 연 메모 칸에도 바로 나타난다(쓰던 다른 글은 바꾸지 않음). 서버는 DB처럼 저장 기준을 견준다
  const memoServer = async (p) => {
    const T = (n) => `2026-11-09T02:00:${String(n).padStart(2, '0')}.000000+00:00`;
    // 서버 저장 시각은 늘 앞으로 간다: 저장은 T(11)부터, 시험이 미리 넣는 '그 전' 메모는 T(1)～T(9)
    const ctl = { mem: null, n: 10, sent: [], plan: [], T, memosFail: false };
    await p.route('**/rest/v1/**', async (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/routines')) return fulfill(r, [exRoutine]);
      if (path.endsWith('/routine_sources')) return fulfill(r, null);
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/profiles')) return fulfill(r, [{ id: a }]);
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      if (path.endsWith('/rpc/exercise_list')) return fulfill(r, { strength: [{ key: '스쿼트', name: '스쿼트', count: 2, last: '2026-11-05' }], cardio: [] });
      if (path.endsWith('/rpc/exercise_history')) return fulfill(r, [{ id: 'w2', day: '2026-11-05', day_no: 1, source: 'app', sets: [{ name: '스쿼트', set_no: 1, kg: '60', reps: '10' }] }]);
      if (path.endsWith('/rpc/last_exercise_sets')) return fulfill(r, { 스쿼트: { id: 'w2', day: '2026-11-05', sets: [{ set_no: 1, kg: '60', reps: '10' }] } });
      if (path.endsWith('/exercise_memos')) {
        if (ctl.memosFail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
        return fulfill(r, ctl.mem ? [{ key: '스쿼트', author: 'member', name: '스쿼트', body: ctl.mem.body, updated_at: ctl.mem.at }] : []);
      }
      if (path.endsWith('/rpc/save_exercise_memo')) {
        const b = r.request().postDataJSON();
        const step = ctl.plan.shift() ?? {};
        ctl.sent.push({ body: b.p_body, base: b.p_base });
        if (step.hold) await step.hold;
        if (step.outcome === 'fail') return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' });
        if (b.p_base !== (ctl.mem?.at ?? null)) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'conflict' }) });
        ctl.mem = b.p_body ? { body: b.p_body, at: T(++ctl.n) } : null;
        if (step.after) { const at = ctl.mem?.at ?? null; await step.after; return fulfill(r, at); } // 서버에는 저장하고 응답만 늦게
        if (step.outcome === 'lost') return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"cut"}' });
        return fulfill(r, ctl.mem?.at ?? null);
      }
      return fulfill(r, []);
    });
    return ctl;
  };
  const memoPage = async (tab = 'record') => {
    const p = await ctx.newPage();
    await p.clock.install({ time: new Date('2026-11-09T10:00:00+09:00') });
    const ctl = await memoServer(p);
    await p.goto(`${BASE}?mode=member`);
    await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
    if (tab === 'record') await p.getByRole('group', { name: '운동 화면' }).getByRole('button', { name: '운동 기록', exact: true }).click();
    const open = async () => {
      await p.getByTestId('find-exercise').click();
      await p.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
      const h = p.getByTestId('exercise-history');
      await h.locator('.history-row').first().waitFor({ timeout: 5000 });
      return h;
    };
    const close = async () => {
      await p.getByRole('button', { name: '창 닫기' }).click();
      await p.getByTestId('exercise-history').waitFor({ state: 'detached', timeout: 5000 });
    };
    // 메모를 쓰고 저장을 누른 뒤 응답을 붙잡아 둔 채 창을 닫는다
    const writeHeldThenClose = async (h, text, outcome = 'fail') => {
      const fix = h.getByRole('button', { name: '스쿼트 내 메모 고치기' });
      if (await fix.count()) await fix.click();
      else await h.getByRole('button', { name: /내 메모 추가/ }).click();
      await h.getByRole('textbox', { name: '스쿼트 내 메모' }).fill(text);
      const g = gate();
      ctl.plan.push({ hold: g.p, outcome });
      await h.getByRole('button', { name: '저장', exact: true }).click();
      await p.waitForTimeout(150);
      await close();
      return g;
    };
    return { p, ctl, open, close, writeHeldThenClose };
  };

  await soft('2.4 리뷰 2차 P2-1 저장하지 못한 메모의 저장 기준', async () => {
    const { p, ctl, open, close, writeHeldThenClose } = await memoPage();
    ctl.mem = { body: '처음 읽은 메모', at: ctl.T(1) };
    let h = await open();
    const g = await writeHeldThenClose(h, '내가 고친 글');
    ctl.mem = { body: '다른 기기가 그 뒤 저장한 최신 글', at: ctl.T(2) };
    g.open();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    h = await open();
    await h.getByTestId('memo-latest').waitFor({ timeout: 5000 });
    const latest = await h.getByTestId('memo-latest').innerText().catch(() => '');
    const text = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    const note = await h.locator('.field-error').innerText().catch(() => '');
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await h.locator('.memo-slot', { hasText: '내가 고친 글' }).waitFor({ timeout: 5000 });
    check('다른 기기가 고친 뒤 다시 열면 저장하지 못한 글을 편집 칸에 되돌리며 최신 글과 충돌 안내를 함께 보임 · 첫 저장은 처음 읽은 판(T1), 최신 글을 본 뒤 다시 저장은 그 판(T2)',
      latest.includes('다른 기기가 그 뒤 저장한 최신 글') && text === '내가 고친 글' && note.includes('저장된 메모가 변경됐어요') && ctl.sent[0].base === ctl.T(1) && ctl.sent[1].base === ctl.T(2) && ctl.sent.length === 2,
      JSON.stringify({ latest, text, note, sent: ctl.sent }));
    // 다른 기기가 지운 경우: 지운 사실을 보이고 다시 저장하면 새로 씀
    await close();
    h = await open();
    const g2 = await writeHeldThenClose(h, '지워질 줄 모른 글');
    ctl.mem = null;
    g2.open();
    await p.waitForTimeout(400);
    h = await open();
    await h.getByTestId('memo-latest').waitFor({ timeout: 5000 });
    const gone = await h.getByTestId('memo-latest').innerText().catch(() => '');
    const sentBefore = ctl.sent.length;
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await h.locator('.memo-slot', { hasText: '지워질 줄 모른 글' }).waitFor({ timeout: 5000 });
    check("다른 기기가 메모를 지운 뒤 다시 열면 '현재 저장된 메모가 없어요'를 보이고, 다시 저장하면 새로 씀(지운 판 기준)",
      gone.includes('현재 저장된 메모가 없어요') && ctl.sent[sentBefore].base === null && ctl.mem?.body === '지워질 줄 모른 글', JSON.stringify({ gone, sent: ctl.sent.slice(sentBefore) }));
    await p.close();
  });

  await soft('2.4 리뷰 2차 P2-1 저장 순서(새 저장 뒤 옛 실패 · 실패 역전 · 응답만 끊김)', async () => {
    const { p, ctl, open, close, writeHeldThenClose } = await memoPage();
    // 새 편집기에서 새 글을 저장한 뒤 첫 요청이 실패해도 첫 글을 되살리지 않음
    let h = await open();
    const g1 = await writeHeldThenClose(h, '첫 요청의 글');
    h = await open();
    const savingNote = await h.locator('.memo-saving').innerText().catch(() => '');
    await h.getByRole('button', { name: /내 메모 추가/ }).click();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('새로 저장한 글');
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await h.locator('.memo-slot', { hasText: '새로 저장한 글' }).waitFor({ timeout: 5000 });
    g1.open();
    await p.waitForTimeout(500);
    const unsentNow = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).count();
    await close();
    h = await open();
    await p.waitForTimeout(300);
    const unsentAgain = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).count();
    const toasts = await p.locator('.toast', { hasText: '메모를 저장하지 못했어요' }).count();
    check("다시 연 칸에 '저장하는 중' 표시 · 새 편집기의 저장이 성공한 뒤 첫 요청이 실패해도 첫 글을 되살리지 않고 알리지도 않음",
      savingNote.includes('저장하는 중') && unsentNow === 0 && unsentAgain === 0 && toasts === 0 && ctl.mem?.body === '새로 저장한 글', JSON.stringify({ savingNote, unsentNow, unsentAgain, toasts, mem: ctl.mem }));
    // 두 실패의 응답 역전: 어느 순서로 와도 나중에 쓴 글
    await close();
    for (const order of [['second', 'first'], ['first', 'second']]) {
      h = await open();
      const ga = await writeHeldThenClose(h, '먼저 보낸 글');
      h = await open();
      const gb = await writeHeldThenClose(h, '나중에 보낸 글');
      for (const o of order) { (o === 'first' ? ga : gb).open(); await p.waitForTimeout(300); }
      h = await open();
      const box = h.getByRole('textbox', { name: '스쿼트 내 메모' });
      await box.waitFor({ timeout: 5000 });
      const shown = await box.inputValue();
      check(`두 실패가 ${order.join('→')} 순서로 와도 나중에 쓴 글만 되돌림`, shown === '나중에 보낸 글', shown);
      // 되돌린 글을 취소하면 그 실패도 버림 — 다시 열어도 되돌리지 않음
      await h.getByRole('button', { name: '취소', exact: true }).click();
      await box.waitFor({ state: 'detached', timeout: 5000 });
      await close();
      h = await open();
      await p.waitForTimeout(300);
      check(`(${order.join('→')}) 되돌린 글을 취소하면 다시 열어도 되돌리지 않음`, (await h.getByRole('textbox', { name: '스쿼트 내 메모' }).count()) === 0);
      await close();
    }
    await p.close();
    // 서버에는 저장됐는데 응답만 끊김: 알리지 않고(서버를 새로 받아 같은 글), 다시 열면 저장된 글만 · 지우기 실패는 '지우지 못했어요'(적대 검토 P3-C)
    const m = await memoPage();
    const seen = [];
    await m.p.exposeFunction('__toastSeen', (t) => seen.push(t));
    await m.p.evaluate(() => new MutationObserver(() => { const t = document.querySelector('.toast.visible'); if (t) window.__toastSeen(t.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }));
    h = await m.open();
    const gl = await m.writeHeldThenClose(h, '응답만 끊긴 글', 'lost');
    gl.open();
    await m.p.waitForTimeout(600);
    h = await m.open();
    await h.locator('.memo-slot', { hasText: '응답만 끊긴 글' }).waitFor({ timeout: 5000 });
    await m.p.waitForTimeout(200);
    const lostUnsent = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).count();
    const lostToasts = seen.filter((t) => t.includes('못했어요')).length;
    check('서버에 저장됐지만 응답만 끊기면 알리지 않고, 다시 열 때 저장된 글만 보이며 저장하지 못한 글로 남지 않음', lostUnsent === 0 && lostToasts === 0, JSON.stringify({ lostUnsent, seen }));
    // 지우기: 글을 비우고 저장 → 실패
    await h.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('');
    const gd = gate(); m.ctl.plan.push({ hold: gd.p, outcome: 'fail' });
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await m.p.waitForTimeout(150);
    await m.close();
    gd.open();
    await m.p.locator('.toast', { hasText: '스쿼트 메모를 지우지 못했어요' }).waitFor({ timeout: 5000 });
    h = await m.open();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).waitFor({ timeout: 5000 });
    const delText = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    const delHead = await h.locator('.field-error').innerText().catch(() => '');
    check("지우기가 칸이 닫힌 뒤 실패하면 '스쿼트 메모를 지우지 못했어요'를 알리고, 다시 열면 빈 편집 칸과 '메모를 지우지 못했어요'", delText === '' && delHead.includes('메모를 지우지 못했어요'), JSON.stringify({ delText, delHead, seen }));
    await m.p.close();
  });

  // 넘기기 전 적대 검토(2차 리뷰 반영분) P2-A: 운동 기록 창의 메모 저장 중 '이전 기록'을 열면 그 창의 메모 칸은 가려진다 — 그동안의 실패는
  // 닫힌 칸처럼 맡겨 보이는 층에 나타나고, 그대로 창을 닫아도 다시 열면 남아 있음. P3-B: 실패 전에 받은 낡은 목록이 같은 글이어도 실패를 지우지 않음
  await soft('2.4 리뷰 2차 반영 뒤 적대 검토(가려진 칸 · 낡은 목록)', async () => {
    const { p, ctl } = await memoPage('routine');
    await p.getByTestId('start-workout').click();
    const form = p.getByTestId('workout-form');
    const squat = form.locator('.workout-group[aria-label="스쿼트"]');
    await squat.getByRole('button', { name: /내 메모 추가/ }).click();
    await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('폼에서 쓴 메모');
    const g = gate(); ctl.plan.push({ hold: g.p, outcome: 'fail' });
    await squat.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(150);
    await p.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).evaluate((b) => b.click());
    const hist = p.getByTestId('exercise-history');
    await hist.locator('.history-row').first().waitFor({ timeout: 5000 });
    const savingShown = await hist.locator('.memo-saving').count();
    g.open();
    const layerBox = hist.getByRole('textbox', { name: '스쿼트 내 메모' });
    await layerBox.waitFor({ timeout: 5000 });
    const layerShows = await layerBox.inputValue();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    await p.getByRole('button', { name: '창 닫기' }).click();
    await form.waitFor({ state: 'detached', timeout: 5000 });
    await p.getByTestId('start-workout').click();
    const again = p.getByTestId('workout-form').locator('.workout-group[aria-label="스쿼트"]');
    await again.getByRole('textbox', { name: '스쿼트 내 메모' }).waitFor({ timeout: 5000 });
    const formShows = await again.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    check("운동 기록 창의 메모 저장 중 '이전 기록'을 연 동안 실패하면 보이는 층의 편집 칸에 바로 되돌리고 알림 · 창을 닫았다 다시 열어도 운동 기록 창 메모 칸에 되돌림",
      savingShown === 1 && layerShows === '폼에서 쓴 메모' && formShows === '폼에서 쓴 메모', JSON.stringify({ savingShown, layerShows, formShows }));
    await again.getByRole('button', { name: '취소', exact: true }).click();
    // P3-B: 운동 기록 창이 받은 목록은 '처음 메모'. 층에서 '바꾼 메모'를 저장(그 뒤 목록 받기 실패) → '처음 메모'로 되돌리는 저장이 층을 떠난 뒤 실패
    await p.getByRole('button', { name: '창 닫기' }).click();
    ctl.mem = { body: '처음 메모', at: ctl.T(5) };
    await p.getByTestId('start-workout').click();
    const form2 = p.getByTestId('workout-form');
    await form2.locator('.workout-group[aria-label="스쿼트"] .memo-slot', { hasText: '처음 메모' }).waitFor({ timeout: 5000 });
    await p.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).evaluate((b) => b.click());
    await hist.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('바꾼 메모');
    ctl.memosFail = true;
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await hist.locator('.memo-slot', { hasText: '바꾼 메모' }).waitFor({ timeout: 5000 });
    await hist.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('처음 메모');
    const g2 = gate(); ctl.plan.push({ hold: g2.p, outcome: 'fail' });
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(150);
    await hist.getByRole('button', { name: '← 운동 기록으로' }).click();
    await form2.waitFor({ state: 'visible', timeout: 5000 });
    g2.open();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(300);
    const staleKept = await form2.locator('.workout-group[aria-label="스쿼트"]').getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue().catch(() => '(없음)');
    check("실패 전에 받은 낡은 목록이 실패한 글과 같아도('처음 메모') 저장하지 못한 메모를 지우지 않고 되돌림", staleKept === '처음 메모' && ctl.mem.body === '바꾼 메모', JSON.stringify({ staleKept, mem: ctl.mem }));
    ctl.memosFail = false;
    await p.close();
  });

  await soft('2.4 리뷰 2차 P3-1 실패 전에 다시 연 메모 칸', async () => {
    const { p, ctl, open, writeHeldThenClose, close } = await memoPage();
    let h = await open();
    const g = await writeHeldThenClose(h, '먼저 연 칸의 글');
    h = await open();
    const saving = await h.locator('.memo-saving').count();
    g.open();
    const box = h.getByRole('textbox', { name: '스쿼트 내 메모' });
    await box.waitFor({ timeout: 5000 });
    const text = await box.inputValue();
    const note = await h.locator('.field-error').innerText().catch(() => '');
    check("실패 전에 다시 연 칸: '저장하는 중'을 보이다가 실패가 오면 닫지 않아도 저장하지 못한 글을 편집 칸에 바로 되돌림(3차 리뷰: 카드·버튼 없이)",
      saving === 1 && text === '먼저 연 칸의 글' && note.includes('저장하지 못한 메모예요') && ctl.sent[0].base === null, JSON.stringify({ saving, text, note }));
    // 되돌린 채 창을 닫아도 다시 열면 또 되돌리고, 그 글을 저장하면 끝(적대 검토 P3-D)
    await close();
    h = await open();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).waitFor({ timeout: 5000 });
    const keptAfterClose = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await h.locator('.memo-slot', { hasText: '먼저 연 칸의 글' }).waitFor({ timeout: 5000 });
    await close();
    h = await open();
    await p.waitForTimeout(300);
    const goneAfterSave = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).count();
    check('되돌린 채 창을 닫아도 다시 열면 또 되돌리고 · 그 글을 저장하면 다시 열어도 되돌리지 않음', keptAfterClose === '먼저 연 칸의 글' && goneAfterSave === 0, JSON.stringify({ keptAfterClose, goneAfterSave }));
    await close();
    // 다시 연 칸에서 이미 다른 글을 쓰는 중이면 그 글을 바꾸지 않고(알림만), 그 글을 취소하면 그때 되돌림
    h = await open();
    const g2 = await writeHeldThenClose(h, '실패할 글');
    h = await open();
    await h.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('지금 쓰는 다른 글');
    g2.open();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(200);
    const still = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    await h.getByRole('button', { name: '취소', exact: true }).click();
    await p.waitForTimeout(200);
    const after = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue().catch(() => '(없음)');
    check('다른 글을 쓰는 중에 옛 실패가 오면 그 글을 그대로 두고 알림만 · 그 글을 취소하면 저장하지 못한 글을 되돌림', still === '지금 쓰는 다른 글' && after === '실패할 글', JSON.stringify({ still, after }));
    await p.close();
  });

  // Codex v2.4.0 3차 리뷰 P3-1: 늦게 온 옛 저장의 성공 응답이, 다시 받기가 실패한 동안 더 새 메모를 가리지 않음
  await soft('2.4 리뷰 3차 P3-1 늦은 성공과 다시 받기 실패', async () => {
    const { p, ctl } = await memoPage('routine');
    await p.getByTestId('start-workout').click();
    const form = p.getByTestId('workout-form');
    const squat = form.locator('.workout-group[aria-label="스쿼트"]');
    await squat.getByRole('button', { name: /내 메모 추가/ }).click();
    await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('첫 저장 글');
    const late = gate(); ctl.plan.push({ after: late.p });
    await squat.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(200);
    await p.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).evaluate((b) => b.click());
    const hist = p.getByTestId('exercise-history');
    await hist.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('두 번째 정상 저장 글');
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await hist.locator('.memo-slot', { hasText: '두 번째 정상 저장 글' }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(300);
    ctl.memosFail = true;
    late.open();
    await p.waitForTimeout(400);
    await hist.getByRole('button', { name: '← 운동 기록으로' }).click();
    await form.waitFor({ state: 'visible', timeout: 5000 });
    const shown = await squat.locator('.memo-slot').innerText().catch(() => '');
    check('늦게 온 옛 성공 응답 뒤 다시 받기가 실패해도 운동 기록 창은 더 새 메모(두 번째 정상 저장 글)를 보임',
      shown.includes('두 번째 정상 저장 글') && !shown.includes('첫 저장 글') && ctl.mem.body === '두 번째 정상 저장 글', JSON.stringify({ shown, mem: ctl.mem }));
    ctl.memosFail = false;
    await p.close();
  });

  // 3차 리뷰 반영 뒤 넘기기 전 적대 검토: 되돌린 글을 손대지 않았으면 '쓰는 중'이 아니다(떠날 때 묻지 않음 · 더 새 실패로 바뀜) ·
  // 이 메모의 저장이 진행 중이면 옛 실패를 넣지 않음 · 되돌린 뒤 저장·취소하면 고치기가 한 번에 열림 · 저절로 되돌릴 때 커서를 옮기지 않음 ·
  // 더 새 저장이 성공하면 손대지 않은 옛 글을 닫음 · 늦게 온 지우기 성공이 더 새 메모를 가리지 않음
  await soft('2.4 리뷰 3차 반영 뒤 적대 검토(되돌린 글)', async () => {
    let { p, ctl, open, writeHeldThenClose } = await memoPage();
    let h = await open();
    let g = await writeHeldThenClose(h, '옛 글 A');
    g.open();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    h = await open();
    let box = h.getByRole('textbox', { name: '스쿼트 내 메모' });
    await box.waitFor({ timeout: 5000 });
    const asked = [];
    p.on('dialog', (d) => { asked.push(d.message()); void d.dismiss(); });
    await h.getByRole('button', { name: '← 운동 찾기로' }).click();
    const leftClean = (await p.getByTestId('exercise-find').count()) === 1 && asked.length === 0;
    await p.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
    await box.waitFor({ timeout: 5000 });
    const againA = await box.inputValue();
    // B로 고쳐 저장(붙잡음) → 층을 떠남 → 다시 열면 B가 끝날 때까지 A를 넣지 않음 → B 실패 → B를 되돌림
    await box.fill('새 글 B');
    const gb = gate(); ctl.plan.push({ hold: gb.p, outcome: 'fail' });
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(150);
    await h.getByRole('button', { name: '← 운동 찾기로' }).click();
    await p.getByTestId('exercise-find').locator('.find-row', { hasText: '스쿼트' }).click();
    await h.locator('.history-row').first().waitFor({ timeout: 5000 });
    await p.waitForTimeout(300);
    const whileSaving = await box.count();
    gb.open();
    await box.waitFor({ timeout: 5000 });
    await p.waitForTimeout(200);
    const restoredB = await box.inputValue();
    check("손대지 않은 되돌린 글은 떠날 때 묻지 않고 다시 열면 또 되돌림 · 더 새 저장(B)이 진행 중이면 옛 글(A)을 넣지 않고 · B가 실패하면 B를 되돌림",
      leftClean && againA === '옛 글 A' && whileSaving === 0 && restoredB === '새 글 B', JSON.stringify({ leftClean, asked, againA, whileSaving, restoredB }));
    // 되돌린 글을 저장한 뒤 고치기는 한 번에 열림
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await h.locator('.memo-slot', { hasText: '새 글 B' }).waitFor({ timeout: 5000 });
    await h.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await p.waitForTimeout(200);
    const openAfterSave = await box.count();
    await h.getByRole('button', { name: '취소', exact: true }).click();
    // 되돌린 글을 취소한 뒤 고치기도 한 번에 열림(지금 메모로)
    g = await writeHeldThenClose(h, '옛 글 C');
    g.open();
    await p.waitForTimeout(400);
    h = await open();
    await box.waitFor({ timeout: 5000 });
    await h.getByRole('button', { name: '취소', exact: true }).click();
    await h.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await p.waitForTimeout(200);
    const openAfterCancel = (await box.count()) === 1 ? await box.inputValue() : '(안 열림)';
    check('되돌린 글을 저장하거나 취소한 뒤 고치기를 한 번 누르면 바로 열림', openAfterSave === 1 && openAfterCancel === '새 글 B', JSON.stringify({ openAfterSave, openAfterCancel }));
    p.removeAllListeners('dialog');
    await p.close();

    // 저절로 되돌릴 때 커서를 옮기지 않음 · 더 새 저장이 성공하면 손대지 않은 옛 글을 닫음
    ({ p, ctl } = await memoPage('routine'));
    await p.getByTestId('start-workout').click();
    let form = p.getByTestId('workout-form');
    let squat = form.locator('.workout-group[aria-label="스쿼트"]');
    await squat.getByRole('button', { name: /내 메모 추가/ }).click();
    await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('폼의 옛 글');
    g = gate(); ctl.plan.push({ hold: g.p, outcome: 'fail' });
    await squat.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(150);
    await p.getByRole('button', { name: '창 닫기' }).click();
    await p.getByTestId('start-workout').click();
    form = p.getByTestId('workout-form');
    squat = form.locator('.workout-group[aria-label="스쿼트"]');
    const weight = form.getByLabel('레그 프레스 1세트 중량');
    await weight.click();
    await weight.fill('');
    await p.keyboard.type('10');
    g.open();
    await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).waitFor({ timeout: 5000 });
    await p.keyboard.type('5');
    const typed = await weight.inputValue();
    const memoText = await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).inputValue();
    check('저절로 되돌릴 때 커서를 메모 칸으로 옮기지 않음(치던 무게 칸에 그대로 입력)', typed === '105' && memoText === '폼의 옛 글', JSON.stringify({ typed, memoText }));
    await p.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).evaluate((b) => b.click());
    const hist = p.getByTestId('exercise-history');
    const layerBox = hist.getByRole('textbox', { name: '스쿼트 내 메모' });
    await layerBox.waitFor({ timeout: 5000 });
    await layerBox.fill('층에서 새로 쓴 글');
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await hist.locator('.memo-slot', { hasText: '층에서 새로 쓴 글' }).waitFor({ timeout: 5000 });
    await hist.getByRole('button', { name: '← 운동 기록으로' }).click();
    await form.waitFor({ state: 'visible', timeout: 5000 });
    await squat.locator('.memo-slot', { hasText: '층에서 새로 쓴 글' }).waitFor({ timeout: 5000 });
    const oldStill = await squat.getByRole('textbox', { name: '스쿼트 내 메모' }).count();
    check('더 새 저장이 성공하면 운동 기록 창의 손대지 않은 옛 글을 닫고 새 메모를 보임', oldStill === 0, String(oldStill));
    await p.close();

    // 늦게 온 지우기 성공이 그사이 받은 다른 기기의 새 메모를 가리지 않음
    ({ p, ctl, open } = await memoPage());
    ctl.mem = { body: '지울 메모', at: ctl.T(1) };
    h = await open();
    await h.getByRole('button', { name: '스쿼트 내 메모 고치기' }).click();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('');
    const late = gate(); ctl.plan.push({ after: late.p });
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(200);
    ctl.mem = { body: '다른 기기의 새 메모', at: ctl.T(40) };
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(400);
    ctl.memosFail = true;
    late.open();
    await p.waitForTimeout(500);
    const shown = await h.locator('.memo-slot').innerText().catch(() => '');
    check('늦게 온 지우기 성공 뒤 다시 받기가 실패해도 그사이 받은 다른 기기의 새 메모를 보임', shown.includes('다른 기기의 새 메모'), shown);
    await p.close();
  });

  // Codex v2.4.0 4차 리뷰 P3-2: 되돌린 실패 글을 저장된 글과 같게 고쳐 저장하면(통신 없음) 그 실패도 끝난다 — 다시 열어도 되돌리지 않음
  // 4차 리뷰 P3-1은 알려진 한계로 둔다: 메모가 없던 칸의 첫 저장은 그사이 '없음' 목록을 받았어도 성공한 글을 보인다(저장 전에 읽은 목록과
  // 저장 뒤 지운 목록을 가를 수 없고, 앞의 경우가 흔하다 — 넘기기 전 적대 검토). 아래 첫 묶음이 그 선택을 지킨다
  await soft('2.4 리뷰 4차 첫 저장 중 받은 목록·변경 없는 저장', async () => {
    const memosRead = (p) => p.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/exercise_memos'), { timeout: 5000 });
    // 보낸 뒤 받은 목록이 저장 전에 읽은 것(없음)이고 저장 뒤 다시 받기도 실패해도, 저장에 성공한 글을 보인다
    let { p, ctl, open } = await memoPage();
    let h = await open();
    await h.getByRole('button', { name: /내 메모 추가/ }).click();
    await h.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('저장 전에 읽힌 글');
    const late = gate(); ctl.plan.push({ hold: late.p }); // 서버 저장 전에 붙잡음
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(200);
    const read = memosRead(p);
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await read;
    await p.waitForTimeout(150);
    ctl.memosFail = true;
    late.open();
    await p.waitForTimeout(500);
    const shown = await h.getByTestId('memo-box').innerText().catch(() => '');
    check('메모가 없던 칸의 첫 저장 중 받은 목록이 저장 전에 읽은 것이면, 저장 뒤 다시 받기가 실패해도 저장에 성공한 글을 보임',
      shown.includes('저장 전에 읽힌 글') && ctl.mem?.body === '저장 전에 읽힌 글', JSON.stringify({ shown, mem: ctl.mem }));
    ctl.memosFail = false;
    await p.close();

    // P3-2
    let writeHeldThenClose;
    ({ p, ctl, open, writeHeldThenClose } = await memoPage());
    ctl.mem = { body: '원래 저장된 글', at: ctl.T(1) };
    h = await open();
    const g = await writeHeldThenClose(h, '고르지 않을 실패 글');
    g.open();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    h = await open();
    const box = h.getByRole('textbox', { name: '스쿼트 내 메모' });
    await box.waitFor({ timeout: 5000 });
    const restoredText = await box.inputValue();
    await box.fill('원래 저장된 글');
    await h.getByRole('button', { name: '저장', exact: true }).click();
    await h.locator('.memo-slot', { hasText: '원래 저장된 글' }).waitFor({ timeout: 5000 });
    await p.getByRole('button', { name: '창 닫기' }).click();
    await p.getByTestId('exercise-history').waitFor({ state: 'detached', timeout: 5000 });
    h = await open();
    await p.waitForTimeout(400);
    const again = await h.getByRole('textbox', { name: '스쿼트 내 메모' }).count();
    const slotShown = await h.locator('.memo-slot', { hasText: '원래 저장된 글' }).count();
    check('되돌린 실패 글을 저장된 글과 같게 고쳐 저장하면 통신 없이 닫고, 다시 열어도 그 실패 글을 되돌리지 않음',
      restoredText === '고르지 않을 실패 글' && again === 0 && slotShown === 1 && ctl.sent.length === 1 && ctl.mem?.body === '원래 저장된 글', JSON.stringify({ restoredText, again, slotShown, sent: ctl.sent, mem: ctl.mem }));
    await p.close();
  });

  // 2.4.1(2026-11-10 사용자 의견): 새 기록을 루틴으로 채울 때 무게는 그 운동을 마지막으로 한 기록의 무게(루틴 무게는 시트 첫 회차 칸이라 회차가 지나도 그대로였다)
  //  - 같은 번호 세트의 무게, 이전 기록에 없는 번호는 마지막 세트 · 한 적 없는 운동은 루틴 무게 · 횟수는 루틴 그대로
  //  - 이전 기록이 오기 전에 손댄 세트는 그대로 · 채운 것은 사용자 입력이 아니라 닫을 때 묻지 않음
  await soft('2.4.1 새 기록의 최신 무게', async () => {
    const open = async (ctrl) => {
      const p = await ctx.newPage();
      await p.clock.install({ time: new Date('2026-11-10T10:00:00+09:00') });
      await exRoutes(p, ctrl);
      await p.route('**/rest/v1/rpc/last_exercise_sets', async (r) => {
        ctrl.lastAsked = (ctrl.lastAsked ?? 0) + 1;
        if (ctrl.lastHold) await ctrl.lastHold;
        return fulfill(r, ctrl.lastData);
      });
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.bottom-nav').getByRole('button', { name: '운동', exact: true }).click();
      await p.getByTestId('routine-day-1').waitFor({ timeout: 15000 });
      await p.getByTestId('start-workout').click();
      const form = p.getByTestId('workout-form');
      await form.waitFor();
      return { p, form, val: (label) => form.getByLabel(label).inputValue() };
    };
    const latest = { 스쿼트: { id: 'w3', day: '2026-11-07', sets: [{ set_no: 1, kg: '62.5', reps: '10' }, { set_no: 2, kg: '75', reps: '8' }] } };
    // 받은 뒤: 세트마다 최신 무게, 기록 없는 레그 프레스는 루틴 무게, 횟수는 루틴
    let ctrl = { routines: [exRoutine], lastData: latest };
    let { p, form, val } = await open(ctrl);
    await form.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(200);
    const got = { sq1: await val('스쿼트 1세트 중량'), sq2: await val('스쿼트 2세트 중량'), leg: await val('레그 프레스 1세트 중량'), reps: await val('스쿼트 1세트 횟수') };
    check('새 기록: 루틴 무게(70) 대신 그 운동을 마지막으로 한 기록의 무게를 세트마다 채움 · 기록 없는 운동은 루틴 무게 · 횟수는 루틴',
      got.sq1 === '62.5' && got.sq2 === '75' && got.leg === '100' && got.reps === '8', JSON.stringify(got));
    const asked = [];
    p.on('dialog', (d) => { asked.push(d.message()); void d.dismiss(); });
    await p.getByRole('button', { name: '창 닫기' }).click();
    await p.waitForTimeout(300);
    check('최신 무게로 채운 것은 쓰던 내용이 아님(닫을 때 묻지 않고 닫힘)', asked.length === 0 && (await p.getByTestId('workout-form').count()) === 0, JSON.stringify(asked));
    await p.close();
    // 받기 전에 손댄 세트는 그대로, 나머지만 최신 무게
    let release; ctrl = { routines: [exRoutine], lastData: latest, lastHold: new Promise((r) => (release = r)) };
    ({ p, form, val } = await open(ctrl));
    await form.getByLabel('스쿼트 1세트 중량').fill('65');
    release();
    await form.getByRole('button', { name: /스쿼트 이전 기록 보기/ }).waitFor({ timeout: 5000 });
    await p.waitForTimeout(200);
    const mixed = { sq1: await val('스쿼트 1세트 중량'), sq2: await val('스쿼트 2세트 중량') };
    check('이전 기록이 오기 전에 손댄 세트는 그대로 두고 나머지 세트만 최신 무게', mixed.sq1 === '65' && mixed.sq2 === '75', JSON.stringify(mixed));
    await p.close();
    // 한 적 없는 운동뿐이면 루틴 무게 그대로
    ctrl = { routines: [exRoutine], lastData: {} };
    ({ p, form, val } = await open(ctrl));
    await p.waitForTimeout(600);
    const plain = { sq1: await val('스쿼트 1세트 중량'), sq2: await val('스쿼트 2세트 중량'), asked: ctrl.lastAsked ?? 0 };
    check('이전 기록이 없으면 루틴 무게 그대로', plain.sq1 === '70' && plain.sq2 === '70' && plain.asked > 0, JSON.stringify(plain));
    await p.close();
  });

  // 2.4.1(2026-11-10 사용자 의견 '쉬는 시간 끝 소리가 너무 작다', 후보 중 2번 '빠른 삐삐삐'를 고름): 짧은 삐 네 번 × 세 묶음 · 소리 나는 동안의 크기가 커짐 · 넘쳐서 찢어지지 않음
  await soft('2.4.1 쉬는 시간 끝 소리 크기', async () => {
    const p = await ctx.newPage();
    await p.goto(`${BASE}?mode=member`);
    const m = await p.evaluate(async () => {
      const { scheduleRestBeeps } = await import('/src/lib/restBeep.ts');
      const rate = 48000, ac = new OfflineAudioContext(1, rate * 2, rate);
      scheduleRestBeeps(ac, 0.05);
      const d = (await ac.startRendering()).getChannelData(0);
      // 묶음: 0.1초 넘게 조용하면 끊김 · 삐: 0.02초 넘게 조용하면 끊김
      const count = (gap) => { let c = 0, on = false, quiet = 0; for (const x of d) { if (Math.abs(x) > 0.01) { if (!on) c++; on = true; quiet = 0; } else if (on && ++quiet > rate * gap) on = false; } return c; };
      let peak = 0, sum = 0, n = 0;
      for (const x of d) { const a = Math.abs(x); peak = Math.max(peak, a); if (a > 0.01) { sum += x * x; n++; } }
      return { groups: count(0.1), pulses: count(0.02), peak, rmsDb: 20 * Math.log10(Math.sqrt(sum / n)), sec: n / rate };
    });
    // 고치기 전(880Hz 사인파, 최고 0.35에서 바로 잦아듦)은 같은 측정으로 -19.7dBFS·0.23초(scripts/review-local/v241-20261110/measure-beep-result.json)
    check('쉬는 시간 끝 소리: 짧은 삐 네 번 × 세 묶음 · 소리 나는 동안 -8dBFS 이상(고치기 전 -19.7) · 0.6초 이상 · 최고 1 미만(찢어지지 않음)',
      m.groups === 3 && m.pulses === 12 && m.rmsDb >= -8 && m.sec >= 0.6 && m.peak < 1, JSON.stringify(m));
    await p.close();
  });

  // 적대 검토 3차 S3: 받은 사진이 이미지로 열리지 않으면(깨진 파일) 다시 불러오기가 캐시를 버리고 새로 받는다
  await soft('2.4 깨진 사진 파일의 다시 불러오기', async () => {
    const p = await ctx.newPage();
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const meal = { id: '55555555-5555-4555-8555-5555555555aa', member_id: '11111111-1111-4111-8111-000000000001', eaten_on: today, eaten_at: '12:00', meal_type: '점심', food: '깨진 파일 검증', note: '', photo_path: '11111111-1111-4111-8111-000000000001/z.jpg', created_at: d0.toISOString(), reviewed_at: null, member_seen_at: d0.toISOString(), note_updated_at: d0.toISOString(), member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [], member: { nickname: '검증 회원 1' } };
    let calls = 0, good = false;
    await p.route('**/rest/v1/**', (r) => (new URL(r.request().url()).pathname.endsWith('/meals') ? fulfill(r, [meal]) : fulfill(r, [])));
    await p.route('**/functions/v1/meal-photo*', (r) => { calls++; return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: good ? jpeg : Buffer.from('not an image') }); });
    await p.goto(`${BASE}?mode=trainer`);
    await p.locator('.meal-card', { hasText: '깨진 파일 검증' }).click();
    const failed = p.getByTestId('photo-failed');
    await failed.waitFor({ timeout: 10000 });
    const before = calls;
    good = true;
    await failed.getByRole('button', { name: '다시 불러오기' }).click();
    await p.locator('dialog[open] img.detail-photo').waitFor({ timeout: 5000 });
    check('받은 사진이 열리지 않으면 실패 안내, 다시 불러오기는 캐시를 버리고 새로 받아 보임', calls === before + 1 && (await p.getByTestId('photo-failed').count()) === 0, JSON.stringify({ before, calls }));
    await p.close();
  });

  // P3-1: 서명 주소의 이미지가 깨지면 서버 기능으로 다시 받고, 그것도 실패하면 실패 안내(상세·수정 창 같은 규칙) · 후속: 폼이 만든 미리보기 주소는 닫을 때 해제
  await soft('2.4 리뷰 1차 P3-1 서명 주소 사진 실패와 미리보기 주소', async () => {
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const meal = { id: '55555555-5555-4555-8555-555555555599', member_id: a, eaten_on: today, eaten_at: '12:00', meal_type: '점심', food: '깨진 서명 사진', note: '', photo_path: `${a}/s.jpg`, created_at: d0.toISOString(), reviewed_at: null, member_seen_at: d0.toISOString(), note_updated_at: d0.toISOString(), member_msg_at: null, trainer_msg_at: null, rating: null, rated_at: null, shared_at: null, comments: [] };
    const run = async (fnOk) => {
      const c = await newCtx({ ...devices['iPhone 13'] });
      const p = await c.newPage();
      await p.route('**/rest/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
        if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 1, best: 1, today_logged: true });
        if (path.endsWith('/meals')) return fulfill(r, new URL(r.request().url()).searchParams.has('id') ? meal : [meal]);
        return fulfill(r, []);
      });
      await p.route('**/storage/v1/**', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 500, contentType: 'text/plain', body: 'gone' }) : fulfill(r, [{ path: meal.photo_path, signedURL: `/object/sign/meal-photos/${meal.photo_path}?token=t`, error: null }])));
      await p.route('**/functions/v1/meal-photo*', (r) => (fnOk ? r.fulfill({ status: 200, contentType: 'application/octet-stream', body: jpeg }) : r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' })));
      await p.goto(`${BASE}?mode=member`);
      await p.locator('.meal-card', { hasText: '깨진 서명 사진' }).first().click();
      const d = p.locator('dialog[open]');
      const out = {};
      if (fnOk) {
        await d.locator('img.detail-photo[src^="blob:"]').waitFor({ timeout: 8000 });
        out.detail = 'blob';
        await d.getByRole('button', { name: '수정', exact: true }).click();
        await d.locator('.meal-photo-has img[src^="blob:"]').waitFor({ timeout: 8000 });
        out.edit = 'blob';
      } else {
        await p.getByTestId('photo-failed').waitFor({ timeout: 8000 });
        out.detail = 'failed';
      }
      await c.close();
      return out;
    };
    const ok = await run(true), bad = await run(false);
    check('서명 주소의 이미지가 깨지면 서버 기능으로 다시 받아 상세·수정 창에 보이고, 그것도 실패하면 실패 안내', ok.detail === 'blob' && ok.edit === 'blob' && bad.detail === 'failed', JSON.stringify({ ok, bad }));

    const c = await newCtx({ ...devices['iPhone 13'] });
    await c.addInitScript(() => {
      const live = new Set(); window.__blob = live;
      const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (b) => { const u = mk(b); live.add(u); return u; };
      URL.revokeObjectURL = (u) => { live.delete(u); rv(u); };
      // 압축 끝을 붙잡아 두는 스위치(2차 리뷰 4절: 압축 도중 창을 닫는 경우)
      const tb = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, ...args) { return tb.call(this, (b) => { if (window.__holdBlob) window.__releaseBlob = () => cb(b); else cb(b); }, ...args); };
    });
    const p = await c.newPage();
    await p.route('**/rest/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/assignments')) return fulfill(r, { trainer: { nickname: '검증 코치' } });
      if (path.endsWith('/rpc/meal_streak')) return fulfill(r, { current: 0, best: 0, today_logged: false });
      return fulfill(r, []);
    });
    await p.goto(`${BASE}?mode=member`);
    await p.getByTestId('add-meal').click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (let i = 0; i < 3; i++) {
      await p.getByLabel('식사 사진 선택').setInputFiles({ name: `m${i}.png`, mimeType: 'image/png', buffer: png });
      await p.waitForTimeout(400);
    }
    const whileOpen = await p.evaluate(() => window.__blob.size);
    p.once('dialog', (dd) => dd.accept());
    await p.getByRole('button', { name: '창 닫기' }).click();
    await p.waitForTimeout(400);
    const afterClose = await p.evaluate(() => window.__blob.size);
    check('폼이 만든 미리보기 주소: 바꿀 때 앞 주소를 해제하고(열린 동안 하나) 창을 닫으면 해제', whileOpen === 1 && afterClose === 0, JSON.stringify({ whileOpen, afterClose }));
    // 2차 리뷰 4절: 압축이 끝나기 전에 창을 닫으면, 늦게 끝난 압축이 미리보기 주소를 새로 만들지 않음
    await p.getByTestId('add-meal').click();
    await p.evaluate(() => { window.__holdBlob = true; window.__releaseBlob = null; });
    await p.getByLabel('식사 사진 선택').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: png });
    await p.waitForFunction(() => !!window.__releaseBlob, null, { timeout: 5000 });
    await p.getByRole('button', { name: '창 닫기' }).click();
    await p.waitForTimeout(200);
    await p.evaluate(() => { window.__holdBlob = false; window.__releaseBlob(); });
    await p.waitForTimeout(400);
    const lateLeft = await p.evaluate(() => window.__blob.size);
    check('사진 압축 도중 창을 닫으면 늦게 끝난 압축이 미리보기 주소를 만들지 않음(남은 주소 0)', lateLeft === 0, String(lateLeft));
    await c.close();
  });

  // 트레이너(결정 3-2·3-3): 루틴 카드의 운동마다 '메모 추가' → 그 운동의 기록에서 바로 쓰기, 회원 메모는 읽기만
  await soft('2.4 트레이너 메모 추가', async () => {
    const { p } = await trainerPage(1);
    const ctrl = { trainerView: true, routines: [{ ...exRoutine, member_id: '11111111-1111-4111-8111-000000000001' }], memos: [{ key: '레그프레스', author: 'member', name: '레그 프레스', body: '왼쪽 무릎이 불편함', updated_at: '2026-11-08T01:00:00Z' }] };
    await exRoutes(p, ctrl);
    await p.locator('.member-row').first().click();
    await p.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '루틴', exact: true }).click();
    const card = p.getByTestId('routine-day-1');
    await card.waitFor({ timeout: 10000 });
    const memberMemo = await card.locator('.routine-memo', { hasText: '왼쪽 무릎' }).innerText();
    await card.getByRole('button', { name: '스쿼트 메모 추가' }).click();
    const hist = p.getByTestId('exercise-history');
    await hist.waitFor({ timeout: 5000 });
    const box = hist.getByRole('textbox', { name: '스쿼트 내 메모' });
    await box.waitFor({ timeout: 5000 });
    const focused = await box.evaluate((e) => e === document.activeElement);
    await box.fill('내려갈 때 3초');
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await hist.locator('.memo-slot.is-coach', { hasText: '내려갈 때 3초' }).waitFor({ timeout: 5000 });
    check("트레이너: 루틴 카드에 '회원 메모' · '메모 추가'를 누르면 그 운동의 기록에서 바로 쓰기 · 저장하면 '내 메모'",
      memberMemo.includes('회원 메모') && focused && ctrl.saved?.p_member === '11111111-1111-4111-8111-000000000001' && (await hist.locator('.memo-slot.is-coach b').innerText()) === '내 메모', JSON.stringify({ memberMemo, focused, saved: ctrl.saved }));
    await p.close();
  });

  // 2차 리뷰 P2-1: 트레이너 칸도 같은 원칙 — 메모 추가로 연 칸을 저장 중 ✕로 닫고 실패하면, 다시 메모 추가를 눌렀을 때 저장하지 못한 글
  await soft('2.4 리뷰 2차 트레이너 칸의 저장하지 못한 메모', async () => {
    const { p } = await trainerPage(1);
    const ctrl = { trainerView: true, routines: [{ ...exRoutine, member_id: '11111111-1111-4111-8111-000000000001' }], memos: [] };
    await exRoutes(p, ctrl);
    await p.locator('.member-row').first().click();
    await p.getByRole('group', { name: '회원 화면' }).getByRole('button', { name: '루틴', exact: true }).click();
    const card = p.getByTestId('routine-day-1');
    await card.waitFor({ timeout: 10000 });
    await card.getByRole('button', { name: '스쿼트 메모 추가' }).click();
    const hist = p.getByTestId('exercise-history');
    await hist.getByRole('textbox', { name: '스쿼트 내 메모' }).fill('트레이너가 쓴 글');
    let release;
    ctrl.memoHold = new Promise((r) => (release = r));
    await hist.getByRole('button', { name: '저장', exact: true }).click();
    await p.waitForTimeout(150);
    await p.getByRole('button', { name: '창 닫기' }).click();
    release();
    await p.locator('.toast', { hasText: '스쿼트 메모를 저장하지 못했어요' }).waitFor({ timeout: 5000 });
    ctrl.memoHold = null;
    await card.getByRole('button', { name: '스쿼트 메모 추가' }).click();
    const box = hist.getByRole('textbox', { name: '스쿼트 내 메모' });
    await box.waitFor({ timeout: 5000 });
    await p.waitForTimeout(200);
    const back = await box.inputValue();
    check("트레이너 칸: 저장 중 ✕로 닫은 뒤 실패하면 알리고, 다시 '메모 추가'로 열면 저장하지 못한 글을 편집 칸에 바로 되돌림", back === '트레이너가 쓴 글', JSON.stringify({ back }));
    await p.close();
  });
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
