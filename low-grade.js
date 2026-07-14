// Import environment variables via Vite
const invokeUrl = import.meta.env.VITE_CLOVA_INVOKE_URL;
const secretKey = import.meta.env.VITE_CLOVA_SECRET_KEY;
const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;

let targetSentence = "로딩 중...";
let currentMode = 'story'; // 'story' | 'practice' | 'finished'
let practiceAttemptCount = 0;
let recommendedWordsCache = "";
let worstWordCache = "";

document.addEventListener('DOMContentLoaded', async () => {
  let currentLevel = parseInt(localStorage.getItem('speechbuddy_level')) || 1;
  let currentXp = parseInt(localStorage.getItem('speechbuddy_xp')) || 0;

  function updateLevelDisplay() {
    const levelDisplay = document.querySelector('.bg-tertiary-container');
    if (levelDisplay) {
      levelDisplay.innerHTML = `레벨 ${currentLevel} <span class="material-symbols-outlined">trending_up</span>`;
    }
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
    const requiredXp = currentLevel * 50;
    if (currentXp >= requiredXp) {
      currentLevel++;
      currentXp -= requiredXp;
      localStorage.setItem('speechbuddy_level', currentLevel);
      localStorage.setItem('speechbuddy_xp', currentXp);
      updateLevelDisplay();
      showToast(`축하합니다! 레벨 ${currentLevel}(으)로 올랐어요!`);
    } else {
      localStorage.setItem('speechbuddy_xp', currentXp);
    }
  }

  updateLevelDisplay();

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
  function renderSentence(text, highlightHtml = null) {
    if (highlightHtml) {
      storyBox.innerHTML = highlightHtml;
      return;
    }
    let html = '';
    const words = text.split(' ');
    words.forEach((w, idx) => {
      for (let char of w) {
        html += `<span class="letter-box">${char}</span>`;
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

  micBtn.addEventListener('click', async () => {
    if (currentMode === 'finished') {
      currentMode = 'story';
      renderSentence("새로운 지문을 불러오는 중입니다... ⏳");
      feedbackSection.style.display = 'none';
      recommendationBox.style.display = 'none';
      micText.innerText = '누르고 말하기';
      micIcon.innerText = 'mic';
      await generateNewSentence();
      return;
    }

    if (isRecording) {
      stopRecording();
      return;
    }

    if (!invokeUrl || !secretKey) {
      alert('.env 파일에 VITE_CLOVA_INVOKE_URL과 VITE_CLOVA_SECRET_KEY를 설정해주세요.');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        processAudio(audioBlob, invokeUrl, secretKey);
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

    } catch (err) {
      alert('마이크 접근 권한이 필요합니다.');
      console.error(err);
    }
  });

  renderSentence("새로운 지문을 불러오는 중입니다... ⏳");

  // Generate initial sentence using Gemini
  await generateNewSentence();

  async function generateNewSentence() {
    if (!geminiKey) {
      targetSentence = "아기 다람쥐가 나무 위로 쪼르르 올라갔습니다.";
      renderSentence(targetSentence);
      return;
    }
    
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: "초등학교 저학년(1~3학년) 국어 교과서 수준의 동화책 지문이나 교육적인 문장 1개를 만들어줘. 발음 연습하기 좋게 길이는 20자 내외로 짧게 해줘. 부가 설명 없이 문장만 딱 출력해." }]
          }]
        })
      });
      if (response.ok) {
        const data = await response.json();
        targetSentence = data.candidates[0].content.parts[0].text.trim().replace(/^"|"$/g, '');
      } else {
        targetSentence = "바람이 시원하게 불어옵니다.";
      }
    } catch(e) {
      targetSentence = "예쁜 꽃밭에 나비가 날아왔습니다.";
    }
    renderSentence(targetSentence);
  }

  function stopRecording() {
    isRecording = false;
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

  async function processAudio(audioBlob, url, secret) {
    let rawUrl = url;
    let requestOptions = {};

    if (url.endsWith('/stt')) {
      // Short sentence API (/recog/v1/stt) requires query params & octet-stream
      const queryParams = new URLSearchParams({
        lang: 'Kor',
        assessment: 'true',
        graph: 'true',
        utterance: targetSentence
      });
      rawUrl = `${url}?${queryParams.toString()}`;
      
      requestOptions = {
        method: 'POST',
        headers: {
          'X-CLOVASPEECH-API-KEY': secret,
          'Content-Type': 'application/octet-stream'
        },
        body: audioBlob
      };
    } else {
      // Standard upload API requires multipart/form-data
      const formData = new FormData();
      formData.append('media', audioBlob, 'record.webm');
      formData.append('params', JSON.stringify({
        language: 'ko-KR',
        completion: 'sync',
        assessment: true,
        graph: true,
        utterance: targetSentence
      }));
      
      if (!url.endsWith('/upload')) {
        rawUrl = `${url}/recognizer/upload`;
      }
      
      requestOptions = {
        method: 'POST',
        headers: { 'X-CLOVASPEECH-API-KEY': secret },
        body: formData
      };
    }

    // Proxy request through Vite to avoid CORS issues
    let proxiedUrl = rawUrl;
    try {
      const urlObj = new URL(rawUrl);
      proxiedUrl = `/api/clova${urlObj.pathname}${urlObj.search}`;
    } catch(e) {}

    try {
      const response = await fetch(proxiedUrl, requestOptions);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'API Error');
      }

      const score = data.assessment_score;
      const recognizedText = data.text;
      const details = data.assessment_details;
      const usrGraph = data.usr_graph || [];
      
      const parsed = parseAssessmentDetails(details, targetSentence);
      const highlightedText = parsed.html || `<span class="text-error font-bold">음성이 인식되지 않았습니다.</span>`;
      
      const fluency = calculateFluency(usrGraph);

      // Restore button text
      micText.innerText = '다시 해보기';
      micIcon.innerText = 'replay';

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
          feedbackMsg = `우와, 정말 대단해! 오늘 어려운 글자 '${worstWordCache}'(을)를 완벽하게 마스터했어! 발음 점수 ${score}점!`;
          detailMsg = `요정이 ${score}점을 주었어요! 이제 어떤 단어든 자신감 있게 읽을 수 있어요.`;
          currentMode = 'finished';
          micText.innerText = '새로운 지문 도전하기';
          micIcon.innerText = 'stars';
          micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
        } else if (practiceAttemptCount >= 2) {
          feedbackMsg = `두 번이나 열심히 도전하다니 정말 멋져! 연습 단어는 여기까지 하고, 다음 이야기로 넘어가 볼까?`;
          detailMsg = `노력 점수로 별 요정이 칭찬 스티커를 주었어요! 다음 문장으로 넘어갈 수 있어요.`;
          currentMode = 'finished';
          micText.innerText = '새로운 지문 도전하기';
          micIcon.innerText = 'stars';
          micBtn.classList.replace('chunky-button-secondary', 'chunky-button-primary');
        } else {
          feedbackMsg = `거의 다 왔어! 연습 단어들을 조금만 더 뚜렷하게 다시 읽어볼까? (남은 기회: 1번)`;
          detailMsg = `현재 점수: ${score}점. 천천히 한 글자씩 또박또박 소리 내어 보세요!`;
        }
      } else {
        if (score >= 90 && fluency.score >= 90) {
          feedbackMsg = `우와! 발음도 정말 완벽하고 끊어 읽기도 아나운서처럼 자연스러웠어! 100점 만점!`;
          detailMsg = `어려운 발음도 훌륭하게 소화했고, 중간에 부자연스러운 멈춤 없이 완벽한 리듬으로 읽었어요.`;
        } else if (score >= 80) {
          if (fluency.pauseCount > 0) {
            feedbackMsg = `발음은 아주 좋았어! 하지만 중간에 너무 길게 쉬어간 곳이 ${fluency.pauseCount}번 있었네. 물 흐르듯 자연스럽게 이어서 읽어볼까?`;
            detailMsg = `가장 헷갈려 했던 단어는 '${parsed.worstWord}'예요. 유창성 점수는 ${fluency.score}점입니다.`;
          } else {
            feedbackMsg = `참 잘했어! '${parsed.worstWord}' 부분만 한 번 더 또박또박 읽어보면 완벽할 것 같아!`;
            detailMsg = `전체적으로 훌륭하지만 '${parsed.worstWord}' 발음이 살짝 아쉬웠어요. 유창성 점수는 ${fluency.score}점입니다.`;
          }
        } else {
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
        
        if (geminiKey) {
          try {
            const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{
                  parts: [{
                    text: `초등학교 저학년 학생이 '${parsed.worstWord}'라는 단어를 발음하기 어려워해. 이 단어와 발음 원리나 구조(예: 겹받침, 연음 등)가 유사해서 발음 연습하기 좋은 '두 글자 이상'의 단어 3개를 쉼표로 구분해서 말해줘. (예: 한 글자 단어는 절대 안 됨). 부가 설명 없이 딱 단어 3개만 출력해.`
                  }]
                }]
              })
            });
            
            if (geminiResponse.ok) {
              const geminiData = await geminiResponse.json();
              recommendedWordsCache = geminiData.candidates[0].content.parts[0].text.trim();
            } else {
              recommendedWordsCache = fallbackWords.join(", ");
            }
          } catch (e) {
            console.error("Gemini API Error", e);
            recommendedWordsCache = fallbackWords.join(", ");
          }
        } else {
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

  function parseAssessmentDetails(detailsStr, originalSentence) {
    if (!detailsStr) return { html: '', worstWord: '', minScore: 100 };
    let worstWord = '';
    let minScore = 100;
    let wordScores = {};

    const matches = [...detailsStr.matchAll(/([^\s|]+)\|\{([^}]+)\}/g)];
    
    matches.forEach(m => {
      const word = m[1];
      const scoresStr = m[2];
      const scoreMatches = scoresStr.match(/\d+/g);
      let avgScore = 100;
      if (scoreMatches && scoreMatches.length > 0) {
        const sum = scoreMatches.reduce((acc, val) => acc + parseInt(val), 0);
        avgScore = sum / scoreMatches.length;
      }
      wordScores[word] = avgScore;
      if (avgScore < minScore && avgScore < 85) {
        minScore = avgScore;
        worstWord = word;
      }
    });

    let html = '';
    const words = originalSentence.split(' ');
    words.forEach((w, idx) => {
      // Find matching word score (fuzzy match or exact)
      // Clova might split punctuation, so remove punctuation for matching
      const cleanW = w.replace(/[.,!?]/g, '');
      const score = wordScores[cleanW] || wordScores[w] || 100;
      
      let colorClass = '';
      if (score >= 90) colorClass = 'highlight-green';
      else if (score < 75) colorClass = 'highlight-red';

      for (let char of w) {
        html += `<span class="letter-box ${colorClass}">${char}</span>`;
      }
      if (idx < words.length - 1) html += '<span class="mx-4"></span>';
    });

    return { html, worstWord, minScore };
  }

  function calculateFluency(usrGraph) {
    if (!usrGraph || !usrGraph.length) return { score: 100, pauseCount: 0 };
    const NOISE_THRESHOLD = 5;
    const PAUSE_THRESHOLD_SAMPLES = 30;
    
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
    
    let score = 100;
    if (pauseCount === 1) score = 90;
    else if (pauseCount === 2) score = 80;
    else if (pauseCount === 3) score = 70;
    else if (pauseCount >= 4) score = 60;
    return { score, pauseCount };
  }
});
