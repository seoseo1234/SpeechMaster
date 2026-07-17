import { db, auth } from './firebase.js';
import { collection, onSnapshot, addDoc, serverTimestamp, query, doc, getDoc, updateDoc, where } from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';

let currentUser = null;
const isGuestMode = localStorage.getItem('guestMode') === 'true';

// Auth Guard
if (isGuestMode) {
    currentUser = { uid: 'guest', role: 'teacher', displayName: '둘러보기 선생님' };
    const teacherNameDisplay = document.getElementById('teacher-name-display');
    if (teacherNameDisplay) teacherNameDisplay.innerText = '둘러보기 선생님';
    
    // Slight delay to simulate loading
    setTimeout(() => {
        initStudentList();
    }, 500);
} else {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.replace('login.html');
        } else {
            currentUser = user;
            
            // Fetch role
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists() && userDoc.data().role !== 'teacher') {
                alert('접근 권한이 없습니다. (교사 전용)');
                window.location.replace('login.html');
            }
            
            // Get classCode and className
            let teacherClassCode = "";
            let teacherClassName = "내 학급";
            if (userDoc.exists()) {
                teacherClassCode = userDoc.data().classCode || "NONE";
                teacherClassName = userDoc.data().className || "내 학급";
                const classCodeDisplay = document.getElementById('class-code-display');
                if (classCodeDisplay) {
                    classCodeDisplay.innerText = `코드: ${teacherClassCode}`;
                }
                const classNameDisplay = document.getElementById('class-name-display');
                if (classNameDisplay) {
                    classNameDisplay.innerText = teacherClassName;
                    
                    // Add edit listener
                    classNameDisplay.addEventListener('click', async () => {
                        const newName = prompt('새로운 반 이름을 입력하세요:', classNameDisplay.innerText);
                        if (newName !== null && newName.trim() !== '') {
                            try {
                                await updateDoc(doc(db, "users", user.uid), {
                                    className: newName.trim()
                                });
                                classNameDisplay.innerText = newName.trim();
                            } catch (e) {
                                console.error("Error updating class name:", e);
                                alert("반 이름 변경 중 오류가 발생했습니다.");
                            }
                        }
                    });
                }
            }
            
            const teacherNameDisplay = document.getElementById('teacher-name-display');
            if (teacherNameDisplay) {
                teacherNameDisplay.innerText = user.displayName || user.email.split('@')[0] + ' 선생님';
            }
            
            // Init dashboard
            initStudentList(teacherClassCode);
        }
    });
}


let students = [];

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
const btnBackToList = document.getElementById('btn-back-to-list');

if (btnBackToList) {
    btnBackToList.addEventListener('click', () => {
        document.body.classList.remove('show-dashboard');
    });
}

let radarChartInstance = null;
let lineChartInstance = null;
let currentStudent = null;

