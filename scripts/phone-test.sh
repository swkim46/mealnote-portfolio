#!/bin/sh
# 실제 휴대폰으로 푸시 알림 시험(v1.7): 맥의 로컬 DB·로컬 서버 기능을 쓰는 빌드본에 임시 https 주소(Cloudflare 터널)를 붙인다.
# 사용: npm run phone:test   (먼저 npm run db:start. 끝내려면 Ctrl+C — 미리보기 서버와 터널을 함께 끈다)
# 주의: 터널이 켜져 있는 동안은 주소를 아는 사람이 시험 앱에 들어올 수 있다. 시험 데이터만 두고, 끝나면 바로 끈다.
cd "$(dirname "$0")/.." || exit 1
PORT=4180
OUT=dist-phonetest

if ! supabase status >/dev/null 2>&1; then
  echo "중단: 로컬 Supabase가 꺼져 있습니다. 먼저 npm run db:start" >&2
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "중단: cloudflared가 없습니다. brew install cloudflared 로 설치한 뒤 다시 실행하세요." >&2
  exit 1
fi

# 로컬 시험 준비(VAPID 키·Vault·송신 스위치) + 시험 빌드 환경 파일
node scripts/push-local-setup.mjs >/dev/null || exit 1
node -e '
const fs = require("fs");
const s = JSON.parse(require("child_process").execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const f = ".env.phonetest.local";
const keep = (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "").split("\n").filter((l) => l.startsWith("VITE_VAPID_PUBLIC_KEY="));
fs.writeFileSync(f, [`VITE_SUPABASE_URL=${s.API_URL}`, `VITE_SUPABASE_PUBLISHABLE_KEY=${s.PUBLISHABLE_KEY}`, "VITE_SUPABASE_SAME_ORIGIN=1", ...keep].join("\n") + "\n");
' || exit 1

# Vite가 최종 적용할 DB 주소 확인은 vite.config.ts(assertPhonetestLocal)가 빌드·미리보기 시작 때 한다.
# 셸 환경 변수로 운영 주소가 들어와도 여기서 멈춘다(터널은 그 뒤에만 띄운다).
node scripts/copy-ocr-assets.mjs >/dev/null || exit 1
npx vite build --mode phonetest --outDir "$OUT" --emptyOutDir >/dev/null || { echo "중단: 시험 빌드 실패" >&2; exit 1; }

npx vite preview --mode phonetest --outDir "$OUT" --port "$PORT" --strictPort >/dev/null 2>&1 &
PREVIEW=$!
LOG=$(mktemp)
cleanup() { kill "$PREVIEW" "$TUNNEL" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT INT TERM
sleep 2
if ! kill -0 "$PREVIEW" 2>/dev/null; then echo "중단: 미리보기 서버를 띄우지 못했습니다." >&2; exit 1; fi

cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL=$!
URL=""
for _ in $(seq 1 30); do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo "중단: 터널 주소를 받지 못했습니다." >&2; exit 1; fi
echo ""
echo "휴대폰에서 이 주소를 여세요: $URL"
echo "아이폰은 Safari로 연 뒤 '홈 화면에 추가' → 추가한 앱으로 열어 내 정보 → 알림에서 켭니다."
echo "끝내려면 Ctrl+C"
wait "$TUNNEL"
