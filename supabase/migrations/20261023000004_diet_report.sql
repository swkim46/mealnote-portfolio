-- v1.4 단계 4: 결산 — 두 인바디 측정 사이의 식단 기록·평가를 서버에서 센다(기간이 앱이 받아 두는 60일보다 길 수 있다).
-- 회원 본인과 담당 트레이너만. 점수는 private.rating_score 한 곳에서 정한다.
create function public.diet_report(p_member uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 730 then raise exception 'bad_range'; end if;
  select jsonb_build_object(
    'days', p_to - p_from + 1,
    'logged_days', count(distinct m.eaten_on),
    'meals', count(*),
    'great', count(*) filter (where m.rating = 1),
    'good', count(*) filter (where m.rating = 2),
    'care', count(*) filter (where m.rating = 3),
    'rated', count(m.rating),
    'score', round(avg(private.rating_score(m.rating)))::int
  ) into v
  from public.meals m
  where m.member_id = p_member and m.eaten_on between p_from and p_to;
  return v;
end;
$$;
revoke execute on function public.diet_report(uuid, date, date) from public, anon;
grant execute on function public.diet_report(uuid, date, date) to authenticated;
