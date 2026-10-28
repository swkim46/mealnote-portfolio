// 푸시 알림 보내기(v1.7). pg_cron이 10분마다, 알림 켜기 직후 시험 알림 때 DB(push_kick)가 부른다.
// 할 일: push_claim(알림 만들기 + 보낼 전송 선점·재확인) → 기기마다 웹 푸시 → push_report(결과 기록).
// 호출 확인은 공유 비밀 머리글로 한다(config.toml에서 verify_jwt = false). endpoint·키는 로그에 남기지 않는다.
import * as webpush from 'jsr:@negrel/webpush@0.3.0';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { quoteFor } from '../_shared/quotes.ts';

const SECRET = Deno.env.get('PUSH_CRON_SECRET') ?? '';
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'https://mealnote.example';

// 웹 푸시 요청은 등록 때 확인한 알림 서버 주소로만: 다른 주소로 넘기라는 응답(3xx)을 따라가지 않고 실패로 본다. 15초 제한.
// (라이브러리가 전역 fetch를 쓰므로 여기서 바꾼다. DB 호출은 원래 fetch를 쓴다)
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(input, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(15_000) });

const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let appServer: webpush.ApplicationServer | null = null;
async function server() {
  if (appServer) return appServer;
  const pub = fromB64u(VAPID_PUBLIC);
  const x = toB64u(pub.slice(1, 33)), y = toB64u(pub.slice(33, 65));
  const vapidKeys = await webpush.importVapidKeys({
    publicKey: { kty: 'EC', crv: 'P-256', x, y, ext: true },
    privateKey: { kty: 'EC', crv: 'P-256', x, y, d: VAPID_PRIVATE, ext: true },
  });
  appServer = await webpush.ApplicationServer.new({ contactInformation: SUBJECT, vapidKeys });
  return appServer;
}

interface Job {
  nid: string;
  sid: string;
  endpoint_url: string;
  key_p256dh: string;
  key_auth: string;
  payload: { ttl?: number; tag?: string } & Record<string, unknown>;
}

async function send(job: Job) {
  const base = { notification_id: job.nid, subscription_id: job.sid };
  try {
    const sub = (await server()).subscribe({ endpoint: job.endpoint_url, keys: { p256dh: job.key_p256dh, auth: job.key_auth } });
    const { ttl = 3600, quote_day, ...data } = job.payload;
    // 아침 응원: DB가 날짜만 넘기면 앱과 같은 목록·같은 규칙으로 그날의 기본 문구를 채운다
    if (typeof quote_day === 'string') data.body = quoteFor(quote_day);
    // Topic 머리글은 32자 이하 URL 안전 문자만(같은 Topic의 대기 메시지는 알림 서버에서 새 것으로 바뀐다). 피드백처럼 알림마다 tag가 다르면 넣지 않는다
    const topic = typeof data.tag === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(data.tag) && !data.tag.startsWith('feedback-') ? data.tag : undefined;
    await sub.pushTextMessage(JSON.stringify(data), { ttl, urgency: webpush.Urgency.Normal, topic });
    return { ...base, outcome: 'accepted' };
  } catch (e) {
    const res = (e as { response?: Response }).response;
    if (!res) return { ...base, outcome: 'retry', code: 0 }; // 네트워크 오류·시간 초과
    const code = res.status;
    if (code === 404 || code === 410) return { ...base, outcome: 'gone', code };
    if (code === 429) return { ...base, outcome: 'retry', code, retry_after: Number(res.headers.get('retry-after')) || 0 };
    if (code >= 500) return { ...base, outcome: 'retry', code };
    return { ...base, outcome: 'fail', code }; // 400·403 등: 키·요청 문제라 다시 보내도 같다
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' || !sameSecret(req.headers.get('x-push-secret') ?? '', SECRET)) return new Response('forbidden', { status: 403 });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return Response.json({ error: 'vapid_missing' }, { status: 500 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
    global: { fetch: realFetch },
  });
  const summary = { accepted: 0, gone: 0, retry: 0, fail: 0 };
  for (let round = 0; round < 4; round++) {
    const { data, error } = await db.rpc('push_claim', { p_limit: 50 });
    if (error) return Response.json({ error: 'claim_failed' }, { status: 500 });
    const jobs = (data ?? []) as Job[];
    if (!jobs.length) break;
    const results = await Promise.all(jobs.map(send));
    for (const r of results) summary[r.outcome as keyof typeof summary]++;
    const rep = await db.rpc('push_report', { p_results: results });
    if (rep.error) return Response.json({ error: 'report_failed' }, { status: 500 });
  }
  return Response.json(summary);
});
