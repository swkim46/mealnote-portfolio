-- v1.3 Codex 재검토(8ccc345) 대응.
-- (1) 복구 답·등록 코드 원문이 auth.identities.identity_data에 남았다 → 저장 전 제거 + 기존 행 정리
-- (2) 표준 Auth API(updateUser)로 지금 PIN·복구 답 없이 PIN을 바꿀 수 있었다 → 인증 서버 경로의 PIN 변경 차단
-- (3) 새로 로그인한 기기가 PIN을 한 번 더 바꿔 스스로 되찾기 자격을 만들었다 → 되찾기 기준 시각을 '아직 확인 안 된 첫 변경'으로 고정
-- (4) 되찾기로 세션을 지워도 남은 접근 토큰(최대 1시간)으로 데이터를 읽고 쓸 수 있었다 → 모든 데이터 접근에 '세션이 살아 있는가' 검사

-- ─── (1) identities에서 비밀 값 제거 ───
create function private.strip_identity_secrets()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.identity_data := new.identity_data - 'trainer_code' - 'recovery_answer' - 'recovery_question';
  return new;
end;
$$;
create trigger before_identity_strip_secrets
  before insert or update on auth.identities
  for each row execute function private.strip_identity_secrets();
update auth.identities set identity_data = identity_data - 'trainer_code' - 'recovery_answer' - 'recovery_question'
 where identity_data ?| array['trainer_code', 'recovery_answer', 'recovery_question'];
update auth.users set raw_user_meta_data = raw_user_meta_data - 'trainer_code' - 'recovery_answer' - 'recovery_question'
 where raw_user_meta_data ?| array['trainer_code', 'recovery_answer', 'recovery_question'];

-- ─── (2) 인증 서버 경로(updateUser·관리 API)의 PIN 변경 차단 ───
-- PIN은 이 DB의 함수(private.set_pin, 소유자 postgres)로만 바꾼다. 인증 서버는 supabase_auth_admin으로 접속한다.
-- 인증 서버는 로그인할 때 해시를 다시 쓰지 않는다(2026-10-21 로컬 확인).
create function private.guard_password_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password and current_user <> 'postgres' then
    raise exception 'pin_change_not_allowed';
  end if;
  return new;
end;
$$;
create trigger before_auth_user_guard_password
  before update on auth.users
  for each row execute function private.guard_password_change();

-- ─── (3) 되찾기 기준 시각 ───
alter table private.account_security add column reclaim_before timestamptz;

create or replace function private.set_pin(p_uid uuid, p_pin text)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_now timestamptz := now();
begin
  update auth.users set encrypted_password = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), updated_at = v_now where id = p_uid;
  -- reclaim_before는 아직 확인 안 된 '첫' 변경 시각에 고정한다(이후 변경으로 앞당기거나 미루지 않는다)
  insert into private.account_security (user_id, pin_changed_at, reclaim_before) values (p_uid, v_now, v_now)
  on conflict (user_id) do update
    set pin_changed_at = v_now, failed_count = 0, locked_until = null, updated_at = v_now,
        reclaim_before = coalesce(private.account_security.reclaim_before, v_now);
  return v_now;
end;
$$;

-- ─── (4) 세션이 살아 있는가 ───
create function private.session_ok()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s
     where s.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
       and s.user_id = (select auth.uid())
  );
$$;
revoke execute on function private.session_ok() from public, anon;
grant execute on function private.session_ok() to authenticated;

-- 기존 권한 규칙에 '그리고 세션이 살아 있을 것'을 덧붙인다(restrictive는 다른 규칙과 AND로 묶인다)
create policy session_alive on public.profiles     as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.assignments  as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.meals        as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.comments     as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.app_feedback as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive_meal_photos on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'meal-photos' or (select private.session_ok()))
  with check (bucket_id <> 'meal-photos' or (select private.session_ok()));

