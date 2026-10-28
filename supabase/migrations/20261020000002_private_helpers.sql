-- 정책 안에서만 쓰는 보조 함수를 API에 노출되지 않는 private 스키마로 옮긴다.
-- 정책은 함수를 OID로 참조하므로 스키마를 옮겨도 그대로 동작한다.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter function public.is_my_member(uuid) set schema private;
alter function public.can_read_member_folder(text) set schema private;
