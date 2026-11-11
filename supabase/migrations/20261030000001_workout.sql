-- v2.0 운동(계획서 4단계): 트레이너가 정한 루틴(계획)과 회원이 실제로 한 운동(수행)을 따로 저장한다.
--  - 루틴 양식은 트레이너의 실제 시트를 따른다(2026-10-30 확인): 한 달이 탭 하나, 탭 맨 위 '운동 전 필수 동작', 운동 날 1·2·3 블록,
--    열은 운동·SET·REPS·중량·REST. 중량·횟수는 '32+40'·'10/10'·'30 S'처럼 글자가 섞이므로 글자로 저장한다.
--  - 루틴은 판(version)으로 쌓는다. 고치면 새 판이 생기고 옛 판은 남는다 → 이미 끝낸 운동 기록은 옛 판을 가리킨 채 바뀌지 않는다.
--  - 수행 기록은 세션(그날 한 번의 운동)과 세트로 나눈다. 세트에는 운동 이름을 복사해 두어 루틴이 바뀌어도 기록이 읽힌다.
--  - 쓰기는 함수로만: 계정 잠금 → 세션 확인(private.lock_account_and_check) → 대상 행 잠금. 회원 본인·지금 담당 트레이너만 읽는다.

create table public.routines (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.profiles(id) on delete cascade,
  trainer_id  uuid references public.profiles(id) on delete set null,
  version     int not null check (version >= 1),
  title       text not null check (char_length(btrim(title)) between 1 and 60),
  goal        text not null default '' check (char_length(goal) <= 300),
  reason      text not null default '' check (char_length(reason) <= 300),
  warmup      text not null default '' check (char_length(warmup) <= 1000),
  source      text not null default 'manual' check (source in ('manual', 'paste', 'sheet')),
  source_ref  text not null default '' check (char_length(source_ref) <= 60),
  created_at  timestamptz not null default now(),
  unique (member_id, version)
);
create table public.routine_items (
  id          uuid primary key default gen_random_uuid(),
  routine_id  uuid not null references public.routines(id) on delete cascade,
  ord         int not null check (ord between 1 and 80),
  day_no      int not null default 1 check (day_no between 1 and 10),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  weight      text not null default '' check (char_length(weight) <= 30),
  reps        text not null default '' check (char_length(reps) <= 30),
  sets        int check (sets is null or sets between 1 and 20),
  rest        text not null default '' check (char_length(rest) <= 10),
  note        text not null default '' check (char_length(note) <= 100),
  unique (routine_id, ord)
);
create index routine_items_routine_idx on public.routine_items (routine_id, ord);

create table public.workout_sessions (
  id           uuid primary key,
  member_id    uuid not null references public.profiles(id) on delete cascade,
  routine_id   uuid references public.routines(id) on delete set null,
  day_no       int check (day_no is null or day_no between 1 and 10),
  day          date not null,
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished     boolean not null default false,
  last_save_id uuid -- 마지막으로 반영한 저장 요청(같은 저장을 다시 보내면 한 번만)
);
create index workout_sessions_member_day_idx on public.workout_sessions (member_id, day desc);
create table public.workout_sets (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.workout_sessions(id) on delete cascade,
  item_id     uuid references public.routine_items(id) on delete set null,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  set_no      int not null check (set_no between 1 and 50),
  kg          numeric(5,1) check (kg is null or kg between 0 and 999),
  reps        int check (reps is null or reps between 0 and 999),
  done        boolean not null default false,
  ord         int not null default 0
);
create index workout_sets_session_idx on public.workout_sets (session_id, ord, set_no);

alter table public.routines enable row level security;
alter table public.routine_items enable row level security;
alter table public.workout_sessions enable row level security;
alter table public.workout_sets enable row level security;
create policy routines_select on public.routines for select to authenticated
using (member_id = (select auth.uid()) or private.is_my_member(member_id));
create policy routine_items_select on public.routine_items for select to authenticated
using (exists (select 1 from public.routines r where r.id = routine_id and (r.member_id = (select auth.uid()) or private.is_my_member(r.member_id))));
create policy workout_sessions_select on public.workout_sessions for select to authenticated
using (member_id = (select auth.uid()) or private.is_my_member(member_id));
create policy workout_sets_select on public.workout_sets for select to authenticated
using (exists (select 1 from public.workout_sessions s where s.id = session_id and (s.member_id = (select auth.uid()) or private.is_my_member(s.member_id))));
create policy session_alive on public.routines as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.routine_items as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.workout_sessions as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
create policy session_alive on public.workout_sets as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.routines, public.routine_items, public.workout_sessions, public.workout_sets from anon, authenticated;
grant select on public.routines, public.routine_items, public.workout_sessions, public.workout_sets to authenticated;

