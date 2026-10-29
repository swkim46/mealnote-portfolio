-- Run once as the database owner. This adds an aggregate view and a reader role;
-- it does not change application records, RLS policies, or existing roles.
begin;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'portfolio_metrics_reader') then
    create role portfolio_metrics_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2;
  end if;
end $$;

create schema if not exists portfolio_metrics authorization postgres;
revoke all on schema portfolio_metrics from public, anon, authenticated;

create or replace view portfolio_metrics.daily_usage
with (security_barrier = true) as
with settings as (
  select (now() at time zone 'Asia/Seoul')::date as today
), members as (
  select p.id, (p.created_at at time zone 'Asia/Seoul')::date as day
  from public.profiles p, settings s
  where p.role = 'member' and not coalesce(p.is_test, false)
    and p.created_at < (s.today::timestamp at time zone 'Asia/Seoul')
), meals as (
  select m.member_id, (m.created_at at time zone 'Asia/Seoul')::date as day
  from public.meals m
  join members p on p.id = m.member_id
  cross join settings s
  where m.created_at < (s.today::timestamp at time zone 'Asia/Seoul')
), starts as (
  select min(day) as day from (
    select day from members union all select day from meals
  ) events
), calendar as (
  select start.day + n as day
  from starts start, settings s,
    lateral generate_series(0, s.today - start.day - 1) as n
), signups as (
  select day, count(*) as total from members group by day
), activity as (
  select day, count(distinct member_id) as active, count(*) as total
  from meals group by day
)
select c.day as date,
  sum(coalesce(p.total, 0)) over (order by c.day)::bigint as members_total,
  coalesce(m.active, 0)::bigint as active_members,
  sum(coalesce(m.total, 0)) over (order by c.day)::bigint as meals_total
from calendar c
left join signups p on p.day = c.day
left join activity m on m.day = c.day;

revoke all on portfolio_metrics.daily_usage from public, anon, authenticated;
grant usage on schema portfolio_metrics to portfolio_metrics_reader;
grant select on portfolio_metrics.daily_usage to portfolio_metrics_reader;
alter role portfolio_metrics_reader set default_transaction_read_only = on;
alter role portfolio_metrics_reader set statement_timeout = '15s';
alter role portfolio_metrics_reader set idle_in_transaction_session_timeout = '15s';
commit;
