-- v1.4 단계 1: 오늘의 한마디(트레이너가 쓰면 담당 회원에게 그날 보임) · 연속 기록(하루 1끼 이상)

-- ─── 트레이너 한마디 ───
create table public.trainer_messages (
  trainer_id  uuid not null references public.profiles(id) on delete cascade,
  day         date not null,
  body        text not null check (char_length(btrim(body)) between 1 and 100),
  updated_at  timestamptz not null default now(),
  primary key (trainer_id, day)
);
alter table public.trainer_messages enable row level security;
create policy trainer_messages_select on public.trainer_messages for select to authenticated
using (
  trainer_id = (select auth.uid())
  or exists (select 1 from public.assignments a where a.member_id = (select auth.uid()) and a.trainer_id = trainer_messages.trainer_id)
);
create policy session_alive on public.trainer_messages as restrictive for all to authenticated
using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.trainer_messages from anon, authenticated;
grant select on public.trainer_messages to authenticated;

-- 쓰기는 함수로만: 빈 글이면 그날 한마디를 지운다(기본 문구로 돌아감)
create function public.set_trainer_message(p_day date, p_body text)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_body text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null or not private.session_ok()
     or not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'trainer') then
    raise exception 'not_allowed';
  end if;
  if p_day is null or p_day not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  if v_body = '' then
    delete from public.trainer_messages where trainer_id = v_uid and day = p_day;
  elsif char_length(v_body) > 100 then
    raise exception 'too_long';
  else
    insert into public.trainer_messages (trainer_id, day, body) values (v_uid, p_day, v_body)
    on conflict (trainer_id, day) do update set body = excluded.body, updated_at = now();
  end if;
end;
$$;

-- ─── 연속 기록 ───
-- 기기 날짜(p_today)를 받는다(서버는 UTC라 한국 날짜와 다를 수 있다). 터무니없는 날짜는 거부.
create function private.streak_of(p_member uuid, p_today date)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with d as (
    select distinct m.eaten_on from public.meals m where m.member_id = p_member and m.eaten_on <= p_today
  ), g as (
    select eaten_on, eaten_on - (row_number() over (order by eaten_on))::int as grp from d
  ), runs as (
    select max(eaten_on) as last_day, count(*)::int as n from g group by grp
  )
  select jsonb_build_object(
    'current', coalesce((select n from runs where last_day >= p_today - 1 order by last_day desc limit 1), 0),
    'best', coalesce((select max(n) from runs), 0),
    'today_logged', exists (select 1 from d where eaten_on = p_today)
  );
$$;
revoke execute on function private.streak_of(uuid, date) from public, anon, authenticated;

create function public.meal_streak(p_today date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  return private.streak_of((select auth.uid()), p_today);
end;
$$;

-- 트레이너: 담당 회원별 연속 기록
create function public.member_streaks(p_today date)
returns table (member_id uuid, current_streak int, today_logged boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  return query
    select a.member_id, (s ->> 'current')::int, (s ->> 'today_logged')::boolean
      from public.assignments a
      cross join lateral private.streak_of(a.member_id, p_today) s
     where a.trainer_id = (select auth.uid());
end;
$$;

revoke execute on function public.set_trainer_message(date, text), public.meal_streak(date), public.member_streaks(date) from public, anon;
grant execute on function public.set_trainer_message(date, text), public.meal_streak(date), public.member_streaks(date) to authenticated;
