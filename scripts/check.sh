#!/bin/sh
# 로컬 Supabase에 대고 권한 검증과 화면 흐름 검증을 돌린 뒤 시험 계정을 지운다.
# 사용: sh scripts/check.sh [unit|component|backend|race|push|update|ocr|e2e|all]
cd "$(dirname "$0")/.." || exit 1
what="${1:-all}"
if ! supabase status >/dev/null 2>&1; then
  echo "로컬 Supabase가 꺼져 있습니다. 먼저 npm run db:start" >&2
  exit 1
fi
status=0
if [ "$what" = unit ] || [ "$what" = all ]; then
  echo "── 규칙 검증 (결산 한 줄 정리·인바디 숫자 고르기)"
  node scripts/unit-check.mjs || status=1
fi
if [ "$what" = component ] || [ "$what" = all ]; then
  echo "── 화면 조각 검증 (서버 응답을 가로채 경계 상황 재현, DB 안 씀)"
  node scripts/component-check.mjs || status=1
fi
if [ "$what" = backend ] || [ "$what" = all ]; then
  echo "── 권한 검증 (로컬 DB)"
  node --env-file=.env.development.local --env-file=.env.local scripts/backend-check.mjs || status=1
  sh scripts/cleanup-test-users.sh local
fi
if [ "$what" = race ] || [ "$what" = all ]; then
  echo "── 경쟁 상황 검증 (로컬 DB, 행 잠금으로 요청을 겹치게 함)"
  node --env-file=.env.development.local --env-file=.env.local scripts/race-check.mjs || status=1
  sh scripts/cleanup-test-users.sh local
fi
if [ "$what" = push ] || [ "$what" = all ]; then
  echo "── 알림 검증 (로컬 DB·로컬 서버 기능·시험 수신 서버, 실제 휴대폰 아님)"
  node scripts/push-local-setup.mjs >/dev/null || status=1
  node --env-file=.env.development.local --env-file=.env.local scripts/push-check.mjs || status=1
  sh scripts/cleanup-test-users.sh local
  echo "── 휴대폰 시험 빌드의 DB 보호 (운영 주소가 들어오면 빌드·터널 중단)"
  node scripts/phonetest-guard-check.mjs || status=1
fi
if [ "$what" = update ] || [ "$what" = all ]; then
  echo "── 새 버전 적용 검증 (실제 빌드를 번갈아 띄움)"
  node --env-file=.env.development.local --env-file=.env.local scripts/update-check.mjs || status=1
  sh scripts/cleanup-test-users.sh local
fi
if [ "$what" = ocr ] || [ "$what" = all ]; then
  echo "── 인바디 글자 인식 검증 (가짜 결과지, 기기 안 인식·외부 전송 없음)"
  # 받은 결과지로도 확인하려면 INBODY_SAMPLE·INBODY_EXPECT를 함께 준다(scripts/ocr-check.mjs 참고)
  node scripts/ocr-check.mjs || status=1
fi
if [ "$what" = e2e ] || [ "$what" = all ]; then
  echo "── 화면 흐름 검증 (로컬 개발 서버 + 로컬 DB)"
  node --env-file=.env.local scripts/e2e-flow.mjs || status=1
fi
sh scripts/cleanup-test-users.sh local
exit $status
