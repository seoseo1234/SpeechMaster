import { auth, db } from './firebase.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signInWithPopup, 
    GoogleAuthProvider,
    updateProfile
} from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

// DOM Elements
const tabStudent = document.getElementById('tab-student');
const tabTeacher = document.getElementById('tab-teacher');
const roleDesc = document.getElementById('role-desc');
const loginForm = document.getElementById('login-form');
const btnGoogleLogin = document.getElementById('btn-google-login');
const authLoading = document.getElementById('auth-loading');

const nameInput = document.getElementById('name-input');
const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');

// State
let selectedRole = 'student'; // 'student' or 'teacher'

// Role Selection Logic
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
    
    roleDesc.innerText = '학생 계정으로 접속하여 스피치 연습을 시작합니다.';
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
    
    roleDesc.innerText = '선생님 계정으로 접속하여 학생들의 발표를 관리합니다.';
});

// Helper: Save user data to Firestore and redirect
async function handleUserAuthSuccess(user, nameStr) {
    try {
        const userDocRef = doc(db, 'users', user.uid);
        const docSnap = await getDoc(userDocRef);
        
        let finalRole = selectedRole;
        let finalName = nameStr || user.displayName || user.email.split('@')[0];

        // If user document doesn't exist, create it
        if (!docSnap.exists()) {
            await setDoc(userDocRef, {
                uid: user.uid,
                email: user.email,
                name: finalName,
                role: selectedRole, // Set role only on first creation
                createdAt: serverTimestamp()
            });
            
            // Update Auth Profile if name is provided
            if (nameStr && !user.displayName) {
                await updateProfile(user, { displayName: nameStr });
            }
        } else {
            // Document exists, retrieve data and FORCE UPDATE the role for prototyping purposes
            const data = docSnap.data();
            finalRole = selectedRole; // Use the currently selected tab
            finalName = data.name || finalName;
            
            // Update the document so they can switch roles easily during testing
            await updateDoc(userDocRef, { role: finalRole });
        }

        // 로그인 후 항상 홈화면(index.html)으로 이동하도록 수정
        window.location.href = 'index.html';

    } catch (error) {
        console.error("Firestore user save error:", error);
        alert('계정 정보를 저장하는 중 오류가 발생했습니다.');
        authLoading.classList.add('hidden');
    }
}

// Email Login / Register
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const nameStr = nameInput.value.trim();
    
    if(!email || !password) return;
    
    authLoading.classList.remove('hidden');
    
    try {
        // Try Login First
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        await handleUserAuthSuccess(userCredential.user, nameStr);
    } catch (error) {
        // If user not found, try Register
        if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential' || error.code === 'auth/invalid-login-credentials') {
            try {
                if(!nameStr) {
                    alert('새로 가입하려면 이름을 꼭 입력해주세요!');
                    authLoading.classList.add('hidden');
                    return;
                }
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                await handleUserAuthSuccess(userCredential.user, nameStr);
            } catch (regError) {
                console.error("Registration Error:", regError);
                alert(`가입 실패: ${regError.message}`);
                authLoading.classList.add('hidden');
            }
        } else {
            console.error("Login Error:", error);
            alert(`로그인 실패: ${error.message}`);
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
        const nameStr = nameInput.value.trim(); // Optional name override
        await handleUserAuthSuccess(result.user, nameStr);
    } catch (error) {
        console.error("Google Login Error:", error);
        if (error.code !== 'auth/popup-closed-by-user') {
            alert(`구글 로그인 실패: ${error.message}`);
        }
        authLoading.classList.add('hidden');
    }
});
