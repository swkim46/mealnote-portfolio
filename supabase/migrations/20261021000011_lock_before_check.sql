-- Codex 재검토(ad10d77) P1: 본인의 되찾기가 계정 잠금을 잡은 동안 기다리던 공격자의 change_my_pin·set_recovery가
-- 잠금이 풀린 뒤 그대로 실행돼 PIN과 복구 답을 다시 덮어썼다(세션·PIN 확인을 잠금 전에 끝냈기 때문).
-- 계정 상태를 바꾸는 함수는 모두 계정 잠금(account_security 행)을 먼저 잡고, 그 안에서 세션·본인 확인을 한다.

create or replace function public.change_my_pin(p_new_pin text, p_current_pin text default null, p_answer text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_res text; v_at timestamptz;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  insert into private.account_security (user_id) values (v_uid) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = v_uid for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  if coalesce(p_new_pin, '') !~ '^\d{6}$' then return jsonb_build_object('status', 'bad_pin'); end if;
  if p_current_pin is not null then
    if not private.pin_matches(v_uid, p_current_pin) then return jsonb_build_object('status', 'wrong'); end if;
    if p_current_pin = p_new_pin then return jsonb_build_object('status', 'same'); end if;
  else
    v_res := private.check_answer(v_uid, p_answer);
    if v_res <> 'ok' then return jsonb_build_object('status', v_res); end if;
  end if;
  v_at := private.apply_pin(v_uid, p_new_pin, false);
  insert into private.security_events (user_id, kind) values (v_uid, 'pin_changed');
  return jsonb_build_object('status', 'ok', 'pin_changed_at', v_at);
end;
$$;

create or replace function public.set_recovery(p_question int, p_answer text, p_current_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_a text := private.norm_answer(p_answer);
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  insert into private.account_security (user_id) values (v_uid) on conflict (user_id) do nothing;
  perform 1 from private.account_security where user_id = v_uid for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  if not private.pin_matches(v_uid, p_current_pin) then return jsonb_build_object('status', 'wrong'); end if;
  if p_question not between 1 and 6 or char_length(v_a) < 2 then return jsonb_build_object('status', 'bad_answer'); end if;
  update private.account_security
     set question = p_question, answer_hash = extensions.crypt(v_a, extensions.gen_salt('bf', 10)), failed_count = 0, locked_until = null, updated_at = now()
   where user_id = v_uid;
  insert into private.security_events (user_id, kind) values (v_uid, 'recovery_set');
  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.report_pin_not_me()
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_allowed'; end if;
  perform 1 from private.account_security where user_id = (select auth.uid()) for update;
  if not private.session_ok() then raise exception 'not_allowed'; end if;
  insert into private.security_events (user_id, kind) values ((select auth.uid()), 'reported_not_me');
end;
$$;
