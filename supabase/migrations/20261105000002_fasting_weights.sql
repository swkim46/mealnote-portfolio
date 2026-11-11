-- 공복 체중(2.3 — 트레이너 의견 2026-11-04, 문서/기획/2_3_범위와_결정_261105.md). 하루 한 값: 같은 날 다시 적으면 그 값으로 바뀐다.
-- 회원 본인과 담당 트레이너가 읽는다. 쓰기는 회원 본인이 서버 함수로만 한다.
create table public.fasting_weights (
  member_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  kg numeric(5, 1) not null check (kg between 20 and 300),
  updated_at timestamptz not null default now(),
  primary key (member_id, day)
);
alter table public.fasting_weights enable row level security;
create policy fasting_select on public.fasting_weights for select to authenticated
  using (member_id = (select auth.uid()) or private.is_my_member(member_id));
create policy session_alive on public.fasting_weights as restrictive for all to authenticated
  using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.fasting_weights from anon, authenticated;
grant select on public.fasting_weights to authenticated;

create function public.save_fasting_weight(p_day date, p_kg numeric)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_kst date := (now() at time zone 'Asia/Seoul')::date;
begin
  perform private.lock_account_and_check(v_uid);
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'member') then raise exception 'not_allowed'; end if;
  -- 기기 시계가 조금 달라도 받는다(운동 요약과 같은 하루 여유). 1년보다 오래된 날은 받지 않는다
  if p_day is null or p_day > v_kst + 1 or p_day < v_kst - 366 then raise exception 'bad_day'; end if;
  if p_kg is null or p_kg < 20 or p_kg > 300 then raise exception 'bad_weight'; end if;
  insert into public.fasting_weights (member_id, day, kg) values (v_uid, p_day, round(p_kg, 1))
  on conflict (member_id, day) do update set kg = excluded.kg, updated_at = now();
end;
$$;

create function public.delete_fasting_weight(p_day date)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  delete from public.fasting_weights where member_id = v_uid and day = p_day;
end;
$$;

revoke execute on function public.save_fasting_weight(date, numeric), public.delete_fasting_weight(date) from public, anon;
grant execute on function public.save_fasting_weight(date, numeric), public.delete_fasting_weight(date) to authenticated;
