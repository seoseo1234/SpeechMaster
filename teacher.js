import { db, auth } from './firebase.js';
import { collection, onSnapshot, addDoc, serverTimestamp, query, doc, getDoc, getDocs, setDoc, updateDoc, where, orderBy, limit } from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { askGemini } from './apiClient.js';
import { radarFromStudent, buildInsights, SCORE_LABELS } from './scoring.js';

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
        if (!user || user.isAnonymous) {
            window.location.replace('login.html');
        } else {
            currentUser = user;
            
            // Fetch role (교사 프로필이 없거나 교사가 아니면 차단)
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (!userDoc.exists() || userDoc.data().role !== 'teacher') {
                alert('접근 권한이 없습니다. (교사 전용)');
                window.location.replace('index.html');
                return;
            }
            
            const teacherClassCode = userDoc.data().classCode;
            const teacherClassName = userDoc.data().className || "내 학급";
            await ensureClassDoc(user.uid, teacherClassCode, teacherClassName);
            
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
                            await updateDoc(doc(db, "users", user.uid), { className: newName.trim() });
                            await updateDoc(doc(db, "classes", teacherClassCode), { className: newName.trim() });
                            classNameDisplay.innerText = newName.trim();
                        } catch (e) {
                            console.error("Error updating class name:", e);
                            alert("반 이름 변경 중 오류가 발생했습니다.");
                        }
                    }
                });
            }
            
            const teacherNameDisplay = document.getElementById('teacher-name-display');
            if (teacherNameDisplay) {
                teacherNameDisplay.innerText = user.displayName || user.email.split('@')[0] + ' 선생님';
            }
            
            // Init dashboard
            teacherInfo = { uid: user.uid, classCode: teacherClassCode };
            initStudentList(teacherClassCode);
        }
    });
}

let teacherInfo = null;

