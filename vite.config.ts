import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 버전 표시(2026-10-23 결정): 버전 번호는 운영 배포 기준. APP_VERSION은 '다음 운영 버전'이고 dev에서 바꾸지 않는다.
// 운영 빌드는 v1.4.0, dev 빌드(개발 서버·검증 빌드)는 v1.4.0-dev.N(+커밋 수) · 커밋 [+작업중].
const APP_VERSION = /export const APP_VERSION = '([0-9.]+)'/.exec(readFileSync('src/lib/releases.ts', 'utf8'))?.[1] ?? '0.0.0';
const sh = (cmd: string) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
function devLabel() {
  const sha = sh('git rev-parse --short=7 HEAD') || 'nogit';
  // 예: v1.4.0-dev.2-3-gabc1234 (마지막 dev 태그 이후 커밋 3개)
  const desc = sh(`git describe --tags --long --match "v${APP_VERSION}-dev.*"`);
  const m = /^(v[0-9.]+-dev\.\d+)-(\d+)-g/.exec(desc);
  const base = m ? (m[2] === '0' ? m[1] : `${m[1]}+${m[2]}`) : `v${APP_VERSION}-dev`;
  const dirty = sh('git status --porcelain --untracked-files=no') !== '';
  return `${base} · ${sha}${dirty ? ' +작업중' : ''}`;
}

// 휴대폰 알림 시험 빌드(phonetest): 터널 https 주소로 연 휴대폰이 맥의 로컬 DB만 쓰게 한다.
// 파일 원문이 아니라 Vite가 최종 적용할 값(셸 환경 변수·.env.phonetest.local 포함)으로 확인하고, 로컬이 아니면 빌드·미리보기를 멈춘다.
function assertPhonetestLocal(mode: string) {
  if (mode !== 'phonetest') return;
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))) };
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.VITE_SUPABASE_URL ?? '')) {
    throw new Error('중단: phonetest 빌드의 DB 주소가 로컬(127.0.0.1·localhost)이 아닙니다. 셸 환경 변수와 .env.phonetest.local을 확인하세요.');
  }
  if (env.VITE_SUPABASE_SAME_ORIGIN !== '1') throw new Error('중단: phonetest 빌드에는 VITE_SUPABASE_SAME_ORIGIN=1이 필요합니다.');
}

// 로컬 Supabase로 넘기는 것은 실제 API 경로(/supabase/rest|auth|storage|functions/v1)만. '/supabase' 전체를 넘기면
// 앱이 불러오는 공용 문구 파일(supabase/functions/_shared/quotes.ts)까지 DB로 가서 404가 난다(2026-10-27)
const supabaseProxy = {
  '^/supabase/(rest|auth|storage|functions)/v1': {
    target: 'http://127.0.0.1:54321',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/supabase/, ''),
  },
};

export default defineConfig(({ mode }) => (assertPhonetestLocal(mode), {
  define: {
    __APP_BUILD__: JSON.stringify(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16)),
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __CHANNEL__: JSON.stringify(mode === 'production' ? 'prod' : 'dev'),
    __DEV_LABEL__: JSON.stringify(mode === 'production' ? '' : devLabel()),
  },
  plugins: [react(), VitePWA({
    // 새 버전 적용 시점은 앱이 정한다(src/lib/appUpdate.ts): 입력 중이 아닐 때 조용히, 입력 중이면 띠
    registerType: 'prompt',
    injectRegister: false,
    includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'logo.svg'],
    manifest: {
      name: '식단노트',
      short_name: '식단노트',
      description: '회원의 식단 기록과 트레이너 피드백을 잇는 앱',
      lang: 'ko',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      // 설치 앱 시작 화면·기본 상단 색(라이트 기준). 실행 뒤에는 index.html·theme.ts가 테마에 맞춰 바꾼다
      background_color: '#F5F5F5',
      theme_color: '#F5F5F5',
      icons: [
        { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      // 앱 화면 파일만 저장해 둔다. Supabase 요청(데이터·사진)은 저장하지 않는다.
      globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      // 인바디 글자 인식 파일(수 MB)은 미리 저장하지 않는다. '사진에서 읽기'를 누를 때만 받는다.
      // 알림 설정 그림 안내 이미지(약 1.3MB)도 안내를 열 때만 받는다
      globIgnores: ['ocr/**', 'guides/**'],
      navigateFallback: '/index.html',
      // 새 서비스워커가 열린 화면을 즉시 맡게(clientsClaim) 하지 않는다. 켜 두면 적용 순간 기존 화면의 새로고침 요청이
      // 끝나지 않고 걸리는 일이 있었다(새 버전 적용 검증에서 약 14번 중 3~4번, 끄고 6번 연속 통과). 처음 연 화면은
      // appUpdate.ts의 3초 뒤 직접 새로고침이 맡는다.
      clientsClaim: false,
      // 푸시 알림 받기·누르기(public/push-sw.js). 서비스워커 업데이트 흐름은 그대로 두고 이벤트만 더한다
      importScripts: ['push-sw.js'],
    },
  })],
  server: {
    host: true,
    port: 5173,
    // 로컬 Supabase로 가는 요청을 대신 전달한다(src/lib/supabase.ts 참고)
    proxy: supabaseProxy,
  },
  // 휴대폰 알림 시험(npm run phone:test): 빌드본을 띄우고 같은 /supabase 경로로 로컬 DB에 전달. 터널 주소는 이 모드에서만 허용
  preview: mode === 'phonetest' ? { proxy: supabaseProxy, allowedHosts: ['.trycloudflare.com'] } : undefined,
}));
