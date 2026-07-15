import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";

let faceLandmarker;
let lastVideoTime = -1;
let previousPosition = null;
let movementHistory = [];
const MOVEMENT_WINDOW_SIZE = 30;
const SHAKING_THRESHOLD = 3.0;
let faceTrackingAnimation = null;

let mediaStream = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let volumeAnimation = null;
let audioWorkletNode = null;

let ws = null;
let isPresenting = false;
let startTime = 0;

let recognition = null;
let mediaRecorder = null;
let audioChunks = [];

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
let totalSpeed = 0, speedCount = 0;
let totalShaking = 0, shakingCount = 0;
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
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
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

function setupScriptEditor() {
  let isEditing = false;
  
  const pTags = scriptContent.querySelectorAll('p');
  let initialText = Array.from(pTags).map(p => p.innerText.trim()).join('\n\n');
  scriptEditor.value = initialText;

  editScriptBtn.addEventListener('click', () => {
    if (isPresenting) {
      alert('발표 중에는 대본을 수정할 수 없습니다.');
      return;
    }
    
    isEditing = !isEditing;
    if (isEditing) {
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
      const paragraphs = text.split('\n\n').filter(p => p.trim() !== '');
      scriptContent.innerHTML = '';
      paragraphs.forEach((p, idx) => {
        const pEl = document.createElement('p');
        pEl.className = 'font-body-lg leading-relaxed text-on-surface text-2xl transition-all duration-500';
        pEl.style.borderLeft = '8px solid transparent';
        pEl.style.paddingLeft = '0px';
        pEl.style.opacity = idx === 0 ? '1' : '0.2';
        if (idx === 0) {
          pEl.style.borderLeft = '8px solid #3B82F6';
          pEl.style.paddingLeft = '16px';
        }
        pEl.innerText = p.trim();
        scriptContent.appendChild(pEl);
      });
    }
  });
}

let interimText = '';
function updateSTTUI(interim = '') {
    sttResult.innerHTML = `<span class="text-on-surface font-medium">${fullRecognizedText}</span> <span class="text-on-surface-variant italic opacity-70">${interim}</span>`;
    sttResult.parentElement.scrollTop = sttResult.parentElement.scrollHeight;
}

