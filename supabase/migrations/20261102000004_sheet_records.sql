-- v2.1 시트의 회차 기록(2026-11-02 사용자 피드백 "이전까지의 운동 기록 불러오기" · "앱에서 기록하면 시트로 기록이 넘어가게").
--  - 시트의 중량 칸은 회차마다 한 칸이고, 블록 끝 '운동한 날' 줄에 그 회차 날짜가 있다(규칙: supabase/functions/_shared/routineSheet.ts).
--    서버 기능 sheet-import가 탭을 읽어 sheet_records_save로 '시트에서 가져온 기록'(source='sheet')을 만든다.
--    가져온 기록은 (회원, 탭, 루틴 번호, 열)마다 하나(고유 색인)이고 id는 무작위다 — id를 계산할 수 있으면 다른 회원이 그 id로
--    자기 기록을 먼저 만들어 남의 시트 기록을 받아 갈 수 있었다(2026-11-02 적대 검토 P1). 시트에서 지운 회차는 다음 가져오기 때 지운다.
--    지난 기록 가져오기는 시트에 더는 없는 탭의 기록도 지운다(sheet_records_prune). 시트 연결을 풀거나 다른 시트로 바꾸면 가져온 기록과 쓴 칸 표시를 지운다.
--    세트 수는 그 달 계획의 세트 수로 보고 각 세트에 칸 글자를 그대로 넣는다(시트에는 회차당 한 칸뿐이라 세트별 값을 모른다).
--    가져온 기록은 앱에서 고치거나 지우지 않는다(sheet_record) — 시트에서 고치면 다음 가져오기 때 반영된다.
--  - 서버 기능 sheet-write가 앱 기록을 그 달 탭의 빈 회차 칸에 써 넣고, 어느 칸에 무엇을 썼는지 sheet_record_links에 남긴다.
--    가져오기는 앱이 쓴 열(같은 날짜 그대로인 것)과, 같은 날·같은 루틴의 앱 기록(완료 세트나 유산소가 있는 것)이 있는 회차를 건너뛴다 — 기록이 두 번 들어가지 않게.
--    표시는 앱 기록을 지워도 남긴다(운동 기록에 묶지 않음): 앱에서 지운 기록이 시트 가져오기로 되살아나지 않게. 앱 기록 하나에 표시 하나(옮겨 쓰면 옛 표시를 지운다).
--  - 시트 쓰기의 세 가지 상태(2026-11-03 Codex 2차 리뷰 — 한 행이 예약·소유·쓰는 중을 함께 맡아 서로 지웠다):
--    ① 쓰기 차례: 회원마다 한 번에 한 작업만 시트에 쓴다(private.sheet_write_turns, sheet_write_begin/end). 같은 기록의 두 번째 요청이
--       첫 요청이 쓰는 중인 열의 표시를 지우던 것(P1)을 막는다 — 차례를 가진 작업만 표시를 만들고 고치고 지운다(private.sheet_write_hold).
--       차례는 시트 연결과 따로 둔다: 연결을 풀었다가 같은 시트로 다시 이어도 결과를 모르는 쓰기의 차례(아래 ③)가 끊기지 않게(적대 검토 F15).
--    ② 앱이 쓴 칸(cells): 쓰기가 끝났다고 확인한 칸과 값 — 운동 이름(같은 이름이 또 있으면 '이름#2') → 값, '@date' → 날짜(YYYY-MM-DD).
--       줄 번호가 아니라 이름으로 기억한다(트레이너가 줄을 끼워 넣어도 다른 운동 칸을 앱 칸으로 보지 않게). 이 값이 시트에 그대로 있을 때만 앱이 고치거나 비운다.
--    ③ 쓰는 중(pending): 시트에 보내기 전에 적어 둔 '이번에 쓸 값'. 응답이 끊겨 결과를 모르면 남고, 다음 쓰기가 칸 값과 맞춰 본다 —
--       시트에 그 값이 있으면 앱이 쓴 칸으로 되찾는다(P2: 쓰기는 됐는데 응답만 잃으면 다음 수정·완료 해제를 못 하던 것).
--       결과를 모르면 서버 기능이 쓰기 차례를 60초 더 쥔다 — 끊긴 요청을 구글이 늦게 반영하는 동안 다른 쓰기가 그 열을 받지 않게.
--    차례와 표시는 시트 연결의 세대(routine_sources.link_gen, 다른 시트로 바꾸거나 다시 이을 때마다 새로)에 묶인다. 연결이 바뀌면 그 전 세대의
--    작업은 차례를 잃어, 옛 시트를 읽던 요청이 늦게 끝나도 새 시트에 표시를 남기지 못한다(P1).
--    시트 쓰기가 표시를 바꿀 때마다 routine_sources.write_seq가 늘어난다 — 가져오기는 시트를 읽기 전의 번호를 sheet_records_save에 넘기고,
--    그사이 번호가 바뀌었으면 저장하지 않고 다시 읽는다(앱이 방금 비운 칸을 옛 내용으로 가져오던 것, 적대 검토 F11).
--  - 잠금 순서: 계정(account_security) → 회원 행(profiles) → 시트 연결(routine_sources). save_workout·sheet_sync_save·set_routine_sheet와 같은 차례라 서로 기다리기만 한다.
--  - 루틴 판: 운동 구성(이름·세트·횟수·쉬는 시간·필수 동작)이 바뀔 때만 새 판. 시트의 첫 회차 중량 칸만 바뀌면(앱이 기록을 써 넣은 것 포함)
--    지금 판의 목표 중량만 고친다 — 기록을 써 넣을 때마다 새 판과 긴 변경 목록이 생기지 않게.

