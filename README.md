# FITORY — 트레이너의 계획과 회원의 기록을 연결하는 운동·식단 앱

**FITORY는 제가 다니는 PT센터에서 트레이너와 회원들이 함께 사용하는 앱입니다.** 회원의 식단·운동 기록과 체성분 변화를 모으고, 트레이너가 같은 기록을 보며 피드백할 수 있도록 만들었습니다. 식단 사진과 답변을 주고받던 ‘식단노트’에서 시작해 운동 계획과 실제 수행을 함께 다루는 서비스로 확장했습니다.

개인 카카오톡으로 식단 사진을 보내는 것이 부담스러워 기록을 잘 남기지 못했던 경험이 출발점입니다. 트레이너도 비슷한 회원이 많다며 전용 앱을 제안했습니다. 저는 필요한 기능부터 추려 직접 기획하고, Claude Code에 구현을, Codex에 검토를 맡겼습니다. 회원과 트레이너 화면을 직접 써 보며 사용 흐름과 제품 규칙을 정하고 개선합니다.

## 현재 제품이 연결하는 일

| 사용자 | 앱에서 하는 일 | 연결되는 다음 작업 |
|---|---|---|
| 회원 | 식단과 질문을 남기고 피드백을 확인합니다. | 트레이너가 확인할 식사와 답변할 메시지를 구분해 봅니다. |
| 트레이너 | 익숙한 Google Sheets에서 운동 루틴을 작성합니다. | 회원은 앱에서 계획을 보고 실제 중량·횟수·완료 여부를 기록합니다. |
| 회원·트레이너 | 운동별 과거 기록과 메모를 확인합니다. | 다음 운동에서 이전 수행과 설명을 참고합니다. |
| 회원·트레이너 | 같은 기간의 식단·운동·체성분 변화를 봅니다. | 트레이너가 기록을 종합해 총평을 남깁니다. |

제품의 중심은 기록을 많이 받는 데 있지 않습니다. **회원이 남긴 내용이 트레이너의 확인과 피드백으로 이어지고, 그 결과를 다음 운동과 식단 관리에서 다시 볼 수 있도록** 흐름을 연결했습니다.

## 1. 기존 시트 작성 방식을 유지하면서 앱과 연결했습니다

트레이너는 Google Sheets에 운동 루틴을 작성하고 있었습니다. 저는 이 작성 방식을 유지하면서 회원이 운동 계획과 식단을 앱에서 함께 볼 수 있게 하려 했습니다.

시트의 일차별 운동·세트·횟수·중량·휴식 정보를 가져와 루틴으로 구성합니다. 회원이 실제로 한 운동은 별도로 기록하고, 앱 기록은 시트에도 반영합니다. 루틴을 받았다는 사실과 그 운동을 수행했다는 사실을 구분한 것입니다.

양쪽에서 기록을 고칠 수 있어 값을 복사하는 것만으로는 충분하지 않았습니다. 시트의 기존 값, 앱이 작성한 칸, 수정 중인 값을 구분하고, 앱에서 지운 기록이 다시 가져오기로 되살아나는 경우도 다뤘습니다. [시트·계획·실제 기록을 연결한 설계](docs/08_운동과_식단을_연결하는_설계.md)

## 2. 식사 확인과 메시지 답변을 나눴습니다

트레이너가 식사를 확인하는 것과 질문에 답하는 것은 다른 일입니다. 처음에는 식사에 함께 남긴 질문이 작게 표시돼 놓치기 쉬웠고, 반대로 “감사합니다”라는 댓글까지 답변 대기에 남았습니다.

저는 질문을 대화 맨 위에서 보여주고, 답변할 식사를 목록 상단에 두게 했습니다. 답변이 필요 없는 메시지는 ‘답변 없이 확인’으로 정리합니다. 이후 회원이 새 댓글을 남기면 다시 답변 대기에 표시됩니다.

확인 목록과 알림도 같은 처리 규칙을 쓰도록 했습니다. 트레이너는 처리한 일을 다시 확인하지 않고, 새 질문에 집중할 수 있습니다. [확인과 답변을 구분한 과정](docs/02_트레이너_업무_흐름과_처리_규칙.md)

## 3. 같은 기간의 기록으로 변화를 돌아보게 했습니다

운동 계획은 시트에, 식단은 앱에, 체성분은 인바디 기록에 흩어져 있으면 몸의 변화를 돌아볼 때 다시 모아야 합니다. 현재 변화 보고서에서는 같은 기간의 식단 평가 흐름, 운동 변화, 체성분을 함께 보여주고 트레이너가 총평을 남깁니다.

계획한 운동과 실제 수행, 기록이 없는 것과 변화가 없는 것을 구분합니다. 식단 평가는 트레이너가 평가한 기록을 기준으로 집계하고, 측정값이 없는 항목은 비교할 수 없다고 표시합니다. 기록으로 확인할 수 있는 내용과 트레이너의 해석을 나누어 다음 목표를 논의할 자료로 구성했습니다.

