-- v2.0.1 주요 업데이트 알림은 운영자가 정해 보낸다(2026-11-02 사용자 결정): 회원·트레이너가 끄는 설정을 없앤다.
-- 알림 설정 화면의 '앱 업데이트 소식' 줄을 지우고, 받을지 판단(private.push_pref)도 이 칸을 보지 않는다 — 2.0.0 화면에서 꺼 둔 사람도 받는다.
-- push_prefs.updates 칸은 남긴다(2.0.0 화면이 아직 읽고 쓴다, 판단에는 쓰지 않음). 알림을 켠 기기가 있어야 받는 것은 그대로다.
create or replace function private.push_pref(p_uid uuid, p_kind text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case p_kind
           when 'digest' then coalesce((select digest from public.push_prefs where user_id = p_uid), true)
           when 'feedback' then coalesce((select feedback from public.push_prefs where user_id = p_uid), true)
           when 'lunch' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'dinner' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'morning' then coalesce((select morning from public.push_prefs where user_id = p_uid), true)
           else true end;
$$;
