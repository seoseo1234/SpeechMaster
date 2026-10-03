// 발표 자세/제스처 분석 (MediaPipe Pose + Face 랜드마크 기반)
//
// - 자세 안정성: 손이 아니라 "몸통(어깨 중심)"의 흔들림과 어깨 기울기로 판단한다.
//   그래서 손 제스처는 자세를 불안정하게 만들지 않는다.
// - 제스처: 손목 움직임으로 따로 평가한다. 적당한 손동작은 가점, 전혀 없거나 과하면 감점.
// - 상반신(양 어깨)이 안 보이면 얼굴 위치 흔들림으로 대신 판단한다.
//
// 거리 단위는 "어깨너비"(얼굴 기준일 때는 얼굴 너비)로 정규화해 카메라 거리와 무관하게 한다.
// 아래 기준값은 실제 교실 영상으로 조정이 필요할 수 있다.
export const BODY_LIMITS = {
  SWAY: 0.15,            // 몸통 흔들림 허용치 (최근 3초 위치 표준편차 / 어깨너비)
  HEAD_SWAY: 0.25,       // 상반신이 안 보일 때 머리 흔들림 허용치 (/ 얼굴 너비)
  TILT_DEG: 10,          // 어깨 기울기 허용 각도
  HAND_ACTIVE_SPEED: 0.5, // 손 움직임을 제스처로 보는 속도 (어깨너비/초, 0.3초 이동거리 기준)
  FACE_TOUCH: 0.6,       // 손목-코 거리가 이보다 가까우면 얼굴 만지기 (/ 어깨너비)
  MIN_VISIBILITY: 0.6,
};

const WINDOW_MS = 3000;       // 흔들림 계산 구간
const HAND_WINDOW_MS = 300;   // 손 속도 측정 구간 (프레임 단위 떨림을 줄이기 위해 구간 이동거리 사용)
const GESTURE_WINDOW_MS = 5000; // 실시간 제스처 상태 표시 구간

// Pose 랜드마크 번호
const NOSE = 0, L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16;

const visible = (p) => p && (p.visibility ?? 1) >= BODY_LIMITS.MIN_VISIBILITY
  && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

function spread(points) {
  if (points.length < 10) return 0;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const v = points.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / n;
  return Math.sqrt(v);
}

