-- 지난 기록 가져오기 미리보기를 서버에서 센다(2026-11-03 Codex v2.1.0 4차 리뷰 P2 — 미리보기에서 예고한 것보다 더 많은 기록을 지움).
--  미리보기는 서버 기능이 쓴 칸 표시·앱 기록·가져온 기록을 한 번씩 조회해 셌는데, API의 행 상한(1,000개) 밖의 기록은 삭제·겹침 판정에서 빠졌다.
--  실제 저장(sheet_records_save)·정리(sheet_records_prune)에는 상한이 없어 예고(1,000)보다 많이(1,001) 지웠다.
--  같은 판정 규칙을 SQL 한 곳에서 전체 대상에 적용한다(서버 기능 전용, 읽기만):
--   - 건너뜀: 앱이 쓴 칸 표시(지금 연결 세대, 같은 탭·루틴 번호·열·날짜)가 있거나, 같은 날·같은 루틴 번호의 앱 운동 기록(완료 세트나 유산소)이 있는 회차
--   - 지움: 읽은 탭의 가져온 기록 가운데 이번에 건너뛰지 않고 다시 나오는 회차가 아닌 것 + 시트에 없는 탭(p_month_tabs 밖)의 가져온 기록
--  p_read = [{tab, sessions: [{day_no, col, date}]}] — 서버 기능이 이번에 읽은 탭과 회차.
--  반환 {status: 'preview', removes, tabs: [{tab, sessions(가져올 수), skipped}]} · 연결이 없거나 다른 시트 {status: 'unlinked'}
create function public.sheet_records_preview(p_member uuid, p_sheet text, p_read jsonb, p_month_tabs text[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_src public.routine_sources; v jsonb;
begin
  select * into v_src from public.routine_sources r where r.member_id = p_member;
  if v_src.member_id is null or v_src.sheet_id <> p_sheet then return jsonb_build_object('status', 'unlinked'); end if;
  if p_read is null or jsonb_typeof(p_read) <> 'array' or p_month_tabs is null then raise exception 'bad_preview'; end if;
  with r as (
    select left(btrim(t ->> 'tab'), 60) tab, (s ->> 'day_no')::int day_no, (s ->> 'col')::int col, (s ->> 'date')::date dt, ti
      from jsonb_array_elements(p_read) with ordinality x(t, ti)
      left join lateral jsonb_array_elements(coalesce(t -> 'sessions', '[]'::jsonb)) s on true),
  tabs as (select distinct on (tab) tab, ti from r order by tab, ti),
  marked as (
    select r.*, (
      exists (select 1 from public.sheet_record_links l
               where l.member_id = p_member and l.gen = v_src.link_gen and l.tab = r.tab and l.day_no = r.day_no and l.col = r.col and l.day = r.dt)
      or exists (select 1 from public.workout_sessions w
                  where w.member_id = p_member and w.source = 'app' and w.day = r.dt and w.day_no = r.day_no and private.is_workout_session(w.id))) skip
      from r where r.day_no is not null),
  keep as (select tab, day_no, col from marked where not skip),
  gone as (
    select w.id from public.workout_sessions w
     where w.member_id = p_member and w.source = 'sheet'
       and ((w.sheet_tab in (select tab from tabs) and not exists (select 1 from keep k where k.tab = w.sheet_tab and k.day_no = w.day_no and k.col = w.sheet_col))
            or not (w.sheet_tab = any (p_month_tabs))))
  select jsonb_build_object(
    'status', 'preview',
    'removes', (select count(*) from gone),
    'tabs', coalesce((select jsonb_agg(jsonb_build_object('tab', t.tab,
                        'sessions', (select count(*) from marked m where m.tab = t.tab and not m.skip),
                        'skipped', (select count(*) from marked m where m.tab = t.tab and m.skip)) order by t.ti) from tabs t), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke execute on function public.sheet_records_preview(uuid, text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.sheet_records_preview(uuid, text, jsonb, text[]) to service_role;
