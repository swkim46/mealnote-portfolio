-- v1.8.2 피드백 탭 '모두 읽음'(2026-10-29 회원 의견: 평가만 받은 식사도 하나씩 눌러야 알림 배지가 지워져 불편).
-- 화면에 새 피드백으로 보여 준 식사들만, 보여 준 가장 늦은 피드백 시각까지 읽음으로 옮긴다 — 그 뒤에 도착한 피드백은 새 피드백으로 남는다.
-- 읽음 시각은 뒤로 가지 않고 서버 시각보다 앞서지 않는다. 계정 잠금 → 세션 확인(다른 상태 변경 함수와 같은 순서).
create function public.mark_seen_many(p_meals uuid[], p_through timestamptz)
returns int language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_n int;
begin
  perform private.lock_account_and_check(v_uid);
  if p_meals is null or cardinality(p_meals) = 0 or cardinality(p_meals) > 500 or p_through is null then raise exception 'bad_request'; end if;
  update public.meals m set member_seen_at = greatest(m.member_seen_at, least(p_through, now()))
   where m.id = any(p_meals) and m.member_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.mark_seen_many(uuid[], timestamptz) from public, anon;
grant execute on function public.mark_seen_many(uuid[], timestamptz) to authenticated;
