// 운영 푸시 알림 준비(v1.7, 처음 한 번 · 키를 바꿀 때). 사용자가 직접 실행한다: node scripts/push-prod-setup.mjs 회원닉네임 트레이너닉네임
// 1) 서버 기능 비밀(VAPID 키·호출 비밀)을 Supabase에 등록  2) 운영 Vault에 서버 기능 주소·호출 비밀 저장
// 3) 송신 스위치를 '시험 계정만'(testers)으로, 시험 계정은 인자로 준 닉네임  4) 서버 기능을 비밀로 한 번 불러 응답 확인
// 값은 .env.production.local에서 읽고(git 제외), 화면에 출력하지 않는다. 임시 파일은 권한 600으로 만들고 바로 지운다.
// 전체에 켜기는 두 휴대폰 확인 뒤: supabase db query --linked "update public.app_settings set value = 'all' where key = 'push_mode';"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const nicks = process.argv.slice(2);
if (!nicks.length) {
  console.error('사용: node scripts/push-prod-setup.mjs <시험 계정 닉네임> [...]   예) node scripts/push-prod-setup.mjs 회원닉네임 트레이너닉네임');
  process.exit(1);
}
const env = fs.readFileSync('.env.production.local', 'utf8');
const get = (k) => {
  const m = new RegExp(`^${k}=(.+)$`, 'm').exec(env);
  if (!m) {
    console.error(`중단: .env.production.local에 ${k}가 없습니다.`);
    process.exit(1);
  }
  return m[1].trim();
};
const url = get('VITE_SUPABASE_URL');
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) {
  console.error('중단: 운영 Supabase 주소가 아닙니다.');
  process.exit(1);
}
const pub = get('VITE_VAPID_PUBLIC_KEY'), priv = get('PUSH_VAPID_PRIVATE_KEY'), secret = get('PUSH_CRON_SECRET');
const fnUrl = `${url}/functions/v1/send-push`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mealnote-push-'));
const write = (name, text) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, text, { mode: 0o600 });
  return f;
};
const run = (args, label) => {
  try {
    return execFileSync('supabase', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`중단: ${label} 실패 — ${String(e.stderr ?? e.stdout ?? '').split('\n').filter((l) => !/new version|recommend/.test(l)).slice(-3).join(' ')}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
};
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
try {
  run(['secrets', 'set', '--env-file', write('fn.env', `VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${priv}\nPUSH_CRON_SECRET=${secret}\n`)], '서버 기능 비밀 등록');
  console.log('1) 서버 기능 비밀 등록');
  // 한 번에 한 문장씩(여러 문장을 묶으면 거부된다). 비밀은 명령 인자가 아니라 권한 600 임시 파일로 넘긴다
  run(['db', 'query', '--linked', `delete from vault.secrets where name in ('push_function_url', 'push_cron_secret')`], 'Vault 정리');
  run(['db', 'query', '--linked', '-f', write('v1.sql', `select vault.create_secret(${lit(fnUrl)}, 'push_function_url')`)], 'Vault 주소 저장');
  run(['db', 'query', '--linked', '-f', write('v2.sql', `select vault.create_secret(${lit(secret)}, 'push_cron_secret')`)], 'Vault 비밀 저장');
  console.log('2) 운영 Vault에 서버 기능 주소·호출 비밀 저장');
  const ids = JSON.parse(run(['db', 'query', '--linked', '--output-format', 'json', `select id::text, nickname from public.profiles where nickname in (${nicks.map(lit).join(',')})`], '시험 계정 찾기').replace(/^[^{]*/, '')).rows ?? [];
  const missing = nicks.filter((n) => !ids.some((r) => r.nickname === n));
  if (missing.length) throw new Error(`운영에 없는 닉네임: ${missing.join(', ')}`);
  run(['db', 'query', '--linked', `update public.app_settings set value = ${lit(ids.map((r) => r.id).join(','))} where key = 'push_testers'`], '시험 계정 저장');
  run(['db', 'query', '--linked', `update public.app_settings set value = 'testers' where key = 'push_mode'`], '송신 스위치');
  console.log(`3) 송신 스위치: 시험 계정만(${nicks.join(', ')})`);
  const res = await fetch(fnUrl, { method: 'POST', headers: { 'x-push-secret': secret, 'content-type': 'application/json' }, body: '{}' });
  console.log(`4) 서버 기능 응답 ${res.status} ${res.ok ? (await res.text()) : '(실패 — 비밀이 아직 반영되지 않았으면 1분 뒤 다시 실행)'}`);
} catch (e) {
  console.error(`중단: ${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
