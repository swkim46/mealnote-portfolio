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
const soft = async (label, fn) => { try { await fn(); } catch (e) { check(label, false, String(e.message).split('\n')[0]); } };
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const row = (member, w) => ({ id: 'record-' + member, member_id: member, measured_on: '2026-10-22', weight_kg: w, smm_kg: 30, pbf_pct: 22, source: 'manual' });
const fulfill = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
const state = async (p) => JSON.parse(await p.getByTestId('state').textContent());
const open = async (ctx, mode) => {
  const p = await ctx.newPage();
  return { p, go: async () => { await p.goto(`${BASE}?mode=${mode}`); await p.waitForLoadState('networkidle'); } };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
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
      if (r.method() === 'GET') return failRead ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"db down"}' }) : fulfill(route, [{ digest: true, digest_times: '3', feedback: false, reminder: true, morning: true }]);
      const body = r.postDataJSON();
      saves.push(pick(Array.isArray(body) ? body[0] : body));
      return fulfill(route, { digest: true, digest_times: '3', feedback: false, reminder: true, ...pick(Array.isArray(body) ? body[0] : body) });
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
    const server = { digest: true, digest_times: '3', feedback: true, reminder: true, morning: true };
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

  const item = { key: 'recorded:33333333-3333-4333-8333-333333333333', kind: 'recorded', at: '2026-10-27T01:00:00Z', meal_id: '33333333-3333-4333-8333-333333333333', eaten_on: '2026-10-27', meal_type: '점심', actor: '검증회원' };
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
  const ev = (n, at) => ({ key: `recorded:${String(n).padStart(3, '0')}`, kind: 'recorded', at, meal_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, eaten_on: '2026-10-27', meal_type: '점심', actor: '검증회원' });
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

  // 14) 그림 안내를 보며 휴대폰 설정에서 알림 차단을 풂 → 앱 복귀·안내에서 돌아오면 켜기 버튼(Codex v1.7 운영 배포 후 리뷰 1)
  const permStub = async (p, initial) => {
    await p.addInitScript((perm) => {
      window.__perm = perm;
      Object.defineProperty(Notification, 'permission', { get: () => window.__perm });
      Notification.requestPermission = async () => window.__perm;
    }, initial);
  };
  const prefsRoute = (p) => p.route('**/rest/v1/push_prefs*', (route) => fulfill(route, [{ digest: true, digest_times: '3', feedback: true, reminder: true, morning: true }]));
  await soft('알림 권한 바뀜 동기화', async () => {
    const { p, go } = await open(ctx, 'prefs');
    await permStub(p, 'denied');
    await prefsRoute(p);
    await go();
    await p.getByText('휴대폰 설정 → 알림에서 식단노트를 허용해 주세요', { exact: false }).waitFor({ timeout: 10000 });
    await p.getByRole('button', { name: '알림 설정 방법 보기' }).click();
    await p.evaluate(() => { window.__perm = 'default'; document.dispatchEvent(new Event('visibilitychange')); }); // 휴대폰 설정에서 차단을 풀고 돌아옴
    await p.getByRole('button', { name: '알림 설정으로 돌아가기' }).first().click();
    await p.waitForTimeout(800);
    check('안내를 보며 차단을 풀고 돌아오면 이 기기 켜기 버튼이 보임', (await p.getByRole('button', { name: '이 기기에서 알림 받기' }).count()) === 1);
    await p.evaluate(() => { window.__perm = 'denied'; document.dispatchEvent(new Event('visibilitychange')); }); // 반대로 다시 차단
    await p.waitForTimeout(800);
    check('앱 밖에서 다시 차단하고 돌아오면 허용하라는 안내로 바뀜', (await p.getByText('휴대폰 설정 → 알림에서 식단노트를 허용해 주세요', { exact: false }).count()) === 1);
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
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
