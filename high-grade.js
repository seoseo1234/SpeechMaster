import { FaceLandmarker, PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import { db, auth } from './firebase.js';
import { collection, onSnapshot, query, where, setDoc, addDoc, doc, serverTimestamp, getDoc } from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { analyzePresentation } from './apiClient.js';
import { speedScore, volumeScore, ratioScore, gestureScore } from './scoring.js';
import { createLevelMeter, micName, MIC_HELP } from './micCheck.js';
import { BodyTracker } from './bodyTracking.js';

let studentId = "";
let studentName = "";

let currentUser = null;
const isGuestMode = localStorage.getItem('guestMode') === 'true';
let studentClassCode = "";

onAuthStateChanged(auth, async (user) => {
    if ((!user || user.isAnonymous) && !isGuestMode) {
        window.location.replace('login.html');
    } else if (isGuestMode) {
        currentUser = { uid: 'guest', role: 'student', displayName: '체험학생' };
        studentId = 'guest';
        studentName = '체험학생';
        studentClassCode = "GUEST";
        const studentNameDisplay = document.getElementById('student-name-display');
        if (studentNameDisplay) studentNameDisplay.innerText = studentName;
    } else {
        currentUser = user;
        studentId = user.uid;
        studentName = user.displayName || user.email.split('@')[0];
        
        const studentNameDisplay = document.getElementById('student-name-display');
        if (studentNameDisplay) {
            studentNameDisplay.innerText = studentName;
        }
        
        // Fetch role and classCode
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
            studentClassCode = userDoc.data().classCode || "";
            studentName = userDoc.data().name || studentName;
            if (studentNameDisplay) studentNameDisplay.innerText = studentName;
            if (userDoc.data().role !== 'student') {
                console.warn("User is not a student, but allowing access for testing.");
            }
            if (studentClassCode) subscribeAssignments(studentClassCode);
        }
    }
});

let faceLandmarker;
let poseLandmarker = null; // 상반신 인식 (로드 실패 시 얼굴만으로 판단)
const bodyTracker = new BodyTracker();

let lastVideoTime = -1;
let faceTrackingAnimation = null;

let mediaStream = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let volumeAnimation = null;
let audioWorkletNode = null;

let ws = null;
let recognitionFatal = false;
let micMeter = null;
let presentationHadSound = true;
let isPresenting = false;
let startTime = 0;

let recognition = null;
let mediaRecorder = null;
let audioChunks = [];
let recorderStopped = Promise.resolve();

// 다시 듣기 타임라인 (녹음 시작 기준 ms). 녹음은 이 기기에서만 재생하고 저장하지 않는다.
const MIN_SEGMENT_MS = 1000;   // 이보다 짧은 시선 이탈/흔들림은 표시하지 않음
const HABIT_GAP_MS = 2000;     // 같은 습관어가 자막에 여러 번 잡혀도 한 번만 표시
const STT_DELAY_MS = 800;      // 자막이 실제 발화보다 늦게 도착하는 만큼 앞당김
let recordingStartedAt = 0;
let recordingDurationMs = 0;
let timelineEvents = [];       // { type: 'habit' | 'gaze' | 'posture', t, end? }
let openSegments = { gaze: null, posture: null };
let lastHabitEventAt = -Infinity;
let replayUrl = null;

let habitCounts = {
  uh: 0, // 어
  um: 0, // 음
  geu: 0 // 그
};
let fullRecognizedText = '';

// DOM Elements
const cameraFeed = document.getElementById('camera-feed');
const cameraFallback = document.getElementById('camera-fallback');
const volumeBar = document.getElementById('volume-bar');
const volumeText = document.getElementById('volume-text');
const sttResult = document.getElementById('stt-result');

const scriptContent = document.getElementById('script-content');
const scriptEditor = document.getElementById('script-editor');
const editScriptBtn = document.getElementById('edit-script-btn');

const startBtn = document.getElementById('start-presentation-btn');
const endBtn = document.getElementById('end-presentation-btn');
const resetHistoryBtn = document.getElementById('reset-history-btn');
const analysisModal = document.getElementById('analysis-modal');
const closeModalBtn = document.getElementById('close-modal-btn');

const countUh = document.getElementById('count-uh');
const countUm = document.getElementById('count-um');
const countGeu = document.getElementById('count-geu');
const habitItemUh = document.getElementById('habit-item-uh');
const habitItemUm = document.getElementById('habit-item-um');
const habitItemGeu = document.getElementById('habit-item-geu');
const resetHabitBtn = document.getElementById('reset-habit-btn');

const micStatusIcon = document.getElementById('mic-status-icon');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// Settings Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const cameraSelect = document.getElementById('camera-select');
const micSelect = document.getElementById('mic-select');
const enableTimerToggle = document.getElementById('enable-timer-toggle');
const targetTimeMin = document.getElementById('target-time-min');
const targetTimeSec = document.getElementById('target-time-sec');
const targetTimeInputs = document.getElementById('target-time-inputs');
const hideHudToggle = document.getElementById('hide-hud-toggle');
// HUD & Timer Elements
const hudLeft = document.getElementById('hud-left');
const hudRight = document.getElementById('hud-right');
const faceTrackingCanvas = document.getElementById('face-tracking-canvas');
const presentationTimer = document.getElementById('presentation-timer');
const currentTimeDisplay = document.getElementById('current-time-display');
const targetTimeDisplay = document.getElementById('target-time-display');
const timerSeparator = document.getElementById('timer-separator');

let selectedCameraId = '';
let selectedMicId = '';
let targetPresentationSeconds = 180;
let hideHudActive = false;
let presentationTimerInterval = null;

// HUD Elements
let toneGraphCtx, speedGraphCtx, gestureGraphCtx;
let toneHistory = new Array(30).fill(0);
let speedHistory = new Array(30).fill(0);
let gestureHistory = new Array(30).fill(0);
let lastWordCount = 0;
let lastSpeedCalcTime = 0;

// Accumulators for Gemini Feedback
let totalTone = 0, toneCount = 0;
let outOfGazeCount = 0, totalGazeFrames = 0;

