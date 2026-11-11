-- v2.1 운동 기록의 중량·횟수를 글자로(2026-11-02 사용자 피드백 "횟수 입력에 기호 입력 가능하게").
--  - 횟수: '12+12'(두 동작)·'10/10'(양쪽)·'30초'·'max'처럼 시트에 쓰는 형식을 그대로 적는다.
--  - 중량도 글자: 시트의 중량 칸에 '35+8'·'60-'·'17.5,20'이 있어, 시트에서 가져온 기록을 담고 시트에 그대로 써 넣으려면 글자여야 한다.
--  - 이 값으로 계산하는 곳은 없다(운동한 날·완료 세트 수만 센다). 기존 숫자는 '60.0' → '60'처럼 옮긴다.
--  - 옛 앱(2.0.x)은 숫자를 보낸다 — jsonb ->> 로 받으면 '60'·'60.5' 글자가 되어 그대로 저장된다.

alter table public.workout_sets drop constraint if exists workout_sets_kg_check;
alter table public.workout_sets drop constraint if exists workout_sets_reps_check;
alter table public.workout_sets
  alter column kg type text using regexp_replace(kg::text, '\.0$', ''),
  alter column reps type text using reps::text;
alter table public.workout_sets
  add constraint workout_sets_kg_check check (kg is null or char_length(kg) between 1 and 30),
  add constraint workout_sets_reps_check check (reps is null or char_length(reps) between 1 and 30);

-- 저장 함수: 숫자 변환만 글자로 바꾼다(앞뒤 공백은 지우고 빈 글자는 null). 나머지 규칙은 20261030000001 그대로
create or replace function public.save_workout(p_session uuid, p_day date, p_routine uuid, p_sets jsonb, p_finished boolean, p_day_no int default null, p_base timestamptz default null, p_save_id uuid default null)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_owner uuid; v_updated timestamptz; v_last uuid; v_s jsonb; v_ord int := 0; v_now timestamptz := clock_timestamp();
begin
  perform private.lock_account_and_check(v_uid);
  if p_session is null then raise exception 'bad_request'; end if;
  if p_day_no is not null and p_day_no not between 1 and 10 then raise exception 'bad_day_no'; end if;
  if p_sets is null or jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) > 200 then raise exception 'bad_sets'; end if;
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
  return v_now;
end;
$$;
