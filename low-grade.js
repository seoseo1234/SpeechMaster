import { askGemini, assessPronunciation } from './apiClient.js';
import { createLevelMeter, micName, MIC_HELP } from './micCheck.js';
import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, addDoc, collection, query, where, onSnapshot, serverTimestamp } from 'firebase/firestore';

const isGuestMode = localStorage.getItem('guestMode') === 'true';
let studentProfile = null; // { uid, name, classCode } - 로그인한 학생만

// 레벨·경험치·오답 노트: 로그인한 학생은 Firestore(students/{uid}.readingProgress)에 저장해
// 기기를 바꿔도 이어지고 공용 기기에서 다른 학생 기록과 섞이지 않는다. 둘러보기는 이 기기에만 저장.
const MAX_WRONG_WORDS = 50;
let currentLevel = 1;
let currentXp = 0;
let wrongWords = [];
let onProgressLoaded = () => {}; // 화면 준비 후 레벨 표시 갱신 함수로 교체됨
let onAssignmentsChanged = () => {}; // 화면 준비 후 과제 목록 갱신 함수로 교체됨

if (isGuestMode) {
  currentLevel = parseInt(localStorage.getItem('speechbuddy_level')) || 1;
  currentXp = parseInt(localStorage.getItem('speechbuddy_xp')) || 0;
  wrongWords = JSON.parse(localStorage.getItem('speechbuddy_wrong_words')) || [];
}

let saveProgressTimer = null;
function saveProgress() {
  if (!studentProfile) {
    if (!isGuestMode) return;
    localStorage.setItem('speechbuddy_level', currentLevel);
    localStorage.setItem('speechbuddy_xp', currentXp);
    localStorage.setItem('speechbuddy_wrong_words', JSON.stringify(wrongWords));
    return;
  }
  // 연속 호출(경험치 + 오답 추가 등)은 한 번에 저장
  clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(async () => {
    try {
      await setDoc(doc(db, 'students', studentProfile.uid), {
        name: studentProfile.name,
        classCode: studentProfile.classCode,
        readingProgress: { level: currentLevel, xp: currentXp, wrongWords }
      }, { merge: true });
    } catch (e) {
      console.error('Reading progress save error:', e);
    }
  }, 500);
}

// 교사가 배포한 저학년 낭독 지문
let readingAssignments = [];
let readingAssignmentsReceived = false;
function subscribeReadingAssignments(classCode) {
  const q = query(collection(db, 'assignments'), where('classCode', '==', classCode));
  onSnapshot(q, (snapshot) => {
    readingAssignments = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(a => a.active && a.script && a.mode === 'reading')
      .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
    readingAssignmentsReceived = true;
    onAssignmentsChanged();
  }, (err) => console.error('Assignment sync error:', err));
}

