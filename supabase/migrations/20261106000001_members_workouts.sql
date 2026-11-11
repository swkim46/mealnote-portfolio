-- 트레이너 화면의 회원 운동(2.3, v2.3.0 3차 리뷰): 담당 회원의 최근 기록을 문장 하나로 읽는다.
--  - 새 운동 기록은 받은 기록의 ID와 판으로 본 처리한다. 쪽을 나눠 받으면 쪽 사이의 삭제·삽입으로 목록에서 기록이 빠진다.
--  - 문장 하나는 한 시점의 기록 전부를 본다. 결과가 값 하나라 서버의 행 상한(max_rows)에도 걸리지 않는다.
--  - 권한은 부른 사람의 표 정책 그대로(security invoker): 표를 직접 조회할 때와 같은 기록만 나온다.
create function public.members_workouts(p_members uuid[], p_from date)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'member_id', s.member_id, 'routine_id', s.routine_id, 'day_no', s.day_no, 'day', s.day,
    'started_at', s.started_at, 'updated_at', s.updated_at, 'finished', s.finished,
    'source', s.source, 'sheet_tab', s.sheet_tab, 'sheet_col', s.sheet_col,
    'sets', (select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'name', x.name, 'set_no', x.set_no, 'kg', x.kg, 'reps', x.reps, 'done', x.done, 'ord', x.ord)), '[]'::jsonb)
               from public.workout_sets x where x.session_id = s.id),
    'cardio', (select coalesce(jsonb_agg(jsonb_build_object('kind', c.kind, 'minutes', c.minutes, 'km', c.km, 'speed', c.speed, 'ord', c.ord)), '[]'::jsonb)
                 from public.workout_cardio c where c.session_id = s.id)
  ) order by s.day desc, s.started_at desc, s.id desc), '[]'::jsonb)
  from public.workout_sessions s
  where s.member_id = any(p_members) and s.day >= p_from;
$$;
revoke all on function public.members_workouts(uuid[], date) from public, anon;
grant execute on function public.members_workouts(uuid[], date) to authenticated;
