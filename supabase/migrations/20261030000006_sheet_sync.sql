-- v2.0 시트 자동 반영(2026-10-30 사용자 결정: "시트 연결해도 읽어오질 않는데? 자동으로 읽어와야 하는 거 아니야?" → 자동으로 바로 반영).
--  - 회원 본인이나 담당 트레이너가 시트를 연결하는 순간, 그리고 운동 탭을 열 때(1시간에 한 번까지) 서버 기능 sheet-import가 시트를 읽고
--    같은 규칙(supabase/functions/_shared/routineSheet.ts)으로 해석해 이 함수로 저장한다. 트레이너의 미리보기·확정 단계는 없앴다.
--  - 내용(탭·필수 동작·운동 줄)이 지난번 읽은 것과 같으면 새 판을 만들지 않는다(last_hash). 시트가 바뀌면 새 판 — 직전 판과 비교가 그대로 보인다.
--    트레이너가 앱에서 직접 고친 판은 시트가 다시 바뀔 때까지 그대로 남는다.
--  - 위험 변화: 예전에는 연결만으로는 회원에게 아무것도 보이지 않았다(20261030000003 설명). 이제 연결하면 그 시트의 루틴이 연결한 회원에게 보인다.
--    남의 시트 링크를 알아낸 사람이 먼저 연결하면 내용을 볼 수 있다 — 링크 유출 가능성은 배제한다는 사용자 판단(2026-10-30) 그대로이고,
--    시트 하나는 회원 한 명에게만 연결되며 겹치는 시도는 운영자 보안 기록에 남는다.
--  - 이 함수는 서버 기능(서비스 키)만 부른다. 부른 사람이 그 회원 본인·담당 트레이너인지는 서버 기능이 routine_sheet_for로 먼저 확인한다.

alter table public.routine_sources add column last_hash text not null default '';

-- 다시 연결하면(시트를 바꾸면) 지난 내용 표식도 지운다 — 같은 내용의 다른 시트라도 한 번은 새로 읽어 반영
create or replace function public.set_routine_sheet(p_member uuid, p_sheet text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_id text; v_owner uuid;
begin
  perform private.lock_account_and_check(v_uid);
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found or (p_member <> v_uid and not private.is_my_member(p_member)) then raise exception 'not_allowed'; end if;
  if btrim(coalesce(p_sheet, '')) = '' then
    delete from public.routine_sources where member_id = p_member;
    return null;
  end if;
  v_id := coalesce(substring(p_sheet from '/spreadsheets/d/([A-Za-z0-9_-]+)'), btrim(p_sheet));
  if v_id !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception 'bad_sheet'; end if;
  select r.member_id into v_owner from public.routine_sources r where r.sheet_id = v_id for update;
  if v_owner is not null and v_owner <> p_member then
    insert into private.security_events (user_id, kind, actor_id) values (p_member, 'sheet_taken', v_uid);
    return jsonb_build_object('status', 'taken', 'sheet_id', v_id);
  end if;
  insert into public.routine_sources (member_id, sheet_id, set_by) values (p_member, v_id, v_uid)
  on conflict (member_id) do update set sheet_id = excluded.sheet_id, set_by = excluded.set_by, set_at = now(), last_read_at = null, last_error = '', last_hash = '';
  return jsonb_build_object('status', 'ok', 'sheet_id', v_id);
end;
$$;

-- 서버 기능이 읽고 해석한 시트 내용을 저장한다. 반환 {status: 'updated'(새 판)|'same'(바뀐 것 없음)|'unlinked'(그사이 연결이 풀리거나 바뀜), version?}
create function public.sheet_sync_save(p_member uuid, p_sheet text, p_tab text, p_title text, p_warmup text, p_items jsonb, p_hash text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_src public.routine_sources; v_id uuid; v_ver int; v_item jsonb; v_ord int := 0; v_trainer uuid;
begin
  -- 같은 회원의 판 번호·동시 읽기(회원과 트레이너가 함께 열었을 때)가 겹치지 않게 회원 행을 잠근다(save_routine과 같은 순서)
  perform 1 from public.profiles p where p.id = p_member and p.role = 'member' for update;
  if not found then raise exception 'not_allowed'; end if;
  select * into v_src from public.routine_sources r where r.member_id = p_member for update;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  if v_src.last_hash = p_hash then
    update public.routine_sources set last_read_at = now(), last_error = '' where member_id = p_member;
    return jsonb_build_object('status', 'same');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 80 then raise exception 'bad_items'; end if;
  select a.trainer_id into v_trainer from public.assignments a where a.member_id = p_member;
  select coalesce(max(r.version), 0) + 1 into v_ver from public.routines r where r.member_id = p_member;
  insert into public.routines (member_id, trainer_id, version, title, source, warmup, source_ref)
  values (p_member, v_trainer, v_ver, left(btrim(coalesce(p_title, '')), 60), 'sheet', left(btrim(coalesce(p_warmup, '')), 1000), left(btrim(coalesce(p_tab, '')), 60))
  returning id into v_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_ord := v_ord + 1;
    insert into public.routine_items (routine_id, ord, day_no, name, weight, reps, sets, rest, note)
    values (v_id, v_ord, coalesce(nullif(v_item ->> 'day_no', '')::int, 1), btrim(coalesce(v_item ->> 'name', '')), btrim(coalesce(v_item ->> 'weight', '')),
            btrim(coalesce(v_item ->> 'reps', '')), nullif(v_item ->> 'sets', '')::int, btrim(coalesce(v_item ->> 'rest', '')), btrim(coalesce(v_item ->> 'note', '')));
  end loop;
  update public.routine_sources set last_hash = p_hash, last_read_at = now(), last_error = '' where member_id = p_member;
  return jsonb_build_object('status', 'updated', 'version', v_ver);
end;
$$;
revoke execute on function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.sheet_sync_save(uuid, text, text, text, text, jsonb, text) to service_role;