function checkHabitualWords(text) {
  // JS의 \b는 한글을 단어 문자로 인식하지 않으므로 공백 및 기호를 기준으로 찾습니다.
  const uhMatch = (text.match(/(^|\s)(어+|아+|어\.\.\.)(?=\s|[.,?!]|$)/g) || []).length;
  const umMatch = (text.match(/(^|\s)(음+|음마+|음\.\.\.)(?=\s|[.,?!]|$)/g) || []).length;
  const geuMatch = (text.match(/(^|\s)(그+|어그+|그\.\.\.)(?=\s|[.,?!]|$)/g) || []).length;

  if (uhMatch > 0) updateHabit('uh', uhMatch);
  if (umMatch > 0) updateHabit('um', umMatch);
  if (geuMatch > 0) updateHabit('geu', geuMatch);
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

function predictWebcam() {
    if (!isPresenting) return;
    
    if (faceLandmarker && cameraFeed.readyState >= 2) {
        let startTimeMs = performance.now();
        if (lastVideoTime !== cameraFeed.currentTime) {
            lastVideoTime = cameraFeed.currentTime;
            const results = faceLandmarker.detectForVideo(cameraFeed, startTimeMs);
            
            if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                // 1. 회전 각도 판별
                let isLookingFront = true;
                if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
                    const matrix = results.facialTransformationMatrixes[0].data;
                    const r00 = matrix[0], r10 = matrix[1], r20 = matrix[2];
                    const r01 = matrix[4], r11 = matrix[5], r21 = matrix[6];
                    const r02 = matrix[8], r12 = matrix[9], r22 = matrix[10];

                    const sy = Math.sqrt(r00 * r00 + r10 * r10);
                    const singular = sy < 1e-6;
                    
                    let x, y;
                    if (!singular) {
                        x = Math.atan2(r21, r22);
                        y = Math.atan2(-r20, sy);
                    } else {
                        x = Math.atan2(-r12, r11);
                        y = Math.atan2(-r20, sy);
                    }

                    let pitch = x * 180 / Math.PI;
                    let yaw = y * 180 / Math.PI;
                    
                    // 대본을 읽어야 하므로 시선(고개 회전) 판별 기준 완화 (좌우 상하 15도)
                    isLookingFront = Math.abs(yaw) < 15 && Math.abs(pitch) < 15;
                }

                // 2. 머리 흔들림 정량화
                const noseTip = results.faceLandmarks[0][1];
                const currentPosition = { x: noseTip.x, y: noseTip.y, z: noseTip.z };
                
                let movement = 0;
                if (previousPosition) {
                    const dx = currentPosition.x - previousPosition.x;
                    const dy = currentPosition.y - previousPosition.y;
                    const dz = currentPosition.z - previousPosition.z;
                    movement = Math.sqrt(dx*dx + dy*dy + dz*dz);
                }
                previousPosition = currentPosition;

                movementHistory.push(movement);
                if (movementHistory.length > MOVEMENT_WINDOW_SIZE) {
                    movementHistory.shift();
                }
                
                // 얼굴 인식 브래킷 그리기 (캔버스)
                const faceCanvas = document.getElementById('face-tracking-canvas');
                if (faceCanvas) {
                    faceCanvas.width = cameraFeed.videoWidth;
                    faceCanvas.height = cameraFeed.videoHeight;
                    const ctx = faceCanvas.getContext('2d');
                    ctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
                    
                    const landmarks = results.faceLandmarks[0];
                    let minX = 1, minY = 1, maxX = 0, maxY = 0;
                    for(let l of landmarks) {
                        if(l.x < minX) minX = l.x;
                        if(l.x > maxX) maxX = l.x;
                        if(l.y < minY) minY = l.y;
                        if(l.y > maxY) maxY = l.y;
                    }
                    const bx = minX * faceCanvas.width;
                    const by = minY * faceCanvas.height;
                    const bw = (maxX - minX) * faceCanvas.width;
                    const bh = (maxY - minY) * faceCanvas.height;

                    const cornerSize = 20;
                    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)'; // Electric blue
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    // Top-left
                    ctx.moveTo(bx, by + cornerSize); ctx.lineTo(bx, by); ctx.lineTo(bx + cornerSize, by);
                    // Top-right
                    ctx.moveTo(bx + bw - cornerSize, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cornerSize);
                    // Bottom-left
                    ctx.moveTo(bx, by + bh - cornerSize); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cornerSize, by + bh);
                    // Bottom-right
                    ctx.moveTo(bx + bw - cornerSize, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cornerSize);
                    ctx.stroke();
                    
                    // 코 끝 타겟 십자선
                    const nx = noseTip.x * faceCanvas.width;
                    const ny = noseTip.y * faceCanvas.height;
                    ctx.beginPath();
                    ctx.moveTo(nx - 5, ny); ctx.lineTo(nx + 5, ny);
                    ctx.moveTo(nx, ny - 5); ctx.lineTo(nx, ny + 5);
                    ctx.stroke();
                }

                const totalMovement = movementHistory.reduce((acc, val) => acc + val, 0);
                const shakingScore = totalMovement * 100;

                let isShaking = shakingScore > SHAKING_THRESHOLD;
                
                // 상태 표시 및 우측 피드백 텍스트 독립적 업데이트
                const feedbackPosture = document.getElementById('feedback-posture');
                const feedbackGaze = document.getElementById('feedback-gaze');

                // 발표 자세 피드백 (흔들림 기반)
                if (feedbackPosture) {
                    if (isShaking) {
                        feedbackPosture.innerText = '불안정';
                        feedbackPosture.className = 'text-base font-black text-error';
                    } else {
                        feedbackPosture.innerText = '자신감 있음';
                        feedbackPosture.className = 'text-base font-black text-[#96f996]';
                    }
                }

                // 시선 처리 피드백 (고개 각도 + 눈동자 기반)
                if (feedbackGaze) {
                    if (!isLookingFront) {
                        feedbackGaze.innerText = '시선 이탈';
                        feedbackGaze.className = 'text-base font-black text-error';
                        outOfGazeCount++;
                    } else {
                        feedbackGaze.innerText = '우수';
                        feedbackGaze.className = 'text-base font-black text-[#96f996]';
                    }
                }
                
                totalShaking += shakingScore;
                shakingCount++;
                totalGazeFrames++;

                // 좌측 상단 메인 상태 표시기 업데이트
                if (isShaking) {
                    statusText.innerText = '⚠️ 산만함 감지!';
                    statusDot.className = 'w-3 h-3 bg-error border border-black rounded-none';
                } else if (!isLookingFront) {
                    statusText.innerText = '👀 시선 이탈';
                    statusDot.className = 'w-3 h-3 bg-secondary border border-black rounded-none';
                } else {
                    statusText.innerText = '🟢 정면 주시 중';
                    statusDot.className = 'w-3 h-3 bg-tertiary border border-black rounded-none animate-pulse';
                }
                
                // 제스쳐 이력 업데이트
                gestureHistory.push(shakingScore);
                gestureHistory.shift();
                drawHUDGraph(gestureGraphCtx, gestureHistory, '#3B82F6'); // Electric Blue
                
            } else {
                statusText.innerText = '얼굴 인식 불가';
                statusDot.className = 'w-3 h-3 bg-surface-variant border border-black rounded-none';
                
                const faceCanvas = document.getElementById('face-tracking-canvas');
                if (faceCanvas) {
                    const ctx = faceCanvas.getContext('2d');
                    ctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
                }
            }
        }
    }
    faceTrackingAnimation = window.requestAnimationFrame(predictWebcam);
}

