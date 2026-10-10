// auth.js - login / register
//
// The dashboard runs on the farmer's own laptop next to the Arduino (Web Serial only works
// locally), so accounts are kept in localStorage. Passwords are never stored as plain text,
// only a SHA-256 hash of "username:password".
// Note: this protects against someone casually reading the storage, it is not server-grade security.

const USERS_KEY = 'si_users';
const SESSION_KEY = 'si_session';

async function hashPassword(username, pass) {
  const data = new TextEncoder().encode(username.toLowerCase() + ':' + pass);
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // very old browser fallback (djb2) - weak, but still not plain text
  let h = 5381;
  for (const b of data) h = ((h << 5) + h + b) >>> 0;
  return 'djb2-' + h.toString(16);
}

function getUsers() { return store.get(USERS_KEY, {}); }

// a ready-made account so the project can be shown without registering first
async function ensureDemoUser() {
  const users = getUsers();
  if (!users.demo) {
    users.demo = { name: 'Demo Farmer', hash: await hashPassword('demo', 'demo123'), created: Date.now() };
    store.set(USERS_KEY, users);
  }
}

async function registerUser(username, name, pass, pass2) {
  username = username.trim().toLowerCase();
  name = name.trim();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Username: 3-20 letters, numbers or _');
  if (name.length < 2) throw new Error('Please enter your name');
  if (pass.length < 6) throw new Error('Password must be at least 6 characters');
  if (pass !== pass2) throw new Error('Passwords do not match');
  const users = getUsers();
  if (users[username]) throw new Error('That username is already taken');
  users[username] = { name, hash: await hashPassword(username, pass), created: Date.now() };
  store.set(USERS_KEY, users);
}

async function login(username, pass, remember) {
  username = username.trim().toLowerCase();
  const u = getUsers()[username];
  if (!u || u.hash !== await hashPassword(username, pass)) throw new Error('Wrong username or password');
  const session = JSON.stringify({ username, name: u.name, at: Date.now() });
  sessionStorage.setItem(SESSION_KEY, session);
  if (remember) localStorage.setItem(SESSION_KEY, session);
  else localStorage.removeItem(SESSION_KEY);
}

function currentUser() {
  try {
    const s = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
  location.href = 'index.html';
}

function requireLogin() {
  const u = currentUser();
  if (!u) location.replace('index.html');
  return u;
}
