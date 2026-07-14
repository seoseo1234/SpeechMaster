let mediaStream = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let volumeAnimation = null;
let recognition = null;

let isPresenting = false;
let startTime = 0;
let timerInterval = null;

let habitCounts = {
  uh: 0, // 어
  um: 0, // 음
  geu: 0 // 그
};
let lastRecognizedText = '';
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

// Init
document.addEventListener('DOMContentLoaded', () => {
  setupScriptEditor();
  setupSpeechRecognition();
  
  startBtn.addEventListener('click', startPresentation);
  endBtn.addEventListener('click', endPresentation);
  closeModalBtn.addEventListener('click', () => {
    analysisModal.classList.add('hidden');
  });
  resetHabitBtn.addEventListener('click', resetHabits);
});

function setupScriptEditor() {
  let isEditing = false;
  let lines = [];
  
  // Extract initial text
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
      
      // Update scriptContent from textarea
      const text = scriptEditor.value;
      const paragraphs = text.split('\n\n').filter(p => p.trim() !== '');
      scriptContent.innerHTML = '';
      paragraphs.forEach((p, idx) => {
        const pEl = document.createElement('p');
        pEl.className = 'font-body-lg leading-relaxed text-on-surface text-2xl transition-all duration-500';
        pEl.style.borderLeft = '4px solid transparent';
        pEl.style.paddingLeft = '0px';
        pEl.style.opacity = idx === 0 ? '1' : '0.4'; // Focus first line
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

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('이 브라우저는 실시간 스트리밍 음성 인식을 지원하지 않습니다. Chrome을 사용해주세요.');
    return;
  }
  
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'ko-KR';

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    if (finalTranscript) {
      fullRecognizedText += finalTranscript + ' ';
      checkHabitualWords(finalTranscript);
      updateScriptHighlight(fullRecognizedText);
    }
    
    if (interimTranscript) {
       // Also check interim for immediate feedback, but be careful of double counting
       checkHabitualWords(interimTranscript, true);
    }

    sttResult.innerHTML = `
      <span class="text-on-surface font-medium">${fullRecognizedText}</span>
      <span class="text-on-surface-variant italic opacity-70">${interimTranscript}</span>
    `;
    
    // Auto scroll to bottom
    sttResult.parentElement.scrollTop = sttResult.parentElement.scrollHeight;
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error', event.error);
    // Restart if network or no speech error to keep the live feed going
    if (isPresenting && (event.error === 'no-speech' || event.error === 'network')) {
        try { recognition.stop(); } catch(e){}
    }
  };

  recognition.onend = () => {
    if (isPresenting) {
      // Auto-restart to simulate continuous streaming API
      setTimeout(() => {
        if (isPresenting) {
            try { recognition.start(); } catch(e){}
        }
      }, 500);
    }
  };
}

let lastInterimHabitCheck = '';
function checkHabitualWords(text, isInterim = false) {
  // Simple regex matching for common Korean habitual words
  // "어", "어..", "음", "음..", "그", "그.."
  
  // If interim, we only check new parts to avoid counting the same "어" multiple times
  let textToCheck = text;
  if (isInterim) {
      if (text.startsWith(lastInterimHabitCheck)) {
          textToCheck = text.substring(lastInterimHabitCheck.length);
      }
      lastInterimHabitCheck = text;
  } else {
      lastInterimHabitCheck = ''; // reset on final
  }

  const uhMatch = (textToCheck.match(/\b(어+|아+)\b/g) || []).length;
  const umMatch = (textToCheck.match(/\b(음+|음마+)\b/g) || []).length;
  const geuMatch = (textToCheck.match(/\b(그+|어그+)\b/g) || []).length;

  if (uhMatch > 0) updateHabit('uh', uhMatch);
  if (umMatch > 0) updateHabit('um', umMatch);
  if (geuMatch > 0) updateHabit('geu', geuMatch);
}