alter table public.workout_sessions
  add column source text not null default 'app' check (source in ('app', 'sheet')),
  add column sheet_tab text not null default '' check (char_length(sheet_tab) <= 60),
  add column sheet_col int check (sheet_col is null or sheet_col between 0 and 200);
alter table public.routine_sources
  add column last_weight_hash text not null default '',
  add column link_gen uuid not null default gen_random_uuid(),
  add column write_seq bigint not null default 0;
create table private.sheet_write_turns (
  member_id   uuid primary key references public.profiles(id) on delete cascade,
  job         uuid not null,
  gen         uuid not null,
  until       timestamptz not null
);
revoke all on private.sheet_write_turns from public, anon, authenticated;
create unique index workout_sessions_sheet_key on public.workout_sessions (member_id, sheet_tab, day_no, sheet_col) where source = 'sheet';

create table public.sheet_record_links (
  member_id   uuid not null references public.profiles(id) on delete cascade,
  gen         uuid not null,
  tab         text not null check (char_length(tab) between 1 and 60),
  day_no      int not null check (day_no between 1 and 10),
  col         int not null check (col between 0 and 200),
  day         date not null,
  session_id  uuid,
  cells       jsonb not null default '{}'::jsonb check (jsonb_typeof(cells) = 'object'),
  pending     jsonb check (pending is null or jsonb_typeof(pending) = 'object'),
  written_at  timestamptz not null default now(),
  primary key (member_id, tab, day_no, col)
);
create unique index sheet_record_links_session_idx on public.sheet_record_links (session_id) where session_id is not null;
alter table public.sheet_record_links enable row level security;
revoke all on public.sheet_record_links from anon, authenticated;

-- 운동 기록 저장: 시트에서 가져온 기록은 고치지 않는다. 나머지는 20261102000003 그대로
create or replace function public.save_workout(p_session uuid, p_day date, p_routine uuid, p_sets jsonb, p_finished boolean, p_day_no int default null, p_base timestamptz default null, p_save_id uuid default null, p_cardio jsonb default null)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_owner uuid; v_updated timestamptz; v_last uuid; v_source text; v_s jsonb; v_ord int := 0; v_now timestamptz := clock_timestamp();
  v_kind text; v_min numeric; v_km numeric; v_speed numeric;
