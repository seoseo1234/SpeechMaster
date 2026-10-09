// 5대 역량 점수 산식 (저학년/고학년/교사 화면 공통)
// 기준값은 초등 발표 지도용 경험치이며, 필요하면 아래 상수만 조정하면 된다.

export const SCORE_KEYS = ['pronunciation', 'speed', 'volume', 'gaze', 'posture', 'gesture'];
export const SCORE_LABELS = ['발음정밀도', '말하기 속도(적절성)', '성량 크기', '시선 처리', '자세 안정성', '제스처 활용'];

const IDEAL_WPM = [80, 130];   // 적절한 말하기 속도 (어절/분)
const IDEAL_VOLUME = [15, 40]; // 적절한 성량 (화면 표시 0~100 기준)
const IDEAL_GESTURE = [0.15, 0.6]; // 손이 보이는 동안 제스처를 쓰는 시간 비율

const clamp = (n) => Math.round(Math.min(100, Math.max(0, n)));

// 말하기 속도: 적정 범위면 100점, 벗어난 만큼 감점
export function speedScore(wpm) {
  if (!wpm) return 0;
  const [lo, hi] = IDEAL_WPM;
  if (wpm < lo) return clamp(100 - (lo - wpm) * 1.5);
  if (wpm > hi) return clamp(100 - (wpm - hi) * 1.5);
  return 100;
}

// 성량: 너무 작으면 크게 감점, 너무 크면 완만하게 감점
export function volumeScore(level) {
  const [lo, hi] = IDEAL_VOLUME;
  if (level < lo) return clamp((level / lo) * 100);
  if (level > hi) return clamp(100 - (level - hi) * 2);
  return 100;
}

// 제스처: 적당히 쓰면 100점, 거의 없으면 완만하게, 과하면 크게 감점. 얼굴 만지기는 추가 감점
export function gestureScore(activeRatio, faceTouchRatio = 0) {
  const [lo, hi] = IDEAL_GESTURE;
  let score = 100;
  if (activeRatio < lo) score = 60 + (activeRatio / lo) * 40;
  else if (activeRatio > hi) score = 100 - (activeRatio - hi) * 150;
  return clamp(score - faceTouchRatio * 100);
}

// 비율(0~1) → 점수
export const ratioScore = (goodFrames, totalFrames) =>
  totalFrames > 0 ? clamp((goodFrames / totalFrames) * 100) : 0;

// 학생 문서 → 레이더 차트 배열 (예전 radarData 형식도 지원)
export function radarFromStudent(st) {
  if (st.scores) return SCORE_KEYS.map(k => st.scores[k] ?? 0);
  return st.radarData || [0, 0, 0, 0, 0];
}

// 점수 기반 취약점/추천 활동 (측정된 항목만 판단)
export function buildInsights(st) {
  const s = st.scores || {};
  const weaknesses = [];
  const recommendations = [];

  if (s.pronunciation != null && s.pronunciation < 80) {
    const words = (st.readingProgress?.wrongWords?.slice(-3).reverse() || st.lastReading?.wrongWords || []).slice(0, 3);
    weaknesses.push(words.length ? `발음이 불명확한 단어: ${words.join(', ')}` : '발음 정확도가 낮음');
    recommendations.push('거울을 보며 입모양을 크게 하여 또박또박 읽기');
  }
  if (s.speed != null && s.speed < 80) {
    const wpm = st.lastPresentation?.wpm;
    weaknesses.push(wpm > IDEAL_WPM[1] ? '말하기 속도가 빠름' : '말하기 속도가 느림');
    recommendations.push('문장 단위로 끊어 읽으며 적정 속도 유지하기');
  }
  if (s.volume != null && s.volume < 80) {
    weaknesses.push('목소리 크기가 적절하지 않음');
    recommendations.push('교실 뒤까지 들리도록 배에 힘을 주고 말하기');
  }
  if (s.gaze != null && s.gaze < 80) {
    weaknesses.push('시선 이탈이 잦음');
    recommendations.push('대본을 충분히 익힌 뒤 청중을 바라보며 말하기');
  }
  const p = st.lastPresentation || {};
  if (s.posture != null && s.posture < 80) {
    weaknesses.push(p.tiltRatio > 0.3 ? '어깨가 한쪽으로 기울어짐' : '발표 중 몸이 흔들림');
    recommendations.push('두 발을 어깨너비로 고정하고 어깨를 펴고 바른 자세 유지하기');
  }
  if (s.gesture != null && s.gesture < 80) {
    if (p.faceTouchRatio > 0.1) {
      weaknesses.push('발표 중 얼굴을 자주 만짐');
      recommendations.push('손은 허리 높이에 두고 필요할 때만 제스처 사용하기');
    } else if (p.gestureRatio > 0.6) {
      weaknesses.push('손동작이 지나치게 많음');
      recommendations.push('중요한 내용을 말할 때만 손동작으로 강조하기');
    } else {
      weaknesses.push('손 제스처를 거의 사용하지 않음');
      recommendations.push('숫자·비교·강조할 부분에서 자연스럽게 손동작 활용하기');
    }
  }
  const habits = p.habitCount;
  if (habits != null && habits >= 5) {
    weaknesses.push(`습관어(어, 음, 그) 사용이 잦음 (${habits}회)`);
    recommendations.push('말을 멈출 때 습관어 대신 잠깐 쉬어 가기');
  }

  if (!st.scores) {
    // 예전 형식 데이터
    return { weaknesses: st.weaknesses || [], recommendations: st.recommendations || [] };
  }
  return { weaknesses, recommendations };
}
