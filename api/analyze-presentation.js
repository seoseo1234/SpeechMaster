// 고학년: 발표 녹음(오디오 원본 바디) + 트래킹 수치(쿼리) → 습관어 횟수 및 종합 피드백
import { handler, readRawBody, getQuery, callGemini, parseJsonText, sendJson, HttpError } from './_lib.js';

const toNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : '정보 없음';
};
const clip = (value) => String(value || '정보 없음').slice(0, 100);
const toCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

export default handler(async (req, res) => {
  const audio = await readRawBody(req);
  if (!audio.length) throw new HttpError(400, '녹음된 오디오가 없습니다.');

  const q = getQuery(req);
  const mimeType = (req.headers['content-type'] || 'audio/webm').split(';')[0];

  const prompt = '첨부된 오디오 파일은 학생의 발표 녹음입니다.\n' +
    '다음은 발표 중에 수집된 실시간 트래킹 데이터입니다:\n' +
    `- 평균 목소리 톤 (0~255 수치): ${toNum(q.get('avgTone'))}\n` +
    `- 평균 말하기 속도 (어절/분, 0은 미측정): ${toNum(q.get('avgSpeed'))}\n` +
    `- 자세 안정성 점수 (0~100, 몸통 흔들림·어깨 기울기 기준): ${toNum(q.get('postureScore'))}\n` +
    `- 손 제스처: ${clip(q.get('gestureNote'))}\n` +
    `- 정면 주시(시선 처리) 비율 (%): ${toNum(q.get('gazeScore'))}\n\n` +
    "학생이 발표 중 '어...', '음...', '그...' 와 같은 무의미한 습관어를 얼마나 사용했는지 오디오에서 찾아내주세요. 아주 짧은 찰나의 '어'나 '음'도 모두 카운트해야 합니다.\n\n" +
    '결과는 반드시 다음 JSON 포맷으로만 출력해주세요:\n' +
    '{\n' +
    '  "habitCounts": {\n' +
    '    "uh": (어, 아 사용 횟수 정수형),\n' +
    '    "um": (음, 음마 사용 횟수 정수형),\n' +
    '    "geu": (그, 어그 사용 횟수 정수형)\n' +
    '  },\n' +
    '  "feedback": "(트래킹 데이터와 발표 내용, 습관어 사용을 모두 종합하여 목소리의 크기/톤, 속도, 발표자세, 손 제스처, 시선처리 등에 대한 매우 구체적이고 종합적인 피드백 코멘트를 3~4문장으로 작성해주세요. 수집된 데이터를 직접 언급하며 분석적인 조언을 제공해야 합니다.)"\n' +
    '}';

  const text = await callGemini([
    { text: prompt },
    { inlineData: { mimeType, data: audio.toString('base64') } },
  ]);
  const result = parseJsonText(text);
  const counts = result.habitCounts || {};

  sendJson(res, 200, {
    habitCounts: { uh: toCount(counts.uh), um: toCount(counts.um), geu: toCount(counts.geu) },
    feedback: String(result.feedback || ''),
  });
});
