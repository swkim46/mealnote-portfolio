-- 식단노트 v1 스키마
-- 회원은 자기 기록만, 트레이너는 담당 회원 기록만 본다.
-- 프로젝트 생성 때 "새 테이블 자동 노출"을 껐으므로 권한(GRANT)을 여기서 직접 준다.

-- ─── 테이블 ───────────────────────────────────────────────

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 2 and 20),
  role        text not null check (role in ('member', 'trainer')),
  created_at  timestamptz not null default now()
);
create unique index profiles_nickname_lower_key on public.profiles (lower(nickname));

create table public.assignments (
  member_id   uuid primary key references public.profiles(id) on delete cascade,
  trainer_id  uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now()
);
create index assignments_trainer_idx on public.assignments (trainer_id);

create table public.meals (
  id              uuid primary key default gen_random_uuid(),
  member_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  eaten_on        date not null,
  eaten_at        time not null,
  meal_type       text not null check (meal_type in ('아침', '점심', '저녁', '간식')),
  food            text not null check (char_length(btrim(food)) between 1 and 150),
  note            text not null default '' check (char_length(note) <= 500),
  photo_path      text,
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  member_seen_at  timestamptz not null default now()
);
create index meals_member_day_idx on public.meals (member_id, eaten_on desc, eaten_at desc);

create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  meal_id      uuid not null references public.meals(id) on delete cascade,
  author_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  author_role  text not null default 'member' check (author_role in ('member', 'trainer')),
  body         text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at   timestamptz not null default now()
);
create index comments_meal_idx on public.comments (meal_id, created_at);

-- 운영 설정. 앱(anon·authenticated)에는 권한을 주지 않는다.
create table public.app_settings (
  key    text primary key,
  value  text not null
);
-- 트레이너 등록 코드의 SHA-256. 원문은 저장소에 두지 않는다.
insert into public.app_settings (key, value)
-- 공개본: 운영 코드의 해시 대신 예시 코드 MEALNOTE-TRAINER의 해시를 넣었다(.env.example의 TRAINER_CODE).
values ('trainer_code_sha256', '335fdc3f13def46cb18ed2d8af4b083ccd5fa9e8cba8554109029d7fbb165553');

alter table public.profiles     enable row level security;
alter table public.assignments  enable row level security;
alter table public.meals        enable row level security;
alter table public.comments     enable row level security;
alter table public.app_settings enable row level security;

-- ─── 보조 함수 ────────────────────────────────────────────

-- 지금 로그인한 트레이너의 담당 회원인가 (RLS 재귀를 피하려고 definer로 둔다)
create function public.is_my_member(p_member uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.assignments a
    where a.member_id = p_member and a.trainer_id = (select auth.uid())
  );
$$;

-- 사진 경로의 첫 폴더(회원 id 문자열)용
create function public.can_read_member_folder(p_folder text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_folder = (select auth.uid())::text
      or exists (
        select 1 from public.assignments a
        where a.member_id::text = p_folder and a.trainer_id = (select auth.uid())
      );
$$;

-- ─── 가입 처리 ────────────────────────────────────────────
-- 가입 메타데이터: nickname, role, trainer_id(회원), trainer_code(트레이너)

-- 1) 저장 전에 검증하고 등록 코드를 메타데이터에서 지운다
create function public.validate_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_nick  text := btrim(coalesce(new.raw_user_meta_data ->> 'nickname', ''));
  v_role  text := coalesce(new.raw_user_meta_data ->> 'role', '');
  v_code  text := upper(btrim(coalesce(new.raw_user_meta_data ->> 'trainer_code', '')));
  v_tid   text := coalesce(new.raw_user_meta_data ->> 'trainer_id', '');
begin
  if char_length(v_nick) not between 2 and 20 then
    raise exception 'invalid_nickname';
  end if;

  if v_role = 'trainer' then
    if encode(extensions.digest(v_code, 'sha256'), 'hex') is distinct from
       (select s.value from public.app_settings s where s.key = 'trainer_code_sha256') then
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

  new.raw_user_meta_data := (new.raw_user_meta_data - 'trainer_code') || jsonb_build_object('nickname', v_nick);
  return new;
end;
$$;

-- 2) 저장 뒤 프로필과 담당 연결을 만든다
create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role text := new.raw_user_meta_data ->> 'role';
begin
  insert into public.profiles (id, nickname, role)
  values (new.id, new.raw_user_meta_data ->> 'nickname', v_role);

  if v_role = 'member' then
    insert into public.assignments (member_id, trainer_id)
    values (new.id, (new.raw_user_meta_data ->> 'trainer_id')::uuid);
  end if;
  return new;
end;
$$;

