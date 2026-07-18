// ═══════════════════════════════════════════════════════
// auth.js — Login module (glass morphism, single kode akses)
// ═══════════════════════════════════════════════════════

const AUTH_KEY = "awb_auth";
const AUTH_API = "/api/auth";
const DEVICE_ID_KEY = "awb_device_id";

// ── State ──
let authUser = null;
let _onLogin = null;

// ── Device ID ──
function getOrCreateDeviceId() {
  try {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (deviceId) return deviceId;
    
    // Generate device ID
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      deviceId = crypto.randomUUID();
    } else {
      // Fallback: kombinasi user agent + screen + timezone + random
      const ua = navigator.userAgent || "";
      const screen = `${window.screen.width}x${window.screen.height}`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const rand = Math.random().toString(36).substring(2, 15);
      deviceId = btoa(`${ua}|${screen}|${tz}|${rand}`).replace(/[^a-zA-Z0-9]/g, "").substring(0, 32);
    }
    
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    return deviceId;
  } catch {
    return "unknown-device";
  }
}

// ── Init ──
export function initAuth(onLogin) {
  _onLogin = onLogin;
  authUser = loadAuth();
  if (authUser) {
    if (onLogin) setTimeout(onLogin, 0);
    return true;
  }
  showLoginOverlay();
  return false;
}

export function getAuthUser() {
  return authUser;
}

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const now = Date.now();
    if (data.expires && data.expires < now) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveAuth(username, tipe) {
  const data = {
    username,
    tipe,
    expires: Date.now() + 24 * 60 * 60 * 1000,
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(data));
  authUser = data;
}

export function logout() {
  localStorage.removeItem(AUTH_KEY);
  authUser = null;
  showLoginOverlay();
}

// ── Login Overlay ──
function showLoginOverlay() {
  const existing = document.getElementById("loginOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "loginOverlay";
  overlay.className = "login-overlay";
  overlay.innerHTML = `
    <div class="login-bg">
      <div class="login-dotgrid"></div>
      <div class="login-glow"></div>
    </div>
    <div class="login-card">
      <div class="login-logo">
        <img src="New-AWB.png" alt="SiCepat Jinxpro" class="login-logo-icon">
        <div class="login-logo-ring"></div>
      </div>
      <h2 class="login-title">SICEPAT JINXPRO</h2>
      <p class="login-subtitle">Masukkan kode akses untuk melanjutkan</p>

      <div class="login-field">
        <label class="login-label">Kode Akses</label>
        <input id="loginKodeAkses" type="text" class="login-input" placeholder="AWB-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
      </div>

      <div id="loginError" class="login-error hidden"></div>

      <button id="loginBtn" class="login-btn">
        <span class="login-btn-text">Masuk</span>
        <span class="login-btn-spinner hidden"></span>
      </button>

      <p class="login-footer">SiCepat Jinxpro · v2.0 WEB</p>
    </div>
  `;

  document.body.appendChild(overlay);

  // Events
  const kodeEl = document.getElementById("loginKodeAkses");
  const btn = document.getElementById("loginBtn");
  const errorEl = document.getElementById("loginError");

  btn.addEventListener("click", () => doLogin(kodeEl, btn, errorEl));
  kodeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin(kodeEl, btn, errorEl);
  });

  setTimeout(() => kodeEl.focus(), 300);
}

async function doLogin(kodeEl, btn, errorEl) {
  const kodeAkses = kodeEl.value.trim();

  if (!kodeAkses) {
    showError(errorEl, "Kode akses wajib diisi");
    return;
  }

  setLoading(btn, true);
  hideError(errorEl);

  try {
    const deviceId = getOrCreateDeviceId();
    const resp = await fetch(AUTH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kodeAkses, deviceId }),
    });

    const data = await resp.json();

    if (data.ok) {
      saveAuth(data.username, data.tipe);
      const overlay = document.getElementById("loginOverlay");
      if (overlay) {
        overlay.classList.add("login-overlay-out");
        setTimeout(() => {
          overlay.remove();
          if (_onLogin) _onLogin();
        }, 400);
      }
    } else {
      showError(errorEl, data.message || "Kode akses tidak valid");
    }
  } catch (err) {
    showError(errorEl, "Gagal terhubung. Coba lagi.");
  } finally {
    setLoading(btn, false);
  }
}

function setLoading(btn, loading) {
  const text = btn.querySelector(".login-btn-text");
  const spinner = btn.querySelector(".login-btn-spinner");
  if (loading) {
    text.classList.add("hidden");
    spinner.classList.remove("hidden");
    btn.disabled = true;
  } else {
    text.classList.remove("hidden");
    spinner.classList.add("hidden");
    btn.disabled = false;
  }
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.add("login-error-shake");
  setTimeout(() => el.classList.remove("login-error-shake"), 500);
}

function hideError(el) {
  el.classList.add("hidden");
  el.textContent = "";
}