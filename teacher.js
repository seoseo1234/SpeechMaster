const students = [
    { id: 1, name: "박지우", status: "완료", accuracy: 92, lastDate: "오늘 오전 10:45",
      radarData: [90, 85, 95, 80, 88], // 발음정밀도, 속도, 성량, 시선, 성량안정
      historyData: { labels: ['3월', '4월', '5월', '6월', '현재'], wpm: [100, 110, 115, 125, 130], accuracy: [70, 75, 82, 88, 92] },
      weaknesses: ["발표 중 시선이 바닥 대본으로 자주 향함 (시선 이탈률 20%)", "긴장 시 '어..', '그..' 습관어 사용 증가 (총 8회)"],
      recommendations: ["거울을 보고 대본 없이 1분간 말하기 연습 추천", "문장 끝맺음 후 1초간 의도적으로 쉬어가는 호흡 훈련 필요"]
    },
    { id: 2, name: "김민수", status: "대기", accuracy: 78, lastDate: "어제 오후 2:30",
      radarData: [70, 95, 75, 90, 60],
      historyData: { labels: ['3월', '4월', '5월', '6월', '현재'], wpm: [140, 150, 160, 155, 160], accuracy: [60, 65, 70, 75, 78] },
      weaknesses: ["말의 속도가 너무 빠름 (WPM 160 초과)", "발음이 뭉개지는 구간 다수 발생 (특히 'ㄹ' 발음)"],
      recommendations: ["천천히 또박또박 읽는 '저학년 모드' 훈련 주 2회 권장", "녹음 후 자신의 목소리 모니터링하기"]
    },
    { id: 3, name: "이서연", status: "완료", accuracy: 98, lastDate: "오늘 오전 9:15",
      radarData: [98, 95, 96, 99, 95],
      historyData: { labels: ['3월', '4월', '5월', '6월', '현재'], wpm: [110, 120, 125, 130, 130], accuracy: [85, 90, 95, 97, 98] },
      weaknesses: ["거의 완벽한 발표를 보임", "가끔 목소리가 작아지는 현상 (구간별 편차)"],
      recommendations: ["자신감을 잃지 않고 현재 톤 유지하기", "친구들 앞에서 모의 발표(동료 평가) 진행해보기"]
    },
    { id: 4, name: "최현우", status: "진행중", accuracy: 85, lastDate: "-",
      radarData: [85, 80, 85, 85, 80],
      historyData: { labels: ['3월', '4월', '5월', '6월', '현재'], wpm: [90, 95, 105, 110, 115], accuracy: [75, 80, 82, 85, 85] },
      weaknesses: ["전체적으로 무난하나 감정 표현이 부족함 (Monotone)", "몸을 좌우로 흔드는 산만한 자세"],
      recommendations: ["강조할 단어에 억양을 넣는 연습 필요", "바른 자세로 발을 땅에 붙이고 서서 발표하기"]
    },
    { id: 5, name: "정다은", status: "완료", accuracy: 88, lastDate: "오늘 오전 11:20",
      radarData: [85, 90, 92, 80, 85],
      historyData: { labels: ['3월', '4월', '5월', '6월', '현재'], wpm: [100, 105, 115, 120, 125], accuracy: [80, 82, 85, 87, 88] },
      weaknesses: ["발음은 좋으나 시선 처리가 불안함", "특정 단어에서 머뭇거림"],
      recommendations: ["대본을 완전히 숙지하는 연습 필요", "청중과 아이컨택(Eye Contact) 연습"]
    }
];

// Populate more dummy students to reach 24
for (let i = 6; i <= 24; i++) {
    students.push({
        id: i, name: `학생${i}`, status: Math.random() > 0.5 ? "완료" : "대기", accuracy: Math.floor(Math.random() * 30 + 60), lastDate: "2일 전",
        radarData: Array.from({length: 5}, () => Math.floor(Math.random() * 40 + 60)),
        historyData: { labels: ['3월', '4월', '5월', '6월', '현재'], wpm: [100, 105, 110, 115, 120], accuracy: [60, 65, 70, 75, 80] },
        weaknesses: ["일반적인 발음 교정 필요", "자신감 부족"],
        recommendations: ["교과서 큰 소리로 읽기 연습", "꾸준한 연습 요망"]
    });
}

