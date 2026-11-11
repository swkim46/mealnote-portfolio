-- 시트 가져오기 작업 번호(2026-11-03 Codex v2.1.0 3차 리뷰 P2 — 늦게 끝난 가져오기가 더 새 가져오기에서 저장한 기록을 지움).
--  write_seq(20261102000004)는 앱의 시트 쓰기와 가져오기가 겹칠 때만 막는다 — 가져오기끼리는 번호가 바뀌지 않아, 옛 시트 내용을 읽은
--  가져오기가 나중에 끝나면 더 새 가져오기가 저장한 회차를 되돌리거나 지웠다(루틴 판도 같은 꼴로 옛 내용의 새 판이 생길 수 있었다).
--  - 시트를 읽는 가져오기(자동 반영·다시 읽기·지난 기록 가져오기의 저장)는 읽기 전에 작업 번호를 받는다(sheet_import_begin: import_seq를 1 늘림).
--    같은 순간의 연결 세대(link_gen)·시트 쓰기 번호(write_seq)도 함께 받는다.
--  - 루틴 판 저장(sheet_sync_save)·탭 기록 저장(sheet_records_save)·사라진 탭 정리(sheet_records_prune)는 그 작업 번호가 지금도 마지막 번호이고
--    연결 세대가 같을 때만 바꾼다. 아니면 'superseded' — 더 새 가져오기가 시작됐거나 연결이 바뀐 것이므로 옛 작업은 아무것도 바꾸지 않고 끝난다.
--    한 작업이 여러 탭을 저장해도 번호는 그대로라 자기 저장 때문에 막히지 않는다.
--  - 연결을 풀었다 다시 이으면 연결 행이 새로 생겨 세대가 바뀐다 — 그 전에 시작한 작업의 번호가 우연히 같아도 세대에서 걸린다.
--  - 마지막 오류 기록(last_error)도 그 작업이 마지막 번호일 때만 남긴다(서버 기능의 조건부 갱신).
alter table public.routine_sources add column import_seq bigint not null default 0;

-- 작업 번호 받기(서버 기능 전용). 잠금 순서는 다른 시트 함수와 같다(계정 → 회원 행 → 시트 연결)
--  반환 {status: 'ok', ticket, gen, seq(지금의 write_seq)} · 연결이 없거나 다른 시트 {status: 'unlinked'}
create function public.sheet_import_begin(p_member uuid, p_sheet text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources;
begin
  insert into private.account_security (user_id) values (p_member) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_member for update;
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for no key update;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  update public.routine_sources r set import_seq = r.import_seq + 1 where r.member_id = p_member returning * into v_src;
  return jsonb_build_object('status', 'ok', 'ticket', v_src.import_seq, 'gen', v_src.link_gen, 'seq', v_src.write_seq);
end;
$$;
revoke execute on function public.sheet_import_begin(uuid, text) from public, anon, authenticated;
grant execute on function public.sheet_import_begin(uuid, text) to service_role;

-- 루틴 판 저장: 작업 번호 확인(p_ticket·p_gen)을 더한다. 번호 없이 부르면(배포 사이의 옛 서버 기능) 예전처럼. 나머지는 20261102000004 그대로
drop function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text, text);
create function public.sheet_sync_save(p_member uuid, p_sheet text, p_tab text, p_title text, p_warmup text, p_items jsonb, p_hash text, p_weight_hash text default null,
                                        p_ticket bigint default null, p_gen uuid default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_cur public.routines; v_id uuid; v_ver int; v_item jsonb; v_ord int := 0; v_trainer uuid; v_same boolean;
begin
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  if p_ticket is not null and (v_src.import_seq <> p_ticket or v_src.link_gen is distinct from p_gen) then return jsonb_build_object('status', 'superseded'); end if;
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
revoke execute on function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text, text, bigint, uuid) to service_role;

-- 탭 기록 저장: 작업 번호 확인을 더하고(반환에 {status: 'superseded'}), 가져온 회차의 시작 시각을 열 순서로 정한다. 나머지는 20261102000004 그대로
drop function public.sheet_records_save(uuid, text, text, jsonb, bigint);
create function public.sheet_records_save(p_member uuid, p_sheet text, p_tab text, p_sessions jsonb, p_seq bigint default null, p_ticket bigint default null, p_gen uuid default null)
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
  if p_ticket is not null and (v_src.import_seq <> p_ticket or v_src.link_gen is distinct from p_gen) then return jsonb_build_object('status', 'superseded'); end if;
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
    -- 시작 시각: 시트에는 시각이 없어 그 날 0시(한국)에 열 순서만큼 분을 더한다 — 같은 날 회차의 앞뒤(최고 기록·지난번 비교, 목록 순서)가
    -- 가져온 순간(now)·무작위 id가 아니라 시트의 열 순서로 늘 같게(적대 검토 11-03)
    if v_id is null then
      insert into public.workout_sessions (id, member_id, routine_id, day_no, day, started_at, finished, updated_at, source, sheet_tab, sheet_col)
      values (gen_random_uuid(), p_member, v_routine, v_dayno, v_day, (v_day::timestamp + make_interval(mins => v_col)) at time zone 'Asia/Seoul', true, now(), 'sheet', v_tab, v_col)
      returning id into v_id;
    else
      update public.workout_sessions set routine_id = v_routine, day = v_day, started_at = (v_day::timestamp + make_interval(mins => v_col)) at time zone 'Asia/Seoul', finished = true, updated_at = now() where id = v_id;
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
revoke execute on function public.sheet_records_save(uuid, text, text, jsonb, bigint, bigint, uuid) from public, anon, authenticated;
grant execute on function public.sheet_records_save(uuid, text, text, jsonb, bigint, bigint, uuid) to service_role;

-- 사라진 탭 정리: 작업 번호 확인을 더하고, 지운 수와 함께 상태를 돌려준다
--  반환 {status: 'pruned', removed} · {status: 'superseded'} · {status: 'unlinked'}
drop function public.sheet_records_prune(uuid, text, text[]);
create function public.sheet_records_prune(p_member uuid, p_sheet text, p_tabs text[], p_ticket bigint default null, p_gen uuid default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_n int;
begin
  insert into private.account_security (user_id) values (p_member) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = p_member for update;
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for no key update;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet or p_tabs is null then return jsonb_build_object('status', 'unlinked'); end if;
  if p_ticket is not null and (v_src.import_seq <> p_ticket or v_src.link_gen is distinct from p_gen) then return jsonb_build_object('status', 'superseded'); end if;
  delete from public.workout_sessions w where w.member_id = p_member and w.source = 'sheet' and not (w.sheet_tab = any (p_tabs));
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', 'pruned', 'removed', v_n);
end;
$$;
revoke execute on function public.sheet_records_prune(uuid, text, text[], bigint, uuid) from public, anon, authenticated;
grant execute on function public.sheet_records_prune(uuid, text, text[], bigint, uuid) to service_role;
