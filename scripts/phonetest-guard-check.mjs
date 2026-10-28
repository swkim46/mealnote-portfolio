// 휴대폰 시험 빌드가 운영 DB를 쓰지 못하는지(Codex 3차): Vite가 최종 적용할 값으로 막는다.
// ① 셸 환경 변수에 운영 주소 → vite build 중단 ② .env.phonetest.local에 운영 주소 → 중단
// ③ 셸 환경 변수에 운영 주소로 npm run phone:test → 빌드·미리보기·터널 모두 시작 안 함(가짜 cloudflared로 실행 여부 확인)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
const PROD = 'https://abcdefghijklmnop.supabase.co';
const OUT = 'dist-phonetest-guard';
const build = (env) => spawnSync('npx', ['vite', 'build', '--mode', 'phonetest', '--outDir', OUT], { env: { ...process.env, ...env }, encoding: 'utf8' });

rmSync(OUT, { recursive: true, force: true });
const a = build({ VITE_SUPABASE_URL: PROD });
check('셸 환경 변수에 운영 주소면 시험 빌드 중단', a.status !== 0 && /중단: phonetest 빌드의 DB 주소/.test(a.stdout + a.stderr) && !existsSync(OUT));

const f = '.env.phonetest.local';
const saved = existsSync(f) ? readFileSync(f, 'utf8') : null;
try {
  writeFileSync(f, `VITE_SUPABASE_URL=${PROD}\nVITE_SUPABASE_PUBLISHABLE_KEY=x\nVITE_SUPABASE_SAME_ORIGIN=1\n`);
  const env = { ...process.env };
  delete env.VITE_SUPABASE_URL;
  const b = spawnSync('npx', ['vite', 'build', '--mode', 'phonetest', '--outDir', OUT], { env, encoding: 'utf8' });
  check('.env.phonetest.local에 운영 주소면 시험 빌드 중단', b.status !== 0 && /중단: phonetest 빌드의 DB 주소/.test(b.stdout + b.stderr) && !existsSync(OUT));
} finally {
  if (saved === null) rmSync(f, { force: true });
  else writeFileSync(f, saved);
}

// 가짜 cloudflared: 실행되면 표시 파일을 남긴다
const bin = mkdtempSync(join(tmpdir(), 'phonetest-guard-'));
const marker = join(bin, 'tunnel-started');
writeFileSync(join(bin, 'cloudflared'), `#!/bin/sh\ntouch "${marker}"\nsleep 1\n`);
chmodSync(join(bin, 'cloudflared'), 0o755);
// 이미 떠 있는 휴대폰 시험 서버가 있어도 판단이 흔들리지 않게, 실행 전후의 4180 포트 사용 프로세스를 비교한다
const listeners = () => spawnSync('lsof', ['-ti', 'tcp:4180'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).sort().join(',');
const before = listeners();
const c = spawnSync('sh', ['scripts/phone-test.sh'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITE_SUPABASE_URL: PROD }, encoding: 'utf8', timeout: 180000 });
check('셸 환경 변수에 운영 주소면 phone:test가 터널·미리보기를 띄우지 않음', c.status !== 0 && !existsSync(marker) && listeners() === before, `exit ${c.status}`);
rmSync(bin, { recursive: true, force: true });

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
