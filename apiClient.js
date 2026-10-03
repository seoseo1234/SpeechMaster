// 서버 API(/api/*) 호출 헬퍼. Firebase ID 토큰을 붙이며, 로그인 전(둘러보기 모드)이면 익명 로그인한다.
import { auth } from './firebase.js';
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';

const authReady = new Promise(resolve => {
  const unsubscribe = onAuthStateChanged(auth, user => {
    unsubscribe();
    resolve(user);
  });
});

async function getIdToken() {
  await authReady;
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser.getIdToken();
}

async function request(path, init = {}) {
  const token = await getIdToken();
  const response = await fetch(path, {
    ...init,
    method: 'POST',
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data;
}

export async function askGemini(task, payload = {}) {
  const data = await request('/api/gemini', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, ...payload }),
  });
  return data.text;
}

export function assessPronunciation(audioBlob, utterance) {
  const params = new URLSearchParams({ utterance });
  return request(`/api/clova-stt?${params}`, {
    headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
    body: audioBlob,
  });
}

export function analyzePresentation(audioBlob, metrics) {
  const params = new URLSearchParams(metrics);
  return request(`/api/analyze-presentation?${params}`, {
    headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
    body: audioBlob,
  });
}
