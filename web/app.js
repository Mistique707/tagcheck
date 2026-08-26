/**
 * TagCheck.
 *
 * One rule drives the whole interface: never let a member tag a bike before
 * they have seen an answer about that bike. Everything else -- the camera, the
 * offline mirror, the queue -- exists to make that answer arrive fast enough to
 * be useful while standing next to a parked motorcycle.
 *
 * Where the records live is decided in backend.js, and nothing here needs to
 * know which one was chosen.
 */

import { formatPlate, normalizePlate, usefulAlternatives } from './shared/plate.js';
import { SYNC_INTERVAL_MS } from './config.js';
import { getBackend } from './backend.js';
import {
  canvasFromImage, cropGuideRegion, releaseEngine, scanPlate, sharpest,
} from './ocr.js';

const $ = (id) => document.getElementById(id);

const el = {
  signin: $('view-signin'),
  app: $('view-app'),
  signinForm: $('signin-form'),
  signinError: $('signin-error'),
  name: $('input-name'),
  code: $('input-code'),
  server: $('input-server'),
  codeFallback: $('code-fallback'),
  serverFallback: $('server-fallback'),
  tally: $('my-tally'),
  tallyMine: $('tally-mine'),
  tallyAll: $('tally-all'),
  clubName: $('club-name'),
  topbarClub: $('topbar-club'),
  netChip: $('net-chip'),
  menuBtn: $('btn-menu'),
  menu: $('menu'),
  panels: { scan: $('panel-scan'), feed: $('panel-feed'), stats: $('panel-stats') },
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
  alternatives: $('alternatives'),
  alternativeList: $('alternative-list'),
  verdict: $('verdict'),
  similarBox: $('similar-box'),
  similarList: $('similar-list'),
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

let backend;

/* Small helpers ----------------------------------------------------------- */

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3600);
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

/**
 * The club code travels in the invite link so nobody has to type it:
 *
 *   https://your-club.web.app/#join=RIDE01
 *
 * It is remembered on first open, because a phone launching the app from the
 * home screen will not have the link any more. The fragment is then wiped from
 * the address bar so the code is not sitting in a screenshot.
 */
function takeCodeFromLink() {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('join');
  const fromQuery = new URLSearchParams(location.search).get('join');
  const code = (fromHash || fromQuery || '').trim();

  if (code) {
    localStorage.setItem('tagcheck.code', code);
    history.replaceState(null, '', location.pathname);
  }
  return localStorage.getItem('tagcheck.code') || '';
}

async function refreshTally() {
  try {
    const result = await backend.stats();
    el.tallyMine.textContent = result.mine ?? 0;
    el.tallyAll.textContent = result.total ?? 0;
    el.tally.hidden = false;
  } catch {
    el.tally.hidden = true;
  }
}

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

function handleSignedOut() {
  toast('Signed out. Please join again.');
  showSignIn();
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
  refreshTally();
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

async function updateNetChip() {
  const pending = await backend.pendingCount().catch(() => 0);
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
    const { reading, readings, sawText } = await scanPlate(canvas, {
      onStage: (stage) => ocrStatus(stage),
    });
    ocrStatus(null);

    if (!reading) openResult('', { unread: true, sawText, readings });
    else openResult(reading.plate, { reading, readings });
  } catch {
    ocrStatus(null);
    openResult('', { unread: true });
  } finally {
    state.busy = false;
    el.capture.disabled = false;
  }
}

/**
 * Grab a short burst rather than a single frame.
 *
 * Frames a tenth of a second apart differ enormously in a held hand: one is
 * focused, the next is smeared. Taking three and keeping the sharpest costs
 * about a third of a second and removes the commonest cause of a failed read.
 */
