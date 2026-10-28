import { createClient } from '@supabase/supabase-js';

const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
if (!envUrl || !key) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 환경 변수가 없습니다.');

// 개발 모드에서 로컬 Supabase(127.0.0.1)를 쓸 때는 개발 서버의 /supabase 경로로 돌려 보낸다.
// 로컬 Supabase는 맥 안에서만 열려 있어서, 같은 와이파이의 휴대폰은 이 경로로만 닿는다(vite.config.ts의 proxy).
// 휴대폰 알림 시험 빌드(phonetest, 빌드본이라 DEV=false)도 VITE_SUPABASE_SAME_ORIGIN=1로 같은 경로를 쓴다(터널 https 주소 → 맥 → 로컬 DB).
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(envUrl);
const sameOrigin = import.meta.env.DEV || import.meta.env.VITE_SUPABASE_SAME_ORIGIN === '1';
const url = sameOrigin && isLocal ? `${location.origin}/supabase` : envUrl;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
