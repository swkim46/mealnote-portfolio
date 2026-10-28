-- v1.3: PIN 재설정을 '복구 질문' 방식으로 바꾼다(2026-10-21 사용자 결정).
-- 트레이너가 회원 PIN을 만들어 주던 기능은 회원 몰래 계정을 가져갈 수 있어서(Codex 리뷰 P1) 없앤다.
-- 회원만 아는 답을 맞히면 회원이 직접 새 PIN을 정한다. 답을 잊고 로그아웃 상태면 되찾을 수 없다(새로 가입).

-- ─── 1. 트레이너 재설정 제거 ───
drop function if exists public.reset_member_pin(uuid);
drop function if exists public.request_pin_reset(text, uuid);
drop table if exists public.pin_reset_requests;

-- ─── 2. 계정 보안 정보(앱에서 직접 읽거나 쓸 수 없는 private 스키마) ───
create table private.account_security (
  user_id         uuid primary key references auth.users(id) on delete cascade deferrable initially deferred,
  question        smallint check (question between 1 and 6),
  answer_hash     text,
  failed_count    int not null default 0,
  last_failed_at  timestamptz,
  locked_until    timestamptz,
  pin_changed_at  timestamptz,
  updated_at      timestamptz not null default now()
);
create table private.security_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('pin_reset_by_answer', 'pin_changed', 'recovery_set', 'recovery_locked', 'reported_not_me', 'reclaimed')),
  created_at  timestamptz not null default now()
);
revoke all on private.account_security, private.security_events from public, anon, authenticated;

-- 답 비교: 유니코드 정규화 + 공백 제거 + 소문자
create function private.norm_answer(p text)
returns text language sql immutable set search_path = ''
as $$ select lower(regexp_replace(normalize(coalesce(p, ''), NFC), '\s+', '', 'g')) $$;

create function private.pin_matches(p_uid uuid, p_pin text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from auth.users u where u.id = p_uid and u.encrypted_password = extensions.crypt(p_pin, u.encrypted_password)) $$;

create function private.set_pin(p_uid uuid, p_pin text)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_now timestamptz := now();
begin
  update auth.users set encrypted_password = extensions.crypt(p_pin, extensions.gen_salt('bf')), updated_at = v_now where id = p_uid;
  insert into private.account_security (user_id, pin_changed_at) values (p_uid, v_now)
  on conflict (user_id) do update set pin_changed_at = v_now, failed_count = 0, locked_until = null, updated_at = v_now;
  return v_now;
end;
$$;

-- 답 확인(실패 횟수 세기 포함). 반환: ok | wrong | locked | no_recovery
create function private.check_answer(p_uid uuid, p_answer text)
returns text language plpgsql security definer set search_path = ''
as $$
declare s private.account_security%rowtype;
begin
  select * into s from private.account_security where user_id = p_uid for update;
  if not found or s.answer_hash is null then return 'no_recovery'; end if;
  if s.locked_until is not null and s.locked_until > now() then return 'locked'; end if;
  if s.locked_until is not null and s.locked_until <= now() then
    update private.account_security set failed_count = 0, locked_until = null where user_id = p_uid;
    s.failed_count := 0;
  end if;
  if extensions.crypt(private.norm_answer(p_answer), s.answer_hash) = s.answer_hash then
    update private.account_security set failed_count = 0 where user_id = p_uid;
    return 'ok';
  end if;
  update private.account_security
     set failed_count = s.failed_count + 1, last_failed_at = now(),
         locked_until = case when s.failed_count + 1 >= 5 then now() + interval '24 hours' end
   where user_id = p_uid;
  if s.failed_count + 1 >= 5 then
    insert into private.security_events (user_id, kind) values (p_uid, 'recovery_locked');
    return 'locked';
  end if;
  return 'wrong';
end;
$$;

revoke execute on function private.norm_answer(text), private.pin_matches(uuid, text), private.set_pin(uuid, text), private.check_answer(uuid, text) from public, anon, authenticated;