-- RLS를 건너뛰는(security definer) 함수에도 같은 검사
create or replace function public.mark_reviewed(p_meal uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  update public.meals m set reviewed_at = now(), reviewed_by = (select auth.uid())
   where m.id = p_meal and private.is_my_member(m.member_id);
  if not found then raise exception 'not_allowed'; end if;
end;
$$;

create or replace function public.mark_seen(p_meal uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  update public.meals m set member_seen_at = now() where m.id = p_meal and m.member_id = (select auth.uid());
  if not found then raise exception 'not_allowed'; end if;
end;
$$;

create or replace function public.change_my_pin(p_new_pin text, p_current_pin text default null, p_answer text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_res text; v_at timestamptz;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  if p_current_pin is not null then
    if not private.pin_matches(v_uid, p_current_pin) then return jsonb_build_object('status', 'wrong'); end if;
    if p_current_pin = p_new_pin then return jsonb_build_object('status', 'same'); end if;
  else
    v_res := private.check_answer(v_uid, p_answer);
    if v_res <> 'ok' then return jsonb_build_object('status', v_res); end if;
  end if;
  v_at := private.set_pin(v_uid, p_new_pin);
  insert into private.security_events (user_id, kind) values (v_uid, 'pin_changed');
  return jsonb_build_object('status', 'ok', 'pin_changed_at', v_at);
end;
$$;

create or replace function public.set_recovery(p_question int, p_answer text, p_current_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_a text := private.norm_answer(p_answer);
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if not private.pin_matches(v_uid, p_current_pin) then return jsonb_build_object('status', 'wrong'); end if;
  if p_question not between 1 and 6 or char_length(v_a) < 2 then return jsonb_build_object('status', 'bad_answer'); end if;
  insert into private.account_security (user_id, question, answer_hash) values (v_uid, p_question, extensions.crypt(v_a, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set question = excluded.question, answer_hash = excluded.answer_hash, failed_count = 0, locked_until = null, updated_at = now();
  insert into private.security_events (user_id, kind) values (v_uid, 'recovery_set');
  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.my_security_status()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare s private.account_security%rowtype;
begin
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  select * into s from private.account_security where user_id = (select auth.uid());
  return jsonb_build_object(
    'has_recovery', coalesce(s.answer_hash is not null, false),
    'question', s.question,
    'pin_changed_at', s.pin_changed_at,
    'failed_count', coalesce(s.failed_count, 0),
    'last_failed_at', s.last_failed_at,
    'locked_until', s.locked_until);
end;
$$;

create or replace function public.report_pin_not_me()
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  insert into private.security_events (user_id, kind) values ((select auth.uid()), 'reported_not_me');
end;
$$;

-- '네, 제가 바꿨어요': 변경 전부터 로그인돼 있던 기기가 확인하면 되찾기 창을 닫는다
create function public.ack_pin_change()
returns void language plpgsql security definer set search_path = ''
as $$
declare v_sess timestamptz; v_before timestamptz;
begin
  if (select auth.uid()) is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  select s.created_at into v_sess from auth.sessions s where s.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  select reclaim_before into v_before from private.account_security where user_id = (select auth.uid());
  if v_before is not null and v_sess < v_before then
    update private.account_security set reclaim_before = null where user_id = (select auth.uid());
  end if;
end;
$$;

-- 되찾기: '아직 확인 안 된 첫 변경' 전부터 있던 세션만
create or replace function public.reclaim_account(p_new_pin text, p_question int, p_answer text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  v_sess timestamptz; v_before timestamptz; v_a text := private.norm_answer(p_answer); v_at timestamptz;
begin
  if v_uid is null or v_sid is null then raise exception 'not_allowed'; end if;
  select s.created_at into v_sess from auth.sessions s where s.id = v_sid and s.user_id = v_uid;
  select reclaim_before into v_before from private.account_security where user_id = v_uid;
  if v_sess is null or v_before is null or v_sess >= v_before then raise exception 'not_allowed'; end if;
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  if p_question not between 1 and 6 or char_length(v_a) < 2 then return jsonb_build_object('status', 'bad_answer'); end if;
  v_at := private.set_pin(v_uid, p_new_pin);
  update private.account_security
     set question = p_question, answer_hash = extensions.crypt(v_a, extensions.gen_salt('bf', 10)), reclaim_before = null
   where user_id = v_uid;
  delete from auth.sessions where user_id = v_uid and id <> v_sid;
  insert into private.security_events (user_id, kind) values (v_uid, 'reclaimed');
  return jsonb_build_object('status', 'ok', 'pin_changed_at', v_at);
end;
$$;

create or replace function public.admin_security_events()
returns table (nickname text, kind text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.nickname, e.kind, e.created_at
    from private.security_events e join public.profiles p on p.id = e.user_id
   where private.is_admin() and private.session_ok() and e.kind in ('reported_not_me', 'reclaimed', 'recovery_locked')
   order by e.created_at desc limit 100;
$$;

revoke execute on function private.strip_identity_secrets(), private.guard_password_change() from public, anon, authenticated;
revoke execute on function public.ack_pin_change() from public, anon;
grant execute on function public.ack_pin_change() to authenticated;

-- ─── Codex P2: 오래된 식사에 새로 달린 트레이너 피드백이 회원 조회에서 빠짐 ───
alter table public.meals add column trainer_msg_at timestamptz;
update public.meals m set trainer_msg_at = (select max(c.created_at) from public.comments c where c.meal_id = m.id and c.author_role = 'trainer');
create index meals_trainer_msg_idx on public.meals (trainer_msg_at);
create or replace function private.comments_touch_meal()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_role = 'member' then
    update public.meals set member_msg_at = new.created_at where id = new.meal_id;
  else
    update public.meals set trainer_msg_at = new.created_at where id = new.meal_id;
  end if;
  return new;
end;
$$;
