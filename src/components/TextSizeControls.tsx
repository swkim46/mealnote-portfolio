import { useTextSize } from '../lib/textSize';

/** 머리글 오른쪽 위(로그인 전후): 누르면 큰 글씨 켜고 끄기. 제목과 같은 줄에 들어가도록 '가' 한 글자 */
export function TextSizeToggle() {
  const { size, change } = useTextSize();
  const large = size === 'large';
  return (
    <button
      className="text-size-toggle"
      aria-pressed={large}
      aria-label={large ? '큰 글씨 끄기' : '큰 글씨로 보기'}
      title={large ? '큰 글씨 끄기' : '큰 글씨로 보기'}
      onClick={() => change(large ? 'normal' : 'large')}
    >
      <b>가</b>
    </button>
  );
}

/** 내 정보 화면: 글씨 크기 보통 / 크게 */
export function TextSizeSetting() {
  const { size, change } = useTextSize();
  return (
    <div className="text-size-row">
      <span>글씨 크기</span>
      <div className="role-switch" role="group" aria-label="글씨 크기">
        <button aria-pressed={size === 'normal'} onClick={() => change('normal')}>
          보통
        </button>
        <button aria-pressed={size === 'large'} onClick={() => change('large')}>
          <span>가</span>크게
        </button>
      </div>
    </div>
  );
}
