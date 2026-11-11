// 루틴 시트 읽기용 구글 서비스 계정 키 등록(v2.0). 키 파일: .secrets/google-sheets-key.json(git 제외)
//   node scripts/sheets-key-setup.mjs          → 로컬: supabase/functions/.env 의 GOOGLE_SA_KEY_B64·SHEETS_FAKE_BASE(검증용 가짜 시트 서버) (그다음 npm run db:stop → db:start)
//   node scripts/sheets-key-setup.mjs --linked → 운영: supabase secrets set (권한 600 임시 파일로 넘기고 바로 지움)
// 키 내용은 화면에 출력하지 않는다. 서비스 계정 주소만 보인다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FILE = '.secrets/google-sheets-key.json';
const key = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
  console.error('중단: 서비스 계정 키 파일이 아닙니다.');
  process.exit(1);
}
const b64 = Buffer.from(JSON.stringify({ client_email: key.client_email, private_key: key.private_key })).toString('base64');
if (process.argv.includes('--linked')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mealnote-sheets-'));
  const f = path.join(tmp, 'fn.env');
  try {
    fs.writeFileSync(f, `GOOGLE_SA_KEY_B64=${b64}\n`, { mode: 0o600 });
    execFileSync('supabase', ['secrets', 'set', '--env-file', f], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`운영 서버 기능 비밀 등록: GOOGLE_SA_KEY_B64 (${key.client_email})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  const FN_ENV = 'supabase/functions/.env';
  const lines = fs.existsSync(FN_ENV) ? fs.readFileSync(FN_ENV, 'utf8').split('\n').filter((l) => l && !l.startsWith('GOOGLE_SA_KEY_B64=') && !l.startsWith('SHEETS_FAKE_BASE=')) : [];
  // 로컬 검증용 가짜 시트 서버(시트 id가 'zz'로 시작하는 시험 시트만 — 검증 스크립트가 맥에 띄우고, 서버 기능은 Docker 안에서 host.docker.internal로 닿는다)
  fs.writeFileSync(FN_ENV, [...lines, `GOOGLE_SA_KEY_B64=${b64}`, 'SHEETS_FAKE_BASE=http://host.docker.internal:8789', ''].join('\n'), { mode: 0o600 });
  console.log(`로컬 서버 기능 비밀 등록: ${FN_ENV} (${key.client_email}) — 반영하려면 npm run db:stop → npm run db:start`);
}
