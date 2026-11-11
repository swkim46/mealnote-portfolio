-- v2.0 루틴 시트 연결(계획서 5단계): 시트 주인이 우리 서비스 계정에 '뷰어'로 공유하고, 회원 본인이나 담당 트레이너가 앱에 링크를 넣으면 바로 연결된다.
-- 구글 로그인·확인 코드 없음(2026-10-30 사용자 결정): 링크가 새어 나가 남이 먼저 연결할 위험은 감수한다 — 링크는 추측할 수 없고,
-- 시트에는 운동 루틴만 있으며, 연결만으로는 회원에게 아무것도 보이지 않는다(담당 트레이너가 가져오기 미리보기를 보고 저장해야 루틴이 됨).
-- Codex v2.0.0 1차 리뷰 P1(링크를 먼저 적으면 읽기 자격)에 대한 사용자의 판단이다. 보완:
--  - 시트 하나는 회원 한 명에게만. 이미 연결된 시트를 다른 사람이 연결하려 하면 거절하고 운영자 보안 기록에 남긴다(sheet_taken) — 진짜 주인이 막혔을 때 운영자가 확인·해제
--  - 연결·해제는 그 회원 본인이나 지금 담당 트레이너만. 읽기(routine_sheet_for)도 그 둘만. 서버는 시트를 바꾸지 않는다(읽기 전용 범위)
create table public.routine_sources (
  member_id     uuid primary key references public.profiles(id) on delete cascade,
  sheet_id      text not null unique check (sheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  set_by        uuid references public.profiles(id) on delete set null,
  set_at        timestamptz not null default now(),
  last_read_at  timestamptz,
  last_error    text not null default ''
);
alter table public.routine_sources enable row level security;
create policy routine_sources_select on public.routine_sources for select to authenticated
using (member_id = (select auth.uid()) or private.is_my_member(member_id));
create policy session_alive on public.routine_sources as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.routine_sources from anon, authenticated;
grant select on public.routine_sources to authenticated;

alter table private.security_events drop constraint security_events_kind_check;
alter table private.security_events add constraint security_events_kind_check
  check (kind = any (array['pin_reset_by_answer', 'pin_changed', 'recovery_set', 'recovery_locked', 'reported_not_me', 'reclaimed', 'nickname_changed', 'member_removed', 'sheet_taken']));

-- 시트 링크(또는 id) 연결 → {status: 'ok'|'taken', sheet_id}. 빈 값이면 연결 해제(null).
-- 이미 다른 회원에게 연결된 시트면 'taken'을 돌려주고(예외가 아니라서 기록이 남는다) 운영자 보안 기록에 '누가 어느 회원 자리로' 남긴다
create function public.set_routine_sheet(p_member uuid, p_sheet text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_id text; v_owner uuid;
begin
  perform private.lock_account_and_check(v_uid);
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found or (p_member <> v_uid and not private.is_my_member(p_member)) then raise exception 'not_allowed'; end if;
  if btrim(coalesce(p_sheet, '')) = '' then
    delete from public.routine_sources where member_id = p_member;
    return null;
  end if;
  v_id := coalesce(substring(p_sheet from '/spreadsheets/d/([A-Za-z0-9_-]+)'), btrim(p_sheet));
  if v_id !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception 'bad_sheet'; end if;
  select r.member_id into v_owner from public.routine_sources r where r.sheet_id = v_id for update;
  if v_owner is not null and v_owner <> p_member then
    insert into private.security_events (user_id, kind, actor_id) values (p_member, 'sheet_taken', v_uid);
    return jsonb_build_object('status', 'taken', 'sheet_id', v_id);
  end if;
  insert into public.routine_sources (member_id, sheet_id, set_by) values (p_member, v_id, v_uid)
  on conflict (member_id) do update set sheet_id = excluded.sheet_id, set_by = excluded.set_by, set_at = now(), last_read_at = null, last_error = '';
  return jsonb_build_object('status', 'ok', 'sheet_id', v_id);
end;
$$;

-- 서버 기능 sheet-import가 부른 사람의 로그인으로 확인: 회원 본인·지금 담당 트레이너면 연결된 시트 id
create function public.routine_sheet_for(p_member uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select r.sheet_id from public.routine_sources r
   where r.member_id = p_member and private.session_ok()
     and (p_member = (select auth.uid()) or private.is_my_member(p_member));
$$;

-- 운영자 보안 기록에 시트 가로채기 시도(sheet_taken)도 — 대상 회원·시도한 사람
create or replace function public.admin_security_events()
returns table (nickname text, kind text, created_at timestamptz, actor text)
language sql stable security definer set search_path = ''
as $$
  select p.nickname, e.kind, e.created_at, ap.nickname
    from private.security_events e join public.profiles p on p.id = e.user_id
    left join public.profiles ap on ap.id = e.actor_id
   where private.is_admin() and private.session_ok()
     and e.kind in ('reported_not_me', 'reclaimed', 'recovery_locked', 'nickname_changed', 'member_removed', 'sheet_taken')
   order by e.created_at desc limit 100;
$$;

revoke execute on function public.set_routine_sheet(uuid, text), public.routine_sheet_for(uuid) from public, anon;
grant execute on function public.set_routine_sheet(uuid, text), public.routine_sheet_for(uuid) to authenticated;
