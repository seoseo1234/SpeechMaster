import { auth, db } from './firebase.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signInWithPopup, 
    GoogleAuthProvider,
    updateProfile
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';

// DOM Elements
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formTitle = document.getElementById('form-title');
const roleDesc = document.getElementById('role-desc');
const registerFields = document.getElementById('register-fields');
const passwordConfirmContainer = document.getElementById('password-confirm-container');
const passwordConfirmInput = document.getElementById('password-confirm-input');
const btnSubmit = document.getElementById('btn-submit');

const tabStudent = document.getElementById('tab-student');
const tabTeacher = document.getElementById('tab-teacher');
const loginForm = document.getElementById('login-form');
const btnGoogleLogin = document.getElementById('btn-google-login');
const authLoading = document.getElementById('auth-loading');

const nameInput = document.getElementById('name-input');
const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');

const classCodeContainer = document.getElementById('class-code-container');
const classCodeInput = document.getElementById('class-code-input');

// State
let authMode = 'login'; // 'login' or 'register'
let selectedRole = 'student'; // 'student' or 'teacher'

// --- Auth Mode Tabs (Login / Register) ---
function setAuthMode(mode) {
    authMode = mode;
    if (mode === 'login') {
        tabLogin.classList.replace('bg-surface-variant', 'bg-white');
        tabLogin.classList.replace('text-gray-500', 'text-black');
        tabLogin.classList.add('shadow-brutalist-sm', 'border-2', 'border-black');
        
        tabRegister.classList.replace('bg-white', 'bg-transparent');
        tabRegister.classList.replace('text-black', 'text-gray-500');
        tabRegister.classList.remove('shadow-brutalist-sm', 'border-2', 'border-black');
        
        formTitle.innerText = '로그인';
        roleDesc.innerText = '등록된 이메일과 비밀번호로 로그인하세요.';
        registerFields.style.display = 'none';
        passwordConfirmContainer.style.display = 'none';
        btnSubmit.innerText = '로그인';
        
        nameInput.removeAttribute('required');
        classCodeInput.removeAttribute('required');
        passwordConfirmInput.removeAttribute('required');
    } else {
        tabRegister.classList.replace('bg-surface-variant', 'bg-white');
        tabRegister.classList.replace('text-gray-500', 'text-black');
        tabRegister.classList.add('shadow-brutalist-sm', 'border-2', 'border-black');
        
        tabLogin.classList.replace('bg-white', 'bg-transparent');
        tabLogin.classList.replace('text-black', 'text-gray-500');
        tabLogin.classList.remove('shadow-brutalist-sm', 'border-2', 'border-black');
        
        formTitle.innerText = '회원가입';
        roleDesc.innerText = selectedRole === 'student' ? '학생 계정으로 가입하여 스피치 연습을 시작합니다.' : '선생님 계정으로 가입하여 학급을 관리합니다.';
        registerFields.style.display = 'flex';
        passwordConfirmContainer.style.display = 'block';
        btnSubmit.innerText = '회원가입 완료';
        
        nameInput.setAttribute('required', 'true');
        passwordConfirmInput.setAttribute('required', 'true');
        if (selectedRole === 'student') {
            classCodeInput.setAttribute('required', 'true');
        } else {
            classCodeInput.removeAttribute('required');
        }
    }
}

tabLogin.addEventListener('click', () => setAuthMode('login'));
tabRegister.addEventListener('click', () => setAuthMode('register'));

// --- Role Selection Logic (Only for Register) ---
tabStudent.addEventListener('click', () => {
    selectedRole = 'student';
    tabStudent.classList.replace('bg-surface', 'bg-secondary');
    tabStudent.classList.replace('text-gray-500', 'text-black');
    tabStudent.classList.replace('border-b-4', 'border-b-8');
    tabStudent.classList.remove('opacity-70');
    
    tabTeacher.classList.replace('bg-secondary', 'bg-surface');
    tabTeacher.classList.replace('text-black', 'text-gray-500');
    tabTeacher.classList.replace('border-b-8', 'border-b-4');
    tabTeacher.classList.add('opacity-70');
    
    if(authMode === 'register') roleDesc.innerText = '학생 계정으로 가입하여 스피치 연습을 시작합니다.';
    if(classCodeContainer) classCodeContainer.style.display = 'block';
    if(authMode === 'register') classCodeInput.setAttribute('required', 'true');
});

