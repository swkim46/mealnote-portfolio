-- 인바디 변화 보고서(2.3 — 사용자 선택 11-05, 문서/기획/2_3_범위와_결정_261105.md).
--  - 식단 평가 흐름: 날마다·끼니마다 평가를 센다. 점수 규칙은 private.rating_score 한 곳(diet_report와 같다).
--  - 트레이너 총평: 인바디 측정 하나에 하나. 측정을 지우면 함께 지워지고, 측정 날짜를 고쳐도 그대로 따라간다.
--    앱에 드러나지 않는 표에 두고 함수로만 읽고 쓴다(쓴 사람의 닉네임을 함께 돌려주기 위해).
create function public.diet_period(p_member uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 730 then raise exception 'bad_range'; end if;
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.eaten_on, 'meals', d.meals, 'rated', d.rated, 'score_sum', d.score_sum) order by d.eaten_on)
      from (select m.eaten_on, count(*) as meals, count(m.rating) as rated, coalesce(sum(private.rating_score(m.rating)), 0) as score_sum
              from public.meals m where m.member_id = p_member and m.eaten_on between p_from and p_to group by m.eaten_on) d), '[]'::jsonb),
    'types', coalesce((select jsonb_agg(jsonb_build_object('meal_type', t.meal_type, 'great', t.great, 'good', t.good, 'care', t.care, 'none', t.none))
      from (select m.meal_type, count(*) filter (where m.rating = 1) as great, count(*) filter (where m.rating = 2) as good,
                   count(*) filter (where m.rating = 3) as care, count(*) filter (where m.rating is null) as none
              from public.meals m where m.member_id = p_member and m.eaten_on between p_from and p_to group by m.meal_type) t), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

create table private.report_notes (
  inbody_id  uuid primary key references public.inbody_records(id) on delete cascade,
  trainer_id uuid references public.profiles(id) on delete set null,
  body       text not null check (char_length(body) between 1 and 1000),
  updated_at timestamptz not null default now()
);

create function public.report_note(p_inbody uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_member uuid; v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  select i.member_id into v_member from public.inbody_records i where i.id = p_inbody;
  if v_member is null or (v_member is distinct from v_uid and not private.is_my_member(v_member)) then raise exception 'not_allowed'; end if;
  select jsonb_build_object('body', n.body, 'trainer', p.nickname, 'updated_at', n.updated_at) into v
    from private.report_notes n left join public.profiles p on p.id = n.trainer_id where n.inbody_id = p_inbody;
  return v;
end;
$$;

-- 담당 트레이너만 쓴다. 빈 글은 총평을 지운다
create function public.save_report_note(p_inbody uuid, p_body text)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_member uuid; v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
begin
  perform private.lock_account_and_check(v_uid);
  select i.member_id into v_member from public.inbody_records i where i.id = p_inbody;
  if v_member is null or not private.is_my_member(v_member) then raise exception 'not_allowed'; end if;
  if char_length(v_body) > 1000 then raise exception 'bad_note'; end if;
  if v_body = '' then
    delete from private.report_notes n where n.inbody_id = p_inbody;
  else
    insert into private.report_notes (inbody_id, trainer_id, body) values (p_inbody, v_uid, v_body)
    on conflict (inbody_id) do update set trainer_id = excluded.trainer_id, body = excluded.body, updated_at = now();
  end if;
end;
$$;

revoke execute on function public.diet_period(uuid, date, date), public.report_note(uuid), public.save_report_note(uuid, text) from public, anon;
grant execute on function public.diet_period(uuid, date, date), public.report_note(uuid), public.save_report_note(uuid, text) to authenticated;
