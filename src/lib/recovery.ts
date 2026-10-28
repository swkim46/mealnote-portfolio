// 복구 질문(2026-10-21 사용자 결정). 번호는 DB에 저장되므로 순서를 바꾸지 말고 뒤에만 추가한다(DB는 1~6만 허용).
// 개인정보 느낌이 없고, 트레이너가 식단·대화로 알 수 없으며, 답이 여러 가지인 취향 질문만 둔다.
export const RECOVERY_QUESTIONS: Record<number, string> = {
  1: '가장 좋아하는 영화 제목은?',
  2: '가장 좋아하는 노래 제목은?',
  3: '가장 좋아하는 가수나 배우는?',
  4: '가장 기억에 남는 여행지는?',
  5: '어렸을 때 장래 희망은?',
  6: '가장 좋아하는 책이나 만화 제목은?',
};

export const RECOVERY_WARNING = '답을 잊으면 PIN을 되찾을 수 없어요. 꼭 기억할 수 있는 답으로 정해 주세요.';

/** 답 비교는 서버가 띄어쓰기·대소문자를 무시해서 한다. 여기서는 최소 길이만 본다. */
export const answerProblem = (answer: string) =>
  answer.normalize('NFC').replace(/\s+/g, '').length < 2 ? '답을 두 글자 이상 적어 주세요.' : null;