-- 트레이너: 담당 회원의 새 루틴 판. p_items = [{day_no, name, weight, reps, sets, rest, note}] 1～80개. 새 판의 id를 돌려준다
create function public.save_routine(p_member uuid, p_title text, p_goal text, p_reason text, p_items jsonb, p_source text default 'manual', p_warmup text default '', p_source_ref text default '')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_id uuid; v_ver int; v_item jsonb; v_ord int := 0;
begin
  perform private.lock_account_and_check(v_uid);
  -- 같은 회원의 판 번호가 겹치지 않게 회원 행을 잠근다(담당 확인도 잠근 뒤에)
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found or not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 80 then raise exception 'bad_items'; end if;
  if coalesce(p_source, 'manual') not in ('manual', 'paste', 'sheet') then raise exception 'bad_source'; end if;
  select coalesce(max(r.version), 0) + 1 into v_ver from public.routines r where r.member_id = p_member;
  insert into public.routines (member_id, trainer_id, version, title, goal, reason, source, warmup, source_ref)
  values (p_member, v_uid, v_ver, btrim(coalesce(p_title, '')), btrim(coalesce(p_goal, '')), btrim(coalesce(p_reason, '')), coalesce(p_source, 'manual'),
          btrim(coalesce(p_warmup, '')), btrim(coalesce(p_source_ref, '')))
  returning id into v_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_ord := v_ord + 1;
    insert into public.routine_items (routine_id, ord, day_no, name, weight, reps, sets, rest, note)
    values (v_id, v_ord, coalesce(nullif(v_item ->> 'day_no', '')::int, 1), btrim(coalesce(v_item ->> 'name', '')), btrim(coalesce(v_item ->> 'weight', '')),
            btrim(coalesce(v_item ->> 'reps', '')), nullif(v_item ->> 'sets', '')::int, btrim(coalesce(v_item ->> 'rest', '')), btrim(coalesce(v_item ->> 'note', '')));
  end loop;
  return v_id;
end;
$$;

-- 회원: 운동 기록 저장. 처음이면 만들고, 다시 저장하면 세트를 통째로 바꾼다. 세션 id는 앱이 운동을 시작할 때 한 번 만든다.
--  - p_save_id: 저장 요청마다 앱이 만든 id. 응답이 끊겨 같은 요청을 다시 보내면 한 번만 반영하고 그때의 수정 시각을 돌려준다
--  - p_base: 이 기기가 읽은 기록의 수정 시각(새 기록이면 null). 서버의 지금 값과 다르면 다른 기기가 먼저 고친 것 → 'conflict'로 거절
--    (덮어쓰지 않는다, Codex v2.0.0 1차 리뷰 3). 읽은 기록이 그사이 지워졌으면 'gone'
--  - 날짜 제한(최근 7일～이틀 뒤)은 새 기록에만. 이미 있는 기록은 날짜와 관계없이 고칠 수 있고 날짜는 바꾸지 않는다(리뷰 4)
--  - p_sets = [{item_id?, name, set_no, kg, reps, done}] 0～200개. 돌려주는 값 = 새 수정 시각(다음 저장의 p_base)
create function public.save_workout(p_session uuid, p_day date, p_routine uuid, p_sets jsonb, p_finished boolean, p_day_no int default null, p_base timestamptz default null, p_save_id uuid default null)
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
            btrim(coalesce(v_s ->> 'name', '')), (v_s ->> 'set_no')::int, nullif(v_s ->> 'kg', '')::numeric, nullif(v_s ->> 'reps', '')::int,
            coalesce((v_s ->> 'done')::boolean, false), v_ord);
  end loop;
  return v_now;
end;
$$;

create function public.delete_workout(p_session uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  delete from public.workout_sessions s where s.id = p_session and s.member_id = v_uid;
  if not found then raise exception 'not_allowed'; end if;
end;
$$;

-- 변화(지난 측정 이후)에 쓰는 기간별 운동 요약: 운동한 날(완료 세트가 하나라도 있는 날)·완료 세트 수. 회원 본인·담당 트레이너
create function public.workout_summary(p_member uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_member is distinct from v_uid and not private.is_my_member(p_member) then raise exception 'not_allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 730 then raise exception 'bad_range'; end if;
  select jsonb_build_object(
    'days', count(distinct s.day) filter (where exists (select 1 from public.workout_sets w where w.session_id = s.id and w.done)),
    'done_sets', coalesce(sum((select count(*) from public.workout_sets w where w.session_id = s.id and w.done)), 0)
  ) into v
  from public.workout_sessions s where s.member_id = p_member and s.day between p_from and p_to;
  return v;
end;
$$;

revoke execute on function public.save_routine(uuid, text, text, text, jsonb, text, text, text), public.save_workout(uuid, date, uuid, jsonb, boolean, int, timestamptz, uuid),
  public.delete_workout(uuid), public.workout_summary(uuid, date, date) from public, anon;
grant execute on function public.save_routine(uuid, text, text, text, jsonb, text, text, text), public.save_workout(uuid, date, uuid, jsonb, boolean, int, timestamptz, uuid),
  public.delete_workout(uuid), public.workout_summary(uuid, date, date) to authenticated;
