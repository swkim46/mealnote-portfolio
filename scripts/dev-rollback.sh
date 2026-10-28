#!/bin/sh
# dev 세부 버전으로 되돌리기. 운영(main·운영 DB)은 건드리지 않는다.
# 사용: sh scripts/dev-rollback.sh v1.4.0-dev.N [--dry-run]
#  1) 그 태그에서 새 브랜치 rollback/<태그>-<시각>을 만든다(dev 브랜치는 그대로 남는다)
#  2) 로컬 테스트 DB를 그 시점의 마이그레이션으로 다시 만든다(테스트 데이터는 초기화된다)
# 되돌린 상태를 dev로 삼으려면 확인 뒤: git switch dev && git reset --hard <태그> (또는 git revert로 되돌리기 커밋)
cd "$(dirname "$0")/.." || exit 1
tag="$1"; dry="$2"
if ! echo "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$'; then
  echo "사용: sh scripts/dev-rollback.sh v1.4.0-dev.N [--dry-run]" >&2
  echo "있는 dev 세부 버전:" >&2; git tag -l 'v*-dev.*' | sort -V >&2
  exit 1
fi
if ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "중단: ${tag} 태그가 없습니다." >&2; git tag -l 'v*-dev.*' | sort -V >&2; exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "중단: 커밋하지 않은 변경이 있습니다. 먼저 커밋하거나 치워 주세요." >&2; git status --short >&2; exit 1
fi
branch="rollback/${tag}-$(date +%y%m%d-%H%M)"
echo "되돌릴 곳: ${tag} ($(git log -1 --format='%h %s' "${tag}"))"
echo "새 브랜치: ${branch}"
echo "로컬 테스트 DB: 그 시점 마이그레이션 $(git ls-tree --name-only "${tag}" supabase/migrations/ | wc -l | tr -d ' ')개로 다시 만듦(데이터 초기화)"
if [ "$dry" = "--dry-run" ]; then echo "(시험 실행: 아무것도 바꾸지 않았습니다)"; exit 0; fi
git switch -c "${branch}" "${tag}" || exit 1
if supabase status >/dev/null 2>&1; then
  supabase db reset --local || { echo "로컬 DB 재생성 실패" >&2; exit 1; }
else
  echo "참고: 로컬 DB가 꺼져 있어 재생성은 건너뜀. npm run db:start 후 supabase db reset --local"
fi
echo "완료: ${branch}에서 ${tag} 상태로 확인할 수 있습니다. 개발 서버: npm run dev"