// Inline AudioWorklet for downsampling to 16kHz
const workletCode = `
class ResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.buffer = [];
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const channelData = input[0]; // mono
      // Very simple downsampling by picking samples
      const ratio = sampleRate / this.targetSampleRate;
      for (let i = 0; i < channelData.length; i += ratio) {
        this.buffer.push(channelData[Math.floor(i)]);
      }
      
      // When buffer has enough data, send it to main thread
      if (this.buffer.length >= 4096) {
        const out = new Float32Array(this.buffer);
        // Convert Float32 to Int16
        const int16Buffer = new Int16Array(out.length);
        for (let i = 0; i < out.length; i++) {
          let s = Math.max(-1, Math.min(1, out[i]));
          int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this.port.postMessage(int16Buffer.buffer, [int16Buffer.buffer]);
        this.buffer = [];
      }
    }
    return true;
  }
}
registerProcessor('resampler-processor', ResamplerProcessor);
`;
const workletUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));


async function initializeFaceLandmarker() {
    const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: "VIDEO",
        numFaces: 1
    });
    try {
        poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numPoses: 1
        });
    } catch (e) {
        console.warn("Pose landmarker unavailable, using face-only posture:", e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeFaceLandmarker();
  setupScriptEditor();
  
  toneGraphCtx = document.getElementById('tone-graph').getContext('2d');
  speedGraphCtx = document.getElementById('speed-graph').getContext('2d');
  gestureGraphCtx = document.getElementById('gesture-graph').getContext('2d');

  startBtn.addEventListener('click', startPresentation);
  endBtn.addEventListener('click', endPresentation);
  closeModalBtn.addEventListener('click', () => {
    analysisModal.classList.add('hidden');
  });
  resetHabitBtn.addEventListener('click', resetHabits);
  if(resetHistoryBtn) resetHistoryBtn.addEventListener('click', resetAllHistory);
});

function resetAllHistory() {
    if (isPresenting) {
        alert('발표 중에는 초기화할 수 없습니다.');
        return;
    }
    
    // STT 기록 초기화
    fullRecognizedText = '';
    sttResult.innerHTML = '<span class="text-on-surface-variant italic opacity-70">발표를 시작하면 여기에 음성이 실시간 텍스트로 나타납니다...</span>';
    
    // 대본 하이라이트 초기화
    const paragraphs = Array.from(scriptContent.querySelectorAll('p'));
    paragraphs.forEach((p, idx) => {
        if (idx === 0) {
          p.style.opacity = '1';
          p.style.borderLeft = '8px solid #3B82F6';
          p.style.paddingLeft = '16px';
        } else {
          p.style.opacity = '0.2';
          p.style.borderLeft = '8px solid transparent';
          p.style.paddingLeft = '0px';
        }
    });

    // 습관어 초기화
    resetHabits();
    
    // 그래프 초기화
    toneHistory.fill(0);
    speedHistory.fill(0);
    gestureHistory.fill(0);
    drawHUDGraph(toneGraphCtx, toneHistory, '#FDE047');
    drawHUDGraph(speedGraphCtx, speedHistory, '#22C55E');
    drawHUDGraph(gestureGraphCtx, gestureHistory, '#3B82F6');
    
    // 피드백 텍스트 초기화
    const feedbackPosture = document.getElementById('feedback-posture');
    const feedbackGaze = document.getElementById('feedback-gaze');
    if (feedbackPosture) { feedbackPosture.innerText = '-'; feedbackPosture.className = 'text-base font-black text-white'; }
    if (feedbackGaze) { feedbackGaze.innerText = '-'; feedbackGaze.className = 'text-base font-black text-white'; }
    setFeedback('feedback-gesture', '-', 'text-white');
    
    // 좌측 상단 상태 표시기 초기화
    statusText.innerText = '대기 중';
    statusDot.className = 'w-3 h-3 bg-surface-variant border border-black rounded-none';
    
    // 볼륨 게이지 초기화
    volumeBar.style.width = '0%';
    volumeText.innerText = '0 dB';
}

function drawHUDGraph(ctx, history, color) {
    if (!ctx) return;
    ctx.clearRect(0, 0, 140, 50);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    
    const w = 140;
    const h = 50;
    const step = w / (history.length - 1);
    
    // Normalize logic
    let max = Math.max(...history, 10); // min 10 to avoid flat line at 0 max
    
    for (let i = 0; i < history.length; i++) {
        const x = i * step;
        const normalizedY = (history[i] / max) * h;
        const y = h - Math.min(h, Math.max(0, normalizedY)) * 0.8 - 5; // keep some padding
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    // Add glowing effect
    ctx.shadowBlur = 8;
    ctx.shadowColor = color;
    ctx.stroke();
    ctx.shadowBlur = 0;
}

const MY_SCRIPT_KEY = 'speechmaster_my_script';
const assignmentSelect = document.getElementById('assignment-select');
let isEditingScript = false;
let assignments = [];          // 학급 과제 목록 (최신순)
let knownAssignmentIds = null; // 처음 불러온 과제 id (이후 추가된 과제에 🆕 표시)
let defaultScript = '';

function loadMyScript() {
  try { return localStorage.getItem(MY_SCRIPT_KEY) || defaultScript; } catch { return defaultScript; }
}

function saveMyScript(text) {
  try { localStorage.setItem(MY_SCRIPT_KEY, text); } catch {}
}

// 대본을 문단(<p>) 단위로 표시: 빈 줄로 나누고, 빈 줄이 없으면 줄바꿈 단위로 나눈다
function renderScript(text) {
  let paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) paragraphs = text.split('\n').map(p => p.trim()).filter(Boolean);

  scriptEditor.value = text;
  scriptContent.replaceChildren();
  paragraphs.forEach((p, idx) => {
    const pEl = document.createElement('p');
    pEl.className = 'font-body-lg leading-relaxed text-on-surface text-2xl transition-all duration-500';
    pEl.style.borderLeft = idx === 0 ? '8px solid #3B82F6' : '8px solid transparent';
    pEl.style.paddingLeft = idx === 0 ? '16px' : '0px';
    pEl.style.opacity = idx === 0 ? '1' : '0.2';
    pEl.innerText = p;
    scriptContent.appendChild(pEl);
  });
}

function selectedAssignment() {
  return assignments.find(a => a.id === assignmentSelect.value) || null;
}

