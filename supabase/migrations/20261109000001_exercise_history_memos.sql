-- v2.4 운동 찾기 · 운동별 기록 · 지난번 · 동작별 메모(문서/기획/2_4_범위와_결정_261107.md, 결정 2_4_결정할것_261108.md).
--  - 같은 운동은 이름으로 가린다. 띄어쓰기와 영문 대소문자 차이는 같은 운동으로 본다(비교용 이름 = 공백을 빼고 소문자로).
--    앱의 exerciseKey(src/lib/exercise.ts)와 같은 규칙이다.
--  - 완료한 세트만 센다. 앱 기록과 시트에서 가져온 기록을 함께 본다.
--  - 조회 함수는 부른 사람의 표 정책 그대로(security invoker): 회원 본인과 지금 담당 트레이너만 읽는다. 결과는 값 하나라 행 상한에 걸리지 않는다.
--  - 메모는 기록이 아니라 '회원 × 운동 이름'에 붙는다 → 다음 주·다음 달 루틴에 같은 이름의 운동이 있으면 그대로 보인다.
--    칸은 회원 몫과 트레이너 몫 둘. 각자 자기 칸만 고친다(트레이너 칸은 담당이 바뀌면 새 담당이 이어받는다).

-- 비교용 이름(운동 이름 → 공백 없이 소문자). 표 정책 안의 조회에서 쓰므로 로그인한 사용자에게 연다.
-- 지우는 공백은 [[:space:]]에 U+0085·U+FEFF를 더한 것 — 앱의 exerciseKey(/[\s\u0085]+/, \s에 U+FEFF 포함)와 같은 글자를 지운다(넘기기 전 적대 검토 10)
create function private.exercise_key(p_name text)
returns text language sql immutable set search_path = ''
as $$ select lower(regexp_replace(coalesce(p_name, ''), '[[:space:]\u0085\ufeff]+', '', 'g')) $$;
revoke execute on function private.exercise_key(text) from public, anon;
grant execute on function private.exercise_key(text) to authenticated;

-- 운동 찾기 목록: 한 운동마다 비교용 이름 · 마지막으로 쓴 이름 · 한 기록 수 · 마지막 날. 유산소는 종류마다
create function public.exercise_list(p_member uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with x as (
    select private.exercise_key(w.name) k, w.name, s.id sid, s.day, s.started_at
      from public.workout_sessions s join public.workout_sets w on w.session_id = s.id
     where s.member_id = p_member and w.done),
  g as (select x.k, count(distinct x.sid) n, max(x.day) last from x group by x.k),
  nm as (select distinct on (x.k) x.k, x.name from x order by x.k, x.day desc, x.started_at desc, x.sid desc),
  c as (
    select c.kind, count(distinct s.id) n, max(s.day) last
      from public.workout_sessions s join public.workout_cardio c on c.session_id = s.id
     where s.member_id = p_member group by c.kind)
  select jsonb_build_object(
    'strength', coalesce((select jsonb_agg(jsonb_build_object('key', g.k, 'name', nm.name, 'count', g.n, 'last', g.last) order by g.n desc, g.last desc, g.k)
                            from g join nm on nm.k = g.k), '[]'::jsonb),
    'cardio', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'count', c.n, 'last', c.last) order by c.n desc, c.last desc) from c), '[]'::jsonb));
$$;
revoke all on function public.exercise_list(uuid) from public, anon;
grant execute on function public.exercise_list(uuid) to authenticated;

-- 운동별 기록: 그 운동을 한 기록마다 날짜·루틴·출처와 완료한 세트(처음 기록까지, 최근 것부터).
-- p_kind가 있으면 유산소 그 종류의 기록(시간·거리·속도)
create function public.exercise_history(p_member uuid, p_key text, p_kind text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select case when p_kind is null then
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'day', s.day, 'day_no', s.day_no, 'source', s.source,
        'sets', (select jsonb_agg(jsonb_build_object('name', w.name, 'set_no', w.set_no, 'kg', w.kg, 'reps', w.reps) order by w.ord, w.set_no)
                   from public.workout_sets w where w.session_id = s.id and w.done and private.exercise_key(w.name) = p_key))
      order by s.day desc, s.started_at desc, s.id desc)
      from public.workout_sessions s
     where s.member_id = p_member
       and exists (select 1 from public.workout_sets w where w.session_id = s.id and w.done and private.exercise_key(w.name) = p_key)), '[]'::jsonb)
  else
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'day', s.day, 'day_no', s.day_no, 'source', s.source,
        'cardio', (select jsonb_agg(jsonb_build_object('minutes', c.minutes, 'km', c.km, 'speed', c.speed) order by c.ord)
                     from public.workout_cardio c where c.session_id = s.id and c.kind = p_kind))
      order by s.day desc, s.started_at desc, s.id desc)
      from public.workout_sessions s
     where s.member_id = p_member
       and exists (select 1 from public.workout_cardio c where c.session_id = s.id and c.kind = p_kind)), '[]'::jsonb)
  end;
