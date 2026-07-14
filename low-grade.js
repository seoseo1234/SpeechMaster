document.addEventListener('DOMContentLoaded', () => {
  const micBtn = document.getElementById('mic-btn');
  const storyBox = document.getElementById('story-box');
  const feedbackBox = document.getElementById('feedback-box');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackText = document.getElementById('feedback-text');

  let isRecording = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;

  const targetSentence = "아기 다람쥐가 나무 위로 쪼르르 올라갔습니다.";

  micBtn.addEventListener('click', async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    const invokeUrl = import.meta.env.VITE_CLOVA_INVOKE_URL;
    const secretKey = import.meta.env.VITE_CLOVA_SECRET_KEY;

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
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' }); // webm is usually supported in browsers
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
      const formData = new FormData();
      formData.append('media', audioBlob, 'record.webm');
      formData.append('params', JSON.stringify({
        language: 'ko-KR',
        completion: 'sync',
        assessment: true,
        utterance: targetSentence
      }));

      // Determine correct URL format
      let rawUrl = invokeUrl;
      if (!invokeUrl.endsWith('/stt') && !invokeUrl.endsWith('/upload')) {
        rawUrl = `${invokeUrl}/recognizer/upload`;
      }
      
      const urlObj = new URL(rawUrl);
      const proxiedUrl = `/api/clova${urlObj.pathname}${urlObj.search}`;

      // Send to CLOVA Speech via Vite Proxy
      const response = await fetch(proxiedUrl, {
        method: 'POST',
        headers: {
          'X-CLOVASPEECH-API-KEY': secretKey
        },
        body: formData
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
      
      // Update story text with the score
      // Note: CLOVA Speech provides assessment_details, but it might require parsing. 
      // For now, we'll display the overall score and recognized text.
      storyBox.innerHTML = `<span style="font-size:20px;color:var(--color-muted)">내 발음 정확도: <strong style="color:var(--color-success)">${score || 0}점</strong></span><br><br>"${targetSentence}"`;

      // Show feedback
      micBtn.innerHTML = '🎤 다시 해보기';
      micBtn.style.background = 'var(--color-pastel-yellow-dark)';
      micBtn.style.color = 'var(--color-pastel-text)';
      micBtn.style.boxShadow = '0 4px 0 #e6c84c';

      feedbackTitle.style.display = 'block';
      feedbackBox.style.display = 'flex';
      
      if (score >= 90) {
        feedbackText.innerHTML = `"우와! 발음이 정말 완벽해! 아나운서처럼 또박또박 잘 읽었어!"<br><span style="font-size:14px;color:#666">인식된 문장: ${recognizedText}</span>`;
      } else if (score >= 70) {
        feedbackText.innerHTML = `"잘했어! 조금만 더 큰 소리로 자신감 있게 읽어보면 100점 맞을 수 있을거야!"<br><span style="font-size:14px;color:#666">인식된 문장: ${recognizedText}</span>`;
      } else {
        feedbackText.innerHTML = `"어려운 단어가 있었나 보네! 도토리 요정이랑 천천히 다시 읽어보자!"<br><span style="font-size:14px;color:#666">인식된 문장: ${recognizedText}</span>`;
      }

      feedbackTitle.scrollIntoView({ behavior: 'smooth' });

    } catch (err) {
      console.error(err);
      alert('API 호출 중 오류가 발생했습니다. 브라우저 콘솔을 확인해주세요. (CORS 문제 또는 API 키 확인 필요)');
      micBtn.innerHTML = '🎤 다시 해보기';
      micBtn.style.background = 'var(--color-pastel-yellow-dark)';
      micBtn.style.color = 'var(--color-pastel-text)';
      micBtn.style.boxShadow = '0 4px 0 #e6c84c';
    }
  }
});
