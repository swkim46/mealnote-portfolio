// 인바디 결과지 글자 인식 검증. 실제 브라우저(휴대폰 크기, https 아닌 주소)에서 앱의 인식 모듈을 그대로 돌린다.
// 1) 지어낸 값의 가짜 결과지(깨끗한 것·휴대폰으로 찍은 듯한 것)  2) INBODY_SAMPLE이 있으면 그 사진(개인 사진은 저장소에 넣지 않는다)
//    INBODY_SAMPLE=/경로/사진.png INBODY_EXPECT='{"measured_on":"…","weight_kg":…,"smm_kg":…,"pbf_pct":…}' node scripts/ocr-check.mjs
// 인식 중 우리 주소 밖으로 나가는 요청, 사진을 보내는 요청(POST 등)이 없어야 한다.
import { chromium, devices } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { sheetHtml, SAMPLE } from './inbody-sheet.mjs';

const PORT = 5181;
const OUT = 'test-results/ocr';
mkdirSync(OUT, { recursive: true });
execFileSync('node', ['scripts/copy-ocr-assets.mjs']);
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const BASE = `http://${lan ? lan.address : 'localhost'}:${PORT}`;
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('개발 서버가 30초 안에 뜨지 않았습니다.')), 30000);
  server.stdout.on('data', (d) => { if (String(d).includes(`${PORT}`)) { clearTimeout(timer); resolve(); } });
});
process.on('exit', () => server.kill());

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch();
// 가짜 결과지 이미지 만들기
const maker = await browser.newPage({ viewport: { width: 1600, height: 2260 } });
const cases = [];
for (const photo of [false, true]) {
  await maker.setContent(sheetHtml(SAMPLE, { photo }));
  const path = `${OUT}/sheet_${photo ? 'photo' : 'clean'}.png`;
  await maker.screenshot({ path, type: 'png' });
  cases.push({ name: photo ? '가짜 결과지(찍은 사진처럼)' : '가짜 결과지(깨끗한 스캔)', path, expect: SAMPLE.expect });
}
// 해상도를 낮춘 사본(메모리에서만 만든다): 흐리거나 작게 저장된 사진에서도 읽는지, 못 읽어도 틀린 값을 채우지 않는지
const shrink = async (b64, width) => {
  await maker.setContent('<body></body>');
  return maker.evaluate(async ({ b64, width }) => {
    const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((img.height * width) / img.width);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7).split(',')[1];
  }, { b64, width });
};
cases.push({ name: '가짜 결과지(가로 800px로 줄임)', b64: await shrink(readFileSync(`${OUT}/sheet_clean.png`).toString('base64'), 800), expect: SAMPLE.expect, allowEmpty: true });
if (process.env.INBODY_SAMPLE) {
  const expect = JSON.parse(process.env.INBODY_EXPECT ?? '{}');
  const raw = readFileSync(process.env.INBODY_SAMPLE);
  cases.push({ name: '받은 결과지', b64: raw.toString('base64'), expect, private: true });
  for (const w of [1000, 700]) cases.push({ name: `받은 결과지(가로 ${w}px로 줄임)`, b64: await shrink(raw.toString('base64'), w), expect, private: true });
  // 같은 결과지를 휴대폰으로 찍은 것처럼(기울기·흐림·그림자). 메모리에서만 만들고 파일로 남기지 않는다.
  await maker.setContent(`<body style="margin:0;background:#8a8578"><div style="position:relative;width:1600px;height:2260px;transform:rotate(1.6deg) scale(.93);filter:blur(.8px) contrast(.88)"><img style="width:100%" src="data:image/png;base64,${raw.toString('base64')}"><div style="position:absolute;inset:0;background:linear-gradient(120deg,#0000 35%,#0003 80%,#0005)"></div></div></body>`);
  const shotBuf = await maker.screenshot({ type: 'png' });
  // 흐리고 기운 사진은 다 못 읽을 수 있다. 대신 틀린 값을 채우면 안 된다(못 읽은 칸은 회원이 입력).
  cases.push({ name: '받은 결과지(찍은 사진처럼)', b64: shotBuf.toString('base64'), expect, private: true, allowEmpty: true });
}
await maker.close();

const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const requests = [];
page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
await page.goto(BASE);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500); // 개발 서버의 첫 의존성 정리로 화면이 한 번 새로 고쳐질 수 있다
const origin = new URL(BASE).origin;
for (const c of cases) {
  requests.length = 0;
  const b64 = c.b64 ?? readFileSync(c.path).toString('base64');
  const t0 = Date.now();
  const res = await page.evaluate(async ({ b64, debug }) => {
    const m = await import('/src/lib/inbodyOcr.ts');
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const dbg = debug ? { crops: {} } : undefined;
    const r = await m.readInbodyPhotoDetailed(blob, undefined, dbg);
    return { skew: r.skew, values: r.values, reads: debug ? r.reads.map((x) => [x.key, x.text]) : [], crops: dbg?.crops ?? {}, lines: debug ? r.lines.map((l) => `${Math.round(l.bbox.y0)} ${l.words.map((w) => w.text).join(' ')}`) : [] };
  }, { b64, debug: !!process.env.OCR_DEBUG && (!c.private || !!process.env.PRIVATE_DEBUG) });
  const ms = Date.now() - t0;
  if (!c.private) for (const [k, v] of Object.entries(res.crops)) writeFileSync(`${OUT}/crop_${cases.indexOf(c)}_${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
  if (process.env.OCR_LINES) for (const l of res.lines) console.log('    L', l);
  for (const [k, t] of res.reads) console.log('   ', k, '|', t.replace(/\n+/g, ' ⏎ '));
  if (process.env.PRIVATE_DEBUG) console.log('    values', JSON.stringify(res.values), 'skew', res.skew);
  if (c.allowEmpty) {
    const keys = Object.keys(c.expect);
    const wrong = keys.filter((k) => res.values[k] !== null && res.values[k] !== c.expect[k]);
    check(`${c.name}: 틀린 값 없음(읽은 칸 ${keys.filter((k) => res.values[k] === c.expect[k]).length}/${keys.length})`, wrong.length === 0, wrong.join(','));
  } else for (const key of ['measured_on', 'weight_kg', 'smm_kg', 'pbf_pct']) {
    if (!(key in c.expect)) continue;
    check(`${c.name}: ${key}`, res.values[key] === c.expect[key], c.private ? (res.values[key] === c.expect[key] ? '' : '값 다름(개인 사진이라 값은 출력하지 않음)') : `읽음 ${res.values[key]} · 기대 ${c.expect[key]}`);
  }
  const foreign = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const sends = requests.filter((r) => r.method !== 'GET');
  check(`${c.name}: 인식 중 외부 요청·전송 없음`, !foreign.length && !sends.length, JSON.stringify([...foreign, ...sends].slice(0, 3)));
  console.log(`    (${(ms / 1000).toFixed(1)}초)`);
}
await browser.close();
console.log(`\n${pass} PASS / ${fail} FAIL`);
server.kill();
process.exit(fail ? 1 : 0);
