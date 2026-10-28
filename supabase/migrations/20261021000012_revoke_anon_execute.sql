-- 운영 반영 직후 보안 점검에서 발견: 0006 이후 만든 '로그인한 사람용' 함수에서 public 권한만 거두고
-- Supabase가 새 함수에 기본으로 주는 anon 실행 권한은 거두지 않았다.
-- 각 함수가 안에서 로그인·세션을 확인해 거부하므로 실제 노출은 없었지만, 이중 안전장치로 anon 권한을 거둔다.
-- (begin_signup·get_recovery_question·reset_pin_with_answer·list_trainers·nickname_taken은 로그인 전 화면용이라 anon 유지)
revoke execute on function
  public.change_my_pin(text, text, text),
  public.set_recovery(int, text, text),
  public.my_security_status(),
  public.report_pin_not_me(),
  public.reclaim_account(text, int, text),
  public.admin_security_events(),
  public.ack_pin_change(),
  public.mark_reviewed(uuid),
  public.mark_seen(uuid)
from anon;