-- ─── 3. 가입: 복구 질문·답 필수, 메타데이터에서 답을 지운다 ───
create or replace function public.validate_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_nick  text := btrim(coalesce(new.raw_user_meta_data ->> 'nickname', ''));
  v_role  text := coalesce(new.raw_user_meta_data ->> 'role', '');
  v_code  text := upper(btrim(coalesce(new.raw_user_meta_data ->> 'trainer_code', '')));
  v_hash  text;
  v_tid   text := coalesce(new.raw_user_meta_data ->> 'trainer_id', '');
  v_q     text := coalesce(new.raw_user_meta_data ->> 'recovery_question', '');
  v_a     text := private.norm_answer(new.raw_user_meta_data ->> 'recovery_answer');
begin
  if char_length(v_nick) not between 2 and 20 then
    raise exception 'invalid_nickname';
  end if;
  if v_q !~ '^[1-6]$' or char_length(v_a) < 2 then
    raise exception 'invalid_recovery';
  end if;

  if v_role = 'trainer' then
    v_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');
    if v_hash = (select s.value from public.app_settings s where s.key = 'admin_code_sha256') then
      v_role := 'admin';
    elsif v_hash is distinct from (select s.value from public.app_settings s where s.key = 'trainer_code_sha256') then
      raise exception 'invalid_trainer_code';
    end if;
  elsif v_role = 'member' then
    if v_tid !~ '^[0-9a-f-]{36}$'
       or not exists (select 1 from public.profiles p where p.id = v_tid::uuid and p.role = 'trainer') then
      raise exception 'invalid_trainer';
    end if;
  else
    raise exception 'invalid_role';
  end if;

  -- auth.users 행은 아직 없지만 외래 키를 트랜잭션 끝에 검사하므로 여기서 넣을 수 있다
  insert into private.account_security (user_id, question, answer_hash)
  values (new.id, v_q::smallint, extensions.crypt(v_a, extensions.gen_salt('bf')));

  new.raw_user_meta_data := (new.raw_user_meta_data - 'trainer_code' - 'recovery_answer' - 'recovery_question')
    || jsonb_build_object('nickname', v_nick, 'role', v_role);
  return new;
end;
$$;
revoke execute on function public.validate_new_user() from public, anon, authenticated;

-- 가입 뒤 인증 서버가 메타데이터를 다시 쓸 때도 비밀 값을 지운다
create or replace function private.strip_trainer_code()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.raw_user_meta_data := new.raw_user_meta_data - 'trainer_code' - 'recovery_answer' - 'recovery_question';
  return new;
end;
$$;

-- 기존 계정에도 보안 행을 만들어 둔다(복구 질문은 비어 있음 → 앱이 정하라고 안내)
insert into private.account_security (user_id) select id from auth.users on conflict do nothing;

-- ─── 4. 앱에서 부르는 함수 ───
-- 로그인 전: 닉네임의 복구 질문 번호(없으면 null)
create function public.get_recovery_question(p_nickname text)
returns smallint language sql stable security definer set search_path = ''
as $$
  select s.question from public.profiles p join private.account_security s on s.user_id = p.id
   where lower(p.nickname) = lower(btrim(p_nickname)) and s.answer_hash is not null;
$$;