begin
  perform private.lock_account_and_check(v_uid);
  if p_session is null then raise exception 'bad_request'; end if;
  if p_day_no is not null and p_day_no not between 1 and 10 then raise exception 'bad_day_no'; end if;
  if p_sets is null or jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) > 200 then raise exception 'bad_sets'; end if;
  if p_cardio is not null and (jsonb_typeof(p_cardio) <> 'array' or jsonb_array_length(p_cardio) > 20) then raise exception 'bad_cardio'; end if;
  if p_routine is not null and not exists (select 1 from public.routines r where r.id = p_routine and r.member_id = v_uid) then raise exception 'not_allowed'; end if;
  select s.member_id, s.updated_at, s.last_save_id, s.source into v_owner, v_updated, v_last, v_source from public.workout_sessions s where s.id = p_session for update;
  if v_owner is not null and v_owner <> v_uid then raise exception 'not_allowed'; end if;
  if v_source = 'sheet' then raise exception 'sheet_record'; end if; -- 시트에서 가져온 기록은 시트에서 고친다
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
  -- 유산소: 보낸 목록으로 통째로 바꾼다. null이면(2.0.x 앱) 있던 유산소를 그대로 둔다
  if p_cardio is not null then
    delete from public.workout_cardio where session_id = p_session;
    v_ord := 0;
    for v_s in select * from jsonb_array_elements(p_cardio) loop
      v_ord := v_ord + 1;
      v_kind := v_s ->> 'kind';
      v_min := nullif(v_s ->> 'minutes', '')::numeric;
      v_km := nullif(v_s ->> 'km', '')::numeric;
      v_speed := nullif(v_s ->> 'speed', '')::numeric;
      if v_kind is null or v_kind not in ('run', 'walk', 'cycle', 'row', 'stair', 'elliptical', 'swim', 'rope', 'other')
         or v_min is null or v_min not between 1 and 600 or (v_km is not null and v_km not between 0.01 and 200)
         or (v_speed is not null and v_speed not between 0.1 and 80) then
        raise exception 'bad_cardio';
      end if;
      insert into public.workout_cardio (session_id, ord, kind, minutes, km, speed)
      values (p_session, v_ord, v_kind, round(v_min, 1), round(v_km, 2), round(v_speed, 1));
    end loop;
  end if;
  return v_now;
end;
$$;

create or replace function public.delete_workout(p_session uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  perform private.lock_account_and_check(v_uid);
  if exists (select 1 from public.workout_sessions s where s.id = p_session and s.member_id = v_uid and s.source = 'sheet') then raise exception 'sheet_record'; end if;
  delete from public.workout_sessions s where s.id = p_session and s.member_id = v_uid;
  if not found then raise exception 'not_allowed'; end if;
end;
$$;

-- 시트 자동 반영 저장: 구성이 같으면 새 판을 만들지 않는다.
--  구성이 같다 = 지난번에 읽은 구성 해시와 같거나, 지금 판이 같은 탭의 시트 판이고 필수 동작·운동 줄(루틴 번호·이름·세트·횟수·쉬는 시간)이 같은 것
--  (2.0은 해시에 중량까지 넣었다 — 배포 뒤 처음 읽을 때 같은 내용으로 새 판이 생기지 않게 내용으로도 비교한다).
--  구성이 같고 중량이 바뀌었으면 지금 판(시트 판일 때만 — 트레이너가 앱에서 고친 판은 그대로)의 목표 중량을 순서대로 고친다.
--  p_weight_hash가 없는 호출(배포 사이의 옛 서버 기능)은 예전처럼 해시만 본다.
drop function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text);
create function public.sheet_sync_save(p_member uuid, p_sheet text, p_tab text, p_title text, p_warmup text, p_items jsonb, p_hash text, p_weight_hash text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_cur public.routines; v_id uuid; v_ver int; v_item jsonb; v_ord int := 0; v_trainer uuid; v_same boolean;
begin
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 80 then raise exception 'bad_items'; end if;
  select * into v_cur from public.routines r where r.member_id = p_member order by r.version desc limit 1;
  v_same := v_src.last_hash = p_hash;
  if not v_same and p_weight_hash is not null and v_cur.source = 'sheet' and v_cur.source_ref = left(btrim(coalesce(p_tab, '')), 60)
     and v_cur.warmup = left(btrim(coalesce(p_warmup, '')), 1000) then
    v_same := (select coalesce(jsonb_agg(jsonb_build_array(i.day_no, i.name, i.sets, i.reps, i.rest) order by i.ord), '[]'::jsonb) from public.routine_items i where i.routine_id = v_cur.id)
            = (select coalesce(jsonb_agg(jsonb_build_array(coalesce(nullif(e ->> 'day_no', '')::int, 1), btrim(coalesce(e ->> 'name', '')), nullif(e ->> 'sets', '')::int,
                                                            btrim(coalesce(e ->> 'reps', '')), btrim(coalesce(e ->> 'rest', ''))) order by n), '[]'::jsonb)
                 from jsonb_array_elements(p_items) with ordinality t(e, n));
  end if;
  if v_same then
    if p_weight_hash is not null and v_src.last_weight_hash is distinct from p_weight_hash and v_cur.source = 'sheet' and v_cur.source_ref = left(btrim(coalesce(p_tab, '')), 60) then
      update public.routine_items i set weight = btrim(coalesce(t.e ->> 'weight', ''))
        from jsonb_array_elements(p_items) with ordinality t(e, n)
       where i.routine_id = v_cur.id and i.ord = t.n and i.weight is distinct from btrim(coalesce(t.e ->> 'weight', ''));
    end if;
    update public.routine_sources set last_hash = p_hash, last_weight_hash = coalesce(p_weight_hash, ''), last_read_at = now(), last_error = '' where member_id = p_member;
    return jsonb_build_object('status', 'same');
  end if;
  select a.trainer_id into v_trainer from public.assignments a where a.member_id = p_member;
  v_ver := coalesce(v_cur.version, 0) + 1;
  insert into public.routines (member_id, trainer_id, version, title, source, warmup, source_ref)
  values (p_member, v_trainer, v_ver, left(btrim(coalesce(p_title, '')), 60), 'sheet', left(btrim(coalesce(p_warmup, '')), 1000), left(btrim(coalesce(p_tab, '')), 60))
  returning id into v_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_ord := v_ord + 1;
    insert into public.routine_items (routine_id, ord, day_no, name, weight, reps, sets, rest, note)
    values (v_id, v_ord, coalesce(nullif(v_item ->> 'day_no', '')::int, 1), btrim(coalesce(v_item ->> 'name', '')), btrim(coalesce(v_item ->> 'weight', '')),
            btrim(coalesce(v_item ->> 'reps', '')), nullif(v_item ->> 'sets', '')::int, btrim(coalesce(v_item ->> 'rest', '')), btrim(coalesce(v_item ->> 'note', '')));
  end loop;
  update public.routine_sources set last_hash = p_hash, last_weight_hash = coalesce(p_weight_hash, ''), last_read_at = now(), last_error = '' where member_id = p_member;
  return jsonb_build_object('status', 'updated', 'version', v_ver);
end;
$$;
revoke execute on function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text, text) to service_role;

