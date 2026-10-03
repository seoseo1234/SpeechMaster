// 서버 전용 공통 유틸 (파일명이 _로 시작하므로 Vercel 라우트로 노출되지 않음)
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function getQuery(req) {
  return new URL(req.originalUrl || req.url, 'http://localhost').searchParams;
}

// Firebase ID 토큰 검증 → { uid, anonymous }
export async function verifyUser(req) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(500, 'FIREBASE_PROJECT_ID가 설정되지 않았습니다.');

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, '로그인이 필요합니다.');

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    return { uid: payload.sub, anonymous: payload.firebase?.sign_in_provider === 'anonymous' };
  } catch (e) {
    throw new HttpError(401, '인증 토큰이 유효하지 않습니다.');
  }
}

export async function readRawBody(req, maxBytes = 4 * 1024 * 1024) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, '업로드 용량이 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req, 100 * 1024);
  try {
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, '잘못된 JSON 요청입니다.');
  }
}

// Gemini REST 호출 → 응답 텍스트
export async function callGemini(parts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, 'GEMINI_API_KEY가 설정되지 않았습니다.');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  if (!response.ok) throw new HttpError(502, `Gemini API 오류 (${response.status})`);

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new HttpError(502, 'Gemini 응답이 비어 있습니다.');
  return text;
}

export function parseJsonText(text) {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new HttpError(502, 'AI 응답 형식을 해석하지 못했습니다.');
  }
}

// 요청 처리 래퍼: 메서드 확인 + 인증 + 에러 응답
export function handler(fn) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'POST만 허용됩니다.');
      const user = await verifyUser(req);
      await fn(req, res, user);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message || '서버 오류가 발생했습니다.' });
    }
  };
}
