// 남의 식사 사진(v1.8): 담당 트레이너가 보는 회원 사진, 같은 트레이너 회원들이 보는 추천 식단 사진.
// 서명 주소는 만든 뒤 담당이 끊기거나 동의를 꺼도 만료 전까지 열리므로(Codex v1.8.0 리뷰 3·재리뷰 1), 남의 사진에는 저장소 읽기 권한을 주지 않고
// 요청마다 지금 권한을 확인한 뒤 이 함수가 내려준다. 본인 사진만 저장소에서 직접 읽는다.
// 확인: 부른 사람의 로그인으로 DB 함수 meal_photo_path(식사) — 본인·지금 담당 트레이너·공유 범위이고 사진이 그 회원 폴더일 때만 경로를 준다.
// 사용자 확인은 함수 안에서 그 로그인으로 DB를 부르는 것으로 한다(config.toml에서 verify_jwt = false). 응답은 기기에 남기지 않게 no-store.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const deny = (status: number) => new Response(null, { status, headers: { ...CORS, 'cache-control': 'no-store' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return deny(405);
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer \S+$/.test(auth)) return deny(401);
  let meal = '';
  try {
    meal = String((await req.json())?.meal ?? '');
  } catch {
    return deny(400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(meal)) return deny(400);
  const user = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: path, error } = await user.rpc('meal_photo_path', { p_meal: meal });
  if (error || typeof path !== 'string' || !path) return deny(403);
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: blob, error: dlError } = await admin.storage.from('meal-photos').download(path);
  if (dlError || !blob) return deny(404);
  return new Response(blob, { headers: { ...CORS, 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
});
