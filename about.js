import { auth, db } from './firebase.js';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

const navContainer = document.getElementById('nav-links-container');

const isGuestMode = localStorage.getItem('guestMode') === 'true';
const guestRole = localStorage.getItem('guestRole') || 'student';

// Authentication state observer for Nav
onAuthStateChanged(auth, async (user) => {
    if (user) {
        let role = 'student';
        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if(userDoc.exists()) role = userDoc.data().role || 'student';
        } catch (e) {
            console.error(e);
        }

        const dashboardHtml = role === 'teacher' ? '<a href="teacher.html">DASHBOARD</a>' : '';
        
        navContainer.innerHTML = `
            <a href="index.html" onclick="localStorage.removeItem('guestMode'); localStorage.removeItem('guestRole');">HOME</a>
            <a href="about.html" class="active">ABOUT</a>
            ${dashboardHtml}
            <a href="#" id="nav-logout-btn" style="cursor: pointer;">LOGOUT</a>
        `;
    } else {
        if (isGuestMode) {
            const dashboardHtml = guestRole === 'teacher' ? '<a href="teacher.html">DASHBOARD</a>' : '';
            navContainer.innerHTML = `
                <a href="index.html" onclick="localStorage.removeItem('guestMode'); localStorage.removeItem('guestRole');">HOME</a>
                <a href="about.html" class="active">ABOUT</a>
                ${dashboardHtml}
                <a href="#" id="nav-logout-btn" style="cursor: pointer;">LOGOUT</a>
            `;
        } else {
            navContainer.innerHTML = `
                <a href="index.html" onclick="localStorage.removeItem('guestMode'); localStorage.removeItem('guestRole');">HOME</a>
                <a href="about.html" class="active">ABOUT</a>
                <a href="login.html">LOGIN</a>
            `;
        }
    }
});

// Event Delegation for Logout
document.addEventListener('click', (e) => {
    if(e.target && e.target.id === 'nav-logout-btn') {
        e.preventDefault();
        localStorage.removeItem('guestMode');
        localStorage.removeItem('guestRole');
        signOut(auth).then(() => {
            window.location.href = 'index.html';
        });
    }
});

// Scroll Reveal Animation (Intersection Observer)
function reveal() {
    var reveals = document.querySelectorAll(".reveal");
    for (var i = 0; i < reveals.length; i++) {
        var windowHeight = window.innerHeight;
        var elementTop = reveals[i].getBoundingClientRect().top;
        var elementVisible = 150;
        
        if (elementTop < windowHeight - elementVisible) {
            reveals[i].classList.add("active");
        }
    }
}

window.addEventListener("scroll", reveal);
reveal(); // Trigger on load
