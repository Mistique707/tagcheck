/**
 * TagCheck.
 *
 * One rule drives the whole interface: never let a member tag a bike before
 * they have seen an answer about that bike. Everything else -- the camera, the
 * offline mirror, the queue -- exists to make that answer arrive fast enough to
 * be useful while standing next to a parked motorcycle.
 */

import { bestReading, formatPlate, normalizePlate } from './shared/plate.js';
import { SYNC_INTERVAL_MS } from './config.js';
import {
  ApiError, OfflineError, api, apiUrl, session,
} from './api.js';
import {
  applyPlates, clearPlates, forgetLocalTag, getMeta, localPlate, localSimilar,
  queueAdd, queueAll, queueCount, queueRemove, rememberLocalTag, setMeta,
} from './store.js';
import { canvasFromImage, cropGuideRegion, readPlate, releaseEngine } from './ocr.js';

const $ = (id) => document.getElementById(id);

const el = {
  signin: $('view-signin'),
  app: $('view-app'),
  signinForm: $('signin-form'),
  signinError: $('signin-error'),
  name: $('input-name'),
  code: $('input-code'),
  server: $('input-server'),
  clubName: $('club-name'),
  topbarClub: $('topbar-club'),
  netChip: $('net-chip'),
  menuBtn: $('btn-menu'),
  menu: $('menu'),
  panels: {
    scan: $('panel-scan'),
    feed: $('panel-feed'),
    stats: $('panel-stats'),
  },
  cameraWrap: $('camera-wrap'),
  video: $('video'),
  cameraFallback: $('camera-fallback'),
  ocrStatus: $('ocr-status'),
  capture: $('btn-capture'),
  photo: $('input-photo'),
  manual: $('btn-manual'),
  result: $('panel-result'),
  closeResult: $('btn-close-result'),
  plateInput: $('plate-input'),
  plateMeta: $('plate-meta'),
  verdict: $('verdict'),
  similarBox: $('similar-box'),
  similarList: $('similar-list'),
  noteRow: $('note-row'),
  note: $('note-input'),
  tag: $('btn-tag'),
  recheck: $('btn-recheck'),
  untag: $('btn-untag'),
  feedList: $('feed-list'),
  feedMore: $('btn-feed-more'),
  leaderboard: $('leaderboard'),
  statTotal: $('stat-total'),
  statToday: $('stat-today'),
  statMembers: $('stat-members'),
  adminTools: $('admin-tools'),
  export: $('link-export'),
  sync: $('btn-sync'),
  locationToggle: $('btn-location'),
  signout: $('btn-signout'),
  toast: $('toast'),
};

const state = {
  stream: null,
  reading: null,
  lookup: null,
  feedMode: 'all',
  feedCursor: null,
  busy: false,
};

/* Small helpers ----------------------------------------------------------- */

function deviceId() {
  let id = localStorage.getItem('tagcheck.device');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID())
      || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('tagcheck.device', id);
  }
  return id;
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const locationEnabled = () => localStorage.getItem('tagcheck.location') === 'on';

/** Never let a slow fix hold up a tag: no answer within 4s means no answer. */
function currentPosition() {
  if (!locationEnabled() || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => resolve(null),
      { timeout: 4000, maximumAge: 60000, enableHighAccuracy: false },
    );
  });
}

/* Views ------------------------------------------------------------------- */

function showSignIn() {
  el.signin.hidden = false;
  el.app.hidden = true;
  stopCamera();
}

function showApp() {
  el.signin.hidden = true;
  el.app.hidden = false;
  showPanel('scan');
}

function showPanel(name) {
  for (const [key, panel] of Object.entries(el.panels)) panel.hidden = key !== name;
  el.menu.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
  if (name === 'scan') startCamera();
  else stopCamera();
  if (name === 'feed') loadFeed(true);
  if (name === 'stats') loadStats();
}

function setVerdict(kind, title, detail) {
  el.verdict.className = `verdict ${kind}`;
  el.verdict.querySelector('.verdict-title').textContent = title;
  el.verdict.querySelector('.verdict-detail').textContent = detail || '';
}

