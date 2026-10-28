-- v1.4 단계 2: 식단 3단계 평가. 트레이너가 글 대신 세 단계 중 하나를 고른다.
--   1 너무 좋아요(100) · 2 좋은데 조금 더 잘해 봐요(60) · 3 조금 신경 써 주세요(20)
-- 평가를 고르면 확인 완료로 치고(답변 대기도 정리), 회원에게는 새 피드백으로 알린다.
alter table public.meals
  add column rating smallint check (rating between 1 and 3),
  add column rated_at timestamptz,
  add column rated_by uuid references public.profiles(id) on delete set null;

-- 읽기만 열고, 쓰기는 rate_meal 함수로만(앱 쓰기 권한은 칸 단위로 이미 좁혀 두었다)
grant select (rating, rated_at) on public.meals to authenticated;

-- 결산 점수는 여기 한 곳에서만 정한다
create function private.rating_score(p_rating smallint)
returns int language sql immutable set search_path = ''
as $$ select case p_rating when 1 then 100 when 2 then 60 when 3 then 20 end $$;
revoke execute on function private.rating_score(smallint) from public, anon;
grant execute on function private.rating_score(smallint) to authenticated;

create function public.rate_meal(p_meal uuid, p_rating int)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_at timestamptz := now();
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  -- 계정 상태가 바뀌는 중이면 끝날 때까지 기다린 뒤 세션을 본다(다른 상태 변경 함수와 같은 순서)
  insert into private.account_security (user_id) values (v_uid) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = v_uid for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_rating is null or p_rating not between 1 and 3 then raise exception 'bad_rating'; end if;
  -- 식사 행을 먼저 잠그고 담당인지 본다
  perform 1 from public.meals m where m.id = p_meal for update;
  update public.meals m
     set rating = p_rating, rated_at = v_at, rated_by = v_uid,
         reviewed_at = v_at, reviewed_by = v_uid,
         trainer_msg_at = v_at
   where m.id = p_meal and private.is_my_member(m.member_id);
  if not found then raise exception 'not_allowed'; end if;
  return jsonb_build_object('rating', p_rating, 'rated_at', v_at);
end;
$$;
revoke execute on function public.rate_meal(uuid, int) from public, anon;
grant execute on function public.rate_meal(uuid, int) to authenticated;
