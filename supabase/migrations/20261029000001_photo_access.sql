-- v1.8 Codex 재리뷰(2026-10-29) 1: 담당에서 내보낸 뒤에도 그 전에 받은 1시간짜리 사진 서명 주소로 새로 내려받을 수 있었다.
-- 남의 사진에는 저장소 읽기(→ 서명) 권한을 주지 않는다. 본인 폴더만 직접 읽고, 담당 트레이너·추천 식단은 서버 기능 meal-photo가
-- 요청마다 meal_photo_path로 지금 권한을 확인해 내려준다(담당이 끊기면 다음 요청부터 거부).
drop policy meal_photos_select on storage.objects;
create policy meal_photos_select on storage.objects for select to authenticated
using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop function public.shared_photo_path(uuid);
create function public.meal_photo_path(p_meal uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.photo_path from public.meals m
   where m.id = p_meal and m.photo_path is not null and private.session_ok()
     and split_part(m.photo_path, '/', 1) = m.member_id::text
     and (
       m.member_id = (select auth.uid())
       or private.is_my_member(m.member_id)
       or exists (
         select 1 from public.assignments a join public.profiles o on o.id = m.member_id
          where a.member_id = m.member_id and m.shared_at is not null and o.share_consent
            and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer()
       )
     );
$$;
revoke execute on function public.meal_photo_path(uuid) from public, anon;
grant execute on function public.meal_photo_path(uuid) to authenticated;
