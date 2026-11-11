// 운동 시트 연결 그림 안내(2026-11-01 사용자 요청: 홈 화면 추가 안내처럼 그림으로). 공유 순서와 메뉴 이름은 구글 공식 도움말 기준
// (support.google.com/docs/answer/9331169 · drive/answer/2494822, 2026-11-01 확인): 공유 → 이메일 입력 → 편집자(v2.1, 2.0은 뷰어) → 보내기, 링크 복사.
// 이미지는 public/guides/sheet/(구글 시트 화면은 단순화한 예시, 앱 화면은 실제 2.0 화면). 원본·다시 만들기는 Codex의 design/sheet-guide-v2/build-guide.mjs
// 문구의 <b>…</b>는 강조만 뜻한다(NotificationGuide와 같은 방식으로 굵은 글씨로만 바꾼다).
import type { GuideStep } from './notificationGuide';

export type SheetGuideRole = 'member' | 'trainer';

// 2.1 경로(Codex 3차 리뷰의 안내 점검, 2026-11-03): 시트 연결 줄은 운동 화면의 '루틴' 안에 있다 — 회원 '운동 → 루틴', 트레이너 '회원 → 회원 고르기 → 루틴'
const PASTE: Record<SheetGuideRole, GuideStep> = {
  member: {
    title: '앱에 링크 붙여 넣기',
    text: '앱의 <b>운동</b> → <b>루틴</b> → <b>운동 시트 연결</b>에서 링크를 붙여 넣고 <b>시트 연결하기</b>를 누르세요.',
    sub: '연결은 회원이 해도 되고 트레이너가 해도 돼요.',
  },
  trainer: {
    title: '앱에 링크 붙여 넣기',
    text: '<b>회원</b> → 회원 고르기 → <b>루틴</b> → <b>운동 시트 연결</b>에서 링크를 붙여 넣고 <b>시트 연결하기</b>를 누르세요.',
    sub: '회원이 직접 연결해도 돼요.\n시트 하나는 회원 한 명에게만 연결할 수 있어요.',
  },
};

/** 이메일 복사 뒤의 단계(1단계 이메일 복사는 복사 버튼이 있어 SheetGuide가 그린다). 공유 창은 이메일을 받으므로 '주소' 대신 '이메일'로 부른다(사용자 11-06). 줄바꿈은 내용을 가른다 */
export const sheetGuideSteps = (role: SheetGuideRole): GuideStep[] => [
  {
    title: '구글 시트에서 공유 누르기',
    text: '운동 시트를 열고 오른쪽 위 <b>공유</b>를 누르세요.',
    sub: '시트를 고칠 수 있는 사람이 해요. 보통 트레이너예요.\n휴대폰 앱에서는 더보기(⋮) 메뉴 안에 있을 수 있어요.',
  },
  {
    title: '복사한 이메일을 편집자로 추가',
    text: '공유 창의 이메일 칸에 복사한 이메일을 붙여 넣으세요.\n<b>편집자</b>를 고르고 <b>보내기</b>를 누르세요.',
    sub: '‘사용자에게 알림’은 켜든 끄든 괜찮아요.',
  },
  {
    title: '시트 링크 복사',
    text: '공유 창의 <b>링크 복사</b>를 누르세요.',
    sub: '컴퓨터라면 주소창의 주소를 복사해도 돼요.\n‘일반 액세스’는 바꾸지 않아도 돼요.',
  },
  PASTE[role],
  role === 'member'
    ? {
        title: '루틴이 들어왔는지 확인',
        text: '<b>운동</b> → <b>루틴</b>에 그 달 탭(예: <b>2611</b>)의 루틴이 들어오면 끝이에요.',
        sub: '시트를 고치면 운동 탭을 열 때 자동으로 다시 읽어요.',
      }
    : {
        title: '루틴이 들어왔는지 확인',
        text: '회원 화면의 <b>루틴</b>에 그 달 탭(예: <b>2611</b>)의 루틴이 들어오면 끝이에요.',
        sub: '시트를 고치면 회원 화면의 루틴을 열 때 자동으로 다시 읽어요.',
      },
];

/** 단계 그림(이메일 복사 뒤의 차례): 4번째 그림(앱에 붙여 넣기)만 회원·트레이너 화면이 다르다 */
export const sheetGuideImage = (role: SheetGuideRole, step: number) => `/guides/sheet/sheet-${String(step).padStart(2, '0')}${step === 4 ? `-${role}` : ''}.png`;
