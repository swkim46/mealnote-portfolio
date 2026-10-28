import { IS_DEV_CHANNEL, VERSION_LABEL } from '../lib/releases';

/** dev 빌드(개발 서버·검증 빌드)에서만 보이는 띠: 운영과 헷갈리지 않게 지금 dev 세부 버전을 보여 준다 */
export function DevBanner() {
  if (!IS_DEV_CHANNEL) return null;
  return (
    <div className="dev-banner" role="note">
      테스트 환경 · {VERSION_LABEL}
    </div>
  );
}
