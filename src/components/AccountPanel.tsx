import { Icon } from './Icon';
import { roleLabel, signOut } from '../lib/auth';
import { VERSION_LABEL } from '../lib/releases';
import { TextSizeSetting } from './TextSizeControls';
import { ThemeSetting } from './ThemeControls';
import { useEffect, useState } from 'react';
import { mySecurityStatus } from '../lib/pin';
import type { Profile } from '../lib/types';

export function InstallHint() {
  return (
    <div className="install-hint">
      <strong>홈 화면에 추가하면 앱처럼 쓸 수 있어요.</strong>
      {/* iOS 26부터 Safari 기본 화면(탭 '간략히')에는 공유 버튼이 바로 안 보이고 주소창 옆 ⋯ 안에 있다 */}
      <p>iPhone: Safari 주소창 옆 ⋯ → 공유 → 홈 화면에 추가 (공유 버튼이 바로 보이면 공유부터)</p>
      <p>Android: Chrome 오른쪽 위 메뉴 → 홈 화면에 추가</p>
    </div>
  );
}

/** 앱 아래쪽에 두는 작은 의견 보내기 링크 */
export function FeedbackLink({ onClick }: { onClick: () => void }) {
  return (
    <button className="feedback-link" onClick={onClick}>
      앱이 불편하거나 오류가 있나요? <strong>의견 보내기</strong>
    </button>
  );
}

interface PanelProps {
  profile: Profile;
  detail: string;
  onFeedback?: () => void;
  onReleases: () => void;
  onChangePin: () => void;
  onRecovery: () => void;
  onChangeNickname: () => void;
  /** 알림 설정(회원·트레이너만) */
  onNotifications?: () => void;
}

export function AccountPanel({ profile, detail, onFeedback, onReleases, onChangePin, onRecovery, onChangeNickname, onNotifications }: PanelProps) {
  const [hasRecovery, setHasRecovery] = useState<boolean | null>(null);
  useEffect(() => {
    mySecurityStatus()
      .then((s) => setHasRecovery(s.has_recovery))
      .catch(() => {});
  }, []);
  return (
    <>
      <div className="profile-banner">
        <span className="avatar">{profile.nickname.slice(0, 1)}</span>
        <div>
          <strong>
            {profile.nickname} {roleLabel(profile.role)}
          </strong>
          <p>{detail}</p>
        </div>
      </div>
      <TextSizeSetting />
      <ThemeSetting />
      {onNotifications && (
        <button className="menu-row" onClick={onNotifications}>
          <Icon name="bell" />
          <span>
            <strong>알림 설정</strong>
            <small>앱을 닫아 두어도 새 소식을 휴대폰 알림으로 받아요</small>
          </span>
          <Icon name="right" />
        </button>
      )}
      <button className="menu-row" onClick={onChangeNickname}>
        <Icon name="user" />
        <span>
          <strong>닉네임 바꾸기</strong>
          <small>로그인할 때 쓰는 이름도 함께 바뀌어요</small>
        </span>
        <Icon name="right" />
      </button>
      <button className="menu-row" onClick={onChangePin}>
        <Icon name="user" />
        <span>
          <strong>PIN 바꾸기</strong>
          <small>지금 PIN이나 복구 질문의 답으로 바꿔요</small>
        </span>
        <Icon name="right" />
      </button>
      <button className={`menu-row ${hasRecovery === false ? 'needs-action' : ''}`} onClick={onRecovery}>
        <Icon name="check" />
        <span>
          <strong>
            복구 질문 {hasRecovery === false ? '정하기' : '바꾸기'} {hasRecovery === false && <span className="new-badge">필요</span>}
          </strong>
          <small>PIN을 잊었을 때 혼자 되찾는 데 써요</small>
        </span>
        <Icon name="right" />
      </button>
      {onFeedback && (
        <button className="menu-row" onClick={onFeedback}>
          <Icon name="chat" />
          <span>
            <strong>의견 보내기</strong>
            <small>불편한 점·오류·바라는 기능을 익명으로 알려 주세요</small>
          </span>
          <Icon name="right" />
        </button>
      )}
      <button className="menu-row" onClick={onReleases}>
        <Icon name="book" />
        <span>
          <strong>
            업데이트 소식
          </strong>
          <small>지금 버전 {VERSION_LABEL} · 바뀐 내용을 확인해요</small>
        </span>
        <Icon name="right" />
      </button>
      <p className="hint account-note">로그아웃하기 전까지 이 기기에서 로그인이 유지돼요.</p>
      <button className="secondary full" onClick={() => void signOut()}>
        <Icon name="logout" /> 로그아웃
      </button>
      <InstallHint />
    </>
  );
}
