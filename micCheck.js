// 마이크 입력 레벨 측정: 녹음 중 소리가 실제로 들어오는지 확인한다.
const SILENCE_RMS = 0.01; // 이보다 작으면 무음으로 판단 (말소리는 보통 0.02 이상)

export function createLevelMeter(stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);

  const data = new Float32Array(analyser.fftSize);
  let peak = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    peak = Math.max(peak, Math.sqrt(sum / data.length));
  }, 100);

  return {
    hasSound: () => peak >= SILENCE_RMS,
    stop() {
      clearInterval(timer);
      ctx.close().catch(() => {});
    },
  };
}

export function micName(stream) {
  return stream?.getAudioTracks()[0]?.label || '알 수 없는 마이크';
}

export const MIC_HELP =
  '마이크 음소거 여부, 브라우저 주소창 왼쪽 자물쇠 아이콘의 마이크 권한, ' +
  'Windows 설정 > 개인 정보 > 마이크 권한을 확인해주세요.';