// DOM Elements
const studentListEl = document.getElementById('student-list');
const dashboardContent = document.getElementById('dashboard-content');
const emptyState = document.getElementById('empty-state');
const stName = document.getElementById('st-name');
const stLastDate = document.getElementById('st-last-date');
const stWeaknesses = document.getElementById('st-weaknesses');
const stRecommendations = document.getElementById('st-recommendations');
const btnGenerateNeis = document.getElementById('btn-generate-neis');
const neisOutput = document.getElementById('neis-output');
const neisLoading = document.getElementById('neis-loading');
const btnCopyNeis = document.getElementById('btn-copy-neis');

const modalAssign = document.getElementById('modal-assign');
const btnAssignScript = document.getElementById('btn-assign-script');
const closeAssignBtns = document.querySelectorAll('.btn-close-modal');

let radarChartInstance = null;
let lineChartInstance = null;
let currentStudent = null;

// Initialize Student List
function initStudentList() {
    studentListEl.innerHTML = '';
    students.forEach(st => {
        const li = document.createElement('li');
        li.className = `p-4 border-b-2 border-gray-200 cursor-pointer hover:bg-gray-100 transition flex justify-between items-center`;
        
        let statusBadge = '';
        if (st.status === '완료') statusBadge = '<span class="bg-primary text-white text-xs px-2 py-1 font-bold">완료</span>';
        else if (st.status === '진행중') statusBadge = '<span class="bg-tertiary text-white text-xs px-2 py-1 font-bold">진행중</span>';
        else statusBadge = '<span class="bg-surface-variant text-gray-500 border border-gray-300 text-xs px-2 py-1 font-bold">대기</span>';

        li.innerHTML = `
            <div class="flex flex-col gap-1">
                <span class="font-bold text-lg">${st.name}</span>
                <span class="text-xs text-gray-500 font-medium">정확도: ${st.accuracy}%</span>
            </div>
            ${statusBadge}
        `;
        
        li.addEventListener('click', () => {
            // Remove active style from all
            Array.from(studentListEl.children).forEach(child => {
                child.classList.remove('bg-yellow-100', 'border-l-8', 'border-secondary');
            });
            // Add active style to selected
            li.classList.add('bg-yellow-100', 'border-l-8', 'border-secondary');
            
            selectStudent(st);
        });
        
        studentListEl.appendChild(li);
    });
}

// Select Student & Update Dashboard
function selectStudent(st) {
    currentStudent = st;
    emptyState.classList.add('hidden');
    dashboardContent.classList.remove('hidden');
    
    stName.innerText = st.name;
    stLastDate.innerText = st.lastDate;
    
    // Update Weaknesses
    stWeaknesses.innerHTML = st.weaknesses.map(w => `<li>${w}</li>`).join('');
    stRecommendations.innerHTML = st.recommendations.map(r => `<li>${r}</li>`).join('');
    
    // Reset NEIS
    neisOutput.value = '';
    btnCopyNeis.disabled = true;

    // Update Charts
    updateRadarChart(st.radarData);
    updateLineChart(st.historyData);
}

// Chart.js Default styling to match brutalism
Chart.defaults.font.family = "'Quicksand', sans-serif";
Chart.defaults.font.weight = 'bold';
Chart.defaults.color = '#000';