async function captureFromVideo() {
  const rect = el.cameraWrap.getBoundingClientRect();
  const frames = [];
  for (let i = 0; i < 3; i += 1) {
    const frame = cropGuideRegion(el.video, rect.width, rect.height);
    if (frame) frames.push(frame);
    if (i < 2) await new Promise((resolve) => { setTimeout(resolve, 110); });
  }
  if (!frames.length) {
    toast('Camera is still warming up.');
    return;
  }
  await scanFromCanvas(sharpest(frames));
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

function openResult(plate, { reading, unread, focus, sawText, readings } = {}) {
  state.reading = reading || null;
  state.lookup = null;
  el.result.hidden = false;
  el.note.value = '';
  el.similarBox.hidden = true;
  el.untag.hidden = true;
  el.plateInput.value = plate ? formatPlate(plate) : '';
  renderAlternatives(readings, plate);

  if (unread) {
    // Showing what the camera actually read turns a dead end into something a
    // member can judge: bad angle, bad light, or the box was on the wrong bike.
    el.plateMeta.textContent = sawText
      ? `Could not make a plate of it. The camera read: ${sawText}`
      : 'Could not read it. Type the plate and check.';
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
  el.alternatives.hidden = true;
}

/**
 * Offer the runners-up as one-tap corrections.
 *
 * Recognition gets a real plate exactly right about half the time, and no
 * amount of preprocessing changed that. What does change the experience is
 * that the right answer is usually in the top few readings -- so showing them
 * turns a wrong result into a single touch rather than a retype.
 */
function renderAlternatives(readings, chosen) {
  const others = usefulAlternatives(readings, chosen);
  if (!others.length) {
    el.alternatives.hidden = true;
    return;
  }

  el.alternativeList.innerHTML = '';
  for (const item of others) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.pretty || formatPlate(item.plate);
    button.addEventListener('click', () => {
      el.plateInput.value = formatPlate(item.plate);
      el.alternatives.hidden = true;
      lookupPlate(item.plate);
    });
    el.alternativeList.append(button);
  }
  el.alternatives.hidden = false;
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
    li.append(plate, document.createTextNode(` - ${item.taggedBy}, ${timeAgo(item.createdAt)}`));
    el.similarList.append(li);
  }
  el.similarBox.hidden = false;
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
  // The previous answer is stale from here on, including who could undo it.
  el.untag.hidden = true;
  setVerdict('busy', 'Checking...', 'Asking the club records.');

  let result;
  try {
    result = await backend.lookup(reading);
  } catch (error) {
    if (error.code === 'signed_out') {
      handleSignedOut();
      return;
    }
    setVerdict('busy', 'Could not check', 'Try again in a moment.');
    return;
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
    el.untag.hidden = !backend.canUntag(tag);
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

  try {
    const result = await backend.tag({
      reading,
      note: el.note.value.trim(),
      lat: position?.lat,
      lon: position?.lon,
    });

    if (result.status === 'conflict') {
      state.lookup = { status: 'tagged', tag: result.tag, similar: [] };
      setVerdict(
        'taken',
        'Someone got there first',
        `${result.tag.taggedBy} tagged this bike ${timeAgo(result.tag.createdAt)}. Leave it alone.`,
      );
      return;
    }

    if (result.status === 'queued') {
      setVerdict('free', 'Saved on this phone', 'It will be sent as soon as you have signal.');
      toast('Saved offline.');
    } else {
      setVerdict('free', 'Tagged', `Recorded as yours. ${formatPlate(reading.plate)} is now on the list.`);
      toast('Tagged. Hang the sign.');
    }
    setTimeout(closeResult, 1300);
  } catch (error) {
    if (error.code === 'signed_out') handleSignedOut();
    else {
      toast(error.code === 'offline' ? 'No signal, and it could not be saved.' : 'Could not save that.');
      el.tag.disabled = false;
    }
  } finally {
    updateNetChip();
  }
}

async function untagCurrent() {
  const tag = state.lookup?.tag;
  if (!tag) return;
  try {
    await backend.untag(tag);
    toast('Tag removed.');
    await lookupPlate(tag.plate);
  } catch (error) {
    toast(error.code === 'not_allowed' ? 'That tag could not be removed.' : 'Needs a connection.');
  }
}

/* Feed and stats ---------------------------------------------------------- */

async function loadFeed(reset) {
  if (reset) {
    el.feedList.innerHTML = '';
    state.feedCursor = null;
  }
  try {
    const result = await backend.feed({
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
      who.style.whiteSpace = 'pre-line';
      who.textContent = `${tag.taggedBy}\n${timeAgo(tag.createdAt)}`;
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
    const result = await backend.stats();
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
  } catch {
    toast('Totals need a connection.');
  }
}

async function downloadExport(event) {
  event.preventDefault();
  try {
    const csv = await backend.exportCsv();
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `tagcheck-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    toast('Could not build the export. Try again with a connection.');
  }
}

/* Sign in ----------------------------------------------------------------- */

async function loadClub() {
  const club = await backend.club();
  el.clubName.textContent = club.name;
  el.topbarClub.textContent = club.name;
  document.title = club.name === 'TagCheck' ? 'TagCheck' : `${club.name} - TagCheck`;
}

const SIGNIN_MESSAGES = {
  bad_code: 'This invite link is not valid for this club. Ask for a fresh one.',
  club_not_set_up: 'This club has not been set up yet. Whoever created it still needs to add the club settings in Firebase.',
  no_code: 'This link is missing its club code. Ask whoever set it up to resend the invite link.',
  offline: 'Cannot reach the club records. Check your signal.',
  anonymous_auth_disabled: 'This club is not set up yet: anonymous sign-in is off in Firebase.',
};

async function handleSignIn(event) {
  event.preventDefault();
  el.signinError.hidden = true;

  const button = el.signinForm.querySelector('button[type="submit"]');
  button.disabled = true;

  // The link supplies the code; the typed field is only a fallback for when a
  // messaging app has eaten the fragment.
  const code = (localStorage.getItem('tagcheck.code') || el.code.value || '').trim();

  try {
    if (!code) throw Object.assign(new Error('no_code'), { code: 'no_code' });

    await backend.signIn({
      code,
      name: el.name.value.trim(),
      server: el.server.value.trim(),
    });
    localStorage.setItem('tagcheck.code', code);
    showApp();
    await loadClub();
    await backend.sync().catch(() => {});
    updateNetChip();
  } catch (error) {
    if (error.code === 'bad_code' || error.code === 'no_code') {
      // Let them type it rather than leaving them stuck on a broken link.
      el.codeFallback.hidden = false;
      el.codeFallback.open = true;
      if (error.code === 'bad_code') localStorage.removeItem('tagcheck.code');
    }
    el.signinError.textContent = SIGNIN_MESSAGES[error.code] || 'Could not join. Try again.';
    el.signinError.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  if (backend.mode === 'firebase'
    && !confirm('Sign out? Your past tags stay on record, but this phone rejoins as a new member.')) {
    return;
  }
  await backend.signOut();
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
  el.export.addEventListener('click', downloadExport);

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
    try {
      const result = await backend.sync();
      toast(`Up to date. ${result.changes} on record.`);
    } catch {
      toast('Could not sync right now.');
    }
    updateNetChip();
  });

  el.locationToggle.addEventListener('click', () => {
    localStorage.setItem('tagcheck.location', locationEnabled() ? 'off' : 'on');
    renderLocationToggle();
  });

  el.signout.addEventListener('click', signOut);

  window.addEventListener('online', async () => {
    await backend.sync().catch(() => {});
    updateNetChip();
  });
  window.addEventListener('offline', updateNetChip);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !el.app.hidden) {
      backend.sync().catch(() => {});
      if (!el.panels.scan.hidden) startCamera();
    } else {
      stopCamera();
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible' && !el.app.hidden) {
      backend.sync().catch(() => {});
    }
  }, SYNC_INTERVAL_MS);
}

function renderLocationToggle() {
  const on = locationEnabled();
  el.locationToggle.textContent = `Save location with tags: ${on ? 'on' : 'off'}`;
  el.locationToggle.setAttribute('aria-pressed', String(on));
}

async function boot() {
  backend = await getBackend();

  backend.onChange(() => {
    updateNetChip();
    // The tally sits on the scan screen, so it has to move as tags land --
    // including tags other members make while this phone is open.
    if (!el.app.hidden) refreshTally();
    if (!el.panels.feed.hidden) loadFeed(true);
    if (!el.panels.stats.hidden) loadStats();
  });

  backend.onLostRace((plate, taggedBy) => {
    toast(`${formatPlate(plate)} was already tagged by ${taggedBy}. Your tag was not saved.`);
  });

  wire();
  renderLocationToggle();

  // Take the club code out of the invite link before anything is rendered, so
  // a member only ever sees a name box.
  const code = takeCodeFromLink();
  if (!code) el.codeFallback.hidden = false;

  // The server address only means anything when there is a server.
  if (backend.mode === 'firebase' && el.serverFallback) el.serverFallback.hidden = true;

  if ('serviceWorker' in navigator) {
    // Check for a new worker on every launch, and reload once when one takes
    // over. Without this a phone keeps running whatever it installed first, and
    // a fix that is live on the server never reaches the person who needs it.
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => registration.update())
      .catch(() => {});

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  await loadClub().catch(() => {});

  if (await backend.resume().catch(() => false)) {
    showApp();
    await backend.sync().catch(() => {});
  } else {
    showSignIn();
  }
  updateNetChip();
}

boot();