function setupScriptEditor() {
  defaultScript = Array.from(scriptContent.querySelectorAll('p')).map(p => p.innerText.trim()).join('\n\n');
  renderScript(loadMyScript());

  assignmentSelect.addEventListener('change', () => {
    const assignment = selectedAssignment();
    renderScript(assignment ? assignment.script : loadMyScript());
    if (assignment) {
      // 확인한 과제는 🆕 표시 해제
      assignment.isNew = false;
      renderAssignmentOptions();
    }
  });

  editScriptBtn.addEventListener('click', () => {
    if (isPresenting) {
      alert('발표 중에는 대본을 수정할 수 없습니다.');
      return;
    }

    isEditingScript = !isEditingScript;
    assignmentSelect.disabled = isEditingScript;
    if (isEditingScript) {
      scriptContent.style.display = 'none';
      scriptEditor.classList.remove('hidden');
      editScriptBtn.innerHTML = `<span class="material-symbols-outlined text-sm">save</span>저장`;
      editScriptBtn.classList.replace('bg-secondary', 'bg-primary');
      editScriptBtn.classList.add('text-white');
    } else {
      scriptEditor.classList.add('hidden');
      scriptContent.style.display = 'block';
      editScriptBtn.innerHTML = `<span class="material-symbols-outlined text-sm">edit</span>수정`;
      editScriptBtn.classList.replace('bg-primary', 'bg-secondary');
      editScriptBtn.classList.remove('text-white');

      const text = scriptEditor.value;
      const assignment = selectedAssignment();
      // 과제 대본을 고치면 원본은 그대로 두고 '직접 작성한 대본'으로 저장
      if (!assignment || text.trim() !== assignment.script.trim()) {
        saveMyScript(text);
        assignmentSelect.value = '';
      }
      renderScript(text);
    }
  });
}

function renderAssignmentOptions() {
  const current = assignmentSelect.value;
  const options = [new Option('✏️ 직접 작성한 대본', '')];
  assignments.forEach(a => {
    const d = a.createdAt?.toDate?.();
    const date = d ? ` (${d.getMonth() + 1}/${d.getDate()})` : '';
    options.push(new Option(`${a.isNew ? '🆕 ' : '📌 '}${a.title || '제목 없는 과제'}${date}`, a.id));
  });
  assignmentSelect.replaceChildren(...options);
  assignmentSelect.value = assignments.some(a => a.id === current) ? current : '';
}
// 실시간 자막 영역 위에 경고 표시 (마이크/브라우저 문제)
function showSttNotice(message) {
    let el = document.getElementById('stt-notice');
    if (!el) {
        el = document.createElement('div');
        el.id = 'stt-notice';
        el.className = 'mb-2 p-2 border-2 border-black bg-error text-white font-bold text-sm';
        sttResult.parentElement.insertBefore(el, sttResult);
    }
    el.textContent = '⚠️ ' + message;
}

function clearSttNotice() {
    document.getElementById('stt-notice')?.remove();
}

let interimText = '';
function updateSTTUI(interim = '') {
    sttResult.innerHTML = `<span class="text-on-surface font-medium"></span> <span class="text-on-surface-variant italic opacity-70"></span>`;
    sttResult.children[0].textContent = fullRecognizedText;
    sttResult.children[1].textContent = interim;
    sttResult.parentElement.scrollTop = sttResult.parentElement.scrollHeight;
}

function checkHabitualWords(text) {
  // JS의 \b는 한글을 단어 문자로 인식하지 않으므로 공백 및 기호를 기준으로 찾습니다.
  const uhMatch = (text.match(/(^|\s)(어+|아+|어\.\.\.)(?=\s|[.,?!]|$)/g) || []).length;
  const umMatch = (text.match(/(^|\s)(음+|음마+|음\.\.\.)(?=\s|[.,?!]|$)/g) || []).length;
  const geuMatch = (text.match(/(^|\s)(그+|어그+|그\.\.\.)(?=\s|[.,?!]|$)/g) || []).length;

  if (isPresenting && uhMatch + umMatch + geuMatch > 0) markHabitEvent();
  if (uhMatch > 0) updateHabit('uh', uhMatch);
  if (umMatch > 0) updateHabit('um', umMatch);
  if (geuMatch > 0) updateHabit('geu', geuMatch);
}

function markHabitEvent() {
  const t = Math.max(0, Date.now() - recordingStartedAt - STT_DELAY_MS);
  if (t - lastHabitEventAt < HABIT_GAP_MS) return;
  lastHabitEventAt = t;
  timelineEvents.push({ type: 'habit', t });
}

// 시선 이탈/자세 흔들림이 이어지는 구간을 기록
function trackSegment(type, active) {
  const t = Date.now() - recordingStartedAt;
  if (active) {
    if (openSegments[type] == null) openSegments[type] = t;
  } else {
    closeSegment(type, t);
  }
}

function closeSegment(type, t) {
  const start = openSegments[type];
  openSegments[type] = null;
  if (start != null && t - start >= MIN_SEGMENT_MS) timelineEvents.push({ type, t: start, end: t });
}

function updateHabit(type, count) {
  habitCounts[type] += count;
  
  const elCount = document.getElementById(`count-${type}`);
  const elItem = document.getElementById(`habit-item-${type}`);
  
  elCount.innerText = `${habitCounts[type]}회`;
  
  if (habitCounts[type] > 0) {
    elItem.classList.replace('bg-white', 'bg-error');
    elItem.classList.add('text-white');
    elCount.classList.add('text-white');
    
    elItem.classList.add('scale-105');
    setTimeout(() => elItem.classList.remove('scale-105'), 200);
  }
}

function resetHabits() {
  habitCounts = { uh: 0, um: 0, geu: 0 };
  ['uh', 'um', 'geu'].forEach(type => {
    document.getElementById(`count-${type}`).innerText = '0';
    const elItem = document.getElementById(`habit-item-${type}`);
    const elCount = document.getElementById(`count-${type}`);
    elItem.classList.replace('bg-error', 'bg-white');
    elItem.classList.remove('text-white');
    elCount.classList.remove('text-white');
  });
}

function updateScriptHighlight(recognizedText) {
  const paragraphs = Array.from(scriptContent.querySelectorAll('p'));
  if (paragraphs.length === 0) return;

  let bestMatchIdx = 0;
  let maxMatches = 0;
  
  const recogWords = recognizedText.split(/\s+/).slice(-20);

  paragraphs.forEach((p, idx) => {
    const pWords = p.innerText.split(/\s+/);
    let matches = 0;
    recogWords.forEach(rw => {
      if (rw.length > 1 && pWords.some(pw => pw.includes(rw))) matches++;
    });
    if (matches >= maxMatches && matches > 0) {
      maxMatches = matches;
      bestMatchIdx = idx;
    }
  });

  paragraphs.forEach((p, idx) => {
    if (idx === bestMatchIdx) {
      p.style.opacity = '1';
      p.style.borderLeft = '8px solid #3B82F6';
      p.style.paddingLeft = '16px';
    } else {
      p.style.opacity = '0.2';
      p.style.borderLeft = '8px solid transparent';
      p.style.paddingLeft = '0px';
    }
  });
}

