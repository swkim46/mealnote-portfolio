// 아직 안 한 설정을 알리는 창(lib/setupNudge.ts가 하루 한 번 띄운다). 줄을 누르면 그 설정 창으로 간다
import type { SetupItem } from '../lib/setupNudge';
import { Icon } from './Icon';

export function SetupNudge({ items, member, onPush, onSheet, onClose }: { items: SetupItem[]; member: boolean; onPush: () => void; onSheet: () => void; onClose: () => void }) {
  return (
    <div className="setup-nudge" data-testid="setup-nudge">
      <div className="community-card">
        {items.includes('push') && (
          <button type="button" className="setup-row" onClick={onPush}>
            <span>
              <b>알림 켜기</b>
              <small>{member ? '트레이너 피드백을 바로 받아요.' : '확인할 식사와 질문을 바로 받아요.'}</small>
            </span>
            <Icon name="right" />
          </button>
        )}
        {items.includes('sheet') && (
          <button type="button" className="setup-row" onClick={onSheet}>
            <span>
              <b>운동 시트 연결</b>
              <small>그 달 루틴이 앱에 들어와요.</small>
            </span>
            <Icon name="right" />
          </button>
        )}
      </div>
      <button type="button" className="secondary full" onClick={onClose}>
        나중에 할게요
      </button>
    </div>
  );
}
