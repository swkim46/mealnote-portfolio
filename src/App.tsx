import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { signOut } from './lib/auth';
import { syncRemembered } from './lib/remember';
import { wasMyNickname } from './lib/pin';
import { AuthScreen } from './auth/AuthScreen';
import { MemberApp } from './member/MemberApp';
import { TrainerApp } from './trainer/TrainerApp';
import { AdminApp } from './admin/AdminApp';
import { SecurityNotices } from './components/SecurityNotices';
import { Loading } from './components/Bits';
import type { Profile } from './lib/types';
import { PROFILE_CHANGED } from './components/PinForms';

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState(false);
  const userId = session?.user.id;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // 닉네임을 바꾸면 프로필만 다시 불러온다(화면은 그대로 두고 이름만 바뀐다)
  const [profileVersion, setProfileVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setProfileVersion((v) => v + 1);
    window.addEventListener(PROFILE_CHANGED, onChanged);
    return () => window.removeEventListener(PROFILE_CHANGED, onChanged);
  }, []);

  useEffect(() => {
    setProfile(null);
    setProfileError(false);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('id, nickname, role')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setProfileError(true);
        else if (!data) void signOut(); // 계정이 지워졌으면 처음 화면으로
        else {
          setProfile(data as Profile);
          // 기억한 닉네임을 지금 프로필에 맞춘다: 가입 때 정한 표기(로그인은 대소문자를 안 가림), 다른 기기에서 바꾼 새 닉네임
          const p = data as Profile;
          if (p.role !== 'admin') void syncRemembered({ id: p.id, nickname: p.nickname, role: p.role }, wasMyNickname);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, profileVersion]);

  if (session === undefined) return <Splash />;
  if (!session) return <AuthScreen />;
  if (profileError)
    return (
      <Splash>
        <p className="hint">계정 정보를 불러오지 못했어요.</p>
        <button className="secondary" onClick={() => location.reload()}>
          다시 시도
        </button>
      </Splash>
    );
  if (!profile) return <Splash />;
  const app =
    profile.role === 'admin' ? (
      <AdminApp key={profile.id} profile={profile} />
    ) : profile.role === 'trainer' ? (
      <TrainerApp key={profile.id} profile={profile} />
    ) : (
      <MemberApp key={profile.id} profile={profile} />
    );
  return (
    <>
      {app}
      <SecurityNotices key={`sec-${profile.id}`} profile={profile} />
    </>
  );
}

function Splash({ children }: { children?: React.ReactNode }) {
  return (
    <div className="workspace">
      <section className="prototype splash">{children ?? <Loading />}</section>
    </div>
  );
}