// 상반신 연결선 (어깨-팔꿈치-손목)
const UPPER_BODY_LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];

const GESTURE_LABELS = {
    natural: ['자연스러움', 'text-[#96f996]'],
    none: ['거의 없음', 'text-white/70'],
    excessive: ['과함', 'text-error'],
    'face-touch': ['얼굴 만짐', 'text-error'],
    hidden: ['손 안 보임', 'text-white/50'],
    unknown: ['상반신 필요', 'text-white/50']
};

function setFeedback(id, text, colorClass) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = text;
    el.className = `text-base font-black ${colorClass}`;
}

// 고개 회전 각도로 정면 주시 여부 판별
function isFacingFront(faceResult) {
    const matrix = faceResult.facialTransformationMatrixes?.[0]?.data;
    if (!matrix) return true;
    const r00 = matrix[0], r10 = matrix[1], r20 = matrix[2];
    const r11 = matrix[5], r21 = matrix[6];
    const r12 = matrix[9], r22 = matrix[10];

    const sy = Math.sqrt(r00 * r00 + r10 * r10);
    const x = sy < 1e-6 ? Math.atan2(-r12, r11) : Math.atan2(r21, r22);
    const y = Math.atan2(-r20, sy);
    const pitch = x * 180 / Math.PI;
    const yaw = y * 180 / Math.PI;

    // 대본을 읽어야 하므로 시선(고개 회전) 판별 기준 완화 (좌우 상하 15도)
    return Math.abs(yaw) < 15 && Math.abs(pitch) < 15;
}

// 얼굴 인식 브래킷 + 코 끝 십자선
function drawFaceBracket(ctx, landmarks, width, height) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const l of landmarks) {
        if (l.x < minX) minX = l.x;
        if (l.x > maxX) maxX = l.x;
        if (l.y < minY) minY = l.y;
        if (l.y > maxY) maxY = l.y;
    }
    const bx = minX * width, by = minY * height;
    const bw = (maxX - minX) * width, bh = (maxY - minY) * height;
    const c = 20;

    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)'; // Electric blue
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx, by + c); ctx.lineTo(bx, by); ctx.lineTo(bx + c, by);
    ctx.moveTo(bx + bw - c, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + c);
    ctx.moveTo(bx, by + bh - c); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + c, by + bh);
    ctx.moveTo(bx + bw - c, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - c);
    ctx.stroke();

    const nose = landmarks[1];
    const nx = nose.x * width, ny = nose.y * height;
    ctx.beginPath();
    ctx.moveTo(nx - 5, ny); ctx.lineTo(nx + 5, ny);
    ctx.moveTo(nx, ny - 5); ctx.lineTo(nx, ny + 5);
    ctx.stroke();

    return { nose: { x: nose.x, y: nose.y }, width: maxX - minX };
}

// 상반신 골격 (어깨선은 기울면 빨간색, 손목은 제스처 중이면 초록색)
function drawUpperBody(ctx, pose, body, width, height) {
    const pt = (i) => ({ x: pose[i].x * width, y: pose[i].y * height, ok: (pose[i].visibility ?? 1) > 0.5 });
    ctx.lineWidth = 4;
    UPPER_BODY_LINKS.forEach(([a, b], idx) => {
        const p = pt(a), q = pt(b);
        if (!p.ok || !q.ok) return;
        ctx.strokeStyle = idx === 0
            ? (body.stable ? 'rgba(150, 249, 150, 0.85)' : 'rgba(255, 90, 90, 0.9)')
            : 'rgba(253, 224, 71, 0.7)';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
    });
    [15, 16].forEach(i => {
        const p = pt(i);
        if (!p.ok) return;
        ctx.fillStyle = body.gesture === 'natural' ? '#96f996' : body.gesture === 'none' ? '#FDE047' : '#ff5a5a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fill();
    });
}

function predictWebcam() {
    if (!isPresenting) return;

    if (faceLandmarker && cameraFeed.readyState >= 2 && lastVideoTime !== cameraFeed.currentTime) {
        lastVideoTime = cameraFeed.currentTime;
        const now = performance.now();
        const faceResult = faceLandmarker.detectForVideo(cameraFeed, now);
        const poseResult = poseLandmarker ? poseLandmarker.detectForVideo(cameraFeed, now) : null;
        const faceLm = faceResult.faceLandmarks?.[0] || null;
        const poseLm = poseResult?.landmarks?.[0] || null;

        const faceCanvas = document.getElementById('face-tracking-canvas');
        const width = cameraFeed.videoWidth, height = cameraFeed.videoHeight;
        faceCanvas.width = width;
        faceCanvas.height = height;
        const ctx = faceCanvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);

        if (!faceLm && !poseLm) {
            statusText.innerText = '사람 인식 불가';
            statusDot.className = 'w-3 h-3 bg-surface-variant border border-black rounded-none';
        } else {
            // 1. 시선 처리 (얼굴)
            const isLookingFront = faceLm ? isFacingFront(faceResult) : true;
            const faceInfo = faceLm ? drawFaceBracket(ctx, faceLm, width, height) : null;
            trackSegment('gaze', !!faceLm && !isLookingFront);
            if (faceLm) {
                totalGazeFrames++;
                if (!isLookingFront) outOfGazeCount++;
                if (isLookingFront) setFeedback('feedback-gaze', '우수', 'text-[#96f996]');
                else setFeedback('feedback-gaze', '시선 이탈', 'text-error');
            }

            // 2. 자세(몸통) + 제스처(손) 분석
            const body = bodyTracker.update({ pose: poseLm, face: faceInfo, aspect: width / height, t: now });
            trackSegment('posture', body.mode !== 'none' && !body.stable);
if (body.mode === 'body') drawUpperBody(ctx, poseLm, body, width, height);

            if (body.mode !== 'none') {
                if (body.stable) setFeedback('feedback-posture', body.mode === 'body' ? '안정적' : '안정적(얼굴 기준)', 'text-[#96f996]');
                else setFeedback('feedback-posture', body.tilted ? '어깨 기울어짐' : '몸 흔들림', 'text-error');
            }
            const [gestureText, gestureColor] = GESTURE_LABELS[body.mode === 'body' ? body.gesture : 'unknown'];
            setFeedback('feedback-gesture', gestureText, gestureColor);

            // 좌측 상단 메인 상태 표시기 업데이트
            if (body.mode !== 'none' && !body.stable) {
                statusText.innerText = body.tilted ? '⚠️ 어깨 기울어짐!' : '⚠️ 몸 흔들림 감지!';
                statusDot.className = 'w-3 h-3 bg-error border border-black rounded-none';
            } else if (!isLookingFront) {
                statusText.innerText = '👀 시선 이탈';
                statusDot.className = 'w-3 h-3 bg-secondary border border-black rounded-none';
            } else if (body.mode === 'face') {
                statusText.innerText = '🟢 정면 주시 중 (상반신이 보이면 제스처도 분석해요)';
                statusDot.className = 'w-3 h-3 bg-tertiary border border-black rounded-none animate-pulse';
            } else {
                statusText.innerText = '🟢 정면 주시 중';
                statusDot.className = 'w-3 h-3 bg-tertiary border border-black rounded-none animate-pulse';
            }

            // 제스처 그래프: 손 움직임 속도
            gestureHistory.push(body.handSpeed * 10);
            gestureHistory.shift();
            drawHUDGraph(gestureGraphCtx, gestureHistory, '#3B82F6'); // Electric Blue
        }
    }
    faceTrackingAnimation = window.requestAnimationFrame(predictWebcam);
}