// Initialize Student List from Firebase
function initStudentList(classCode = "GUEST") {
    if (isGuestMode) {
        loadMockStudents();
        return;
    }

    const q = query(collection(db, "students"), where("classCode", "==", classCode));
    
    onSnapshot(q, (snapshot) => {
        students = [];
        studentListEl.innerHTML = '';
        
        snapshot.forEach((doc) => {
            const st = { id: doc.id, ...doc.data() };
            students.push(st);
        });
        
        // Sort manually by lastUpdatedAt desc to avoid requiring composite indexes
        students.sort((a, b) => {
            const timeA = a.lastUpdatedAt ? a.lastUpdatedAt.toMillis() : 0;
            const timeB = b.lastUpdatedAt ? b.lastUpdatedAt.toMillis() : 0;
            return timeB - timeA;
        });

        students.forEach((st) => {
            const li = document.createElement('li');
            li.className = `p-4 border-b-2 border-gray-200 cursor-pointer hover:bg-gray-100 transition flex justify-between items-center`;
            
            let statusBadge = '';
            if (st.status === '완료') statusBadge = '<span class="bg-primary text-white text-xs px-2 py-1 font-bold">완료</span>';
            else if (st.status === '진행중') statusBadge = '<span class="bg-tertiary text-white text-xs px-2 py-1 font-bold">진행중</span>';
            else statusBadge = '<span class="bg-surface-variant text-gray-500 border border-gray-300 text-xs px-2 py-1 font-bold">대기</span>';

            li.innerHTML = `
                <div class="flex flex-col gap-1">
                    <span class="font-bold text-lg">${st.name}</span>
                    <span class="text-xs text-gray-500 font-medium">정확도: ${st.accuracy || 0}%</span>
                </div>
                ${statusBadge}
            `;
            
            li.addEventListener('click', () => {
                Array.from(studentListEl.children).forEach(child => {
                    child.classList.remove('bg-yellow-100', 'border-l-8', 'border-secondary');
                });
                li.classList.add('bg-yellow-100', 'border-l-8', 'border-secondary');
                selectStudent(st);
                document.body.classList.add('show-dashboard');
            });
            
            studentListEl.appendChild(li);
        });
        
        // If currentStudent exists, refresh their data, otherwise select the first student
        if (currentStudent) {
            const updated = students.find(s => s.id === currentStudent.id);
            if (updated) {
                selectStudent(updated);
            }
        } else if (students.length > 0) {
            // Auto-select first student and highlight its list item
            const firstLi = studentListEl.firstElementChild;
            if (firstLi) firstLi.classList.add('bg-yellow-100', 'border-l-8', 'border-secondary');
            selectStudent(students[0]);
        }
    });
}

function loadMockStudents() {
    const mockNames = ['김지훈', '박서연', '이도윤', '최유진', '정하준', '강민서', '조준우', '윤지아', '임서준', '한지우'];
    const statuses = ['완료', '진행중', '대기'];
    
    students = mockNames.map((name, i) => {
        const status = statuses[i % 3];
        const accVal = status === '대기' ? 0 : Math.floor(Math.random() * 20) + 75; // 75~95
        const speedVal = status === '대기' ? 0 : Math.floor(Math.random() * 20) + 75;
        const volVal = status === '대기' ? 0 : Math.floor(Math.random() * 20) + 75;
        const gazeVal = status === '대기' ? 0 : Math.floor(Math.random() * 20) + 75;
        const postureVal = status === '대기' ? 0 : Math.floor(Math.random() * 20) + 75;
        
        return {
            id: `mock_${i}`,
            name: name,
            status: status,
            accuracy: accVal,
            lastDate: status === '대기' ? '-' : '2026.07.16',
            lastUpdatedAt: new Date().getTime() - Math.random() * 10000000,
            radarData: [accVal, speedVal, volVal, gazeVal, postureVal],
            historyData: {
                labels: status === '대기' ? [] : ['3/4', '3/15', '4/2', '오늘'],
                accuracy: status === '대기' ? [] : [accVal - 15, accVal - 10, accVal - 5, accVal]
            },
            weaknesses: status === '대기' ? [] : ['말하기 속도가 다소 빠름', '특정 자음(ㅅ, ㄹ) 발음 불명확'],
            recommendations: status === '대기' ? [] : ['천천히 또박또박 읽는 연습', '거울을 보고 입모양을 크게 벌리기']
        };
    });

    studentListEl.innerHTML = '';
    students.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt).forEach((st) => {
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
            Array.from(studentListEl.children).forEach(child => {
                child.classList.remove('bg-yellow-100', 'border-l-8', 'border-secondary');
            });
            li.classList.add('bg-yellow-100', 'border-l-8', 'border-secondary');
            selectStudent(st);
        });
        
        studentListEl.appendChild(li);
    });

    if (students.length > 0) {
        const firstLi = studentListEl.firstElementChild;
        if (firstLi) firstLi.classList.add('bg-yellow-100', 'border-l-8', 'border-secondary');
        selectStudent(students[0]);
    }
}


