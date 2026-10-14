// auth.cjs — user accounts + login sessions for server.js.
//
// Accounts live in <data dir>/users.json, written by the app (host tab in the
// lobby). The file may also be edited by hand: a record carrying a plaintext
// `password` is hashed (scrypt) and rewritten on load, so the file never keeps
// a readable password. Users cannot change their password; only the host can
// set a new one.
//
// Sessions are stateless signed tokens (HMAC over name + expiry + the user's
// salt), so they survive a server restart and die when the host resets the
// password or disables the account.
//
// THREEDX_OPEN_LOGIN=1 keeps the legacy trusted-table mode (any username, no
// password, the name "gm" is the host) for tests and throwaway LAN sessions.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_FILE = 'users.json';
const MIN_USERNAME = 2;
const MAX_USERNAME = 20;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 200;
const MAX_USERS = 500;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 30 * 1000;
const ROLES = new Set(['host', 'user']);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validUsersSaveData(value) {
  return isRecord(value) && (!('users' in value) || isRecord(value.users));
}

function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_USERNAME);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createAuth({ dataDir, loadJSON, saveJSON, open = false }) {
  let signingKey = '';
  let users = Object.create(null);   // lowercase name -> record
  const failures = new Map();        // ip -> { count, until }

  function persist() {
    return saveJSON(USERS_FILE, { signingKey, users: { ...users } }, dataDir);
  }

  function load() {
    const data = loadJSON(USERS_FILE, { users: {} }, validUsersSaveData, dataDir);
    let dirty = false;
    signingKey = typeof data.signingKey === 'string' && data.signingKey.length >= 32 ? data.signingKey : '';
    if (!signingKey) { signingKey = randomHex(32); dirty = true; }
    const loaded = Object.create(null);
    for (const [key, raw] of Object.entries(data.users || {})) {
      if (!isRecord(raw)) continue;
      const username = cleanUsername(raw.username || key);
      if (username.length < MIN_USERNAME) continue;
      const record = {
        username,
        role: ROLES.has(raw.role) ? raw.role : 'user',
        trusted: raw.trusted === true,
        disabled: raw.disabled === true,
        salt: typeof raw.salt === 'string' ? raw.salt : '',
        hash: typeof raw.hash === 'string' ? raw.hash : '',
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
      };
      // Hand-written record: hash the plaintext password and drop it.
      if (typeof raw.password === 'string' && raw.password) {
        record.salt = randomHex(16);
        record.hash = hashPassword(raw.password, record.salt);
        dirty = true;
      }
      if (!record.salt || !record.hash) continue;
      if (username.toLowerCase() !== key) dirty = true;
      loaded[username.toLowerCase()] = record;
    }
    // A hand edit that leaves no usable account (typo, truncated file) must
    // not wipe the live accounts and reopen first-run setup.
    if (!Object.keys(loaded).length && Object.keys(users).length) {
      console.warn(`[AUTH] Ignoring ${USERS_FILE}: it no longer holds any valid account.`);
      return;
    }
    users = loaded;
    if (dirty) persist();
  }

  if (!open) {
    load();
    // Pick up hand edits (and new plaintext passwords) while running.
    fs.watchFile(path.join(dataDir, USERS_FILE), { interval: 2000 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs) load();
    }).unref();
  } else {
    signingKey = randomHex(32);
  }

  function recordFor(username) {
    if (typeof username !== 'string') return null;
    return users[username.toLowerCase()] || null;
  }

  function sign(username, expires, salt) {
    return crypto.createHmac('sha256', signingKey)
      .update(`${username.toLowerCase()}.${expires}.${salt}`).digest('hex');
  }

  function issueToken(username, salt) {
    const expires = Date.now() + TOKEN_TTL_MS;
    const name = Buffer.from(username, 'utf8').toString('base64url');
    return `${name}.${expires}.${sign(username, expires, salt)}`;
  }

  // -> canonical username, or null when the token is forged/expired/revoked.
  function verifyToken(token) {
    if (typeof token !== 'string' || token.length > 400) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const username = cleanUsername(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const expires = Number(parts[1]);
    if (username.length < MIN_USERNAME || !Number.isFinite(expires) || expires < Date.now()) return null;
    if (open) return safeEqual(parts[2], sign(username, expires, '')) ? username : null;
    const record = recordFor(username);
    if (!record || record.disabled) return null;
    return safeEqual(parts[2], sign(record.username, expires, record.salt)) ? record.username : null;
  }

  function lockedOut(ip) {
    const entry = failures.get(ip);
    return !!entry && entry.count >= MAX_FAILURES && entry.until > Date.now();
  }

  function noteFailure(ip) {
    const now = Date.now();
    const entry = failures.get(ip);
    const count = entry && entry.until > now ? entry.count + 1 : 1;
    failures.set(ip, { count, until: now + LOCKOUT_MS });
    if (failures.size > 5000) failures.clear();
  }

  function validateNewAccount(username, password) {
    if (username.length < MIN_USERNAME) return `Username must be ${MIN_USERNAME}-${MAX_USERNAME} characters`;
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return `Password must be at least ${MIN_PASSWORD} characters`;
    }
    return null;
  }

  function addUser(username, password, fields) {
    const salt = randomHex(16);
    const key = username.toLowerCase();
    users[key] = {
      username, role: 'user', trusted: false, disabled: false,
      salt, hash: hashPassword(password, salt), createdAt: Date.now(), ...fields
    };
    if (!persist()) { delete users[key]; return false; }
    return true;
  }

  function needsSetup() {
    return !open && Object.keys(users).length === 0;
  }

  // credentials: { token } | { username, password, setup? }
  // -> { ok, username, token } | { ok: false, error, expired? }
  function login(credentials, { ip = '', loopback = false } = {}) {
    const source = isRecord(credentials) ? credentials : {};
    if (typeof source.token === 'string' && source.token) {
      const username = verifyToken(source.token);
      if (!username) return { ok: false, expired: true, error: 'Session expired — please log in again' };
      return { ok: true, username, token: source.token };
    }
    const username = cleanUsername(source.username);
    if (open) {
      if (!username) return { ok: false, error: 'Invalid username' };
      return { ok: true, username, token: issueToken(username, '') };
    }
    if (needsSetup()) {
      if (!source.setup) return { ok: false, error: 'This server has no accounts yet — the host must set it up first' };
      if (!loopback) return { ok: false, error: 'The host account must be created from the host computer' };
      const problem = validateNewAccount(username, source.password);
      if (problem) return { ok: false, error: problem };
      if (!addUser(username, source.password, { role: 'host', trusted: true })) {
        return { ok: false, error: 'Could not save the account' };
      }
      return { ok: true, username, token: issueToken(username, users[username.toLowerCase()].salt) };
    }
    if (!username) return { ok: false, error: 'Enter your username and password' };
    if (lockedOut(ip)) return { ok: false, error: 'Too many attempts — wait a moment and try again' };
    const record = recordFor(username);
    const typed = typeof source.password === 'string' ? source.password.slice(0, MAX_PASSWORD) : '';
    // Hash even for unknown names so the answer time does not reveal them.
    const hash = hashPassword(typed, record ? record.salt : 'no-such-user');
    if (!record || !safeEqual(hash, record.hash)) {
      noteFailure(ip);
      return { ok: false, error: 'Wrong username or password' };
    }
    if (record.disabled) return { ok: false, error: 'This account is disabled' };
    failures.delete(ip);
    return { ok: true, username: record.username, token: issueToken(record.username, record.salt) };
  }

  function isHost(username) {
    if (!username) return false;
    if (open) return String(username).toLowerCase() === 'gm';
    const record = recordFor(username);
    return !!record && record.role === 'host' && !record.disabled;
  }

  // Trusted users create campaigns without host approval.
  function isTrusted(username) {
    if (open) return true;
    const record = recordFor(username);
    return !!record && !record.disabled && (record.role === 'host' || record.trusted);
  }

  // Canonical spelling of an existing, enabled account (open mode: any name).
  function canonical(username) {
    if (open) return cleanUsername(username) || null;
    const record = recordFor(username);
    return record && !record.disabled ? record.username : null;
  }

  function list() {
    return Object.values(users)
      .map(({ username, role, trusted, disabled, createdAt }) => ({ username, role, trusted, disabled, createdAt }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  function createUser({ username, password, trusted } = {}) {
    if (open) return { ok: false, error: 'Accounts are off in open-login mode' };
    const name = cleanUsername(username);
    const problem = validateNewAccount(name, password);
    if (problem) return { ok: false, error: problem };
    if (recordFor(name)) return { ok: false, error: 'That username is taken' };
    if (Object.keys(users).length >= MAX_USERS) return { ok: false, error: 'User limit reached' };
    if (!addUser(name, password, { trusted: trusted === true })) return { ok: false, error: 'Could not save the account' };
    return { ok: true, username: name };
  }

  // patch: { trusted?, disabled?, password? } — a new password or a disable
  // revokes the account's sessions (reported as `revoked`).
  function updateUser(username, patch = {}) {
    const record = recordFor(username);
    if (!record) return { ok: false, error: 'Unknown user' };
    const previous = { ...record };
    let revoked = false;
    if (typeof patch.trusted === 'boolean') record.trusted = patch.trusted;
    if (typeof patch.disabled === 'boolean') {
      if (patch.disabled && record.role === 'host') {
        Object.assign(record, previous);
        return { ok: false, error: 'The host account cannot be disabled' };
      }
      record.disabled = patch.disabled;
      revoked = revoked || patch.disabled;
    }
    if (patch.password !== undefined) {
      const problem = validateNewAccount(record.username, patch.password);
      if (problem) { Object.assign(record, previous); return { ok: false, error: problem }; }
      record.salt = randomHex(16);
      record.hash = hashPassword(patch.password, record.salt);
      revoked = true;
    }
    if (!persist()) { Object.assign(record, previous); return { ok: false, error: 'Could not save the account' }; }
    return { ok: true, username: record.username, revoked };
  }

  return {
    open, needsSetup, login, verifyToken, isHost, isTrusted, canonical,
    list, createUser, updateUser
  };
}

module.exports = { createAuth, validUsersSaveData, USERS_FILE };