function updateNetChip() {
  queueCount().then((pending) => {
    if (pending > 0) {
      el.netChip.textContent = `${pending} to send`;
      el.netChip.className = 'chip pending';
    } else if (navigator.onLine) {
      el.netChip.textContent = 'online';
      el.netChip.className = 'chip';
    } else {
      el.netChip.textContent = 'offline';
      el.netChip.className = 'chip offline';
    }
  });
}

/* Camera ------------------------------------------------------------------ */

async function startCamera() {
  if (state.stream || !navigator.mediaDevices?.getUserMedia) {
    if (!navigator.mediaDevices?.getUserMedia) showCameraFallback();
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    el.video.srcObject = state.stream;
    await el.video.play().catch(() => {});
    el.cameraWrap.hidden = false;
    el.cameraFallback.hidden = true;
    el.capture.hidden = false;
  } catch {
    showCameraFallback();
  }
}

function showCameraFallback() {
  el.cameraWrap.hidden = true;
  el.cameraFallback.hidden = false;
  el.capture.hidden = true;
}

function stopCamera() {
  if (!state.stream) return;
  for (const track of state.stream.getTracks()) track.stop();
  state.stream = null;
  el.video.srcObject = null;
}

/* Scanning ---------------------------------------------------------------- */

function ocrStatus(message) {
  if (!message) {
    el.ocrStatus.hidden = true;
    return;
  }
  el.ocrStatus.hidden = false;
  el.ocrStatus.textContent = message;
}

async function scanFromCanvas(canvas) {
  if (state.busy) return;
  state.busy = true;
  el.capture.disabled = true;

  try {
    ocrStatus('preparing the image');
    const candidates = await readPlate(canvas, {
      onStage: (stage) => ocrStatus(stage),
      onProgress: (progress) => ocrStatus(`reading the characters (${Math.round(progress * 100)}%)`),
    });

    const reading = bestReading(candidates);
    ocrStatus(null);

    if (!reading) {
      openResult('', { unread: true });
      return;
    }
    openResult(reading.plate, { reading });
  } catch {
    ocrStatus(null);
    openResult('', { unread: true });
  } finally {
    state.busy = false;
    el.capture.disabled = false;
  }
}

async function captureFromVideo() {
  const rect = el.cameraWrap.getBoundingClientRect();
  const canvas = cropGuideRegion(el.video, rect.width, rect.height);
  if (!canvas) {
    toast('Camera is still warming up.');
    return;
  }
  await scanFromCanvas(canvas);
}

