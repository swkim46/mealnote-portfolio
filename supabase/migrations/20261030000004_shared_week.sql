-- v2.0 이번 주 추천 식단(2026-10-30 사용자 결정): 트레이너가 공유한 식사는 공유한 때부터 7일 동안만 보인다.
--  - 7일이 지나면 목록(shared_meals)에서 내려가고, 그 사진을 여는 권한(meal_photo_path의 공유 경로)도 함께 끊긴다.
--  - 트레이너가 다시 공유하면 그때부터 다시 7일(share_meal이 shared_at을 지금으로 바꾼다 — 기존 동작 그대로).
--  - 기준은 private.share_active 한 곳. 1.8 화면도 같은 함수를 쓰므로 1.8에서도 7일 뒤 내려간다.
create function private.share_active(p_at timestamptz)
returns boolean language sql stable set search_path = ''
as $$ select p_at is not null and p_at > now() - interval '7 days' $$;
revoke execute on function private.share_active(timestamptz) from public, anon;

create or replace function public.shared_meals(p_limit integer default 20)
returns table (id uuid, eaten_on date, meal_type text, food text, rating smallint, photo_path text, shared_at timestamptz, mine boolean)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.eaten_on, m.meal_type, m.food, m.rating, m.photo_path, m.shared_at, m.member_id = (select auth.uid())
    from public.meals m
    join public.assignments a on a.member_id = m.member_id
    join public.profiles o on o.id = m.member_id
   where private.share_active(m.shared_at) and o.share_consent
     and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer()
   order by m.shared_at desc, m.id
   limit least(greatest(coalesce(p_limit, 20), 1), 30);
$$;

create or replace function public.meal_photo_path(p_meal uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.photo_path from public.meals m
   where m.id = p_meal and m.photo_path is not null and private.session_ok()
     and split_part(m.photo_path, '/', 1) = m.member_id::text
     and (
       m.member_id = (select auth.uid())
       or private.is_my_member(m.member_id)
       or exists (
         select 1 from public.assignments a join public.profiles o on o.id = m.member_id
          where a.member_id = m.member_id and private.share_active(m.shared_at) and o.share_consent
            and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer()
       )
     );
$$;
