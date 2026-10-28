-- 운영에서 직접 써 보기 위한 테스트 계정 표시.
-- is_test 트레이너는 회원 가입 화면의 트레이너 목록(list_trainers)에 나오지 않는다.
-- 테스트 회원은 테스트 트레이너에게 배정해 두므로 실제 트레이너 화면에도 나오지 않는다.
-- 표시는 운영자가 SQL로만 바꾼다(앱에는 수정 권한이 없다).
alter table public.profiles add column is_test boolean not null default false;

create or replace function public.list_trainers()
returns table (id uuid, nickname text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.nickname from public.profiles p
  where p.role = 'trainer' and not p.is_test
  order by p.nickname;
$$;
revoke execute on function public.list_trainers() from public;
grant execute on function public.list_trainers() to anon, authenticated;
