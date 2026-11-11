-- v1.8 (2026-10-28 사용자 요청)
-- 1) 알림 목록 소식마다 '이미 확인했는지'(handled): 알림 목록을 열지 않고 피드백 탭·확인 목록에서 그 식사를 따로 확인해도
--    종 버튼 점이 사라지게. 회원 평가·답글 = 그 식사의 피드백을 읽음(member_seen_at), 트레이너 기록 = 확인 처리(reviewed_at),
--    트레이너 질문·고친 한마디 = 그 뒤 확인했거나 답함. 앱은 '목록을 연 뒤에 생겼고 아직 확인하지 않은' 소식만 새 소식으로 센다.
-- 2) 알림 제목: 늘 '식단노트'로 보내 아이폰에서 앱 이름과 제목이 '식단노트'로 겹쳐 보였다. 종류별 제목을 넣는다.
-- my_activity(handled 포함)는 좋아요 표가 생긴 뒤 20261028000002_social.sql에서 정의한다.

create or replace function private.push_payload(n private.push_notifications, p_now timestamptz)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_q int; v_r int; v_body text; v_day date;
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
  elsif n.kind = 'test' then
    return jsonb_build_object('title', '알림이 켜졌어요', 'body', '새 소식이 있으면 이렇게 알려 드려요.', 'open', '', 'tag', 'test', 'ttl', 600);
  end if;
  return null;
end;
$$;