async function startPresentation() {
  const originalStartText = startBtn.innerHTML;
  clearSttNotice();
  assignmentSelect.disabled = true; // 발표 중에는 과제 변경 불가
  try {
    startBtn.innerHTML = `<span class="material-symbols-outlined animate-spin" style="animation-duration: 2s;">sync</span> <span id="start-btn-text">연결 중...</span>`;
    startBtn.classList.add('opacity-70', 'pointer-events-none');

    // Apply Settings
    const constraints = {
        video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true,
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
    };
    
    // Start Audio/Video
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Start WebKit Speech Recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'ko-KR';
        recognition.onresult = (event) => {
            let currentInterim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    fullRecognizedText += event.results[i][0].transcript + ' ';
                    updateScriptHighlight(fullRecognizedText);
                } else {
                    currentInterim += event.results[i][0].transcript;
                }
            }
            updateSTTUI(currentInterim);
            
            // 실시간 카운터 및 속도 분석 (임시 로직)
            const transcript = event.results[event.resultIndex][0].transcript;
            checkHabitualWords(transcript);
            
            // Speed analysis
            const now = Date.now();
            if (now - lastSpeedCalcTime > 1000) {
                const words = fullRecognizedText.trim().split(/\s+/).length;
                const speed = Math.max(0, words - lastWordCount);
                speedHistory.push(speed * 10); // scale up
                speedHistory.shift();
                drawHUDGraph(speedGraphCtx, speedHistory, '#22C55E'); // Green
                lastWordCount = words;
                lastSpeedCalcTime = now;

            }
        };
        recognition.onerror = (event) => {
            console.warn('Speech recognition error:', event.error);
            const messages = {
                'not-allowed': `마이크 권한이 차단되어 실시간 자막을 표시할 수 없어요. ${MIC_HELP}`,
                'service-not-allowed': '이 브라우저에서는 실시간 음성 인식이 허용되지 않아요. 크롬 또는 엣지를 사용해주세요.',
                'audio-capture': `마이크를 찾을 수 없어요. ${MIC_HELP}`,
                'network': '음성 인식 서버에 연결할 수 없어요. 학교 네트워크에서 Google 음성 인식이 차단되었을 수 있어요.'
            };
            if (messages[event.error]) {
                recognitionFatal = true;
                showSttNotice(messages[event.error]);
            }
        };
        // 크롬은 잠시 조용하면 인식을 스스로 끝내므로 발표 중에는 다시 시작
        recognition.onend = () => {
            if (isPresenting && !recognitionFatal) {
                try { recognition.start(); } catch(e){}
            }
        };
        recognitionFatal = false;
        try { recognition.start(); } catch(e){}
    } else {
        showSttNotice('이 브라우저는 실시간 자막을 지원하지 않아요. 크롬 또는 엣지 브라우저를 사용해주세요. (발표 분석은 정상적으로 진행됩니다)');
    }

    // 시작 후 5초 동안 마이크 소리가 전혀 없으면 안내
    micMeter = createLevelMeter(mediaStream);
    const activeMic = micName(mediaStream);
    setTimeout(() => {
        if (isPresenting && micMeter && !micMeter.hasSound()) {
            showSttNotice(`마이크에서 소리가 들리지 않아요. (사용 중인 마이크: ${activeMic}) 설정(톱니바퀴)에서 다른 마이크를 선택하거나, ${MIC_HELP}`);
        }
    }, 5000);

    // Record audio for Gemini (영상 제외, 저비트레이트: 서버 업로드 한도 4MB ≈ 약 15분)
    audioChunks = [];
    const audioMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    mediaRecorder = new MediaRecorder(new MediaStream(mediaStream.getAudioTracks()), {
        ...(audioMime ? { mimeType: audioMime } : {}),
        audioBitsPerSecond: 32000
    });
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.start(1000); // chunk every second
    recordingStartedAt = Date.now();
    timelineEvents = [];
    openSegments = { gaze: null, posture: null };
    lastHabitEventAt = -Infinity;
    resetReplay();

    cameraFeed.srcObject = mediaStream;
    cameraFallback.classList.add('hidden');
    cameraFeed.classList.remove('hidden');
    
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    microphone = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    microphone.connect(analyser);
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    function drawVolume() {
        if (!isPresenting) return;
        volumeAnimation = requestAnimationFrame(drawVolume);
        
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for(let i = 0; i < bufferLength; i++) { sum += dataArray[i]; }
        let average = sum / bufferLength;
        
        let dbEstimate = Math.round((average / 255) * 100);
        let percentage = Math.min(100, dbEstimate);
        
        volumeBar.style.width = `${percentage}%`;
        volumeText.innerText = `${dbEstimate} dB`;
        
        if (dbEstimate > 40) volumeBar.classList.replace('bg-secondary', 'bg-error');
        else volumeBar.classList.replace('bg-error', 'bg-secondary');
        
        // Update Tone Graph
        toneHistory.push(average);
        toneHistory.shift();
        drawHUDGraph(toneGraphCtx, toneHistory, '#FDE047'); // Lemon Yellow
        
        totalTone += average;
        toneCount++;
    }
    
    isPresenting = true;
    lastWordCount = 0;
    lastSpeedCalcTime = Date.now();
    
    // Reset Accumulators
    totalTone = 0; toneCount = 0;
    bodyTracker.reset();
    outOfGazeCount = 0; totalGazeFrames = 0;
    
    // Reset Histories
    toneHistory.fill(0);
    speedHistory.fill(0);
    gestureHistory.fill(0);
    drawVolume();
    
    fullRecognizedText = '';
    sttResult.innerHTML = '<span class="text-on-surface-variant italic opacity-70">발표를 시작하세요. 실시간으로 음성이 기록됩니다.</span>';

    startBtn.classList.add('hidden');
    startBtn.innerHTML = originalStartText;
    startBtn.classList.remove('opacity-70', 'pointer-events-none');
    endBtn.classList.remove('hidden');
    
    micStatusIcon.classList.replace('bg-surface-variant', 'bg-error');
    micStatusIcon.classList.add('animate-pulse');
    micStatusIcon.innerHTML = `<span class="material-symbols-outlined text-white font-bold" style="font-variation-settings: 'FILL' 1;">mic</span>`;
    
    statusDot.className = 'w-3 h-3 bg-tertiary border border-black rounded-none animate-pulse';
    statusText.innerText = '🟢 분석 시작...';
    
    // 시작 시 변수 초기화
    lastVideoTime = -1;
    if (faceTrackingAnimation) cancelAnimationFrame(faceTrackingAnimation);
    predictWebcam();
    startTime = Date.now();
    
    // Start Timer
    presentationTimer.classList.remove('hidden');
    currentTimeDisplay.parentElement.classList.remove('text-error');
    if (presentationTimerInterval) clearInterval(presentationTimerInterval);
    presentationTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        currentTimeDisplay.innerText = `${m}:${s}`;
        
        if (targetPresentationSeconds !== Infinity && elapsed > targetPresentationSeconds) {
            currentTimeDisplay.parentElement.classList.add('text-error');
        }
    }, 1000);
  } catch (err) {
    console.error('시작 오류:', err);
    assignmentSelect.disabled = false;
    startBtn.innerHTML = originalStartText;
    startBtn.classList.remove('opacity-70', 'pointer-events-none');
    alert('오류 발생: ' + err.message + '\n(카메라/마이크 권한을 확인해주세요)');
  }
}

