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


document.addEventListener('DOMContentLoaded', () => {
  setupScriptEditor();
  
  startBtn.addEventListener('click', startPresentation);
  endBtn.addEventListener('click', endPresentation);
  closeModalBtn.addEventListener('click', () => {
    analysisModal.classList.add('hidden');
  });
  resetHabitBtn.addEventListener('click', resetHabits);
});

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
      editScriptBtn.classList.replace('bg-surface-container', 'bg-primary-container');
      editScriptBtn.classList.add('text-on-primary-container');
    } else {
      scriptEditor.classList.add('hidden');
      scriptContent.style.display = 'block';
      editScriptBtn.innerHTML = `<span class="material-symbols-outlined text-sm">edit</span>대본 수정`;
      editScriptBtn.classList.replace('bg-primary-container', 'bg-surface-container');
      editScriptBtn.classList.remove('text-on-primary-container');
      
      const text = scriptEditor.value;
      const paragraphs = text.split('\n\n').filter(p => p.trim() !== '');
      scriptContent.innerHTML = '';
      paragraphs.forEach((p, idx) => {
        const pEl = document.createElement('p');
        pEl.className = 'font-body-lg leading-relaxed text-on-surface text-2xl transition-all duration-500';
        pEl.style.borderLeft = '4px solid transparent';
        pEl.style.paddingLeft = '0px';
        pEl.style.opacity = idx === 0 ? '1' : '0.4';
        if (idx === 0) {
          pEl.style.borderLeft = '4px solid #0c6780';
          pEl.style.paddingLeft = '16px';
        }
        pEl.innerText = p.trim();
        scriptContent.appendChild(pEl);
      });
    }
  });
}

let interimText = '';

function updateSTTUI() {
    sttResult.innerHTML = `<span class="text-on-surface font-medium">${fullRecognizedText}</span> <span class="text-on-surface-variant italic opacity-70">${interimText}</span>`;
    sttResult.parentElement.scrollTop = sttResult.parentElement.scrollHeight;
}

function handleWebSocketMessage(event) {
    if (event.data === 'ping' || event.data === 'pong') return;
    try {
        const response = JSON.parse(event.data);
        if (response.error) {
            console.error("Clova gRPC Error:", response.error);
            return;
        }

        if (response.responseType && response.responseType.includes('transcription')) {
            const tx = response.transcription;
            if (tx && tx.text) {
                fullRecognizedText += tx.text + ' ';
                interimText = ''; // Clear interim when final arrives
                checkHabitualWords(tx.text);
                updateScriptHighlight(fullRecognizedText);
                updateSTTUI();
            }
        }
    } catch(e) {
        // console.error("Error parsing WebSocket message", e);
    }
}

function checkHabitualWords(text) {
  const uhMatch = (text.match(/\b(어+|아+)\b/g) || []).length;
  const umMatch = (text.match(/\b(음+|음마+)\b/g) || []).length;
  const geuMatch = (text.match(/\b(그+|어그+)\b/g) || []).length;

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
    elItem.classList.replace('bg-surface-container', 'bg-error-container/30');
    elItem.classList.replace('border-outline-variant', 'border-error/20');
    elCount.classList.replace('text-on-surface-variant', 'text-error');
    
    elItem.classList.add('scale-105');
    setTimeout(() => elItem.classList.remove('scale-105'), 200);
  }
}

function resetHabits() {
  habitCounts = { uh: 0, um: 0, geu: 0 };
  ['uh', 'um', 'geu'].forEach(type => {
    document.getElementById(`count-${type}`).innerText = '0회';
    const elItem = document.getElementById(`habit-item-${type}`);
    elItem.classList.replace('bg-error-container/30', 'bg-surface-container');
    elItem.classList.replace('border-error/20', 'border-outline-variant');
    document.getElementById(`count-${type}`).classList.replace('text-error', 'text-on-surface-variant');
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
      p.style.borderLeft = '4px solid #0c6780';
      p.style.paddingLeft = '16px';
    } else {
      p.style.opacity = '0.4';
      p.style.borderLeft = '4px solid transparent';
      p.style.paddingLeft = '0px';
    }
  });
}

