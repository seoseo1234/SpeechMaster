// 텍스트 기반 Gemini 작업. 프롬프트는 서버에서 조립해 임의 프롬프트 호출을 막는다.
import { handler, readJsonBody, callGemini, sendJson, HttpError } from './_lib.js';
import { SCORE_LABELS } from '../scoring.js';

const clip = (value, max) => String(value ?? '').slice(0, max);
const toNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const tasks = {
  // 저학년: 낭독 지문 생성
  sentence: () =>
    '초등학교 저학년(1~3학년) 국어 교과서 수준의 동화책 지문이나 교육적인 문장 1개를 만들어줘. 발음 연습하기 좋게 길이는 20자 내외로 짧게 해줘. 부가 설명 없이 문장만 딱 출력해.',

  // 저학년: 어려운 단어와 유사한 연습 단어 추천
  words: ({ word }) => {
    const w = clip(word, 20).trim();
    if (!w) throw new HttpError(400, '단어가 필요합니다.');
    return `초등학교 저학년 학생이 '${w}'라는 단어를 발음하기 어려워해. 이 단어와 발음 원리나 구조(예: 겹받침, 연음 등)가 유사해서 발음 연습하기 좋은 '두 글자 이상'의 단어 3개를 쉼표로 구분해서 말해줘. (예: 한 글자 단어는 절대 안 됨). 부가 설명 없이 딱 단어 3개만 출력해.`;
  },

  // 교사: 나이스 관찰평가 문구 생성
  neis: ({ name, accuracy, weaknesses, radar }) => {
    const r = Array.isArray(radar) ? radar.slice(0, SCORE_LABELS.length).map(toNum) : [];
    while (r.length < SCORE_LABELS.length) r.push(0);
    const radarText = SCORE_LABELS.map((label, i) => `${label}(${r[i]})`).join(', ');
    const w = Array.isArray(weaknesses) && weaknesses.length
      ? weaknesses.slice(0, 10).map(x => clip(x, 100)).join(', ')
      : '데이터 부족';
    return '당신은 초등학교 교사입니다. 학생의 발표 기록 데이터를 바탕으로 나이스(NEIS) 학교생활기록부 교과세특 또는 행동특성 및 종합의견에 들어갈 만한 "서술형 관찰평가 피드백 문구"를 작성해주세요.\n\n' +
      '[학생 데이터]\n' +
      `- 이름: ${clip(name, 30) || '학생'}\n` +
      `- 평균 정확도: ${toNum(accuracy)}%\n` +
      `- 주요 취약점: ${w}\n` +
      `- 역량 점수(100점 만점, 0은 미측정): ${radarText}\n\n` +
      '[작성 지침]\n' +
      '1. 공손하고 전문적인 교사의 어투(평어체, ~함, ~임)로 작성해주세요.\n' +
      '2. 장점(역량 점수가 높은 부분)을 먼저 칭찬하고, 단점(취약점)은 보완 방향성을 제시하는 긍정적인 방향으로 작성해주세요.\n' +
      '3. 길이는 2~3문장, 150자 내외로 매우 간결하게 작성해주세요.\n' +
      '4. 오직 작성된 생기부 문구 텍스트만 출력하세요. json 포맷을 쓰지 마세요.';
  },
};

export default handler(async (req, res) => {
  const body = await readJsonBody(req);
  const build = tasks[body.task];
  if (!build) throw new HttpError(400, '알 수 없는 작업입니다.');

  const text = await callGemini([{ text: build(body) }]);
  sendJson(res, 200, { text });
});
