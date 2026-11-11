-- 이달의 중량왕(2.3 — 트레이너 의견 11-03, 사용자 결정 11-05, 문서/기획/2_3_범위와_결정_261105.md).
--  - 운동 이름이 정확히 '벤치 프레스'·'데드리프트'·'스쿼트'이고 횟수가 5로 적힌 완료 세트만 센다(시트 기록은 가져온 회차의 세트가 완료로 들어 있다). 무게는 숫자로만 적힌 값만 쓴다.
--  - 같은 트레이너의 회원끼리, 남녀를 나눠 동작마다 무게 왕·체중 대비 왕을 뽑는다. 같은 값이면 공동이다. 체중 대비는 화면에 보이는 정수 퍼센트로 견준다.
--  - 그 동작의 무게 왕은 그 동작의 체중 대비 왕이 될 수 없다(사용자 11-05): 한 사람의 무게와 퍼센트가 함께 보이면 다른 회원이 체중을 계산할 수 있다.
--  - 체중은 그달 마지막 체중 기록(공복 체중·인바디 가운데 가장 나중, 그달에 없으면 그 전 마지막). 같은 날이면 인바디. 기록이 없으면 체중 대비 후보에서 빠진다.
--  - 성별을 정하지 않았거나 '성별 공개하지 않기'면 후보에서 빠진다. 닉네임 공개를 끈 회원은 식단왕·운동왕과 같이 '익명 회원'으로 보인다.
--  - 달 마감 저장 없이 볼 때마다 기록에서 센다. 수상을 시작하기 전 달(award_from 앞)은 세지 않는다(10월은 수상이 없다, 사용자 11-05).
create function private.strength_board(p_from date, p_to date, p_trainer uuid)
returns table (member_id uuid, gender text, lift text, kg numeric, body_kg numeric, pct int, kg_rank bigint, pct_rank bigint)
language sql stable security definer set search_path = ''
as $$
  with pool as (
    select a.member_id, g.gender
      from public.assignments a
      join public.profiles t on t.id = a.trainer_id join public.profiles m on m.id = a.member_id
      join private.member_gender g on g.member_id = a.member_id
     where a.trainer_id = p_trainer and not t.is_test and not m.is_test and g.gender is not null and not g.hidden
  ), sets as (
    select p.member_id, p.gender, x.name as lift,
           case when btrim(x.kg) ~ '^[0-9]{1,3}(\.[0-9]+)?$' then btrim(x.kg)::numeric end as kg
      from pool p
      join public.workout_sessions w on w.member_id = p.member_id and w.day between p_from and p_to
      join public.workout_sets x on x.session_id = w.id
     where x.done and btrim(x.reps) = '5' and x.name in ('벤치 프레스', '데드리프트', '스쿼트')
  ), best as (
    select s.member_id, s.gender, s.lift, max(s.kg) as kg from sets s where s.kg > 0 group by s.member_id, s.gender, s.lift
  ), scored as (
    select b.member_id, b.gender, b.lift, b.kg, y.kg as body_kg, round(b.kg / y.kg * 100)::int as pct
      from best b
      left join lateral (
        select v.kg from (
          select i.measured_on as day, i.weight_kg as kg, 0 as ord from public.inbody_records i where i.member_id = b.member_id and i.measured_on <= p_to
          union all
          select f.day, f.kg, 1 from public.fasting_weights f where f.member_id = b.member_id and f.day <= p_to
        ) v order by v.day desc, v.ord limit 1
      ) y on true
  ), ranked as (
    select s.*, rank() over (partition by s.gender, s.lift order by s.kg desc) as kg_rank from scored s
  )
  select r.member_id, r.gender, r.lift, r.kg, r.body_kg, r.pct, r.kg_rank,
         case when r.pct is not null and r.kg_rank > 1
              then rank() over (partition by r.gender, r.lift order by case when r.kg_rank > 1 then r.pct end desc nulls last) end
    from ranked r;
$$;
revoke execute on function private.strength_board(date, date, uuid) from public, anon, authenticated;

-- p_month = 그달 1일. 이번 달은 p_today까지 센다
create function public.strength_kings(p_month date, p_today date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid; v_to date; v_role text; v_gender text; v_hidden boolean; v_out jsonb;
  v_starts date := coalesce((select s.value::date from public.app_settings s where s.key = 'award_from'), date '2999-01-01');
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date or p_month > p_today then raise exception 'bad_month'; end if;
  if p_month < v_starts then
    return jsonb_build_object('month', p_month, 'started', false, 'kings', '[]'::jsonb, 'mine', '[]'::jsonb, 'my_gender', null, 'my_state', null);
  end if;
  v_to := least((p_month + interval '1 month' - interval '1 day')::date, p_today);
  v_trainer := private.shared_scope_trainer();
  select p.role into v_role from public.profiles p where p.id = v_uid;
  select g.gender, g.hidden into v_gender, v_hidden from private.member_gender g where g.member_id = v_uid;
  with b as materialized (
    select * from private.strength_board(p_month, v_to, v_trainer)
  ), k as (
    select x.gender, x.lift, 'kg' as metric, x.kg as value,
           jsonb_agg(jsonb_build_object('nickname', case when p.award_public or x.member_id = v_uid then p.nickname else '익명 회원' end, 'is_me', x.member_id = v_uid) order by p.nickname) as names
      from b x join public.profiles p on p.id = x.member_id where x.kg_rank = 1 group by x.gender, x.lift, x.kg
    union all
    select x.gender, x.lift, 'pct', x.pct::numeric,
           jsonb_agg(jsonb_build_object('nickname', case when p.award_public or x.member_id = v_uid then p.nickname else '익명 회원' end, 'is_me', x.member_id = v_uid) order by p.nickname)
      from b x join public.profiles p on p.id = x.member_id where x.pct_rank = 1 group by x.gender, x.lift, x.pct
  )
  select jsonb_build_object(
    'month', p_month,
    'started', true,
    'kings', coalesce((select jsonb_agg(jsonb_build_object('gender', k.gender, 'lift', k.lift, 'metric', k.metric, 'value', k.value, 'names', k.names)) from k), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('lift', x.lift, 'kg', x.kg, 'kg_rank', x.kg_rank, 'pct', x.pct, 'pct_rank', x.pct_rank, 'body_kg', x.body_kg)) from b x where x.member_id = v_uid), '[]'::jsonb),
    'my_gender', case when coalesce(v_hidden, false) then null else v_gender end,
    'my_state', case when v_role <> 'member' then null when coalesce(v_hidden, false) then 'hidden' when v_gender is null then 'no_gender' else 'ok' end
  ) into v_out;
  return v_out;
end;
$$;
revoke execute on function public.strength_kings(date, date) from public, anon;
grant execute on function public.strength_kings(date, date) to authenticated;
