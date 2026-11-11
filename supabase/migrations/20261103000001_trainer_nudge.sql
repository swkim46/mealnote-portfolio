-- 트레이너 '기록 알림 보내기'(2.1, 2026-11-03 사용자 확정 시안 — design/diet-tab-20261103 · 문서/기획/식단탭_레퍼런스조사_261103.md).
--  - 트레이너 회원 목록의 회원별 하루 카드에서, 오늘(한국 시각) 식사를 하나도 안 남긴 담당 회원에게 알림 하나를 보낸다.
--  - 회원 한 명에게 하루 한 번(같은 날 다시 누르면 'already'). 회원이 '식단 기록 알림'(push_prefs.reminder)을 꺼 두었으면 보내지 않는다.
--  - 보내기 전에 회원이 그날 식사를 남기면 보내지 않는다(push_payload에서 다시 확인). 그날이 지나면 버린다.
--  - 반환: sent · already · logged(오늘 기록 있음) · no_device(알림을 켠 기기 없음) · muted(식단 기록 알림 끔) · off(알림 송신 꺼짐)

alter table private.push_notifications drop constraint push_notifications_kind_check;
alter table private.push_notifications add constraint push_notifications_kind_check
  check (kind = any (array['digest', 'feedback', 'lunch', 'dinner', 'morning', 'test', 'release', 'nudge']));

