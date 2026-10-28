-- v1.6 닉네임 바꾸기(2026-10-26 사용자 요청). 닉네임은 로그인 아이디이기도 하다:
-- 로그인용 내부 주소 = sha256(닉네임 NFC·앞뒤 공백 제거·소문자)의 앞 32자 + '@users.mealnote.local' (src/lib/auth.ts emailOf와 같은 규칙).
-- 그래서 화면 닉네임(profiles), 인증 사용자(auth.users.email·메타데이터), 이메일 신원(auth.identities)을 한 번에 바꾼다.
-- 로그인 아이디가 바뀌는 일이라 PIN 바꾸기와 같이 계정 잠금 → 세션 확인 → 지금 PIN 확인 순서로 한다. 보안 기록에 남긴다.
alter table private.security_events drop constraint security_events_kind_check;
alter table private.security_events add constraint security_events_kind_check
  check (kind = any (array['pin_reset_by_answer', 'pin_changed', 'recovery_set', 'recovery_locked', 'reported_not_me', 'reclaimed', 'nickname_changed']));

-- 예전 로그인 이름 기록: 다른 기기에 '닉네임 기억하기'로 남은 예전 이름을 그 기기에서 새 이름으로 맞추는 데만 쓴다.
-- 이름 자체가 아니라 로그인 아이디와 같은 해시(앞 32자)만 둔다. 본인 확인 함수(is_my_former_nickname) 말고는 아무도 못 읽는다.
create table private.former_nicknames (
  user_id     uuid not null references auth.users(id) on delete cascade,
  login_key   text not null,
  changed_at  timestamptz not null default now(),
  primary key (user_id, login_key)
);
revoke all on private.former_nicknames from public, anon, authenticated;

create function public.change_my_nickname(p_new_nickname text, p_current_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_nick text := btrim(normalize(coalesce(p_new_nickname, ''), NFC));
  v_old text;
  v_email text;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  insert into private.account_security (user_id) values (v_uid) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = v_uid for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  if not private.pin_matches(v_uid, p_current_pin) then return jsonb_build_object('status', 'wrong'); end if;
  if char_length(v_nick) not between 2 and 20 then return jsonb_build_object('status', 'invalid'); end if;
  select p.nickname into v_old from public.profiles p where p.id = v_uid for update;
  if v_old is null then raise exception 'not_allowed'; end if;
  if v_old = v_nick then return jsonb_build_object('status', 'same'); end if;
  if exists (select 1 from public.profiles p where lower(p.nickname) = lower(v_nick) and p.id <> v_uid) then
    return jsonb_build_object('status', 'taken');
  end if;
  v_email := left(encode(extensions.digest(lower(v_nick), 'sha256'), 'hex'), 32) || '@users.mealnote.local';
  begin
    update public.profiles set nickname = v_nick where id = v_uid;
  exception when unique_violation then
    return jsonb_build_object('status', 'taken'); -- 같은 순간 다른 사람이 먼저 가져감
  end;
  update auth.users
     set email = v_email,
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('nickname', v_nick),
         updated_at = now()
   where id = v_uid;
  update auth.identities
     set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', v_email),
         updated_at = now()
   where user_id = v_uid and provider = 'email';
  if lower(v_old) <> lower(v_nick) then -- 대소문자만 바꾸면 로그인 아이디는 그대로다
    insert into private.former_nicknames (user_id, login_key)
    values (v_uid, left(encode(extensions.digest(lower(v_old), 'sha256'), 'hex'), 32))
    on conflict (user_id, login_key) do update set changed_at = now();
  end if;
  insert into private.security_events (user_id, kind) values (v_uid, 'nickname_changed');
  return jsonb_build_object('status', 'ok', 'nickname', v_nick);
end;
$$;
revoke execute on function public.change_my_nickname(text, text) from public, anon;
grant execute on function public.change_my_nickname(text, text) to authenticated;

-- 이 기기에 기억된 이름이 '로그인한 본인의 예전 닉네임'인지(Codex v1.6 리뷰 P2: 다른 기기의 로그인 칸에 옛 이름이 남음).
-- 지금 그 이름을 다른 사람이 쓰고 있으면 그 사람의 기억값일 수 있으니 false다.
create function public.is_my_former_nickname(p_nickname text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.session_ok()
     and exists (
       select 1 from private.former_nicknames f
        where f.user_id = (select auth.uid())
          and f.login_key = left(encode(extensions.digest(lower(btrim(normalize(coalesce(p_nickname, ''), NFC))), 'sha256'), 'hex'), 32))
     and not exists (
       select 1 from public.profiles p
        where lower(p.nickname) = lower(btrim(normalize(coalesce(p_nickname, ''), NFC))) and p.id <> (select auth.uid()));
$$;
revoke execute on function public.is_my_former_nickname(text) from public, anon;
grant execute on function public.is_my_former_nickname(text) to authenticated;

-- 운영자 보안 기록에 닉네임 변경도 보이게(Codex v1.6 리뷰 P2). 운영자·유효 세션 확인은 그대로다.
create or replace function public.admin_security_events()
returns table (nickname text, kind text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.nickname, e.kind, e.created_at
    from private.security_events e join public.profiles p on p.id = e.user_id
   where private.is_admin() and private.session_ok() and e.kind in ('reported_not_me', 'reclaimed', 'recovery_locked', 'nickname_changed')
   order by e.created_at desc limit 100;
$$;
