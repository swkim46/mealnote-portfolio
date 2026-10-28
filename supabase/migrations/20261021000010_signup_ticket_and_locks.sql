-- Codex 재검토(f0e8c9f) 대응.
-- (1) P1 가입 직후 응답·JWT·저장 세션에 등록 코드·복구 답 원문이 남았다(인증 서버 가입 정보로 보냈기 때문).
--     → 가입 전에 begin_signup이 코드·답을 확인하고 답은 해시로만 보관, 한 번만 쓰는 '가입권'만 돌려준다.
--       인증 서버에는 닉네임과 가입권만 보낸다. 가입권 없이 오는 가입은 거부한다.
-- (2) P1 동시 되찾기 두 건이 모두 성공해 세션이 0개가 됐다(자격 확인이 잠금 전에 끝남).
--     → 계정 단위 잠금(account_security 행)을 먼저 잡고 그 안에서 세션·자격을 다시 확인한다.
--       PIN을 바꾸는 모든 경로가 같은 순서(account_security → auth.users)로 잠가 교착을 피한다.

-- ─── (1) 가입권 ───
create table private.signup_tickets (
  ticket_hash  text primary key,
  nickname     text not null,
  role         text not null check (role in ('member', 'trainer', 'admin')),
  trainer_id   uuid,
  question     smallint not null check (question between 1 and 6),
  answer_hash  text not null,
  created_at   timestamptz not null default now()
);
revoke all on private.signup_tickets from public, anon, authenticated;

create function public.begin_signup(p_nickname text, p_role text, p_question int, p_answer text, p_trainer_code text default null, p_trainer_id uuid default null)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_nick text := btrim(normalize(coalesce(p_nickname, ''), NFC));
  v_a text := private.norm_answer(p_answer);
  v_role text := coalesce(p_role, '');
  v_hash text; v_ticket text;
begin
  delete from private.signup_tickets where created_at < now() - interval '30 minutes';
  if char_length(v_nick) not between 2 and 20 then raise exception 'invalid_nickname'; end if;
  if exists (select 1 from public.profiles p where lower(p.nickname) = lower(v_nick)) then raise exception 'nickname_taken'; end if;
  if p_question is null or p_question not between 1 and 6 or char_length(v_a) < 2 then raise exception 'invalid_recovery'; end if;
  if v_role = 'trainer' then
    v_hash := encode(extensions.digest(upper(btrim(coalesce(p_trainer_code, ''))), 'sha256'), 'hex');
    if v_hash = (select s.value from public.app_settings s where s.key = 'admin_code_sha256') then
      v_role := 'admin';
    elsif v_hash is distinct from (select s.value from public.app_settings s where s.key = 'trainer_code_sha256') then
      raise exception 'invalid_trainer_code';
    end if;
  elsif v_role = 'member' then
    if p_trainer_id is null or not exists (select 1 from public.profiles p where p.id = p_trainer_id and p.role = 'trainer') then
      raise exception 'invalid_trainer';
    end if;
  else
    raise exception 'invalid_role';
  end if;
  v_ticket := encode(extensions.gen_random_bytes(24), 'hex');
  insert into private.signup_tickets (ticket_hash, nickname, role, trainer_id, question, answer_hash)
  values (encode(extensions.digest(v_ticket, 'sha256'), 'hex'), v_nick, v_role,
          case when v_role = 'member' then p_trainer_id end, p_question, extensions.crypt(v_a, extensions.gen_salt('bf', 10)));
  return v_ticket;
end;
$$;
revoke execute on function public.begin_signup(text, text, int, text, text, uuid) from public;
grant execute on function public.begin_signup(text, text, int, text, text, uuid) to anon, authenticated;

-- 가입 처리: 가입권으로만. 역할·담당 트레이너·복구 답은 가입권에서 가져온다(인증 서버 가입 정보의 값은 믿지 않는다).
create or replace function public.validate_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket text := coalesce(new.raw_user_meta_data ->> 'signup_ticket', '');
  v_nick text := btrim(normalize(coalesce(new.raw_user_meta_data ->> 'nickname', ''), NFC));
  t private.signup_tickets%rowtype;
begin
  delete from private.signup_tickets
   where ticket_hash = encode(extensions.digest(v_ticket, 'sha256'), 'hex')
     and created_at >= now() - interval '30 minutes'
  returning * into t;
  if t.ticket_hash is null or lower(t.nickname) <> lower(v_nick) then
    raise exception 'invalid_signup';
  end if;
  if t.role = 'member' and not exists (select 1 from public.profiles p where p.id = t.trainer_id and p.role = 'trainer') then
    raise exception 'invalid_trainer';
  end if;

  insert into private.account_security (user_id, question, answer_hash) values (new.id, t.question, t.answer_hash);

  new.raw_user_meta_data := (new.raw_user_meta_data - 'signup_ticket' - 'trainer_code' - 'recovery_answer' - 'recovery_question' - 'trainer_id')
    || jsonb_build_object('nickname', t.nickname, 'role', t.role)
    || case when t.role = 'member' then jsonb_build_object('trainer_id', t.trainer_id) else '{}'::jsonb end;
  return new;
end;
$$;
revoke execute on function public.validate_new_user() from public, anon, authenticated;

-- DB 사본에서도 가입권을 지운다
create or replace function private.strip_trainer_code()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.raw_user_meta_data := new.raw_user_meta_data - 'trainer_code' - 'recovery_answer' - 'recovery_question' - 'signup_ticket';
  return new;
end;
$$;
create or replace function private.strip_identity_secrets()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.identity_data := new.identity_data - 'trainer_code' - 'recovery_answer' - 'recovery_question' - 'signup_ticket';
  return new;
end;
$$;

-- ─── (2) 잠금 순서: account_security 행 → auth.users ───
create or replace function private.apply_pin(p_uid uuid, p_pin text, p_open_window boolean)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_now timestamptz := now(); v_before timestamptz;
begin
  insert into private.account_security (user_id) values (p_uid) on conflict (user_id) do nothing;
  select reclaim_before into v_before from private.account_security where user_id = p_uid for update;
  if p_open_window and (
       v_before is null
       or not exists (select 1 from auth.sessions s where s.user_id = p_uid and s.created_at < v_before)
     ) then
    v_before := v_now;
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), updated_at = v_now where id = p_uid;
  update private.account_security
     set pin_changed_at = v_now, failed_count = 0, locked_until = null, updated_at = v_now, reclaim_before = v_before
   where user_id = p_uid;
  return v_now;
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
  if v_uid is null or v_sid is null then raise exception 'not_allowed'; end if;
  -- 계정 단위 잠금을 먼저 잡는다. 앞선 되찾기가 이 세션을 지웠다면 아래 확인에서 걸린다.
  perform 1 from private.account_security where user_id = v_uid for update;
  if not private.session_ok() or not private.can_reclaim(v_uid) then raise exception 'not_allowed'; end if;
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

-- '네, 제가 바꿨어요'도 같은 잠금 안에서
create or replace function public.ack_pin_change()
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_allowed'; end if;
  perform 1 from private.account_security where user_id = (select auth.uid()) for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  if private.can_reclaim((select auth.uid())) then
    update private.account_security set reclaim_before = null where user_id = (select auth.uid());
  end if;
end;
$$;