async function startPresentation() {
  const originalStartText = startBtn.innerHTML;
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
                
                totalSpeed += speed;
                speedCount++;
            }
        };
        try { recognition.start(); } catch(e){}
    }

    // Record audio for Gemini
    audioChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.start(1000); // chunk every second

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
    totalSpeed = 0; speedCount = 0;
    totalShaking = 0; shakingCount = 0;
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
    previousPosition = null;
    movementHistory = [];
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
    startBtn.innerHTML = originalStartText;
    startBtn.classList.remove('opacity-70', 'pointer-events-none');
    alert('오류 발생: ' + err.message + '\n(카메라/마이크 권한을 확인해주세요)');
  }
}

function endPresentation() {
  isPresenting = false;
  
  if (recognition) {
      try { recognition.stop(); } catch(e){}
  }
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
  }
  
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
  
  if (audioChunks.length === 0) {
      document.getElementById('report-habits').innerText = `오디오 없음`;
      commentEl.innerHTML = `녹음된 오디오가 없어 분석을 수행할 수 없습니다.`;
      return;
  }

  try {
      // Create audio blob
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      
      const avgTone = toneCount > 0 ? Math.round(totalTone / toneCount) : 0;
      const avgSpeed = speedCount > 0 ? Math.round(totalSpeed / speedCount) : 0;
      const avgShaking = shakingCount > 0 ? Math.round(totalShaking / shakingCount) : 0;
      const gazeScore = totalGazeFrames > 0 ? Math.round((1 - outOfGazeCount / totalGazeFrames) * 100) : 0;
      
      formData.append('avgTone', avgTone);
      formData.append('avgSpeed', avgSpeed);
      formData.append('avgShaking', avgShaking);
      formData.append('gazeScore', gazeScore);
      formData.append('audio', audioBlob, 'recording.webm');

      // Send to local server which then calls Gemini
      const response = await fetch('http://localhost:3001/analyze-audio', {
          method: 'POST',
          body: formData
      });

      if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
      }

      const result = await response.json();
      
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
      
      commentEl.innerHTML = result.feedback;

  } catch (error) {
      console.error("Analysis Error:", error);
      document.getElementById('report-habits').innerText = `분석 실패`;
      commentEl.innerHTML = `<span class="text-error">오류 발생: 제미나이 분석에 실패했습니다. (${error.message})</span>`;
  }
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