async function scanFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    await scanFromCanvas(canvasFromImage(image));
  } catch {
    toast('That image could not be read.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Result sheet ------------------------------------------------------------ */

function openResult(plate, { reading, unread, focus } = {}) {
  state.reading = reading || null;
  state.lookup = null;
  el.result.hidden = false;
  el.note.value = '';
  el.similarBox.hidden = true;
  el.untag.hidden = true;
  el.plateInput.value = plate ? formatPlate(plate) : '';

  if (unread) {
    el.plateMeta.textContent = 'Could not read it. Type the plate and check.';
    setVerdict('busy', 'Nothing read yet', 'Enter the plate above, then check.');
    el.tag.disabled = true;
  } else if (reading) {
    el.plateMeta.textContent = reading.corrected
      ? 'Corrected a look-alike character. Check it against the bike.'
      : 'Check this matches the plate in front of you.';
    lookupPlate(plate);
  }

  if (focus || unread) {
    el.plateInput.focus();
    el.plateInput.select();
  }
}

function closeResult() {
  el.result.hidden = true;
  state.reading = null;
  state.lookup = null;
}

function renderSimilar(similar) {
  if (!similar || !similar.length) {
    el.similarBox.hidden = true;
    return;
  }
  el.similarList.innerHTML = '';
  for (const item of similar) {
    const li = document.createElement('li');
    const plate = document.createElement('span');
    plate.className = 'plate';
    plate.textContent = formatPlate(item.plate);
    li.append(plate, document.createTextNode(
      ` - ${item.taggedBy}, ${timeAgo(item.createdAt)}`,
    ));
    el.similarList.append(li);
  }
  el.similarBox.hidden = false;
}

/** Answer from the phone when the network cannot be reached. */
async function offlineLookup(reading) {
  const hit = await localPlate(reading.plate);
  if (hit) {
    return {
      status: 'tagged',
      offline: true,
      tag: { plate: hit.plate, taggedBy: hit.taggedBy, createdAt: hit.createdAt, note: '' },
      similar: [],
    };
  }
  const similar = await localSimilar(reading.fuzzy, reading.plate);
  return {
    status: similar.length ? 'similar' : 'free',
    offline: true,
    tag: null,
    similar: similar.map((row) => ({
      plate: row.plate, taggedBy: row.taggedBy, createdAt: row.createdAt,
    })),
  };
}

async function lookupPlate(rawPlate) {
  const reading = normalizePlate(rawPlate);
  if (!reading.ok) {
    setVerdict('busy', 'That is not a plate yet', 'Check the characters and try again.');
    el.tag.disabled = true;
    return;
  }

  state.reading = reading;
  el.tag.disabled = true;
  setVerdict('busy', 'Checking...', 'Asking the club records.');

  let result;
  try {
    result = navigator.onLine ? await api.lookup(reading.plate) : await offlineLookup(reading);
  } catch (error) {
    if (error instanceof OfflineError) result = await offlineLookup(reading);
    else if (error instanceof ApiError && error.status === 401) {
      session.clear();
      showSignIn();
      return;
    } else {
      setVerdict('busy', 'Could not check', 'Try again in a moment.');
      return;
    }
  }

  state.lookup = result;
  const stale = result.offline ? ' Checked against the copy on this phone.' : '';

  if (result.status === 'tagged') {
    const tag = result.tag;
    setVerdict(
      'taken',
      'Already tagged',
      `${tag.taggedBy} tagged this bike ${timeAgo(tag.createdAt)}.${tag.note ? ` Note: ${tag.note}` : ''}${stale}`,
    );
    el.tag.disabled = true;
    renderSimilar([]);
    const member = session.member;
    const mine = member && tag.taggedById === member.id;
    el.untag.hidden = !(mine || (member && member.admin)) || result.offline || !tag.id;
  } else if (result.status === 'similar') {
    setVerdict(
      'maybe',
      'Almost a match',
      `A very similar plate is already tagged. Compare them, then tag only if this is a different bike.${stale}`,
    );
    renderSimilar(result.similar);
    el.tag.disabled = false;
  } else {
    setVerdict('free', 'Not tagged yet', `Nobody has tagged this bike. Go ahead.${stale}`);
    renderSimilar([]);
    el.tag.disabled = false;
  }
}

/* Tagging ----------------------------------------------------------------- */

async function tagCurrent() {
  const reading = normalizePlate(el.plateInput.value);
  if (!reading.ok) {
    toast('Check the plate first.');
    return;
  }

  el.tag.disabled = true;
  const position = await currentPosition();
  const payload = {
    plate: reading.plate,
    note: el.note.value.trim(),
    clientTagId: (crypto.randomUUID && crypto.randomUUID()) || `t-${Date.now()}-${Math.random()}`,
    ...(position || {}),
  };

  try {
    const result = await api.tag(payload);
    if (result.conflict) {
      state.lookup = result;
      setVerdict(
        'taken',
        'Someone got there first',
        `${result.tag.taggedBy} tagged this bike ${timeAgo(result.tag.createdAt)}. Leave it alone.`,
      );
      await rememberLocalTag({
        plate: result.tag.plate, fuzzy: reading.fuzzy, taggedBy: result.tag.taggedBy,
      });
      return;
    }
    await rememberLocalTag({
      plate: reading.plate, fuzzy: reading.fuzzy, taggedBy: result.tag.taggedBy,
    });
    setVerdict('free', 'Tagged', `Recorded as yours. ${formatPlate(reading.plate)} is now on the list.`);
    toast('Tagged. Hang the sign.');
    setTimeout(closeResult, 1200);
  } catch (error) {
    if (error instanceof OfflineError) {
      // Keep the member moving: queue it and let the server settle duplicates
      // when the phone reconnects.
      await queueAdd({ ...payload, fuzzy: reading.fuzzy, queuedAt: new Date().toISOString() });
      await rememberLocalTag({
        plate: reading.plate, fuzzy: reading.fuzzy, taggedBy: session.member?.name || 'you',
      });
      setVerdict('free', 'Saved on this phone', 'It will be sent as soon as you have signal.');
      toast('Saved offline.');
      setTimeout(closeResult, 1400);
    } else if (error instanceof ApiError && error.status === 401) {
      session.clear();
      showSignIn();
    } else {
      toast('Could not save that. Try again.');
      el.tag.disabled = false;
    }
  } finally {
    updateNetChip();
  }
}

async function untagCurrent() {
  const tag = state.lookup?.tag;
  if (!tag?.id) return;
  try {
    await api.untag(tag.id);
    await forgetLocalTag(tag.plate);
    toast('Tag removed.');
    await lookupPlate(tag.plate);
  } catch (error) {
    toast(error instanceof OfflineError ? 'Needs a connection.' : 'Could not remove that tag.');
  }
}

/* Queue and sync ---------------------------------------------------------- */

async function flushQueue() {
  if (!navigator.onLine || !session.token) return;
  const pending = await queueAll();
  let sent = 0;

  for (const item of pending) {
    try {
      const result = await api.tag(item);
      await queueRemove(item.clientTagId);
      // A conflict still resolves the item: the bike is tagged either way.
      if (result.conflict) {
        await rememberLocalTag({
          plate: result.tag.plate, fuzzy: item.fuzzy, taggedBy: result.tag.taggedBy,
        });
      } else {
        sent += 1;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        await queueRemove(item.clientTagId);
      }
      break;
    }
  }

  if (sent) toast(`${sent} queued tag${sent > 1 ? 's' : ''} sent.`);
  updateNetChip();
}

async function syncPlates({ announce } = {}) {
  if (!navigator.onLine || !session.token) return;
  try {
    const since = await getMeta('lastSync');
    const result = await api.sync(since);
    if (result.full) await clearPlates();
    await applyPlates(result.plates);
    await setMeta('lastSync', result.now);
    if (announce) toast(`Up to date. ${result.plates.length} change${result.plates.length === 1 ? '' : 's'}.`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session.clear();
      showSignIn();
    } else if (announce) {
      toast('Could not sync right now.');
    }
  }
}

/* Feed and stats ---------------------------------------------------------- */

async function loadFeed(reset) {
  if (reset) {
    el.feedList.innerHTML = '';
    state.feedCursor = null;
  }
  try {
    const result = await api.feed({
      mine: state.feedMode === 'mine',
      before: state.feedCursor,
    });
    for (const tag of result.tags) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const plate = document.createElement('span');
      plate.className = 'plate';
      plate.textContent = formatPlate(tag.plate);
      left.append(plate);
      if (tag.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = tag.note;
        left.append(note);
      }
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = `${tag.taggedBy}\n${timeAgo(tag.createdAt)}`;
      who.style.whiteSpace = 'pre-line';
      li.append(left, who);
      el.feedList.append(li);
    }
    state.feedCursor = result.nextBefore;
    el.feedMore.hidden = result.tags.length < 50;
    if (!el.feedList.children.length) {
      el.feedList.innerHTML = '<li class="muted">Nothing tagged yet.</li>';
    }
  } catch {
    if (!el.feedList.children.length) {
      el.feedList.innerHTML = '<li class="muted">Recent tags need a connection.</li>';
    }
  }
}

async function loadStats() {
  try {
    const result = await api.stats();
    el.statTotal.textContent = result.total;
    el.statToday.textContent = result.today;
    el.statMembers.textContent = result.members;
    el.leaderboard.innerHTML = '';
    for (const row of result.leaderboard) {
      const li = document.createElement('li');
      li.append(document.createTextNode(`${row.name} `));
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `- ${row.tags}`;
      li.append(count);
      el.leaderboard.append(li);
    }
    const member = session.member;
    el.adminTools.hidden = !(member && member.admin);
    el.export.href = apiUrl('/api/export.csv');
  } catch {
    toast('Totals need a connection.');
  }
}

/* Sign in ----------------------------------------------------------------- */

async function loadClub() {
  try {
    const club = await api.club();
    el.clubName.textContent = club.name;
    el.topbarClub.textContent = club.name;
    document.title = club.name === 'TagCheck' ? 'TagCheck' : `${club.name} - TagCheck`;
  } catch {
    // The club name is decoration; the app works without it.
  }
}

async function handleSignIn(event) {
  event.preventDefault();
  el.signinError.hidden = true;

  const serverValue = el.server.value.trim();
  if (serverValue) session.base = serverValue;
  else session.base = '';

  try {
    const result = await api.signIn(el.code.value, el.name.value, deviceId());
    session.save(result);
    await clearPlates();
    await setMeta('lastSync', '');
    showApp();
    await loadClub();
    await syncPlates();
    updateNetChip();
  } catch (error) {
    const message = error instanceof OfflineError
      ? 'Cannot reach the club server. Check the address and your signal.'
      : (error.code === 'bad_code' ? 'That club code is not right.' : 'Could not sign in. Try again.');
    el.signinError.textContent = message;
    el.signinError.hidden = false;
  }
}

function signOut() {
  session.clear();
  clearPlates();
  setMeta('lastSync', '');
  releaseEngine();
  showSignIn();
}

/* Wiring ------------------------------------------------------------------ */

function wire() {
  el.signinForm.addEventListener('submit', handleSignIn);

  el.menuBtn.addEventListener('click', () => {
    const open = el.menu.hidden;
    el.menu.hidden = !open;
    el.menuBtn.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (event) => {
    if (!el.menu.hidden && !el.menu.contains(event.target) && event.target !== el.menuBtn) {
      el.menu.hidden = true;
      el.menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  for (const button of el.menu.querySelectorAll('[data-nav]')) {
    button.addEventListener('click', () => showPanel(button.dataset.nav));
  }

  el.capture.addEventListener('click', captureFromVideo);
  el.manual.addEventListener('click', () => openResult('', { focus: true, unread: true }));
  el.photo.addEventListener('change', () => {
    const [file] = el.photo.files;
    if (file) scanFromFile(file);
    el.photo.value = '';
  });

  el.closeResult.addEventListener('click', closeResult);
  el.recheck.addEventListener('click', () => lookupPlate(el.plateInput.value));
  el.tag.addEventListener('click', tagCurrent);
  el.untag.addEventListener('click', untagCurrent);

  // Editing the plate invalidates the previous answer, so the tag button waits
  // until the corrected plate has been checked.
  el.plateInput.addEventListener('input', () => {
    el.tag.disabled = true;
    setVerdict('busy', 'Not checked yet', 'Press Check again once the plate is right.');
  });
  el.plateInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      el.plateInput.blur();
      lookupPlate(el.plateInput.value);
    }
  });

  for (const button of document.querySelectorAll('[data-feed]')) {
    button.addEventListener('click', () => {
      state.feedMode = button.dataset.feed;
      for (const other of document.querySelectorAll('[data-feed]')) {
        other.classList.toggle('active', other === button);
      }
      loadFeed(true);
    });
  }

  el.feedMore.addEventListener('click', () => loadFeed(false));
  el.sync.addEventListener('click', async () => {
    el.menu.hidden = true;
    await flushQueue();
    await syncPlates({ announce: true });
  });

  el.locationToggle.addEventListener('click', () => {
    const next = !locationEnabled();
    localStorage.setItem('tagcheck.location', next ? 'on' : 'off');
    renderLocationToggle();
  });

  el.signout.addEventListener('click', signOut);

  window.addEventListener('online', () => {
    updateNetChip();
    flushQueue().then(() => syncPlates());
  });
  window.addEventListener('offline', updateNetChip);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !el.app.hidden) {
      flushQueue().then(() => syncPlates());
      if (el.panels.scan.hidden === false) startCamera();
    } else {
      stopCamera();
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') syncPlates();
  }, SYNC_INTERVAL_MS);
}

function renderLocationToggle() {
  const on = locationEnabled();
  el.locationToggle.textContent = `Save location with tags: ${on ? 'on' : 'off'}`;
  el.locationToggle.setAttribute('aria-pressed', String(on));
}

async function boot() {
  wire();
  renderLocationToggle();
  updateNetChip();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  await loadClub();

  if (session.token && session.member) {
    showApp();
    await flushQueue();
    await syncPlates();
  } else {
    showSignIn();
    el.server.value = session.base;
  }
}

boot();