export class BodyTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.torso = [];      // { t, x, y, scale }
    this.head = [];
    this.wristLog = [];   // { t, pts: [왼손, 오른손] }
    this.gestureLog = []; // { t, active, visible }
    this.stats = {
      frames: 0, stableFrames: 0, upperBodyFrames: 0, tiltFrames: 0,
      handFrames: 0, gestureFrames: 0, faceTouchFrames: 0,
    };
  }

  /**
   * @param pose  Pose 랜드마크 배열(33개) 또는 null
   * @param face  { nose: {x,y}, width } (정규화 좌표) 또는 null
   * @param aspect 영상 가로/세로 비율 (x 좌표를 세로 단위로 맞추기 위해)
   * @param t     현재 시각(ms)
   */
  update({ pose, face, aspect, t }) {
    const P = (p) => ({ x: p.x * aspect, y: p.y }); // 세로 길이 기준 좌표
    const prune = (arr, ms) => { while (arr.length && t - arr[0].t > ms) arr.shift(); };
    const state = { mode: 'none', stable: true, sway: 0, tilt: 0, tilted: false,
      handsVisible: false, handSpeed: 0, faceTouch: false, gesture: 'unknown' };

    const ls = pose?.[L_SHOULDER], rs = pose?.[R_SHOULDER];
    if (visible(ls) && visible(rs)) {
      // --- 상반신 모드 ---
      state.mode = 'body';
      const a = P(ls), b = P(rs);
      const sw = Math.hypot(a.x - b.x, a.y - b.y) || 1e-6;
      this.torso.push({ t, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scale: sw });
      prune(this.torso, WINDOW_MS);
      const meanScale = this.torso.reduce((s, p) => s + p.scale, 0) / this.torso.length;
      state.sway = spread(this.torso) / meanScale;

      state.tilt = Math.abs(Math.atan2(a.y - b.y, Math.abs(a.x - b.x)) * 180 / Math.PI);
      state.tilted = state.tilt > BODY_LIMITS.TILT_DEG;
      state.stable = state.sway <= BODY_LIMITS.SWAY && !state.tilted;

      // --- 손 제스처 (몸통 중심 기준 상대 위치 → 몸 전체가 움직여도 제스처로 세지 않음) ---
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const wristsAbs = [pose[L_WRIST], pose[R_WRIST]].map(w => (visible(w) ? P(w) : null));
      const wrists = wristsAbs.map(w => (w ? { x: w.x - center.x, y: w.y - center.y } : null));
      state.handsVisible = wrists.some(Boolean);
      this.wristLog.push({ t, pts: wrists });
      prune(this.wristLog, HAND_WINDOW_MS);
      if (state.handsVisible) {
        const old = this.wristLog[0];
        const dt = (t - old.t) / 1000;
        if (dt > 0.1) {
          wrists.forEach((w, i) => {
            const prev = old.pts[i];
            if (w && prev) state.handSpeed = Math.max(state.handSpeed, Math.hypot(w.x - prev.x, w.y - prev.y) / sw / dt);
          });
        }

        const nose = visible(pose[NOSE]) ? P(pose[NOSE]) : null;
        state.faceTouch = !!nose && wristsAbs.some(w => w && Math.hypot(w.x - nose.x, w.y - nose.y) / sw < BODY_LIMITS.FACE_TOUCH);
      }

      const active = state.handsVisible && state.handSpeed >= BODY_LIMITS.HAND_ACTIVE_SPEED;
      this.gestureLog.push({ t, active, visible: state.handsVisible });
      prune(this.gestureLog, GESTURE_WINDOW_MS);
      state.gesture = this.gestureState(state);

      this.stats.upperBodyFrames++;
      if (state.tilted) this.stats.tiltFrames++;
      if (state.handsVisible) {
        this.stats.handFrames++;
        if (active) this.stats.gestureFrames++;
        if (state.faceTouch) this.stats.faceTouchFrames++;
      }
    } else if (face) {
      // --- 얼굴 모드 (상반신이 안 보일 때) ---
      state.mode = 'face';
      const n = P(face.nose);
      this.head.push({ t, x: n.x, y: n.y, scale: face.width * aspect });
      prune(this.head, WINDOW_MS);
      const meanScale = this.head.reduce((s, p) => s + p.scale, 0) / this.head.length;
      state.sway = spread(this.head) / meanScale;
      state.stable = state.sway <= BODY_LIMITS.HEAD_SWAY;
      this.wristLog = [];
    } else {
      this.wristLog = [];
      return state; // 사람이 인식되지 않으면 집계하지 않음
    }

    this.stats.frames++;
    if (state.stable) this.stats.stableFrames++;
    return state;
  }

  // 최근 5초 기준 제스처 상태: hidden / face-touch / none / natural / excessive
  gestureState(state) {
    if (!state.handsVisible) return 'hidden';
    if (state.faceTouch) return 'face-touch';
    const seen = this.gestureLog.filter(g => g.visible);
    const ratio = seen.length ? seen.filter(g => g.active).length / seen.length : 0;
    if (ratio > 0.7) return 'excessive';
    if (ratio < 0.1) return 'none';
    return 'natural';
  }

  summary() {
    const s = this.stats;
    const ratio = (a, b) => (b > 0 ? a / b : 0);
    const handsMeasured = s.upperBodyFrames > 0 && ratio(s.handFrames, s.upperBodyFrames) >= 0.2;
    return {
      measuredFrames: s.frames,
      stableRatio: ratio(s.stableFrames, s.frames),
      upperBodyRatio: ratio(s.upperBodyFrames, s.frames),
      tiltRatio: ratio(s.tiltFrames, s.upperBodyFrames),
      // 손이 충분히 보였을 때만 제스처를 평가
      gestureRatio: handsMeasured ? ratio(s.gestureFrames, s.handFrames) : null,
      faceTouchRatio: handsMeasured ? ratio(s.faceTouchFrames, s.handFrames) : 0,
    };
  }
}
