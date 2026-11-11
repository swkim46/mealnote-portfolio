-- v2.1 유산소 기록(2026-11-02 사용자 피드백 "유산소 운동 기록 추가(몇키로 몇분)(러닝, 사이클 등 유형 선택)").
--  - 유형(코드로 저장, 화면 글자는 앱이 정함) · 시간(분, 필수) · 거리(km)·속도(km/h)는 필요에 따라 하나만 또는 둘 다(사용자 11-02: "거리랑 속력이 둘 다 필요에 따라").
--    거리·속도는 서로 계산해 채우지 않는다(구간마다 속도를 바꾸는 경우가 있다).
--  - 근력 기록과 같은 운동 기록(workout_sessions) 안에 둔다. 유산소만 한 날은 루틴 없이 기록 하나.
--  - '운동한 날' = 완료한 세트가 있거나 유산소가 있는 기록의 날(사용자 11-02 결정: 유산소만 한 날도 셈).
--    규칙은 private.is_workout_session 하나에 두고 세 곳(변화 카드 workout_summary · 운동왕 private.award_ranking · 참여 현황 my_award_progress)이 같이 쓴다.
--  - save_workout에 p_cardio를 더한다. 2.0.x 앱은 p_cardio 없이 부른다 → null이면 있던 유산소를 지우지 않는다.

create table public.workout_cardio (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.workout_sessions(id) on delete cascade,
  ord         int not null check (ord between 1 and 20),
  kind        text not null check (kind in ('run', 'walk', 'cycle', 'row', 'stair', 'elliptical', 'swim', 'rope', 'other')),
  minutes     numeric(5,1) not null check (minutes between 1 and 600),
  km          numeric(5,2) check (km is null or km between 0.01 and 200),
  speed       numeric(4,1) check (speed is null or speed between 0.1 and 80),
  unique (session_id, ord)
);
alter table public.workout_cardio enable row level security;
create policy workout_cardio_select on public.workout_cardio for select to authenticated
using (exists (select 1 from public.workout_sessions s where s.id = session_id and (s.member_id = (select auth.uid()) or private.is_my_member(s.member_id))));
create policy session_alive on public.workout_cardio as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.workout_cardio from anon, authenticated;
grant select on public.workout_cardio to authenticated;

-- 운동한 날의 기준(한 곳): 완료한 세트가 있거나 유산소가 있는 운동 기록
create function private.is_workout_session(p_session uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.workout_sets x where x.session_id = p_session and x.done)
      or exists (select 1 from public.workout_cardio c where c.session_id = p_session);
$$;
revoke execute on function private.is_workout_session(uuid) from public, anon, authenticated;

-- 저장 함수: 유산소(p_cardio)를 더한다. PostgREST가 이름으로 함수를 고르므로 옛 시그니처는 지운다(둘이면 어느 것인지 못 고름)
drop function public.save_workout(uuid, date, uuid, jsonb, boolean, int, timestamptz, uuid);
create function public.save_workout(p_session uuid, p_day date, p_routine uuid, p_sets jsonb, p_finished boolean, p_day_no int default null, p_base timestamptz default null, p_save_id uuid default null, p_cardio jsonb default null)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_owner uuid; v_updated timestamptz; v_last uuid; v_s jsonb; v_ord int := 0; v_now timestamptz := clock_timestamp();
  v_kind text; v_min numeric; v_km numeric; v_speed numeric;
