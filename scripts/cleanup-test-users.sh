#!/bin/sh
# 시험 계정(zz검증…)과 시험 의견을 지운다.  사용: sh scripts/cleanup-test-users.sh local|linked [실행 번호]
# 실행 번호를 주면 그 실행이 만든 것만 지운다(시험 닉네임·의견에 실행 번호가 들어 있다). 같은 로컬 DB에서 다른 검증(다른 세션·Codex 리뷰)이
# 돌고 있어도 그쪽 자료를 지우지 않는다(Codex v2.0.0 정식 2차 리뷰). 번호 없이 부르면 zz검증 전부 — 손으로 정리할 때만 쓴다.
# 정리에 실패하면 '완료'를 찍지 않고 실패로 끝낸다.
target="${1:-local}"
run="${2:-}"
if [ -n "$run" ] && ! printf '%s' "$run" | grep -Eq '^[a-z0-9]{4,12}$'; then
  echo "정리 중단: 실행 번호는 영문 소문자·숫자 4～12자입니다('$run')." >&2
  exit 1
fi
# 닉네임은 대소문자를 가리지 않는 시험(ZZ검증…)이 있어 ilike로 고른다 — like로 고르면 그 회원이 빠지고, 그 회원을 맡은 트레이너도
# 담당 관계(assignments) 때문에 지워지지 않아 정리 전체가 실패했다(옛 스크립트는 이 실패를 숨겨 로컬 DB에 시험 계정이 쌓였다, 2026-11-01)
users="delete from auth.users where raw_user_meta_data->>'nickname' ilike 'zz검증%'"
feedback="delete from public.app_feedback where (body like '검증 의견%' or body ilike 'zz검증 의견%')"
if [ -n "$run" ]; then
  users="$users and raw_user_meta_data->>'nickname' ilike '%${run}%'"
  feedback="$feedback and body ilike '%${run}%'"
fi
if ! supabase db query --"$target" "$users;" >/dev/null || ! supabase db query --"$target" "$feedback;" >/dev/null; then
  echo "시험 자료 정리 실패 ($target${run:+ · 실행 $run})" >&2
  exit 1
fi
echo "시험 계정 정리 완료 ($target${run:+ · 실행 $run})"