async function startPresentation() {
  const originalStartText = startBtn.innerHTML;
  try {
    startBtn.innerHTML = `<span class="material-symbols-outlined animate-spin" style="animation-duration: 2s;">sync</span> <span id="start-btn-text">연결 중...</span>`;
    startBtn.classList.add('opacity-70', 'pointer-events-none');

    // 1. WebSocket connect
    ws = new WebSocket('ws://localhost:3001');
    ws.onopen = async () => {
        ws.send(JSON.stringify({ action: 'start' }));

        // 2. Start Audio/Video
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: {
            channelCount: 1,
            sampleRate: 16000
        }});
        
        // 2.5 Start WebKit Speech Recognition for real-time typing effect
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'ko-KR';
            recognition.onresult = (event) => {
                let currentInterim = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (!event.results[i].isFinal) {
                        currentInterim += event.results[i][0].transcript;
                    }
                }
                interimText = currentInterim;
                updateSTTUI();
            };
            try { recognition.start(); } catch(e){}
        }

        cameraFeed.srcObject = mediaStream;
        cameraFallback.classList.add('hidden');
        cameraFeed.classList.remove('hidden');
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await audioContext.audioWorklet.addModule(workletUrl);
        
        microphone = audioContext.createMediaStreamSource(mediaStream);
        audioWorkletNode = new AudioWorkletNode(audioContext, 'resampler-processor');
        
        audioWorkletNode.port.onmessage = (event) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                // Send PCM Int16 buffer
                ws.send(event.data);
            }
        };

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        microphone.connect(analyser);
        microphone.connect(audioWorkletNode);
        // Note: we don't connect audioWorkletNode to destination to avoid feedback
        
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        function drawVolume() {
            if (!isPresenting) return;
            volumeAnimation = requestAnimationFrame(drawVolume);
            
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for(let i = 0; i < bufferLength; i++) { sum += dataArray[i]; }
            let average = sum / bufferLength;
            
            let percentage = Math.min(100, Math.max(0, (average / 100) * 100));
            let dbEstimate = Math.round(average / 2);
            
            volumeBar.style.width = `${percentage}%`;
            volumeText.innerText = `${dbEstimate} dB`;
            
            if (percentage > 80) volumeBar.classList.replace('bg-secondary', 'bg-error');
            else volumeBar.classList.replace('bg-error', 'bg-secondary');
        }
        
        isPresenting = true;
        drawVolume();
        
        fullRecognizedText = '';
        sttResult.innerHTML = '<span class="text-on-surface-variant italic opacity-70">서버에 연결되었습니다. 인식 중...</span>';
        resetHabits();

        startBtn.classList.add('hidden');
        startBtn.innerHTML = originalStartText;
        startBtn.classList.remove('opacity-70', 'pointer-events-none');
        endBtn.classList.remove('hidden');
        
        micStatusIcon.classList.replace('bg-surface-variant', 'bg-primary-container');
        micStatusIcon.classList.add('animate-pulse');
        micStatusIcon.innerHTML = `<span class="material-symbols-outlined text-on-primary-container" style="font-variation-settings: 'FILL' 1;">mic</span>`;
        
        statusDot.classList.replace('bg-surface-variant', 'bg-tertiary-fixed');
        statusDot.classList.add('animate-pulse', 'shadow-[0_0_8px_#96f996]');
        statusText.innerText = '🟢 스트리밍 연결됨';
        
        startTime = Date.now();
    };

    ws.onmessage = handleWebSocketMessage;
    ws.onclose = () => {
        console.log("WebSocket connection closed.");
    };

  } catch (err) {
    console.error('시작 오류:', err);
    startBtn.innerHTML = originalStartText;
    startBtn.classList.remove('opacity-70', 'pointer-events-none');
    alert('카메라/마이크 접근 권한이 없거나 서버(ws://localhost:3001)에 연결할 수 없습니다. server.js가 실행 중인지 확인해주세요.');
  }
}

function endPresentation() {
  isPresenting = false;
  
  if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'stop' }));
      ws.close();
  }
  
  if (typeof recognition !== 'undefined' && recognition) {
      try { recognition.stop(); } catch(e){}
  }
  
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    cameraFeed.srcObject = null;
    cameraFeed.classList.add('hidden');
    cameraFallback.classList.remove('hidden');
  }
  
  if (audioWorkletNode) {
      audioWorkletNode.disconnect();
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

  startBtn.classList.remove('hidden');
  endBtn.classList.add('hidden');
  
  micStatusIcon.classList.replace('bg-primary-container', 'bg-surface-variant');
  micStatusIcon.classList.remove('animate-pulse');
  micStatusIcon.innerHTML = `<span class="material-symbols-outlined text-on-surface-variant" style="font-variation-settings: 'FILL' 1;">mic_off</span>`;
  
  statusDot.classList.replace('bg-tertiary-fixed', 'bg-surface-variant');
  statusDot.classList.remove('animate-pulse', 'shadow-[0_0_8px_#96f996]');
  statusText.innerText = '대기 중';
  
  volumeBar.style.width = '0%';
  volumeText.innerText = '0 dB';

  showAnalysisModal();
}

function showAnalysisModal() {
  const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');
  
  document.getElementById('report-time').innerText = `${minutes}:${seconds}`;
  
  const totalHabits = habitCounts.uh + habitCounts.um + habitCounts.geu;
  document.getElementById('report-habits').innerText = `총 ${totalHabits}회`;
  
  const commentEl = document.getElementById('report-comment');
  if (totalHabits === 0) {
    commentEl.innerText = '완벽합니다! 습관어를 단 한 번도 사용하지 않고 유창하게 발표했어요. 최고 수준의 발표력입니다.';
    commentEl.classList.add('text-primary');
  } else if (totalHabits < 5) {
    commentEl.innerText = '아주 훌륭한 발표였습니다! 집중력이 대단하네요. 한두 번의 작은 버벅임만 줄이면 아나운서 같을 거예요.';
  } else {
    commentEl.innerText = `발표 중에 '${Object.keys(habitCounts).reduce((a, b) => habitCounts[a] > habitCounts[b] ? a : b) === 'uh' ? '어..' : '음..'}'와 같은 말을 무의식적으로 자주 씁니다. 침묵을 두려워하지 말고 잠깐 쉬어가는 연습을 해보세요!`;
  }
  
  analysisModal.classList.remove('hidden');
}
