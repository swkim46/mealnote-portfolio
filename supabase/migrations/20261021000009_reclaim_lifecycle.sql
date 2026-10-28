-- Codex 재검토(25480f2) P1: '되찾기 기준 시각(reclaim_before)'이 너무 오래 남아,
-- 정상 PIN 변경·정상 복구 뒤 다시 로그인한 본인 기기가 나중 공격 때 되찾기를 못 했다.
-- 새 규칙:
--   · 기준 시각은 로그인 없이 복구 질문으로 PIN을 바꿀 때만 연다(로그인한 상태의 변경은 본인 확인을 거쳤으므로 열지 않는다).
--   · 이미 열려 있어도, 그보다 먼저 로그인돼 있던 기기가 하나도 남아 있지 않으면 그 기준은 의미가 없으니 새 변경 시각으로 옮긴다.
--   · 먼저 로그인돼 있던 기기가 남아 있는 동안에는 옮기지 않는다(공격자가 새 기기에서 거듭 바꿔 자격을 만드는 것을 막는다).
--   · '네, 제가 바꿨어요'(그 이전 기기) 또는 되찾기 완료로 닫는다.

create function private.apply_pin(p_uid uuid, p_pin text, p_open_window boolean)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_now timestamptz := now(); v_before timestamptz;
begin
  update auth.users set encrypted_password = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), updated_at = v_now where id = p_uid;
  insert into private.account_security (user_id) values (p_uid) on conflict (user_id) do nothing;
  select reclaim_before into v_before from private.account_security where user_id = p_uid for update;
  if p_open_window and (
       v_before is null
       or not exists (select 1 from auth.sessions s where s.user_id = p_uid and s.created_at < v_before)
     ) then
    v_before := v_now;
  end if;
  update private.account_security
     set pin_changed_at = v_now, failed_count = 0, locked_until = null, updated_at = v_now, reclaim_before = v_before
   where user_id = p_uid;
  return v_now;
end;
$$;
revoke execute on function private.apply_pin(uuid, text, boolean) from public, anon, authenticated;

-- 이 세션이 되찾기를 할 수 있는가
create function private.can_reclaim(p_uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s join private.account_security a on a.user_id = s.user_id
     where s.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
       and s.user_id = p_uid and a.reclaim_before is not null and s.created_at < a.reclaim_before
  );
$$;
revoke execute on function private.can_reclaim(uuid) from public, anon, authenticated;

create or replace function public.reset_pin_with_answer(p_nickname text, p_answer text, p_new_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid; v_res text; v_s private.account_security%rowtype;
begin
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  select p.id into v_uid from public.profiles p where lower(p.nickname) = lower(btrim(p_nickname));
  if v_uid is null then return jsonb_build_object('status', 'no_recovery'); end if;
  v_res := private.check_answer(v_uid, p_answer);
  if v_res = 'ok' then
    perform private.apply_pin(v_uid, p_new_pin, true);
    insert into private.security_events (user_id, kind) values (v_uid, 'pin_reset_by_answer');
    return jsonb_build_object('status', 'ok');
  end if;
  select * into v_s from private.account_security where user_id = v_uid;
  return jsonb_build_object('status', v_res, 'remaining', greatest(0, 5 - coalesce(v_s.failed_count, 0)), 'locked_until', v_s.locked_until);
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
  v_at := private.apply_pin(v_uid, p_new_pin, false);
  insert into private.security_events (user_id, kind) values (v_uid, 'pin_changed');
  return jsonb_build_object('status', 'ok', 'pin_changed_at', v_at);
end;
$$;

create or replace function public.reclaim_account(p_new_pin text, p_question int, p_answer text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  v_a text := private.norm_answer(p_answer); v_at timestamptz;
begin
  if v_uid is null or v_sid is null or not private.can_reclaim(v_uid) then raise exception 'not_allowed'; end if;
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  if p_question not between 1 and 6 or char_length(v_a) < 2 then return jsonb_build_object('status', 'bad_answer'); end if;
  v_at := private.apply_pin(v_uid, p_new_pin, false);
  update private.account_security
     set question = p_question, answer_hash = extensions.crypt(v_a, extensions.gen_salt('bf', 10)), reclaim_before = null
   where user_id = v_uid;
  delete from auth.sessions where user_id = v_uid and id <> v_sid;
  insert into private.security_events (user_id, kind) values (v_uid, 'reclaimed');
  return jsonb_build_object('status', 'ok', 'pin_changed_at', v_at);
end;
$$;

create or replace function public.ack_pin_change()
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if private.can_reclaim((select auth.uid())) then
    update private.account_security set reclaim_before = null where user_id = (select auth.uid());
  end if;
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
    'locked_until', s.locked_until,
    'can_reclaim', private.can_reclaim((select auth.uid())));
end;
$$;

-- 예전 함수는 더 이상 쓰지 않는다
drop function private.set_pin(uuid, text);
-- 기존에 열려 있던 기준은 새 규칙으로 다시 시작(로그인 상태 변경으로 열린 것일 수 있다)
update private.account_security set reclaim_before = null;
