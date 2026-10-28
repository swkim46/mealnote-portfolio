-- PIN 재설정: 회원이 로그인 화면에서 "닉네임 + 담당 트레이너"로 요청 → 담당 트레이너가 새 PIN을 만들어 회원에게 전달.
-- 요청이 있는 담당 회원에게만 새 PIN을 만들 수 있다(트레이너가 아무 때나 회원 계정을 가져가지 못하게).

create table public.pin_reset_requests (
  member_id     uuid primary key references public.profiles(id) on delete cascade,
  trainer_id    uuid not null references public.profiles(id) on delete cascade,
  requested_at  timestamptz not null default now()
);
alter table public.pin_reset_requests enable row level security;
create policy pin_reset_requests_select on public.pin_reset_requests for select to authenticated
using (trainer_id = (select auth.uid()));
revoke all on public.pin_reset_requests from anon, authenticated;
grant select on public.pin_reset_requests to authenticated;

-- 로그인 전 호출. 닉네임·트레이너가 맞지 않으면 조용히 아무것도 하지 않는다(어떤 닉네임이 있는지 알아내지 못하게).
create function public.request_pin_reset(p_nickname text, p_trainer uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member uuid;
begin
  select p.id into v_member
    from public.profiles p
    join public.assignments a on a.member_id = p.id
   where lower(p.nickname) = lower(btrim(p_nickname)) and p.role = 'member' and a.trainer_id = p_trainer;
  if v_member is null then
    return;
  end if;
  insert into public.pin_reset_requests (member_id, trainer_id) values (v_member, p_trainer)
  on conflict (member_id) do update set trainer_id = excluded.trainer_id, requested_at = now();
end;
$$;
revoke execute on function public.request_pin_reset(text, uuid) from public;
grant execute on function public.request_pin_reset(text, uuid) to anon, authenticated;

-- 담당 트레이너가 호출. 새 PIN 6자리를 서버에서 만들어 돌려주고 요청을 지운다.
create function public.reset_member_pin(p_member uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_pin text;
begin
  if not exists (
    select 1 from public.pin_reset_requests r
     where r.member_id = p_member and r.trainer_id = (select auth.uid())
  ) or not private.is_my_member(p_member) then
    raise exception 'not_allowed';
  end if;
  v_pin := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  update auth.users
     set encrypted_password = extensions.crypt(v_pin, extensions.gen_salt('bf')), updated_at = now()
   where id = p_member;
  delete from public.pin_reset_requests where member_id = p_member;
  return v_pin;
end;
$$;
revoke execute on function public.reset_member_pin(uuid) from public, anon;
grant execute on function public.reset_member_pin(uuid) to authenticated;
