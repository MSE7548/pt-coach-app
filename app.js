import { Recorder, extensionFor } from './recorder.js';
import { putChunk, listChunks, dropChunks, setActive, getActive, clearActive, bumpRound, getRounds,
         getLocalMembers, addLocalMember, removeLocalMember } from './store.js';

const $ = id => document.getElementById(id);
const views = ['recovery', 'members', 'confirm', 'recording', 'done'];

// iOS PWA는 화면을 끄면 녹음을 이어가지 못한다. 2026-08-11 실기기 실측에서
// 62분 녹음이 652바이트(헤더만)로 끝났고, 화면을 켜둔 2차도 백그라운드 전환만으로
// 끊겼다. v1은 녹음을 빼고 회원 선택·파일명만 맡는다.
// 녹음 코드는 지우지 않는다 — 네이티브 래퍼에서 그대로 재사용한다.
// 상세: docs/superpowers/specs/2026-08-10-pwa-recording-requirements.md
const RECORDING_ENABLED = false;

let members = [];
let rounds = {};
let picked = null;     // 고른 회원
let counted = false;   // 이 선택에서 회차를 이미 올렸는가
let session = null;    // 진행 중인 세션 메타
let rec = null;        // Recorder

// ─── 파일명 ────────────────────────────────────────────────────────────
// Stage 1은 파일명에서 `^(.+?)님`으로 회원을 뽑는다. 이름 앞에 아무것도 붙이지 않는다.
// 오늘 실패한 `제험 홍길동님 6,23.m4a`가 정확히 이 규칙을 어긴 경우다.
export function buildFilename(name, date, ext = 'm4a') {
  const d = date instanceof Date ? date : new Date(date);
  return `${name}님 ${d.getMonth() + 1},${d.getDate()}.${ext}`;
}

// ─── 화면 ──────────────────────────────────────────────────────────────
function show(name) {
  views.forEach(v => { $(v).hidden = v !== name; });
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60]
    .map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
}

// ─── 회원 목록 ─────────────────────────────────────────────────────────
// 실명은 저장소에 커밋하지 않는다. members.json은 gitignore 대상이고,
// 없으면 members.sample.json으로 떨어진다. 나중에 Notion 회원 코어 DB와 동기화한다.
async function loadMembers() {
  let fromFile = [];
  for (const url of ['members.json', 'members.sample.json']) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) continue;
      const json = await res.json();
      if (Array.isArray(json) && json.length) { fromFile = json; break; }
    } catch { /* 다음 후보로 */ }
  }
  // 폰에서 직접 넣은 회원이 앞에 온다. 그분들이 오늘 수업할 분들이다.
  const local = await getLocalMembers();
  const seen = new Set(local.map(m => m.name));
  return [...local, ...fromFile.filter(m => !seen.has(m.name))];
}

function renderMembers(filter = '') {
  const q = filter.trim();
  const list = q ? members.filter(m => m.name.includes(q)) : members;
  const ul = $('member-list');
  ul.textContent = '';

  for (const m of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const name = document.createElement('span');
    name.textContent = m.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const n = rounds[m.id] || 0;
    meta.textContent = n ? `${n}회 기록됨` : '기록 없음';
    btn.append(name, meta);
    btn.onclick = () => pick(m);
    li.append(btn);

    // 직접 넣은 회원만 지울 수 있다. 파일에서 온 목록은 여기서 건드리지 않는다.
    if (m.local) {
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.textContent = '×';
      del.title = `${m.name} 지우기`;
      del.onclick = async e => {
        e.stopPropagation();
        if (!confirm(`${m.name}님을 목록에서 지울까요?`)) return;
        await removeLocalMember(m.id);
        members = await loadMembers();
        renderMembers($('search').value);
      };
      li.append(del);
    }
    ul.append(li);
  }
  $('member-empty').hidden = list.length > 0;
  if (!members.length) {
    $('member-empty').textContent = '아직 회원이 없어요. 아래에 이름을 적고 추가하세요.';
  }
}

// ─── 세션 확인 ─────────────────────────────────────────────────────────
// 회원·시간·회차는 미리 채우고 틀린 것만 고친다. 자동으로 채운 값은 노란 배지를 단다.
function pick(member) {
  picked = member;
  counted = false;
  const now = new Date();

  $('confirm-name').textContent = `${member.name}님`;
  $('f-date').value = toDateInput(now);
  $('f-time').value = toTimeInput(now);
  $('f-round').value = (rounds[member.id] || 0) + 1;
  $('f-round-src').className = 'draft';
  $('f-round-src').textContent = '자동';

  refreshFilename();
  show('confirm');
}

function toDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toTimeInput(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function chosenDate() {
  const [y, m, d] = ($('f-date').value || toDateInput(new Date())).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function refreshFilename() {
  if (!picked) return;
  $('f-filename').textContent = buildFilename(picked.name, chosenDate());
}

// v1의 핵심 동작. 음성 메모로 녹음한 뒤 이 이름으로 저장하면
// Stage 1의 `^(.+?)님` 회원 추출이 반드시 성공한다.
async function copyFilename() {
  const name = $('f-filename').textContent;
  try {
    await navigator.clipboard.writeText(name);
    toast('파일명을 복사했습니다');
  } catch {
    // 클립보드 권한이 없으면 직접 고를 수 있게 선택 상태로 둔다.
    const range = document.createRange();
    range.selectNodeContents($('f-filename'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('길게 눌러 복사하세요');
  }
  // 복사를 여러 번 눌러도 회차는 한 번만 올린다. 두 번 세면 다음 회차가 어긋난다.
  if (picked && !counted) {
    counted = true;
    rounds[picked.id] = await bumpRound(picked.id);
    renderMembers($('search').value);
  }
}

// ─── 녹음 ──────────────────────────────────────────────────────────────
async function startRecording() {
  const id = `${Date.now()}-${picked.id}`;
  session = {
    id,
    memberId: picked.id,
    memberName: picked.name,
    date: $('f-date').value,
    time: $('f-time').value,
    round: Number($('f-round').value) || 1,
    roundEdited: Number($('f-round').value) !== (rounds[picked.id] || 0) + 1,
    startedAt: Date.now(),
    chunks: 0
  };

  rec = new Recorder({
    chunk: async (blob, index, bytes) => {
      await putChunk(session.id, index, blob);
      session.chunks = index + 1;
      await setActive(session);
      $('rec-chunks').textContent = session.chunks;
      $('rec-size').textContent = (bytes / 1048576).toFixed(1);
    },
    tick: ms => { $('timer').textContent = fmtClock(ms); },
    silence: () => setRecState('5분째 조용합니다. 수업이 끝났나요?', 'warn'),
    overrun: min => {
      setRecState(min === 55 ? '55분 지났습니다' : '70분 지났습니다. 종료를 잊으셨나요?', 'warn');
      notify(min === 55 ? '수업 끝나셨나요?' : '녹음이 70분째입니다');
    },
    autoStop: reason => { toast(`${reason}으로 자동 종료했습니다`); finish({ auto: reason }); },
    lost: msg => setRecState(msg, 'bad'),
    error: err => setRecState(`오류: ${err?.name || err}`, 'bad')
  });

  try {
    await rec.start();
  } catch (err) {
    rec = null;
    session = null;
    toast(err.name === 'NotAllowedError' ? '마이크 권한이 필요합니다' : `녹음 시작 실패: ${err.name}`);
    return;
  }

  await setActive(session);
  $('rec-name').textContent = `${picked.name}님 · ${session.round}회차`;
  $('rec-chunks').textContent = '0';
  $('rec-size').textContent = '0';
  $('timer').textContent = '00:00:00';
  setRecState('녹음 중');
  show('recording');
}

function setRecState(text, cls = '') {
  $('rec-state').textContent = text;
  $('rec-state').className = 'state ' + cls;
}

// 안전망 1: 다음 회원을 고르면 이전 녹음을 반드시 먼저 끝낸다.
async function finish({ auto = null, thenPick = false } = {}) {
  if (!rec || !session) return;
  const result = await rec.stop();
  const ext = extensionFor(result?.mimeType);
  const stored = await listChunks(session.id);

  const partial = Boolean(auto) && auto === '90분 상한';
  const filename = buildFilename(session.memberName, chosenDate(), ext);

  if (stored.length) {
    // 조각은 기기 안에서만 쓰고, 업로드는 한 파일로 합친다.
    const blob = new Blob(stored.map(c => c.blob), { type: result?.mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = $('download');
    a.href = url;
    a.download = partial ? `(부분) ${filename}` : filename;
    a.hidden = false;

    rounds[session.memberId] = await bumpRound(session.memberId);
    $('done-summary').textContent =
      `${session.memberName}님 · ${fmtClock(result?.ms || 0)} · 조각 ${stored.length}개 · ${filename}` +
      (partial ? '\n90분 상한으로 끊겨 다른 회원 발화가 섞였을 수 있습니다. 확인이 필요합니다.' : '');
  } else {
    $('download').hidden = true;
    $('done-summary').textContent = '저장된 조각이 없습니다.';
  }

  await dropChunks(session.id);
  await clearActive();
  rec = null;
  session = null;

  if (thenPick) { renderMembers($('search').value); show('members'); }
  else show('done');
}

function notify(body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('PT Coach OS', { body });
  }
}

// ─── 복구 ──────────────────────────────────────────────────────────────
// 탭이 죽거나 배터리가 나가도 저장된 조각은 남는다.
async function checkRecovery() {
  const active = await getActive();
  if (!active) return false;

  const stored = await listChunks(active.id);
  if (!stored.length) { await clearActive(); return false; }

  const minutes = Math.round(stored.length * 5);
  $('recovery-summary').textContent =
    `${active.memberName}님 · 약 ${minutes}분 저장됨 · 조각 ${stored.length}개`;

  document.querySelectorAll('[data-recover]').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.recover;
      if (action === 'discard') {
        await dropChunks(active.id);
        await clearActive();
        show('members');
        return;
      }
      const blob = new Blob(stored.map(c => c.blob), { type: 'audio/webm' });
      const a = $('download');
      a.href = URL.createObjectURL(blob);
      a.download = `(복구) ${buildFilename(active.memberName, new Date(active.startedAt), 'webm')}`;
      a.hidden = false;
      $('done-summary').textContent = `복구했습니다 · 조각 ${stored.length}개`;
      await dropChunks(active.id);
      await clearActive();
      if (action === 'resume') toast('이어 녹음은 v2입니다. 지금은 저장만 됩니다.');
      show('done');
    };
  });

  show('recovery');
  return true;
}


// ─── 설치 안내 ─────────────────────────────────────────────────────────
// 기종마다 방법이 다르고, 그 차이를 선생님이 동료에게 설명하는 것도 부탁이다.
// 앱이 접속한 기기를 보고 맞는 안내만 띄운다.
//
// 아이폰은 두 가지가 다르다. 하나는 공유 버튼으로 추가한다는 것이고, 다른
// 하나는 **홈 화면 추가가 선택이 아니라는 것**이다 — 사파리는 한동안 안 쓴
// 사이트의 저장 데이터를 지우므로, 추가하지 않으면 넣어둔 회원이 사라질 수 있다.
function detectPlatform() {
  const ua = navigator.userAgent;
  // 아이패드가 데스크톱으로 위장하는 경우까지 잡는다
  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!iOS) return /Android/.test(ua) ? 'android' : 'other';
  // iOS에서 크롬·파이어폭스는 홈 화면 추가가 들쭉날쭉하다. 사파리로 안내한다
  return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other-browser' : 'ios-safari';
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

const INSTALL_GUIDE = {
  'ios-safari': {
    title: '홈 화면에 추가해 주세요',
    steps: '아래 <kbd>공유 □↑</kbd> 를 누르고 <kbd>홈 화면에 추가</kbd> 를 고르세요.',
    why: '아이폰은 한동안 안 쓴 사이트의 저장 내용을 지웁니다. 홈 화면에 추가해 두셔야 넣어두신 회원이 남습니다.',
  },
  'ios-other-browser': {
    title: '사파리로 열어주세요',
    steps: '이 주소를 <kbd>Safari</kbd> 에서 연 뒤, 아래 <kbd>공유 □↑</kbd> → <kbd>홈 화면에 추가</kbd>.',
    why: '아이폰에서는 사파리로 추가해야 안정적으로 앱처럼 열립니다.',
  },
  android: {
    title: '홈 화면에 추가해 주세요',
    steps: '주소창 오른쪽 <kbd>⋮</kbd> 를 누르고 <kbd>홈 화면에 추가</kbd> 를 고르세요.',
    why: '홈 화면에서 열면 주소창 없이 앱처럼 넓게 씁니다.',
  },
  other: {
    title: '휴대폰에서 열어주세요',
    steps: '수업 중에 쓰는 도구라 휴대폰에서 여는 것을 권합니다.',
    why: '',
  },
};

function showInstallGuide() {
  if (isInstalled()) return;
  try { if (localStorage.getItem('installGuideDone')) return; } catch { /* 무시 */ }
  const g = INSTALL_GUIDE[detectPlatform()];
  if (!g) return;
  $('install-title').textContent = g.title;
  $('install-steps').innerHTML = g.steps;
  $('install-why').textContent = g.why;
  $('install-why').hidden = !g.why;
  $('install').hidden = false;
  $('install-close').onclick = () => {
    $('install').hidden = true;
    try { localStorage.setItem('installGuideDone', '1'); } catch { /* 무시 */ }
  };
}

// ─── 시작 ──────────────────────────────────────────────────────────────
async function main() {
  [members, rounds] = await Promise.all([loadMembers(), getRounds()]);
  renderMembers();

  $('search').oninput = e => renderMembers(e.target.value);

  $('add-member').onsubmit = async e => {
    e.preventDefault();
    const input = $('new-member');
    const added = await addLocalMember(input.value);
    if (!added) return;
    input.value = '';
    members = await loadMembers();
    rounds = await getRounds();
    $('search').value = '';
    renderMembers();
    $('add-hint').textContent = `${added.name}님을 넣었어요. 이름을 누르면 수업을 시작해요.`;
  };
  $('f-date').onchange = () => refreshFilename();
  $('f-round').oninput = () => { $('f-round-src').className = 'draft confirmed'; };
  $('back').onclick = () => { picked = null; show('members'); };
  $('start').onclick = () => startRecording();
  $('copy').onclick = () => copyFilename();

  // 녹음이 켜지면(네이티브 래퍼) 파일명 복사 대신 녹음 시작이 기본 동작이 된다.
  $('start').hidden = !RECORDING_ENABLED;
  $('copy').hidden = RECORDING_ENABLED;
  $('record-hint').hidden = RECORDING_ENABLED;
  $('finish').onclick = () => finish();
  $('next-member').onclick = () => finish({ thenPick: true });
  $('again').onclick = () => { renderMembers($('search').value); show('members'); };

  if (!await checkRecovery()) show('members');

  showInstallGuide();

  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// 종료를 누르지 않고 앱을 닫는 경우를 대비해 마지막 상태를 남긴다.
window.addEventListener('pagehide', () => { if (session) setActive(session); });

main();
