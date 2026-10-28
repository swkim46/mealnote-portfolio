-- 익명 의견 보내기 + 운영자(관리자) 역할
-- 의견 테이블에는 작성자를 가리키는 칸이 없다. 닉네임·계정 id를 저장하지 않는다.

-- ─── 운영자 역할 ──────────────────────────────────────────
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('member', 'trainer', 'admin'));

-- 운영자 등록 코드의 SHA-256. 원문은 app/.env.local의 ADMIN_CODE에만 있다.
insert into public.app_settings (key, value)
-- 공개본: 운영 코드의 해시 대신 예시 코드 MEALNOTE-ADMIN의 해시를 넣었다(.env.example의 ADMIN_CODE).
values ('admin_code_sha256', 'b54ed9859c8d773dc7f121ae539a1f0afcd04df50551b9464f84a3e8b49f467f');

-- 트레이너 가입 화면에서 운영자 코드를 넣으면 운영자로 가입된다.
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
begin
  if char_length(v_nick) not between 2 and 20 then
    raise exception 'invalid_nickname';
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

  new.raw_user_meta_data := (new.raw_user_meta_data - 'trainer_code')
    || jsonb_build_object('nickname', v_nick, 'role', v_role);
  return new;
end;
$$;
revoke execute on function public.validate_new_user() from public, anon, authenticated;

create function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin');
$$;
revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- ─── 익명 의견 ────────────────────────────────────────────
create table public.app_feedback (
  id           uuid primary key default gen_random_uuid(),
  category     text not null check (category in ('bug', 'idea', 'other')),
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  screen       text not null default '' check (char_length(screen) <= 40),
  device       text not null default '' check (char_length(device) <= 60),
  app_version  text not null default '' check (char_length(app_version) <= 40),
  status       text not null default 'new' check (status in ('new', 'read', 'done')),
  created_at   timestamptz not null default now()
);
create index app_feedback_created_idx on public.app_feedback (created_at desc);
alter table public.app_feedback enable row level security;

-- 로그인한 사람은 누구나 보낼 수 있다(작성자는 남지 않는다). 읽기·상태 변경은 운영자만.
create policy app_feedback_insert on public.app_feedback for insert to authenticated
with check (true);
create policy app_feedback_select on public.app_feedback for select to authenticated
using (private.is_admin());
create policy app_feedback_update on public.app_feedback for update to authenticated
using (private.is_admin()) with check (private.is_admin());

revoke all on public.app_feedback from anon, authenticated;
grant insert (category, body, screen, device, app_version) on public.app_feedback to authenticated;
grant select on public.app_feedback to authenticated;
grant update (status) on public.app_feedback to authenticated;
