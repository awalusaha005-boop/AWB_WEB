// auth.js — Firebase Auth with Email Link (passwordless)
import { FIREBASE_CONFIG, ALLOWED_EMAILS } from "./firebase-config.js";

let auth = null;
let currentUser = null;
let authReady = false;
let authResolve = null;

// ── Init Firebase ──
export function initAuth() {
  return new Promise((resolve) => {
    authResolve = resolve;

    const scripts = [
      "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js",
    ];

    let loaded = 0;
    scripts.forEach((src) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => {
        loaded++;
        if (loaded === scripts.length) initFirebaseApp();
      };
      document.head.appendChild(script);
    });
  });
}

function initFirebaseApp() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();

    // Check for email link sign-in on page load
    if (firebase.auth().isSignInWithEmailLink(window.location.href)) {
      handleEmailLinkSignIn();
      return;
    }

    auth.onAuthStateChanged((user) => {
      currentUser = user;
      authReady = true;
      if (authResolve) {
        authResolve(user);
        authResolve = null;
      }
    });
  } catch (err) {
    console.error("Firebase init error:", err);
    authReady = true;
    if (authResolve) {
      authResolve(null);
      authResolve = null;
    }
  }
}

// ── Handle email link callback ──
async function handleEmailLinkSignIn() {
  let email = window.localStorage.getItem("emailForSignIn");
  if (!email) {
    email = window.prompt("Masukkan email untuk konfirmasi login:");
  }
  if (!email) return;

  try {
    const result = await auth.signInWithEmailLink(email, window.location.href);
    window.localStorage.removeItem("emailForSignIn");
    currentUser = result.user;
    // Redirect to app
    window.location.href = "/";
  } catch (err) {
    console.error("Email link sign-in error:", err);
    alert("Gagal verifikasi link. Mungkin link sudah kadaluarsa. Silakan minta link baru.");
    window.location.href = "/login.html";
  }
}

// ── Send email sign-in link ──
export async function sendEmailLink(email) {
  if (!auth) throw new Error("Auth not initialized");

  const actionCodeSettings = {
    url: window.location.origin + "/login.html",
    handleCodeInApp: true,
  };

  await auth.sendSignInLinkToEmail(email, actionCodeSettings);
  window.localStorage.setItem("emailForSignIn", email);
}

// ── Google Sign-In ──
export async function signInWithGoogle() {
  if (!auth) return null;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    return result.user;
  } catch (err) {
    console.error("Google sign-in error:", err);
    return null;
  }
}

// ── Sign Out ──
export async function signOut() {
  if (!auth) return;
  try {
    await auth.signOut();
  } catch (err) {
    console.error("Sign-out error:", err);
  }
}

// ── Check access ──
export function isAllowed(user) {
  if (!user) return false;
  if (ALLOWED_EMAILS.length === 0) return true;
  return ALLOWED_EMAILS.includes(user.email);
}

// ── Getters ──
export function getUser() { return currentUser; }
export function isReady() { return authReady; }