-- 시트 쓰기 차례(서버 기능 sheet-write 전용, 2026-11-03 Codex 2차 리뷰 P1). 회원마다 한 작업만 시트에 쓴다 — 같은 기록의 다른 요청이
--  쓰는 중인 열의 표시를 지우거나, 연결이 바뀐 뒤 옛 시트를 읽던 요청이 표시를 남기지 못하게.
--  차례는 60초 동안 유효하고, 차례를 가진 작업이 DB를 부를 때마다(private.sheet_write_hold) 늘어난다. 서버 기능이 멈추면 60초 뒤 다른 작업이 넘겨받는다.
--  구글 요청 하나는 15초 안에 끝나거나 끊긴다(_shared/googleSheets.ts). 끊긴 요청은 구글이 늦게 반영할 수 있어, 결과를 모르면 서버 기능이
--  차례를 바로 돌려주지 않고 60초 더 쥔다(sheet_write_renew).
--  반환 {status: 'ok', gen(지금 연결의 세대)} · 다른 작업이 쓰는 중 {status: 'busy'} · 연결이 없거나 다른 시트 {status: 'unlinked'}
create function public.sheet_write_begin(p_member uuid, p_sheet text, p_job uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_turn private.sheet_write_turns;
begin
  if p_member is null or p_job is null then raise exception 'bad_request'; end if;
  insert into private.account_security (user_id) values (p_member) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_member for update;
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for no key update;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  -- 다른 작업의 차례가 아직 살아 있으면(그 작업이 다른 연결 세대여도 — 결과를 모르는 쓰기가 늦게 반영될 수 있다) 기다리게 한다
  select * into v_turn from private.sheet_write_turns t where t.member_id = p_member for update;
  if v_turn.member_id is not null and v_turn.job <> p_job and v_turn.until > now() then return jsonb_build_object('status', 'busy'); end if;
  insert into private.sheet_write_turns (member_id, job, gen, until) values (p_member, p_job, v_src.link_gen, now() + interval '60 seconds')
  on conflict (member_id) do update set job = excluded.job, gen = excluded.gen, until = excluded.until;
  return jsonb_build_object('status', 'ok', 'gen', v_src.link_gen);
end;
$$;
revoke execute on function public.sheet_write_begin(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.sheet_write_begin(uuid, text, uuid) to service_role;

-- 차례 확인: 이 작업이 지금도 그 회원의 쓰기 차례를 가졌고 그 차례의 연결 세대가 지금 연결이면 차례를 늘리고 세대를 돌려준다.
--  아니면 null(연결이 풀렸거나 바뀌었거나 다른 작업이 넘겨받음). 부를 때마다 write_seq를 늘린다(가져오기가 그사이 읽은 칸을 저장하지 않게)
create function private.sheet_write_hold(p_member uuid, p_job uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_gen uuid;
begin
  insert into private.account_security (user_id) values (p_member) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_member for update;
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for no key update;
  select r.link_gen into v_gen from public.routine_sources r where r.member_id = p_member for update;
  if v_gen is null then return null; end if;
  update private.sheet_write_turns t set until = now() + interval '60 seconds' where t.member_id = p_member and t.job = p_job and t.gen = v_gen;
  if not found then return null; end if;
  update public.routine_sources set write_seq = write_seq + 1 where member_id = p_member;
  return v_gen;
end;
$$;
revoke execute on function private.sheet_write_hold(uuid, uuid) from public, anon, authenticated;

-- 차례 늘리기: 시트에 다음 쓰기를 보내기 전에 부른다. 차례를 잃었으면(연결이 바뀜 등) false — 옛 시트에 쓰기를 더 보내지 않는다
create function public.sheet_write_renew(p_member uuid, p_job uuid)
returns boolean language sql security definer set search_path = ''
as $$
  select private.sheet_write_hold(p_member, p_job) is not null;
$$;
revoke execute on function public.sheet_write_renew(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sheet_write_renew(uuid, uuid) to service_role;

-- 쓰기 차례 돌려주기: 이 작업의 차례일 때만
create function public.sheet_write_end(p_member uuid, p_job uuid)
returns void language sql security definer set search_path = ''
as $$
  delete from private.sheet_write_turns t where t.member_id = p_member and t.job = p_job;
$$;
revoke execute on function public.sheet_write_end(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sheet_write_end(uuid, uuid) to service_role;

-- 시트에 보내기 직전: 그 칸(회원·탭·루틴 번호·열)을 이 기록의 것으로 하고, 지금 앱이 쓴 칸(p_cells)과 이번에 쓸 값(p_pending)을 적는다.
--  다른 기록의 표시가 있는 칸이면 'taken'(서버 기능은 다음 후보 열로). 다만 그 열이 시트에서 모두 빈 칸이었으면(p_empty) 그 표시는 시트에
--  남긴 것이 없으므로 넘겨받는다 — 결과를 모른 채 끝난 쓰기가 빈 열을 계속 막지 않게. 차례를 잃었으면 'lost'(아무것도 바꾸지 않음).
--  넘겨받는 남의 표시에 쓰는 중 값(pending)이 있어도 된다: 결과를 모르는 쓰기는 차례를 60초 더 쥐므로, 차례를 받은 지금 그 열이 비어 있으면 그 쓰기는 반영되지 않은 것이다.
--  이 기록의 다른 칸 표시(옛 열)는 지운다 — 기록 하나에 표시 하나. 다른 연결 세대의 표시가 남아 있으면 함께 지운다.
create function public.sheet_link_claim(p_member uuid, p_job uuid, p_tab text, p_day_no int, p_col int, p_day date, p_session uuid, p_empty boolean, p_cells jsonb, p_pending jsonb)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_gen uuid; v_owner uuid; v_cells jsonb; v_pending jsonb; v_found boolean;
begin
  if p_member is null or p_session is null or p_day is null or p_day_no not between 1 and 10 or p_col not between 0 and 200
     or jsonb_typeof(p_cells) is distinct from 'object' or (p_pending is not null and jsonb_typeof(p_pending) <> 'object') then
    raise exception 'bad_request';
  end if;
  v_gen := private.sheet_write_hold(p_member, p_job);
  if v_gen is null then return 'lost'; end if;
  delete from public.sheet_record_links l where l.member_id = p_member and l.gen <> v_gen;
  select l.session_id, l.cells, l.pending, true into v_owner, v_cells, v_pending, v_found from public.sheet_record_links l
   where l.member_id = p_member and l.tab = p_tab and l.day_no = p_day_no and l.col = p_col for update;
  if v_found and v_owner is distinct from p_session then
    if not (p_empty or (v_cells = '{}'::jsonb and v_pending is null)) then return 'taken'; end if;
    delete from public.sheet_record_links l where l.member_id = p_member and l.tab = p_tab and l.day_no = p_day_no and l.col = p_col;
  end if;
  delete from public.sheet_record_links l
   where l.session_id = p_session and not (l.member_id = p_member and l.tab = p_tab and l.day_no = p_day_no and l.col = p_col);
  insert into public.sheet_record_links (member_id, gen, tab, day_no, col, day, session_id, cells, pending, written_at)
  values (p_member, v_gen, p_tab, p_day_no, p_col, p_day, p_session, p_cells, p_pending, now())
  on conflict (member_id, tab, day_no, col) do update set gen = excluded.gen, day = excluded.day, session_id = excluded.session_id,
    cells = excluded.cells, pending = excluded.pending, written_at = excluded.written_at;
  -- 기록에도 쓰는 자리를 적는다 — 결과를 모른 채 끝나도 앱이 '시트에 쓴 기록'으로 알고 완료 해제를 시트에 보내게(적대 검토 F5)
  update public.workout_sessions w set sheet_tab = p_tab, sheet_col = p_col where w.id = p_session and w.member_id = p_member and w.source = 'app';
  return 'ok';
end;
$$;
revoke execute on function public.sheet_link_claim(uuid, uuid, text, int, int, date, uuid, boolean, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sheet_link_claim(uuid, uuid, text, int, int, date, uuid, boolean, jsonb, jsonb) to service_role;

-- 시트에 보낸 결과를 확정한다: 앱이 쓴 칸을 p_cells로, 쓰는 중 표시는 지운다. p_cells가 비면(앱이 쓴 칸이 남지 않음) 표시를 지운다.
--  기록의 sheet_tab·sheet_col(앱이 그 기록을 시트에 썼는지)도 같이 고친다. 차례를 잃었거나 표시가 없으면 'lost' — 바뀐 행이 0개인 확정을 성공으로 보지 않는다.
create function public.sheet_link_confirm(p_member uuid, p_job uuid, p_tab text, p_day_no int, p_col int, p_session uuid, p_cells jsonb)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_gen uuid;
begin
  if p_member is null or p_session is null or jsonb_typeof(p_cells) is distinct from 'object' then raise exception 'bad_request'; end if;
  v_gen := private.sheet_write_hold(p_member, p_job);
  if v_gen is null then return 'lost'; end if;
  if p_cells = '{}'::jsonb then
    delete from public.sheet_record_links l
     where l.member_id = p_member and l.gen = v_gen and l.tab = p_tab and l.day_no = p_day_no and l.col = p_col and l.session_id = p_session;
  else
    update public.sheet_record_links l set cells = p_cells, pending = null, written_at = now()
     where l.member_id = p_member and l.gen = v_gen and l.tab = p_tab and l.day_no = p_day_no and l.col = p_col and l.session_id = p_session;
  end if;
  if not found then return 'lost'; end if;
  update public.workout_sessions w set sheet_tab = case when p_cells = '{}'::jsonb then '' else p_tab end, sheet_col = case when p_cells = '{}'::jsonb then null else p_col end
   where w.id = p_session and w.member_id = p_member and w.source = 'app';
  return 'ok';
end;
$$;
revoke execute on function public.sheet_link_confirm(uuid, uuid, text, int, int, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sheet_link_confirm(uuid, uuid, text, int, int, uuid, jsonb) to service_role;

-- 시트에서 읽은 탭 하나의 회차 기록을 '시트에서 가져온 기록'으로 저장한다(서버 기능 전용).
--  p_sessions = [{day_no, col, date, items: [{name, sets, reps, weight}]}] — 이 탭의 회차 전부(없어진 회차는 지운다).
--  p_seq = 시트를 읽기 전의 routine_sources.write_seq. 그사이 앱이 시트에 썼으면(번호가 바뀜) 저장하지 않는다 — 읽은 칸이 옛 내용일 수 있어서(적대 검토 F11).
--  반환 {status: 'saved', saved, skipped, removed(이번에 지운 가져온 기록 수)} · 그사이 연결이 풀리거나 바뀌었으면 {status: 'unlinked'} · 그사이 앱이 썼으면 {status: 'stale'}
create function public.sheet_records_save(p_member uuid, p_sheet text, p_tab text, p_sessions jsonb, p_seq bigint default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_tab text := left(btrim(coalesce(p_tab, '')), 60); v_s jsonb; v_i jsonb; v_id uuid; v_ids uuid[] := array[]::uuid[];
  v_day date; v_dayno int; v_col int; v_routine uuid; v_ord int; v_n int; v_saved int := 0; v_skipped int := 0; v_removed int;
begin
  -- 잠금 순서(머리 설명): 계정 → 회원 행 → 시트 연결. 앱 저장(save_workout)과 가져오기가 겹쳐도 차례대로
  insert into private.account_security (user_id) values (p_member) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_member for update;
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for no key update;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  if p_seq is not null and v_src.write_seq <> p_seq then return jsonb_build_object('status', 'stale'); end if;
  if v_tab = '' or p_sessions is null or jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) > 200 then raise exception 'bad_records'; end if;
  select r.id into v_routine from public.routines r where r.member_id = p_member and r.source = 'sheet' and r.source_ref = v_tab order by r.version desc limit 1;
  for v_s in select * from jsonb_array_elements(p_sessions) loop
    v_day := (v_s ->> 'date')::date;
    v_dayno := (v_s ->> 'day_no')::int;
    v_col := (v_s ->> 'col')::int;
    if v_day is null or v_dayno not between 1 and 10 or v_col not between 0 and 200 or jsonb_typeof(v_s -> 'items') <> 'array' then raise exception 'bad_records'; end if;
    -- 앱이 쓴 열(날짜 그대로)과, 같은 날·같은 루틴의 앱 기록(완료 세트나 유산소가 있는 것)이 있는 회차는 앱 기록이 원본이다
    if exists (select 1 from public.sheet_record_links l where l.member_id = p_member and l.gen = v_src.link_gen and l.tab = v_tab and l.day_no = v_dayno and l.col = v_col and l.day = v_day)
       or exists (select 1 from public.workout_sessions w where w.member_id = p_member and w.source = 'app' and w.day = v_day and w.day_no = v_dayno and private.is_workout_session(w.id)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    -- 이 회원의 이 탭·루틴·열 기록(고유 색인 workout_sessions_sheet_key)을 찾고, 없으면 무작위 id로 새로
    select w.id into v_id from public.workout_sessions w
     where w.member_id = p_member and w.source = 'sheet' and w.sheet_tab = v_tab and w.day_no = v_dayno and w.sheet_col = v_col for update;
    if v_id is null then
      insert into public.workout_sessions (id, member_id, routine_id, day_no, day, finished, updated_at, source, sheet_tab, sheet_col)
      values (gen_random_uuid(), p_member, v_routine, v_dayno, v_day, true, now(), 'sheet', v_tab, v_col)
      returning id into v_id;
    else
      update public.workout_sessions set routine_id = v_routine, day = v_day, finished = true, updated_at = now() where id = v_id;
      delete from public.workout_sets where session_id = v_id;
    end if;
    v_ids := v_ids || v_id;
    v_ord := 0;
    for v_i in select * from jsonb_array_elements(v_s -> 'items') loop
      v_n := least(greatest(coalesce(nullif(v_i ->> 'sets', '')::int, 1), 1), 20);
      for k in 1..v_n loop
        v_ord := v_ord + 1;
        exit when v_ord > 200;
        insert into public.workout_sets (session_id, name, set_no, kg, reps, done, ord)
        values (v_id, left(btrim(coalesce(v_i ->> 'name', '')), 60), k, nullif(left(btrim(coalesce(v_i ->> 'weight', '')), 30), ''), nullif(left(btrim(coalesce(v_i ->> 'reps', '')), 30), ''), true, v_ord);
      end loop;
    end loop;
    v_id := null;
    v_saved := v_saved + 1;
  end loop;
  delete from public.workout_sessions w where w.member_id = p_member and w.source = 'sheet' and w.sheet_tab = v_tab and not (w.id = any (v_ids));
  get diagnostics v_removed = row_count;
  return jsonb_build_object('status', 'saved', 'saved', v_saved, 'skipped', v_skipped, 'removed', v_removed);
end;
$$;
revoke execute on function public.sheet_records_save(uuid, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.sheet_records_save(uuid, text, text, jsonb, bigint) to service_role;

-- 지난 기록 가져오기 뒤: 이번에 읽은 탭(p_tabs) 말고 다른 탭에서 가져온 기록을 지운다 — 시트에서 지운 탭·같은 달의 사본 탭(서버 기능 전용).
--  p_tabs가 빈 목록이면(시트에 월별 탭이 하나도 없음) 가져온 기록을 모두 지운다. 지운 수를 돌려준다
create function public.sheet_records_prune(p_member uuid, p_sheet text, p_tabs text[])
returns int language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_n int;
begin
  insert into private.account_security (user_id) values (p_member) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_member for update;
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for no key update;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet or p_tabs is null then return 0; end if;
  delete from public.workout_sessions w where w.member_id = p_member and w.source = 'sheet' and not (w.sheet_tab = any (p_tabs));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.sheet_records_prune(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.sheet_records_prune(uuid, text, text[]) to service_role;

-- 시트 연결: 연결을 풀거나 다른 시트로 바꾸면 그 시트에서 가져온 기록과 쓴 칸 표시를 지운다 — 가져온 기록은 앱에서 지울 수 없어서(같은 시트를 다시 연결하면 다시 가져온다).
-- 다른 시트로 바꾸면 연결 세대(link_gen)를 새로 한다 — 그 전 세대의 쓰기 작업은 차례를 잃어, 옛 시트를 읽던 쓰기가 늦게 끝나도 새 시트에 표시를 남기지 못한다
-- (Codex v2.1 2차 리뷰 P1). 연결을 풀면 연결 행이 지워져 다시 이을 때 새 세대가 된다. 같은 시트를 다시 연결하면 세대·표시를 그대로 둔다.
-- 쓰기 차례(private.sheet_write_turns)는 건드리지 않는다 — 결과를 모르는 쓰기가 쥔 차례는 연결을 바꾸거나 다시 이어도 끝날 때까지 남는다(적대 검토 F15).
-- 나머지는 20261030000006 그대로
create or replace function public.set_routine_sheet(p_member uuid, p_sheet text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_id text; v_owner uuid; v_prev text;
begin
  perform private.lock_account_and_check(v_uid);
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found or (p_member <> v_uid and not private.is_my_member(p_member)) then raise exception 'not_allowed'; end if;
  select r.sheet_id into v_prev from public.routine_sources r where r.member_id = p_member for update;
  if btrim(coalesce(p_sheet, '')) = '' then
    delete from public.routine_sources where member_id = p_member;
    delete from public.workout_sessions w where w.member_id = p_member and w.source = 'sheet';
    delete from public.sheet_record_links l where l.member_id = p_member;
    return null;
  end if;
  v_id := coalesce(substring(p_sheet from '/spreadsheets/d/([A-Za-z0-9_-]+)'), btrim(p_sheet));
  if v_id !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception 'bad_sheet'; end if;
  select r.member_id into v_owner from public.routine_sources r where r.sheet_id = v_id for update;
  if v_owner is not null and v_owner <> p_member then
    insert into private.security_events (user_id, kind, actor_id) values (p_member, 'sheet_taken', v_uid);
    return jsonb_build_object('status', 'taken', 'sheet_id', v_id);
  end if;
  if v_prev is not null and v_prev <> v_id then
    delete from public.workout_sessions w where w.member_id = p_member and w.source = 'sheet';
    delete from public.sheet_record_links l where l.member_id = p_member;
  end if;
  insert into public.routine_sources as r (member_id, sheet_id, set_by) values (p_member, v_id, v_uid)
  on conflict (member_id) do update set sheet_id = excluded.sheet_id, set_by = excluded.set_by, set_at = now(), last_read_at = null, last_error = '', last_hash = '', last_weight_hash = '',
    link_gen = case when r.sheet_id = excluded.sheet_id then r.link_gen else gen_random_uuid() end;
  return jsonb_build_object('status', 'ok', 'sheet_id', v_id);
end;
$$;
