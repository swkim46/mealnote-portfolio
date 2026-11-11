-- v2.0 주요 업데이트 알림(2026-10-30 사용자 요청: 2.0 같은 주요 업데이트 때 푸시 알림).
--  - 업데이트 소식(src/lib/releases.ts)의 버전 항목에 push 문구가 있으면, 그 N.M을 처음 운영에 낼 때 배포 명령이
--    scripts/release-push.mjs로 private.queue_release_push를 부른다. 알림을 켠 회원·트레이너 기기마다 한 번.
--  - 같은 버전은 다시 불러도 한 번만(release_pushes의 버전 키). 받을 알림에 '앱 업데이트 소식'(push_prefs.updates, 기본 켬)을 둔다.
--  - 누르면 앱 첫 화면('open' 빈 값 — 1.8 서비스워커도 그대로 처리). 이틀이 지나도록 못 보낸 알림은 버린다.

alter table public.push_prefs add column updates boolean not null default true;

alter table private.push_notifications drop constraint push_notifications_kind_check;
alter table private.push_notifications add constraint push_notifications_kind_check
  check (kind = any (array['digest', 'feedback', 'lunch', 'dinner', 'morning', 'test', 'release']));

create table private.release_pushes (
  version    text primary key check (version ~ '^[0-9]+\.[0-9]+$'),
  title      text not null check (length(btrim(title)) between 1 and 40),
  body       text not null check (length(btrim(body)) between 1 and 120),
  queued_at  timestamptz not null default now(),
  recipients int not null default 0
);
revoke all on private.release_pushes from public, anon, authenticated;

create or replace function private.push_pref(p_uid uuid, p_kind text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case p_kind
           when 'digest' then coalesce((select digest from public.push_prefs where user_id = p_uid), true)
           when 'feedback' then coalesce((select feedback from public.push_prefs where user_id = p_uid), true)
           when 'lunch' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'dinner' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'morning' then coalesce((select morning from public.push_prefs where user_id = p_uid), true)
           when 'release' then coalesce((select updates from public.push_prefs where user_id = p_uid), true)
           else true end;
$$;

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
  elsif n.kind = 'test' then
    return jsonb_build_object('title', '알림이 켜졌어요', 'body', '새 소식이 있으면 이렇게 알려 드려요.', 'open', '', 'tag', 'test', 'ttl', 600);
  end if;
  return null;
end;
$function$;

-- 배포 명령만 부른다(운영 DB 관리자 연결). 반환: 새로 만든 알림 수, 이미 보낸 버전이면 0
create function private.queue_release_push(p_version text, p_title text, p_body text)
returns int language plpgsql security definer set search_path = ''
as $$
declare v_n int := 0; v_uid uuid;
begin
  perform pg_advisory_xact_lock(hashtext('mealnote_release_push'));
  insert into private.release_pushes (version, title, body) values (p_version, btrim(p_title), btrim(p_body))
  on conflict (version) do nothing;
  if not found then return 0; end if;
  for v_uid in
    select distinct s.user_id from public.push_subscriptions s join public.profiles p on p.id = s.user_id
     where p.role in ('member', 'trainer')
  loop
    perform private.push_add(v_uid, 'release', p_version, null, null, now() + interval '2 days');
    v_n := v_n + 1;
  end loop;
  update private.release_pushes set recipients = v_n where version = p_version;
  perform private.push_kick_soon();
  return v_n;
end;
$$;
revoke execute on function private.queue_release_push(text, text, text) from public, anon, authenticated;
