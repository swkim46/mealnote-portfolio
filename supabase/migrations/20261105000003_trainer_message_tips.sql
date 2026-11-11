-- 트레이너 한마디 모아 보기(2.3 — 트레이너 의견 2026-11-04: 운동 꿀팁을 올릴 예정). 한마디에 '운동 꿀팁' 표시를 둔다.
-- 옛 앱(2.2)은 인자 두 개로 부른다 — p_is_tip이 없으면 표시는 그대로 둔다.
alter table public.trainer_messages add column is_tip boolean not null default false;

drop function public.set_trainer_message(date, text);
create function public.set_trainer_message(p_day date, p_body text, p_is_tip boolean default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_body text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null or not private.session_ok()
     or not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'trainer') then
    raise exception 'not_allowed';
  end if;
  if p_day is null or p_day not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  if v_body = '' then
    delete from public.trainer_messages where trainer_id = v_uid and day = p_day;
  elsif char_length(v_body) > 100 then
    raise exception 'too_long';
  else
    insert into public.trainer_messages (trainer_id, day, body, is_tip) values (v_uid, p_day, v_body, coalesce(p_is_tip, false))
    on conflict (trainer_id, day) do update set body = excluded.body, is_tip = coalesce(p_is_tip, public.trainer_messages.is_tip), updated_at = now();
  end if;
end;
$$;
revoke execute on function public.set_trainer_message(date, text, boolean) from public, anon;
grant execute on function public.set_trainer_message(date, text, boolean) to authenticated;
