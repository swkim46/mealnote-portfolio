-- 운동 기록 탭의 요약과 기록 카드 비교를 서버에서 센다(2026-11-03 Codex v2.1.0 3차 리뷰 P2·P3).
--  앱이 받는 운동 기록은 최근 30개(fetchWorkouts)라, 그 목록으로 이번 달 횟수·연속 주·최근 5주 달력·최고 기록을 정하면 30개 밖의 기록이 빠졌다
--  (이번 달 31회를 30회로, 달력 안의 날을 빈 날로, 30개 밖의 100kg을 모른 채 50kg을 최고로). 목록은 그대로 두고 요약·비교만 따로 받는다.
--  운동한 기록 = 완료 세트나 유산소가 있는 기록(private.is_workout_session과 같은 기준). 횟수는 기록 수다(같은 날 두 번이면 두 번 — 날 수가 아님).
--  기록의 앞뒤는 (날짜, 시작 시각, id) 순서로 정한다 — 같은 날 먼저 한 기록도 '이전 기록'이다(3차 리뷰 P3).

-- 요약: 이번 주(일요일부터)·이번 달 횟수, 연속 주(운동한 주가 이어진 수 — 이번 주에 아직 안 했으면 지난주부터),
--  달력에 쓸 기록(최근 5주와 이번 달 1일 가운데 이른 날부터 p_today까지, 운동한 기록 전부 — 개수 제한 없음),
--  지금 판(가장 최근 루틴 판)의 진행: 그 판을 가리키고 판을 받은 날(한국 날짜) 이후에 한 운동 기록만 — 루틴 번호마다 마지막 한 날·가장 최근 루틴 번호.
--  p_today = 기기의 오늘(한국). 반환 {this_week, this_month, streak_weeks, from, days: [{day, day_no, started_at, strength, cardio}], routine: {id, last: {루틴 번호: 날짜}, latest_day_no} | null}
create function public.workout_overview(p_member uuid, p_today date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_ws date; v_month date; v_from date; v_rt public.routines; v_vday date; v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between (now() at time zone 'Asia/Seoul')::date - 2 and (now() at time zone 'Asia/Seoul')::date + 2 then raise exception 'bad_day'; end if;
  v_ws := p_today - extract(dow from p_today)::int;
  v_month := date_trunc('month', p_today)::date;
  v_from := least(v_ws - 28, v_month);
  select * into v_rt from public.routines r where r.member_id = p_member order by r.version desc limit 1;
  v_vday := (v_rt.created_at at time zone 'Asia/Seoul')::date;
  with w as (
    select s.id, s.day, s.day_no, s.started_at, s.routine_id,
           exists (select 1 from public.workout_sets x where x.session_id = s.id and x.done) strength,
           exists (select 1 from public.workout_cardio c where c.session_id = s.id) cardio
      from public.workout_sessions s
     where s.member_id = p_member and s.day <= p_today and private.is_workout_session(s.id)),
  weeks as (select distinct w.day - extract(dow from w.day)::int wk from w),
  s0 as (select case when exists (select 1 from weeks where wk = v_ws) then v_ws else v_ws - 7 end s0),
  run as (select k.wk, row_number() over (order by k.wk desc) rn from weeks k, s0 where k.wk <= s0.s0),
  mine as (select * from w where v_rt.id is not null and w.routine_id = v_rt.id and w.day >= v_vday and w.day_no is not null)
  select jsonb_build_object(
    'this_week', (select count(*) from w where w.day >= v_ws),
    'this_month', (select count(*) from w where w.day >= v_month),
    'streak_weeks', (select count(*) from run, s0 where run.wk = s0.s0 - 7 * (run.rn - 1)::int),
    'from', v_from,
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', w.day, 'day_no', w.day_no, 'started_at', w.started_at, 'strength', w.strength, 'cardio', w.cardio)
                                       order by w.day, w.started_at, w.id) from w where w.day >= v_from), '[]'::jsonb),
    'routine', case when v_rt.id is null then null else jsonb_build_object(
      'id', v_rt.id,
      'last', coalesce((select jsonb_object_agg(m.day_no, m.last) from (select mine.day_no, max(mine.day) last from mine group by mine.day_no) m), '{}'::jsonb),
      'latest_day_no', (select mine.day_no from mine order by mine.day desc, mine.started_at desc, mine.id desc limit 1)) end
  ) into v;
  return v;
end;
$$;
revoke execute on function public.workout_overview(uuid, date) from public, anon;
grant execute on function public.workout_overview(uuid, date) to authenticated;

-- 기록 카드 비교: 보이는 기록(p_sessions)마다, 그 기록의 운동마다 그 앞의 모든 기록(최근 30개 밖 포함)에서
--  prior = 무게를 단 완료 세트 가운데 가장 무거운 무게(숫자 묶음 — 앱의 weightKey·heavier와 같은 비교: 앞 숫자부터, 숫자가 더 있으면 더 무거움), 없으면 null
--  prev  = 그 운동을 마지막으로 한 앞 기록의 가장 무거운 세트 무게(글자 그대로, 지난번보다 오른 무게를 셀 때)
--  반환 {기록 id: {운동 이름: {prior, prev}}}. 앱은 prior보다 무거우면 최고 기록, 아니면 prev보다 무거운 만큼을 표시한다
create function public.workout_compare(p_member uuid, p_sessions uuid[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_sessions is null or cardinality(p_sessions) > 100 then raise exception 'bad_sessions'; end if;
  with d as (
    select s.id sid, s.day, s.started_at, x.name, x.kg,
           -- 숫자는 0～9만 — \d는 DB 문자 규칙에 따라 전각 숫자(４０) 등도 잡아 numeric 변환이 실패하고, 그 회원의 비교 전체가 멈췄다(적대 검토 11-03).
           -- 앱의 weightKey(/\d/ — 0～9만)와 같다
           array(select m[1]::numeric from regexp_matches(coalesce(x.kg, ''), '([0-9]+(?:\.[0-9]+)?)', 'g') as m) k
      from public.workout_sessions s join public.workout_sets x on x.session_id = s.id
     where s.member_id = p_member and x.done),
  t as (select distinct d.sid, d.day, d.started_at, d.name from d where d.sid = any (p_sessions)),
  r as (
    select t.sid, t.name,
      (select max(e.k) from d e where e.name = t.name and cardinality(e.k) > 0 and (e.day, e.started_at, e.sid) < (t.day, t.started_at, t.sid)) prior,
      (select e.kg from d e
        where e.name = t.name
          and e.sid = (select f.sid from d f where f.name = t.name and (f.day, f.started_at, f.sid) < (t.day, t.started_at, t.sid)
                        order by f.day desc, f.started_at desc, f.sid desc limit 1)
        order by e.k desc limit 1) prev
      from t)
  select coalesce(jsonb_object_agg(g.sid, g.names), '{}'::jsonb) into v
    from (select r.sid, jsonb_object_agg(r.name, jsonb_build_object('prior', r.prior, 'prev', r.prev)) names from r group by r.sid) g;
  return v;
end;
$$;
revoke execute on function public.workout_compare(uuid, uuid[]) from public, anon;
grant execute on function public.workout_compare(uuid, uuid[]) to authenticated;
