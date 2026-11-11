-- 추천 식단에 닉네임을 보인다(사용자 11-06). 공개 여부는 수상과 같은 profiles.award_public을 쓴다.
-- 끄면 다른 사람에게는 '익명 회원', 본인에게는 자기 닉네임. 돌려주는 칸이 늘어 지우고 다시 만든다.
drop function public.shared_meals(integer);

create function public.shared_meals(p_limit integer default 20)
returns table (id uuid, eaten_on date, meal_type text, food text, rating smallint, photo_path text, shared_at timestamptz, mine boolean, nickname text)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.eaten_on, m.meal_type, m.food, m.rating, m.photo_path, m.shared_at, m.member_id = (select auth.uid()),
         case when o.award_public or m.member_id = (select auth.uid()) then o.nickname else '익명 회원' end
    from public.meals m
    join public.assignments a on a.member_id = m.member_id
    join public.profiles o on o.id = m.member_id
   where private.share_active(m.shared_at) and o.share_consent
     and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer()
   order by m.shared_at desc, m.id
   limit least(greatest(coalesce(p_limit, 20), 1), 30);
$$;

revoke all on function public.shared_meals(integer) from public, anon;
grant execute on function public.shared_meals(integer) to authenticated;
