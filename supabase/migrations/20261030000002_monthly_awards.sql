-- v2.0 이달의 식단왕·운동왕(계획서 3단계, 2026-10-29 사용자 결정): 달이 끝난 뒤 공개, 지난달 결과를 15일까지 먼저 보인다.
--  - 한국 날짜로 달이 끝나면 다음 달 1일 오전 9시(UTC 0시)에 지난달 결과를 확정해 저장한다. 이후 식사·평가를 고쳐도 지난 결과는 바뀌지 않는다.
--    같은 달을 다시 실행해도 결과가 겹치지 않는다(멱등). 실패에 대비해 1～3일 매시 다시 부른다(이미 확정한 달은 건너뜀).
--  - 평가왕: 그달 기록 10끼 이상 + 평가받은 식사 10끼 이상, 평가 평균 1등(같으면 기록일 수, 그래도 같으면 공동 수상)
--    꾸준왕: 그달 기록 10끼 이상, 그달 안의 최장 연속 기록 1등(같으면 기록일 수, 그래도 같으면 공동)
--    운동왕: 그달 운동한 날(완료 세트가 있는 날) 8일 이상, 운동한 날 1등(같으면 공동). app_settings.workout_award_from 달부터
--  - 2026-11 기록부터 뽑는다(app_settings.award_from). 10월은 수상하지 않는다(2026-10-30 사용자 결정: 2.0 전이고 기간도 짧음).
--  - 범위는 같은 트레이너의 회원(집계 시점의 담당). 시험 계정은 뺀다. 후보가 없으면 수상자를 만들지 않는다.
--  - 수상 닉네임은 기본 공개, 회원이 끄면(award_public) 다른 사람에게는 '익명 회원'으로 보인다.
--  - 1.8의 실시간 순위(monthly_kings)는 없앤다 — 남의 순위를 매일 보이지 않는다(내 참여 현황만).

drop function if exists public.monthly_kings(date);

alter table public.profiles add column award_public boolean not null default true;
insert into public.app_settings (key, value) values ('award_from', '2026-11-01'), ('workout_award_from', '2026-12-01') on conflict (key) do nothing;

create table public.monthly_awards (
  month       date not null check (extract(day from month) = 1),
  trainer_id  uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('rating', 'streak', 'workout')),
  member_id   uuid not null references public.profiles(id) on delete cascade,
  score       numeric not null,
  primary key (month, trainer_id, kind, member_id)
);
alter table public.monthly_awards enable row level security;
revoke all on public.monthly_awards from anon, authenticated; -- 읽기는 함수로만(닉네임 공개 여부를 거쳐서)

create table private.award_runs (
  month     date primary key,
  ran_at    timestamptz not null default now(),
  winners   int not null default 0
);
revoke all on private.award_runs from public, anon, authenticated;

create function private.publish_monthly_awards(p_month date)
returns int language plpgsql security definer set search_path = ''
as $$
declare v_from date := date_trunc('month', p_month)::date; v_to date; v_n int; v_workout boolean;
begin
  v_to := (v_from + interval '1 month' - interval '1 day')::date;
  -- 그달이 한국 날짜로 끝나기 전에는 확정하지 않는다
  if v_to >= (now() at time zone 'Asia/Seoul')::date then return -1; end if;
  -- 수상을 시작하기 전 달은 확정하지 않는다(기록도 남기지 않음 — 화면은 '시작 전'으로 보인다)
  if v_from < coalesce((select s.value::date from public.app_settings s where s.key = 'award_from'), date '2999-01-01') then return -2; end if;
  perform pg_advisory_xact_lock(hashtext('mealnote_awards'), (v_from - date '2000-01-01'));
  if exists (select 1 from private.award_runs r where r.month = v_from) then return 0; end if;
  v_workout := v_from >= coalesce((select s.value::date from public.app_settings s where s.key = 'workout_award_from'), date '2999-01-01');

  with pool as (
    select a.trainer_id, a.member_id from public.assignments a
      join public.profiles t on t.id = a.trainer_id join public.profiles m on m.id = a.member_id
     where not t.is_test and not m.is_test
  ), ms as (
    select p.trainer_id, x.member_id, x.eaten_on, x.rating
      from pool p join public.meals x on x.member_id = p.member_id
     where x.eaten_on between v_from and v_to
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
    select s.trainer_id, s.member_id, s.avg_score, s.days,
           rank() over (partition by s.trainer_id order by s.avg_score desc, s.days desc) as rk
      from stat s where s.meals >= 10 and s.rated >= 10
  ), streak as (
    select s.trainer_id, s.member_id, r.best, rank() over (partition by s.trainer_id order by r.best desc, s.days desc) as rk
      from stat s join runs r on r.member_id = s.member_id where s.meals >= 10
  ), wdays as (
    select p.trainer_id, w.member_id, count(distinct w.day) as days
      from pool p join public.workout_sessions w on w.member_id = p.member_id
     where v_workout and w.day between v_from and v_to
       and exists (select 1 from public.workout_sets x where x.session_id = w.id and x.done)
     group by p.trainer_id, w.member_id
  ), workout as (
    select d.trainer_id, d.member_id, d.days, rank() over (partition by d.trainer_id order by d.days desc) as rk
      from wdays d where d.days >= 8
  ), winners as (
    select trainer_id, 'rating'::text as kind, member_id, round(avg_score, 2) as score from rating where rk = 1
    union all select trainer_id, 'streak', member_id, best from streak where rk = 1
    union all select trainer_id, 'workout', member_id, days from workout where rk = 1
  )
  insert into public.monthly_awards (month, trainer_id, kind, member_id, score)
  select v_from, w.trainer_id, w.kind, w.member_id, w.score from winners w;
  get diagnostics v_n = row_count;
  insert into private.award_runs (month, winners) values (v_from, v_n);
  return v_n;