begin
  perform private.lock_account_and_check(v_uid);
  if p_session is null then raise exception 'bad_request'; end if;
  if p_day_no is not null and p_day_no not between 1 and 10 then raise exception 'bad_day_no'; end if;
  if p_sets is null or jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) > 200 then raise exception 'bad_sets'; end if;
  if p_cardio is not null and (jsonb_typeof(p_cardio) <> 'array' or jsonb_array_length(p_cardio) > 20) then raise exception 'bad_cardio'; end if;
  if p_routine is not null and not exists (select 1 from public.routines r where r.id = p_routine and r.member_id = v_uid) then raise exception 'not_allowed'; end if;
  select s.member_id, s.updated_at, s.last_save_id into v_owner, v_updated, v_last from public.workout_sessions s where s.id = p_session for update;
  if v_owner is not null and v_owner <> v_uid then raise exception 'not_allowed'; end if;
  if v_owner is not null and p_save_id is not null and v_last = p_save_id then return v_updated; end if; -- 같은 저장의 재전송
  if v_owner is null then
    if p_base is not null then raise exception 'gone'; end if;
    if p_day is null or p_day not between current_date - 7 and current_date + 2 then raise exception 'bad_day'; end if;
    insert into public.workout_sessions (id, member_id, routine_id, day_no, day, finished, updated_at, last_save_id)
    values (p_session, v_uid, p_routine, p_day_no, p_day, coalesce(p_finished, false), v_now, p_save_id);
  else
    if p_base is null or p_base <> v_updated then raise exception 'conflict'; end if;
    update public.workout_sessions set routine_id = p_routine, day_no = p_day_no, finished = coalesce(p_finished, false), updated_at = v_now, last_save_id = p_save_id
     where id = p_session;
    delete from public.workout_sets where session_id = p_session;
  end if;
  for v_s in select * from jsonb_array_elements(p_sets) loop
    v_ord := v_ord + 1;
    insert into public.workout_sets (session_id, item_id, name, set_no, kg, reps, done, ord)
    values (p_session,
            (select i.id from public.routine_items i where i.id = nullif(v_s ->> 'item_id', '')::uuid and i.routine_id = p_routine),
            btrim(coalesce(v_s ->> 'name', '')), (v_s ->> 'set_no')::int, nullif(btrim(v_s ->> 'kg'), ''), nullif(btrim(v_s ->> 'reps'), ''),
            coalesce((v_s ->> 'done')::boolean, false), v_ord);
  end loop;
  -- 유산소: 보낸 목록으로 통째로 바꾼다. null이면(2.0.x 앱) 있던 유산소를 그대로 둔다
  if p_cardio is not null then
    delete from public.workout_cardio where session_id = p_session;
    v_ord := 0;
    for v_s in select * from jsonb_array_elements(p_cardio) loop
      v_ord := v_ord + 1;
      v_kind := v_s ->> 'kind';
      v_min := nullif(v_s ->> 'minutes', '')::numeric;
      v_km := nullif(v_s ->> 'km', '')::numeric;
      v_speed := nullif(v_s ->> 'speed', '')::numeric;
      if v_kind is null or v_kind not in ('run', 'walk', 'cycle', 'row', 'stair', 'elliptical', 'swim', 'rope', 'other')
         or v_min is null or v_min not between 1 and 600 or (v_km is not null and v_km not between 0.01 and 200)
         or (v_speed is not null and v_speed not between 0.1 and 80) then
        raise exception 'bad_cardio';
      end if;
      insert into public.workout_cardio (session_id, ord, kind, minutes, km, speed)
      values (p_session, v_ord, v_kind, round(v_min, 1), round(v_km, 2), round(v_speed, 1));
    end loop;
  end if;
  return v_now;
end;
$$;
revoke execute on function public.save_workout(uuid, date, uuid, jsonb, boolean, int, timestamptz, uuid, jsonb) from public, anon;
grant execute on function public.save_workout(uuid, date, uuid, jsonb, boolean, int, timestamptz, uuid, jsonb) to authenticated;