-- 20261102000001_release_push_always.sql의 판단 그대로 + 'nudge'는 식단 기록 알림 설정을 따른다
create or replace function private.push_pref(p_uid uuid, p_kind text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case p_kind
           when 'digest' then coalesce((select digest from public.push_prefs where user_id = p_uid), true)
           when 'feedback' then coalesce((select feedback from public.push_prefs where user_id = p_uid), true)
           when 'lunch' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'dinner' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'nudge' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'morning' then coalesce((select morning from public.push_prefs where user_id = p_uid), true)
           else true end;
$$;

-- 20261030000005_release_push.sql의 본문 그대로 + 'nudge' 갈래
create or replace function private.push_payload(n private.push_notifications, p_now timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_q int; v_r int; v_body text; v_day date; v_title text;
begin
  if n.expires_at <= p_now or not private.push_allowed(n.user_id) or not private.push_pref(n.user_id, n.kind) then return null; end if;
  if n.kind = 'digest' then
    if not exists (select 1 from public.profiles p where p.id = n.user_id and p.role = 'trainer') then return null; end if;
    select count(*) filter (where kind = 'question'), count(*) filter (where kind = 'review') into v_q, v_r
      from private.trainer_attention(n.user_id);
    if v_q + v_r = 0 then return null; end if;
    v_body := concat_ws(', ',
      case when v_r > 0 then '확인할 식사 기록 ' || v_r || '건' end,
      case when v_q > 0 then '답할 질문 ' || v_q || '건' end) || '이 있어요';
    return jsonb_build_object('title', '확인할 소식', 'body', v_body, 'open', 'queue', 'tag', 'digest', 'ttl', 10800);
  elsif n.kind = 'feedback' then
    -- 이 알림이 알리는 그 피드백을 아직 안 읽었고, 같은 식사를 더 새 피드백 알림이 맡지 않았을 때만 보낸다.
    -- (재시도 대기 중 읽었다면 취소 · 같은 식사에 새 피드백이 생기면 새 알림 하나만 간다)
    if not exists (
      select 1 from unnest(n.meal_ids, n.feedback_ats) as f(meal_id, fat)
        join public.meals m on m.id = f.meal_id and m.member_id = n.user_id
       where m.member_seen_at < f.fat
         and not exists (select 1 from private.push_notifications n2
                          where n2.user_id = n.user_id and n2.kind = 'feedback' and n2.created_at > n.created_at
                            and f.meal_id = any (n2.meal_ids))) then
      return null;
    end if;
    -- 피드백마다 따로 쌓이게 알림마다 다른 tag
    return jsonb_build_object('title', '새 피드백', 'body', '트레이너가 피드백을 남겼어요', 'open', 'feedback', 'tag', 'feedback-' || left(n.id::text, 8), 'ttl', 43200);
  elsif n.kind in ('lunch', 'dinner') then
    v_day := n.slot_key::date;
    if (p_now at time zone 'Asia/Seoul')::date <> v_day
       or exists (select 1 from public.meals m where m.member_id = n.user_id and m.eaten_on = v_day
                    and m.meal_type = case n.kind when 'lunch' then '점심' else '저녁' end) then
      return null;
    end if;
    return jsonb_build_object('title', '식단 기록', 'body', case n.kind when 'lunch' then '점심 식단을 남겨 주세요' else '저녁 식단을 남겨 주세요' end,
      'open', 'today', 'tag', 'reminder', 'ttl', 7200);
  elsif n.kind = 'morning' then
    -- 앱의 '오늘의 한마디'와 같은 규칙: 담당 트레이너가 그날 한마디를 썼으면 그 글, 아니면 그날의 기본 문구.
    -- 기본 문구 목록은 서버 기능(_shared/quotes.ts)에 있으므로 날짜만 넘기고 서버 기능이 채운다.
    v_day := n.slot_key::date;
    if (p_now at time zone 'Asia/Seoul')::date <> v_day then return null; end if;
    select btrim(tm.body) into v_body
      from public.assignments a join public.trainer_messages tm on tm.trainer_id = a.trainer_id and tm.day = v_day
     where a.member_id = n.user_id;
    return jsonb_build_object('title', '오늘 하루도 화이팅!', 'open', 'today', 'tag', 'morning', 'ttl', 7200)
           || case when v_body is not null and v_body <> '' then jsonb_build_object('body', v_body)
                   else jsonb_build_object('quote_day', to_char(v_day, 'YYYY-MM-DD')) end;
  elsif n.kind = 'release' then
    -- 주요 업데이트 알림(v2.0): 문구는 배포 때 버전별로 한 번 저장한 것(private.release_pushes). 누르면 앱 첫 화면
    select r.title, r.body into v_title, v_body from private.release_pushes r where r.version = n.slot_key;
    if v_title is null then return null; end if;
    return jsonb_build_object('title', v_title, 'body', v_body, 'open', '', 'tag', 'release-' || n.slot_key, 'ttl', 172800);
  elsif n.kind = 'nudge' then
    -- 트레이너가 보낸 기록 알림(2.1): 그날(한국 시각) 안에, 회원이 아직 그날 식사를 하나도 안 남겼을 때만
    v_day := n.slot_key::date;
    if (p_now at time zone 'Asia/Seoul')::date <> v_day
       or exists (select 1 from public.meals m where m.member_id = n.user_id and m.eaten_on = v_day) then
      return null;
    end if;
    return jsonb_build_object('title', '식단 기록', 'body', '트레이너가 오늘 식단을 기다리고 있어요', 'open', 'today', 'tag', 'nudge', 'ttl', 7200);
  elsif n.kind = 'test' then
    return jsonb_build_object('title', '알림이 켜졌어요', 'body', '새 소식이 있으면 이렇게 알려 드려요.', 'open', '', 'tag', 'test', 'ttl', 600);
  end if;
  return null;
end;
$function$;

create function public.nudge_member(p_member uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  perform private.lock_account_and_check(v_uid);
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'trainer')
     or p_member is null or not private.is_my_member(p_member) then
    raise exception 'not_allowed';
  end if;
  -- 같은 회원에게 동시에 두 번 눌러도 판단은 하나씩
  perform pg_advisory_xact_lock(hashtext('mealnote_nudge:' || p_member::text));
  if exists (select 1 from public.meals m where m.member_id = p_member and m.eaten_on = v_today) then return 'logged'; end if;
  if exists (select 1 from private.push_notifications n where n.user_id = p_member and n.kind = 'nudge' and n.slot_key = v_today::text) then
    return 'already';
  end if;
  if not private.push_allowed(p_member) then return 'off'; end if;
  if not exists (select 1 from public.push_subscriptions s where s.user_id = p_member) then return 'no_device'; end if;
  if not private.push_pref(p_member, 'nudge') then return 'muted'; end if;
  perform private.push_add(p_member, 'nudge', v_today::text, null, null,
                           ((v_today + 1)::timestamp at time zone 'Asia/Seoul'));
  perform private.push_kick_soon();
  return 'sent';
end;
$$;
revoke execute on function public.nudge_member(uuid) from public, anon;
grant execute on function public.nudge_member(uuid) to authenticated;