tabTeacher.addEventListener('click', () => {
    selectedRole = 'teacher';
    tabTeacher.classList.replace('bg-surface', 'bg-secondary');
    tabTeacher.classList.replace('text-gray-500', 'text-black');
    tabTeacher.classList.replace('border-b-4', 'border-b-8');
    tabTeacher.classList.remove('opacity-70');
    
    tabStudent.classList.replace('bg-secondary', 'bg-surface');
    tabStudent.classList.replace('text-black', 'text-gray-500');
    tabStudent.classList.replace('border-b-8', 'border-b-4');
    tabStudent.classList.add('opacity-70');
    
    if(authMode === 'register') roleDesc.innerText = '선생님 계정으로 가입하여 학급을 관리합니다.';
    if(classCodeContainer) classCodeContainer.style.display = 'none';
    classCodeInput.removeAttribute('required');
});

// Generate 5-character random class code
function generateClassCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Helper: Save user data to Firestore
async function handleUserRegistrationSuccess(user, nameStr) {
    try {
        const userDocRef = doc(db, 'users', user.uid);
        
        const userData = {
            uid: user.uid,
            email: user.email,
            name: nameStr,
            role: selectedRole,
            createdAt: serverTimestamp()
        };
        
        if (selectedRole === 'student') {
            userData.classCode = classCodeInput.value.trim().toUpperCase();
        } else if (selectedRole === 'teacher') {
            userData.classCode = generateClassCode(); // Assign a random class code to the teacher
        }

        await setDoc(userDocRef, userData);
        
        if (!user.displayName) {
            await updateProfile(user, { displayName: nameStr });
        }
        
        window.location.href = 'index.html';
    } catch (error) {
        console.error("Firestore user save error:", error);
        alert('계정 정보를 저장하는 중 오류가 발생했습니다.');
        authLoading.classList.add('hidden');
    }
}

// Form Submit
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    
    if(!email || !password) return;
    
    authLoading.classList.remove('hidden');
    
    if (authMode === 'login') {
        try {
            await signInWithEmailAndPassword(auth, email, password);
            window.location.href = 'index.html';
        } catch (error) {
            console.error("Login Error:", error);
            alert(`로그인 실패: 이메일 또는 비밀번호가 올바르지 않습니다.`);
            authLoading.classList.add('hidden');
        }
    } else if (authMode === 'register') {
        const passwordConfirm = passwordConfirmInput.value;
        const nameStr = nameInput.value.trim();
        
        if (password !== passwordConfirm) {
            alert('비밀번호가 일치하지 않습니다.');
            authLoading.classList.add('hidden');
            return;
        }
        if (selectedRole === 'student' && !classCodeInput.value.trim()) {
            alert('선생님에게 받은 학급 코드를 입력해주세요.');
            authLoading.classList.add('hidden');
            return;
        }

        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            await handleUserRegistrationSuccess(userCredential.user, nameStr);
        } catch (error) {
            console.error("Registration Error:", error);
            if (error.code === 'auth/email-already-in-use') {
                alert('이미 가입된 이메일입니다. 로그인 탭을 이용해주세요.');
            } else {
                alert(`가입 실패: ${error.message}`);
            }
            authLoading.classList.add('hidden');
        }
    }
});

// Google Login
btnGoogleLogin.addEventListener('click', async () => {
    const provider = new GoogleAuthProvider();
    authLoading.classList.remove('hidden');
    
    try {
        const result = await signInWithPopup(auth, provider);
        const userDocRef = doc(db, 'users', result.user.uid);
        const docSnap = await getDoc(userDocRef);
        
        if (!docSnap.exists()) {
            // First time Google Login -> register
            const nameStr = nameInput.value.trim() || result.user.displayName || result.user.email.split('@')[0];
            await handleUserRegistrationSuccess(result.user, nameStr);
        } else {
            // Returning user -> just login
            window.location.href = 'index.html';
        }
    } catch (error) {
        console.error("Google Login Error:", error);
        if (error.code !== 'auth/popup-closed-by-user') {
            alert(`구글 로그인 실패: ${error.message}`);
        }
        authLoading.classList.add('hidden');
    }
});