function endPresentation() {
  isPresenting = false;
  assignmentSelect.disabled = false;
  
  if (recognition) {
      try { recognition.stop(); } catch(e){}
  }
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      // 마지막 조각까지 받은 뒤 분석/다시 듣기에 사용
      recorderStopped = new Promise(resolve => mediaRecorder.addEventListener('stop', resolve, { once: true }));
      mediaRecorder.stop();
  }
  recordingDurationMs = Date.now() - recordingStartedAt;
  closeSegment('gaze', recordingDurationMs);
  closeSegment('posture', recordingDurationMs);

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    cameraFeed.srcObject = null;
    cameraFeed.classList.add('hidden');
    cameraFallback.classList.remove('hidden');
  }
  
  if (microphone) {
      microphone.disconnect();
  }
  if (audioContext) {
    audioContext.close();
  }
  if (volumeAnimation) {
    cancelAnimationFrame(volumeAnimation);
  }
  if (faceTrackingAnimation) {
    cancelAnimationFrame(faceTrackingAnimation);
  }
  
  if (presentationTimerInterval) {
      clearInterval(presentationTimerInterval);
      presentationTimerInterval = null;
  }
  presentationTimer.classList.add('hidden');
  startBtn.classList.remove('hidden');
  endBtn.classList.add('hidden');
  
  micStatusIcon.classList.replace('bg-error', 'bg-surface-variant');
  micStatusIcon.classList.remove('animate-pulse');
  micStatusIcon.innerHTML = `<span class="material-symbols-outlined text-white font-bold" style="font-variation-settings: 'FILL' 1;">mic_off</span>`;
  
  statusDot.className = 'w-3 h-3 bg-surface-variant border border-black rounded-none';
  statusText.innerText = '대기 중';
  
  volumeBar.style.width = '0%';
  volumeText.innerText = '0 dB';

  presentationHadSound = micMeter ? micMeter.hasSound() : true;
  if (micMeter) {
    micMeter.stop();
    micMeter = null;
  }

  showAnalysisModal();
}

