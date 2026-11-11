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
// 다른 src/lib 파일을 불러오는 모듈은 묶어서 불러온다(import를 지우면 쓰는 함수가 사라진다)
const bundle = async (file) => {
  const out = await require('esbuild').build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text + '\n//' + randomUUID()).toString('base64')}`);
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
  check('첫 실행(저장값 없음)은 라이트', document.documentElement.dataset.theme === 'light' && metas[0].v === '#F7F6F3');
  th.setTheme('dark');
  check('다크 선택 → 즉시 적용·저장·브라우저 상단 색', document.documentElement.dataset.theme === 'dark' && store.get('mealnote:theme') === 'dark' && metas[0].v === '#181613' && document.documentElement.style.colorScheme === 'dark');
  storageFails = true;
  th.setTheme('light');
  check('저장할 수 없어도 이번 실행에서는 바뀐 테마 유지', document.documentElement.dataset.theme === 'light' && th.readTheme() === 'light');
  storageFails = false;
  storageListener({ key: 'mealnote:theme', newValue: 'dark' });
  check('다른 탭에서 바꾸면 이 탭도 따라감', document.documentElement.dataset.theme === 'dark');
  storageListener({ key: 'mealnote:text-size', newValue: 'large' });
  check('다른 설정의 변경은 테마에 영향 없음', document.documentElement.dataset.theme === 'dark');
}

// 2.0 이름(FITORY)·바탕색: brand.ts·theme.ts를 읽지 못하는 index.html과 설치 정보(vite.config.ts)가 같은 값을 적었는가
{
  const { APP_NAME } = await load('src/lib/brand.ts');
  const html = readFileSync('index.html', 'utf8');
  const vite = readFileSync('vite.config.ts', 'utf8');
  const css = readFileSync('src/styles.css', 'utf8');
  const theme = readFileSync('src/lib/theme.ts', 'utf8');
  check('앱 이름: 탭 제목·아이폰 홈 화면 이름·설치 이름이 brand.ts와 같음', html.includes(`<title>${APP_NAME}</title>`) && html.includes(`name="apple-mobile-web-app-title" content="${APP_NAME}"`) && vite.includes(`name: '${APP_NAME}'`) && vite.includes(`short_name: '${APP_NAME}'`), APP_NAME);
  const bg = (sel) => new RegExp(`${sel}\\{color-scheme:\\w+;\\s*--bg:(#[0-9A-F]{6})`).exec(css)?.[1];
  const [light, dark] = [bg(':root,:root\\[data-theme="light"\\]'), bg(':root\\[data-theme="dark"\\]')];
  check('바탕색: theme.ts·index.html·설치 정보가 styles.css --bg와 같음', !!light && !!dark && theme.includes(`light: '${light}', dark: '${dark}'`) && html.includes(`content="${light}"`) && html.includes(`'${dark}' : '${light}'`) && vite.includes(`theme_color: '${light}'`), JSON.stringify([light, dark]));
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

// v2.0 트레이너 루틴 시트 읽기(실제 시트 양식을 본뜬 가짜 표): 필수 동작 · 일차 블록 · 제목줄로 열 찾기 · 제목줄에 빠진 칸은 시트 순서 · 컨디션 줄 건너뛰기
{
  // 원본은 서버 기능과 같이 쓰는 _shared 파일(src/lib/routineSheet.ts는 다시 내보내기만 함)
  const { parseRoutineRows, parseRoutinePaste, pickTab, tabTitle } = await load('supabase/functions/_shared/routineSheet.ts');
  const rows = [
    [],
    ['', '본 운동 전 필수 동작'],
    ['', '1. 폼롤링', '2. 스트레칭 10 X 2SET'],
    [],
    ['', '1'],
    ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
    ['', '가짜 프레스', '3', '10/10', '14', '', '', '', '-'],
    ['', '가짜 로우', '4', '12', '12.5', '', '', '', '1.5'],
    ['', '', '', '컨디션'],
    ['', '', '', '운동한 날', '10/20'],
    ['', '2'],
    ['', '', 'SET', 'REPS', '', '', '', '', 'REST'],
    ['', '가짜 스쿼트', '3', '8', '70', '', '', '', '2'],
    ['', '가짜 플랭크', '셋', '30 S', '-'],
  ];
  const r = parseRoutineRows(rows);
  check('시트: 필수 동작 두 줄', r.warmup === '1. 폼롤링\n2. 스트레칭 10 X 2SET', JSON.stringify(r.warmup));
  check('시트: 일차별 운동 4개', r.items.length === 4 && r.items.filter((x) => x.day_no === 1).length === 2 && r.items.filter((x) => x.day_no === 2).length === 2, JSON.stringify(r.items));
  check('시트: 글자 섞인 중량·횟수는 그대로, 세트만 숫자', r.items[0].reps === '10/10' && r.items[1].weight === '12.5' && r.items[1].rest === '1.5' && r.items[0].rest === '' && r.items[0].sets === 3);
  check('시트: 제목줄에 중량 칸 이름이 없어도 REPS 다음 칸', r.items[2].weight === '70', r.items[2].weight);
  check('시트: 세트를 못 읽으면 비우고 알림', r.items[3].sets === null && r.items[3].weight === '' && r.problems.length === 1, JSON.stringify(r.problems));
  check('시트: 컨디션·운동한 날 줄은 운동이 아님', !r.items.some((x) => /컨디션|운동한/.test(x.name)));
  const p = parseRoutinePaste('1\n\tSET\tREPS\t중량\n레그 프레스\t2\t12\t60\n');
  check('붙여넣기(탭): 제목줄 있는 복사', p.items.length === 1 && p.items[0].name === '레그 프레스' && p.items[0].weight === '60' && p.items[0].sets === 2, JSON.stringify(p));
  const q = parseRoutinePaste('런지\t3\t10\t20');
  check('붙여넣기: 제목줄 없이 시트 순서(운동·SET·REPS·중량)', q.items[0].sets === 3 && q.items[0].reps === '10' && q.items[0].weight === '20', JSON.stringify(q));
  check('붙여넣기: 빈 글은 0개', parseRoutinePaste('  \n').items.length === 0);
  // 시트 자동 반영(서버 기능): 제목줄이 나온 뒤의 줄만 운동 — 메모만 있는 탭이 루틴이 되지 않게(2026-10-30 검증에서 발견)
  const rs = parseRoutineRows(rows, { sheet: true });
  check('시트 읽기: 제목줄이 있는 시트는 붙여넣기와 같은 결과', JSON.stringify(rs.items) === JSON.stringify(r.items) && rs.warmup === r.warmup);
  // 2.3: 회원마다 다른 시트 표기 — 제목줄 '세트수·회수·무게(kg)·쉬는시간', 루틴 구분 'Day 2'·'3일차'
  {
    const v = parseRoutineRows([['Day 2'], ['', '', '세트 수', '회수', '무게(kg)', '', '쉬는시간'], ['', '가짜 런지', '3', '10', '20', '', '1.5'], ['3일차'], ['', '', '세트수', '반복', 'Weight', '', '휴식시간'], ['', '가짜 로우', '4', '12', '30', '', '1']], { sheet: true });
    const [i1, i2] = v.items;
    check('표기 넓히기: 세트 수·회수·무게(kg)·쉬는시간 · Weight·반복·휴식시간 · Day 2·3일차를 읽음', v.items.length === 2 && i1.day_no === 2 && i1.sets === 3 && i1.reps === '10' && i1.weight === '20' && i1.rest === '1.5' && i2.day_no === 3 && i2.sets === 4 && i2.reps === '12' && i2.weight === '30' && i2.rest === '1', JSON.stringify(v));
    const notDay = parseRoutineRows([['', '1'], ['', '', 'SET', 'REPS', '중량'], ['', 'Day 2 메모', '3', '10', '20']], { sheet: true });
    check('표기 넓히기: 운동 이름에 든 Day·숫자는 루틴 구분으로 보지 않음', notDay.items.length === 1 && notDay.items[0].day_no === 1, JSON.stringify(notDay.items));
  }
  const memo = parseRoutineRows([['메모만 있는 탭'], ['다음 주에 바꿀 것']], { sheet: true });
  check('시트 읽기: 제목줄 없는 탭은 운동 0개·이유 안내', memo.items.length === 0 && memo.problems.some((x) => x.includes('제목줄')), JSON.stringify(memo));
  const before = parseRoutineRows([['', '1'], ['', '메모: 컨디션 보며'], ['', '', 'SET', 'REPS', '중량'], ['', '가짜 런지', '3', '10', '20']], { sheet: true });
  check('시트 읽기: 제목줄 앞의 메모 줄은 운동이 아님', before.items.length === 1 && before.items[0].name === '가짜 런지', JSON.stringify(before.items));
  check('기본 탭: 연월 4자리 탭 중 가장 최근, 없으면 첫 탭', pickTab(['메모', '2610', '2611', '2609']) === '2611' && pickTab(['루틴', '메모']) === '루틴' && pickTab([]) === '');
  check('탭 이름 → 루틴 제목', tabTitle('2611') === '26년 11월 루틴' && tabTitle('봄') === '봄 루틴');
}

// 운동 이름 → 부위(2026-10-30, 루틴을 '하체'·'등·가슴'처럼 부름). 실제 트레이너 시트의 이름(한글·헬스장 약어)을 대표로
{
  const { partsOf, routineFocus } = await load('src/lib/bodyParts.ts');
  const cases = [
    ['바벨ohp', '어깨'], ['시티드 사레레', '어깨'], ['페이스풀 (밑 에서 위로)', '어깨'], ['덤벨 라트익', '팔'], ['해머컬', '팔'],
    ['불스스', '하체'], ['회내 스플릿 스퀏', '하체'], ['케틀벨 굿모닝 (2s hold)', '하체'], ['루마니안 데드', '하체'],
    ['오버그립 케이블 로우', '등'], ['와이드 그립 랫풀다운', '등'], ['풀업', '등'], ['덤벨 슈러그', '등'],
    ['벤치프레스', '가슴'], ['덤벨 어퍼 플라이', '가슴'], ['푸쉬업', '가슴'], ['L-sit', '코어'], ['드래곤 플래그', '코어'], ['데드버그', '코어'],
    // 헷갈리기 쉬운 이름: 내로우(그립)의 로우·플랫의 랫·레그 익스텐션 뒤의 컬
    ['인클라인 덤벨프레스(내로우그립,fast)', '가슴'], ['플랫 덤벨 프레스', '가슴'], ['레그 익스텐션 + 컬', '하체'],
    // 묶음 운동은 각각
    ['스미스 ohp+사레레', '어깨'], ['인버티드로우+푸쉬업', '등,가슴'], ['데드버그+풀오버', '코어,등'],
    // 몸풀기는 세지 않음
    ['흉추 스트레칭', ''], ['밴드 str 스트레칭 3종', ''],
  ];
  const wrong = cases.filter(([n, want]) => partsOf(n).join(',') !== want).map(([n, want]) => `${n}: ${partsOf(n).join(',')} ≠ ${want}`);
  check(`운동 이름 → 부위 ${cases.length}건(시트 실제 이름·약어·헷갈리는 이름·묶음·몸풀기)`, wrong.length === 0, wrong.join(' | '));
  check('루틴 부위: 가장 많은 부위', routineFocus(['스미스 스퀏', '불스스', '레그 익스텐션+컬', '사이드 플랭크']) === '하체');
  check('루틴 부위: 두 번째가 절반 이상(2번 이상)이면 함께', routineFocus(['풀업', '팬들레이로우', '와이드 그립 랫풀다운', '벤치프레스', '푸쉬업']) === '등·가슴');
  check('루틴 부위: 두 번째가 1번뿐이면 하나만', routineFocus(['풀업', '팬들레이로우', '푸쉬업']) === '등');
  check('루틴 부위: 정하지 못하면 빈 글자', routineFocus(['흉추 스트레칭', '모르는 동작']) === '');
}

// 화면 흐름 검증의 '브라우저 오류' 가리기(Codex v2.0.2 1차 리뷰 P3): 기록한 실패 응답의 오류만, 기록 하나에 한 번 뺀다
{
  const { failureLedger } = await import(`${process.cwd()}/scripts/failure-ledger.mjs`);
  const S = 'http://127.0.0.1:5188/supabase';
  const res = (status, url) => `console: Failed to load resource: the server responded with a status of ${status} (${status === 500 ? 'Internal Server Error' : 'Bad Request'}) @ ${url}`;
  const body = (message) => `console: {message: ${message}} @ http://127.0.0.1:5188/@vite/client`;
  const list = `${S}/rest/v1/meals?select=id%2Cmember_id&order=eaten_on.desc`, one = `${S}/rest/v1/meals?id=eq.15b5468b`, save = `${S}/rest/v1/rpc/save_workout`;
  const split = (allows, errors) => { const l = failureLedger(); for (const a of allows) l.allow(a); return l.split(errors); };
  const patch = { method: 'PATCH', url: one, status: 500, why: '글만 고친 수정의 저장 실패', message: 'db down' };
  const lost = { method: 'POST', url: save, status: 500, why: '운동 기록 저장 응답 끊김', message: 'network lost' };
  let r = split([patch], [res(500, one), body('db down')]);
  check('오류 가리기: 기록한 실패 응답과 그 본문은 뺌(무엇을 뺐는지 남김)', r.real.length === 0 && r.excluded.length === 2 && r.excluded[0].why === patch.why, JSON.stringify(r.real));
  r = split([patch], [res(500, list)]);
  check('오류 가리기: 실패를 만들지 않은 식사 목록 GET의 500은 셈', r.real.length === 1, JSON.stringify(r.real));
  r = split([lost], [res(500, save), res(500, save)]);
  check('오류 가리기: 정상 저장 단계의 같은 save_workout 500(기록보다 많은 실패)은 셈', r.real.length === 1 && r.excluded.length === 1, JSON.stringify(r.real));
  r = split([lost], [res(500, `${S}/rest/v1/profiles?select=id`)]);
  check('오류 가리기: 다른 API(profiles)의 500은 셈', r.real.length === 1 && r.unused.length === 1);
  r = split([], [body('network lost')]);
  check('오류 가리기: 만든 실패와 연결되지 않은 {message: network lost}는 셈', r.real.length === 1);
  r = split([lost], [body('network lost'), body('network lost')]);
  check('오류 가리기: 만든 실패 하나의 본문은 한 번만 뺌', r.real.length === 1 && r.excluded.length === 1);
  r = split([{ method: 'POST', url: save, status: 400, why: '충돌' }], [res(500, save), 'pageerror: boom']);
  check('오류 가리기: 상태가 다른 실패와 화면 오류(pageerror)는 셈', r.real.length === 2);
}

// v2.1 시트의 회차 기록(사용자 피드백 11-02: 지난 기록 가져오기 · 앱 기록을 시트에 쓰기). 실제 시트 양식을 본뜬 가짜 탭(값은 지어냄)
{
  const { parseSheetLayout, parseSheetRecords, parseSheetDate, formatSheetDate, sheetCellFor, pickWriteColumn, routineDefinition, routineWeights, colName, parseRoutineRows } = await load('supabase/functions/_shared/routineSheet.ts');
  const tab = [
    ['', '본 운동 전 필수 동작'],
    ['', '1. 폼롤링'],
    ['', '1'],
    ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
    ['', '가짜 스쿼트', '3', '10', '60', '62.5', '60-', '', '2'],
    ['', '가짜 컬+익스', '3', '12+12', '10+8', '', '-', '', '1'],
    ['', '가짜 플랭크', '2', '1min', '-', '-', '', '', 'x'],
    ['', '', '', '컨디션', '중', '하'],
    ['', '', '', '운동한 날', '12/15', '12/23', '1/6', ''],
    ['', '2'],
    ['', '', 'SET', 'REPS', '', '', '', '', 'REST', ''],
    ['', '가짜 런지', '3', '12', '20', '', '', '', '1.5', '22'],
    ['', '', '', '운동한 날', '2025.12.19', '', '', '', '', '2026.01.14'],
    ['', '3'],
    ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
    ['', '가짜 로우', '3', '12', '35', '40', '', '', '1'],
    ['', '', '', '운동한 날', '13/45', ''],
  ];
  const L = parseSheetLayout(tab);
  check('시트 배치: 블록 3개 · 루틴 1의 회차 칸은 중량(E열)부터 REST 앞까지, 운동한 날 줄', L.length === 3 && L[0].weightCol === 4 && L[0].restCol === 8 && L[0].rows.length === 3 && L[0].dateRow === 8 && L[1].weightCol === 4, JSON.stringify(L.map((b) => [b.day_no, b.weightCol, b.restCol, b.rows.length, b.dateRow])));
  const R = parseSheetRecords(tab, '2512');
  const brief = R.sessions.map((s) => `${s.day_no}:${colName(s.col)}:${s.date}:${s.items.map((i) => `${i.name}=${i.weight}`).join('/')}`);
  check('회차 기록: 열마다 그 날짜의 운동(빈 칸은 안 한 것, \'-\'는 무게 없이 함), 12월 탭의 1/6은 다음 해, REST 뒤 열도 날짜가 있으면', JSON.stringify(brief) === JSON.stringify([
    '1:E:2025-12-15:가짜 스쿼트=60/가짜 컬+익스=10+8/가짜 플랭크=',
    '1:F:2025-12-23:가짜 스쿼트=62.5/가짜 플랭크=',
    '1:G:2026-01-06:가짜 스쿼트=60-/가짜 컬+익스=',
    '2:E:2025-12-19:가짜 런지=20',
    '2:J:2026-01-14:가짜 런지=22',
  ]), JSON.stringify(brief));
  check('회차 기록: 계획 세트·횟수를 함께(세트 수는 계획 기준)', R.sessions[0].items[1].sets === 3 && R.sessions[0].items[1].reps === '12+12');
  check('회차 기록: 날짜를 못 읽은 열·날짜가 빈 열은 가져오지 않고 알림', R.problems.length === 2 && R.problems.some((p) => p.includes("'13/45'")) && R.problems.some((p) => p.includes('F열') && p.includes('비어')), JSON.stringify(R.problems));
  const D = (t, tb) => JSON.stringify(parseSheetDate(t, tb));
  check('날짜: 10.20 · 1/6(연말 넘김) · 연도 있는 날 · 먼 연도는 고쳐 읽음 · 없는 날 · 탭 달 모름', D('10.20', '2510') === JSON.stringify({ date: '2025-10-20', fixed: false }) && D('1/6', '2512/back/up') === JSON.stringify({ date: '2026-01-06', fixed: false }) && D('2026.06.22', '2606') === JSON.stringify({ date: '2026-06-22', fixed: false }) && D('2025.07.10', '2606의 사본') === JSON.stringify({ date: '2026-07-10', fixed: true }) && D('2/30', '2602') === 'null' && D('11/20', '메모') === 'null');
  check('날짜 쓰기: 탭에 적힌 표기를 따름(10/20 → 11/5 · 10.20 → 11.05 · 2026.06.22 → 2026.11.05 · 없으면 11/5)', formatSheetDate('2026-11-05', ['', '10/20']) === '11/5' && formatSheetDate('2026-11-05', ['10.20']) === '11.05' && formatSheetDate('2026-11-05', ['2026.06.22']) === '2026.11.05' && formatSheetDate('2026-11-05', []) === '11/5');
  // 세트마다 무게가 다르면 가장 높은 무게 하나(2026-11-02 사용자 결정 — 11/2 벤치 프레스 30·35 → 35)
  const cell = (list) => sheetCellFor(list.map(([kg, done = true]) => ({ kg, done })));
  // 기호가 든 무게(두 동작의 무게)는 둘 다, 동작마다 높은 쪽(사용자 11-02 — '20+5'·'18+8' → '20+8')
  check('칸 값: 완료 세트 가운데 가장 높은 무게(30·35 → 35, 완료 안 한 25는 뺌) · 기호 무게는 두 무게 다, 동작마다 높은 쪽(20+5·18+8 → 20+8 · 35+8·35+10 → 35+10) · 모양이 다르면 앞 숫자부터(60-·62.5 → 62.5) · 무게 없는 세트는 견주지 않음 · 무게 없이 하면 - · 완료 없으면 안 씀',
    cell([['30'], ['35'], ['35']]) === '35' && cell([['17.5'], ['20'], ['25', false]]) === '20' && cell([['20+5'], ['18+8']]) === '20+8' && cell([['35+8'], ['35+10']]) === '35+10' && cell([['10+8'], ['10+8']]) === '10+8' && cell([['12.5/10'], ['12/12']]) === '12.5/12' && cell([['60-'], ['62.5']]) === '62.5' && cell([[null], ['40']]) === '40' && cell([[null]]) === '-' && cell([['60', false]]) === '',
    JSON.stringify([cell([['30'], ['35']]), cell([['20+5'], ['18+8']]), cell([['35+8'], ['35+10']]), cell([['12.5/10'], ['12/12']]), cell([['60-'], ['62.5']])]));
  // 적대 검토(11-03) F13: 같은 이름의 운동이 블록에 둘이면(준비 세트·본 세트) 세트를 루틴 항목으로 가른다 — 시트 쓰기와 '시트용으로 복사'가 같이 쓰는 규칙
  const { blockCellValues } = await load('supabase/functions/_shared/routineSheet.ts');
  const bv = blockCellValues?.([{ id: 'i1', name: '가짜 스쿼트' }, { id: 'i2', name: '가짜 스쿼트' }, { id: 'i3', name: '가짜 로우' }], [
    { item_id: 'i1', name: '가짜 스쿼트', kg: '40', done: true }, { item_id: 'i2', name: '가짜 스쿼트', kg: '80', done: true }, { item_id: null, name: '가짜 로우', kg: '30', done: true },
  ]);
  check('블록 칸 값: 같은 이름 두 줄은 루틴 항목별(40·80), 한 줄뿐이면 이름으로(로우 30)', JSON.stringify(bv) === '["40","80","30"]', JSON.stringify(bv));
  check('쓸 열: 같은 날짜 열 → 없으면 날짜·운동 칸이 모두 빈 첫 열(REST 앞까지) → 없으면 -1', pickWriteColumn(tab, L[0], '2025-12-23', '2512') === 5 && pickWriteColumn(tab, L[0], '2026-01-08', '2512') === 7 && pickWriteColumn(tab, L[1], '2026-01-10', '2512') === 5 && pickWriteColumn(tab.map((r, i) => (i === 8 ? [...r.slice(0, 7), '1/9'] : r)), L[0], '2026-01-10', '2512') === -1);
  const base = parseRoutineRows(tab, { sheet: true });
  const heavier = parseRoutineRows(tab.map((r, i) => (i === 4 ? r.map((c, j) => (j === 4 ? '65' : c)) : r)), { sheet: true });
  const moreSets = parseRoutineRows(tab.map((r, i) => (i === 4 ? r.map((c, j) => (j === 2 ? '4' : c)) : r)), { sheet: true });
  check('루틴 구성: 첫 회차 중량만 바뀌면 구성은 같고 중량만 다름 · 세트가 바뀌면 구성이 다름', routineDefinition('2512', base) === routineDefinition('2512', heavier) && routineWeights(base) !== routineWeights(heavier) && routineDefinition('2512', base) !== routineDefinition('2512', moreSets));
  check('열 이름: A · Z · AA', colName(0) === 'A' && colName(25) === 'Z' && colName(26) === 'AA');
  // 적대 검토(11-02): 사본 탭이 같은 회차를 한 번 더 가져옴 · 탭의 달과 먼 날짜·미래 날짜가 연도 추측으로 들어옴
  const { pickMonthTabs } = await load('supabase/functions/_shared/routineSheet.ts');
  const picked = pickMonthTabs?.(['2610의 사본', '2610', '2609', '2512/back/up', '2606의 사본', '메모', '2699']);
  check('가져올 탭: 연월마다 하나, 같은 달 정식 탭이 있으면 사본은 뺌, 그 달 탭이 하나뿐이면 그것', JSON.stringify(picked) === JSON.stringify(['2610', '2609', '2512/back/up', '2606의 사본']), JSON.stringify(picked));
  const far = parseSheetRecords([['', '1'], ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'], ['', '가짜 스쿼트', '3', '10', '60', '61', '62', '', '2'], ['', '', '', '운동한 날', '3/5', '2026.03.05', '11/5']], '2610', '2026-11-02');
  check('먼 날짜(3/5·2026.03.05)와 오늘 뒤 날짜(11/5)는 가져오지 않고 알림', far.sessions.length === 0 && far.problems.length === 3, JSON.stringify(far));
}

// Codex v2.1.0 3차 리뷰 P2: 숫자는 시트가 보이는 꼴로 써 두고(40.0 → 40), 앱이 쓴 칸인지는 값으로 견준다(칸 형식이 40.0을 보여도 같은 값). 기호 무게는 글자 그대로
{
  const { canonCell, sameCell, sheetCellFor } = await load('supabase/functions/_shared/routineSheet.ts');
  check('숫자 표기 맞춤: 40.0→40 · 040→40 · 12.50→12.5 · 40→40 · 기호 무게(20+5·14,16·60-)는 그대로', ['40.0', '040', '12.50', '40', '20+5', '14,16', '60-'].map(canonCell).join('|') === '40|40|12.5|40|20+5|14,16|60-', ['40.0', '040', '12.50', '40', '20+5', '14,16', '60-'].map(canonCell).join('|'));
  check('시트에 쓸 값도 같은 꼴(완료 세트 40.0 → 40, 12.50 → 12.5)', sheetCellFor([{ kg: '40.0', done: true }]) === '40' && sheetCellFor([{ kg: '12.50', done: true }, { kg: '10', done: true }]) === '12.5' && sheetCellFor([{ kg: '20+5', done: true }]) === '20+5');
  check('앱이 쓴 칸 비교: 40.0과 40은 같음(숫자) · 20+5와 25는 다름 · 14,16과 14.16은 다름 · 빈 칸은 숫자와 다름', sameCell('40.0', '40') && sameCell('40', '040') && !sameCell('20+5', '25') && !sameCell('14,16', '14.16') && !sameCell('', '0') && sameCell('20+5', '20+5'));
  // 적대 검토(3차 뒤): 시트를 읽을 때 공백을 하나로 줄이므로(sheet-write clean) 적어 둘 값도 같게 — '20 +  5'를 쓰고 '20 + 5'로 읽어도 앱이 쓴 칸
  check('기호 무게의 공백: 적어 둘 값은 공백 하나로(20 +  5 → 20 + 5) · 공백만 다른 값은 같은 칸', canonCell('20 +  5') === '20 + 5' && canonCell(' 40 ') === '40' && sameCell('20 +  5', '20 + 5') && sheetCellFor([{ kg: '20 +  5', done: true }]) === '20 + 5');
}

// v2.1 쉬는 시간(사용자 피드백 11-02): 시트 REST 칸(분 단위·범위·없음 표시) → 화면 글자·타이머 초
{
  const { restLabel, restSeconds } = await load('src/lib/restTime.ts');
  const cases = [
    ['1.5', '1분 30초', 90], ['1', '1분', 60], ['0.5', '30초', 30], ['2', '2분', 120],
    ['1.5~2', '1분 30초～2분', 90], ['1.5～2', '1분 30초～2분', 90],
    ['x', '', null], ['-', '', null], ['', '', null],
    ['30초', '30초', 30], ['45s', '45초', 45], ['1분', '1분', 60],
    ['자유롭게', '자유롭게', null],
    // Codex 4차 리뷰 P2: 단위를 끝에만 쓴 범위는 그 단위를 앞에도(30~60초는 30분이 아니라 30초)
    ['30~60초', '30초～1분', 30], ['30～60s', '30초～1분', 30], ['30초~1분', '30초～1분', 30], ['1~2분', '1분～2분', 60], ['1.5~2', '1분 30초～2분', 90],
  ];
  for (const [t, label, sec] of cases) check(`쉬는 시간 '${t}' → '${label}' · ${sec}초`, restLabel(t) === label && restSeconds(t) === sec, `${restLabel(t)} · ${restSeconds(t)}`);
}

// v2.1 운동 탭(2026-11-03 사용자 확정 시안): 최근 5주 달력 · 기록 카드의 가장 무거운 세트·최고 기록 · 루틴 바뀐 점 · 새 루틴 한 바퀴
// 회원 목록 이름순(2.3): 첫 글자의 초성 칸. 된소리는 예사소리 칸, 한글이 아니면 기타
{
  {
    const { memberWorkoutLine, sessionBrief, sessionDetail, sessionWhen, isUnseen, markWorkouts, parseSeen, newStamp } = await bundle('src/lib/workoutBrief.ts');
    const set = (name, kg, reps, done = true) => ({ item_id: null, name, set_no: 1, kg, reps, done, ord: 1 });
    const ses = (day, day_no, sets, cardio = [], extra = {}) => ({ id: day, member_id: 'm', routine_id: null, day_no, day, started_at: `${day}T07:40:00+09:00`, updated_at: `${day}T08:30:00+09:00`, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets, cardio, ...extra });
    const legs = ses('2026-11-05', 2, [set('랫풀다운', '50', '10'), set('랫풀다운', '55', '8', false)]);
    const run = ses('2026-11-04', null, [], [{ kind: 'run', minutes: 30, km: 5, speed: null, ord: 1 }]);
    check('2.3 운동 줄: 오늘 한 기록은 완료 세트 수까지', memberWorkoutLine([legs], '2026-11-05').text.startsWith('오늘 루틴 2') && memberWorkoutLine([legs], '2026-11-05').text.endsWith('완료 1/2세트'), memberWorkoutLine([legs], '2026-11-05').text);
    check('2.3 운동 줄: 최근 기록은 날짜와 며칠 전 · 어제 · 2주 안에 없으면 없음', memberWorkoutLine([legs], '2026-11-08').text.includes('(3일 전)') && memberWorkoutLine([legs], '2026-11-06').text.includes('(어제)') && memberWorkoutLine([], '2026-11-05').kind === 'none');
    check('2.3 운동 줄: 시작만 하고 아무것도 안 한 기록은 세지 않음', memberWorkoutLine([ses('2026-11-05', 1, [set('스쿼트', '70', '5', false)])], '2026-11-05').kind === 'none');
    check('2.3 유산소만 한 기록: 종류·시간·거리', sessionBrief(run) === '유산소 · 러닝 30분 · 5km', sessionBrief(run));
    check('2.3 새 기록 문장: 첫 운동의 가장 무거운 세트까지', sessionDetail(legs).includes('랫풀다운 50'), sessionDetail(legs));
    const sheet = { ...legs, source: 'sheet', started_at: '2026-11-05T01:00:00Z', updated_at: '2026-11-06T01:00:00Z' };
    check('2.3 시트 기록은 시각을 보이지 않고, 자동 반영으로 수정 시각만 바뀌어도 새 기록이 되지 않음', sessionWhen(sheet, '2026-11-05') === '오늘' && !isUnseen(sheet, { base: '2026-11-05T12:00:00Z', marks: {} }) && isUnseen(legs, { base: '2026-11-04T12:00:00Z', marks: {} }));
    // v2.3.0 4차 리뷰: 본 처리는 받은 기록·그 판에만 적용한다
    const base = '2026-11-01T00:00:00.000Z';
    const at = (id, updated) => ({ ...legs, id, updated_at: updated });
    const seen = markWorkouts({ base, marks: {} }, [at('b', '2026-11-05T02:00:00Z')]);
    check('본 처리: 받은 기록만 적고 기준 시각은 그대로', seen.base === base && Object.keys(seen.marks).join() === 'b' && !isUnseen(at('b', '2026-11-05T02:00:00Z'), seen), JSON.stringify(seen));
    check('본 처리: 받지 못한 기록은 시각이 더 일러도 새 기록', isUnseen(at('a', '2026-11-05T01:00:00Z'), seen));
    check('본 처리: 같은 기록의 새 판은 다시 새 기록 · 옛 판이 늦게 와도 새 기록이 아님', isUnseen(at('b', '2026-11-05T03:00:00Z'), seen) && !isUnseen(at('b', '2026-11-05T01:00:00Z'), seen));
    check('본 처리: 기준 시각보다 오래된 기록은 새 기록이 아님', !isUnseen(at('c', '2026-10-31T00:00:00Z'), seen));
    const sheetSeen = markWorkouts({ base, marks: {} }, [sheet]);
    check('본 처리: 시트 기록은 자동 반영으로 수정 시각만 바뀌어도 다시 뜨지 않음', !isUnseen({ ...sheet, updated_at: '2026-11-07T01:00:00Z' }, sheetSeen) && sheetSeen.marks[sheet.id] === newStamp(sheet));
    const old = markWorkouts({ base, marks: { gone: '2026-10-15T00:00:00.000Z', kept: '2026-10-25T00:00:00.000Z' } }, [at('b', '2026-11-05T02:00:00Z')]);
    check('본 처리: 살피는 기간 밖으로 나간 표시는 지움(기기 시각이 아니라 기록의 시각으로)', Object.keys(old.marks).sort().join() === 'b,kept', JSON.stringify(old.marks));
    check('본 처리: 기기에 적힌 값 읽기 — 새 형식 · 시각 하나', parseSeen(JSON.stringify(seen)).marks.b === seen.marks.b && parseSeen(base).base === base && parseSeen('2026-11-01T09:00:00+09:00').base === base);
    const broken = parseSeen(JSON.stringify({ base, marks: { ok: base, bad: 'zzz', num: 1 } }));
    check('본 처리: 읽지 못하는 값은 버림(비교가 전부 거짓이면 목록이 말없이 빔)', parseSeen('{"base":1}') === null && parseSeen('garbage') === null && parseSeen('{"base":"zzz","marks":{}}') === null && Object.keys(broken.marks).join() === 'ok', JSON.stringify(broken));
  }
  {
    const { periodCalendar, scoreWeeks, routineCounts, liftChanges, fastingLine, dayTone } = await bundle('src/lib/periodReport.ts');
    const { bodySentence } = await load('src/lib/report.ts');
    const set = (name, kg, reps = '5', done = true) => ({ item_id: null, name, set_no: 1, kg, reps, done, ord: 1 });
    const ses = (day, day_no, sets, cardio = []) => ({ id: day + day_no, member_id: 'm', routine_id: null, day_no, day, started_at: `${day}T01:00:00Z`, updated_at: `${day}T01:00:00Z`, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets, cardio });
    const run = { kind: 'run', minutes: 30, km: 5, speed: null, ord: 1 };
    check('2.3 보고서 날 색: 평균이 가까운 평가 · 평가가 없으면 평가 전', [{ rated: 2, score_sum: 10 }, { rated: 2, score_sum: 6 }, { rated: 1, score_sum: 1 }, { rated: 0, score_sum: 0 }].map(dayTone).join('|') === 'great|good|care|wait');
    const cells = periodCalendar('2026-10-30', '2026-11-03', [{ day: '2026-11-02', meals: 2, rated: 1, score_sum: 5 }, { day: '2026-11-09', meals: 1, rated: 1, score_sum: 5 }], [ses('2026-11-02', 1, [set('스쿼트', '70')]), ses('2026-11-03', null, [], [run]), ses('2026-10-31', 2, [set('스쿼트', '70', '5', false)])]);
    const at = (d) => cells.find((c) => c.day === d);
    check('2.3 보고서 달력: 일요일부터 토요일까지 온전한 주 · 기간 밖은 표시 없음 · 1일은 달까지', cells.length === 14 && cells[0].day === '2026-10-25' && !cells[0].inside && at('2026-11-01').label === '11/1' && at('2026-11-02').tone === 'great', JSON.stringify(cells.slice(0, 2)));
    check('2.3 보고서 달력: 근력 운동 · 유산소만 · 끝내지 않은 세트뿐인 기록은 운동이 아님', at('2026-11-02').work === 'routine' && at('2026-11-03').work === 'cardio' && at('2026-10-31').work === null);
    const weeks = scoreWeeks('2026-11-01', '2026-11-15', [{ day: '2026-11-02', meals: 2, rated: 2, score_sum: 8 }, { day: '2026-11-07', meals: 1, rated: 1, score_sum: 5 }, { day: '2026-11-15', meals: 1, rated: 0, score_sum: 0 }]);
    check('2.3 식단 흐름: 7일씩 끼니 가중 평균 · 마지막 부분 주 · 평가 없는 구간은 점수 없음', weeks.length === 3 && weeks[0].label === '1주' && weeks[0].text === '4.3' && weeks[1].score === null && weeks[2].text === '–', JSON.stringify(weeks));
    const long = scoreWeeks('2026-01-01', '2026-06-30', []);
    check('2.3 식단 흐름: 긴 기간은 막대 여덟 개 안에서 날짜 이름으로', long.length <= 8 && long[0].label === '1/1', JSON.stringify(long.map((x) => x.label)));
    const list = [ses('2026-11-05', 1, [set('스쿼트', '75'), set('랫풀다운', '40'), set('런지', '20+5')]), ses('2026-11-03', 2, [set('랫풀다운', '45')]), ses('2026-11-01', 1, [set('스쿼트', '60'), set('스쿼트', '70'), set('스쿼트', '100', '5', false), set('런지', '20')]), ses('2026-11-02', null, [], [run]), ses('2026-11-04', null, [set('플랭크', null)])];
    check('2.3 운동 횟수: 루틴별 · 그 밖의 운동 · 유산소', routineCounts(list).map((x) => `${x.label}:${x.count}`).join('|') === '루틴 1:2|루틴 2:1|그 밖의 운동:1|유산소:1', JSON.stringify(routineCounts(list)));
    const ch = liftChanges(list);
    check('2.3 운동 변화: 처음과 끝의 가장 무거운 완료 세트 · 숫자 무게만 · 한 번 한 운동·기호 무게는 빠짐 · 많이 오른 순서', ch.map((x) => `${x.name} ${x.first}→${x.last}`).join('|') === '스쿼트 70→75|랫풀다운 45→40', JSON.stringify(ch));
    const w = (kg) => ({ day: '2026-11-01', kg });
    check('2.3 공복 체중 줄: 다섯 번까지 다 · 많으면 처음과 끝 · 없으면 없음', fastingLine([w(73.5), w(72)]) === '공복 체중 2번: 73.5 → 72.0kg' && fastingLine([70, 71, 72, 73, 74, 75].map(w)) === '공복 체중 6번: 70.0 → 75.0kg' && fastingLine([]) === null);
    check('2.3 체성분 한 줄: 내린 것·는 것을 묶음 · 기록 없는 값은 말하지 않음', bodySentence({ weight: -1.7, smm: 0.4, pbf: -1.3 }) === '체중·체지방률이 내려가고 골격근량이 늘었어요' && bodySentence({ weight: 0, smm: null, pbf: null }) === '체성분은 그대로예요' && bodySentence({ weight: 1, smm: null, pbf: 0 }) === '체중이 늘었어요');
  }
  {
    const { parseRoutineRows, parseSheetLayout } = await load('supabase/functions/_shared/routineSheet.ts');
    const rows = [['1'], ['운동', 'SET', 'REPS', '중량', 'REST', '날짜'], ['가짜 스쿼트', '3', '10', '40', '2', ''], ['가짜 로우', '3', '12', '30', '1', ''], ['날짜', '', '', '11/3']];
    const first = [['1'], ['날짜', '운동', '세트', '횟수', '무게'], ['', '가짜 스쿼트', '3', '10', '40']];
    const a = parseRoutineRows(rows, { sheet: true }), b = parseRoutineRows(first, { sheet: true });
    check("2.3 시트: 제목줄에 '날짜' 칸이 있어도 제목줄로 읽음 · 제목 없는 '날짜' 줄은 날짜 줄", a.items.length === 2 && b.items.length === 1 && parseSheetLayout(rows)[0]?.dateRow === 4, JSON.stringify([a.items.length, b.items.length, parseSheetLayout(rows)[0]?.dateRow]));
    const { memberWorkoutLine: lineOf } = await bundle('src/lib/workoutBrief.ts');
    const ses = (day) => ({ id: day, member_id: 'm', routine_id: null, day_no: 1, day, started_at: `${day}T01:00:00Z`, updated_at: `${day}T01:00:00Z`, finished: true, source: 'sheet', sheet_tab: '', sheet_col: null, sets: [{ item_id: null, name: '스쿼트', set_no: 1, kg: '70', reps: '5', done: true, ord: 1 }], cardio: [] });
    check("2.3 운동 줄: 시트 날짜 오기로 오늘 뒤의 기록이 있어도 '-1일 전'이 나오지 않음", lineOf([ses('2026-11-09'), ses('2026-11-03')], '2026-11-05').text.includes('(2일 전)'), lineOf([ses('2026-11-09'), ses('2026-11-03')], '2026-11-05').text);
  }
  const { choseongOf } = await bundle('src/lib/memberOrder.ts');
  check('초성 칸: 김→ㄱ · 꽃→ㄱ · 하→ㅎ · 앞 공백 무시 · 영문·숫자는 기타', ['김하늘', '꽃님', '하늘', ' 나윤서', 'MJ', '7번'].map(choseongOf).join('|') === 'ㄱ|ㄱ|ㅎ|ㄴ|기타|기타');
}
// 꾸준함 숫자와 기록 카드의 비교 값(그 앞의 모든 기록)은 서버(workout_overview·workout_compare)가 센다 — 서버 규칙은 권한 검증(backend-check)에서 본다
{
  process.env.TZ = 'Asia/Seoul'; // 앱은 한국 기기에서 돈다 — 판 받은 날(versionDay)은 기기 시각의 날짜
  const { recentCalendar, calendarRows, bestRows, routineDiff, routineCycle, lastDoneDay, localProgress, progressOf, versionDay, weekStart } = await bundle('src/lib/workoutStats.ts');
  const set = (name, kg, reps, done = true) => ({ item_id: null, name, set_no: 1, kg, reps, done, ord: 1 });
  const ses = (id, day, day_no, sets, cardio = [], routine_id = 'r-new') => ({ id, member_id: 'm', routine_id, day_no, day, started_at: `${day}T01:00:00Z`, updated_at: `${day}T01:00:00Z`, finished: true, source: 'app', sheet_tab: '', sheet_col: null, sets, cardio });
  const today = '2026-11-03'; // 화요일 — 이번 주는 11-01(일)부터
  const list = [
    ses('s1', '2026-11-02', 1, [set('스쿼트', '70', '8'), set('스쿼트', '65', '10')]),
    ses('s4', '2026-11-01', null, [], [{ kind: 'walk', minutes: 40, km: 3.2, speed: null }], null),
    ses('s2', '2026-10-30', 1, [set('스쿼트', '65', '10')]),
    ses('s3', '2026-10-27', 2, [set('랫풀다운', '50', '12')]),
    ses('s5', '2026-10-20', 1, [set('스쿼트', '60', '10', false)]), // 완료 세트가 없으면 운동한 날이 아니다
  ];
  check('주의 시작은 일요일', weekStart('2026-11-03') === '2026-11-01' && weekStart('2026-11-01') === '2026-11-01' && weekStart('2026-10-31') === '2026-10-25');
  const cells = recentCalendar(calendarRows(list), today);
  const at = (d) => cells.find((x) => x.day === d);
  check('달력: 5주 35칸 · 일요일부터 · 루틴 날은 번호, 유산소만 한 날은 유산소 · 완료 세트 없는 날은 빈 칸 · 오늘·앞날 표시', cells.length === 35 && cells[0].day === '2026-10-04' && at('2026-11-02').label === '루틴1' && at('2026-11-02').kind === 'routine' && at('2026-11-01').kind === 'cardio' && at('2026-10-20').kind === null && at(today).today && at('2026-11-04').future, JSON.stringify([at('2026-11-02'), at('2026-11-01'), at('2026-10-20')]));
  // 기록 카드: 비교 값은 서버가 준 그 앞의 모든 기록 기준(prior = 무게 단 세트의 가장 무거운 무게, prev = 지난번 가장 무거운 세트)
  const r1 = bestRows(list[0], { 스쿼트: { prior: [65], prev: '65' } });
  check('기록 카드: 가장 무거운 세트(70kg × 8) · 그 앞의 모든 기록보다 무거우면 최고 기록', r1.length === 1 && r1[0].best === '70kg × 8' && r1[0].record && r1[0].up === null, JSON.stringify(r1));
  check('그 앞에 무게를 단 기록이 없으면(첫 기록) 최고 기록 아님', !bestRows(list[2], { 스쿼트: { prior: null, prev: null } })[0].record);
  check('30개 밖 100kg이 prior면 50kg은 최고가 아니고, 같은 날 먼저 한 40kg이 지난번이면 ↑10(Codex 3차 리뷰 P2·P3)', (() => { const r = bestRows(ses('pm', '2026-11-30', 1, [set('스쿼트', '50', '8')]), { 스쿼트: { prior: [100], prev: '40' } })[0]; return !r.record && r.up === 10; })());
  const tie = bestRows(ses('t', '2026-11-03', 1, [set('스쿼트', '70', '6')]), { 스쿼트: { prior: [70], prev: '70' } });
  check('같은 무게는 최고 기록이 아님 · 지난번과 같으면 오름 표시 없음', !tie[0].record && tie[0].up === null, JSON.stringify(tie));
  const up = bestRows(ses('u', '2026-11-03', 1, [set('스쿼트', '67.5', '8')]), { 스쿼트: { prior: [80], prev: '65' } });
  check('최고 기록은 아니어도 지난번보다 무거우면 오른 무게(↑2.5)', !up[0].record && up[0].up === 2.5, JSON.stringify(up));
  const sym = bestRows(ses('y', '2026-11-03', 1, [set('덤벨컬+해머컬', '10+8', '8+8')]), { '덤벨컬+해머컬': { prior: [8, 8], prev: '8+8' } });
  check('기호 무게(10+8)도 숫자 묶음 비교로 최고 기록을 가림 · 오른 무게(↑)는 숫자 무게끼리만', sym[0].best === '10+8kg × 8+8' && sym[0].record && sym[0].up === null, JSON.stringify(sym));
  check('비교 값을 받지 못하면(null) 최고·오름 표시 없음', (() => { const r = bestRows(list[0], null)[0]; return !r.record && r.up === null; })());
  check('맨몸 기록만 있던 운동의 첫 무게는 최고 표시 없음(prior 없음)', !bestRows(ses('w', '2026-11-03', 1, [set('딥스', '5', '8')]), { 딥스: { prior: null, prev: null } })[0].record);
  let ordN = 0;
  const item = (day_no, name, weight, reps = '10', sets = 3) => ({ id: `${day_no}-${name}-${++ordN}`, ord: ordN, day_no, name, weight, reps, sets, rest: '', note: '' });
  const rt = (id, items, created_at = '2026-10-25T01:00:00Z') => ({ id, member_id: 'm', version: 1, title: id, goal: '', reason: '', warmup: '', source: 'sheet', source_ref: '', created_at, items });
  const prev = rt('r-old', [item(1, '스쿼트', '65'), item(1, '레그 익스텐션', '30'), item(2, '랫풀다운', '50')]);
  const cur = rt('r-new', [item(1, '스쿼트', '70'), item(1, '런지', '20', '12'), item(2, '랫풀다운', '50'), item(2, '시티드 로우', '40')]);
  const d = routineDiff(cur, prev);
  check('루틴 바뀐 점: 루틴 순서 → 빠짐 · 새로 · 목표 바뀜, 같은 이름·같은 루틴이면 같은 운동', new Set(d.map((x) => x.key)).size === d.length && JSON.stringify(d.map((x) => [x.day_no, x.kind, x.name, x.detail])) === JSON.stringify([[1, 'del', '레그 익스텐션', '지난 루틴 30kg · 10회 · 3세트'], [1, 'add', '런지', '목표 20kg · 12회 · 3세트'], [1, 'chg', '스쿼트', '65kg → 70kg'], [2, 'add', '시티드 로우', '목표 40kg · 10회 · 3세트']]), JSON.stringify(d));
  const P = (sessions, r = cur) => localProgress(r, sessions);
  const cy = routineCycle(cur, P(list));
  check('새 루틴 한 바퀴: 지금 판으로 한 루틴만 셈(옛 판·완료 세트 없는 기록은 빼고)', JSON.stringify([...cy.done]) === '[1,2]' && cy.complete, JSON.stringify([...cy.done]));
  const half = routineCycle(cur, P([list[0]]));
  check('루틴 1만 했으면 한 바퀴 전', !half.complete && JSON.stringify([...half.done]) === '[1]');
  // 적대 검토(2026-11-03) 1: 시트에서 가져온 지난 기록은 그 탭의 최신 판을 가리킨다 — 판을 받기 전 날짜의 기록은 이 판으로 한 것으로 세지 않는다
  const fresh = { ...cur, created_at: '2026-11-01T01:00:00Z' };
  const asSheet = (x) => ({ ...x, source: 'sheet' });
  const sheetList = list.map((x) => (x.id === 's2' || x.id === 's3' ? asSheet(x) : x)); // 10/30·10/27 회차를 시트에서 다시 가져와 새 판을 가리킴
  const fp = P(sheetList, fresh);
  check('시트에서 다시 가져온 판 이전 회차는 한 바퀴에 안 셈 · 마지막 한 날도 같은 기준', JSON.stringify([...routineCycle(fresh, fp).done]) === '[1]' && !routineCycle(fresh, fp).complete && lastDoneDay(fp, 2) === null && lastDoneDay(fp, 1) === '2026-11-02');
  // 남은 적대 검토(11-03): 앱 기록은 저장 때 고른 판을 믿고(판 받기 전 날짜로 적은 기록도), 시트 회차는 판을 받은 다음 날부터
  const appBefore = ses('ab', '2026-10-31', 2, [set('랫풀다운', '50', '12')]);
  const sheetSameDay = asSheet(ses('sd', '2026-11-01', 2, [set('랫풀다운', '50', '12')]));
  const sheetNext = asSheet(ses('sn', '2026-11-02', 2, [set('랫풀다운', '50', '12')]));
  check('앱 기록은 판을 고른 그대로(판 받기 전 날짜도 셈) · 판을 받은 날의 시트 회차는 안 셈 · 다음 날 시트 회차는 셈',
    lastDoneDay(P([appBefore], fresh), 2) === '2026-10-31' && lastDoneDay(P([sheetSameDay], fresh), 2) === null && lastDoneDay(P([sheetNext], fresh), 2) === '2026-11-02');
  // 5: 판 받은 날은 기기(한국) 날짜 — UTC로 자르면 오전 9시 전 판이 전날로 보인다
  check('판 받은 날: 11/3 08:30(한국) 판은 11월 3일', versionDay({ created_at: '2026-11-02T23:30:00Z' }) === '2026-11-03', versionDay({ created_at: '2026-11-02T23:30:00Z' }));
  // 4: 완료 세트가 없는 기록은 진행에 세지 않는다
  const empty2 = ses('e2', '2026-11-03', 2, [set('랫풀다운', '50', '12', false)]);
  check('완료 세트 없이 저장한 루틴 2는 마지막 한 날에 안 셈', lastDoneDay(P([empty2, list[0]]), 2) === null);
  // Codex 3차 리뷰 P2: 서버 요약이 이 판의 진행을 주면 최근 목록 밖 기록까지 쓴다 — 다른 판의 것이면 받아 둔 기록으로
  // Codex v2.2.0 2차 리뷰 P2-1: 받아 둔 기록은 그 기간 안에서 정본 — 요약은 목록이 한도로 잘렸을 때 목록의 가장 오래된 날까지만 보탠다
  const ov = { routine: { id: 'r-new', last: { 1: '2026-09-01', 2: '2026-09-02' }, latest_day_no: 2 } };
  const srv = progressOf(cur, [list[0]], ov, true);
  check('잘린 목록: 목록 밖 루틴 2(9월 2일)는 요약에서, 목록 안 루틴 1은 받아 둔 기록(11월 2일) — 한 바퀴 완료 · 다른 판의 요약이면 받아 둔 기록만', routineCycle(cur, srv).complete && lastDoneDay(srv, 1) === '2026-11-02' && lastDoneDay(srv, 2) === '2026-09-02' && !routineCycle(cur, progressOf(cur, [list[0]], { routine: { ...ov.routine, id: 'other' } }, true)).complete, JSON.stringify(srv));
  check('잘리지 않은 목록은 그것이 전부 — 요약을 보태지 않음(한 바퀴 미완료)', !routineCycle(cur, progressOf(cur, [list[0]], ov, false)).complete);
  const b1 = ses('b1', '2026-11-01', 1, [set('스쿼트', '70', '8')]);
  const staleOv = { routine: { id: 'r-new', last: { 1: '2026-11-01', 2: '2026-11-02' }, latest_day_no: 2 } };
  const del = progressOf(cur, [b1], staleOv, true);
  check('옛 요약에 남은 11월 2일 루틴 2(목록 기간 안에서 지운 기록)는 되살리지 않음', !del.last[2] && del.last[1] === '2026-11-01', JSON.stringify(del));
  // Codex v2.2.0 3차 리뷰 P3: 판을 받은 날은 기기 시간대와 관계없이 한국 날짜(서버 workout_overview의 Asia/Seoul과 같게)
  {
    process.env.TZ = 'America/Los_Angeles';
    const kstNoon = rt('r-kst', [item(1, '스쿼트', '70')], '2026-10-31T15:30:00Z'); // 한국 11월 1일 00:30
    const kstDawn = rt('r-kst2', [item(1, '스쿼트', '70')], '2026-10-31T22:30:00Z'); // 한국 11월 1일 07:30(UTC로는 10월 31일)
    const sheetOn = (r, day) => ({ ...ses(`sh-${day}`, day, 1, [set('스쿼트', '70', '8')], [], r.id), source: 'sheet' });
    const days = [versionDay(kstNoon), versionDay(kstDawn)];
    const onDay = localProgress(kstNoon, [sheetOn(kstNoon, '2026-11-01')]);
    const nextDay = localProgress(kstNoon, [sheetOn(kstNoon, '2026-11-02')]);
    process.env.TZ = 'Asia/Seoul';
    check('미국 시간대 기기에서도 판을 받은 날은 한국 날짜(11월 1일) — 그날 시트 기록은 세지 않고 다음 날부터', days.join('|') === '2026-11-01|2026-11-01' && !onDay.last[1] && nextDay.last[1] === '2026-11-02', JSON.stringify({ days, onDay, nextDay }));
  }
  // Codex v2.2.0 4차 리뷰 P2: 잘린 목록에 이 판의 운동이 없으면 요약이 있을 때만 그 진행을 쓴다
  {
    const cardio = ses('cd', '2026-11-02', null, [], [{ kind: 'run', minutes: 30, km: null, speed: null }], null);
    const unknown = progressOf(cur, [cardio], null, true);
    const known = progressOf(cur, [cardio], { routine: { id: 'r-new', last: { 1: '2026-10-03' }, latest_day_no: 1 } }, true);
    const none = progressOf(cur, [cardio], null, false);
    check('잘린 목록에 이 판의 운동이 없고 요약도 없으면 진행 없음 · 요약이 있으면 그 진행으로 · 목록이 전부면 진행 없음', !Object.keys(unknown.last).length && known.last[1] === '2026-10-03' && !Object.keys(none.last).length, JSON.stringify({ unknown, known, none }));
    // 적대 검토: 판을 받은 날(10월 25일, 7일 여유)이 목록의 가장 오래된 날(10월 10일)보다 뒤면 이 판의 기록은 모두 목록 안 — 요약을 보태지 않는다
    const oldCardio = ses('co', '2026-10-10', null, [], [{ kind: 'run', minutes: 30, km: null, speed: null }], null);
    const fresh = progressOf(cur, [cardio, oldCardio], { routine: { id: 'r-new', last: { 1: '2026-10-01' }, latest_day_no: 1 } }, true);
    // 적대 검토: 요약의 날(11월 1일)이 목록 기간 안인데 목록에 없음(목록 다시 받기 실패 등) — 되살리지 않는다
    const clash = progressOf(cur, [cardio, ses('co2', '2026-10-30', null, [], [{ kind: 'run', minutes: 30, km: null, speed: null }], null)], { routine: { id: 'r-new', last: { 1: '2026-11-01' }, latest_day_no: 1 } }, true);
    check('새로 받은 판: 목록이 그 판의 기간을 다 덮으면 요약을 보태지 않음 · 요약의 날이 목록 기간 안이면 쓰지 않음', !Object.keys(fresh.last).length && !Object.keys(clash.last).length, JSON.stringify({ fresh, clash }));
  }
  // 2: 같은 루틴에 같은 이름이 둘(준비 세트·본 세트)이면 순서대로 짝짓는다
  const dupPrev = rt('d-old', [item(1, '스쿼트', '40', '10', 2), item(1, '스쿼트', '80', '8', 4), item(1, '런지', '20')]);
  const dupCur = rt('d-new', [item(1, '스쿼트', '40', '10', 2), item(1, '스쿼트', '80', '8', 4), item(1, '런지', '24')]);
  const dd = routineDiff(dupCur, dupPrev);
  check('같은 이름 두 줄: 안 바뀐 줄은 바뀐 것으로 안 나옴(런지만)', dd.length === 1 && dd[0].name === '런지' && dd[0].kind === 'chg', JSON.stringify(dd));
  const dupCur2 = rt('d-new2', [item(1, '스쿼트', '45', '10', 2), item(1, '스쿼트', '85', '8', 4), item(1, '런지', '20')]);
  const dd2 = routineDiff(dupCur2, dupPrev);
  check('같은 이름 두 줄이 다 바뀌면 줄마다 하나씩(40→45 · 80→85), 줄 키는 겹치지 않음', dd2.length === 2 && dd2.map((x) => x.detail).join('|') === '40kg → 45kg|80kg → 85kg' && new Set(dd2.map((x) => x.key)).size === 2, JSON.stringify(dd2));
  const dd3 = routineDiff(rt('d-new3', [item(1, '스쿼트', '40', '10', 2), item(1, '런지', '20')]), dupPrev);
  check('같은 이름 두 줄 가운데 하나가 빠지면 빠짐으로', dd3.length === 1 && dd3[0].kind === 'del' && dd3[0].detail === '지난 루틴 80kg · 8회 · 4세트', JSON.stringify(dd3));
  // 3: 루틴 없이 직접 기록한 근력 운동은 달력에서 유산소가 아니라 '운동'
  const free = ses('f', '2026-11-02', null, [set('벤치 프레스', '60', '8')], [], null);
  const fc = recentCalendar(calendarRows([free]), today).find((x) => x.day === '2026-11-02');
  check('루틴 없이 기록한 근력 운동: 달력에 채운 칸·운동', fc.kind === 'routine' && fc.label === '운동', JSON.stringify(fc));
  // 같은 날 두 번이면 먼저 시작한 기록의 루틴
  const two = [{ ...ses('late', '2026-11-02', 2, [set('랫풀다운', '50', '12')]), started_at: '2026-11-02T10:00:00Z' }, { ...ses('early', '2026-11-02', 1, [set('스쿼트', '60', '8')]), started_at: '2026-11-02T01:00:00Z' }];
  check('같은 날 두 번이면 먼저 시작한 기록(루틴1)', recentCalendar(calendarRows(two), today).find((x) => x.day === '2026-11-02').label === '루틴1');
}

// v2.1 식단 날짜 띠의 하루 평가 색: 조절 필요가 하나라도 있으면 조절 · 그다음 조금만 더 · 아주 좋아요 · 평가 전만 있으면 대기
{
  const { dayTone } = await bundle('src/lib/status.ts');
  const m = (rating) => ({ rating });
  check('하루 평가 색', dayTone([]) === '' && dayTone([m(null)]) === 'wait' && dayTone([m(1), m(null)]) === 'great' && dayTone([m(1), m(2)]) === 'good' && dayTone([m(1), m(2), m(3)]) === 'care', [dayTone([]), dayTone([m(null)]), dayTone([m(1), m(null)]), dayTone([m(1), m(2)]), dayTone([m(1), m(2), m(3)])].join(','));
}

// 시트 시험의 호출 번호는 요청마다 따로다(v2.3.0 3차 리뷰): A가 인증·DB를 기다리는 사이 B가 시작해도 A의 시트 요청에는 A 번호가 붙는다
{
  const keep = { Deno: globalThis.Deno, fetch: globalThis.fetch };
  const sent = [];
  globalThis.Deno = { env: { get: (k) => (k === 'SHEETS_FAKE_BASE' ? 'http://fake.invalid' : '') } };
  globalThis.fetch = async (url, init) => { sent.push(`${new URL(url).pathname.split('/').at(-1)}:${init.headers['x-check-call']}`); return new Response('{}'); };
  const { sheetToken, sheetsFetch } = await load('supabase/functions/_shared/googleSheets.ts');
  const req = (call) => new Request('http://local', { headers: { 'x-check-call': call } });
  const tokenA = await sheetToken('zzA', '', req('A-1'));
  const tokenB = await sheetToken('zzB', '', req('B-1'));
  await sheetsFetch(tokenB, 'zzB', '');
  await sheetsFetch(tokenA, 'zzA', '');
  check('시트 시험의 호출 번호: 겹친 요청도 자기 번호로', sent.join() === 'zzB:B-1,zzA:A-1', sent.join());
  Object.assign(globalThis, keep);
}

// 2.3.2 공동 순위 표기와 남은 날
{
  const { tieLabel, monthLeftText } = await load('src/lib/awards.ts');
  const a = { nickname: '민지', is_me: false }, b = { nickname: '하늘', is_me: true }, c = { nickname: '예린', is_me: false };
  check('공동 순위: 한 명은 이름만', tieLabel([a]) === '민지');
  check('공동 순위: 이름 하나와 외 n명', tieLabel([a, c]) === '민지 외 1명');
  check('공동 순위: 내가 있으면 내 이름이 앞', tieLabel([a, b, c]) === '하늘 (나) 외 2명');
  check('공동 순위: 빈 목록은 빈 글자', tieLabel([]) === '');
  check('남은 날: 달 끝까지 · 2월 · 마지막 날', monthLeftText('2026-11-06') === '24일 남음' && monthLeftText('2026-02-27') === '1일 남음' && monthLeftText('2026-11-30') === '오늘까지');
}

// 2.4 운동 찾기 · 운동별 기록 · 지난번 · 동작별 메모(src/lib/exercise.ts) · 함께 쓰는 조회(src/lib/sharedRequest.ts)
{
  const { exerciseKey, findExercises, matchRange, lastLine, latestWeight, historySummary, byMonth, memoPair, setsLine } = await bundle('src/lib/exercise.ts');
  check('비교용 이름: 띄어쓰기·대소문자 무시(DB private.exercise_key와 같음)', exerciseKey(' 벤치  프레스 ') === '벤치프레스' && exerciseKey('Lat Pull Down') === 'latpulldown');
  check('비교용 이름: DB와 같은 공백 글자(U+FEFF·U+0085·전각 공백·NBSP)도 지움', exerciseKey('벤치\uFEFF 프레스\u0085X') === '벤치프레스x' && exerciseKey('Lat\u3000Pull\u00A0Down') === 'latpulldown');
  const list = { strength: [{ key: '벤치프레스', name: '벤치 프레스', count: 24, last: '2026-11-05' }, { key: '인클라인벤치프레스', name: '인클라인 벤치 프레스', count: 3, last: '2026-10-20' }, { key: '스쿼트', name: '스쿼트', count: 30, last: '2026-11-05' }], cardio: [{ kind: 'run', count: 4, last: '2026-11-01' }] };
  const f1 = findExercises(list, '벤치프레');
  check('찾기: 띄어쓰기 없이 쳐도 이름에 든 운동만(순서 그대로)', f1.strength.map((x) => x.key).join() === '벤치프레스,인클라인벤치프레스' && f1.cardio.length === 0);
  check('찾기: 빈 글이면 전부 · 유산소는 종류 이름(러닝)으로', findExercises(list, ' ').strength.length === 3 && findExercises(list, '러닝').cardio.length === 1 && findExercises(list, '러닝').strength.length === 0);
  check('찾은 글자 강조 자리: 띄어쓰기를 건너 원래 이름의 자리', JSON.stringify(matchRange('인클라인 벤치 프레스', '벤치프')) === '[5,9]' && matchRange('스쿼트', '벤치') === null && matchRange('스쿼트', '') === null);
  const last = { '벤치 프레스': { id: 'a', day: '2026-11-05', sets: [{ set_no: 1, kg: '60', reps: '10' }, { set_no: 2, kg: '70', reps: '8' }, { set_no: 3, kg: '70', reps: '6' }] }, 플랭크: { id: 'b', day: '2026-11-03', sets: [{ set_no: 1, kg: null, reps: '40초' }] }, 덤벨: { id: 'c', day: '2026-11-01', sets: [{ set_no: 1, kg: '10+8', reps: '8' }, { set_no: 2, kg: '12', reps: '8' }] } };
  const l1 = lastLine(last, '벤치 프레스');
  check('지난번: 마지막 날과 가장 무거운 세트(무게가 같으면 앞 세트)', l1?.day === '2026-11-05' && l1?.text === '70kg × 8', JSON.stringify(l1));
  check('지난번: 무게 없이 한 운동은 횟수 · 한 적 없으면 없음', lastLine(last, '플랭크')?.text === '40초' && lastLine(last, '스쿼트') === null, JSON.stringify(lastLine(last, '플랭크')));
  check('지난번: 글자 무게는 기록 카드와 같은 비교(앞 숫자부터 — 12가 10+8보다 무거움)', lastLine(last, '덤벨')?.text === '12kg × 8', JSON.stringify(lastLine(last, '덤벨')));
  // 2.4.1 최신 무게(사용자 의견 11-10): 루틴으로 채운 세트에 넣을 무게 — 이전 기록의 같은 번호 세트, 없으면 그 기록의 마지막 세트, 무게가 없으면 null(루틴 무게 유지)
  const w = (name, n) => latestWeight(last[name], n);
  check('최신 무게: 같은 번호 세트의 무게 · 이전 기록에 없는 번호는 마지막 세트 · 글자 무게 그대로',
    w('벤치 프레스', 1) === '60' && w('벤치 프레스', 3) === '70' && w('벤치 프레스', 5) === '70' && w('덤벨', 1) === '10+8', JSON.stringify([w('벤치 프레스', 1), w('벤치 프레스', 5), w('덤벨', 1)]));
  check('최신 무게: 한 적 없거나 무게를 적지 않은 세트는 null(루틴 무게를 둔다)',
    w('스쿼트', 1) === null && w('플랭크', 1) === null && latestWeight({ id: 'd', day: '2026-11-05', sets: [{ set_no: 1, kg: '  ', reps: '8' }] }, 1) === null && latestWeight({ id: 'e', day: '2026-11-05', sets: [] }, 1) === null);
  const day = (d, kgs, source = 'app') => ({ id: d, day: d, day_no: 1, source, sets: kgs.map((kg, i) => ({ name: '벤치 프레스', set_no: i + 1, kg, reps: '8' })) });
  const h = historySummary([day('2026-11-05', ['70', '72.5']), day('2026-11-03', ['70']), day('2026-10-30', [null]), day('2026-10-28', ['65'], 'sheet')]);
  check('운동별 기록: 가장 무거운 무게·기록 수·마지막 날', h.heaviest === '72.5kg' && h.count === 4 && h.last === '2026-11-05', JSON.stringify([h.heaviest, h.count, h.last]));
  check('운동별 기록: 최고 = 그 앞 모든 기록보다 무거움(첫 기록·같은 무게·무게 없는 날은 아님)', h.rows.map((r) => r.record).join() === 'true,true,false,false' && h.rows[0].best === '72.5kg × 8', JSON.stringify(h.rows.map((r) => [r.day, r.record, r.best])));
  check('운동별 기록: 무게를 단 기록이 없으면 가장 무거운 무게 없음', historySummary([day('2026-11-05', [null])]).heaviest === null && historySummary([]).last === null);
  check('달 묶음: 최근 달부터, 같은 달끼리', JSON.stringify(byMonth(h.rows).map((g) => [g.month, g.rows.length])) === '[["2026-11",2],["2026-10",2]]');
  check('그날 세트 한 줄', setsLine([{ kg: '60', reps: '10' }, { kg: null, reps: '12' }]) === '60kg × 10 · 12회');
  const memos = [{ key: '벤치프레스', author: 'trainer', name: '벤치 프레스', body: 'A', updated_at: 't' }, { key: '벤치프레스', author: 'member', name: '벤치프레스', body: 'B', updated_at: 't' }, { key: '스쿼트', author: 'member', name: '스쿼트', body: 'C', updated_at: 't' }];
  const pair = memoPair(memos, '벤치 프레스');
  check('메모: 운동 이름(띄어쓰기 무시)으로 회원 칸·트레이너 칸', pair.trainer?.body === 'A' && pair.member?.body === 'B' && memoPair(memos, '런지').member === null && memoPair(undefined, '스쿼트').trainer === null);

  const { sharedRequest, setRequestScope } = await load('src/lib/sharedRequest.ts');
  let calls = 0;
  let open;
  const slow = () => { calls++; return new Promise((r) => { open = r; }); };
  const a = sharedRequest('k', slow), b = sharedRequest('k', slow), c = sharedRequest('k2', () => { calls++; return Promise.resolve(2); });
  open(1);
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  const after = await sharedRequest('k', () => { calls++; return Promise.resolve(3); });
  check('함께 쓰는 조회: 진행 중이면 같은 요청을 함께 받고, 끝나면 다음엔 새로 받음 · 다른 key는 따로', ra === 1 && rb === 1 && rc === 2 && after === 3 && calls === 3, JSON.stringify({ calls, ra, rb, rc, after }));
  let failed = 0;
  await sharedRequest('e', () => Promise.reject(new Error('x'))).catch(() => failed++);
  check('함께 쓰는 조회: 실패한 요청은 남기지 않음', failed === 1 && (await sharedRequest('e', () => Promise.resolve('ok'))) === 'ok');
  // Codex v2.4.0 1차 리뷰 P1-1: 로그인한 사람이 바뀌면(같은 사람의 다시 로그인 포함) 진행 중인 요청을 함께 받지 않는다
  {
    let n = 0;
    let releaseA;
    setRequestScope('user-a');
    const pa = sharedRequest('standings:2026-11-09:', () => { n++; return new Promise((r) => { releaseA = () => r('A의 순위'); }); });
    setRequestScope(''); // 로그아웃
    setRequestScope('user-b');
    const pb = sharedRequest('standings:2026-11-09:', () => { n++; return Promise.resolve('B의 순위'); });
    releaseA();
    const [ra, rb] = await Promise.all([pa, pb]);
    setRequestScope('user-b'); // 같은 사람이 다시 로그인해도 새로 받는다
    let held;
    const pb1 = sharedRequest('strength:2026-11-01:2026-11-09', () => { n++; return new Promise((r) => { held = r; }); });
    setRequestScope('user-b');
    const pb2 = sharedRequest('strength:2026-11-01:2026-11-09', () => { n++; return Promise.resolve('새 로그인'); });
    held('옛 로그인');
    const [r1, r2] = await Promise.all([pb1, pb2]);
    const same = sharedRequest('k-same', () => { n++; return Promise.resolve(1); }), same2 = sharedRequest('k-same', () => { n++; return Promise.resolve(2); });
    const [s1, s2] = await Promise.all([same, same2]);
    check('함께 쓰는 조회: 계정이 바뀌거나 다시 로그인하면 옛 요청을 넘겨받지 않음 · 같은 로그인 안에서는 함께 받음',
      ra === 'A의 순위' && rb === 'B의 순위' && r1 === '옛 로그인' && r2 === '새 로그인' && s1 === 1 && s2 === 1 && n === 5, JSON.stringify({ ra, rb, r1, r2, s1, s2, n }));
  }
  {
    const { memoStateOf } = await bundle('src/lib/exercise.ts');
    // 2차 리뷰 1절(사용자 결정 11-09): 저장 중에는 떠나도 된다 — 물어야 하는 쓰는 중이 앞선다
    check('메모 상태 합치기: 쓰는 중 > 저장 중 > 없음', memoStateOf(['clean', 'dirty', 'saving']) === 'dirty' && memoStateOf(['clean', 'saving']) === 'saving' && memoStateOf([]) === 'clean');
  }
  // Codex v2.4.0 2차 리뷰 P2-1·P3-1·4절: 저장하지 못한 메모는 보낼 때의 저장 기준과 함께, 더 나중의 저장이 있으면 앞선 실패는 버리고, 로그인 회차가 바뀌면 비운다
  {
    const out = await require('esbuild').build({
      stdin: { contents: "export * from './src/lib/memoSaves.ts'; export { setRequestScope } from './src/lib/sharedRequest.ts';", resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    });
    const M = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text + '\n//' + randomUUID()).toString('base64')}`);
    const slot = { memberId: 'm1', name: '스쿼트', viewer: 'member' };
    const later = () => { let ok, no; const p = new Promise((a, b) => { ok = a; no = b; }); return { p, ok, no }; };
    M.setRequestScope('user-a');
    // 칸이 열려 있으면 실패는 칸이 맡는다(여기에 남기지 않음)
    let s1 = later();
    let r = M.beginMemoSave(slot, '열린 칸', 'T1', () => s1.p);
    const savingNow = M.memoSaving(slot);
    s1.no(new Error('down'));
    let res = await r.done;
    check('메모 저장: 진행 중 표시 · 칸이 열려 있으면 실패를 칸이 맡음', savingNow && !M.memoSaving(slot) && res.ok === false && res.kept === false && M.memoFailure(slot) === null);
    // 칸이 닫힌 뒤 실패: 글과 보낼 때의 기준을 함께 남김
    s1 = later();
    r = M.beginMemoSave(slot, '닫힌 칸', 'T1', () => s1.p);
    r.owner.alive = false;
    s1.no(new Error('down'));
    res = await r.done;
    const f = M.memoFailure(slot);
    check('메모 저장: 칸이 닫힌 뒤 실패하면 글과 보낼 때의 저장 기준(T1)을 남김', res.kept && f?.body === '닫힌 칸' && f?.base === 'T1');
    // 실패 뒤에 받기 시작한 목록만 그 실패보다 큰 번호(적대 검토 P3-B)
    const fresh = M.nextListStamp();
    check('메모 저장: 실패는 그때의 목록 번호를 남기고, 실패 뒤에 받기 시작한 목록의 번호가 더 큼', fresh > f.stamp);
    // 더 나중의 저장이 성공하면 앞선 실패를 지운다 · 그 뒤 온 옛 실패도 되살리지 않는다
    const old = later(), next = later();
    const ro = M.beginMemoSave(slot, '옛 글', 'T1', () => old.p); ro.owner.alive = false;
    const rn = M.beginMemoSave(slot, '새 글', 'T1', () => next.p);
    next.ok('T2'); await rn.done;
    const clearedByNew = M.memoFailure(slot) === null;
    old.no(new Error('down')); const ro2 = await ro.done;
    check('메모 저장: 더 나중의 저장이 성공하면 앞선 실패를 지우고, 그 뒤 온 옛 실패도 남기지 않음', clearedByNew && ro2.kept === false && M.memoFailure(slot) === null);
    // Codex 3차 리뷰 P3-1: 늦게 온 옛 성공은 newest가 거짓(화면 값으로 쓰지 않음)
    {
      const o = later(), nn = later();
      const r1 = M.beginMemoSave(slot, '첫 글', 'T1', () => o.p), r2 = M.beginMemoSave(slot, '둘째 글', 'T1', () => nn.p);
      nn.ok('T3'); const d2 = await r2.done;
      o.ok('T2'); const d1 = await r1.done;
      check('메모 저장: 더 나중에 시작한 저장이 있으면 늦게 온 성공은 newest가 거짓 · 마지막 저장은 참', d1.ok && d1.newest === false && d2.newest === true);
    }
    // 두 실패가 어느 순서로 와도 나중에 시작한 글
    for (const order of [[1, 0], [0, 1]]) {
      const g = [later(), later()];
      const rs = [M.beginMemoSave(slot, '먼저', 'T2', () => g[0].p), M.beginMemoSave(slot, '나중', 'T2', () => g[1].p)];
      rs.forEach((x) => (x.owner.alive = false));
      for (const i of order) { g[i].no(new Error('down')); await rs[i].done; }
      check(`메모 저장: 두 실패가 ${order.join('→')} 순서로 와도 나중에 시작한 글만 남음`, M.memoFailure(slot)?.body === '나중');
    }
    // 지우기는 그 실패 번호일 때만
    const keep = M.memoFailure(slot);
    M.dropMemoFailure(slot, keep.seq - 1);
    const stays = M.memoFailure(slot) === keep;
    M.dropMemoFailure(slot, keep.seq);
    check('메모 저장: 다른 번호로는 지우지 않고 그 번호로만 지움', stays && M.memoFailure(slot) === null);
    // 회원 칸과 트레이너 칸은 따로 · 운동 이름 띄어쓰기는 같은 칸
    s1 = later();
    r = M.beginMemoSave({ memberId: 'm1', name: '레그 프레스', viewer: 'trainer' }, '트레이너 글', null, () => s1.p);
    r.owner.alive = false; s1.no(new Error('down')); await r.done;
    check('메모 저장: 트레이너 칸과 회원 칸은 따로, 운동 이름의 띄어쓰기는 무시', M.memoFailure({ memberId: 'm1', name: '레그프레스', viewer: 'trainer' })?.body === '트레이너 글' && M.memoFailure({ memberId: 'm1', name: '레그 프레스', viewer: 'member' }) === null);
    // 같은 사용자의 로그인 소식이 거듭 와도 그대로 · 로그아웃 뒤 같은 계정으로 다시 들어오면 비어 있음
    M.setRequestScope('user-a');
    const sameLogin = M.memoFailure({ memberId: 'm1', name: '레그프레스', viewer: 'trainer' }) !== null;
    M.setRequestScope('');
    M.setRequestScope('user-a');
    const relogin = M.memoFailure({ memberId: 'm1', name: '레그프레스', viewer: 'trainer' });
    // 로그인이 바뀐 뒤 도착한 옛 실패는 새 로그인에 남기지 않음
    s1 = later();
    r = M.beginMemoSave(slot, '로그아웃 전 글', 'T3', () => s1.p);
    r.owner.alive = false;
    M.setRequestScope('user-b');
    s1.no(new Error('down'));
    res = await r.done;
    check('메모 저장: 같은 로그인 소식이 거듭 와도 그대로 · 로그아웃 뒤 같은 계정으로 다시 들어오면 비어 있음 · 로그인이 바뀐 뒤 온 옛 실패는 남기지 않음',
      sameLogin && relogin === null && res.current === false && res.kept === false && M.memoFailure(slot) === null && !M.memoSaving(slot));
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