end;
$$;
revoke execute on function private.publish_monthly_awards(date) from public, anon, authenticated;

-- 1일 9시(한국) = UTC 0시에 지난달. 실패에 대비해 1～3일 매시 다시(확정한 달은 건너뜀)
select cron.schedule('mealnote-awards', '0 * 1-3 * *',
  $$select private.publish_monthly_awards(((now() at time zone 'Asia/Seoul')::date - interval '1 month')::date)$$);

-- 그달 결과(호출자의 담당 트레이너 범위, 트레이너면 본인). published = 그달을 확정했는가(아니면 '집계 중'). 비공개 수상자는 '익명 회원'
-- started = 수상을 시작한 달인가(아니면 화면은 '시작 전'), starts = 시작 달
create function public.awards_for_me(p_month date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid; v_month date := date_trunc('month', p_month)::date;
  v_starts date := coalesce((select s.value::date from public.app_settings s where s.key = 'award_from'), date '2999-01-01');
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  v_trainer := private.shared_scope_trainer();
  return jsonb_build_object(
    'month', v_month,
    'started', v_month >= v_starts,
    'starts', v_starts,
    'published', exists (select 1 from private.award_runs r where r.month = v_month),
    'winners', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', a.kind,
               'nickname', case when p.award_public or a.member_id = v_uid then p.nickname else '익명 회원' end,
               'score', a.score,
               'is_me', a.member_id = v_uid)
             order by a.kind, p.nickname)
        from public.monthly_awards a join public.profiles p on p.id = a.member_id
       where a.month = v_month and a.trainer_id = v_trainer), '[]'::jsonb)
  );
end;
$$;

-- 지난 수상이 있는 달(최근 것부터, 최대 24개)
create function public.award_months()
returns table (month date)
language sql stable security definer set search_path = ''
as $$
  select distinct a.month from public.monthly_awards a
   where a.trainer_id = private.shared_scope_trainer()
   order by a.month desc limit 24;
$$;

-- 이번 달 내 참여 현황(회원 본인만): 기록 끼니·평가받은 끼니·기록한 날·그달 최장 연속·운동한 날. 남의 순위는 돌려주지 않는다
create function public.my_award_progress(p_today date)
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
                        and exists (select 1 from public.workout_sets x where x.session_id = w.id and x.done))
  ) into v;
  return v;
end;
$$;

create function public.set_award_public(p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  update public.profiles set award_public = coalesce(p_on, true) where id = v_uid and role = 'member';
  if not found then raise exception 'not_allowed'; end if;
end;
$$;

revoke execute on function public.awards_for_me(date), public.award_months(), public.my_award_progress(date), public.set_award_public(boolean) from public, anon;
grant execute on function public.awards_for_me(date), public.award_months(), public.my_award_progress(date), public.set_award_public(boolean) to authenticated;
