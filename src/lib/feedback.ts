// 익명 의견 보내기. 작성자(닉네임·계정 id)는 보내지도 저장하지도 않는다.
import { supabase } from './supabase';
import { VERSION_LABEL } from './releases';

export type FeedbackCategory = 'bug' | 'idea' | 'other';
export type FeedbackStatus = 'new' | 'read' | 'done';

export const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: '불편한 점·오류',
  idea: '이런 기능이 있으면 좋겠어요',
  other: '기타 의견',
};

export interface AppFeedback {
  id: string;
  category: FeedbackCategory;
  body: string;
  screen: string;
  device: string;
  app_version: string;
  status: FeedbackStatus;
  created_at: string;
}

/** 기기 종류만 거칠게: iPhone·Android 같은 수준. 모델·버전은 보내지 않는다. */
export function deviceSummary(): string {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : '기타 기기';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
  return `${kind} · ${standalone ? '홈 화면 앱' : '브라우저'}`;
}

export async function sendFeedback(category: FeedbackCategory, body: string, screen: string) {
  // 의견을 보낸 사람은 목록을 읽을 수 없으므로 insert 결과를 돌려받지 않는다.
  const { error } = await supabase.from('app_feedback').insert({
    category,
    body,
    screen,
    device: deviceSummary(),
    app_version: `${VERSION_LABEL} (${__APP_BUILD__})`.slice(0, 40),
  });
  if (error) throw error;
}

export async function listFeedback(): Promise<AppFeedback[]> {
  const { data, error } = await supabase.from('app_feedback').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  return (data ?? []) as AppFeedback[];
}

export async function setFeedbackStatus(id: string, status: FeedbackStatus) {
  const { error } = await supabase.from('app_feedback').update({ status }).eq('id', id);
  if (error) throw error;
}
