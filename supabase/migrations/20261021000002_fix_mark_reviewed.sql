-- 0002에서 is_my_member를 private 스키마로 옮겼지만, mark_reviewed 본문은 이름으로 함수를 찾아서
-- 'public.is_my_member does not exist' 오류로 항상 실패했다(정책은 OID로 참조해서 영향 없음).
-- 검증이 "남의 회원 확인 거부"만 보고 있어 이 오류를 거부로 오인했다. 2026-10-21 발견.
create or replace function public.mark_reviewed(p_meal uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.meals m
     set reviewed_at = now(), reviewed_by = (select auth.uid())
   where m.id = p_meal and private.is_my_member(m.member_id);
  if not found then
    raise exception 'not_allowed';
  end if;
end;
$$;
revoke execute on function public.mark_reviewed(uuid) from public, anon;
grant execute on function public.mark_reviewed(uuid) to authenticated;