async function showAnalysisModal() {
  const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');
  
  document.getElementById('report-time').innerText = `${minutes}:${seconds}`;
  
  const commentEl = document.getElementById('report-comment');
  commentEl.innerHTML = `<span class="material-symbols-outlined animate-spin text-secondary inline-block">sync</span> 제미나이가 녹음된 음성을 분석하여 습관어와 발표 내용을 피드백하고 있습니다...`;
  commentEl.classList.remove('text-primary', 'text-error');
  
  document.getElementById('report-habits').innerText = `분석 중...`;
  document.getElementById('analysis-modal').classList.remove('hidden');

  await recorderStopped;
  if (audioChunks.length > 0) {
      showReplay(new Blob(audioChunks, { type: (mediaRecorder.mimeType || 'audio/webm').split(';')[0] }));
  }

if (!presentationHadSound) {
      document.getElementById('report-habits').innerText = `소리 없음`;
      commentEl.textContent = `발표 중 마이크에서 소리가 들리지 않아 분석하지 않았습니다. ${MIC_HELP}`;
      return;
  }

  if (audioChunks.length === 0) {
      document.getElementById('report-habits').innerText = `오디오 없음`;
      commentEl.innerHTML = `녹음된 오디오가 없어 분석을 수행할 수 없습니다.`;
      return;
  }

  try {
      const audioBlob = new Blob(audioChunks, { type: (mediaRecorder.mimeType || 'audio/webm').split(';')[0] });
      if (audioBlob.size > 4 * 1024 * 1024) {
          throw new Error('발표 녹음이 너무 길어요. 약 15분 이내로 발표해주세요.');
      }

      const avgTone = toneCount > 0 ? Math.round(totalTone / toneCount) : 0;
      // 말하기 속도: 인식된 전체 어절 수 / 발표 시간(분)
      const wordCount = fullRecognizedText.trim() ? fullRecognizedText.trim().split(/\s+/).length : 0;
      const avgSpeed = elapsedSeconds > 0 ? Math.round(wordCount / (elapsedSeconds / 60)) : 0;
      const body = bodyTracker.summary();
      const postureScore = ratioScore(body.stableRatio * 100, 100);
      const gestureNote = body.gestureRatio == null
          ? '상반신/손이 화면에 충분히 보이지 않아 측정 안 됨'
          : `손이 보이는 시간 중 ${Math.round(body.gestureRatio * 100)}% 동안 손동작 사용` +
            (body.faceTouchRatio > 0.1 ? `, 얼굴 만지기 ${Math.round(body.faceTouchRatio * 100)}%` : '');
      const gazeScore = totalGazeFrames > 0 ? Math.round((1 - outOfGazeCount / totalGazeFrames) * 100) : 0;
      

      const result = await analyzePresentation(audioBlob, { avgTone, avgSpeed, postureScore, gestureNote, gazeScore });
      
      const counts = result.habitCounts || { uh: 0, um: 0, geu: 0 };
      const totalHabits = counts.uh + counts.um + counts.geu;
      
      // Update the real-time UI counters just to sync the data
      document.getElementById('count-uh').innerText = `${counts.uh}회`;
      document.getElementById('count-um').innerText = `${counts.um}회`;
      document.getElementById('count-geu').innerText = `${counts.geu}회`;

      document.getElementById('report-habits').innerText = `총 ${totalHabits}회`;
      
      if (totalHabits === 0) {
          commentEl.classList.add('text-primary');
      } else if (totalHabits >= 5) {
          commentEl.classList.add('text-error');
      }
      
      commentEl.textContent = result.feedback;
      
      // Upload to Firebase (요약은 병합 저장, 회차 기록은 누적)
      try {
          const scores = { volume: volumeScore((avgTone / 255) * 100) };
          if (totalGazeFrames > 0) scores.gaze = gazeScore;
          if (body.measuredFrames > 0) scores.posture = postureScore;
          if (body.gestureRatio != null) scores.gesture = gestureScore(body.gestureRatio, body.faceTouchRatio);
          if (avgSpeed > 0) scores.speed = speedScore(avgSpeed);
          
          if (!isGuestMode) {
              const presentation = {
                  wpm: avgSpeed, habitCount: totalHabits, durationSec: elapsedSeconds,
                  upperBodyRatio: body.upperBodyRatio, tiltRatio: body.tiltRatio,
                  gestureRatio: body.gestureRatio, faceTouchRatio: body.faceTouchRatio
              };
              await setDoc(doc(db, "students", studentId), {
                  name: studentName,
                  classCode: studentClassCode,
                  status: "완료",
                  lastDate: new Date().toLocaleString(),
                  lastUpdatedAt: serverTimestamp(),
                  scores,
                  lastPresentation: presentation
              }, { merge: true });
              const assignment = selectedAssignment();
              await addDoc(collection(db, "students", studentId, "sessions"), {
                  mode: 'presentation',
                  assignmentId: assignment?.id || null,
                  assignmentTitle: assignment?.title || '직접 작성한 대본',
                  createdAt: serverTimestamp(),
                  scores,
                  habitCounts: counts,
                  ...presentation
              });
          }
      } catch (err) {
          console.error("Firebase upload error:", err);
      }

  } catch (error) {
      console.error("Analysis Error:", error);
      document.getElementById('report-habits').innerText = `분석 실패`;
      commentEl.innerHTML = '<span class="text-error"></span>';
      commentEl.firstChild.textContent = `오류 발생: 제미나이 분석에 실패했습니다. (${error.message})`;
  }
}

// ==========================================
// 다시 듣기 + 타임라인
// ==========================================
const replaySection = document.getElementById('replay-section');
const replayAudio = document.getElementById('replay-audio');
const replayTimeline = document.getElementById('replay-timeline');
const replayPlayhead = document.getElementById('replay-playhead');
const replaySummary = document.getElementById('replay-summary');
const replayEventList = document.getElementById('replay-events');

const TIMELINE_STYLES = {
    habit: { label: '습관어', color: '#ba1a1a' },
    gaze: { label: '시선 이탈', color: '#3B82F6' },
    posture: { label: '자세 흔들림', color: '#F97316' }
};

const formatTime = (ms) => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

function resetReplay() {
    replayAudio.pause();
    replayAudio.removeAttribute('src');
    if (replayUrl) URL.revokeObjectURL(replayUrl);
    replayUrl = null;
    replaySection.classList.add('hidden');
}

// 해당 시점 조금 앞부터 재생
function playFrom(ms) {
    replayAudio.currentTime = Math.max(0, ms - 1500) / 1000;
    replayAudio.play().catch(() => {});
}

function showReplay(blob) {
    resetReplay();
    replayUrl = URL.createObjectURL(blob);
    replayAudio.src = replayUrl;
    replaySection.classList.remove('hidden');

    const total = Math.max(1, recordingDurationMs);
    const pct = (ms) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;
    const events = timelineEvents.slice().sort((a, b) => a.t - b.t);

    // 타임라인: 구간(시선/자세)은 띠, 습관어는 세로선
    const marks = events.map(ev => {
        const style = TIMELINE_STYLES[ev.type];
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.title = `${formatTime(ev.t)} ${style.label}`;
        mark.style.left = pct(ev.t);
        mark.style.backgroundColor = style.color;
        if (ev.type === 'habit') {
            mark.className = 'absolute top-0 bottom-0 w-1.5 -ml-[3px] z-10';
        } else {
            mark.className = `absolute h-3 opacity-70 ${ev.type === 'gaze' ? 'top-1' : 'bottom-1'}`;
            mark.style.width = `max(4px, calc(${pct(ev.end)} - ${pct(ev.t)}))`;
        }
        mark.addEventListener('click', (e) => { e.stopPropagation(); playFrom(ev.t); });
        return mark;
    });
    replayTimeline.replaceChildren(...marks, replayPlayhead);
    replayPlayhead.style.left = '0%';

    const count = (type) => events.filter(ev => ev.type === type).length;
    replaySummary.textContent = events.length === 0
        ? '표시할 구간이 없어요. 시선과 자세가 안정적이었어요! 👏'
        : `습관어 ${count('habit')}곳 · 시선 이탈 ${count('gaze')}구간 · 자세 흔들림 ${count('posture')}구간 — 표시를 누르면 그 부분부터 들려줘요.`;

    replayEventList.replaceChildren(...events.slice(0, 30).map(ev => {
        const style = TIMELINE_STYLES[ev.type];
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'px-2 py-1 border-2 border-black bg-white text-sm font-bold flex items-center gap-1 hover:bg-surface-variant';
        const dot = document.createElement('span');
        dot.className = 'inline-block w-3 h-3';
        dot.style.backgroundColor = style.color;
        chip.append(dot, `${formatTime(ev.t)} ${style.label}`);
        chip.addEventListener('click', () => playFrom(ev.t));
        return chip;
    }));
}