운동 중에도 이전 기록을 참고할 수 있도록 운동별 검색과 메모를 제공합니다. 회원의 메모와 트레이너의 설명은 나누고, 같은 운동이면 루틴이 바뀌어도 이어 볼 수 있게 했습니다. [기록을 비교하는 기준과 사용 흐름](docs/08_운동과_식단을_연결하는_설계.md)

## 4. 사용 편의와 기록 보호를 함께 다룹니다

연락처 없이 닉네임과 PIN으로 가입하게 했지만, 트레이너가 회원의 PIN을 대신 정하는 방식에는 계정 접근 위험이 있었습니다. Codex의 지적을 검토한 뒤, 저는 복구 질문과 기존 로그인 기기를 활용해 회원이 직접 계정을 되찾는 절차를 기획했습니다. [계정 복구 설계](docs/03_가입과_계정_보안.md)

기록을 보호하는 방식도 조작을 늘리는 쪽으로만 풀지 않았습니다. 운동 메모의 저장이 실패했을 때 별도 보관 카드에서 복원하게 하던 안은 조작이 과하다고 판단했습니다. 기존 메모 입력란으로 돌아가 이어 쓸 수 있도록 흐름을 단순화하고, 다른 기기에서 바뀐 내용이 있을 때만 충돌을 안내하게 했습니다. [사용 중인 기록을 지키는 설계](docs/09_사용중인_기록과_업무흐름.md)

## 실제 사용 현황

<!-- usage-metrics:start -->
<picture>
  <source media="(max-width: 600px)" srcset="docs/images/usage-mobile.svg">
  <img src="docs/images/usage.svg" alt="식단노트 사용 추이. 11월 10일 기준 가입 회원 46명, 당일 활성 회원 14명, 누적 식단 기록 622건" width="1100">
</picture>

2026년 11월 10일까지의 기록입니다. 활성 회원은 그날 식단을 한 번 이상 작성한 회원이며, 가입 회원과 식단 기록은 누적입니다. 테스트 계정은 제외하고, 매일 전날까지 갱신합니다. [집계 기준](docs/reference/사용_현황_집계.md)
<!-- usage-metrics:end -->

## 제가 맡은 일과 개발 방식

| 담당 | 역할 |
|---|---|
| 저 | 사용자 문제와 제품 범위 정의, 흐름·문구·평가 기준 결정, 제안의 채택·수정, 사용 점검과 운영 |
| Claude Code | 기능 구현, 검증, 제품 반영, 변경 기록 |
| Codex | 계획·코드 검토, 문제 재현, 대안 제안 |

처음부터 큰 앱을 만드는 대신 식단 기록과 피드백부터 시작했습니다. 실제 사용하면서 운동 기록·시트 연동·변화 보고서로 범위를 넓혔습니다. 검토에서 나온 기술적 해결책도 그대로 채택하기보다, 회원과 트레이너가 어떤 조작을 하게 되는지 확인하며 수정합니다.

## 설계와 구현 살펴보기

| 관심 있는 내용 | 자료 |
|---|---|
| 처음 해결할 문제와 제품 범위를 정한 과정 | [범위 결정](docs/01_문제와_범위_결정.md) |
| 실무를 상태와 알림으로 바꾼 기준 | [확인·답변 규칙](docs/02_트레이너_업무_흐름과_처리_규칙.md) · [알림](docs/04_알림_설계.md) |
| 기존 도구와 실제 수행을 연결한 구조 | [운동·식단·시트 설계](docs/08_운동과_식단을_연결하는_설계.md) |
| 기록을 지키면서 사용 흐름을 단순화한 과정 | [기록 보호와 업무 흐름](docs/09_사용중인_기록과_업무흐름.md) |
| 계정 권한과 복구 | [가입과 계정 보안](docs/03_가입과_계정_보안.md) |
| 기획이 구현된 부분 | [주요 코드 발췌](docs/reference/현재_제품_구현근거.md) |
| 다음에 발전시킬 내용 | [다음 설계 과제](docs/07_앞으로의_계획.md) |

<details>
<summary>Summary in English</summary>

FITORY connects meal logging, workout plans, actual training records and body-composition changes at the personal-training studio I attend. It began as Mealnote, a dedicated way for members to share meals and receive feedback without sending photos through personal messaging.

I define the product scope and workflows, choose which proposals to adopt, and test both member and trainer experiences. Claude Code implements the app; Codex reviews plans and code.

The app preserves the trainer’s Google Sheets workflow while connecting plans to members’ actual workout records. I separated meal review from message replies, planned member-controlled account recovery, and brought diet, exercise and body-composition records into a common reporting period.

<!-- usage-metrics-en:start -->
Through November 10, 2026 (KST), the app had 46 registered members and 622 meal records. On that day, 14 members logged at least one meal. Test accounts are excluded; the charts update daily after the Korean day ends.
<!-- usage-metrics-en:end -->

</details>
