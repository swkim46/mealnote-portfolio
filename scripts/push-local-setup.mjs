// 로컬 푸시 알림 준비(v1.7). 로컬 Supabase에서만 쓴다: npm run push:setup
// - supabase/functions/.env: 시험용 VAPID 키·호출 비밀(없을 때만 새로 만든다. git에 안 올라감)
// - .env.development.local · .env.phonetest.local: 앱이 쓰는 공개 VAPID 키
// - 로컬 DB: Vault(서버 기능 주소·호출 비밀), 송신 스위치 all, 시험 수신 서버 주소 허용
// 키·비밀 원문은 출력하지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FN_ENV = 'supabase/functions/.env';
const readEnv = (path) => {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
};
const setEnv = (path, key, value) => {
  const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
  const lines = text.split('\n').filter((l) => !l.startsWith(`${key}=`) && l !== '');
  lines.push(`${key}=${value}`);
  fs.writeFileSync(path, lines.join('\n') + '\n');
};

// 로컬 DB인지 먼저 확인
const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(status.API_URL ?? '')) {
  console.error('중단: 로컬 Supabase가 아닙니다.');
  process.exit(1);
}

const env = readEnv(FN_ENV);
if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  setEnv(FN_ENV, 'VAPID_PUBLIC_KEY', ecdh.getPublicKey().toString('base64url'));
  setEnv(FN_ENV, 'VAPID_PRIVATE_KEY', ecdh.getPrivateKey().toString('base64url'));
  console.log('시험용 VAPID 키를 새로 만들었습니다.');
}
if (!env.PUSH_CRON_SECRET) setEnv(FN_ENV, 'PUSH_CRON_SECRET', crypto.randomBytes(32).toString('base64url'));
const fn = readEnv(FN_ENV);
for (const f of ['.env.development.local', '.env.phonetest.local']) setEnv(f, 'VITE_VAPID_PUBLIC_KEY', fn.VAPID_PUBLIC_KEY);

// 한 번에 한 문장씩(여러 문장을 묶으면 거부된다). 실패해도 명령 원문(비밀 포함)을 출력하지 않는다.
const q = (sql, label) => {
  try {
    execFileSync('supabase', ['db', 'query', '--local', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`중단: ${label} 실패 — ${String(e.stdout ?? '').replace(/'[^']*'/g, "'…'").slice(0, 200)}`);
    process.exit(1);
  }
};
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
q(`delete from vault.secrets where name in ('push_function_url', 'push_cron_secret')`, 'Vault 정리');
q(`select vault.create_secret(${lit('http://supabase_kong_app:8000/functions/v1/send-push')}, 'push_function_url')`, '서버 기능 주소 저장');
q(`select vault.create_secret(${lit(fn.PUSH_CRON_SECRET)}, 'push_cron_secret')`, '호출 비밀 저장');
q(`update public.app_settings set value = 'all' where key = 'push_mode'`, '송신 스위치');
q(`insert into public.app_settings (key, value) values ('push_test_endpoint_prefix', 'http://host.docker.internal:') on conflict (key) do update set value = excluded.value`, '시험 수신 서버 허용');
console.log('로컬 푸시 준비 완료: 서버 기능 비밀·Vault·송신 스위치(all)·시험 수신 서버 허용');
console.log('서버 기능이 새 비밀을 읽도록 처음 한 번은 npm run db:stop → db:start 가 필요할 수 있습니다.');
