-- 가입 직후 인증 서버가 메타데이터를 다시 쓰면서 등록 코드가 되살아났다(검증 스크립트로 확인).
-- 갱신 때도 등록 코드를 지운다.
create function private.strip_trainer_code()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.raw_user_meta_data ? 'trainer_code' then
    new.raw_user_meta_data := new.raw_user_meta_data - 'trainer_code';
  end if;
  return new;
end;
$$;
revoke execute on function private.strip_trainer_code() from public, anon, authenticated;

create trigger before_auth_user_updated_strip_code
  before update on auth.users
  for each row execute function private.strip_trainer_code();

update auth.users set raw_user_meta_data = raw_user_meta_data - 'trainer_code'
where raw_user_meta_data ? 'trainer_code';
