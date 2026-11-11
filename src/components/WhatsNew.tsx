// 새 기능 소개(2.3 — 사용자 선택 11-05, 시안 design/v23-20261105 10번): 업데이트 뒤 처음 열 때 한 번. 처음 깐 기기는 시작 안내만 본다.
// 소식 전체는 설정 → 업데이트 소식(releases.ts). 여기는 눌러서 그 기능으로 바로 가는 짧은 소개다. 언제 뜨는지는 src/lib/startGuide.ts.
export type WhatsNewTarget = 'community' | 'inbody' | 'records' | 'members' | 'check';
type Item = { icon: string; title: string; lines: string[]; go: string; to: WhatsNewTarget };

const KINGS: Item = { icon: '🏋', title: '이달의 중량왕', lines: ['벤치 프레스·데드리프트·스쿼트의 5회 세트 기록으로 남녀 중량왕을 각각 뽑아요.'], go: '커뮤니티에서 보기', to: 'community' };
const WORDS: Item = { icon: '💬', title: '트레이너 한마디 모아 보기', lines: ['지난 한마디와 운동 꿀팁을 다시 볼 수 있어요.'], go: '커뮤니티에서 보기', to: 'community' };

const ITEMS: Record<'member' | 'trainer', Item[]> = {
  member: [
    { ...KINGS, lines: [...KINGS.lines, '설정 → 계정에서 성별을 정해 주세요.'] },
    { icon: '⚖', title: '공복 체중 기록', lines: ['공복 체중을 기록하면 인바디 측정값과 같은 그래프에서 볼 수 있어요.'], go: '인바디에서 적기', to: 'inbody' },
    { icon: '📋', title: '변화 보고서', lines: ['변화 카드에서 ‘자세히 보기’를 누르면 측정 사이의 식단·운동·체성분 변화를 볼 수 있어요.'], go: '인바디에서 보기', to: 'inbody' },
    WORDS,
    { icon: '⏱', title: '쉬는 시간 알림음', lines: ['쉬는 시간이 끝나면 알림음이 세 번 울려요.'], go: '운동 기록 열기', to: 'records' },
  ],
  trainer: [
    { icon: '👥', title: '회원 목록', lines: ['담당 회원 수를 확인하고 이름순·초성으로 회원을 찾을 수 있어요.', '회원 카드에서 최근 운동을 보고 각 기록으로 바로 이동할 수 있어요.'], go: '회원 목록 열기', to: 'members' },
    { icon: '🏃', title: '새 운동 기록', lines: ['회원이 새로 남긴 운동 기록을 확인 탭 맨 위에서 볼 수 있어요.'], go: '확인 탭 열기', to: 'check' },
    { icon: '📋', title: '변화 보고서', lines: ['인바디 변화 카드에서 ‘자세히 보기’를 눌러 보고서를 보고 총평을 남길 수 있어요.'], go: '회원 목록 열기', to: 'members' },
    KINGS,
    { ...WORDS, lines: ['운동 꿀팁으로 표시한 글은 회원이 따로 모아 볼 수 있어요.'] },
  ],
};

export function WhatsNew({ role, onGo, onDone }: { role: 'member' | 'trainer'; onGo: (to: WhatsNewTarget) => void; onDone: () => void }) {
  return (
    <div className="whats-new" data-testid="whats-new">
      {ITEMS[role].map((x) => (
        <div key={x.title} className="whats-new-item">
          <i aria-hidden="true">{x.icon}</i>
          <div>
            <b>{x.title}</b>
            {x.lines.map((line) => <p key={line}>{line}</p>)}
            <button type="button" className="text-button" onClick={() => onGo(x.to)}>
              {x.go} ›
            </button>
          </div>
        </div>
      ))}
      <p className="tiny">화면 왼쪽 가장자리에서 오른쪽으로 밀면 이전 화면으로 돌아가요.</p>
      <p className="tiny">설정 → 업데이트 소식에서 전체 변경 내용을 볼 수 있어요.</p>
      <button type="button" className="primary full" onClick={onDone}>
        확인
      </button>
    </div>
  );
}
