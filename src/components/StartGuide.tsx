// 시작 안내(2.0 — 2026-10-30 사용자 요청. 2.3부터 제목에서 버전을 뺌, Codex 안내 제안): 메뉴 소개 → 휴대폰 알림 받기 → 이미 홈 화면에 추가했다면 → 운동 시트 연결 → 인바디 기록.
// 회원·트레이너가 하는 일이 달라 쪽 내용도 다르다. 창 하나 안에서 쪽을 넘기고, 알림 설정 그림 안내는 같은 창 안에서 열었다 돌아온다.
// 처음 한 번 뜨는 조건과 '봤음' 기록은 src/lib/startGuide.ts.
import { useState, type ReactNode } from 'react';
import { APP_ICON, APP_NAME, OLD_APP_NAME } from '../lib/brand';
import { pushSupport, standalone } from '../lib/push';
import { REINSTALL_NOTICE } from '../lib/startGuide';
import { NotificationGuide } from './NotificationGuide';
import { SheetGuide } from './SheetGuide';
import { Icon } from './Icon';

interface Page {
  key: string;
  /** 'app'이면 앱 아이콘(고정 자산) — 이름이 바뀐 것을 알리는 첫 쪽 */
  icon: string;
  title: string;
  body: ReactNode;
}


/** onConnectSheet: '지금 연결하기'(회원 — 시트 연결 창으로) · '회원 고르러 가기'(트레이너 — 회원 탭으로). 2026-11-03 사용자 요청: 설명과 연결 화면을 잇는다 */
export function StartGuide({ role, onOpenPush, onDone, onConnectSheet }: { role: 'member' | 'trainer'; onOpenPush: () => void; onDone: () => void; onConnectSheet?: () => void }) {
  const [at, setAt] = useState(0);
  // 같은 창 안에서 여는 그림 안내: 휴대폰 알림(홈 화면 추가) · 운동 시트 연결
  const [howTo, setHowTo] = useState<'' | 'push' | 'sheet'>('');
  const member = role === 'member';
  const installed = standalone();
  const canPush = pushSupport() === 'ok';

  const pages: Page[] = [
    {
      key: 'tabs',
      icon: 'app',
      title: `${APP_NAME} 사용 안내`,
      body: (
        <>
          <p>식단과 운동 기록을 트레이너와 함께 관리해요. 화면 아래에 네 가지 메뉴가 있어요.</p>
          <ul className="guide-list">
            {member ? (
              <>
                <li><b>식단</b> 식사 기록과 받은 피드백</li>
                <li><b>운동</b> 트레이너 루틴·운동 기록·인바디</li>
                <li><b>커뮤니티</b> 트레이너 한마디·추천 식단·수상 결과와 순위</li>
                <li><b>설정</b> 알림·화면·계정</li>
              </>
            ) : (
              <>
                <li><b>확인</b> 확인할 식사 기록과 답할 질문</li>
                <li><b>회원</b> 회원 한 명의 식단·운동·인바디를 한 화면에서</li>
                <li><b>커뮤니티</b> 트레이너 한마디·추천 식단·수상 결과와 순위</li>
                <li><b>설정</b> 알림·화면·계정</li>
              </>
            )}
          </ul>
        </>
      ),
    },
    {
      key: 'push',
      icon: 'bell',
      title: '휴대폰 알림 받기',
      body: installed ? (
        <>
          <p>{member ? '트레이너가 피드백을 남기면 바로 알려 드려요.' : '확인할 식사 기록과 답할 질문을 모아서 알려 드려요.'}</p>
          <p>설정 → 알림에서 <b>이 기기에서 알림 받기</b>를 눌러 주세요.</p>
          {canPush && (
            <button type="button" className="primary full" onClick={onOpenPush}>
              알림 설정 열기
            </button>
          )}
          {/* 홈 화면 앱에서도 그림 안내를(2026-11-02 사용자 요청 — 운동 시트 연결처럼) */}
          <button type="button" className="secondary full" onClick={() => setHowTo('push')}>
            그림으로 알림 받는 방법 보기
          </button>
        </>
      ) : (
        <>
          <p>알림은 <b>홈 화면에 추가한 앱</b>에서 받을 수 있어요. 아이폰은 꼭 홈 화면에 추가해야 해요.</p>
          <button type="button" className="secondary full" onClick={() => setHowTo('push')}>
            그림으로 알림 받는 방법 보기
          </button>
        </>
      ),
    },
    ...(REINSTALL_NOTICE
      ? [
          {
            key: 'reinstall',
            icon: 'home',
            title: '이미 홈 화면에 추가했다면',
            body: (
              <>
                <p>새 아이콘과 이름으로 바꾸려면 홈 화면의 {OLD_APP_NAME}를 지우고 다시 추가해 주세요.</p>
                <p>아이폰은 다시 추가한 뒤 <b>한 번 더 로그인</b>하고 <b>알림도 다시 켜</b> 주세요.</p>
                <p className="tiny">다시 추가하지 않아도 2.0은 그대로 쓸 수 있어요.</p>
              </>
            ),
          },
        ]
      : []),
    {
      key: 'sheet',
      icon: 'list',
      title: '운동 시트 연결',
      body: (
        <>
          <p>{member ? '트레이너와 함께 쓰는 구글 운동 시트가 있으면 연결해 보세요. 그 달 루틴이 자동으로 들어와요.' : '회원과 함께 쓰는 구글 운동 시트를 연결하면 루틴이 회원 화면에 자동으로 들어가요.'}</p>
          <p className="tiny">{member ? '연결 화면에서 ① 이메일 복사 ② 링크 붙여 넣기 ③ 연결하기 순서로 해요.' : '회원을 고른 뒤 루틴 → 운동 시트 연결에서 ① 이메일 복사 ② 링크 붙여 넣기 ③ 연결하기 순서로 해요. 회원이 직접 연결해도 돼요.'}</p>
          {onConnectSheet && (
            <button type="button" className="primary full" onClick={onConnectSheet}>
              {member ? '지금 연결하기' : '회원 고르러 가기'}
            </button>
          )}
          <button type="button" className="secondary full" onClick={() => setHowTo('sheet')}>
            그림으로 연결 방법 보기
          </button>
        </>
      ),
    },
    {
      key: 'inbody',
      icon: 'user',
      title: '인바디 기록',
      body: member ? (
        <>
          <p>운동 탭 → <b>인바디</b>에서 결과지 사진을 고르면 체중·골격근량·체지방률을 읽어 채워요.</p>
          <p>사진은 휴대폰 안에서만 읽고 저장하거나 보내지 않아요. 읽은 값은 확인하고 고칠 수 있어요.</p>
          <p className="tiny">측정 사이의 변화는 같은 화면에서 그래프와 변화 카드로 봐요.</p>
        </>
      ) : (
        <>
          <p>회원 → 회원 고르기 → <b>인바디</b>에서 회원이 남긴 기록을 봐요.</p>
          <p className="tiny">지난 측정 이후의 변화(식단 평가·운동한 날 포함)는 같은 인바디 화면에서 그래프와 함께 봐요.</p>
        </>
      ),
    },
  ];

  if (howTo === 'push') return <NotificationGuide onBack={() => setHowTo('')} backLabel="안내로 돌아가기" />;
  if (howTo === 'sheet') return <SheetGuide role={role} onBack={() => setHowTo('')} backLabel="안내로 돌아가기" onConnect={onConnectSheet} connectLabel={member ? '지금 연결하기' : '회원 고르러 가기'} />;
  const page = pages[at];
  const last = at === pages.length - 1;
  return (
    <div className="start-guide" data-testid="start-guide">
      {page.icon === 'app' ? (
        <img className="start-guide-app-icon" src={APP_ICON} alt="" width={64} height={64} />
      ) : (
        <div className="start-guide-icon" aria-hidden="true">
          <Icon name={page.icon} />
        </div>
      )}
      <h3>{page.title}</h3>
      <div className="start-guide-body">{page.body}</div>
      {/* 다시 보는 곳: 첫 쪽에서 건너뛰거나 ×로 닫는 사람도 보게 첫 쪽과 마지막 쪽에(2026-11-02 사용자 지적) */}
      {(at === 0 || last) && <p className="tiny start-guide-again">나중에 다시 보려면 화면 맨 위의 사용 안내(?) 버튼을 눌러 주세요.</p>}
      <div className="start-guide-dots" aria-label={`${pages.length}쪽 중 ${at + 1}쪽`}>
        {pages.map((p, i) => (
          <span key={p.key} className={i === at ? 'on' : ''} />
        ))}
      </div>
      <div className="start-guide-nav">
        {at > 0 ? (
          <button type="button" className="secondary" onClick={() => setAt(at - 1)}>
            이전
          </button>
        ) : (
          <button type="button" className="text-button" onClick={onDone}>
            건너뛰기
          </button>
        )}
        <button type="button" className="primary" onClick={() => (last ? onDone() : setAt(at + 1))}>
          {last ? '시작하기' : '다음'}
        </button>
      </div>
    </div>
  );
}