$$;
revoke all on function public.exercise_history(uuid, text, text) from public, anon;
grant execute on function public.exercise_history(uuid, text, text) to authenticated;

-- 지난번: 이름마다 그 운동을 마지막으로 한 기록의 날짜와 완료한 세트. 반환 {운동 이름(받은 그대로): {id, day, sets[]}}. 한 적이 없는 이름은 빠진다.
--  - 이미 저장된 기록(p_session)을 고칠 때는 그 기록보다 앞의 기록만 본다 — 기록의 앞뒤는 (날짜, 시작 시각, id)로 workout_compare와 같다
--    (같은 날 더 늦게 한 기록을 '지난번'으로 보이지 않게)
--  - 새 기록이면 p_day(오늘) 이전 또는 같은 날의 기록
create function public.last_exercise_sets(p_member uuid, p_names text[], p_day date, p_session uuid default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_object_agg(n.name, l.v), '{}'::jsonb)
    from (select distinct u.name from unnest(coalesce(p_names, '{}'::text[])) as u(name) where cardinality(p_names) <= 80) n
    left join lateral (select s.day, s.started_at, s.id from public.workout_sessions s where s.id = p_session and s.member_id = p_member) a on true
    cross join lateral (
      select jsonb_build_object('id', s.id, 'day', s.day,
               'sets', (select jsonb_agg(jsonb_build_object('set_no', w.set_no, 'kg', w.kg, 'reps', w.reps) order by w.ord, w.set_no)
                          from public.workout_sets w where w.session_id = s.id and w.done and private.exercise_key(w.name) = private.exercise_key(n.name))) v
        from public.workout_sessions s
       where s.member_id = p_member and s.id is distinct from p_session
         and (case when a.id is null then s.day <= p_day else (s.day, s.started_at, s.id) < (a.day, a.started_at, a.id) end)
         and exists (select 1 from public.workout_sets w where w.session_id = s.id and w.done and private.exercise_key(w.name) = private.exercise_key(n.name))
       order by s.day desc, s.started_at desc, s.id desc
       limit 1) l;
$$;
revoke all on function public.last_exercise_sets(uuid, text[], date, uuid) from public, anon;
grant execute on function public.last_exercise_sets(uuid, text[], date, uuid) to authenticated;

-- 동작별 메모
create table public.exercise_memos (
  member_id   uuid not null references public.profiles(id) on delete cascade,
  key         text not null check (char_length(key) between 1 and 60),
  author      text not null check (author in ('member', 'trainer')),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  body        text not null check (char_length(btrim(body)) between 1 and 200),
  written_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (member_id, key, author)
);
alter table public.exercise_memos enable row level security;
create policy exercise_memos_select on public.exercise_memos for select to authenticated
using (member_id = (select auth.uid()) or private.is_my_member(member_id));
create policy session_alive on public.exercise_memos as restrictive for all to authenticated using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.exercise_memos from anon, authenticated;
grant select on public.exercise_memos to authenticated;

-- 메모 저장: 회원 본인은 회원 칸, 지금 담당 트레이너는 트레이너 칸. 빈 글이면 그 칸을 지운다.
--  - p_base: 이 기기가 읽은 그 칸의 수정 시각(없던 칸이면 null). 다른 기기가 그 뒤에 고쳤으면 'conflict'로 거절한다(덮어쓰지 않는다)
--  - 돌려주는 값 = 새 수정 시각(지웠으면 null)
create function public.save_exercise_memo(p_member uuid, p_name text, p_body text, p_base timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_author text; v_key text := private.exercise_key(p_name); v_body text := btrim(coalesce(p_body, ''));
        v_updated timestamptz; v_now timestamptz := clock_timestamp();
begin
  perform private.lock_account_and_check(v_uid);
  if p_member is null or char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 or v_key = '' then raise exception 'bad_name'; end if;
  if char_length(v_body) > 200 then raise exception 'too_long'; end if;
  if p_member = v_uid then
    v_author := 'member';
  else
    -- 담당 확인은 담당 행을 잠근 뒤에(그사이 담당이 바뀌면 쓰지 않는다)
    perform 1 from public.assignments a where a.member_id = p_member and a.trainer_id = v_uid for update;
    if not found then raise exception 'not_allowed'; end if;
    v_author := 'trainer';
  end if;
  select m.updated_at into v_updated from public.exercise_memos m where m.member_id = p_member and m.key = v_key and m.author = v_author for update;
  if v_updated is distinct from p_base then raise exception 'conflict'; end if;
  if v_body = '' then
    delete from public.exercise_memos m where m.member_id = p_member and m.key = v_key and m.author = v_author;
    return null;
  end if;
  insert into public.exercise_memos (member_id, key, author, name, body, written_by, updated_at)
  values (p_member, v_key, v_author, btrim(p_name), v_body, v_uid, v_now)
  on conflict (member_id, key, author) do update set name = excluded.name, body = excluded.body, written_by = excluded.written_by, updated_at = excluded.updated_at;
  return v_now;
end;
$$;
revoke all on function public.save_exercise_memo(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.save_exercise_memo(uuid, text, text, timestamptz) to authenticated;