// 예전에 가입한 교사는 classes 문서가 없으므로 처음 접속 시 생성 (학생 가입 시 코드 확인용)
async function ensureClassDoc(uid, classCode, className) {
    try {
        const classRef = doc(db, "classes", classCode);
        const classSnap = await getDoc(classRef);
        if (!classSnap.exists()) {
            await setDoc(classRef, { teacherId: uid, className, createdAt: serverTimestamp() });
        } else if (classSnap.data().teacherId !== uid) {
            console.warn("학급 코드가 다른 교사와 중복됩니다:", classCode);
        }
    } catch (e) {
        console.error("Error ensuring class doc:", e);
    }
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
        students = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        // Sort manually by lastUpdatedAt desc to avoid requiring composite indexes
        students.sort((a, b) => toMillis(b.lastUpdatedAt) - toMillis(a.lastUpdatedAt));
        renderStudentList();
    }, (err) => {
        console.error("Student list error:", err);
        alert('학생 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    });
}

function toMillis(t) {
    if (!t) return 0;
    if (typeof t === 'number') return t;
    if (t.toMillis) return t.toMillis();
    return new Date(t).getTime() || 0;
}

const STATUS_BADGES = {
    '완료': ['bg-primary text-white', '완료'],
    '진행중': ['bg-tertiary text-white', '진행중'],
};

function renderStudentList() {
    studentListEl.replaceChildren();

    students.forEach((st) => {
        const li = document.createElement('li');
        li.className = `p-4 border-b-2 border-gray-200 cursor-pointer hover:bg-gray-100 transition flex justify-between items-center`;
        li.dataset.id = st.id;
        li.innerHTML = `
            <div class="flex flex-col gap-1">
                <span class="font-bold text-lg" data-field="name"></span>
                <span class="text-xs text-gray-500 font-medium" data-field="accuracy"></span>
            </div>
            <span data-field="status" class="text-xs px-2 py-1 font-bold"></span>
        `;
        // 학생이 입력한 값은 textContent로만 넣는다 (XSS 방지)
        li.querySelector('[data-field="name"]').textContent = st.name || '이름 없음';
        li.querySelector('[data-field="accuracy"]').textContent =
            `발음 정확도: ${st.accuracy != null ? st.accuracy + '%' : '-'}`;
        const [badgeClass, badgeText] = STATUS_BADGES[st.status] || ['bg-surface-variant text-gray-500 border border-gray-300', '대기'];
        const badge = li.querySelector('[data-field="status"]');
        badge.className += ' ' + badgeClass;
        badge.textContent = badgeText;

        li.addEventListener('click', () => {
            highlightStudent(st.id);
            selectStudent(st);
            document.body.classList.add('show-dashboard');
        });

        studentListEl.appendChild(li);
    });

    updateClassStats();

    // If currentStudent exists, refresh their data, otherwise select the first student
    const target = (currentStudent && students.find(s => s.id === currentStudent.id)) || students[0];
    if (target) {
        highlightStudent(target.id);
        selectStudent(target);
    } else {
        showEmptyClass();
    }
}

// 학급 현황판: 평균 정확도, 오늘 연습한 학생 수, 학생 수
function updateClassStats() {
    const total = students.length;
    const measured = students.filter(st => st.accuracy != null);
    const avg = measured.length
        ? Math.round(measured.reduce((sum, st) => sum + st.accuracy, 0) / measured.length) + '%'
        : '-';
    const today = new Date().toDateString();
    const doneToday = students.filter(st =>
        st.lastUpdatedAt && st.status === '완료' && new Date(toMillis(st.lastUpdatedAt)).toDateString() === today
    ).length;

    document.getElementById('stat-avg-accuracy').textContent = avg;
    document.getElementById('stat-today-done').textContent = `${doneToday}/${total}명`;
    document.getElementById('student-count').textContent = `학생 목록 (${total}명)`;
    document.getElementById('assign-target-all').textContent = `우리 반 전체 (${total}명)`;
}

function showEmptyClass() {
    currentStudent = null;
    dashboardContent.classList.add('hidden');
    emptyState.classList.remove('hidden');
    document.getElementById('empty-title').textContent = '아직 가입한 학생이 없어요';
    document.getElementById('empty-desc').textContent = teacherInfo
        ? `학생들에게 학급 코드 ${teacherInfo.classCode} 를 알려주고 회원가입하게 해주세요.`
        : '학생이 가입하면 이곳에 표시됩니다.';
}

function highlightStudent(id) {
    Array.from(studentListEl.children).forEach(child => {
        const active = child.dataset.id === id;
        child.classList.toggle('bg-yellow-100', active);
        child.classList.toggle('border-l-8', active);
        child.classList.toggle('border-secondary', active);
    });
}

function loadMockStudents() {
    const mockNames = ['김지훈', '박서연', '이도윤', '최유진', '정하준', '강민서', '조준우', '윤지아', '임서준', '한지우'];
    const statuses = ['완료', '진행중', '대기'];
    const rand = () => Math.floor(Math.random() * 20) + 75; // 75~95
    const day = 24 * 60 * 60 * 1000;

    students = mockNames.map((name, i) => {
        const status = statuses[i % 3];
        if (status === '대기') {
            return { id: `mock_${i}`, name, status, lastDate: '-', lastUpdatedAt: 0, mockSessions: [] };
        }
        const scores = { pronunciation: rand(), speed: rand(), volume: rand(), gaze: rand(), posture: rand(), gesture: rand() };
        const mockSessions = [3, 2, 1, 0].flatMap((weeksAgo, k) => {
            const createdAt = Date.now() - weeksAgo * 7 * day;
            return [
                { mode: 'reading', createdAt, avgScore: scores.pronunciation - (3 - k) * 5 },
                { mode: 'presentation', createdAt: createdAt + 3600000, wpm: 140 - k * 8 }
            ];
        });
        return {
            id: `mock_${i}`,
            name,
            status,
            accuracy: scores.pronunciation,
            lastDate: new Date().toLocaleString(),
            lastUpdatedAt: Date.now() - Math.random() * 10000000,
            scores,
            lastPresentation: { wpm: 116, habitCount: i % 2 ? 6 : 2, gestureRatio: 0.35, faceTouchRatio: 0, tiltRatio: 0 },
            lastReading: { wrongWords: ['읽었습니다', '닭'] },
            mockSessions
        };
    });

    students.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    renderStudentList();
}


// Select Student & Update Dashboard
async function selectStudent(st) {
    currentStudent = st;
    emptyState.classList.add('hidden');
    dashboardContent.classList.remove('hidden');

    stName.innerText = st.name || '이름 없음';
    stLastDate.innerText = st.lastDate || '기록 없음';

    const insights = buildInsights(st);
    const wList = insights.weaknesses.length > 0 ? insights.weaknesses : ['분석 데이터가 부족합니다.'];
    const rList = insights.recommendations.length > 0 ? insights.recommendations : ['낭독/발표 연습을 진행해주세요.'];
    renderList(stWeaknesses, wList);
    renderList(stRecommendations, rList);

    // Reset NEIS
    neisOutput.value = '';
    btnCopyNeis.disabled = true;

    updateRadarChart(radarFromStudent(st));

    // 회차별 기록 불러오기 (최근 30회)
    let sessions = st.mockSessions || [];
    if (!st.mockSessions) {
        try {
            const sq = query(collection(db, "students", st.id, "sessions"), orderBy("createdAt", "desc"), limit(30));
            sessions = (await getDocs(sq)).docs.map(d => d.data()).reverse();
        } catch (e) {
            console.error("Session history error:", e);
        }
    }
    if (currentStudent !== st) return; // 그 사이 다른 학생을 선택한 경우
    updateLineChart(sessions);
}

function renderList(listEl, items) {
    listEl.replaceChildren(...items.map(text => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
    }));
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
            labels: SCORE_LABELS,
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
                    min: 0, max: 100,
                    ticks: { display: false }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function updateLineChart(sessions) {
    const ctx = document.getElementById('lineChart').getContext('2d');
    if (lineChartInstance) lineChartInstance.destroy();

    const labels = sessions.map(s => {
        const d = new Date(toMillis(s.createdAt));
        return `${d.getMonth() + 1}/${d.getDate()}`;
    });

    lineChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: '발음 정확도 (%)',
                    data: sessions.map(s => s.mode === 'reading' ? s.avgScore : null),
                    borderColor: '#3B82F6', // primary blue
                    backgroundColor: '#3B82F6',
                    borderWidth: 4,
                    tension: 0.3,
                    spanGaps: true,
                    yAxisID: 'y'
                },
                {
                    label: '말하기 속도 (어절/분)',
                    data: sessions.map(s => s.mode === 'presentation' ? s.wpm : null),
                    borderColor: '#22C55E', // tertiary green
                    backgroundColor: '#22C55E',
                    borderWidth: 4,
                    borderDash: [5, 5],
                    tension: 0.3,
                    spanGaps: true,
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
                    title: { display: true, text: '속도 (어절/분)', font: { weight: 'black' } },
                    min: 0, max: 200
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
        const text = await askGemini('neis', {
            name: currentStudent.name,
            accuracy: currentStudent.accuracy,
            weaknesses: buildInsights(currentStudent).weaknesses,
            radar: radarFromStudent(currentStudent)
        });
        neisOutput.value = text;
        btnCopyNeis.disabled = false;
        
    } catch (error) {
        console.error("NEIS Gen Error:", error);
        neisOutput.value = '';
        btnCopyNeis.disabled = true;
        alert(`생기부 문구 생성에 실패했습니다. 잠시 후 다시 시도해주세요.\n(${error.message})`);
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
            
            if (isGuestMode || !teacherInfo) {
                alert('둘러보기 모드에서는 과제를 배포할 수 없습니다.');
                modalAssign.classList.add('hidden');
                return;
            }

            btn.innerText = '배포 중...';
            btn.disabled = true;

            try {
                await addDoc(collection(db, "assignments"), {
                    title: scriptTitle || '제목 없는 과제',
                    script: scriptText,
                    classCode: teacherInfo.classCode,
                    teacherId: teacherInfo.uid,
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

