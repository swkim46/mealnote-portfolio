// 2.0 설정 탭(회원·트레이너 공통): 프로필 한 줄 → 묶음 목록(알림과 화면 / 공유(회원) / 계정 / 도움말).
// 1.8의 내 정보 화면(AccountPanel)과 머리글의 테마·글씨 버튼, 탭 아래쪽 의견 링크·버전 줄을 여기로 모았다(계획서 원칙 1·7).
import { useEffect, useState, type ReactNode } from 'react';
import { roleLabel, signOut } from '../lib/auth';
import { VERSION_LABEL } from '../lib/releases';
import { mySecurityStatus } from '../lib/pin';
import { useTheme } from '../lib/theme';
import { useTextSize } from '../lib/textSize';
import type { Profile } from '../lib/types';
import { Segmented, SettingsGroup, SettingsRow } from '../ui/kit';
import { GenderSetting } from './GenderSetting';

export type SettingsSheet = 'push' | 'nickname' | 'pin' | 'recovery' | 'appFeedback' | 'releases' | 'install';

export function SettingsPanel({ profile, detail, onOpen, share }: { profile: Profile; detail: string; onOpen: (s: SettingsSheet) => void; share?: ReactNode }) {
  const [hasRecovery, setHasRecovery] = useState<boolean | null>(null);
  useEffect(() => {
    mySecurityStatus()
      .then((s) => setHasRecovery(s.has_recovery))
      .catch(() => {});
  }, []);
  const { theme, change: setTheme } = useTheme();
  const { size, change: setSize } = useTextSize();
  return (
    <>
      <div className="profile-line">
        <span className="avatar">{profile.nickname.slice(0, 1)}</span>
        <div>
          <strong>
            {profile.nickname} <small>{roleLabel(profile.role)}</small>
          </strong>
          <p>{detail}</p>
        </div>
      </div>
      <SettingsGroup title="알림과 화면">
        <SettingsRow icon="bell" label="알림" onClick={() => onOpen('push')} />
        <SettingsRow
          icon="moon"
          label="화면 테마"
          control={
            <Segmented
              label="화면 테마"
              value={theme}
              onChange={setTheme}
              options={[
                ['light', '라이트'],
                ['dark', '다크'],
              ]}
            />
          }
        />
        <SettingsRow
          label="글씨 크기"
          control={
            <Segmented
              label="글씨 크기"
              value={size}
              onChange={setSize}
              options={[
                ['normal', '보통'],
                ['large', '크게'],
              ]}
            />
          }
        />
      </SettingsGroup>
      {share && <SettingsGroup title="공유">{share}</SettingsGroup>}
      <SettingsGroup title="계정" note={profile.role === 'member' ? '성별 수정이 필요하면 ‘의견 보내기’로 알려 주세요.' : undefined}>
        {profile.role === 'member' && <GenderSetting userId={profile.id} />}
        <SettingsRow icon="user" label="닉네임 바꾸기" onClick={() => onOpen('nickname')} />
        <SettingsRow icon="user" label="PIN 바꾸기" onClick={() => onOpen('pin')} />
        <SettingsRow
          icon="check"
          label={hasRecovery === false ? '복구 질문 정하기' : '복구 질문 바꾸기'}
          attention={hasRecovery === false}
          onClick={() => onOpen('recovery')}
        />
      </SettingsGroup>
      <SettingsGroup title="도움말">
        <SettingsRow icon="chat" label="의견 보내기" onClick={() => onOpen('appFeedback')} />
        <SettingsRow icon="book" label="업데이트 소식" value={VERSION_LABEL} onClick={() => onOpen('releases')} />
        <SettingsRow icon="home" label="홈 화면에 추가하기" onClick={() => onOpen('install')} />
        <SettingsRow icon="logout" label="로그아웃" onClick={() => void signOut()} />
      </SettingsGroup>
      <p className="hint account-note">로그아웃하기 전까지 이 기기에서 로그인이 유지돼요.</p>
    </>
  );
}