-- 변화 카드 운동 요약: 운동한 날은 같은 기준, 유산소 횟수·시간·거리(적은 거리만)를 더한다
create or replace function public.workout_summary(p_member uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 730 then raise exception 'bad_range'; end if;
  with s as (select x.id, x.day from public.workout_sessions x where x.member_id = p_member and x.day between p_from and p_to),
  c as (select c.minutes, c.km from public.workout_cardio c join s on s.id = c.session_id)
  select jsonb_build_object(
    'days', (select count(distinct s.day) from s where private.is_workout_session(s.id)),
    'done_sets', (select count(*) from public.workout_sets w join s on s.id = w.session_id where w.done),
    'cardio_count', (select count(*) from c),
    'cardio_minutes', coalesce((select sum(c.minutes) from c), 0),
    'cardio_km', coalesce((select sum(c.km) from c), 0)
  ) into v;
  return v;
end;
$$;

-- 운동왕(달 마감 확정·이번 달 순위가 같이 쓰는 규칙 함수): 운동한 날 기준만 바꾼다. 나머지는 20261101000001 그대로
create or replace function private.award_ranking(p_from date, p_to date, p_workout boolean, p_trainer uuid default null)
returns table (trainer_id uuid, kind text, member_id uuid, score numeric, rk bigint)
language sql stable security definer set search_path = ''
as $$
  with pool as (
    select a.trainer_id, a.member_id from public.assignments a
      join public.profiles t on t.id = a.trainer_id join public.profiles m on m.id = a.member_id
     where not t.is_test and not m.is_test and (p_trainer is null or a.trainer_id = p_trainer)
  ), ms as (
    select p.trainer_id, x.member_id, x.eaten_on, x.rating
      from pool p join public.meals x on x.member_id = p.member_id
     where x.eaten_on between p_from and p_to
  ), stat as (
    select ms.trainer_id, ms.member_id, count(*) as meals, count(ms.rating) as rated, count(distinct ms.eaten_on) as days,
           avg(private.rating_score(ms.rating)) filter (where ms.rating is not null) as avg_score
      from ms group by ms.trainer_id, ms.member_id
  ), runs as (
    select y.member_id, max(y.n) as best
      from (select z.member_id, count(*) as n
              from (select d.member_id, d.eaten_on - (row_number() over (partition by d.member_id order by d.eaten_on))::int as grp
                      from (select distinct ms.member_id, ms.eaten_on from ms) d) z
             group by z.member_id, z.grp) y
     group by y.member_id
  ), rating as (
    select s.trainer_id, s.member_id, s.avg_score,
           rank() over (partition by s.trainer_id order by s.avg_score desc, s.days desc) as rk
      from stat s where s.meals >= 10 and s.rated >= 10
  ), streak as (
    select s.trainer_id, s.member_id, r.best, rank() over (partition by s.trainer_id order by r.best desc, s.days desc) as rk
      from stat s join runs r on r.member_id = s.member_id where s.meals >= 10
  ), wdays as (
    select p.trainer_id, w.member_id, count(distinct w.day) as days
      from pool p join public.workout_sessions w on w.member_id = p.member_id
     where p_workout and w.day between p_from and p_to
       and private.is_workout_session(w.id)
     group by p.trainer_id, w.member_id
  ), workout as (
    select d.trainer_id, d.member_id, d.days, rank() over (partition by d.trainer_id order by d.days desc) as rk
      from wdays d where d.days >= 8
  )
  select g.trainer_id, 'rating'::text, g.member_id, round(g.avg_score, 2), g.rk from rating g
  union all select k.trainer_id, 'streak', k.member_id, k.best::numeric, k.rk from streak k
  union all select w.trainer_id, 'workout', w.member_id, w.days::numeric, w.rk from workout w;
$$;

-- 이번 달 내 참여 현황: 운동한 날 기준만 바꾼다. 나머지는 20261030000002 그대로
create or replace function public.my_award_progress(p_today date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_from date; v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  v_from := date_trunc('month', p_today)::date;
  with ms as (select m.eaten_on, m.rating from public.meals m where m.member_id = v_uid and m.eaten_on between v_from and p_today),
  d as (select distinct eaten_on from ms),
  g as (select count(*) as n from (select eaten_on - (row_number() over (order by eaten_on))::int as grp from d) z group by grp)
  select jsonb_build_object(
    'meals', (select count(*) from ms),
    'rated', (select count(rating) from ms),
    'days', (select count(*) from d),
    'best_streak', coalesce((select max(n) from g), 0),
    'workout_days', (select count(distinct w.day) from public.workout_sessions w
                      where w.member_id = v_uid and w.day between v_from and p_today
                        and private.is_workout_session(w.id))
  ) into v;
  return v;
end;
$$;
