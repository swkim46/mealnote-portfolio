#!/bin/sh
# 시험 계정(zz검증…)과 그 사진을 지운다.  사용: sh scripts/cleanup-test-users.sh local|linked
target="${1:-local}"
supabase db query --"$target" "delete from auth.users where raw_user_meta_data->>'nickname' like 'zz검증%';" >/dev/null
supabase db query --"$target" "delete from public.app_feedback where body like '검증 의견%' or body like 'zz검증 의견%';" >/dev/null
echo "시험 계정 정리 완료 ($target)"
