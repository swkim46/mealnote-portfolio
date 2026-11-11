// 그림 안내(알림 설정·운동 시트 연결) 문구 도우미: 문구의 <b>…</b>만 굵은 글씨로 바꾼다(HTML로 넣지 않음)
import type { ReactNode } from 'react';

export function rich(text: string): ReactNode[] {
  return text.split(/(<b>.*?<\/b>)/g).map((part, i) => (part.startsWith('<b>') ? <strong key={i}>{part.slice(3, -4)}</strong> : part));
}

/** 그림 대체 글(alt)용: 강조 표시를 뺀 문구 */
export const plain = (text: string) => text.replace(/<\/?b>/g, '');