// Select Student & Update Dashboard
function selectStudent(st) {
    currentStudent = st;
    emptyState.classList.add('hidden');
    dashboardContent.classList.remove('hidden');
    
    stName.innerText = st.name || '이름 없음';
    stLastDate.innerText = st.lastDate || '기록 없음';
    
    // Update Weaknesses safely
    const wList = st.weaknesses && st.weaknesses.length > 0 ? st.weaknesses : ['분석 데이터가 부족합니다.'];
    const rList = st.recommendations && st.recommendations.length > 0 ? st.recommendations : ['낭독/발표 연습을 진행해주세요.'];
    
    stWeaknesses.innerHTML = wList.map(w => `<li>${w}</li>`).join('');
    stRecommendations.innerHTML = rList.map(r => `<li>${r}</li>`).join('');
    
    // Reset NEIS
    neisOutput.value = '';
    btnCopyNeis.disabled = true;

    // Update Charts safely
    updateRadarChart(st.radarData || [0, 0, 0, 0, 0]);
    updateLineChart(st.historyData || { labels: [], accuracy: [] });
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
        const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
        if (!geminiKey) throw new Error("Gemini API Key missing in .env");

        const safeWeaknesses = currentStudent.weaknesses || ["데이터 부족"];
        const safeRadar = currentStudent.radarData || [0, 0, 0, 0, 0];

        const prompt = "당신은 초등학교 교사입니다. 학생의 발표 기록 데이터를 바탕으로 나이스(NEIS) 학교생활기록부 교과세특 또는 행동특성 및 종합의견에 들어갈 만한 \"서술형 관찰평가 피드백 문구\"를 작성해주세요.\n\n" +
        "[학생 데이터]\n" +
        "- 이름: " + (currentStudent.name || '학생') + "\n" +
        "- 평균 정확도: " + (currentStudent.accuracy || 0) + "%\n" +
        "- 주요 취약점: " + safeWeaknesses.join(', ') + "\n" +
        "- 5대 역량(100점 만점): 발음정밀도(" + safeRadar[0] + "), 말하기 속도(" + safeRadar[1] + "), 성량 크기(" + safeRadar[2] + "), 시선 처리(" + safeRadar[3] + "), 자세 안정성(" + safeRadar[4] + ")\n\n" +
        "[작성 지침]\n" +
        "1. 공손하고 전문적인 교사의 어투(평어체, ~함, ~임)로 작성해주세요.\n" +
        "2. 장점(역량 점수가 높은 부분)을 먼저 칭찬하고, 단점(취약점)은 보완 방향성을 제시하는 긍정적인 방향으로 작성해주세요.\n" +
        "3. 길이는 2~3문장, 150자 내외로 매우 간결하게 작성해주세요.\n" +
        "4. 오직 작성된 생기부 문구 텍스트만 출력하세요. json 포맷을 쓰지 마세요.";

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) {
            throw new Error(`Gemini API Error: ${response.status}`);
        }
        
        const data = await response.json();
        neisOutput.value = data.candidates[0].content.parts[0].text.trim();
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
    btn.addEventListener('click', async () => {
        if (btn.innerText.includes('배포하기')) {
            // Get inputs
            const scriptTitle = document.querySelector('#modal-assign input[type="text"]').value;
            const scriptText = document.querySelector('#modal-assign textarea').value;
            
            if (!scriptText.trim()) {
                alert('대본 텍스트를 입력해주세요.');
                return;
            }
            
            btn.innerText = '배포 중...';
            btn.disabled = true;
            
            try {
                await addDoc(collection(db, "assignments"), {
                    title: scriptTitle || '제목 없는 과제',
                    script: scriptText,
                    createdAt: serverTimestamp(),
                    active: true
                });
                alert('과제/대본이 성공적으로 배포되었습니다!');
                modalAssign.classList.add('hidden');
            } catch (e) {
                console.error("Error adding document: ", e);
                alert('배포 중 오류가 발생했습니다.');
            } finally {
                btn.innerText = '배포하기';
                btn.disabled = false;
            }
        } else {
            modalAssign.classList.add('hidden');
        }
    });
});

// Logout
const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
    btnLogout.addEventListener('click', () => {
        localStorage.removeItem('guestMode');
        signOut(auth).then(() => {
            window.location.replace('login.html');
        });
    });
}

