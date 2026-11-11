-- 회원 성별(2.3 — 사용자 결정 2026-11-05, 문서/기획/2_3_범위와_결정_261105.md).
--  - 남자·여자 가운데 하나를 고르고, 한 번 고르면 바꿀 수 없다. 잘못 고른 회원은 의견 보내기로 받아 운영자가 고친다.
--  - '성별 공개하지 않기'를 켜면 성별을 쓰는 기능(지금은 이달의 중량왕)에서 빠진다. 언제든 끄고 켤 수 있다.
--  - 앱에 드러나지 않는 private 표에 둔다: profiles는 표 전체 읽기 권한이 있어 칸을 더하면 담당 트레이너가 읽을 수 있다. 본인은 my_gender로만 읽는다.
create table private.member_gender (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  gender text check (gender in ('male', 'female')),
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);

create function public.my_gender()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'member') then raise exception 'not_allowed'; end if;
  select jsonb_build_object('gender', g.gender, 'hidden', g.hidden) into v from private.member_gender g where g.member_id = v_uid;
  return coalesce(v, jsonb_build_object('gender', null, 'hidden', false));
end;
$$;

-- 성별은 비어 있을 때만 정한다. 같은 값을 다시 보내면 통과한다(응답이 끊겨 다시 보낸 경우), 다른 값이면 gender_locked
create function public.set_my_gender(p_gender text, p_hidden boolean default false)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_cur text;
begin
  perform private.lock_account_and_check(v_uid);
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'member') then raise exception 'not_allowed'; end if;
  if p_gender is null or p_gender not in ('male', 'female') then raise exception 'bad_gender'; end if;
  select g.gender into v_cur from private.member_gender g where g.member_id = v_uid;
  if v_cur = p_gender then return 'same'; end if;
  if v_cur is not null then raise exception 'gender_locked'; end if;
  insert into private.member_gender (member_id, gender, hidden) values (v_uid, p_gender, coalesce(p_hidden, false))
  on conflict (member_id) do update set gender = excluded.gender, hidden = private.member_gender.hidden or excluded.hidden, updated_at = now();
  return 'saved';
end;
$$;

create function public.set_gender_hidden(p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'member') then raise exception 'not_allowed'; end if;
  insert into private.member_gender (member_id, hidden) values (v_uid, coalesce(p_on, false))
  on conflict (member_id) do update set hidden = excluded.hidden, updated_at = now();
end;
$$;

revoke execute on function public.my_gender(), public.set_my_gender(text, boolean), public.set_gender_hidden(boolean) from public, anon;
grant execute on function public.my_gender(), public.set_my_gender(text, boolean), public.set_gender_hidden(boolean) to authenticated;
