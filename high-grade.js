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
function updateSTTUI(interim = '') {
    sttResult.innerHTML = `<span class="text-on-surface font-medium">${fullRecognizedText}</span> <span class="text-on-surface-variant italic opacity-70">${interim}</span>`;
    sttResult.parentElement.scrollTop = sttResult.parentElement.scrollHeight;
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

    // Start Audio/Video
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    
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
            
            // 실시간 카운터 임시 로직 (브라우저가 잡는 일부라도 반영)
            const transcript = event.results[event.resultIndex][0].transcript;
            const uhMatch = (transcript.match(/\b(어+|아+)\b/g) || []).length;
            const umMatch = (transcript.match(/\b(음+|음마+)\b/g) || []).length;
            const geuMatch = (transcript.match(/\b(그+|어그+)\b/g) || []).length;
            
            if (uhMatch > 0) document.getElementById('count-uh').innerText = (parseInt(document.getElementById('count-uh').innerText) || 0) + uhMatch + '회';
            if (umMatch > 0) document.getElementById('count-um').innerText = (parseInt(document.getElementById('count-um').innerText) || 0) + umMatch + '회';
            if (geuMatch > 0) document.getElementById('count-geu').innerText = (parseInt(document.getElementById('count-geu').innerText) || 0) + geuMatch + '회';
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
    sttResult.innerHTML = '<span class="text-on-surface-variant italic opacity-70">발표를 시작하세요. 실시간으로 음성이 기록됩니다.</span>';

    startBtn.classList.add('hidden');
    startBtn.innerHTML = originalStartText;
    startBtn.classList.remove('opacity-70', 'pointer-events-none');
    endBtn.classList.remove('hidden');
    
    micStatusIcon.classList.replace('bg-surface-variant', 'bg-primary-container');
    micStatusIcon.classList.add('animate-pulse');
    micStatusIcon.innerHTML = `<span class="material-symbols-outlined text-on-primary-container" style="font-variation-settings: 'FILL' 1;">mic</span>`;
    
    statusDot.classList.replace('bg-surface-variant', 'bg-tertiary-fixed');
    statusDot.classList.add('animate-pulse', 'shadow-[0_0_8px_#96f996]');
    statusText.innerText = '🟢 로컬 인식 중';
    
    startTime = Date.now();

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
