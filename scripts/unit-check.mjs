// 화면·DB 없이 도는 규칙 검증: 결산 한 줄 정리(2×2), 인바디 숫자 고르기 규칙.
// src/lib의 TypeScript를 그대로 변환해 불러온다.  실행: npm run check (또는 sh scripts/check.sh unit)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const require = createRequire(`${process.cwd()}/package.json`);
const ts = require('typescript');
const load = async (file) => {
  const src = readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js + '\n//' + randomUUID()).toString('base64')}`);
};
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

const { summarize, dayAfter, changeOf } = await load('src/lib/report.ts');
const R = (score, meals = 10, rated = 8) => ({ days: 30, logged_days: 20, meals, great: 0, good: 0, care: 0, rated, score });
const T = '다음 목표를 트레이너와 함께 정해 보세요.';
const cases = [
  ['평가 평균 높음 × 개선', R(4.3), { weight: -1, smm: 0.4, pbf: -1.2 }, (s) => s.goodDiet && s.improved && s.line === '평가받은 식단 8끼의 평균은 5점 만점에 4.3점이에요. 체지방률이 1.2%p 내려갔어요. 골격근량이 0.4kg 늘었어요.'],
  ['평가 평균 기준선 3.5 × 개선 없음', R(3.5), { weight: 0.5, smm: -0.2, pbf: 0.3 }, (s) => s.goodDiet && s.improved === false && s.line === `평가받은 식단 8끼의 평균은 5점 만점에 3.5점이에요. 체지방률은 0.3%p 늘었어요. 골격근량은 0.2kg 줄었어요. ${T}`],
  ['평가 평균 낮음 × 개선', R(3), { weight: -0.3, smm: 0, pbf: -0.5 }, (s) => s.goodDiet === false && s.improved && s.line === `평가받은 식단 8끼의 평균은 5점 만점에 3점이에요. 체지방률이 0.5%p 내려갔어요. 골격근량은 그대로예요. ${T}`],
  ['평가 평균 낮음 × 개선 없음(한 끼만 평가)', R(1, 3, 1), { weight: 1, smm: 0, pbf: 0 }, (s) => s.goodDiet === false && s.improved === false && s.line === `평가받은 식단 1끼는 5점 만점에 1점이에요. 체지방률은 그대로예요. 골격근량은 그대로예요. ${T}`],
  ['골격근량 기록 없음 — 비교할 수 없다고만(좋아지지 않았다고 하지 않음)', R(4), { weight: 0.2, smm: null, pbf: 0.3 }, (s) => s.improved === false && s.line === `평가받은 식단 8끼의 평균은 5점 만점에 4점이에요. 체지방률은 0.3%p 늘었어요. 골격근량은 기록이 없어 비교할 수 없어요. ${T}`],
  ['체지방률 기록 없음', R(4), { weight: 0, smm: 0.5, pbf: null }, (s) => s.improved && s.line === '평가받은 식단 8끼의 평균은 5점 만점에 4점이에요. 골격근량이 0.5kg 늘었어요. 체지방률은 기록이 없어 비교할 수 없어요.'],
  ['평가 없음', R(null, 5, 0), { weight: 0, smm: 0.2, pbf: null }, (s) => s.goodDiet === null && s.line === '이 기간에는 평가받은 식단이 없어요. 골격근량이 0.2kg 늘었어요. 체지방률은 기록이 없어 비교할 수 없어요.'],
  ['식단 기록 없음', R(null, 0, 0), { weight: 0, smm: null, pbf: null }, (s) => s.line === '이 기간에는 남긴 식단이 없어요. 골격근량·체지방률도 기록하면 변화를 함께 볼 수 있어요.'],
  ['골격근량·체지방률 없이 체중만', R(4.8), { weight: -1, smm: null, pbf: null }, (s) => s.improved === null && s.line === '평가받은 식단 8끼의 평균은 5점 만점에 4.8점이에요. 골격근량·체지방률도 기록하면 변화를 함께 볼 수 있어요.'],
];
for (const [name, r, c, ok] of cases) { const s = summarize(r, c); check(`결산 한 줄: ${name}`, ok(s), s.line); }
check('결산 한 줄에 인과 단정·탓하는 표현 없음', cases.every(([, r, c]) => !/때문|덕분|덕에|효과|잘 지켰|아쉬웠|챙겨 봐요|올려 봐요/.test(summarize(r, c).line)));
check('기록 없는 항목을 \'좋아지지 않았다\'고 말하지 않음', cases.every(([, r, c]) => !/좋아지지 않았/.test(summarize(r, c).line)));
check('평가 점수 5·3·1, 기준선 3.5(3.4는 아래)', summarize(R(3.4), { weight: 0, smm: 0.1, pbf: null }).goodDiet === false && summarize(R(3.5), { weight: 0, smm: 0.1, pbf: null }).goodDiet === true);
check('기간 시작일(직전 측정 다음 날, 달 넘김)', dayAfter('2026-09-30') === '2026-10-01' && dayAfter('2026-12-31') === '2027-01-01');
const ch = changeOf({ weight_kg: 72.1, smm_kg: 32.8, pbf_pct: 22.4 }, { weight_kg: 73.3, smm_kg: 32.5, pbf_pct: 23.6 });
check('인바디 변화 계산(소수 오차 없음)', ch.weight === -1.2 && ch.smm === 0.3 && ch.pbf === -1.2, JSON.stringify(ch));

const { parseInbody } = await load('src/lib/inbodyParse.ts');
const today = new Date(2026, 9, 23);
check('측정일: 결과지 표기', parseInbody.parseDate('검사일시 2026.10.02. 19:03', today) === '2026-10-02');
check('측정일: 앞날짜·없는 날짜는 버림', parseInbody.parseDate('2026.12.01', today) === null && parseInbody.parseDate('2026.02.30', today) === null);
check('측정일: 회원번호(전화번호) 숫자는 날짜로 읽지 않음', parseInbody.parseDate('01012345678 170cm 40', today) === null);
const cv = (t, d) => JSON.stringify(parseInbody.compValue(t, d));
check('체성분 값: 괄호 안 정상 범위는 버림', cv('(kg) 69.0 ( 57.9~78.3 )') === '{"v":69,"exact":true}');
check('체성분 값: 소수점 빠짐 되살림(무기질 두 자리)', cv('09) 156(82~164)') === '{"v":15.6,"exact":false}' && cv('354 (355~433)', 2) === '{"v":3.54,"exact":false}');
check('체성분 값: 자릿수가 안 맞으면 버림', parseInbody.compValue('3902(383~469)') === null);

// 새 버전 자동 적용: 로그인 연장을 기다리는 사이·새로고침 직전에 입력을 시작하면 멈춘다(Codex 재검토 v1.4 P2)
const updateEnv = () => {
  const env = { updates: 0, reloads: 0, timers: [], release: null, needRefresh: null, needReload: null, visible: null };
  const gate = new Promise((r) => (env.release = r));
  globalThis.document = { visibilityState: 'visible', activeElement: null, querySelector: () => null, addEventListener: (_e, fn) => { env.visible = fn; } };
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: {}, onLine: true }, configurable: true });
  globalThis.window = { setInterval() {}, setTimeout: (fn) => env.timers.push(fn), location: { reload: () => env.reloads++ } };
  globalThis.registerSW = (o) => { env.needRefresh = o.onNeedRefresh; env.needReload = o.onNeedReload; return async () => { env.updates++; }; };
  globalThis.supabase = { auth: { getSession: () => gate } };
  globalThis.__BUILD_ID__ = 'unit';
  return env;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };
{
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  env.needRefresh(); // 돌아온 순간 새 버전 발견 → 자동 적용 시작(로그인 연장 대기 중)
  u.setUnsaved('typing', true); // 기다리는 사이 글쓰기 시작
  env.release();
  await tick(); await tick();
  check('로그인 연장을 기다리는 사이 입력을 시작하면 자동 적용을 멈춤', env.updates === 0 && env.reloads === 0, JSON.stringify({ updates: env.updates, reloads: env.reloads }));
  await u.applyUpdate(); // '지금 적용'을 직접 누름
  env.timers.forEach((f) => f());
  await flush();
  check("입력 중이어도 '지금 적용'을 직접 누르면 적용", env.updates === 1 && env.reloads >= 1, JSON.stringify({ updates: env.updates, reloads: env.reloads }));
}
{
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  env.needRefresh();
  env.release();
  await tick(); await tick();
  u.setUnsaved('typing', true); // 새로고침 직전(3초 사이)에 입력 시작
  env.timers.forEach((f) => f());
  check('자동 적용 뒤 새로고침 직전에 입력을 시작하면 새로 고치지 않음', env.updates === 1 && env.reloads === 0, JSON.stringify({ updates: env.updates, reloads: env.reloads }));
}
{
  // 다른 탭이 새 버전을 적용 → 이 탭에도 '새 버전이 맡음' 신호. 이 탭은 입력 중(Codex 재검토 v1.4 r3 P2)
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  let shown = false;
  u.onUpdateReady((v) => (shown = v));
  u.startUpdateChecks();
  check('라이브러리가 직접 새로고침하지 않게 신호를 앱이 받음', typeof env.needReload === 'function');
  u.setUnsaved('login', true);
  env.needReload();
  check('다른 탭이 적용해도 이 탭이 입력 중이면 새로 고치지 않고 띠를 남김', env.reloads === 0 && shown === true, JSON.stringify({ reloads: env.reloads, shown }));
  env.visible(); // 입력 중인 채로 앱에 돌아옴
  check('입력 중이면 돌아와도 미룬 새로고침을 하지 않음', env.reloads === 0);
  u.setUnsaved('login', false); // 저장(또는 취소)
  env.release();
  env.visible();
  await flush();
  check('입력을 마친 뒤 돌아오면 미룬 새로고침을 함(로그인 연장 대기 뒤)', env.reloads === 1, String(env.reloads));
}
{
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  u.setUnsaved('login', true);
  env.needReload();
  env.release();
  await u.applyUpdate(); // '지금 적용'
  check("미룬 뒤 '지금 적용'을 누르면 바로 새로 고침", env.reloads === 1, String(env.reloads));
}
{
  // 이 탭이 자동 적용 → 서비스워커 활성화가 늦어지는 사이 입력 시작 → '맡음' 신호
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  env.needRefresh();
  env.release();
  await tick(); await tick();
  u.setUnsaved('typing', true);
  env.needReload();
  env.timers.forEach((f) => f());
  check('활성화가 늦어지는 사이 입력을 시작하면 새로 고치지 않음(신호·3초 타이머 모두)', env.updates === 1 && env.reloads === 0, JSON.stringify({ updates: env.updates, reloads: env.reloads }));
}
{
  // Codex 재검토 v1.4 r4 P2: 다른 탭이 적용한 신호가 로그인 연장 도중에 와도 연장이 끝난 뒤에 새로 고친다
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  env.needReload(); // 입력 없음, 로그인 연장은 진행 중(gate 미해제)
  await flush();
  const before = env.reloads;
  env.release();
  await flush();
  check('다른 탭 신호가 와도 로그인 연장이 끝나기 전에는 새로 고치지 않음', before === 0 && env.reloads >= 1, JSON.stringify({ before, after: env.reloads }));
}
{
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  env.needRefresh(); // 이 탭의 자동 적용이 로그인 연장을 기다리는 중
  await flush();
  env.needReload(); // 그사이 다른 탭이 적용을 마침
  await flush();
  const before = env.reloads;
  env.release();
  await flush();
  check('이 탭 적용 대기 중 다른 탭 신호가 와도 연장이 끝난 뒤 한 번만 새로 고침', before === 0 && env.reloads >= 1, JSON.stringify({ before, after: env.reloads }));
}
{
  const env = updateEnv();
  const u = await load('src/lib/appUpdate.ts');
  u.startUpdateChecks();
  env.needReload(); // 로그인 연장 대기 중
  await flush();
  u.setUnsaved('typing', true); // 기다리는 사이 입력 시작
  env.release();
  await flush();
  check('로그인 연장을 기다리는 사이 입력을 시작하면 다른 탭 신호로도 새로 고치지 않음', env.reloads === 0, String(env.reloads));
}

// 화면 테마(v1.4.2): 저장값 해석·저장 불가·다른 탭 변경
{
  const store = new Map();
  let storageFails = false, storageListener = null;
  const metas = [{ v: '', setAttribute(_k, v) { this.v = v; } }];
  globalThis.document = { documentElement: { dataset: {}, style: {} }, querySelectorAll: () => metas };
  globalThis.window = { addEventListener: (e, fn) => { if (e === 'storage') storageListener = fn; } };
  globalThis.localStorage = { getItem: (k) => (storageFails ? (() => { throw new Error('blocked'); })() : store.get(k) ?? null), setItem: (k, v) => { if (storageFails) throw new Error('blocked'); store.set(k, v); } };
  const th = await load('src/lib/theme.ts');
  check('테마 저장값 해석: 없거나 알 수 없으면 라이트', th.parseTheme(null) === 'light' && th.parseTheme('purple') === 'light' && th.parseTheme('dark') === 'dark' && th.parseTheme('light') === 'light');
  th.startTheme();
  check('첫 실행(저장값 없음)은 라이트', document.documentElement.dataset.theme === 'light' && metas[0].v === '#F5F5F5');
  th.setTheme('dark');
  check('다크 선택 → 즉시 적용·저장·브라우저 상단 색', document.documentElement.dataset.theme === 'dark' && store.get('mealnote:theme') === 'dark' && metas[0].v === '#171B19' && document.documentElement.style.colorScheme === 'dark');
  storageFails = true;
  th.setTheme('light');
  check('저장할 수 없어도 이번 실행에서는 바뀐 테마 유지', document.documentElement.dataset.theme === 'light' && th.readTheme() === 'light');
  storageFails = false;
  storageListener({ key: 'mealnote:theme', newValue: 'dark' });
  check('다른 탭에서 바꾸면 이 탭도 따라감', document.documentElement.dataset.theme === 'dark');
  storageListener({ key: 'mealnote:text-size', newValue: 'large' });
  check('다른 설정의 변경은 테마에 영향 없음', document.documentElement.dataset.theme === 'dark');
}


// 알림 누르기 계약: 서비스워커(public/push-sw.js)가 적는 IndexedDB 이름·버전·저장소·키와 화면 목록을 앱(pushOpen.ts)이 그대로 읽는가
{
  const { PUSH_OPEN_DB, PUSH_SCREENS } = await load('src/lib/pushOpen.ts');
  const sw = readFileSync('public/push-sw.js', 'utf8');
  const open = /indexedDB\.open\('([^']+)',\s*(\d+)\)/.exec(sw);
  const store = /createObjectStore\('([^']+)'\)/.exec(sw);
  const put = /objectStore\('([^']+)'\)\.put\(value,\s*'([^']+)'\)/.exec(sw);
  const screens = /const SCREENS = \[([^\]]+)\]/.exec(sw)?.[1].match(/'([^']+)'/g)?.map((x) => x.slice(1, -1));
  check('알림 누르기: 서비스워커와 앱의 IndexedDB 이름·버전이 같음', open?.[1] === PUSH_OPEN_DB.name && Number(open?.[2]) === PUSH_OPEN_DB.version, JSON.stringify(open?.slice(1)));
  check('알림 누르기: 저장소·키가 같음', store?.[1] === PUSH_OPEN_DB.store && put?.[1] === PUSH_OPEN_DB.store && put?.[2] === PUSH_OPEN_DB.key, JSON.stringify([store?.[1], put?.[1], put?.[2]]));
  check('알림 누르기: 화면 목록이 같음', JSON.stringify(screens) === JSON.stringify([...PUSH_SCREENS]), JSON.stringify(screens));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
