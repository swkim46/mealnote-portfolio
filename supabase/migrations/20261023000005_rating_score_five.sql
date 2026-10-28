-- v1.4 사용자 결정(2026-10-23): 식단 평가 점수는 5점 만점. 아주 좋아요 5 · 좋아요, 조금만 더 3 · 조절이 필요해요 1(평가 칸 1·2·3 순서).
-- 평가 칸(meals.rating 1~3)은 그대로라 저장된 평가는 옮길 필요가 없다. 환산과 평균(소수 첫째 자리)만 바꾼다.
create or replace function private.rating_score(p_rating smallint)
returns int language sql immutable set search_path = ''
as $$ select case p_rating when 1 then 5 when 2 then 3 when 3 then 1 end $$;

create or replace function public.diet_report(p_member uuid, p_from date, p_to date)
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
    'score', round(avg(private.rating_score(m.rating)), 1)
  ) into v
  from public.meals m
  where m.member_id = p_member and m.eaten_on between p_from and p_to;
  return v;
end;
$$;
