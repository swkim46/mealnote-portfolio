// 주요 업데이트 알림 보내기(2026-10-30 사용자 요청: 2.0 같은 주요 업데이트 때 푸시 알림).
// 업데이트 소식(src/lib/releases.ts) 맨 위 항목의 push 문구로, 알림을 켠 회원·트레이너 기기마다 한 번 보낸다(DB 함수 private.queue_release_push —
// 같은 버전은 다시 불러도 한 번만, 알림을 켠 기기가 있으면 모두 받음 — 2.0.1부터 끄는 설정 없음). 배포 명령(scripts/deploy.sh)이 그 N.M을 처음 운영에 낸 뒤 부른다.
// 사용: node scripts/release-push.mjs --linked|--local [--dry]   · --check: 맨 위 항목에 push 문구가 있으면 0, 없으면 1(배포 전 확인용)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const ts = require('typescript');
const args = new Set(process.argv.slice(2));

// releases.ts는 빌드 때 넣는 값(__CHANNEL__ 등)을 쓴다 — 읽을 때만 채워 둔다
Object.assign(globalThis, { __CHANNEL__: 'prod', __DEV_LABEL__: '' });
const src = fs.readFileSync('src/lib/releases.ts', 'utf8').replace(/^import .*;\n/gm, '');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { RELEASES } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const top = RELEASES[0];
const push = top?.push;

if (args.has('--check')) process.exit(push ? 0 : 1);
if (!push) {
  console.log(`업데이트 알림 없음: v${top?.version} 소식에 push 문구가 없습니다.`);
  process.exit(0);
}
const title = String(push.title ?? '').trim(), body = String(push.body ?? '').trim();
if (!/^\d+\.\d+$/.test(top.version) || !title || title.length > 40 || !body || body.length > 120) {
  console.error(`중단: v${top.version} 업데이트 알림 문구를 확인하세요(제목 1～40자·본문 1～120자).`);
  process.exit(1);
}
const q = (v) => {
  if (v.includes('$rp$')) throw new Error('문구에 $rp$를 쓸 수 없습니다.');
  return `$rp$${v}$rp$`;
};
const where = args.has('--linked') ? '--linked' : args.has('--local') ? '--local' : null;
if (!where) {
  console.error('사용: node scripts/release-push.mjs --linked|--local [--dry]');
  process.exit(1);
}
if (args.has('--dry')) {
  console.log(`[미리 보기] v${top.version} 업데이트 알림 → ${where === '--linked' ? '운영' : '로컬'}\n  제목: ${title}\n  본문: ${body}`);
  process.exit(0);
}
const out = execFileSync('supabase', ['db', 'query', where, `select private.queue_release_push(${q(top.version)}, ${q(title)}, ${q(body)}) as n`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const n = JSON.parse(out.slice(out.indexOf('{'))).rows?.[0]?.n;
if (typeof n !== 'number') {
  console.error('중단: 업데이트 알림 결과를 읽지 못했습니다.');
  process.exit(1);
}
console.log(n > 0 ? `업데이트 알림: v${top.version} — 계정 ${n}곳에 보냈습니다.` : `업데이트 알림: v${top.version}은 이미 보냈거나 받을 기기가 없습니다(새로 보낸 것 0).`);
