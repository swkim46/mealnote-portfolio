#!/bin/sh
# 운영 배포. main 브랜치·저장 안 한 변경 없음·운영 DB 마이그레이션 최신일 때만 진행한다. 앱과 서버 기능을 같은 커밋으로 올린다.
# 사용: npm run deploy   (배포 뒤 git tag v<버전> 을 붙인다)
cd "$(dirname "$0")/.." || exit 1

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "배포 중단: 지금 브랜치는 '$branch'입니다. 운영 배포는 main에서만 합니다." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "배포 중단: 커밋하지 않은 변경이 있습니다. 운영에 나가는 코드는 모두 커밋돼 있어야 합니다." >&2
  git status --short >&2
  exit 1
fi

# 운영 DB에 아직 안 올린 마이그레이션이 있으면 화면만 먼저 나가지 않게 막는다.
# Codex 리뷰 P2(6): 예전에는 조회 명령이 실패해 빈 출력이 오면 '0건'으로 읽어 배포가 그대로 진행됐다.
# 이제 명령 실패·응답 형식 이상은 모두 배포 중단으로 본다.
if ! mig=$(supabase migration list --linked 2>/dev/null); then
  echo "배포 중단: 운영 DB 마이그레이션 상태를 조회하지 못했습니다(연결·로그인 확인)." >&2
  exit 1
fi
pending=$(printf '%s' "$mig" | python3 -c '
import json, sys
text = sys.stdin.read()
start = text.find("{")
try:
    data = json.loads(text[start:]) if start >= 0 else None
    rows = data["migrations"]
    assert isinstance(rows, list) and rows
except Exception:
    print("ERROR"); sys.exit(0)
print(sum(1 for r in rows if r.get("local") and not r.get("remote")))
')
if [ "$pending" = "ERROR" ] || [ -z "$pending" ]; then
  echo "배포 중단: 마이그레이션 상태 응답을 읽지 못했습니다." >&2
  exit 1
fi
if [ "$pending" != "0" ]; then
  echo "배포 중단: 운영 DB에 적용 안 된 마이그레이션이 ${pending}개 있습니다. 먼저 npm run db:push" >&2
  exit 1
fi

# 버전 확인(N.M.L 규칙, src/lib/releases.ts 맨 위 설명 참고)
version=$(sed -n "s/^export const APP_VERSION = '\([0-9.]*\)';.*/\1/p" src/lib/releases.ts)
release=$(sed -n "s/^ *version: '\([0-9.]*\)'.*/\1/p" src/lib/releases.ts | head -1)
if ! echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "배포 중단: APP_VERSION('$version')이 N.M.L 형식이 아닙니다." >&2
  exit 1
fi
if [ "${version%.*}" != "$release" ]; then
  echo "배포 중단: APP_VERSION $version 의 N.M과 업데이트 소식 최신 버전 $release 이 다릅니다." >&2
  echo "  N이나 M을 올렸다면 RELEASES 맨 위에 v${version%.*} 소식을 추가하세요." >&2
  exit 1
fi
# 버전은 운영 배포 기준: 마지막 운영 태그(vX.Y.Z, dev 태그 제외)의 바로 다음 번호만 허용한다(dev 중 실수로 1.5가 되는 것 방지)
last=$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
if [ -n "$last" ]; then
  allowed=$(echo "$last" | awk -F. '{printf "%d.%d.%d %d.%d.0 %d.0.0", $1,$2,$3+1, $1,$2+1, $1+1}')
  case " $allowed " in
    *" $version "*) ;;
    *) echo "배포 중단: 마지막 운영 버전(v${last}) 다음에는 ${allowed} 중 하나만 쓸 수 있습니다(지금 ${version})." >&2; exit 1 ;;
  esac
fi
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "배포 중단: v$version 은 이미 배포한 번호입니다. 버그 수정이면 L, 새 기능이면 M을 올려 주세요." >&2
  exit 1
fi

npm run build || exit 1

# 서버 기능(supabase/functions/*, _shared 제외)도 같은 커밋으로 올린다. 기본 문구(_shared/quotes.ts)를 앱과 알림 서버 기능이
# 함께 쓰므로, 앱만 나가고 아침 응원 문구가 옛것으로 남는 일을 막는다(Codex v1.7 운영 배포 후 리뷰). 실패하면 앱도 내보내지 않는다.
# 실패하면 원인(명령 출력 끝부분)을 보여 주고, 전체 기록은 임시 로그 파일에 남긴다(Codex v1.7.1 리뷰).
sha=$(git rev-parse --short HEAD)
log=$(mktemp -t mealnote-deploy)
deployed=""
for dir in supabase/functions/*/; do
  fn=$(basename "$dir")
  case "$fn" in _*) continue ;; esac
  if ! supabase functions deploy "$fn" >>"$log" 2>&1; then
    echo "배포 중단: 서버 기능 $fn 배포 실패(앱은 내보내지 않았습니다). 원인:" >&2
    grep -v -e 'new version' -e 'recommend updating' "$log" | tail -8 >&2
    [ -n "$deployed" ] && echo "이미 올라간 서버 기능:$deployed (커밋 $sha)" >&2
    echo "전체 기록: $log" >&2
    exit 1
  fi
  deployed="$deployed $fn"
  echo "서버 기능 $fn 을 이 커밋($sha)으로 올렸습니다."
done

if ! wrangler pages deploy dist --project-name mealnote --branch main \
  --commit-hash "$(git rev-parse HEAD)" --commit-message "v$version $(git log -1 --format=%s)"; then
  echo "배포 중단: 앱(웹) 배포 실패. 서버 기능은 이미 이 커밋($sha)으로 올라갔고 버전 태그는 붙이지 않았습니다." >&2
  echo "같은 커밋에서 npm run deploy 를 다시 실행하면 됩니다(서버 기능도 같은 내용으로 다시 올라감)." >&2
  exit 1
fi
rm -f "$log"

git tag -a "v$version" -m "운영 배포 v$version (앱·서버 기능 같은 커밋)"
echo "태그 v$version 을 붙였습니다." 

# GitHub(비공개 운영 저장소)에 운영 코드와 태그를 올린다
if git remote get-url origin >/dev/null 2>&1; then
  git push -q origin main && git push -q origin --tags && echo "GitHub에 main·태그를 올렸습니다."
fi
