// Import environment variables via Vite
const invokeUrl = import.meta.env.VITE_CLOVA_INVOKE_URL;
const secretKey = import.meta.env.VITE_CLOVA_SECRET_KEY;
const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;

let targetSentence = "로딩 중...";
let currentMode = 'story'; // 'story' | 'practice'
let recommendedWordsCache = "";
let worstWordCache = "";

document.addEventListener('DOMContentLoaded', async () => {
  const micBtn = document.getElementById('mic-btn');
  const storyBox = document.getElementById('story-box');
  const feedbackBox = document.getElementById('feedback-box');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackText = document.getElementById('feedback-text');
  const recommendationBox = document.getElementById('recommendation-box');
  const recommendationText = document.getElementById('recommendation-text');
  const practiceBtn = document.getElementById('practice-btn');

  // Move event listeners above await to ensure they are attached immediately
  // Handle Practice Button
  practiceBtn.addEventListener('click', () => {
    currentMode = 'practice';
    targetSentence = recommendedWordsCache;
    storyBox.innerHTML = `"${targetSentence}"`;
    recommendationBox.style.display = 'none';
    feedbackBox.style.display = 'none';
    feedbackTitle.style.display = 'none';
    micBtn.innerHTML = '🎤 연습 시작하기';
    micBtn.style.background = 'var(--color-primary)';
    micBtn.style.color = 'white';
  });

  let isRecording = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;

  micBtn.addEventListener('click', async () => {
    if (currentMode === 'finished') {
      currentMode = 'story';
      storyBox.innerText = "새로운 지문을 불러오는 중입니다... ⏳";
      feedbackBox.style.display = 'none';
      feedbackTitle.style.display = 'none';
      recommendationBox.style.display = 'none';
      micBtn.innerHTML = '🎤 누르고 말하기';
      micBtn.style.background = 'var(--color-primary)';
      micBtn.style.color = 'white';
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
      micBtn.innerHTML = '🔴 녹음 중... (종료하려면 클릭하세요)';
      micBtn.style.background = 'var(--color-error)';
      micBtn.style.color = 'white';
      micBtn.style.boxShadow = 'none';
      micBtn.style.transform = 'translateY(4px)';

      feedbackBox.style.display = 'none';
      feedbackTitle.style.display = 'none';
      storyBox.innerHTML = `"${targetSentence}"`;

    } catch (err) {
      alert('마이크 접근 권한이 필요합니다.');
      console.error(err);
    }
  });

  storyBox.innerText = "새로운 지문을 불러오는 중입니다... ⏳";

  // Generate initial sentence using Gemini
  await generateNewSentence();

  async function generateNewSentence() {
    if (!geminiKey) {
      targetSentence = "아기 다람쥐가 나무 위로 쪼르르 올라갔습니다.";
      storyBox.innerText = `"${targetSentence}"`;
      return;
    }
    
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`, {
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
        storyBox.innerText = `"${targetSentence}"`;
      } else {
        targetSentence = "바람이 시원하게 불어옵니다.";
        storyBox.innerText = `"${targetSentence}"`;
      }
    } catch(e) {
      targetSentence = "예쁜 꽃밭에 나비가 날아왔습니다.";
      storyBox.innerText = `"${targetSentence}"`;
    }
  }



  function stopRecording() {
    isRecording = false;
    mediaRecorder.stop();
    stream.getTracks().forEach(track => track.stop());

    micBtn.innerHTML = '⚙️ AI 분석 중...';
    micBtn.style.background = 'var(--color-surface-alt)';
    micBtn.style.color = 'var(--color-muted)';
    micBtn.style.transform = 'none';
  }

  async function processAudio(audioBlob, invokeUrl, secretKey) {
    try {
      let rawUrl = invokeUrl;
      if (!invokeUrl.endsWith('/stt') && !invokeUrl.endsWith('/upload')) {
        rawUrl = `${invokeUrl}/recognizer/upload`;
      }
      
      const urlObj = new URL(rawUrl);
      let proxiedUrl = `/api/clova${urlObj.pathname}${urlObj.search}`;
      const isSttEndpoint = proxiedUrl.includes('/stt');

      let bodyData;
      let headers = {
        'X-CLOVASPEECH-API-KEY': secretKey
      };

      if (isSttEndpoint) {
        // STT Endpoint expects binary audio and query params
        const queryParams = new URLSearchParams(urlObj.search);
        queryParams.set('lang', 'Kor');
        queryParams.set('assessment', 'true');
        queryParams.set('utterance', targetSentence);
        queryParams.set('graph', 'true'); // Request audio waveform for fluency analysis
        proxiedUrl = `/api/clova${urlObj.pathname}?${queryParams.toString()}`;
        
        headers['Content-Type'] = 'application/octet-stream';
        bodyData = audioBlob;
      } else {
        // Fallback for /recognizer/upload (FormData)
        const formData = new FormData();
        formData.append('media', audioBlob, 'record.webm');
        formData.append('params', JSON.stringify({
          language: 'ko-KR',
          completion: 'sync',
          assessment: true,
          graph: true, // Request audio waveform for fluency analysis
          utterance: targetSentence
        }));
        bodyData = formData;
      }

      // Send to CLOVA Speech via Vite Proxy
      const response = await fetch(proxiedUrl, {
        method: 'POST',
        headers: headers,
        body: bodyData
      });

      if (!response.ok) {
        let errorBody = "";
        try { errorBody = await response.text(); } catch(e) {}
        throw new Error(`API Request Failed: ${response.status} ${response.statusText} - ${errorBody}`);
      }

      const data = await response.json();
      
      // Handle the Clova Speech response
      const score = data.assessment_score; // 0 to 100
      const recognizedText = data.text;
      const details = data.assessment_details;
      const usrGraph = data.usr_graph || [];
      
      const parsed = parseAssessmentDetails(details);
      const highlightedText = parsed.html || recognizedText || "음성이 인식되지 않았습니다.";
      
      // Calculate Fluency (Rhythm) Score based on pauses in the audio graph
      const fluency = calculateFluency(usrGraph);

      // Update story text with the score and highlighted words
      storyBox.innerHTML = `
        <div style="font-size:18px; color:var(--color-muted); margin-bottom: 12px;">
          발음 정확도: <strong style="color:${score >= 80 ? 'var(--color-success)' : 'var(--color-error)'}">${score || 0}점</strong> | 
          리듬감(유창성): <strong style="color:${fluency.score >= 80 ? 'var(--color-success)' : 'var(--color-error)'}">${fluency.score}점</strong>
        </div>
        "${highlightedText}"`;

      // Show feedback
      micBtn.innerHTML = '🎤 다시 해보기';
      micBtn.style.background = 'var(--color-pastel-yellow-dark)';
      micBtn.style.color = 'var(--color-pastel-text)';
      micBtn.style.boxShadow = '0 4px 0 #e6c84c';

      const feedbackDetail = document.getElementById('feedback-detail');
      let feedbackMsg = "";
      let detailMsg = "";

      if (currentMode === 'practice') {
        if (score >= 90) {
          feedbackMsg = `"우와, 정말 대단해! 오늘 어려운 글자 '${worstWordCache}'(을)를 완벽하게 마스터했어! 발음 점수 ${score}점!"`;
          detailMsg = `별 요정이 ${score}점을 주었어요! 이제 어떤 단어든 자신감 있게 읽을 수 있어요.`;
          currentMode = 'finished';
          micBtn.innerHTML = '✨ 새로운 지문 도전하기';
          micBtn.style.background = 'var(--color-success)';
          micBtn.style.color = 'white';
          micBtn.style.boxShadow = '0 4px 0 #3a8a5b';
        } else {
          feedbackMsg = `"거의 다 왔어! 연습 단어들을 조금만 더 뚜렷하게 다시 읽어볼까?"`;
          detailMsg = `현재 점수: ${score}점. 천천히 한 글자씩 또박또박 소리 내어 보세요!`;
        }
      } else {
        if (score >= 90 && fluency.score >= 90) {
          feedbackMsg = `"우와! 발음도 정말 완벽하고 끊어 읽기도 아나운서처럼 자연스러웠어! 100점 만점!"`;
          detailMsg = `어려운 발음도 훌륭하게 소화했고, 중간에 부자연스러운 멈춤 없이 완벽한 리듬으로 읽었어요.`;
        } else if (score >= 80) {
          if (fluency.pauseCount > 0) {
            feedbackMsg = `"발음은 아주 좋았어! 하지만 중간에 너무 길게 쉬어간 곳이 ${fluency.pauseCount}번 있었네. 물 흐르듯 자연스럽게 이어서 읽어볼까?"`;
            detailMsg = `단어들은 정확히 읽었지만, 숨을 너무 오래 참고 읽거나 중간에 멈춘 구간이 감지되었어요. 자연스럽게 이어서 읽는 연습을 해보세요.`;
          } else if (parsed.worstWord) {
            feedbackMsg = `"리듬감은 완벽해! 하지만 <strong>'${parsed.worstWord}'</strong> 발음이 조금 아쉬웠어. 이 단어만 더 뚜렷하게 읽어보자!"`;
            detailMsg = `AI 분석 결과 '${parsed.worstWord}' 단어가 불명확하게 들렸어요. 입을 크게 벌리고 소리 내보세요.`;
          } else {
            feedbackMsg = `"참 잘했어! 조금만 더 큰 소리로 자신감 있게 읽어보면 완벽할거야!"`;
            detailMsg = `목소리가 조금 작거나 불분명한 구간이 있어요. 큰 소리로 다시 한번 도전!`;
          }
        } else {
          feedbackMsg = `"어려운 단어가 있었나 보네! 별 요정이랑 천천히 처음부터 다시 읽어보자!"`;
          if (parsed.worstWord) {
            detailMsg = `가장 헷갈려 했던 단어는 '${parsed.worstWord}'예요. 이 부분의 발음이 뭉개지거나 다르게 읽혔습니다. 유창성 점수는 ${fluency.score}점입니다.`;
          } else {
            detailMsg = `유창성 점수는 ${fluency.score}점입니다. 전체적으로 속도를 늦추고 또박또박 읽는 연습이 필요해요.`;
          }
        }
      }
      
      feedbackText.innerHTML = feedbackMsg;
      if (feedbackDetail) feedbackDetail.innerHTML = detailMsg;
      feedbackTitle.scrollIntoView({ behavior: 'smooth' });

      // Gemini Word Recommendation (Only in Story Mode)
      if (recommendationBox) {
        recommendationBox.style.display = 'none';
        practiceBtn.style.display = 'none';
      }
      
      if (currentMode === 'story' && parsed.worstWord && recommendationBox) {
        worstWordCache = parsed.worstWord;
        recommendationText.innerHTML = "단어 추천을 생성하고 있습니다... ⏳";
        recommendationBox.style.display = 'block';
        
        const fallbackWords = [`${parsed.worstWord}와`, `${parsed.worstWord}를`, `${parsed.worstWord}도`];
        
        if (geminiKey) {
          try {
            const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{
                  parts: [{
                    text: `초등학교 저학년 학생이 '${parsed.worstWord}'라는 단어를 발음하기 어려워해. 이 단어와 발음 원리나 구조(예: 겹받침, 연음 등)가 유사해서 발음 연습하기 좋은 단어 3개를 쉼표로 구분해서 말해줘. 부가 설명 없이 단어 3개만 딱 출력해.`
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
        
        recommendationText.innerHTML = `이런 단어들도 소리 내어 읽어볼까요? <br><span style="color:var(--color-primary-dark); font-size: 20px;">${recommendedWordsCache}</span>`;
        practiceBtn.style.display = 'block';
      }

    } catch (err) {
      console.error(err);
      alert('API 호출 중 오류가 발생했습니다. 브라우저 콘솔을 확인해주세요. (CORS 문제 또는 API 키 확인 필요)');
      micBtn.innerHTML = '🎤 다시 해보기';
      micBtn.style.background = 'var(--color-pastel-yellow-dark)';
      micBtn.style.color = 'var(--color-pastel-text)';
      micBtn.style.boxShadow = '0 4px 0 #e6c84c';
    }
  }

  // Parse CLOVA Speech assessment_details
  // Format: "word1|{phoneme1:score, ...} word2|{...}"
  function parseAssessmentDetails(detailsStr) {
    if (!detailsStr) return { html: '', worstWord: '', minScore: 100 };
    
    let html = '';
    let worstWord = '';
    let minScore = 100;

    // Match patterns like: word|{a(a):100, b(b):90}
    const matches = [...detailsStr.matchAll(/([^\s|]+)\|\{([^}]+)\}/g)];
    
    if (matches.length === 0) {
      return { html: detailsStr, worstWord: '', minScore: 100 };
    }

    matches.forEach(m => {
      const word = m[1];
      const scoresStr = m[2];
      
      // Extract all numbers from the scoresStr
      const scoreMatches = scoresStr.match(/\d+/g);
      let avgScore = 100;
      
      if (scoreMatches && scoreMatches.length > 0) {
        const sum = scoreMatches.reduce((acc, val) => acc + parseInt(val), 0);
        avgScore = sum / scoreMatches.length;
      }

      // Track the worst pronounced word for personalized feedback
      if (avgScore < minScore && avgScore < 85) {
        minScore = avgScore;
        worstWord = word;
      }

      // Highlight logic
      if (avgScore >= 90) {
        // Excellent: Green
        html += `<span style="color: var(--color-success); font-weight: 600;">${word}</span> `;
      } else if (avgScore < 75) {
        // Needs Improvement: Red with underline
        html += `<span style="color: var(--color-error); font-weight: 600; text-decoration: underline; text-decoration-color: var(--color-error);">${word}</span> `;
      } else {
        // Average: Default text color
        html += `${word} `;
      }
    });

    return { html: html.trim(), worstWord, minScore };
  }

  // Calculate fluency based on audio waveform pauses
  function calculateFluency(usrGraph) {
    if (!usrGraph || !usrGraph.length) return { score: 100, pauseCount: 0 };
    
    const NOISE_THRESHOLD = 5; // amplitude < 5 is considered silence
    const PAUSE_THRESHOLD_SAMPLES = 30; // 30 samples * 20ms = 600ms (Unnatural pause)
    
    // 1. Trim leading and trailing silences
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
        // If the silence was longer than 600ms, it's an unnatural pause
        if (currentSilenceLength >= PAUSE_THRESHOLD_SAMPLES) {
          pauseCount++;
        }
        currentSilenceLength = 0;
      }
    }
    
    // Deduct 15 points per unnatural pause
    let score = 100 - (pauseCount * 15);
    if (score < 0) score = 0;
    
    return { score, pauseCount };
  }
});
