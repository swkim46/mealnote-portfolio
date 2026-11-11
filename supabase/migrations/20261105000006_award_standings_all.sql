-- 이번 달 현재 순위에 후보 조건을 채우지 못한 회원도 넣는다(2.3 — 사용자 결정 2026-11-05).
--  - 후보를 앞에 세우고 아직 후보가 아닌 회원을 뒤에 잇는다: 현재 1위가 달이 끝났을 때의 왕과 어긋나지 않게.
--  - 왕은 전과 같이 후보만 된다. 확정(publish_monthly_awards)은 qualified인 1위만 저장한다.
--  - 평가왕은 평가받은 식사가 있어야, 꾸준왕은 기록이, 운동왕은 운동한 날이 있어야 순위에 든다(견줄 값이 없으면 순위가 없다).
drop function private.award_ranking(date, date, boolean, uuid);
create function private.award_ranking(p_from date, p_to date, p_workout boolean, p_trainer uuid default null)
returns table (trainer_id uuid, kind text, member_id uuid, score numeric, rk bigint, qualified boolean)
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
    select s.trainer_id, s.member_id, s.avg_score, s.meals >= 10 and s.rated >= 10 as ok,
           rank() over (partition by s.trainer_id order by s.meals >= 10 and s.rated >= 10 desc, s.avg_score desc, s.days desc) as rk
      from stat s where s.rated >= 1
  ), streak as (
    select s.trainer_id, s.member_id, r.best, s.meals >= 10 as ok,
           rank() over (partition by s.trainer_id order by s.meals >= 10 desc, r.best desc, s.days desc) as rk
      from stat s join runs r on r.member_id = s.member_id
  ), wdays as (
    select p.trainer_id, w.member_id, count(distinct w.day) as days
      from pool p join public.workout_sessions w on w.member_id = p.member_id
     where p_workout and w.day between p_from and p_to
       and private.is_workout_session(w.id)
     group by p.trainer_id, w.member_id
  ), workout as (
    select d.trainer_id, d.member_id, d.days, d.days >= 8 as ok,
           rank() over (partition by d.trainer_id order by d.days >= 8 desc, d.days desc) as rk
      from wdays d
  )
  select g.trainer_id, 'rating'::text, g.member_id, round(g.avg_score, 2), g.rk, g.ok from rating g
  union all select k.trainer_id, 'streak', k.member_id, k.best::numeric, k.rk, k.ok from streak k
  union all select w.trainer_id, 'workout', w.member_id, w.days::numeric, w.rk, w.ok from workout w;
$$;
revoke execute on function private.award_ranking(date, date, boolean, uuid) from public, anon, authenticated;

create or replace function private.publish_monthly_awards(p_month date)
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

  insert into public.monthly_awards (month, trainer_id, kind, member_id, score)
  select v_from, r.trainer_id, r.kind, r.member_id, r.score from private.award_ranking(v_from, v_to, v_workout) r where r.rk = 1 and r.qualified;
  get diagnostics v_n = row_count;
  insert into private.award_runs (month, winners) values (v_from, v_n);
  return v_n;
end;
$$;
revoke execute on function private.publish_monthly_awards(date) from public, anon, authenticated;

create or replace function public.award_standings(p_today date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid; v_from date;
  v_starts date := coalesce((select s.value::date from public.app_settings s where s.key = 'award_from'), date '2999-01-01');
  v_wstarts date := coalesce((select s.value::date from public.app_settings s where s.key = 'workout_award_from'), date '2999-01-01');
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  v_from := date_trunc('month', p_today)::date;
  v_trainer := private.shared_scope_trainer();
  return jsonb_build_object(
    'month', v_from,
    'started', v_from >= v_starts,
    'starts', v_starts,
    'workout_started', v_from >= v_wstarts,
    'workout_starts', v_wstarts,
    'rows', case when v_from < v_starts or v_trainer is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'rank', x.rk, 'nickname', x.nickname, 'score', x.score, 'is_me', x.is_me, 'qualified', x.qualified)
             order by x.kind, x.rk, x.nickname)
        from (select r.kind, r.rk, r.score, r.qualified, r.member_id = v_uid as is_me,
                     case when p.award_public or r.member_id = v_uid then p.nickname else '익명 회원' end as nickname
                from private.award_ranking(v_from, p_today, v_from >= v_wstarts, v_trainer) r
                join public.profiles p on p.id = r.member_id
               where r.rk <= 3 or r.member_id = v_uid) x), '[]'::jsonb) end
  );
end;
$$;
revoke execute on function public.award_standings(date) from public, anon;
grant execute on function public.award_standings(date) to authenticated;
