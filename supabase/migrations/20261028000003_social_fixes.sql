-- v1.8 Codex 리뷰(2026-10-28) 조치
-- 1) 사진 경로: 식사의 photo_path는 회원이 고칠 수 있는 칸이라, 그 경로가 그 회원 폴더인지 DB가 지킨다.
--    자기 공유 식사의 경로를 남의 사진으로 바꿔 그 회원의 동의 철회를 우회하던 문제(리뷰 1).
-- 2) 공유 사진은 저장소 읽기 권한(→ 서명 주소)을 주지 않는다. 서명 주소는 동의를 꺼도 만료 전까지 열린다(리뷰 3).
--    서버 기능 shared-photo가 요청마다 shared_photo_path로 지금 권한을 확인하고 내려준다.
-- 3) 새 상태 변경 함수도 기존 규칙(계정 잠금 → 세션 확인 → 업무 행 잠금)을 따른다. 계정 되찾기가 끝난 뒤
--    옛 기기에서 대기하던 요청이 완료되지 않게(리뷰 2).
-- 4) 공유와 동의 끄기는 그 회원의 profiles 행을 같은 순서(profiles → meals)로 잠근다. 겹쳐도 옛 공유가 남지 않게(리뷰 4).
-- 5) 내 좋아요 조회는 저장과 같은 기준(지금 담당 트레이너의 그날 한마디)으로(리뷰 6).

alter table public.meals add constraint meals_photo_in_own_folder
  check (photo_path is null or split_part(photo_path, '/', 1) = member_id::text);

drop policy meal_photos_shared_select on storage.objects;
drop function private.can_read_shared_photo(text);

create function public.shared_photo_path(p_meal uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.photo_path from public.meals m
    join public.assignments a on a.member_id = m.member_id
    join public.profiles o on o.id = m.member_id
   where m.id = p_meal and m.photo_path is not null and m.shared_at is not null and o.share_consent
     and split_part(m.photo_path, '/', 1) = m.member_id::text
     and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer();
$$;

-- 계정 잠금 → 세션 확인(다른 상태 변경 함수와 같은 순서)
create function private.lock_account_and_check(p_uid uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_uid is null then raise exception 'not_allowed'; end if;
  insert into private.account_security (user_id) values (p_uid) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_uid for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
end;
$$;

create or replace function public.set_message_like(p_day date, p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid;
begin
  perform private.lock_account_and_check(v_uid);
  select a.trainer_id into v_trainer from public.assignments a where a.member_id = v_uid for update;
  if v_trainer is null then raise exception 'not_allowed'; end if;
  if p_day is null or p_day not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  if p_on then
    if not exists (select 1 from public.trainer_messages tm where tm.trainer_id = v_trainer and tm.day = p_day) then
      raise exception 'no_message';
    end if;
    insert into public.trainer_message_likes (trainer_id, day, member_id) values (v_trainer, p_day, v_uid)
    on conflict do nothing;
  else
    delete from public.trainer_message_likes l where l.trainer_id = v_trainer and l.day = p_day and l.member_id = v_uid;
  end if;
end;
$$;

create function public.my_message_like(p_day date)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.assignments a
      join public.trainer_message_likes l on l.trainer_id = a.trainer_id and l.member_id = a.member_id
     where a.member_id = (select auth.uid()) and private.session_ok() and l.day = p_day
  );
$$;

create or replace function public.set_share_consent(p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  perform 1 from public.profiles p where p.id = v_uid and p.role = 'member' for update;
  if not found then raise exception 'not_allowed'; end if;
  update public.profiles set share_consent = coalesce(p_on, false) where id = v_uid;
  if not coalesce(p_on, false) then
    update public.meals set shared_at = null, shared_by = null where member_id = v_uid and shared_at is not null;
  end if;
end;
$$;

create or replace function public.share_meal(p_meal uuid, p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_member uuid; v_consent boolean;
begin
  perform private.lock_account_and_check(v_uid);
  -- 식사의 회원은 바뀌지 않는 칸이라 잠그기 전에 읽어도 된다. 잠금은 동의 끄기와 같은 순서: 회원 profiles → 식사
  select m.member_id into v_member from public.meals m where m.id = p_meal;
  if v_member is null or not private.is_my_member(v_member) then raise exception 'not_allowed'; end if;
  select p.share_consent into v_consent from public.profiles p where p.id = v_member for share;
  perform 1 from public.meals m where m.id = p_meal and m.member_id = v_member for update;
  if not found or not private.is_my_member(v_member) then raise exception 'not_allowed'; end if;
  if p_on then
    if not coalesce(v_consent, false) then raise exception 'no_consent'; end if;
    update public.meals set shared_at = now(), shared_by = v_uid where id = p_meal;
  else
    update public.meals set shared_at = null, shared_by = null where id = p_meal;
  end if;
end;
$$;

create or replace function public.remove_member(p_member uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid;
begin
  perform private.lock_account_and_check(v_uid);
  select a.trainer_id into v_trainer from public.assignments a where a.member_id = p_member for update;
  if v_trainer is distinct from v_uid then raise exception 'not_allowed'; end if;
  delete from public.assignments where member_id = p_member;
  insert into private.member_removals (member_id, trainer_id) values (p_member, v_uid)
  on conflict (member_id, trainer_id) do update set removed_at = now();
  insert into private.security_events (user_id, kind, actor_id) values (p_member, 'member_removed', v_uid);
end;
$$;

create or replace function public.choose_trainer(p_trainer uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  perform 1 from public.profiles p where p.id = v_uid and p.role = 'member' for update;
  if not found then raise exception 'not_allowed'; end if;
  if exists (select 1 from public.assignments a where a.member_id = v_uid) then raise exception 'already_assigned'; end if;
  if not exists (select 1 from public.trainers_for_me() t where t.id = p_trainer) then raise exception 'not_allowed'; end if;
  insert into public.assignments (member_id, trainer_id) values (v_uid, p_trainer);
end;
$$;

revoke execute on function private.lock_account_and_check(uuid) from public, anon, authenticated;
revoke execute on function public.shared_photo_path(uuid), public.my_message_like(date) from public, anon;
grant execute on function public.shared_photo_path(uuid), public.my_message_like(date) to authenticated;
