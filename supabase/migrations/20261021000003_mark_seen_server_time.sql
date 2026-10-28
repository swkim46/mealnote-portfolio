-- 회원이 피드백을 읽은 시각(member_seen_at)을 회원 기기 시계로 적고 있었다.
-- 트레이너 댓글 시각은 서버 시계라, 기기 시계가 몇 초만 늦어도 '새 피드백' 표시가 사라지지 않았다(2026-10-21 발견).
-- 읽음 표시는 서버 시각으로만 기록한다.
create function public.mark_seen(p_meal uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.meals m
     set member_seen_at = now()
   where m.id = p_meal and m.member_id = (select auth.uid());
  if not found then
    raise exception 'not_allowed';
  end if;
end;
$$;
revoke execute on function public.mark_seen(uuid) from public, anon;
grant execute on function public.mark_seen(uuid) to authenticated;

-- 앱이 기기 시각을 직접 넣지 못하게 한다
revoke update (member_seen_at) on public.meals from authenticated;