function updateRadarChart(dataArr) {
    const ctx = document.getElementById('radarChart').getContext('2d');
    if (radarChartInstance) radarChartInstance.destroy();
    
    radarChartInstance = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['발음정밀도', '말하기 속도(적절성)', '성량 크기', '시선 처리', '자세 안정성'],
            datasets: [{
                label: '역량 점수',
                data: dataArr,
                backgroundColor: 'rgba(253, 224, 71, 0.5)', // secondary yellow
                borderColor: '#000000',
                borderWidth: 3,
                pointBackgroundColor: '#3B82F6', // primary blue
                pointBorderColor: '#000',
                pointBorderWidth: 2,
                pointRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    angleLines: { color: 'rgba(0,0,0,0.2)' },
                    grid: { color: 'rgba(0,0,0,0.2)', circular: true },
                    pointLabels: { font: { size: 14, weight: '900', family: "'Plus Jakarta Sans'" }, color: '#000' },
                    ticks: { display: false, min: 0, max: 100 }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function updateLineChart(history) {
    const ctx = document.getElementById('lineChart').getContext('2d');
    if (lineChartInstance) lineChartInstance.destroy();
    
    lineChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: history.labels,
            datasets: [
                {
                    label: '발음 정확도 (%)',
                    data: history.accuracy,
                    borderColor: '#3B82F6', // primary blue
                    backgroundColor: '#3B82F6',
                    borderWidth: 4,
                    tension: 0.3,
                    yAxisID: 'y'
                },
                {
                    label: '말하기 속도 (WPM)',
                    data: history.wpm,
                    borderColor: '#22C55E', // tertiary green
                    backgroundColor: '#22C55E',
                    borderWidth: 4,
                    borderDash: [5, 5],
                    tension: 0.3,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(0,0,0,0.1)', drawBorder: true, borderColor: '#000', borderWidth: 3 },
                    ticks: { font: { size: 12, weight: 'bold' } }
                },
                y: {
                    type: 'linear', display: true, position: 'left',
                    grid: { color: 'rgba(0,0,0,0.1)', drawBorder: true, borderColor: '#000', borderWidth: 3 },
                    title: { display: true, text: '정확도 (%)', font: { weight: 'black' } },
                    min: 0, max: 100
                },
                y1: {
                    type: 'linear', display: true, position: 'right',
                    grid: { drawOnChartArea: false, borderColor: '#000', borderWidth: 3 },
                    title: { display: true, text: '속도 (WPM)', font: { weight: 'black' } },
                    min: 50, max: 200
                }
            },
            plugins: {
                legend: { position: 'bottom', labels: { font: { weight: 'bold' } } }
            }
        }
    });
}

// NEIS Generation Logic
btnGenerateNeis.addEventListener('click', async () => {
    if (!currentStudent) return;
    
    // UI Loading state
    neisLoading.classList.remove('hidden');
    btnGenerateNeis.disabled = true;
    
    try {
        const response = await fetch('http://localhost:3001/generate-neis-comment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: currentStudent.name,
                accuracy: currentStudent.accuracy,
                weaknesses: currentStudent.weaknesses,
                radar: currentStudent.radarData
            })
        });
        
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        
        const data = await response.json();
        neisOutput.value = data.comment;
        btnCopyNeis.disabled = false;
        
    } catch (error) {
        console.error("NEIS Gen Error:", error);
        neisOutput.value = `오류 발생: 생기부 문구 생성에 실패했습니다. (${error.message})\n임시 문구: 학생은 학기 초 대비 발음 정확도가 크게 향상되었으며, 발표에 대한 자신감을 획득함. 다만 시선 처리가 다소 불안정하여 꾸준한 훈련이 필요함.`;
        btnCopyNeis.disabled = false;
    } finally {
        neisLoading.classList.add('hidden');
        btnGenerateNeis.disabled = false;
    }
});

btnCopyNeis.addEventListener('click', () => {
    if (!neisOutput.value) return;
    navigator.clipboard.writeText(neisOutput.value).then(() => {
        const originalText = btnCopyNeis.innerHTML;
        btnCopyNeis.innerHTML = '<span class="material-symbols-outlined">check</span> 복사 완료!';
        btnCopyNeis.classList.add('bg-tertiary');
        setTimeout(() => {
            btnCopyNeis.innerHTML = originalText;
            btnCopyNeis.classList.remove('bg-tertiary');
        }, 2000);
    });
});

// Modal Logic
btnAssignScript.addEventListener('click', () => {
    modalAssign.classList.remove('hidden');
});

closeAssignBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        modalAssign.classList.add('hidden');
        if (btn.innerText.includes('배포하기')) {
            alert('과제/대본이 성공적으로 배포되었습니다!');
        }
    });
});

// Init
initStudentList();