-- 로그인 전: 답을 맞히면 새 PIN으로 바꾼다
create function public.reset_pin_with_answer(p_nickname text, p_answer text, p_new_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid; v_res text; v_s private.account_security%rowtype;
begin
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  select p.id into v_uid from public.profiles p where lower(p.nickname) = lower(btrim(p_nickname));
  if v_uid is null then return jsonb_build_object('status', 'no_recovery'); end if;
  v_res := private.check_answer(v_uid, p_answer);
  if v_res = 'ok' then
    perform private.set_pin(v_uid, p_new_pin);
    insert into private.security_events (user_id, kind) values (v_uid, 'pin_reset_by_answer');
    return jsonb_build_object('status', 'ok');
  end if;
  select * into v_s from private.account_security where user_id = v_uid;
  return jsonb_build_object('status', v_res, 'remaining', greatest(0, 5 - coalesce(v_s.failed_count, 0)), 'locked_until', v_s.locked_until);
end;
$$;

-- 로그인한 사람: 지금 PIN 또는 복구 답으로 PIN 바꾸기
create function public.change_my_pin(p_new_pin text, p_current_pin text default null, p_answer text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_res text; v_at timestamptz;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
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

-- 로그인한 사람: 복구 질문 정하기·바꾸기(지금 PIN 확인)
create function public.set_recovery(p_question int, p_answer text, p_current_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_a text := private.norm_answer(p_answer);
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  if not private.pin_matches(v_uid, p_current_pin) then return jsonb_build_object('status', 'wrong'); end if;
  if p_question not between 1 and 6 or char_length(v_a) < 2 then return jsonb_build_object('status', 'bad_answer'); end if;
  insert into private.account_security (user_id, question, answer_hash) values (v_uid, p_question, extensions.crypt(v_a, extensions.gen_salt('bf')))
  on conflict (user_id) do update set question = excluded.question, answer_hash = excluded.answer_hash, failed_count = 0, locked_until = null, updated_at = now();
  insert into private.security_events (user_id, kind) values (v_uid, 'recovery_set');
  return jsonb_build_object('status', 'ok');
end;
$$;

-- 로그인한 사람: 알림용 보안 상태
create function public.my_security_status()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'has_recovery', coalesce(s.answer_hash is not null, false),
    'question', s.question,
    'pin_changed_at', s.pin_changed_at,
    'failed_count', coalesce(s.failed_count, 0),
    'last_failed_at', s.last_failed_at,
    'locked_until', s.locked_until)
  from (select (select auth.uid()) as uid) me
  left join private.account_security s on s.user_id = me.uid;
$$;

-- 로그인해 둔 기기에서 '제가 바꾼 게 아니에요'
create function public.report_pin_not_me()
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_allowed'; end if;
  insert into private.security_events (user_id, kind) values ((select auth.uid()), 'reported_not_me');
end;
$$;

-- PIN이 바뀌기 전부터 로그인돼 있던 기기만: 새 PIN·새 복구 질문으로 되찾고 다른 기기는 모두 로그아웃
create function public.reclaim_account(p_new_pin text, p_question int, p_answer text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  v_sess timestamptz; v_changed timestamptz; v_a text := private.norm_answer(p_answer); v_at timestamptz;
begin
  if v_uid is null or v_sid is null then raise exception 'not_allowed'; end if;
  select s.created_at into v_sess from auth.sessions s where s.id = v_sid and s.user_id = v_uid;
  select pin_changed_at into v_changed from private.account_security where user_id = v_uid;
  if v_sess is null or v_changed is null or v_sess >= v_changed then raise exception 'not_allowed'; end if;
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  if p_question not between 1 and 6 or char_length(v_a) < 2 then return jsonb_build_object('status', 'bad_answer'); end if;
  v_at := private.set_pin(v_uid, p_new_pin);
  update private.account_security set question = p_question, answer_hash = extensions.crypt(v_a, extensions.gen_salt('bf')) where user_id = v_uid;
  delete from auth.sessions where user_id = v_uid and id <> v_sid;
  insert into private.security_events (user_id, kind) values (v_uid, 'reclaimed');
  return jsonb_build_object('status', 'ok', 'pin_changed_at', v_at);
end;
$$;

-- 운영자: 신고·되찾기·잠김 기록
create function public.admin_security_events()
returns table (nickname text, kind text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.nickname, e.kind, e.created_at
    from private.security_events e join public.profiles p on p.id = e.user_id
   where private.is_admin() and e.kind in ('reported_not_me', 'reclaimed', 'recovery_locked')
   order by e.created_at desc limit 100;
$$;

revoke execute on function public.get_recovery_question(text), public.reset_pin_with_answer(text, text, text),
  public.change_my_pin(text, text, text), public.set_recovery(int, text, text), public.my_security_status(),
  public.report_pin_not_me(), public.reclaim_account(text, int, text), public.admin_security_events() from public;
grant execute on function public.get_recovery_question(text), public.reset_pin_with_answer(text, text, text) to anon, authenticated;
grant execute on function public.change_my_pin(text, text, text), public.set_recovery(int, text, text), public.my_security_status(),
  public.report_pin_not_me(), public.reclaim_account(text, int, text), public.admin_security_events() to authenticated;
