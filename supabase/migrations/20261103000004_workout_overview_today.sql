-- 운동 기록 요약(workout_overview) 고침(2026-11-03, v2.1.0 운영 반영 뒤 — 남은 적대 검토 의심 두 가지)
--  - 기기 날짜(p_today)가 서버(한국) 날짜와 이틀 넘게 다르면 거절하던 것(bad_day)을, 서버 날짜로 세도록. 어느 날짜로 셌는지 'today'로 돌려준다
--    (앱은 그 날짜로 달력·이번 달을 그린다). 기기 시계가 틀린 휴대폰에서 요약이 늘 '불러오지 못했어요'였다.
--  - 지금 판의 진행: 앱 기록은 저장 때 고른 판을 그대로 믿고, 시트에서 가져온 기록은 판을 받은 다음 날부터만 센다
--    (예전에는 둘 다 판을 받은 날부터 — 그날 옛 판으로 한 시트 회차가 새 판으로 셌다). 앱의 localProgress와 같은 규칙.
--  나머지는 20261103000003 그대로
create or replace function public.workout_overview(p_member uuid, p_today date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_kst date := (now() at time zone 'Asia/Seoul')::date; v_today date; v_ws date; v_month date; v_from date; v_rt public.routines; v_vday date; v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  -- 기기 날짜가 서버(한국) 날짜와 이틀 넘게 다르면(기기 시계가 틀림) 서버 날짜로 센다 — 예전에는 거절해 요약이 계속 실패했다
  v_today := case when p_today between v_kst - 2 and v_kst + 2 then p_today else v_kst end;
  v_ws := v_today - extract(dow from v_today)::int;
  v_month := date_trunc('month', v_today)::date;
  v_from := least(v_ws - 28, v_month);
  select * into v_rt from public.routines r where r.member_id = p_member order by r.version desc limit 1;
  v_vday := (v_rt.created_at at time zone 'Asia/Seoul')::date;
  with w as (
    select s.id, s.day, s.day_no, s.started_at, s.routine_id, s.source,
           exists (select 1 from public.workout_sets x where x.session_id = s.id and x.done) strength,
           exists (select 1 from public.workout_cardio c where c.session_id = s.id) cardio
      from public.workout_sessions s
     where s.member_id = p_member and s.day <= v_today and private.is_workout_session(s.id)),
  weeks as (select distinct w.day - extract(dow from w.day)::int wk from w),
  s0 as (select case when exists (select 1 from weeks where wk = v_ws) then v_ws else v_ws - 7 end s0),
  run as (select k.wk, row_number() over (order by k.wk desc) rn from weeks k, s0 where k.wk <= s0.s0),
  -- 이 판으로 한 운동: 앱 기록은 저장할 때 고른 판(routine_id)을 그대로 믿는다. 시트에서 가져온 기록은 그 탭의 최신 판을 가리키므로
  -- 판을 받은 다음 날부터만 — 판을 받은 날의 시트 회차는 옛 판으로 했는지 새 판으로 했는지 알 수 없어 세지 않는다(적대 검토 11-03)
  mine as (select * from w where v_rt.id is not null and w.routine_id = v_rt.id and w.day_no is not null and (w.source = 'app' or w.day > v_vday))
  select jsonb_build_object(
    'this_week', (select count(*) from w where w.day >= v_ws),
    'this_month', (select count(*) from w where w.day >= v_month),
    'streak_weeks', (select count(*) from run, s0 where run.wk = s0.s0 - 7 * (run.rn - 1)::int),
    'from', v_from,
    'today', v_today,
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
