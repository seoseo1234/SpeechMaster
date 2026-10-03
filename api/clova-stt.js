// 저학년: CLOVA Speech 발음 평가 프록시. 시크릿 키는 서버에서만 사용한다.
import { handler, readRawBody, getQuery, sendJson, HttpError } from './_lib.js';

export default handler(async (req, res) => {
  const invokeUrl = process.env.CLOVA_SHORT_INVOKE_URL;
  const secretKey = process.env.CLOVA_SHORT_SECRET_KEY;
  if (!invokeUrl || !secretKey) throw new HttpError(500, 'CLOVA 환경변수가 설정되지 않았습니다.');

  const audio = await readRawBody(req);
  if (!audio.length) throw new HttpError(400, '녹음된 오디오가 없습니다.');

  const utterance = (getQuery(req).get('utterance') || '').slice(0, 200);
  let url;
  let options;

  if (invokeUrl.endsWith('/stt')) {
    // 단문 인식 API (/recog/v1/stt): 쿼리 파라미터 + octet-stream
    const params = new URLSearchParams({ lang: 'Kor', assessment: 'true', graph: 'true', utterance });
    url = `${invokeUrl}?${params}`;
    options = {
      method: 'POST',
      headers: { 'X-CLOVASPEECH-API-KEY': secretKey, 'Content-Type': 'application/octet-stream' },
      body: audio,
    };
  } else {
    // 일반 업로드 API: multipart/form-data
    const formData = new FormData();
    formData.append('media', new Blob([audio], { type: 'audio/webm' }), 'record.webm');
    formData.append('params', JSON.stringify({
      language: 'ko-KR',
      completion: 'sync',
      assessment: true,
      graph: true,
      utterance,
    }));
    url = invokeUrl.endsWith('/upload') ? invokeUrl : `${invokeUrl}/recognizer/upload`;
    options = { method: 'POST', headers: { 'X-CLOVASPEECH-API-KEY': secretKey }, body: formData };
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, data.message || `CLOVA API 오류 (${response.status})`);

  sendJson(res, 200, {
    assessment_score: data.assessment_score,
    text: data.text,
    assessment_details: data.assessment_details,
    usr_graph: data.usr_graph || [],
  });
});