if (replayAudio) {
    // MediaRecorder로 만든 webm은 길이 정보가 없어(Infinity) 재생바가 동작하지 않으므로 끝으로 한 번 이동해 길이를 계산시킨다
    replayAudio.addEventListener('loadedmetadata', () => {
        if (replayAudio.duration !== Infinity) return;
        replayAudio.addEventListener('durationchange', () => { replayAudio.currentTime = 0; }, { once: true });
        replayAudio.currentTime = 1e101;
    });
    replayAudio.addEventListener('timeupdate', () => {
        replayPlayhead.style.left = `${Math.min(100, (replayAudio.currentTime * 1000 / Math.max(1, recordingDurationMs)) * 100)}%`;
    });
    replayTimeline.addEventListener('click', (e) => {
        const rect = replayTimeline.getBoundingClientRect();
        replayAudio.currentTime = ((e.clientX - rect.left) / rect.width) * recordingDurationMs / 1000;
        replayAudio.play().catch(() => {});
    });
    closeModalBtn.addEventListener('click', () => replayAudio.pause());
}

// ==========================================
// Settings Modal Logic
// ==========================================

async function loadDevices() {
    try {
        // Request permissions first to get device labels
        await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
            stream.getTracks().forEach(t => t.stop());
        }).catch(err => {
            console.warn("Permission not granted yet or no devices: ", err);
        });

        const devices = await navigator.mediaDevices.enumerateDevices();
        
        cameraSelect.innerHTML = '';
        micSelect.innerHTML = '';

        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        const audioDevices = devices.filter(d => d.kind === 'audioinput');

        if (videoDevices.length === 0) cameraSelect.innerHTML = '<option value="">비디오 장치가 없습니다.</option>';
        if (audioDevices.length === 0) micSelect.innerHTML = '<option value="">오디오 장치가 없습니다.</option>';

        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `카메라 ${index + 1}`;
            if (device.deviceId === selectedCameraId) option.selected = true;
            cameraSelect.appendChild(option);
        });

        audioDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `마이크 ${index + 1}`;
            if (device.deviceId === selectedMicId) option.selected = true;
            micSelect.appendChild(option);
        });

    } catch (err) {
        console.error("Error enumerating devices: ", err);
    }
}

settingsBtn.addEventListener('click', async () => {
    await loadDevices();
    settingsModal.classList.remove('hidden');
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

enableTimerToggle.addEventListener('change', (e) => {
    if (e.target.checked) {
        targetTimeInputs.classList.remove('opacity-50', 'pointer-events-none');
    } else {
        targetTimeInputs.classList.add('opacity-50', 'pointer-events-none');
    }
});

saveSettingsBtn.addEventListener('click', () => {
    selectedCameraId = cameraSelect.value;
    selectedMicId = micSelect.value;
    
    if (enableTimerToggle.checked) {
        const minutes = parseInt(targetTimeMin.value) || 0;
        const seconds = parseInt(targetTimeSec.value) || 0;
        targetPresentationSeconds = (minutes * 60) + seconds;
        
        const targetM = String(minutes).padStart(2, '0');
        const targetS = String(seconds).padStart(2, '0');
        targetTimeDisplay.innerText = `${targetM}:${targetS}`;
        
        targetTimeDisplay.classList.remove('hidden');
        timerSeparator.classList.remove('hidden');
    } else {
        targetPresentationSeconds = Infinity;
        targetTimeDisplay.classList.add('hidden');
        timerSeparator.classList.add('hidden');
    }
    
    hideHudActive = hideHudToggle.checked;
    
    // Apply HUD Toggle immediately
    if (hideHudActive) {
        hudLeft.classList.add('opacity-0');
        hudRight.classList.add('opacity-0');
        faceTrackingCanvas.classList.add('opacity-0');
    } else {
        hudLeft.classList.remove('opacity-0');
        hudRight.classList.remove('opacity-0');
        faceTrackingCanvas.classList.remove('opacity-0');
    }
    
    settingsModal.classList.add('hidden');
});

// Firebase Assignment Sync (내 학급에 배포된 가장 최근 대본)
function subscribeAssignments(classCode) {
    const assignmentsQ = query(collection(db, "assignments"), where("classCode", "==", classCode));
    onSnapshot(assignmentsQ, (snapshot) => {
        const firstLoad = knownAssignmentIds === null;
        const previous = new Map(assignments.map(a => [a.id, a]));
        assignments = snapshot.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(a => a.active && a.script && a.mode !== 'reading') // 저학년 낭독 지문 제외
            .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0))
            .map(a => ({ ...a, isNew: !firstLoad && (previous.get(a.id)?.isNew ?? !knownAssignmentIds.has(a.id)) }));
        if (firstLoad) knownAssignmentIds = new Set(assignments.map(a => a.id));
        renderAssignmentOptions();

        // 처음 들어왔을 때는 가장 최근 과제를 선택 (이후 새 과제는 목록에 🆕 표시만)
        if (firstLoad && assignments.length > 0 && !isPresenting && !isEditingScript) {
            assignmentSelect.value = assignments[0].id;
            renderScript(assignments[0].script);
        }
    }, (err) => console.error("Assignment sync error:", err));
}
// Logout
const btnLogout = document.getElementById('btn-logout');
if(btnLogout) {
    btnLogout.addEventListener('click', () => {
        localStorage.removeItem('guestMode');
        signOut(auth).then(() => {
            window.location.replace('login.html');
        });
    });
}