onAuthStateChanged(auth, async (user) => {
  if ((!user || user.isAnonymous) && !isGuestMode) {
    window.location.replace('login.html');
    return;
  }
  if (user && !user.isAnonymous && !isGuestMode) {
    try {
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (userDoc.exists() && userDoc.data().role === 'student') {
        const data = userDoc.data();
        studentProfile = { uid: user.uid, name: data.name || user.displayName || '', classCode: data.classCode };
        const studentDoc = await getDoc(doc(db, 'students', user.uid));
        const progress = studentDoc.exists() ? studentDoc.data().readingProgress : null;
        if (progress) {
          currentLevel = progress.level || 1;
          currentXp = progress.xp || 0;
          wrongWords = progress.wrongWords || [];
        }
        onProgressLoaded();
        if (data.classCode) subscribeReadingAssignments(data.classCode);
      }
    } catch (e) {
      console.error('Profile load error:', e);
    }
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let targetSentence = "로딩 중...";
let currentMode = 'story'; // 'story' | 'practice' | 'finished'
let practiceAttemptCount = 0;
let recommendedWordsCache = "";
let worstWordCache = "";

// Session variables
let sessionQuestionCount = 1;
let sessionHistory = []; 
let sessionResults = []; // 문제별 마지막 결과 { score, fluency }
let currentQuestionStarEligible = true;
const xpMax = 100;

let appSettings = JSON.parse(localStorage.getItem('speechbuddy_settings')) || {
  name: '',
  fairy: 'acorn',
  theme: 'default',
  sound: true
};
const successAudio = new Audio('https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3');

function playSuccessSound() {
  if (appSettings.sound) {
    successAudio.currentTime = 0;
    successAudio.play().catch(()=>{});
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  function updateLevelDisplay() {
    const levelNumber = document.getElementById('level-number');
    if (levelNumber) levelNumber.innerText = currentLevel;
    updateLevelSpeakerIcon();
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-20 left-1/2 transform -translate-x-1/2 bg-primary text-white px-6 py-4 rounded-full shadow-2xl font-bold text-xl z-50 transition-opacity duration-500 flex items-center gap-2 border-4 border-outline-variant';
    toast.innerHTML = `<span class="material-symbols-outlined">celebration</span> ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  function gainXp(amount) {
    currentXp += amount;
    let levelChanged = false;
    while (currentXp >= xpMax) {
      currentXp -= xpMax;
      currentLevel++;
      levelChanged = true;
    }
    saveProgress();
    if (levelChanged) {
      showToast(`🎉 레벨 업! 현재 레벨 ${currentLevel} 🎉`);
      updateLevelSpeakerIcon();
    }
    updateLevelDisplay();
  }

  function updateLevelSpeakerIcon() {
    const levelIcon = document.getElementById('level-icon');
    const levelContainer = document.getElementById('level-container');
    if (!levelIcon || !levelContainer) return;

    let iconName = 'stars';
    let bgClass = '';

    const bgColors = [
      'bg-red-500', 
      'bg-orange-500', 
      'bg-yellow-400', 
      'bg-green-500', 
      'bg-blue-500', 
      'bg-indigo-500', 
      'bg-purple-500'
    ];

    if (currentLevel >= 150) {
      iconName = 'favorite';
      bgClass = 'bg-gradient-to-r from-violet-500 via-blue-500 to-red-500 animate-pulse';
    } else if (currentLevel >= 80) {
      iconName = 'favorite';
      const colorIndex = Math.floor((currentLevel - 80) / 10) % bgColors.length;
      bgClass = bgColors[colorIndex];
    } else if (currentLevel >= 70) {
      iconName = 'stars';
      bgClass = 'bg-gradient-to-r from-violet-500 via-blue-500 to-red-500 animate-pulse';
    } else {
      iconName = 'stars';
      const colorIndex = Math.floor(Math.max(0, currentLevel - 1) / 10) % bgColors.length;
      bgClass = bgColors[colorIndex];
    }

    levelIcon.innerText = iconName;
    levelContainer.className = `text-white px-4 py-2 rounded-full font-label-lg flex items-center gap-2 transition-colors duration-500 ${bgClass}`;
    levelIcon.style.fontVariationSettings = "'FILL' 1";
  }

  updateLevelDisplay();
  onProgressLoaded = updateLevelDisplay;

  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettings = document.getElementById('close-settings');
  const notesBtn = document.getElementById('notes-btn');
  const notesModal = document.getElementById('notes-modal');
  const closeNotes = document.getElementById('close-notes');

  const userNameInput = document.getElementById('user-name-input');
  const soundToggle = document.getElementById('sound-toggle');
  const themeBtns = document.querySelectorAll('.theme-btn');
  const fairyRadios = document.querySelectorAll('input[name="fairy"]');
  const wrongWordsList = document.getElementById('wrong-words-list');
  const clearNotesBtn = document.getElementById('clear-notes-btn');

  // Load Settings
  if (userNameInput) userNameInput.value = appSettings.name;
  if (soundToggle) soundToggle.checked = appSettings.sound;
  const activeFairyRadio = document.querySelector(`input[name="fairy"][value="${appSettings.fairy}"]`);
  if (activeFairyRadio) activeFairyRadio.checked = true;
  applyTheme(appSettings.theme);
  
  const activeThemeBtn = document.querySelector(`.theme-btn[data-theme="${appSettings.theme}"]`);
  if (activeThemeBtn) {
    themeBtns.forEach(b => {
      b.classList.remove('border-outline-variant');
      b.classList.add('border-transparent');
    });
    activeThemeBtn.classList.remove('border-transparent');
    activeThemeBtn.classList.add('border-outline-variant');
  }

  function saveSettings() {
    localStorage.setItem('speechbuddy_settings', JSON.stringify(appSettings));
  }

  function applyTheme(theme) {
    const htmlElement = document.documentElement;
    htmlElement.className = 'light'; 
    if (theme === 'mint') {
      htmlElement.style.setProperty('--color-surface', '#e0f7fa');
      htmlElement.style.setProperty('--color-surface-container-lowest', '#b2ebf2');
    } else if (theme === 'pink') {
      htmlElement.style.setProperty('--color-surface', '#fce4ec');
      htmlElement.style.setProperty('--color-surface-container-lowest', '#f8bbd0');
    } else {
      htmlElement.style.setProperty('--color-surface', '#fbfaee');
      htmlElement.style.setProperty('--color-surface-container-lowest', '#ffffff');
    }
  }

  if (userNameInput) userNameInput.addEventListener('input', (e) => {
    appSettings.name = e.target.value;
    saveSettings();
    updateNameUI();
  });
  if (soundToggle) soundToggle.addEventListener('change', (e) => {
    appSettings.sound = e.target.checked;
    saveSettings();
  });
  fairyRadios.forEach(r => r.addEventListener('change', (e) => {
    appSettings.fairy = e.target.value;
    saveSettings();
    updateFairyUI();
  }));
  themeBtns.forEach(btn => btn.addEventListener('click', (e) => {
    appSettings.theme = e.currentTarget.dataset.theme;
    saveSettings();
    applyTheme(appSettings.theme);
    
    // Update active border
    themeBtns.forEach(b => {
      b.classList.remove('border-outline-variant');
      b.classList.add('border-transparent');
    });
    e.currentTarget.classList.remove('border-transparent');
    e.currentTarget.classList.add('border-outline-variant');
  }));

  function updateNameUI() {
    const headerTitle = document.querySelector('h1.font-headline-md');
    if (headerTitle) {
      if (appSettings.name) {
        headerTitle.innerText = `${appSettings.name}의 스피치버디 (저학년 모드)`;
      } else {
        headerTitle.innerText = `AI 스피치버디 (저학년 모드)`;
      }
    }
  }
  updateNameUI();

  function updateFairyUI() {
    const fairyImg = document.getElementById('fairy-img');
    const fairyName = document.getElementById('fairy-name');
    if (!fairyImg || !fairyName) return;

    if (appSettings.fairy === 'star') {
      fairyImg.src = '/star_fairy.png';
      fairyName.innerText = '별 요정';
    } else if (appSettings.fairy === 'cloud') {
      fairyImg.src = '/cloud_fairy.png';
      fairyName.innerText = '구름 요정';
    } else {
      fairyImg.src = '/acorn_fairy.png';
      fairyName.innerText = '도토리 요정';
    }
  }
  updateFairyUI();

  if (settingsBtn) settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
  if (closeSettings) closeSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
  
  if (notesBtn) notesBtn.addEventListener('click', () => {
    renderWrongWords();
    notesModal.classList.remove('hidden');
  });
  if (closeNotes) closeNotes.addEventListener('click', () => notesModal.classList.add('hidden'));

  function addWrongWord(word) {
    if (!word) return;
    if (!wrongWords.includes(word)) {
      wrongWords.push(word);
      if (wrongWords.length > MAX_WRONG_WORDS) wrongWords = wrongWords.slice(-MAX_WRONG_WORDS);
      saveProgress();
    }
  }

  // 오답 노트 단어를 연습해서 통과하면 노트에서 지운다
  function removeWrongWord(word) {
    if (!wrongWords.includes(word)) return;
    wrongWords = wrongWords.filter(w => w !== word);
    saveProgress();
  }

  function renderWrongWords() {
    if (!wrongWordsList) return;
    wrongWordsList.innerHTML = '';
    if (wrongWords.length === 0) {
      wrongWordsList.innerHTML = '<p class="text-center text-outline py-8 font-body-lg">아직 오답 기록이 없어요!</p>';
      return;
    }
    wrongWords.forEach(w => {
      const div = document.createElement('div');
      div.className = 'flex items-center justify-between bg-surface-container-low p-4 rounded-xl border border-outline-variant';
      div.innerHTML = `
        <span class="font-headline-md text-xl">${escapeHtml(w)}</span>
        <button class="practice-word-btn px-4 py-2 bg-secondary text-on-secondary rounded-lg font-bold hover:bg-secondary-dark transition-colors" data-word="${escapeHtml(w)}">연습하기</button>
      `;
      wrongWordsList.appendChild(div);
    });

    document.querySelectorAll('.practice-word-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const w = e.target.dataset.word;
        notesModal.classList.add('hidden');
        currentMode = 'practice';
        practiceAttemptCount = 0;
        targetSentence = w;
        worstWordCache = w;
        renderSentence(targetSentence);
        if (recommendationBox) recommendationBox.style.display = 'none';
        if (feedbackSection) feedbackSection.style.display = 'none';
        micText.innerText = '연습 시작하기';
        micIcon.innerText = 'mic';
      });
    });
  }

  if (clearNotesBtn) clearNotesBtn.addEventListener('click', () => {
    wrongWords = [];
    saveProgress();
    renderWrongWords();
  });

  const micBtn = document.getElementById('mic-btn');
  const micIcon = document.getElementById('mic-icon');
  const micText = document.getElementById('mic-text');
  const recordingStatus = document.getElementById('recording-status');
  
  const storyBox = document.getElementById('story-box');
  const feedbackSection = document.getElementById('feedback-section');
  const feedbackText = document.getElementById('feedback-text');
  const feedbackDetail = document.getElementById('feedback-detail');
  
  const recommendationBox = document.getElementById('recommendation-box');
  const recommendationText = document.getElementById('recommendation-text');
  const practiceBtn = document.getElementById('practice-btn');

  // Function to render letter-box UI
  const liveTranscript = document.getElementById('live-transcript');
  const liveTranscriptText = document.getElementById('live-transcript-text');

  // spoken: 녹음 중 실시간 자막으로 읽은 것으로 확인된 단어 위치(Set)
  function renderSentence(text, highlightHtml = null, spoken = null) {
    if (highlightHtml) {
      storyBox.innerHTML = highlightHtml;
      return;
    }
    if (!spoken) liveTranscript.classList.add('hidden'); // 새 문장이면 이전 자막 숨김
    let html = '';
    const words = text.split(' ');
    words.forEach((w, idx) => {
      const cls = spoken?.has(idx) ? 'letter-box spoken' : 'letter-box';
      for (let char of w) {
        html += `<span class="${cls}">${escapeHtml(char)}</span>`;
      }
      if (idx < words.length - 1) html += '<span class="mx-4"></span>';
    });
    storyBox.innerHTML = html;
  }

  practiceBtn.addEventListener('click', () => {
    currentMode = 'practice';
    practiceAttemptCount = 0;
    targetSentence = recommendedWordsCache;
    renderSentence(targetSentence);
    recommendationBox.style.display = 'none';
    feedbackSection.style.display = 'none';
    micText.innerText = '연습 시작하기';
    micIcon.innerText = 'mic';
  });

  let isRecording = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;

  // 실시간 자막: 녹음하는 동안 브라우저 음성 인식으로 학생이 말한 말을 바로 보여준다.
  // (발음 점수는 지금처럼 녹음이 끝난 뒤 클로바 평가로 매김. 지원하지 않는 브라우저는 자막만 생략)
  const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  let liveRecognition = null;
  let liveHeardWords = null; // 이번 녹음에서 실시간 자막으로 바르게 들린 단어 위치 (자막을 못 쓰면 null)

  const cleanWord = (w) => w.replace(/[^\p{L}\p{N}]/gu, '');
  const wordsMatch = (target, heard) => target && heard && (
    target === heard ||
    (heard.length >= 2 && (target.startsWith(heard) || heard.startsWith(target))) ||
    (target.length >= 2 && heard.length >= 2 && target.slice(0, 2) === heard.slice(0, 2))
  );

  // 들린 단어를 지문 단어와 순서대로 맞춰 본다 (한두 단어를 건너뛰어도 따라가도록 앞의 3단어까지 비교)
  function matchSpokenWords(target, heardText) {
    const targetWords = target.split(' ').map(cleanWord);
    const heardWords = heardText.split(/\s+/).map(cleanWord).filter(Boolean);
    const spoken = new Set();
    let next = 0;
    heardWords.forEach(h => {
      for (let k = next; k < Math.min(next + 3, targetWords.length); k++) {
        if (wordsMatch(targetWords[k], h)) {
          spoken.add(k);
          next = k + 1;
          break;
        }
      }
    });
    return spoken;
  }

  function startLiveTranscript() {
    liveHeardWords = null;
    if (!SpeechRecognitionApi) return;
    const rec = new SpeechRecognitionApi();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';

    liveTranscriptText.textContent = '듣고 있어요... 👂';
    liveTranscriptText.classList.add('opacity-50');
    liveTranscript.classList.remove('hidden');

    rec.onresult = (event) => {
      if (liveRecognition !== rec) return; // 녹음이 끝난 뒤 늦게 온 결과는 무시
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text + ' ';
        else interim += text;
      }
      const heard = (finalText + interim).trim();
      if (!heard) return;
      liveHeardWords = matchSpokenWords(targetSentence, heard);
      liveTranscriptText.textContent = heard;
      liveTranscriptText.classList.remove('opacity-50');
      renderSentence(targetSentence, null, liveHeardWords);
    };
    rec.onerror = (event) => {
      // 권한/네트워크 문제면 자막만 끄고 녹음과 평가는 계속
      if (['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(event.error)) {
        console.warn('Live transcript unavailable:', event.error);
        if (liveRecognition === rec) liveRecognition = null;
        liveTranscript.classList.add('hidden');
      }
    };
    // 잠깐 조용하면 인식이 스스로 끝나므로 녹음 중이면 다시 시작
    rec.onend = () => {
      if (isRecording && liveRecognition === rec) {
        try { rec.start(); } catch (e) {}
      }
    };
    liveRecognition = rec;
    try { rec.start(); } catch (e) {}
  }

  function stopLiveTranscript() {
    const rec = liveRecognition;
    liveRecognition = null;
    if (rec) {
      try { rec.stop(); } catch (e) {}
    }
    // 아무 말도 인식되지 않았으면 자막 상자를 숨김
    if (liveTranscriptText.classList.contains('opacity-50')) liveTranscript.classList.add('hidden');
  }

  // 과제 지문을 고르면 그 지문을 문장 단위로 나눠 차례로 읽는다 (안 고르면 AI 추천 문장 10개)
  const MAX_ASSIGNMENT_SENTENCES = 20;
  const assignmentPicker = document.getElementById('reading-assignment-picker');
  const assignmentSelect = document.getElementById('reading-assignment-select');
  let sessionSentences = null;
  let sessionTotal = 10;
  let sentenceRequestId = 0;
  let assignmentsLoaded = false;

  function splitSentences(text) {
    return text.split(/\n+|(?<=[.!?])\s+/).map(t => t.trim()).filter(Boolean).slice(0, MAX_ASSIGNMENT_SENTENCES);
  }

  function selectedReadingAssignment() {
    return readingAssignments.find(a => a.id === assignmentSelect.value) || null;
  }

  function updateSessionTitle() {
    const sessionTitle = document.getElementById('session-title');
    if (!sessionTitle) return;
    const assignment = selectedReadingAssignment();
    const label = assignment ? `📌 ${assignment.title || '선생님 과제'}` : '오늘의 문장 읽기';
    sessionTitle.innerText = `${label} (${sessionQuestionCount}/${sessionTotal})`;
  }

  function renderSessionStars() {
    const starsContainer = document.getElementById('session-stars');
    if (!starsContainer) return;
    starsContainer.replaceChildren(...Array.from({ length: sessionTotal }, () => {
      const star = document.createElement('span');
      star.textContent = 'star';
      star.style.fontVariationSettings = "'FILL' 1";
      return star;
    }));
    updateSessionStarsUI();
  }

  function renderAssignmentOptions() {
    const current = assignmentSelect.value;
    const options = [new Option('✨ AI 추천 문장', '')];
    readingAssignments.forEach(a => {
      const d = a.createdAt?.toDate?.();
      const date = d ? ` (${d.getMonth() + 1}/${d.getDate()})` : '';
      options.push(new Option(`📌 ${a.title || '선생님 과제'}${date}`, a.id));
    });
    assignmentSelect.replaceChildren(...options);
    assignmentSelect.value = readingAssignments.some(a => a.id === current) ? current : '';
    assignmentPicker.classList.toggle('hidden', readingAssignments.length === 0);
  }

  onAssignmentsChanged = () => {
    const firstLoad = !assignmentsLoaded;
    assignmentsLoaded = true;
    const previous = assignmentSelect.value;
    renderAssignmentOptions();
    // 처음 들어왔을 때 과제가 있고 아직 시작 전이면 가장 최근 과제로 시작
    const untouched = sessionQuestionCount === 1 && sessionResults.length === 0 && !isRecording;
    if (firstLoad && readingAssignments.length > 0 && untouched) {
      assignmentSelect.value = readingAssignments[0].id;
      startSession();
    } else if (previous && !assignmentSelect.value && !isRecording) {
      startSession(); // 보던 과제가 삭제/비활성화됨
    }
  };

  if (readingAssignmentsReceived) onAssignmentsChanged();

  let activeAssignmentId = '';
  assignmentSelect.addEventListener('change', () => {
    if (isRecording) {
      alert('녹음 중에는 지문을 바꿀 수 없습니다. 먼저 정지해주세요.');
      assignmentSelect.value = activeAssignmentId;
      return;
    }
    startSession();
  });

  async function startSession() {
    const assignment = selectedReadingAssignment();
    activeAssignmentId = assignment?.id || '';
    sessionSentences = assignment ? splitSentences(assignment.script) : null;
    if (sessionSentences && sessionSentences.length === 0) sessionSentences = null;
    sessionTotal = sessionSentences ? sessionSentences.length : 10;

    document.getElementById('result-modal').classList.add('hidden');
    sessionQuestionCount = 1;
    sessionHistory = [];
    sessionResults = [];
    currentQuestionStarEligible = true;
    renderSessionStars();

    currentMode = 'story';
    if (skipBtn) skipBtn.style.display = 'flex';
    renderSentence("새로운 지문을 불러오는 중입니다... ⏳");
    if (feedbackSection) feedbackSection.style.display = 'none';
    if (recommendationBox) recommendationBox.style.display = 'none';
    micText.innerText = '누르고 말하기';
    micIcon.innerText = 'mic';
    micBtn.classList.replace('chunky-button-primary', 'chunky-button-secondary');
    updateSessionTitle();

    await generateNewSentence();
  }

  async function nextQuestion() {
    if (sessionQuestionCount >= sessionTotal) {
      showResultModal();
      return;
    }
    
    sessionQuestionCount++;
    currentQuestionStarEligible = true;
    if (skipBtn) skipBtn.style.display = 'flex';
    
    currentMode = 'story';
    renderSentence("새로운 지문을 불러오는 중입니다... ⏳");
    if (feedbackSection) feedbackSection.style.display = 'none';
    if (recommendationBox) recommendationBox.style.display = 'none';
    micText.innerText = '누르고 말하기';
    micIcon.innerText = 'mic';
    micBtn.classList.replace('chunky-button-primary', 'chunky-button-secondary');
    
    updateSessionTitle();
    
    await generateNewSentence();
  }

  const skipBtn = document.getElementById('skip-btn');
  if (skipBtn) {
    skipBtn.addEventListener('click', async () => {
      if (isRecording) {
        alert('녹음 중에는 건너뛸 수 없습니다. 먼저 정지해주세요.');
        return;
      }
      
      if (!sessionHistory[sessionQuestionCount - 1]) {
        sessionHistory[sessionQuestionCount - 1] = 'none';
        updateSessionStarsUI();
      }
      
      await nextQuestion();
    });
  }

  micBtn.addEventListener('click', async () => {
    if (currentMode === 'finished') {
      await nextQuestion();
      return;
    }

    if (isRecording) {
      stopRecording();
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      const meter = createLevelMeter(stream);
      const recordingMic = micName(stream);

      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const hasSound = meter.hasSound();
        meter.stop();
        if (!hasSound) {
          // 무음이면 분석하지 않고 마이크 점검 안내
          micText.innerText = '다시 해보기';
          micIcon.innerText = 'replay';
          alert(`마이크에서 소리가 들리지 않았어요. 🎤\n\n사용 중인 마이크: ${recordingMic}\n\n${MIC_HELP}`);
          return;
        }
        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        processAudio(audioBlob);
      };

      mediaRecorder.start();
      isRecording = true;
      
      // Update UI for recording state
      recordingStatus.classList.remove('hidden');
      micText.innerText = '말하는 중...';
      micIcon.innerText = 'stop';
      micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
      micBtn.style.backgroundColor = '#ba1a1a';
      micBtn.style.boxShadow = '0 6px 0 0 #93000a';

      feedbackSection.style.display = 'none';
      renderSentence(targetSentence);
      startLiveTranscript();

    } catch (err) {
      console.error(err);
      if (err.name === 'NotFoundError') {
        alert('연결된 마이크를 찾을 수 없어요. 마이크를 연결한 뒤 다시 시도해주세요.');
      } else {
        alert(`마이크 접근 권한이 필요합니다.\n\n${MIC_HELP}`);
      }
    }
  });

  renderSentence("새로운 지문을 불러오는 중입니다... ⏳");
  renderSessionStars();
  updateSessionTitle();

  // Generate initial sentence using Gemini
  await generateNewSentence();

  async function generateNewSentence() {
    const requestId = ++sentenceRequestId;
    if (sessionSentences) {
      targetSentence = sessionSentences[sessionQuestionCount - 1];
      renderSentence(targetSentence);
      return;
    }
    let text;
    try {
      text = (await askGemini('sentence')).replace(/^"|"$/g, '');
    } catch(e) {
      console.error(e);
      text = "예쁜 꽃밭에 나비가 날아왔습니다.";
    }
    // 기다리는 사이 과제 지문으로 바뀌었으면 무시
    if (requestId !== sentenceRequestId) return;
    targetSentence = text;
    renderSentence(targetSentence);
  }

  function stopRecording() {
    isRecording = false;
    stopLiveTranscript();
    mediaRecorder.stop();
    stream.getTracks().forEach(track => track.stop());

    micText.innerText = 'AI 분석 중...';
    micIcon.innerText = 'hourglass_empty';
    
    // Restore styling
    recordingStatus.classList.add('hidden');
    micBtn.style.backgroundColor = '';
    micBtn.style.boxShadow = '';
    micBtn.classList.replace('chunky-button-primary', 'chunky-button-secondary');
  }

  async function processAudio(audioBlob) {
    try {
      const data = await assessPronunciation(audioBlob, targetSentence);

      const recognizedText = data.text;
      const details = data.assessment_details;
      const usrGraph = data.usr_graph || [];
      console.info('[CLOVA 발음 평가]', { score: data.assessment_score, recognizedText, details });

      const parsed = parseAssessmentDetails(details, targetSentence, liveHeardWords);
      const score = Math.max(data.assessment_score || 0, parsed.score ?? 0);
      const highlightedText = parsed.html || `<span class="text-error font-bold">음성이 인식되지 않았습니다.</span>`;
      
      const fluency = calculateFluency(usrGraph);
      if (currentMode === 'story') {
        sessionResults[sessionQuestionCount - 1] = { score: score || 0, fluency: fluency.score };
      }

      if (score >= 80) {
        playSuccessSound();
      }
      if (score < 80 && parsed.worstWord) {
        addWrongWord(parsed.worstWord);
      }

      // Restore button text
      micText.innerText = '다시 해보기';
      micIcon.innerText = 'replay';
      micBtn.classList.replace('chunky-button-primary', 'chunky-button-secondary');

      // Update story box with highlighted letters
      renderSentence(targetSentence, highlightedText);

      // Update Progress Bar
      const progressBar = document.getElementById('progress-bar');
      progressBar.style.width = `${Math.min(100, Math.max(0, score))}%`;
      const progressText = document.getElementById('progress-text');
      progressText.innerHTML = `발음 정확도: <strong class="${score >= 80 ? 'text-tertiary' : 'text-error'}">${score || 0}점</strong> | 리듬감(유창성): <strong class="${fluency.score >= 80 ? 'text-tertiary' : 'text-error'}">${fluency.score}점</strong>`;

      feedbackSection.style.display = 'block';

      let feedbackMsg = "";
      let detailMsg = "";

      if (currentMode === 'practice') {
        practiceAttemptCount++;
        if (score >= 80) {
          removeWrongWord(targetSentence);
          feedbackMsg = `우와, 정말 대단해! 오늘 어려운 글자 '${worstWordCache}'(을)를 완벽하게 마스터했어! 발음 점수 ${score}점!`;
          detailMsg = `요정이 ${score}점을 주었어요! 이제 어떤 단어든 자신감 있게 읽을 수 있어요.`;
          currentMode = 'finished';
          if (skipBtn) skipBtn.style.display = 'none';
          micText.innerText = '새로운 지문 도전하기';
          micIcon.innerText = 'stars';
          micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
          
          if (!sessionHistory[sessionQuestionCount - 1]) {
            sessionHistory[sessionQuestionCount - 1] = 'silver';
            updateSessionStarsUI();
          }
        } else if (practiceAttemptCount >= 2) {
          feedbackMsg = `두 번이나 열심히 도전하다니 정말 멋져! 연습 단어는 여기까지 하고, 다음 이야기로 넘어가 볼까?`;
          detailMsg = `노력 점수로 별 요정이 칭찬 스티커를 주었어요! 다음 문장으로 넘어갈 수 있어요.`;
          currentMode = 'finished';
          if (skipBtn) skipBtn.style.display = 'none';
          micText.innerText = '새로운 지문 도전하기';
          micIcon.innerText = 'stars';
          micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
          
          if (!sessionHistory[sessionQuestionCount - 1]) {
            sessionHistory[sessionQuestionCount - 1] = 'none';
            updateSessionStarsUI();
          }
        } else {
          feedbackMsg = `거의 다 왔어! 연습 단어들을 조금만 더 뚜렷하게 다시 읽어볼까? (남은 기회: 1번)`;
          detailMsg = `현재 점수: ${score}점. 천천히 한 글자씩 또박또박 소리 내어 보세요!`;
        }
      } else {
        if (score >= 90 && fluency.score >= 90) {
          feedbackMsg = `우와! 발음도 정말 완벽하고 끊어 읽기도 아나운서처럼 자연스러웠어! 100점 만점!`;
          detailMsg = `어려운 발음도 훌륭하게 소화했고, 중간에 부자연스러운 멈춤 없이 완벽한 리듬으로 읽었어요.`;
          
          currentMode = 'finished';
          if (skipBtn) skipBtn.style.display = 'none';
          micText.innerText = '새로운 지문 도전하기';
          micIcon.innerText = 'stars';
          micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
          
          if (!sessionHistory[sessionQuestionCount - 1]) {
            sessionHistory[sessionQuestionCount - 1] = currentQuestionStarEligible ? 'gold' : 'silver';
            updateSessionStarsUI();
          }
        } else if (score >= 80) {
          if (fluency.pauseCount > 0) {
            feedbackMsg = `발음은 아주 좋았어! 하지만 중간에 너무 길게 쉬어간 곳이 ${fluency.pauseCount}번 있었네. 물 흐르듯 자연스럽게 이어서 읽어볼까?`;
            detailMsg = parsed.worstWord
              ? `가장 헷갈려 했던 단어는 '${parsed.worstWord}'예요. 유창성 점수는 ${fluency.score}점입니다.`
              : `모든 단어를 또박또박 잘 읽었어요. 유창성 점수는 ${fluency.score}점입니다.`;
          } else if (parsed.worstWord) {
            feedbackMsg = `참 잘했어! '${parsed.worstWord}' 부분만 한 번 더 또박또박 읽어보면 완벽할 것 같아!`;
            detailMsg = `전체적으로 훌륭하지만 '${parsed.worstWord}' 발음이 살짝 아쉬웠어요. 유창성 점수는 ${fluency.score}점입니다.`;
          } else {
            feedbackMsg = `참 잘했어! 모든 단어를 또박또박 읽었어!`;
            detailMsg = `조금만 더 또렷하게 읽으면 만점이에요. 유창성 점수는 ${fluency.score}점입니다.`;
          }
          
          currentMode = 'finished';
          if (skipBtn) skipBtn.style.display = 'none';
          micText.innerText = '새로운 지문 도전하기';
          micIcon.innerText = 'stars';
          micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
          
          if (!sessionHistory[sessionQuestionCount - 1]) {
            sessionHistory[sessionQuestionCount - 1] = currentQuestionStarEligible ? 'gold' : 'silver';
            updateSessionStarsUI();
          }
        } else {
          currentQuestionStarEligible = false;
          feedbackMsg = `어려운 단어가 있었나 보네! 별 요정이랑 천천히 처음부터 다시 읽어보자!`;
          if (parsed.worstWord) {
            detailMsg = `가장 헷갈려 했던 단어는 '${parsed.worstWord}'예요. 이 부분의 발음이 뭉개지거나 다르게 읽혔습니다. 유창성 점수는 ${fluency.score}점입니다.`;
          } else {
            detailMsg = `유창성 점수는 ${fluency.score}점입니다. 전체적으로 속도를 늦추고 또박또박 읽는 연습이 필요해요.`;
          }
        }
      }
      
      feedbackText.innerText = `"${feedbackMsg}"`;
      if (feedbackDetail) feedbackDetail.innerText = detailMsg;
      feedbackSection.scrollIntoView({ behavior: 'smooth' });

      // Apply XP
      if (score >= 90) gainXp(15);
      else if (score >= 80) gainXp(10);
      else gainXp(5);

      // Gemini Word Recommendation (Only in Story Mode)
      if (recommendationBox) {
        recommendationBox.style.display = 'none';
        practiceBtn.style.display = 'none';
      }
      
      if (currentMode === 'story' && parsed.worstWord && recommendationBox) {
        worstWordCache = parsed.worstWord;
        recommendationText.innerText = "단어 추천을 생성하고 있습니다... ⏳";
        recommendationBox.style.display = 'block';
        
        const fallbackWords = [`${parsed.worstWord}와`, `${parsed.worstWord}를`, `${parsed.worstWord}도`];
        
        try {
          recommendedWordsCache = await askGemini('words', { word: parsed.worstWord });
        } catch (e) {
          console.error("Gemini API Error", e);
          recommendedWordsCache = fallbackWords.join(", ");
        }
        
        recommendationText.innerText = `${recommendedWordsCache}`;
        practiceBtn.style.display = 'flex';
      }

    } catch (err) {
      console.error(err);
      alert('API 호출 중 오류가 발생했습니다. 브라우저 콘솔을 확인해주세요.');
      micText.innerText = '다시 해보기';
      micIcon.innerText = 'replay';
    }
  }

  function updateSessionStarsUI() {
    const starsContainer = document.getElementById('session-stars');
    if (!starsContainer) return;
    
    const starElements = starsContainer.querySelectorAll('span');
    starElements.forEach((el, index) => {
      const state = sessionHistory[index];
      if (state === 'gold') {
        el.className = 'material-symbols-outlined text-yellow-400 text-2xl';
      } else if (state === 'silver') {
        el.className = 'material-symbols-outlined text-green-400 text-2xl';
      } else if (state === 'none') {
        el.className = 'material-symbols-outlined text-red-400 text-2xl';
      } else {
        el.className = 'material-symbols-outlined text-outline-variant text-2xl';
      }
    });
  }

  function showResultModal() {
    const modal = document.getElementById('result-modal');
    if (!modal) return;
    
    let totalStars = 0;
    sessionHistory.forEach(s => {
      if (s === 'gold' || s === 'silver') totalStars++;
    });

    let rank = 'F';
    let xpBonus = 0;
    const starRatio = totalStars / sessionTotal;
    if (starRatio >= 1) { rank = 'A'; xpBonus = 50; }
    else if (starRatio >= 0.8) { rank = 'B'; xpBonus = 30; }
    else if (starRatio >= 0.6) { rank = 'C'; xpBonus = 20; }
    else if (starRatio >= 0.4) { rank = 'D'; xpBonus = 10; }
    else if (starRatio >= 0.2) { rank = 'E'; xpBonus = 5; }
    
    document.getElementById('result-rank').innerText = rank;
    document.getElementById('result-detail').innerText = `총 ${totalStars}개의 별을 획득했어요!\n보너스 XP: +${xpBonus}점`;
    
    const starsContainer = document.getElementById('result-stars');
    starsContainer.innerHTML = '';
    for (let i = 0; i < totalStars; i++) {
      starsContainer.innerHTML += `<span class="material-symbols-outlined text-yellow-400 text-3xl" style="font-variation-settings: 'FILL' 1;">star</span>`;
    }

    if (xpBonus > 0) gainXp(xpBonus);

    modal.classList.remove('hidden');
    saveReadingSession(totalStars);
  }

  // 낭독 세션 결과를 교사 대시보드용으로 저장 (로그인한 학생만)
  async function saveReadingSession(totalStars) {
    const results = sessionResults.filter(Boolean);
    if (!studentProfile || results.length === 0) return;
    
    const avg = (key) => Math.round(results.reduce((sum, r) => sum + r[key], 0) / results.length);
    const assignment = selectedReadingAssignment();
    const reading = {
      assignmentId: assignment?.id || null,
      assignmentTitle: assignment?.title || 'AI 추천 문장',
      avgScore: avg('score'),
      avgFluency: avg('fluency'),
      stars: totalStars,
      questionCount: results.length,
      wrongWords: wrongWords.slice(-5)
    };
    
    try {
      await setDoc(doc(db, 'students', studentProfile.uid), {
        name: studentProfile.name,
        classCode: studentProfile.classCode,
        status: '완료',
        accuracy: reading.avgScore,
        lastDate: new Date().toLocaleString(),
        lastUpdatedAt: serverTimestamp(),
        scores: { pronunciation: reading.avgScore },
        lastReading: reading
      }, { merge: true });
      await addDoc(collection(db, 'students', studentProfile.uid, 'sessions'), {
        mode: 'reading',
        createdAt: serverTimestamp(),
        ...reading
      });
    } catch (e) {
      console.error('Reading session save error:', e);
    }
  }

  const restartSessionBtn = document.getElementById('restart-session-btn');
  if (restartSessionBtn) restartSessionBtn.addEventListener('click', startSession);

  // CLOVA 발음 평가 결과를 지문의 글자 하나하나에 맞춘다.
  // assessment_details 예: "봄바람|{봄(bom):100, 바(p͈ɑ):100, 람(lɑm):97} 이|{이(i):98}"
  // 조사('이' 등)를 따로 떼어 주므로 단어 이름이 아니라 글자 순서로 맞춰야 엉뚱한 단어에 점수가 붙지 않는다.
  // heard: 실시간 자막에서 바르게 들린 단어 위치(Set). 자막과 CLOVA가 모두 확인해야 틀렸다고 표시한다.
  const GOOD_SCORE = 85; // 이 이상이면 잘 읽은 글자/단어
  const BAD_SCORE = 70;  // 이보다 낮으면 틀린 글자

  function parseAssessmentDetails(detailsStr, sentence, heard = null) {
    const syllables = [...(detailsStr || '').matchAll(/([^\s,{}|(]+)\([^)]*\):\s*(\d+)/g)]
      .map(m => ({ char: m[1], score: Number(m[2]) }));
    if (syllables.length === 0) return { html: '', worstWord: '', score: null };

    let next = 0;
    const words = sentence.split(' ').map((w, idx) => {
      const chars = [...w].map(ch => {
        if (!/[\p{L}\p{N}]/u.test(ch)) return { ch, score: null }; // 문장부호
        // CLOVA가 글자를 빠뜨려도 밀리지 않도록 앞의 3글자 안에서 같은 글자를 찾는다
        for (let k = next; k < Math.min(next + 3, syllables.length); k++) {
          if (syllables[k].char === ch) {
            next = k + 1;
            return { ch, score: syllables[k].score };
          }
        }
        return { ch, score: null };
      });
      const scored = chars.filter(c => c.score != null);
      const score = scored.length ? scored.reduce((sum, c) => sum + c.score, 0) / scored.length : null;
      return { text: cleanWord(w), chars, score, heardOk: !!heard?.has(idx) };
    });

    // 가장 헷갈린 단어: CLOVA 점수가 낮고, 실시간 자막에서도 바르게 들리지 않은 단어 중 가장 낮은 것
    const useHeard = heard && heard.size > 0;
    const worst = words
      .filter(w => w.score != null && w.score < GOOD_SCORE && !(useHeard && w.heardOk))
      .sort((a, b) => a.score - b.score)[0];

    let html = '';
    words.forEach((w, idx) => {
      w.chars.forEach(c => {
        let cls = '';
        if (c.score != null) {
          if (c.score >= GOOD_SCORE) cls = 'highlight-green';
          else if (w === worst || (c.score < BAD_SCORE && !(useHeard && w.heardOk))) cls = 'highlight-red';
        }
        html += `<span class="letter-box ${cls}">${escapeHtml(c.ch)}</span>`;
      });
      if (idx < words.length - 1) html += '<span class="mx-4"></span>';
    });

    // 전체 점수: 자막으로 바르게 들린 단어는 최소 GOOD_SCORE로 보고 글자 수만큼 가중 평균 (CLOVA 점수보다 낮아지지는 않음)
    let score = null;
    if (useHeard) {
      let total = 0, count = 0;
      words.forEach(w => {
        const n = w.chars.filter(c => c.score != null).length;
        if (!n) return;
        total += (w.heardOk ? Math.max(w.score, GOOD_SCORE) : w.score) * n;
        count += n;
      });
      if (count) score = Math.round(total / count);
    }

    return { html, worstWord: worst?.text || '', score };
  }

  function calculateFluency(usrGraph) {
    if (!usrGraph || !usrGraph.length) return { score: 100, pauseCount: 0 };
    
    // Increase noise threshold to 20 to ignore background noise and mic static
    const NOISE_THRESHOLD = 20;
    // Decrease pause threshold to 15 samples (approx 300ms) to catch stuttering and slow reading
    const PAUSE_THRESHOLD_SAMPLES = 15;
    
    let startIndex = 0;
    while(startIndex < usrGraph.length && usrGraph[startIndex] < NOISE_THRESHOLD) startIndex++;
    let endIndex = usrGraph.length - 1;
    while(endIndex >= 0 && usrGraph[endIndex] < NOISE_THRESHOLD) endIndex--;
    
    if (startIndex >= endIndex) return { score: 100, pauseCount: 0 }; 
    
    let pauseCount = 0;
    let currentSilenceLength = 0;
    
    for (let i = startIndex; i <= endIndex; i++) {
      if (usrGraph[i] < NOISE_THRESHOLD) {
        currentSilenceLength++;
      } else {
        if (currentSilenceLength >= PAUSE_THRESHOLD_SAMPLES) pauseCount++;
        currentSilenceLength = 0;
      }
    }
    // Account for trailing silence within the bounds
    if (currentSilenceLength >= PAUSE_THRESHOLD_SAMPLES) pauseCount++;
    
    let score = 100;
    if (pauseCount === 1) score = 90;
    else if (pauseCount === 2) score = 80;
    else if (pauseCount === 3) score = 70;
    else if (pauseCount >= 4) score = 60;
    
    // Calculate Reading Speed (Characters Per Second)
    // 50 samples = 1 second
    const durationSeconds = (endIndex - startIndex) / 50;
    // Count characters excluding spaces
    const charCount = targetSentence.replace(/\s/g, '').length;
    const charsPerSecond = charCount / durationSeconds;
    
    // If reading is very slow (less than 1.5 characters per second), apply penalty
    if (durationSeconds > 1 && charsPerSecond < 1.5) {
      score -= 15;
      if (score < 0) score = 0;
    }
    
    return { score, pauseCount };
  }
});