function updateHabit(type, count) {
  habitCounts[type] += count;
  
  const elCount = document.getElementById(`count-${type}`);
  const elItem = document.getElementById(`habit-item-${type}`);
  
  elCount.innerText = `${habitCounts[type]}회`;
  
  // Visual feedback: flash red/orange
  if (habitCounts[type] > 0) {
    elItem.classList.replace('bg-surface-container', 'bg-error-container/30');
    elItem.classList.replace('border-outline-variant', 'border-error/20');
    elCount.classList.replace('text-on-surface-variant', 'text-error');
    
    // flash animation
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
  // A simple heuristic to advance script highlighting.
  // In a real complex app, we'd use fuzzy string matching (e.g. Levenshtein distance) 
  // between recognizedText and script lines.
  const paragraphs = Array.from(scriptContent.querySelectorAll('p'));
  if (paragraphs.length === 0) return;

  // Very basic word-matching logic to find which paragraph we are currently at
  let bestMatchIdx = 0;
  let maxMatches = 0;
  
  const recogWords = recognizedText.split(/\s+/).slice(-20); // Look at recent words

  paragraphs.forEach((p, idx) => {
    const pWords = p.innerText.split(/\s+/);
    let matches = 0;
    recogWords.forEach(rw => {
      if (rw.length > 1 && pWords.some(pw => pw.includes(rw))) matches++;
    });
    if (matches > maxMatches) {
      maxMatches = matches;
      bestMatchIdx = idx;
    }
  });

  // Apply visual highlight
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
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    
    // Video
    cameraFeed.srcObject = mediaStream;
    cameraFallback.classList.add('hidden');
    cameraFeed.classList.remove('hidden');
    
    // Audio Context for Volume
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(mediaStream);
    microphone.connect(analyser);
    analyser.fftSize = 256;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    function drawVolume() {
      if (!isPresenting) return;
      volumeAnimation = requestAnimationFrame(drawVolume);
      
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for(let i = 0; i < bufferLength; i++) { sum += dataArray[i]; }
      let average = sum / bufferLength;
      
      // Map average (0-255) to percentage and dB rough estimate
      let percentage = Math.min(100, Math.max(0, (average / 100) * 100));
      let dbEstimate = Math.round(average / 2); // very rough mapping
      
      volumeBar.style.width = `${percentage}%`;
      volumeText.innerText = `${dbEstimate} dB`;
      
      if (percentage > 80) volumeBar.classList.replace('bg-secondary', 'bg-error');
      else volumeBar.classList.replace('bg-error', 'bg-secondary');
    }
    
    isPresenting = true;
    drawVolume();
    
    // STT
    fullRecognizedText = '';
    sttResult.innerHTML = '';
    resetHabits();
    if (recognition) {
        try { recognition.start(); } catch(e){}
    }

    // UI Updates
    startBtn.classList.add('hidden');
    endBtn.classList.remove('hidden');
    
    micStatusIcon.classList.replace('bg-surface-variant', 'bg-primary-container');
    micStatusIcon.classList.add('animate-pulse');
    micStatusIcon.innerHTML = `<span class="material-symbols-outlined text-on-primary-container" style="font-variation-settings: 'FILL' 1;">mic</span>`;
    
    statusDot.classList.replace('bg-surface-variant', 'bg-tertiary-fixed');
    statusDot.classList.add('animate-pulse', 'shadow-[0_0_8px_#96f996]');
    statusText.innerText = '🟢 실시간 분석 중';
    
    startTime = Date.now();
    
  } catch (err) {
    console.error('카메라/마이크 권한 획득 실패:', err);
    alert('카메라와 마이크 권한이 필요합니다. 브라우저 설정에서 허용해주세요.');
  }
}

function endPresentation() {
  isPresenting = false;
  
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    cameraFeed.srcObject = null;
    cameraFeed.classList.add('hidden');
    cameraFallback.classList.remove('hidden');
  }
  if (audioContext) {
    audioContext.close();
  }
  if (volumeAnimation) {
    cancelAnimationFrame(volumeAnimation);
  }
  if (recognition) {
    try { recognition.stop(); } catch(e){}
  }

  // UI Revert
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