create trigger before_auth_user_created
  before insert on auth.users
  for each row execute function public.validate_new_user();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── 댓글 작성자·확인 처리 ────────────────────────────────

-- 작성자와 역할은 서버가 정한다
create function public.set_comment_author()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.author_id   := (select auth.uid());
  new.author_role := (select p.role from public.profiles p where p.id = new.author_id);
  new.created_at  := now();
  if new.author_role is null then
    raise exception 'no_profile';
  end if;
  return new;
end;
$$;

-- 트레이너가 댓글을 달면 그 식사는 확인한 것으로 본다
create function public.mark_reviewed_on_trainer_comment()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_role = 'trainer' then
    update public.meals
       set reviewed_at = coalesce(reviewed_at, now()),
           reviewed_by = coalesce(reviewed_by, new.author_id)
     where id = new.meal_id;
  end if;
  return new;
end;
$$;

create trigger comments_set_author
  before insert on public.comments
  for each row execute function public.set_comment_author();

create trigger comments_mark_reviewed
  after insert on public.comments
  for each row execute function public.mark_reviewed_on_trainer_comment();

-- ─── 앱에서 부르는 함수 ───────────────────────────────────

-- 가입 화면의 트레이너 목록 (로그인 전 호출)
create function public.list_trainers()
returns table (id uuid, nickname text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.nickname from public.profiles p
  where p.role = 'trainer'
  order by p.nickname;
$$;

-- 가입 전 닉네임 중복 확인
create function public.nickname_taken(p_nickname text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p where lower(p.nickname) = lower(btrim(p_nickname))
  );
$$;

-- 트레이너의 확인 완료 표시
create function public.mark_reviewed(p_meal uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.meals m
     set reviewed_at = now(), reviewed_by = (select auth.uid())
   where m.id = p_meal and public.is_my_member(m.member_id);
  if not found then
    raise exception 'not_allowed';
  end if;
end;
$$;

-- ─── RLS 정책 ─────────────────────────────────────────────

create policy profiles_select on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or public.is_my_member(id)
  or exists (select 1 from public.assignments a
             where a.member_id = (select auth.uid()) and a.trainer_id = profiles.id)
);

create policy assignments_select on public.assignments for select to authenticated
using (member_id = (select auth.uid()) or trainer_id = (select auth.uid()));

create policy meals_select on public.meals for select to authenticated
using (member_id = (select auth.uid()) or public.is_my_member(member_id));

create policy meals_insert on public.meals for insert to authenticated
with check (
  member_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'member')
);

create policy meals_update on public.meals for update to authenticated
using (member_id = (select auth.uid()))
with check (member_id = (select auth.uid()));

create policy meals_delete on public.meals for delete to authenticated
using (member_id = (select auth.uid()));

create policy comments_select on public.comments for select to authenticated
using (exists (select 1 from public.meals m where m.id = comments.meal_id));

create policy comments_insert on public.comments for insert to authenticated
with check (exists (select 1 from public.meals m where m.id = comments.meal_id));

-- ─── 권한 ─────────────────────────────────────────────────

revoke all on public.profiles, public.assignments, public.meals, public.comments, public.app_settings
  from anon, authenticated;

grant select on public.profiles, public.assignments to authenticated;

grant select, delete on public.meals to authenticated;
grant insert (id, eaten_on, eaten_at, meal_type, food, note, photo_path) on public.meals to authenticated;
grant update (eaten_on, eaten_at, meal_type, food, note, photo_path, member_seen_at) on public.meals to authenticated;

grant select on public.comments to authenticated;
grant insert (meal_id, body) on public.comments to authenticated;

revoke execute on function
  public.is_my_member(uuid), public.can_read_member_folder(text),
  public.validate_new_user(), public.handle_new_user(),
  public.set_comment_author(), public.mark_reviewed_on_trainer_comment(),
  public.list_trainers(), public.nickname_taken(text), public.mark_reviewed(uuid)
  from public, anon, authenticated;

grant execute on function public.is_my_member(uuid), public.can_read_member_folder(text) to authenticated;
grant execute on function public.list_trainers(), public.nickname_taken(text) to anon, authenticated;
grant execute on function public.mark_reviewed(uuid) to authenticated;

-- ─── 사진 저장소 ──────────────────────────────────────────
-- 경로: {member_id}/{meal_id}.jpg, 비공개, 2MB·JPEG만

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-photos', 'meal-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

create policy meal_photos_insert on storage.objects for insert to authenticated
with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy meal_photos_select on storage.objects for select to authenticated
using (bucket_id = 'meal-photos' and public.can_read_member_folder((storage.foldername(name))[1]));

create policy meal_photos_update on storage.objects for update to authenticated
using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy meal_photos_delete on storage.objects for delete to authenticated
using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
