const $ = (id) => document.getElementById(id);
const app = $('app');
const dialog = $('appDialog');
const STORE_KEY = 'gate-ce-practice-v1';
const DEFAULT_USER = { bookmarks: [], mistakes: [], history: [], activeExam: null, answerOverrides: {}, todos: [], questionNotes: {}, theme: 'light' };
let user = loadUser();
let authUser = null; // { user, profile } when logged in via Supabase
let questions = [];
let questionById = new Map();
let subjects = [];
let topicsBySubject = new Map();
let questionManifest = null;
let madeEasyCatalog = [];
const madeEasyTests = new Map();
let madeEasyManifestPromise = null;
const loadedQuestionFiles = new Set();
const questionFileLoads = new Map();
let view = 'home';
let selectedSubject = null;
let selectedTopic = null;
let activeResult = null;
let pendingExam = null;
let reviewFilter = 'all';
let collectionSearch = '';
let calendarMonth = new Date(new Date().getFullYear(),new Date().getMonth(),1);
let calendarSelectedDate = '';
let timerHandle = null;
let toastHandle = null;
const BACKUP_META_KEY = 'gate-ce-practice-backup-meta';
const PRE_RESTORE_KEY = 'gate-ce-practice-pre-restore';
const BACKUP_KEEP_DAYS = 14;
let backupFolder = { handle: null, name: '', state: 'none', error: '' }; // state: none | granted | prompt | error
let autoBackupTimer = null;
let autoBackupBusy = false;
let pendingRestore = null;
let customBuilder = { subjects: [], topics: [], types: ['MCQ','MSQ','NAT'], source: 'all', count: 30, durationMinutes: 60, title: '' };

function loadUser() {
  try { return { ...DEFAULT_USER, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return structuredClone(DEFAULT_USER); }
}
function saveUser() {
  localStorage.setItem(STORE_KEY, JSON.stringify(user));
  scheduleAutoBackup();
  scheduleCloudSync();
}
let _cloudSyncTimer = null;
function scheduleCloudSync(delay = 3000) {
  if (!window.SupaAuth?.user()) return;
  clearTimeout(_cloudSyncTimer);
  _cloudSyncTimer = setTimeout(async () => {
    try {
      await SupaAuth.syncBookmarks(user.bookmarks || []);
      await SupaAuth.syncMistakes(user.mistakes || []);
      await SupaAuth.saveCloudState(user);
    } catch (e) { console.warn('[CloudSync] sync error', e); }
  }, delay);
}
function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function num(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function nice(value='') { return String(value ?? '').replaceAll('_',' ').replace(/\s+/g,' ').trim(); }
function fmtTime(seconds) { seconds=Math.max(0,Math.floor(seconds)); return [Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(v=>String(v).padStart(2,'0')).join(':'); }
function fmtDuration(seconds) { const total=Math.max(0,Math.round(num(seconds)));if(total<60)return `${total} sec`;const hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),secs=total%60;return hours?`${hours}h ${minutes}m`:`${minutes} min${secs?` ${secs} sec`:''}`; }
function dateLabel(ts) { return new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function examCountdownParts() {
  const target=new Date(2027,1,1,0,0,0,0),remaining=Math.max(0,target.getTime()-Date.now()),seconds=Math.floor(remaining/1000);
  return {days:Math.floor(seconds/86400),hours:Math.floor(seconds%86400/3600),minutes:Math.floor(seconds%3600/60),seconds:seconds%60};
}
function updateExamCountdown() {
  const parts=examCountdownParts();for(const key of ['days','hours','minutes','seconds']){const node=$(`countdown-${key}`);if(node)node.textContent=String(parts[key]).padStart(key==='days'?1:2,'0');}
}
// ---------- Local backup: download, restore, and automatic folder backup ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function whenLabel(ts) { const d = new Date(ts); return ts && !Number.isNaN(d.getTime()) ? d.toLocaleString() : ''; }
function backupStamp(d = new Date()) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function backupPayload() { return { app: 'gate-ce-practice', version: 1, exportedAt: new Date().toISOString(), data: user }; }
function dataCounts(u) { return `${plural((u.history || []).length, 'attempt')} · ${plural((u.bookmarks || []).length, 'bookmark')} · ${plural((u.mistakes || []).length, 'mistake')}`; }
function isEmptyUser(u = user) { return !u.history.length && !u.bookmarks.length && !u.mistakes.length && !u.todos.length && !Object.keys(u.questionNotes || {}).length && !Object.keys(u.answerOverrides || {}).length; }
function readBackupMeta() { try { return JSON.parse(localStorage.getItem(BACKUP_META_KEY) || '{}') || {}; } catch { return {}; } }
function writeBackupMeta(patch) { try { localStorage.setItem(BACKUP_META_KEY, JSON.stringify({ ...readBackupMeta(), ...patch })); } catch {} }
function readPreRestore() { try { const snap = JSON.parse(localStorage.getItem(PRE_RESTORE_KEY) || 'null'); return snap && snap.data ? snap : null; } catch { return null; } }
function getRestoreInput() {
  let input = $('restoreInput');
  if (!input) { input = document.createElement('input'); input.type = 'file'; input.id = 'restoreInput'; input.accept = 'application/json,.json'; input.hidden = true; document.body.append(input); }
  return input;
}
function backupAttention() { return backupFolder.state === 'prompt' || backupFolder.state === 'error' ? '<span title="Backup folder needs attention" style="width:8px;height:8px;border-radius:50%;background:#e5484d;display:inline-block;margin-left:4px"></span>' : ''; }

// Folder handles can't go in localStorage, so the chosen folder lives in IndexedDB.
function backupDb() { return new Promise((resolve, reject) => { const req = indexedDB.open('gate-ce-practice-backup', 1); req.onupgradeneeded = () => req.result.createObjectStore('handles'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
async function idbGet(key) { const db = await backupDb(); return new Promise((resolve, reject) => { const r = db.transaction('handles').objectStore('handles').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
async function idbSet(key, value) { const db = await backupDb(); return new Promise((resolve, reject) => { const tx = db.transaction('handles', 'readwrite'); if (value === undefined) tx.objectStore('handles').delete(key); else tx.objectStore('handles').put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
function folderBackupSupported() { return window.isSecureContext && typeof window.showDirectoryPicker === 'function'; }
async function initBackupFolder() {
  if (!folderBackupSupported()) return;
  try {
    const handle = await idbGet('folder'); if (!handle) return;
    backupFolder.handle = handle; backupFolder.name = handle.name;
    backupFolder.state = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'granted' : 'prompt';
  } catch {}
}
async function ensureFolderAccess(interactive) {
  const handle = backupFolder.handle; if (!handle) throw new Error('No backup folder selected.');
  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { backupFolder.state = 'prompt'; throw new Error('Permission needed for the backup folder. Press “Re-authorize folder”.'); }
  backupFolder.state = 'granted'; return handle;
}
async function pruneFolderBackups(handle) {
  try {
    const names = [];
    for await (const [name, entry] of handle.entries()) if (entry.kind === 'file' && /^gate-ce-practice-\d{4}-\d{2}-\d{2}\.json$/.test(name)) names.push(name);
    names.sort().reverse();
    for (const name of names.slice(BACKUP_KEEP_DAYS)) await handle.removeEntry(name);
  } catch {}
}
async function runFolderBackup({ interactive = false } = {}) {
  const handle = await ensureFolderAccess(interactive);
  if (isEmptyUser()) throw new Error('Nothing to back up yet. Your data is empty, so existing backup files were left untouched.');
  const text = JSON.stringify(backupPayload(), null, 2);
  const put = async name => { const file = await handle.getFileHandle(name, { create: true }); const writable = await file.createWritable(); await writable.write(text); await writable.close(); };
  await put('gate-ce-practice-latest.json');
  await put(`gate-ce-practice-${backupStamp()}.json`);
  await pruneFolderBackups(handle);
  backupFolder.error = ''; writeBackupMeta({ lastFolderAt: Date.now() });
}
function scheduleAutoBackup(delay = 4000) {
  if (!backupFolder.handle || backupFolder.state !== 'granted') return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(async () => {
    if (autoBackupBusy) { scheduleAutoBackup(); return; }
    autoBackupBusy = true;
    try { await runFolderBackup(); }
    catch (error) {
      backupFolder.error = error.message || 'Folder backup failed.';
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') backupFolder.state = 'prompt';
      else if (error.name === 'NotFoundError') backupFolder.state = 'error';
    } finally { autoBackupBusy = false; }
  }, delay);
}

// Restore
function normalizeBackup(raw) {
  const incoming = raw && typeof raw === 'object' ? (raw.data && typeof raw.data === 'object' ? raw.data : raw) : null;
  if (!incoming || Array.isArray(incoming)) throw new Error('This file is not a practice backup.');
  if (!['bookmarks', 'mistakes', 'history', 'todos', 'answerOverrides', 'theme'].some(key => key in incoming)) throw new Error('This file does not look like a GATE CE practice backup.');
  const list = v => Array.isArray(v) ? v : [];
  const map = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const next = {
    ...DEFAULT_USER, ...incoming,
    bookmarks: list(incoming.bookmarks), mistakes: list(incoming.mistakes), history: list(incoming.history), todos: list(incoming.todos),
    answerOverrides: map(incoming.answerOverrides), questionNotes: map(incoming.questionNotes),
    theme: incoming.theme === 'dark' ? 'dark' : 'light',
    activeExam: incoming.activeExam && typeof incoming.activeExam === 'object' ? incoming.activeExam : null
  };
  if (next.activeExam && next.activeExam.source === 'made-easy' && typeof next.activeExam.testId === 'string') {
    // Made Easy question IDs are loaded on demand from the local test bundle.
  } else if (next.activeExam && !(Array.isArray(next.activeExam.qids) && next.activeExam.qids.every(id => questionById.has(id)))) next.activeExam = null;
  return next;
}
function stageRestore(text, name) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('That file is not valid JSON, so it can’t be a backup.'); }
  pendingRestore = { next: normalizeBackup(parsed), name, exportedAt: (parsed && parsed.exportedAt) || '' };
  showRestoreConfirm();
}
function showRestoreConfirm() {
  const p = pendingRestore, when = whenLabel(p.exportedAt);
  dialogShow('Restore this backup?',
    `<p>Restore <strong>${esc(p.name)}</strong>${when ? ` (exported ${esc(when)})` : ''}?</p><p>The file contains ${esc(dataCounts(p.next))}.</p><p>This browser currently has ${esc(dataCounts(user))}. Restoring <strong>replaces</strong> all of it. A safety copy of the current data is kept so you can undo from the Backup window.</p>`,
    '<button class="outline-button" data-dialog="close">Cancel</button><button class="primary-button" data-dialog="confirm-restore">Restore backup</button>');
}
function applyRestoredUser(message) {
  saveUser(); document.body.classList.toggle('dark', user.theme === 'dark'); dialogClose();
  clearInterval(timerHandle); timerHandle = null; view = 'home'; history.replaceState({}, '', '#home'); render(); toast(message);
}
function confirmRestore() {
  if (!pendingRestore) return;
  let safetyCopy = true;
  try { localStorage.setItem(PRE_RESTORE_KEY, JSON.stringify({ savedAt: Date.now(), data: user })); } catch { safetyCopy = false; }
  user = pendingRestore.next; pendingRestore = null;
  applyRestoredUser(safetyCopy ? 'Backup restored' : 'Backup restored (no undo copy: browser storage is full)');
}
function undoRestore() {
  const snap = readPreRestore(); if (!snap) { toast('No earlier data to bring back.'); return; }
  user = { ...DEFAULT_USER, ...snap.data }; try { localStorage.removeItem(PRE_RESTORE_KEY); } catch {}
  applyRestoredUser('Earlier data brought back');
}

// Dialog
function folderSectionMarkup() {
  const f = backupFolder, meta = readBackupMeta(), row = 'style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"';
  const last = meta.lastFolderAt ? `<p><small>Last saved ${esc(whenLabel(meta.lastFolderAt))}</small></p>` : '';
  const err = f.error ? `<p><small>${esc(f.error)}</small></p>` : '';
  if (!folderBackupSupported()) return '<p>Automatic folder backup is unavailable here. Use Download backup.</p>';
  if (f.state === 'granted') return `<p>Automatic local copies are saved in <strong>${esc(f.name)}</strong>. Keeps the latest file and ${BACKUP_KEEP_DAYS} daily copies.</p>${last}${err}<div ${row}><button class="primary-button" data-action="backup-folder-now">Back up now</button><button class="outline-button" data-action="backup-folder-restore">Restore latest</button><button class="outline-button" data-action="backup-folder-pick">Change folder</button><button class="outline-button" data-action="backup-folder-disconnect">Turn off</button></div>`;
  if (f.state === 'prompt') return `<p>Allow access again to continue saving in <strong>${esc(f.name)}</strong>.</p>${err}<div ${row}><button class="primary-button" data-action="backup-folder-now">Allow and back up</button><button class="outline-button" data-action="backup-folder-pick">Change folder</button><button class="outline-button" data-action="backup-folder-disconnect">Turn off</button></div>`;
  if (f.state === 'error') return `<p>Could not access <strong>${esc(f.name)}</strong>.</p><div ${row}><button class="primary-button" data-action="backup-folder-pick">Choose another folder</button><button class="outline-button" data-action="backup-folder-disconnect">Turn off</button></div>`;
  return `<p>Save automatic copies to a folder on this device.</p>${err}<div ${row}><button class="primary-button" data-action="backup-folder-pick">Choose backup folder</button></div>`;
}
function renderBackupDialog(message = '') {
  const meta = readBackupMeta(), snap = readPreRestore();
  const note = message ? `<div class="backup-setup-note"><strong>${esc(message)}</strong></div>` : '';
  const lastDownload = meta.lastDownloadAt ? `<p><small>Last downloaded ${esc(whenLabel(meta.lastDownloadAt))}</small></p>` : '';
  const undo = snap ? `<p><small>A safety copy from before your last restore (${esc(whenLabel(snap.savedAt))}) is available.</small></p><button class="outline-button" data-action="restore-undo">Undo last restore</button>` : '';
  const markup = `${note}<p class="backup-local-note">This option creates a local backup on your device. For a permanent cloud backup across devices, sign in with Google.</p><div class="backup-options">
    <section class="backup-option"><span class="backup-option-icon">↓</span><div><h3>Download to this device</h3><p>Save your practice data as one JSON file (${esc(dataCounts(user))}).</p>${lastDownload}<button class="primary-button" data-action="backup-download">Download backup</button></div></section>
    <section class="backup-option"><span class="backup-option-icon">↑</span><div><h3>Restore from a file</h3><p>Load a backup you saved earlier. You’ll see a summary and confirm before anything is replaced.</p><button class="outline-button" data-action="restore">Choose backup file</button>${undo}</div></section>
    <section class="backup-option"><span class="backup-option-icon">⟳</span><div><h3>Automatic backup to a folder</h3>${folderSectionMarkup()}</div></section>
  </div>`;
  dialogShow('Back up your practice', markup, '<button class="outline-button" data-dialog="close">Close</button>');
}
function showBackupDialog() { renderBackupDialog(); }
function toast(message) { let el=$('toast'); if(!el){el=document.createElement('div');el.id='toast';el.className='toast';document.body.append(el);} el.textContent=message; clearTimeout(toastHandle); toastHandle=setTimeout(()=>el.remove(),2400); }
function dialogShow(title, body, footer='') { dialog.classList.toggle('calculator-modal',body.includes('class="gate-calc"'));dialog.innerHTML=`<div class="modal-head"><h2>${title}</h2><button class="modal-close" data-dialog="close" aria-label="Close">×</button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}`; if(!dialog.open)dialog.showModal(); }
function showQuestionReport(id) {
  const q = questionById.get(id); if (!q) return;
  if (!authUser) { toast('Sign in with Google to report an issue.'); return; }
  dialogShow('Report this question', `<p>Tell us what needs attention for <strong>${esc(q.year)} ${esc(q.session || '')} · Q${esc(q.questionNo)}</strong>.</p><label class="form-label" for="reportReason">Issue type</label><select id="reportReason" class="form-control"><option>Wrong question</option><option>Wrong answer key</option><option>Missing data</option><option>Question formatting or image issue</option><option>Other</option></select><label class="form-label" for="reportDetails">Details (optional)</label><textarea id="reportDetails" class="form-control" rows="4" maxlength="1000" placeholder="What should be corrected?"></textarea>`, '<button class="outline-button" data-dialog="close">Cancel</button><button class="primary-button" data-action="send-question-report" data-id="'+esc(id)+'">Send report</button>');
}
function showCalculator() { dialog.classList.add('calculator-modal');dialog.classList.remove('calculator-minimized');dialog.innerHTML=window.buildScientificCalculator();dialog.showModal(); }
function dialogClose(){if(dialog.open)dialog.close();}
async function navigate(next, options={}) { view=next; if(options.subject!==undefined)selectedSubject=options.subject; if(options.topic!==undefined)selectedTopic=options.topic; if(options.result!==undefined)activeResult=options.result; collectionSearch=''; history.pushState({},'',`#${next}`); await ensureViewQuestions(next); render(); window.scrollTo(0,0); }
function countLabel(n, noun='question') { return `${n.toLocaleString()} ${noun}${n===1?'':'s'}`; }
function allQuestionData() { return questions; }
function topicLabel(topic='') { return nice(topic||'Uncategorized')||'Uncategorized'; }
function topicKey(topic='') { return topicLabel(topic).toLocaleLowerCase(); }
function buildTopicsBySubject(list=questions) {
  const grouped=new Map();
  for(const q of list){
    const subject=q.subject,key=topicKey(q.topic),label=topicLabel(q.topic);
    if(!grouped.has(subject))grouped.set(subject,new Map());
    const byKey=grouped.get(subject);
    if(!byKey.has(key))byKey.set(key,new Map());
    const labels=byKey.get(key);
    labels.set(label,(labels.get(label)||0)+1);
  }
  const out=new Map();
  for(const [subject,byKey] of grouped){
    const canon=new Map();
    for(const [key,labels] of byKey){
      const picked=[...labels.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||'Uncategorized';
      canon.set(key,picked);
    }
    out.set(subject,canon);
  }
  return out;
}
function canonicalTopic(subject, topic='') { return topicsBySubject.get(subject)?.get(topicKey(topic))||topicLabel(topic); }
function topicsFor(subject) { return [...(topicsBySubject.get(subject)?.values()||[])].sort((a,b)=>a.localeCompare(b)); }
function qsForTopic(subject, topic) { const key=topicKey(topic); return questions.filter(q=>q.subject===subject&&topicKey(q.topic)===key).sort(compareQuestions); }
function totalTopicCount() { return questionManifest?.subjects.reduce((sum,entry)=>sum+entry.topics.length,0) ?? [...topicsBySubject.values()].reduce((sum,map)=>sum+map.size,0); }
function compareQuestions(a,b) { return num(b.year)-num(a.year) || String(a.session||'').localeCompare(String(b.session||'')) || num(a.questionNo)-num(b.questionNo); }
function pendingKeyCount() { return questionManifest?.pendingCount ?? questions.filter(q=>q.answerStatus==='pending').length; }
function subjectCounts() { return new Map((questionManifest?.subjects||[]).map(entry=>[entry.subject,entry.count])); }
function questionCount() { return questionManifest?.questionCount ?? questions.length; }
function manifestEntry(subject) { return questionManifest?.subjects.find(entry=>entry.subject===subject); }
async function loadQuestionEntry(entry) {
  if(!entry||loadedQuestionFiles.has(entry.file))return;
  if(questionFileLoads.has(entry.file))return questionFileLoads.get(entry.file);
  const task=(async()=>{
    let response;
    let loaded=[];
    if('DecompressionStream' in window){
      try{response=await fetch(`data/questions/${entry.file}.gz`);}catch{response=null;}
      if(response?.ok){
        try{
          const compressed=await response.arrayBuffer();
          const text=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
          loaded=JSON.parse(text);
        }catch(error){console.warn(`Could not read compressed question data for ${entry.subject}; trying the JSON source.`,error);response=null;}
      }
    }
    if(!loadedQuestionFiles.has(entry.file)&&(!response||!response.ok||!('DecompressionStream' in window))){
      response=await fetch(`data/questions/${entry.file}`);
      if(!response.ok)throw new Error(`Question data unavailable for ${entry.subject} (${response.status})`);
      loaded=await response.json();
    }
    loadedQuestionFiles.add(entry.file);
    questions.push(...loaded);
    for(const q of loaded)questionById.set(q.id,q);
    topicsBySubject.set(entry.subject,new Map(entry.topics.map(topic=>[topicKey(topic.name),topic.name])));
  })().finally(()=>questionFileLoads.delete(entry.file));
  questionFileLoads.set(entry.file,task);
  return task;
}
async function loadMadeEasyCatalog() {
  if (!madeEasyManifestPromise) madeEasyManifestPromise = fetch('data/made-easy/manifest.json').then(response => {
    if (!response.ok) throw new Error(`Made Easy test catalog unavailable (${response.status})`);
    return response.json();
  }).then(manifest => { madeEasyCatalog = Array.isArray(manifest.tests) ? manifest.tests : []; return madeEasyCatalog; });
  return madeEasyManifestPromise;
}
async function loadMadeEasyTest(testId) {
  if (madeEasyTests.has(testId)) return madeEasyTests.get(testId);
  const catalog = await loadMadeEasyCatalog(), entry = catalog.find(test => test.id === testId);
  if (!entry) throw new Error('This Made Easy test is not available.');
  const response = await fetch(`data/made-easy/${entry.file}`);
  if (!response.ok) throw new Error(`Made Easy test unavailable (${response.status})`);
  const test = await response.json();
  madeEasyTests.set(testId, test);
  for (const q of test.questions || []) questionById.set(q.id, q);
  return test;
}
async function ensureQuestionsForSubjects(names) {
  const wanted=names?.length?questionManifest.subjects.filter(entry=>names.includes(entry.subject)):questionManifest.subjects;
  await Promise.all(wanted.map(loadQuestionEntry));
}
async function ensureViewQuestions(target=view) {
  if(!questionManifest)return;
  if(target==='subject'||target==='topic')return ensureQuestionsForSubjects([selectedSubject||subjects[0]]);
  if(target==='exam'&&user.activeExam?.source==='made-easy')return loadMadeEasyTest(user.activeExam.testId);
  if(target==='results'){
    const attempt=user.history.find(item=>item.id===activeResult)||user.history[0];
    if(attempt?.source==='made-easy'&&attempt.testId)await loadMadeEasyTest(attempt.testId);
  }
  if(target==='bookmarks'||target==='mistakes'){
    const ids=new Set(user[target]||[]);
    const relevant=madeEasyCatalog.filter(test=>[...ids].some(id=>id.startsWith(`${test.id}-q`)));
    await Promise.all(relevant.map(test=>loadMadeEasyTest(test.id)));
  }
  if(target==='exam'&&user.activeExam?.subject)return ensureQuestionsForSubjects([user.activeExam.subject]);
  if(['exam','results','year','custom','analytics','bookmarks','mistakes'].includes(target))return ensureQuestionsForSubjects();
}
function iconSvg(name) {
  const paths={
    logout:'<path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
    math:'<path d="M5 6h14M5 12h14M5 18h14M8 4v16M16 4v16"/>',
    aptitude:'<path d="m12 3 2.6 5.3L20 9l-4 4 .9 5.8L12 16l-4.9 2.8L8 13 4 9l5.4-.7L12 3Z"/>',
    water:'<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
    leaf:'<path d="M20 4C11 4 5 7.5 5 13a6 6 0 0 0 6 6c5.5 0 9-6 9-15Z"/><path d="M4 21c3-5 7-8 12-11"/>',
    fluid:'<path d="M3 7h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 17h7a3 3 0 1 1-3 3"/>',
    compass:'<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z"/>',
    ground:'<path d="M4 5h16M4 10h16M4 15h16M4 20h16"/><path d="m8 5 2 5-2 5 2 5m6-15-2 5 2 5-2 5"/>',
    transport:'<path d="M4 7h13l-3-3m3 3-3 3M20 17H7l3 3m-3-3 3-3"/>',
    beam:'<path d="M4 7h16M4 17h16M7 7v10m10-10v10M4 12h16"/>',
    building:'<path d="M4 21V5l8-3 8 3v16M8 8h2m4 0h2M8 12h2m4 0h2M8 16h2m4 0h2M10 21v-3h4v3"/>',
    grid:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16m6-16v16M4 9h16m-16 6h16"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.1 1.9-2 3.4-2.2-.4a8 8 0 0 1-1.8 1L14 23h-4l-.6-2a8 8 0 0 1-1.8-1l-2.2.4-2-3.4 1.1-1.9a8 8 0 0 1 0-2.1l-1.1-1.9 2-3.4 2.2.4a8 8 0 0 1 1.8-1L10 5h4l.6 2a8 8 0 0 1 1.8 1l2.2-.4 2 3.4-1.1 1.9a8 8 0 0 1-.1 2.1Z" transform="translate(-1 -2) scale(1.08)"/>',
    solid:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2m10 8h-2M12 22v-2M2 12h2"/>',
    bookmark:'<path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-3.7L6 21V4.8Z"/>',
    mistake:'<path d="M12 3 2.8 19a1.3 1.3 0 0 0 1.1 2h16.2a1.3 1.3 0 0 0 1.1-2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    backup:'<path d="M4 7.5h16v13H4zM3 4h18v3.5H3z"/><path d="M12 10v7m-3-3 3 3 3-3"/>',
    restore:'<path d="M4 7.5h16v13H4zM3 4h18v3.5H3z"/><path d="M12 17v-7m-3 3 3-3 3 3"/>',
    moon:'<path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.7 8.7 0 1 0 20.4 15.2Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
  };
  return `<svg class="line-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]||paths.grid}</svg>`;
}
function iconFor(text='') { const key=text.toLowerCase(); const icons=[['mathematics','math'],['aptitude','aptitude'],['hydrology','water'],['environmental','leaf'],['fluid','fluid'],['geomatics','compass'],['geotechnical','ground'],['transportation','transport'],['steel','beam'],['rcc','building'],['structural','building'],['irrigation','water'],['construction','grid'],['mechanics','gear'],['solid','solid']]; return iconSvg((icons.find(([word])=>key.includes(word))||['','grid'])[1]); }

async function loadDataset() {
  const manifestResponse=await fetch('data/questions-manifest.json');
  if(!manifestResponse.ok) throw new Error(`Question bank manifest unavailable (${manifestResponse.status})`);
  questionManifest=await manifestResponse.json();
  if(!Array.isArray(questionManifest.subjects)||!questionManifest.subjects.length) throw new Error('Question bank manifest is empty or invalid.');
  subjects=questionManifest.subjects.map(entry=>entry.subject).sort((a,b)=>a.localeCompare(b));
  topicsBySubject=new Map(questionManifest.subjects.map(entry=>[entry.subject,new Map(entry.topics.map(topic=>[topicKey(topic.name),topic.name]))]));
  if(user.theme==='dark')document.body.classList.add('dark');
  const hash=location.hash.replace('#','').split('/')[0];
  if(hash==='results'&&user.history.length){view='results';activeResult=user.history[0].id;}
  else if(['subject','topic','year','custom','analytics','bookmarks','mistakes','profile'].includes(hash))view=hash;
  else if(hash==='exam'&&user.activeExam)view='exam';
  if((view==='subject'||view==='topic')&&!selectedSubject)selectedSubject=subjects[0];
  try { await loadMadeEasyCatalog(); } catch (error) { console.warn('[MadeEasy] catalog unavailable:', error); }
  await ensureViewQuestions(view);
  render();
}

function candidateBlock() {
  const profile = window.SupaAuth?.profile();
  const u = authUser;
  if (u && profile) {
    const name = profile.display_name || u.email || 'Candidate';
    const avatarUrl = profile.avatar_url || '';
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const avatarHtml = avatarUrl
      ? `<img src="${esc(avatarUrl)}" alt="${esc(name)}" class="candidate-photo">`
      : `<span class="candidate-initials">${esc(initials)}</span>`;
    return `<div class="candidate"><div class="candidate-avatar candidate-avatar-auth">${avatarHtml}</div><strong>${esc(name)}</strong></div>`;
  }
  return `<div class="candidate"><div class="candidate-avatar">👤</div><strong>Candidate</strong></div>`;
}

function authHeaderButton() {
  if (!window.SupaAuth) return '';
  const u = authUser;
  if (!u) {
    return `<button class="auth-login-button" data-action="auth-login" title="Sign in with Google">
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.29-8.16 2.29-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      <span>Sign in</span>
    </button>`;
  }
  const profile = SupaAuth.profile();
  const avatarUrl = profile?.avatar_url || '';
  const name = profile?.display_name || u.email || 'User';
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const avatar = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="${esc(name)}" class="auth-avatar-img">`
    : `<span class="auth-avatar-initials">${esc(initials)}</span>`;
  return `<div class="auth-user-widget">
    <button class="profile-open-button" data-action="go" data-view="profile" title="Open profile"><span class="auth-avatar">${avatar}</span><span class="auth-user-name">${esc(name.split(' ')[0])}</span></button>
    <button class="auth-logout-button" data-action="auth-logout" title="Sign out" aria-label="Sign out">${iconSvg('logout')}</button>
  </div>`;
}

function header() {
  const examView=view==='exam';
  if(examView){
    const madeEasy=user.activeExam?.source==='made-easy';
    const examLabel=user.activeExam?.examLabel||'GATE 2027';
    return `<header class="exam-masthead"><button class="masthead-seal" data-action="finish-later" title="Save and exit"><img src="assets/iitmadras.png?v=2" alt="Save and exit"></button><div class="masthead-title"><strong>${madeEasy?'MADE EASY TEST SERIES':'GRADUATE APTITUDE TEST IN ENGINEERING'} <span>(${esc(madeEasy?examLabel:'GATE 2027')})</span></strong><small>${madeEasy?'Civil Engineering practice · Exam-like interface':'Organizing Institute: INDIAN INSTITUTE OF TECHNOLOGY MADRAS'}</small></div><span class="masthead-brand" title="GATE CE"><img src="assets/gate-ce-mark.png?v=1" alt="GATE CE"></span></header>`;
  }
  const active=({home:['home','subject','topic','year','custom'],analytics:['analytics'],bookmarks:['bookmarks'],mistakes:['mistakes']});
  return `<header class="app-header ${examView?'exam-app-header':''}">
    <a class="brand" href="#home" data-action="go" data-view="home"><span class="brand-mark"><img src="assets/gate-ce-mark.png?v=1" alt=""></span><span class="brand-copy"><strong>GATE CE</strong><small>PREVIOUS YEAR PRACTICE</small></span></a>
    <nav class="header-nav"><button class="nav-link ${active.home?.includes(view)?'active':''}" data-action="go" data-view="home">${iconSvg('grid')}<span>Question Library</span></button><button class="nav-link ${view==='analytics'?'active':''}" data-action="go" data-view="analytics">${iconSvg('math')}<span>Analytics</span></button><button class="nav-link ${view==='bookmarks'?'active':''}" data-action="go" data-view="bookmarks">${iconSvg('bookmark')}<span>Bookmarks</span><span class="nav-count">${user.bookmarks.length||''}</span></button><button class="nav-link ${view==='mistakes'?'active':''}" data-action="go" data-view="mistakes">${iconSvg('mistake')}<span>Mistakes</span><span class="nav-count">${user.mistakes.length||''}</span></button></nav>
    <div class="header-tools"><button class="header-button" data-action="backup">${iconSvg('backup')}<span>Backup</span>${backupAttention()}</button><button class="icon-button" data-action="theme" aria-label="${user.theme==='dark'?'Switch to light theme':'Switch to dark theme'}" title="${user.theme==='dark'?'Switch to light theme':'Switch to dark theme'}">${iconSvg(user.theme==='dark'?'sun':'moon')}</button>${authHeaderButton()}</div>
  </header>`;
}
function render() {
  clearInterval(timerHandle); timerHandle=null;
  if(!questionManifest)return;
  if(view==='exam'&&user.activeExam){renderExam(); startTimer(); return;}
  if(view==='results'){renderResult();return;}
  if(view==='subject'){renderSubject();return;}
  if(view==='topic'){renderTopic();return;}
  if(view==='year'){renderYear();return;}
  if(view==='custom'){renderCustom();return;}
  if(view==='analytics'){renderAnalytics();return;}
  if(view==='profile'){renderProfile();return;}
  if(view==='bookmarks'||view==='mistakes'){renderCollection(view);return;}
  renderHome();
}
function practicePickerCards() {
  const subjectCount=subjectCounts();
  const subjectOptions=subjects.map(subject=>`<option value="${esc(subject)}">${esc(subject)} · ${countLabel(subjectCount.get(subject)||0)}</option>`).join('');
  const topicOptions=questionManifest.subjects.flatMap(entry=>entry.topics.map(topic=>[entry.subject,topicKey(topic.name),topic.name]))
    .sort((a,b)=>a[2].localeCompare(b[2])||a[0].localeCompare(b[0]))
    .map(([subject,key,label])=>`<option value="${esc(JSON.stringify([subject,key]))}">${esc(label)} · ${esc(subject)}</option>`).join('');
  const yearCounts=new Map();
  for(const entry of questionManifest.subjects)for(const year of entry.years)yearCounts.set(year.year,(yearCounts.get(year.year)||0)+year.count);
  const years=[...yearCounts.keys()].sort((a,b)=>num(b)-num(a));
  const yearOptions=years.map(year=>`<option value="${esc(year)}">${esc(year)} · ${countLabel(yearCounts.get(year))}</option>`).join('');
  const card=(kind,title,description,options)=>`<section class="surface quick-practice-card"><div class="quick-practice-icon">${iconSvg(kind==='subject'?'grid':kind==='topic'?'compass':'beam')}</div><div class="quick-practice-copy"><h3>Practice by ${title}</h3><p>${description}</p><select class="form-control practice-select" data-kind="${kind}" aria-label="Choose ${title.toLowerCase()}"><option value="">Choose ${title.toLowerCase()}…</option>${options}</select><button class="primary-button" data-action="start-quick-practice" data-kind="${kind}" disabled>Start practice</button></div></section>`;
  return `<div class="quick-practice-grid">${card('subject','Subject','Practice questions from one subject.',subjectOptions)}${card('topic','Topic','Focus on a specific topic.',topicOptions)}${card('year','Year','Build a set from a GATE CE year.',yearOptions)}</div>`;
}
function homeDashboard() {
  const countdown=examCountdownParts();
  return `<section class="hero home-hero"><div class="hero-row"><div><div class="eyebrow">GATE CE QUESTION BANK</div><h1>Get the real feel of D-Day.</h1><p>Practice previous year questions in a GATE exam-like interface, with ${questionCount().toLocaleString()} questions across ${subjects.length} subjects and ${totalTopicCount()} topics.</p><div class="exam-countdown" aria-label="Countdown to 1 February 2027"><span class="countdown-label">Countdown to <strong>1 Feb 2027</strong></span><span class="countdown-value"><b id="countdown-days">${countdown.days}</b><small>d</small><b id="countdown-hours">${String(countdown.hours).padStart(2,'0')}</b><small>h</small><b id="countdown-minutes">${String(countdown.minutes).padStart(2,'0')}</b><small>m</small><b id="countdown-seconds">${String(countdown.seconds).padStart(2,'0')}</b><small>s</small></span></div></div><div class="hero-stats"><div class="hero-stat"><strong>${questionCount().toLocaleString()}</strong><span>Questions</span></div><div class="hero-stat"><strong>${subjects.length}</strong><span>Subjects</span></div><div class="hero-stat"><strong>${totalTopicCount()}</strong><span>Topics</span></div></div></div></section>
  ${user.activeExam?`<section class="resume-banner home-resume"><div><strong>Continue your practice</strong><span>${esc(user.activeExam.title)} · ${countLabel(user.activeExam.qids.length)} · ${fmtTime(Math.ceil((user.activeExam.deadline-Date.now())/1000))} left</span></div><div class="topic-actions"><button class="primary-button" data-action="resume">Resume exam</button><button class="outline-button" data-action="discard-exam">Discard</button></div></section>`:''}`;
}
function homeActivity() {
  const doneToday=user.history.some(a=>new Date(a.endedAt).toDateString()===new Date().toDateString());
  const quote=DAILY_QUOTES[quoteOfTheDayIndex()];
  return `<section class="home-activity"><div class="home-section-heading"><div><h2>Your routine</h2><p>Build a steady practice habit and keep track of what’s next.</p></div></div><div class="dashboard-row"><section class="surface dashboard-card"><div class="card-heading"><h2>Daily practice</h2><div class="streak-total"><div class="streak-fire">✓</div><div><strong>${user.history.length?Math.min(user.history.length,99):0} sessions</strong><small>${doneToday?'You practiced today':'Build a steady routine'}</small></div></div></div>${practiceCalendarHtml()}</section><section class="surface dashboard-card home-routine-card"><article class="daily-quote"><span class="quote-kicker">QUOTE OF THE DAY</span><blockquote>“${esc(quote)}”</blockquote><span class="quote-counter">${quoteOfTheDayIndex()+1} / ${DAILY_QUOTES.length}</span></article><div class="todo-section"><h2>To-do list</h2><div class="todo-line"><input id="todoInput" placeholder="Add a to-do…"><button class="add-button" data-action="add-todo" aria-label="Add to-do">+</button></div><ul class="todo-list">${user.todos.slice(0,4).map((todo,i)=>`<li class="todo-item"><input type="checkbox" data-action="toggle-todo" data-index="${i}" ${todo.done?'checked':''}><span>${esc(todo.text)}</span><button data-action="delete-todo" data-index="${i}" aria-label="Delete">×</button></li>`).join('')}</ul></div></section></div></section>`;
}
const DAILY_QUOTES = [
  'Great things are done by a series of small things brought together. — Vincent van Gogh',
  'It always seems impossible until it is done. — Nelson Mandela',
  'The secret of getting ahead is getting started. — Mark Twain',
  'Well done is better than well said. — Benjamin Franklin',
  'Success is the sum of small efforts, repeated day in and day out. — Robert Collier',
  'The future depends on what you do today. — Mahatma Gandhi',
  'It does not matter how slowly you go as long as you do not stop. — Confucius',
  'A journey of a thousand miles begins with a single step. — Lao Tzu',
  'The expert in anything was once a beginner. — Helen Hayes',
  'Energy and persistence conquer all things. — Benjamin Franklin',
  'Dreams do not work unless you do. — John C. Maxwell',
  'The way to get started is to quit talking and begin doing. — Walt Disney',
  'You are capable of more than you know.',
  'Little by little, one travels far. — J. R. R. Tolkien',
  'Great acts are made up of small deeds. — Lao Tzu',
  'The secret of success is constancy to purpose. — Benjamin Disraeli',
  'A goal without a plan is just a wish. — Antoine de Saint-Exupéry',
  'What we learn with pleasure we never forget. — Alfred Mercier',
  'Learning never exhausts the mind. — Leonardo da Vinci',
  'The beautiful thing about learning is nobody can take it away from you. — B. B. King',
  'The more that you read, the more things you will know. — Dr. Seuss',
  'Knowledge is power. — Francis Bacon',
  'An investment in knowledge pays the best interest. — Benjamin Franklin',
  'The roots of education are bitter, but the fruit is sweet. — Aristotle',
  'Education is the passport to the future. — Malcolm X',
  'Learning is not attained by chance; it must be sought for with ardor. — Abigail Adams',
  'The mind is not a vessel to be filled but a fire to be kindled. — Plutarch',
  'The more I learn, the more I realize how much I do not know. — Albert Einstein',
  'Study hard what interests you the most in the most undisciplined, irreverent and original manner possible. — Richard Feynman',
  'Curiosity is the wick in the candle of learning. — William Arthur Ward',
  'Success is the progressive realization of a worthy goal. — Earl Nightingale',
  'If you can dream it, you can do it. — Walt Disney',
  'Nothing will work unless you do. — Maya Angelou',
  'Act as if what you do makes a difference. It does. — William James',
  'Believe you can and you’re halfway there. — Theodore Roosevelt',
  'Keep your eyes on the stars, and your feet on the ground. — Theodore Roosevelt',
  'You miss 100% of the shots you don’t take. — Wayne Gretzky',
  'The only limit to our realization of tomorrow is our doubts of today. — Franklin D. Roosevelt',
  'Start where you are. Use what you have. Do what you can. — Arthur Ashe',
  'Everything you can imagine is real. — Pablo Picasso',
  'Quality is not an act, it is a habit. — Aristotle',
  'We are what we repeatedly do. — Will Durant',
  'Motivation gets you going and habit gets you there. — Zig Ziglar',
  'The secret of your future is hidden in your daily routine. — Mike Murdock',
  'A year from now you may wish you had started today. — Karen Lamb',
  'The best way out is always through. — Robert Frost',
  'Difficulties strengthen the mind, as labor does the body. — Seneca',
  'Fall seven times and stand up eight. — Japanese proverb',
  'Our greatest glory is not in never falling, but in rising every time we fall. — Confucius',
  'Failure is success in progress. — Albert Einstein',
  'A person who never made a mistake never tried anything new. — Albert Einstein',
  'Courage is resistance to fear, mastery of fear, not absence of fear. — Mark Twain',
  'Perseverance is not a long race; it is many short races one after another. — Walter Elliot',
  'You don’t have to see the whole staircase, just take the first step. — Martin Luther King Jr.',
  'Great works are performed not by strength but by perseverance. — Samuel Johnson',
  'Patience and perseverance have a magical effect before which difficulties disappear. — John Quincy Adams',
  'He who has a why to live can bear almost any how. — Friedrich Nietzsche',
  'Doubt kills more dreams than failure ever will. — Suzy Kassem',
  'Your limitation—it’s only your imagination.',
  'Push yourself, because no one else is going to do it for you.',
  'Work hard in silence; let success make the noise.',
  'Don’t watch the clock; do what it does. Keep going. — Sam Levenson',
  'The only place where success comes before work is in the dictionary. — Vidal Sassoon',
  'Success usually comes to those who are too busy to be looking for it. — Henry David Thoreau',
  'There are no shortcuts to any place worth going. — Beverly Sills',
  'The harder I work, the luckier I get. — Samuel Goldwyn',
  'Opportunities are usually disguised as hard work. — Ann Landers',
  'The difference between ordinary and extraordinary is that little extra. — Jimmy Johnson',
  'Do what you can, with what you have, where you are. — Theodore Roosevelt',
  'If opportunity doesn’t knock, build a door. — Milton Berle',
  'Action is the foundational key to all success. — Pablo Picasso',
  'Nothing is particularly hard if you divide it into small jobs. — Henry Ford',
  'Well begun is half done. — Aristotle',
  'Start by doing what’s necessary; then do what’s possible. — Francis of Assisi',
  'One day or day one. You decide.',
  'Make each day your masterpiece. — John Wooden',
  'The best preparation for tomorrow is doing your best today. — H. Jackson Brown Jr.',
  'Every accomplishment starts with the decision to try. — John F. Kennedy',
  'Don’t let what you cannot do interfere with what you can do. — John Wooden',
  'The only way to achieve the impossible is to believe it is possible. — Charles Kingsleigh',
  'If you have a positive attitude and constantly strive to give your best effort, eventually you will overcome your immediate problems. — Pat Riley',
  'Success is not final, failure is not fatal: it is the courage to continue that counts. — Winston Churchill',
  'The best view comes after the hardest climb.',
  'Small disciplines repeated with consistency every day lead to great achievements. — John C. Maxwell',
  'The man who moves a mountain begins by carrying away small stones. — Confucius',
  'Be so good they can’t ignore you. — Steve Martin',
  'Nothing great was ever achieved without enthusiasm. — Ralph Waldo Emerson',
  'To improve is to change; to be perfect is to change often. — Winston Churchill',
  'The secret to getting results is to never stop making improvements. — James Dyson',
  'If you get tired, learn to rest, not to quit.',
  'Be stronger than your excuses.',
  'Discipline is choosing between what you want now and what you want most. — Abraham Lincoln',
  'You don’t need to be extreme, just consistent.',
  'Every day is a chance to get better.',
  'Progress, not perfection.',
  'Focus on the step in front of you, not the whole staircase.',
  'In the middle of difficulty lies opportunity. — Albert Einstein',
  'Success is walking from failure to failure with no loss of enthusiasm. — Winston Churchill',
  'If you want to lift yourself up, lift up someone else. — Booker T. Washington',
  'Nothing can dim the light that shines from within. — Maya Angelou'
];
function quoteOfTheDayIndex(date=new Date()) {
  const day=Math.floor(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000);
  return ((day%DAILY_QUOTES.length)+DAILY_QUOTES.length)%DAILY_QUOTES.length;
}
function practiceCalendarHtml() {
  const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth();
  const monthLabel=calendarMonth.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  const sessionCounts=new Map();
  for(const a of user.history){const d=new Date(a.endedAt);if(Number.isNaN(d.getTime()))continue;const key=`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;sessionCounts.set(key,(sessionCounts.get(key)||0)+1);}
  const daysInMonth=new Date(year,month+1,0).getDate(),offset=(new Date(year,month,1).getDay()+6)%7;
  const cells=Array.from({length:offset},()=>'<span class="calendar-blank" aria-hidden="true"></span>');
  for(let day=1;day<=daysInMonth;day++){
    const date=new Date(year,month,day),key=`${year}-${month}-${day}`,count=sessionCounts.get(key)||0;
    const isToday=date.toDateString()===new Date().toDateString(),selected=calendarSelectedDate===key;
    const classes=['calendar-day',isToday?'today':'',count?'has-practice':'',selected?'selected':''].filter(Boolean).join(' ');
    const label=date.toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'});
    cells.push(`<button type="button" class="${classes}" data-action="calendar-select-day" data-date="${key}" aria-label="${label}${count?`, ${count} practice session${count===1?'':'s'}`:''}" aria-pressed="${selected}" title="${count?`${count} practice session${count===1?'':'s'}`:label}">${day}${count?'<i aria-hidden="true"></i>':''}</button>`);
  }
  while(cells.length<35)cells.push('<span class="calendar-blank" aria-hidden="true"></span>');
  const selectedCount=calendarSelectedDate?sessionCounts.get(calendarSelectedDate)||0:null;
  const summary=selectedCount===null?`${[...sessionCounts].filter(([key])=>key.startsWith(`${year}-${month}-`)).reduce((sum,[,count])=>sum+count,0)} practice session${[...sessionCounts].filter(([key])=>key.startsWith(`${year}-${month}-`)).reduce((sum,[,count])=>sum+count,0)===1?'':'s'} this month`:selectedCount?`${selectedCount} practice session${selectedCount===1?'':'s'} on ${new Date(year,month,Number(calendarSelectedDate.split('-')[2])).toLocaleDateString(undefined,{month:'short',day:'numeric'})}`:`No practice recorded on ${new Date(year,month,Number(calendarSelectedDate.split('-')[2])).toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;
  return `<div id="practiceCalendar" class="practice-calendar"><div class="calendar-toolbar"><button type="button" class="calendar-nav" data-action="calendar-prev" aria-label="Previous month">‹</button><strong>${monthLabel}</strong><button type="button" class="calendar-nav" data-action="calendar-next" aria-label="Next month">›</button></div><div class="calendar-grid calendar-weekdays" aria-hidden="true">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span>${d}</span>`).join('')}</div><div class="calendar-grid calendar-dates">${cells.join('')}</div><div class="calendar-summary"><span class="calendar-key"></span>${summary}</div></div>`;
}
function homePracticeHistory() {
  const recent=user.history.slice(0,5);
  return `<section class="home-history"><div class="home-section-heading"><div><h2>Recent practice</h2><p>Pick up where you left off and review a completed set.</p></div><button class="outline-button" data-action="go" data-view="analytics">View analytics</button></div>${recent.length?`<div class="home-history-list">${recent.map(a=>`<div class="surface home-history-row"><span class="home-history-mark" aria-hidden="true">✓</span><button class="home-history-main home-history-open" data-action="view-result" data-result="${esc(a.id)}"><strong>${esc(a.title)}</strong><small>${dateLabel(a.endedAt)} · ${a.correct} correct · ${a.incorrect} incorrect</small></button><span class="home-history-score"><strong>${num(a.score).toFixed(2)}</strong><small>of ${num(a.totalMarks).toFixed(2)} marks</small></span><button class="home-history-review" data-action="view-result" data-result="${esc(a.id)}">Review <span aria-hidden="true">→</span></button><button class="small-action" data-action="rename-history" data-result="${esc(a.id)}" title="Rename this test">Rename</button><button class="history-delete-button" data-action="delete-history" data-result="${esc(a.id)}" title="Delete this test from history" aria-label="Delete ${esc(a.title)} from history">×</button></div>`).join('')}</div>`:`<div class="surface home-history-empty"><span class="home-history-mark" aria-hidden="true">◷</span><span><strong>Your practice history will appear here</strong><small>Complete a practice set to see your score and review it later.</small></span></div>`}</section>`;
}
function madeEasySection() {
  if (!madeEasyCatalog.length) return '';
  const groups = [...new Set(madeEasyCatalog.map(test => test.group))];
  const count = madeEasyCatalog.reduce((sum, test) => sum + test.questionCount, 0);
  return `<section class="made-easy-section"><div class="home-section-heading"><div><h2>Made Easy Test Series <span class="new-tag">NEW</span></h2><p>${madeEasyCatalog.length} Civil Engineering tests · ${count.toLocaleString()} questions · GATE and ESE sets · Answer keys and solutions included</p></div></div><div class="made-easy-groups">${groups.map((group, index) => {
    const tests = madeEasyCatalog.filter(test => test.group === group);
    return `<details class="made-easy-group" ${index === 0 ? 'open' : ''}><summary><strong>${esc(group)}</strong><span>${tests.length} tests</span></summary><div class="made-easy-grid">${tests.map(test => `<article class="surface made-easy-card"><div class="made-easy-card-top"><span class="made-easy-mark"><img src="assets/made-easy-logo.png?v=1" alt="Made Easy"></span><span class="new-tag">NEW</span></div><h3>${esc(test.title)}</h3><p>${test.questionCount} questions · ${fmtDuration(test.durationSeconds)} · ${esc(test.examLabel)}</p><button class="primary-button" data-action="start-made-easy-test" data-test-id="${esc(test.id)}">Start test →</button></article>`).join('')}</div></details>`;
  }).join('')}</div></section>`;
}
function renderHome() {
  const counts=subjectCounts();
  const topicCount=totalTopicCount();
  app.innerHTML=`${header()}<main class="page home-page">${homeDashboard()}<section class="home-practice"><div class="home-section-heading"><div><h2>Start practicing</h2><p>Choose the way you want to work through the question bank.</p></div><div class="topic-actions"><button class="primary-button custom-test-cta" data-action="go" data-view="custom">Build a custom test</button></div></div>${practicePickerCards()}</section>${madeEasySection()}<section class="library-section home-library"><div class="library-section-head"><div><h2>Browse the question bank</h2><p>${countLabel(questionCount())} · ${topicCount} topics · GATE CE 2001–2026</p></div></div><div class="library-controls"><div class="search-wrap"><span class="search-icon">⌕</span><input class="search-input" id="librarySearch" placeholder="Search subjects and topics" autocomplete="off"></div><div class="segmented"><button class="segment-button active" data-action="go" data-view="home">By subject</button><button class="segment-button" data-action="go" data-view="year">By year</button></div></div><div class="subject-grid">${subjects.map(subject=>`<button class="surface subject-card browse-item" data-action="open-subject" data-subject="${esc(subject)}" data-search="${esc(`${subject} ${topicsFor(subject).join(' ')} ${manifestEntry(subject).years.map(y=>y.year).join(' ')}`.toLowerCase())}"><span class="subject-icon">${iconFor(subject)}</span><span class="subject-copy"><strong>${esc(subject)}</strong><small>${countLabel(counts.get(subject)||0)} · ${topicsFor(subject).length} topics</small></span><span class="subject-arrow">›</span></button>`).join('')}</div></section>${homeActivity()}${homePracticeHistory()}<footer class="home-footer"><span>Made with <span class="footer-heart" aria-label="love">♥</span> by <a href="https://github.com/0xniru" target="_blank" rel="noopener noreferrer">Niru</a></span></footer></main>`;
}
function renderSubject() {
  const subject=selectedSubject||subjects[0];const topics=topicsFor(subject);const counts=new Map(topics.map(t=>[t,qsForTopic(subject,t).length]));
  app.innerHTML=`${header()}<main class="page"><div class="breadcrumb"><button data-action="go" data-view="home">Question Library</button><span>›</span><span>${esc(subject)}</span></div><section class="surface topic-intro"><div><h1>${esc(subject)}</h1><p>${countLabel([...counts.values()].reduce((a,b)=>a+b,0))} across ${topics.length} topics</p></div><button class="primary-button" data-action="practice-subject">Practice this subject →</button></section><div class="library-controls"><div class="search-wrap"><span class="search-icon">⌕</span><input class="search-input" id="librarySearch" placeholder="Filter topics…"></div><button class="outline-button" data-action="go" data-view="year">Browse all years</button></div><div class="topic-grid">${topics.map(topic=>`<button class="surface topic-card browse-item" data-action="open-topic" data-topic="${esc(topic)}" data-search="${esc(topic.toLowerCase())}"><span class="subject-icon">▸</span><span class="subject-copy"><strong>${esc(topic)}</strong><small>${countLabel(counts.get(topic)||0)} · ${new Set(qsForTopic(subject,topic).map(q=>q.year)).size} years</small></span><span class="topic-count">›</span></button>`).join('')}</div></main>`;
}
function renderTopic() {
  const subject=selectedSubject||subjects[0], topic=selectedTopic||topicsFor(subject)[0], qs=qsForTopic(subject,topic);
  const years=[...new Set(qs.map(q=>q.year))].sort((a,b)=>b-a);
  const rows=years.map(year=>{
    const yearQs=qs.filter(q=>q.year===year);const sessions=[...new Set(yearQs.map(q=>q.session||'Full year'))].sort();
    return sessions.map(session=>{const group=yearQs.filter(q=>(q.session||'Full year')===session);return `<tr><td><strong>${year}</strong></td><td>${esc(session)}</td><td>${group.length}</td><td>${group.reduce((s,q)=>s+num(q.marks),0)}</td><td><button class="small-action" data-action="start-topic-year" data-year="${year}" data-session="${esc(session)}">Start practice →</button></td></tr>`;}).join('');
  }).join('');
  app.innerHTML=`${header()}<main class="page"><div class="breadcrumb"><button data-action="go" data-view="home">Question Library</button><span>›</span><button data-action="open-subject" data-subject="${esc(subject)}">${esc(subject)}</button><span>›</span><span>${esc(topic)}</span></div><section class="surface topic-intro"><div><h1>${esc(topic)}</h1><p>${esc(subject)} · ${countLabel(qs.length)} · ${years.length} years</p></div><div class="topic-actions"><button class="outline-button" data-action="practice-topic-year">Choose a year</button><button class="primary-button" data-action="practice-topic">Practice all ${qs.length} questions →</button></div></section><section class="surface" style="overflow:hidden"><div class="card-heading" style="padding:16px 16px 0"><h2>Practice by year and session</h2><small>One timed practice set per source exam/session</small></div><table class="topic-table"><thead><tr><th>Year</th><th>Session</th><th>Questions</th><th>Marks</th><th></th></tr></thead><tbody>${rows}</tbody></table></section></main>`;
}
function renderYear() {
  const groups=new Map();
  for(const q of questions){const key=`${q.year}|${q.session||'Full year'}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(q);}
  const years=[...new Set(questions.map(q=>q.year))].sort((a,b)=>b-a);
  app.innerHTML=`${header()}<main class="page"><div class="breadcrumb"><button data-action="go" data-view="home">Question Library</button><span>›</span><span>By year</span></div><section class="surface topic-intro"><div><h1>Year-wise question sets</h1><p>Build a practice paper from all subjects in a GATE CE year and session.</p></div></section>${years.map(year=>{const sessions=[...groups.keys()].filter(k=>k.startsWith(`${year}|`)).map(k=>k.split('|')[1]);return `<section class="library-section"><div class="library-section-head"><h2>${year}</h2><span>${sessions.length} session${sessions.length===1?'':'s'}</span></div><div class="year-cards">${sessions.map(session=>{const group=groups.get(`${year}|${session}`)||[];return `<button class="surface year-card browse-item" data-action="start-year" data-year="${year}" data-session="${esc(session)}" data-search="${year} ${esc(session).toLowerCase()}"><strong>${year} · ${esc(session)}</strong><small>${countLabel(group.length)} · ${group.reduce((n,q)=>n+num(q.marks),0)} marks · Start →</small></button>`;}).join('')}</div></section>`;}).join('')}</main>`;
}
function customSourcePool(source=customBuilder.source) {
  return source==='bookmarks'
    ? user.bookmarks.map(id=>questionById.get(id)).filter(Boolean)
    : source==='mistakes'
      ? user.mistakes.map(id=>questionById.get(id)).filter(Boolean)
      : questions;
}
function uniqueById(list) {
  const seen=new Set();
  return list.filter(item=>item?.id&&!seen.has(item.id)&&(seen.add(item.id),true));
}
function customAvailableTopics() {
  let available=customSourcePool();
  if(customBuilder.subjects.length)available=available.filter(q=>customBuilder.subjects.includes(q.subject));
  const mapped=buildTopicsBySubject(available);
  const chosen=customBuilder.subjects.length?customBuilder.subjects:[...mapped.keys()];
  const topics=[...new Set(chosen.flatMap(subject=>[...(mapped.get(subject)?.values()||[])]))];
  return topics.sort((a,b)=>a.localeCompare(b));
}
function customPool() {
  let pool=uniqueById(customSourcePool());
  if(customBuilder.subjects.length)pool=pool.filter(q=>customBuilder.subjects.includes(q.subject));
  if(customBuilder.topics.length){
    const selected=new Set(customBuilder.topics.map(topic=>topicKey(topic)));
    pool=pool.filter(q=>selected.has(topicKey(q.topic)));
  }
  if(customBuilder.types.length)pool=pool.filter(q=>customBuilder.types.includes(q.type));
  return pool;
}
function toggleCustomChoice(list,value) {
  return list.includes(value)?list.filter(item=>item!==value):[...list,value];
}
function normalizeCustomBuilder() {
  customBuilder.subjects=customBuilder.subjects.filter(subject=>subjects.includes(subject));
  const availableTopics=customAvailableTopics();
  customBuilder.topics=customBuilder.topics.filter(topic=>availableTopics.includes(topic));
  const allowedTypes=['MCQ','MSQ','NAT'];
  customBuilder.types=customBuilder.types.filter(type=>allowedTypes.includes(type));
  if(!customBuilder.types.length)customBuilder.types=[...allowedTypes];
  if(!['all','bookmarks','mistakes'].includes(customBuilder.source))customBuilder.source='all';
  if(!Number.isFinite(num(customBuilder.count))||num(customBuilder.count)<1)customBuilder.count=30;
  if(!Number.isFinite(num(customBuilder.durationMinutes))||num(customBuilder.durationMinutes)<1)customBuilder.durationMinutes=60;
}
function customCountLabel(selected,total,label) {
  if(!total)return `No ${label} available`;
  return selected?`${selected} selected`:`All ${label}`;
}
function refreshCustomForm(syncFromInputs=true) {
  if(syncFromInputs){
    const countInput=$('customCount'),durationInput=$('customDuration'),sourceInput=$('customSourceSelect'),titleInput=$('customTitle');
    if(countInput)customBuilder.count=countInput.value;
    if(durationInput)customBuilder.durationMinutes=durationInput.value;
    if(sourceInput)customBuilder.source=sourceInput.value;
    if(titleInput)customBuilder.title=titleInput.value;
  }
  normalizeCustomBuilder();
  const pool=customPool();
  const countInput=$('customCount'),durationInput=$('customDuration'),sourceInput=$('customSourceSelect');
  if(sourceInput)sourceInput.value=customBuilder.source;
  if(countInput){
    countInput.max=String(Math.max(1,pool.length));
    const requested=Math.max(1,Math.floor(num(customBuilder.count)||1));
    customBuilder.count=pool.length?Math.min(requested,pool.length):requested;
    countInput.value=String(customBuilder.count);
  }
  if(durationInput){
    const minutes=Math.max(1,Math.floor(num(customBuilder.durationMinutes)||1));
    customBuilder.durationMinutes=minutes;
    durationInput.value=String(minutes);
  }
  const summary=$('customPoolSummary');
  const startButton=app.querySelector('[data-action="start-custom"]');
  const subjectHint=$('customSubjectHint');
  const topicHint=$('customTopicHint');
  const typeHint=$('customTypeHint');
  if(subjectHint)subjectHint.textContent=customCountLabel(customBuilder.subjects.length,subjects.length,'subjects');
  if(topicHint)topicHint.textContent=customCountLabel(customBuilder.topics.length,customAvailableTopics().length,'topics');
  if(typeHint)typeHint.textContent=customBuilder.types.length===3?'All question types selected':`${customBuilder.types.length} type${customBuilder.types.length===1?'':'s'} selected`;
  if(summary){
    if(pool.length){
      const requested=Math.max(1,Math.floor(num(customBuilder.count)||1));
      summary.textContent=`${countLabel(pool.length)} match your filters. This test will include ${Math.min(requested,pool.length)} questions in ${Math.max(1,Math.floor(num(customBuilder.durationMinutes)||1))} minute${Math.max(1,Math.floor(num(customBuilder.durationMinutes)||1))===1?'':'s'}.`;
    }else summary.textContent='No questions match these filters. Adjust subjects, topics, types, or source.';
  }
  if(startButton)startButton.disabled=!pool.length;
}
function renderCustom() {
  normalizeCustomBuilder();
  const sourceOptions=[
    {value:'all',label:'Question bank'},
    {value:'bookmarks',label:`Bookmarks (${user.bookmarks.length})`},
    {value:'mistakes',label:`Mistakes (${user.mistakes.length})`}
  ];
  const availableTopics=customAvailableTopics();
  const chip=(kind,value,label,active)=>`<button type="button" class="custom-chip ${active?'active':''}" data-action="toggle-custom-${kind}" data-value="${esc(value)}" aria-pressed="${active}">${esc(label)}</button>`;
  app.innerHTML=`${header()}<main class="page"><div class="breadcrumb"><button data-action="go" data-view="home">Question Library</button><span>›</span><span>Custom test builder</span></div><section class="surface dashboard-card"><div class="card-heading"><h1 class="section-title">🧪 Custom test builder</h1><small>Create a mixed-subject timed test in GATE style</small></div><div class="custom-builder-grid"><section class="custom-builder-section"><div class="custom-builder-head"><strong>Subjects</strong><span id="customSubjectHint" class="muted"></span></div><div class="custom-builder-actions"><button class="small-action" data-action="custom-subjects-all">Select all</button><button class="small-action" data-action="custom-subjects-clear">Clear</button></div><div class="custom-chip-list">${subjects.map(subject=>chip('subject',subject,subject,customBuilder.subjects.includes(subject))).join('')}</div></section><section class="custom-builder-section"><div class="custom-builder-head"><strong>Topics</strong><span id="customTopicHint" class="muted"></span></div><div class="custom-builder-actions"><button class="small-action" data-action="custom-topics-all">Select all</button><button class="small-action" data-action="custom-topics-clear">Clear</button></div><div class="custom-chip-list">${availableTopics.length?availableTopics.map(topic=>chip('topic',topic,topic,customBuilder.topics.includes(topic))).join(''):'<p class="muted">No topics available for the selected subject/source.</p>'}</div></section><section class="custom-builder-section"><div class="custom-builder-head"><strong>Question types</strong><span id="customTypeHint" class="muted"></span></div><div class="custom-builder-actions"><button class="small-action" data-action="custom-types-all">Select all</button><button class="small-action" data-action="custom-types-clear">Reset</button></div><div class="custom-chip-list">${['MCQ','MSQ','NAT'].map(type=>chip('type',type,type,customBuilder.types.includes(type))).join('')}</div></section></div><div class="custom-form custom-form-compact"><label>Test name<input id="customTitle" class="form-control" type="text" maxlength="80" placeholder="e.g. Soil Mechanics revision" value="${esc(customBuilder.title||'')}"></label><label>Question source<select id="customSourceSelect" class="form-control">${sourceOptions.map(option=>`<option value="${option.value}" ${customBuilder.source===option.value?'selected':''}>${esc(option.label)}</option>`).join('')}</select></label><label>Question count<input id="customCount" class="form-control" type="number" min="1" value="${Math.max(1,Math.floor(num(customBuilder.count)||30))}"></label><label>Duration (minutes)<input id="customDuration" class="form-control" type="number" min="1" value="${Math.max(1,Math.floor(num(customBuilder.durationMinutes)||60))}"></label></div><p class="muted custom-pool-summary" id="customPoolSummary" aria-live="polite"></p><p class="muted" style="font-size:12px">Questions are sampled without replacement from your filtered pool.</p><button class="primary-button" data-action="start-custom">Start custom test →</button></section></main>`;
  refreshCustomForm(false);
}
function openInstructions(exam) {
  pendingExam=exam;
  const summary=exam.filterSummary;
  const scope=summary?`<div class="custom-test-summary"><p><strong>Subjects:</strong> ${esc(summary.subjects.length?summary.subjects.join(', '):'All subjects')}</p><p><strong>Topics:</strong> ${esc(summary.topics.length?summary.topics.join(', '):'All topics')}</p><p><strong>Question types:</strong> ${esc(summary.types.join(', '))}</p><p><strong>Question source:</strong> ${esc(summary.sourceLabel)}</p><p><strong>Duration:</strong> ${Math.max(1,Math.floor(num(summary.durationMinutes)||1))} minute${Math.max(1,Math.floor(num(summary.durationMinutes)||1))===1?'':'s'}</p></div>`:'';
  dialogShow('Before you begin',`<ol class="modal-list"><li>The timer begins when the exam starts. Your responses are saved in this browser as you work.</li><li>MCQ questions have one correct option. MSQ questions may have more than one correct option. NAT questions accept a numerical response.</li><li>Use Save &amp; Next to save a response and move forward. Use Mark for Review &amp; Next to flag a question.</li><li>Submit ends the session. Unverified answers are identified separately and are excluded from scoring.</li></ol>${scope}<p><strong>${esc(exam.title)}</strong><br>${countLabel(exam.qids.length)} · ${exam.qids.reduce((n,id)=>n+num(questionById.get(id)?.marks),0)} marks · ${fmtDuration(exam.durationSeconds)}</p>`,`<button class="outline-button" data-dialog="close">Cancel</button><button class="primary-button" data-dialog="start">Start exam</button>`);
}
function prepareExam(qs,title,meta={}) {
  if(!qs.length){toast('No questions found for that selection.');return;}
  const ids=qs.map(q=>q.id);const marks=qs.reduce((n,q)=>n+num(q.marks),0);
  const customDuration=num(meta.durationSeconds??meta.customDurationSeconds);
  const durationSeconds=Number.isFinite(customDuration)&&customDuration>=60?Math.round(customDuration):Math.max(60,Math.round(marks*108));
  openInstructions({id:`exam-${Date.now()}`,title,qids:ids,subject:meta.subject||null,topic:meta.topic||null,year:meta.year||null,session:meta.session||null,durationSeconds,source:meta.source||null,testId:meta.testId||null,examLabel:meta.examLabel||null,filterSummary:meta.filterSummary||null});
}
async function enterExamFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen request failed:', err);
  }
}
async function beginPendingExam() {
  if(!pendingExam)return;
  const exam={...pendingExam,index:0,answers:{},visited:[0],marked:[],times:{},questionStartedAt:Date.now(),deadline:Date.now()+pendingExam.durationSeconds*1000};
  user.activeExam=exam;saveUser();pendingExam=null;dialogClose();await enterExamFullscreen();navigate('exam');
}
function currentExamQuestions() {
  const exam=user.activeExam;
  if(exam?.source==='made-easy')return madeEasyTests.get(exam.testId)?.questions||[];
  return (exam?.qids||[]).map(id=>questionById.get(id)).filter(Boolean);
}
function currentQuestion() { const qs=currentExamQuestions();return qs[user.activeExam?.index||0]; }
function answerExists(value) { return value!==undefined&&value!==null&&value!==''&&!(Array.isArray(value)&&!value.length); }
function answerStatus(index) {
  const e=user.activeExam,ans=e.answers[e.qids[index]],visited=e.visited.includes(index),marked=e.marked.includes(index),answered=answerExists(ans);
  if(marked&&answered)return 'answered-review';if(marked)return 'review';if(answered)return 'answered';if(visited)return 'not-answered';return 'not-visited';
}
function recordElapsedTime(e) {
  if(!e?.questionStartedAt)return;
  const qid=e.qids[e.index];if(qid){const elapsed=Math.max(0,(Date.now()-e.questionStartedAt)/1000);e.times[qid]=Math.round(((e.times[qid]||0)+elapsed)*10)/10;}
  e.questionStartedAt=0;
}
function recordVisit(nextIndex) {
  const e=user.activeExam;if(!e)return;
  recordElapsedTime(e);e.index=nextIndex;e.questionStartedAt=Date.now();if(!e.visited.includes(nextIndex))e.visited.push(nextIndex);saveUser();
}
function renderRich(html,q,asOption=false,imageRefs=null) {
  if(!html)return '';
  const parsed=new DOMParser().parseFromString(`<div>${html}</div>`,'text/html');
  const host=parsed.body.firstElementChild;
  // A few scraped records retain source TeX as [latex]...[/latex] instead of
  // the KaTeX HTML used by most records. Typeset those fragments through the
  // same local KaTeX version before sanitizing the resulting markup.
  if(window.katex){
    const walker=parsed.createTreeWalker(host,NodeFilter.SHOW_TEXT);const textNodes=[];
    while(walker.nextNode())if(/\[latex\]/i.test(walker.currentNode.nodeValue))textNodes.push(walker.currentNode);
    for(const textNode of textNodes){
      const parts=textNode.nodeValue.split(/(\[latex\][\s\S]*?\[\/latex\])/ig);const fragment=parsed.createDocumentFragment();
      for(const part of parts){const match=part.match(/^\[latex\]([\s\S]*?)\[\/latex\]$/i);
        if(!match){fragment.append(parsed.createTextNode(part));continue;}
        const source=match[1].replace(/&amp;/g,'&');let rendered;
        try{rendered=window.katex.renderToString(source,{displayMode:true,throwOnError:false,strict:'ignore'});}catch{rendered=esc(source);}
        const wrapper=parsed.createElement('span');wrapper.innerHTML=rendered;fragment.append(wrapper);
      }
      textNode.replaceWith(fragment);
    }
  }
  const allowed=new Set(['SPAN','DIV','P','BR','B','STRONG','I','EM','SUB','SUP','UL','OL','LI','TABLE','TBODY','THEAD','TR','TD','TH','MATH','SEMANTICS','MROW','MI','MN','MO','MSUP','MSUB','MFRAC','MSQRT','MROOT','MSTYLE','MTEXT','MOVER','MUNDER','MSPACE','ANNOTATION','IMG']);
  const nodes=[...host.querySelectorAll('*')];let imageIndex=0;
  for(const el of nodes){
    if(!el.isConnected)continue;
    if(!allowed.has(el.tagName)){if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','NOSCRIPT'].includes(el.tagName))el.remove();else el.replaceWith(...el.childNodes);continue;}
    for(const attr of [...el.attributes]){
      if(attr.name==='class'){if(!/^[\w\s-]*$/.test(attr.value))el.removeAttribute(attr.name);continue;}
      if(attr.name==='style'){
        // Scraped questions contain KaTeX's positioned fraction/radical layout.
        // Preserve its trusted static inline geometry; other inline styles remain stripped.
        if(!el.closest('.katex')||/url\s*\(|expression|javascript:|@import|[<>]/i.test(attr.value))el.removeAttribute(attr.name);
        continue;
      }
      if(attr.name.startsWith('aria-'))continue;
      if(el.tagName==='IMG'&&['alt','width','height'].includes(attr.name))continue;
      if(el.tagName==='MATH'&&attr.name==='xmlns')continue;
      if(el.tagName==='ANNOTATION'&&attr.name==='encoding')continue;
      el.removeAttribute(attr.name);
    }
    if(el.tagName==='IMG'){
      const ref=(imageRefs||(q.images||[]))[imageIndex++];
      const src=ref?.localPath?`/${ref.localPath.replace(/^\//,'')}`:ref?.url;
      if(!src||(!src.startsWith('/')&&!src.startsWith('https://')))el.remove();else{el.setAttribute('src',src);el.setAttribute('loading','lazy');el.setAttribute('alt',ref.altText||'Question figure');}
    }
  }
  return host.innerHTML;
}
function renderQuestionContent(q) {
  const html=q.questionMarkup||'';
  return html?renderRich(html,q):`<div>${esc(q.questionText||'Question text unavailable').replace(/\n/g,'<br>')}</div>`;
}
function negativeMark(q) { return q.negativeMarks!==undefined?num(q.negativeMarks):(q.type==='MCQ'?num(q.marks)/3:0); }
function renderExam() {
  const e=user.activeExam,qs=currentExamQuestions(),q=currentQuestion();
  if(!e||!q){view='home';renderHome();return;}
  const paletteScrollTop=app.querySelector('.question-palette')?.scrollTop||0;
  const statusCounts={'answered':0,'not-answered':0,'not-visited':0,'review':0,'answered-review':0};
  qs.forEach((_,i)=>statusCounts[answerStatus(i)]++);
  const answer=e.answers[q.id];const type=q.type;
  const options=(q.options||[]).map(o=>{
    const selected=type==='MSQ'?Array.isArray(answer)&&answer.includes(o.key):answer===o.key;
    const inputType=type==='MSQ'?'checkbox':'radio';
    return `<label class="answer-option"><input type="${inputType}" class="answer-input" name="answer" value="${esc(o.key)}" ${selected?'checked':''}><span><strong>${esc(o.key)}.</strong> ${renderRich(o.html||esc(o.text||''),q,true,o.images?.length?o.images:q.images||[])}</span></label>`;
  }).join('');
  const isNat=type==='NAT';
  const negative=negativeMark(q);
  app.innerHTML=`${header()}<main class="exam-page"><section class="exam-workspace"><div class="exam-ribbon"><strong>${esc(e.title)}</strong><div class="exam-ribbon-actions"><button data-action="instructions"><span class="exam-ribbon-icon exam-ribbon-info-icon" aria-hidden="true">i</span>Instructions</button><button data-action="paper"><span class="exam-ribbon-icon exam-ribbon-paper-icon" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M4 2.5h6l2 2v9H4z"/><path d="M10 2.5v2h2M6 7h4M6 9h4M6 11h3"/></svg></span>Question Paper</button></div></div><div class="exam-row"><button class="exam-chevron" aria-label="Previous subject">◀</button><span class="exam-chip">${esc(e.subject||q.subject)}</span><button class="exam-chevron">▶</button><button class="exam-chevron push calculator-trigger" data-action="calculator" title="Calculator" aria-label="Open calculator"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="2.5" width="15" height="19" rx="2"/><path d="M8 6.5h8v4H8zM8 14h1m3 0h1m3 0h1M8 17.5h1m3 0h1m3 0h1"/></svg></button></div><div class="section-label-row"><strong>Sections</strong><span class="time-label">Time Left : <b id="timerValue">${fmtTime(Math.max(0,(e.deadline-Date.now())/1000))}</b></span></div><div class="exam-row section-row-small"><button class="exam-chevron">◀</button><span class="exam-chip secondary">${esc(e.topic||q.topic||'GATE CE PYQ')}</span><button class="exam-chevron push">▶</button></div><div class="exam-meta"><span>Question Type: <b>${esc(type)}</b></span><span>Marks for correct answer: <b class="green">${num(q.marks)}</b> | Negative Marks: <b class="red">${negative?negative.toFixed(2):'0'}</b></span></div><article class="question-card"><div class="question-card-title">Question No. ${q.questionNo??e.index+1}<button class="report-question-button" data-action="report-question" data-id="${esc(q.id)}" title="Report an issue" aria-label="Report question"><span aria-hidden="true">⚠</span><small>Report</small></button><span class="question-context">${q.year} ${q.session?`· ${esc(q.session)}`:''}</span></div><div class="question-body question-markup">${renderQuestionContent(q)}${q.sourceUrl?`<div class="question-source">(GATE CE ${q.year})</div>`:''}</div>${isNat?`<div class="nat-answer"><label for="natResponse">Your answer</label><input id="natResponse" class="answer-input nat-input" inputmode="decimal" type="text" value="${esc(answer??'')}" placeholder="Enter numerical value" autocomplete="off"></div>${q.answerStatus==='pending'?'<div class="nat-note">Answer key pending verification. Your response will be saved and excluded from scoring.</div>':''}`:`<fieldset class="answer-options" aria-label="Answer options">${options}</fieldset>`}</article><div class="exam-actions"><div class="action-group"><button class="outline-button" data-action="mark-next">Mark for Review &amp; Next</button><button class="outline-button" data-action="clear-answer">Clear Response</button></div><div class="action-group"><button class="outline-button" data-action="previous" ${e.index===0?'disabled':''}>Previous</button><button class="primary-button" data-action="next">Save &amp; Next</button></div></div></section><aside class="candidate-panel">${candidateBlock()}<div class="status-legend"><div class="status-item"><i class="status-badge answered">${statusCounts.answered}</i> Answered</div><div class="status-item"><i class="status-badge not-answered">${statusCounts['not-answered']}</i> Not Answered</div><div class="status-item"><i class="status-badge not-visited">${statusCounts['not-visited']}</i> Not Visited</div><div class="status-item"><i class="status-badge review">${statusCounts.review}</i> Marked for Review</div><div class="status-item wide"><i class="status-badge answered-review">${statusCounts['answered-review']}</i> Answered &amp; Marked for Review</div></div><div class="palette-title">${esc(e.topic||q.topic||'GATE CE PYQ')}</div><div class="palette-label">Choose a Question</div><div class="question-palette">${qs.map((item,i)=>`<button class="palette-button ${answerStatus(i)} ${i===e.index?'current':''}" data-action="jump" data-index="${i}" aria-label="Question ${i+1}: ${answerStatus(i)}">${i+1}</button>`).join('')}</div><div class="submit-dock"><button class="primary-button" data-action="submit">Submit</button></div></aside></main>`;
  const palette=app.querySelector('.question-palette');
  if(palette)palette.scrollTop=paletteScrollTop;
}
function startTimer() {
  timerHandle=setInterval(()=>{const e=user.activeExam;if(!e)return;const remaining=Math.ceil((e.deadline-Date.now())/1000);const label=$('timerValue');if(label){label.textContent=fmtTime(remaining);label.classList.toggle('red',remaining<300);}if(remaining<=0){clearInterval(timerHandle);submitExam(true);}},1000);
}
function updateCurrentAnswer(input) {
  const e=user.activeExam,q=currentQuestion();if(!e||!q)return;
  if(q.type==='NAT')e.answers[q.id]=input.value.trim();
  else if(q.type==='MSQ')e.answers[q.id]=[...app.querySelectorAll('.answer-input:checked')].map(el=>el.value).sort();
  else e.answers[q.id]=input.value;
  saveUser();
  const i=e.index;const button=app.querySelector(`.palette-button[data-index="${i}"]`);if(button)button.className=`palette-button ${answerStatus(i)} current`;
  const counts={'answered':0,'not-answered':0,'not-visited':0,'review':0,'answered-review':0};e.qids.forEach((_,j)=>counts[answerStatus(j)]++);
  const badges=app.querySelectorAll('.status-badge');const vals=[counts.answered,counts['not-answered'],counts['not-visited'],counts.review,counts['answered-review']];badges.forEach((el,j)=>el.textContent=vals[j]);
}
function moveQuestion(next,mark=false) {
  const e=user.activeExam;if(!e)return;
  if(mark&&!e.marked.includes(e.index))e.marked.push(e.index);
  const target=Math.max(0,Math.min(e.qids.length-1,next));recordVisit(target);if(next>=e.qids.length)submitExam(false);else render();
}
function openSubmitConfirmation(expired=false) {
  const e=user.activeExam,qs=currentExamQuestions();let answered=0,marked=0;
  recordElapsedTime(e);saveUser();
  qs.forEach((q,i)=>{if(answerExists(e.answers[q.id]))answered++;if(e.marked.includes(i))marked++;});
  dialogShow(expired?'Time is up':'Submit your answers?',`<p>${expired?'Your time has ended.':'Are you sure you want to submit this practice exam?'}</p><div class="metric-grid"><div class="metric"><strong>${answered}</strong><small>Answered</small></div><div class="metric"><strong>${qs.length-answered}</strong><small>Not answered</small></div><div class="metric"><strong>${marked}</strong><small>Marked for review</small></div><div class="metric"><strong>${qs.length-e.visited.length}</strong><small>Not visited</small></div></div>`,`<button class="outline-button" data-dialog="close">Continue exam</button><button class="primary-button" data-dialog="confirm-submit">Submit</button>`);
}
function scoreQuestion(q,answer) {
  if(!answerExists(answer))return {status:'unanswered',score:0};
  if(q.answerStatus==='pending'&&user.answerOverrides[q.id]===undefined)return {status:'pending',score:0};
  let correct=false;
  if(q.type==='NAT'){
    const key=user.answerOverrides[q.id]??q.natAnswer;
    if(key===null||key===undefined)return {status:'pending',score:0};
    const value=num(answer);
    if(typeof key==='object'){
      if(key.all===true)correct=true;
      else if(key.min!==undefined&&key.max!==undefined)correct=value>=num(key.min)&&value<=num(key.max);
      else if(key.value!==undefined)correct=Math.abs(value-num(key.value))<=num(key.tolerance);
      else return {status:'pending',score:0};
    }else correct=Math.abs(value-num(key))<1e-9;
  } else {
    const answerSet=(Array.isArray(answer)?answer:[answer]).map(String).sort();
    const keySet=(q.correctAnswer||[]).map(String).sort();
    if(!keySet.length)return {status:'pending',score:0};
    correct=answerSet.length===keySet.length&&answerSet.every((key,i)=>key===keySet[i]);
  }
  if(correct)return {status:'correct',score:num(q.marks)};
  return {status:'incorrect',score:q.type==='MCQ'?-negativeMark(q):0};
}
function submitExam(expired=false) { openSubmitConfirmation(expired); }
function finalizeExam() {
  const e=user.activeExam;if(!e)return;
  recordElapsedTime(e);
  const qs=currentExamQuestions();let correct=0,incorrect=0,unanswered=0,pending=0,earned=0,negative=0;
  const evaluations={};
  for(const q of qs){const answer=e.answers[q.id];const grade=scoreQuestion(q,answer);evaluations[q.id]=grade;if(grade.status==='correct'){correct++;earned+=grade.score;}else if(grade.status==='incorrect'){incorrect++;negative+=Math.abs(grade.score);}else if(grade.status==='unanswered')unanswered++;else pending++;}
  const attempt={id:`result-${Date.now()}`,title:e.title,subject:e.subject,topic:e.topic,year:e.year,session:e.session,source:e.source||null,testId:e.testId||null,questionIds:[...e.qids],answers:{...e.answers},evaluations,endedAt:Date.now(),durationSeconds:e.durationSeconds,remainingSeconds:Math.max(0,Math.ceil((e.deadline-Date.now())/1000)),totalMarks:qs.reduce((n,q)=>n+num(q.marks),0),earned,negative,score:earned-negative,correct,incorrect,unanswered,pending,times:{...e.times},visited:[...e.visited]};
  user.history.unshift(attempt);user.history=user.history.slice(0,150);user.activeExam=null;saveUser();activeResult=attempt.id;dialogClose();navigate('results',{result:attempt.id});
  if(window.SupaAuth?.user())SupaAuth.saveTestAttempt(attempt).then(()=>SupaAuth.saveCloudState(user)).catch(e=>console.warn('[CloudSync] test attempt save error',e));
}
function answerLabel(q,value) {
  if(!answerExists(value))return 'Not attempted';
  if(q.type==='NAT')return String(value);
  const keys=Array.isArray(value)?value:[value];return keys.map(k=>{const option=(q.options||[]).find(o=>o.key===k);return `${k}${option?.text?`. ${option.text}`:''}`;}).join(', ');
}
function natKeyLabel(key) {
  if(key===null||key===undefined)return 'Pending';
  if(typeof key==='object'){
    if(key.all===true)return 'Marks to all';
    if(key.min!==undefined&&key.max!==undefined)return `${key.min} to ${key.max}`;
    if(key.value!==undefined)return String(key.value);
  }
  return String(key);
}
function reviewCard(q,attempt,grade,index) {
  const answer=attempt?.answers?.[q.id];const status=grade?.status||'unanswered';
  const elapsed=num(attempt?.times?.[q.id]);const questionWasVisited=Array.isArray(attempt?.visited)?attempt.visited.includes(index):elapsed>0;
  const statusText={correct:'CORRECT',incorrect:'INCORRECT',unanswered:'UNANSWERED',pending:'ANSWER KEY PENDING'}[status]||status.toUpperCase();
  const keySet=(q.correctAnswer||[]).map(String);
  const selected=Array.isArray(answer)?answer.map(String):answer===undefined?[]:[String(answer)];
  const options=q.type==='NAT'?'':`<div class="review-options">${(q.options||[]).map(o=>{const isCorrect=keySet.includes(String(o.key));const isSelected=selected.includes(String(o.key));let cls=isCorrect?'correct':isSelected&&status==='incorrect'?'selected-wrong':'';return `<div class="review-option ${cls}">${isCorrect?'✓ ':isSelected&&status==='incorrect'?'× ':''}<strong>${esc(o.key)}.</strong> ${renderRich(o.html||esc(o.text||''),q,true,o.images?.length?o.images:q.images||[])}</div>`;}).join('')}</div>`;
  const keyPending=status==='pending';const explanation=q.explanationHtml?renderRich(q.explanationHtml,q,false,q.explanationImages||[]):esc(q.explanationText||'No explanation has been provided for this question.');
  const verifiedAnswer=q.type==='NAT'?natKeyLabel(user.answerOverrides[q.id]??q.natAnswer):answerLabel(q,keySet);
  return `<article class="surface review-card ${status}" data-review-status="${esc(status)}" id="review-${esc(q.id)}"><div class="review-card-head"><strong>Question ${esc(q.questionNo??index+1)} (${esc(q.type)})</strong><span>🗓 ${esc(q.year)}${q.session?` · ${esc(q.session)}`:''}</span><span class="review-topic">▦ ${esc(q.topic||attempt?.topic||q.subject||'Uncategorized')}</span><span>⏱ ${questionWasVisited?fmtDuration(elapsed):'Not visited'}</span><span>+${num(q.marks).toFixed(2)} marks</span><span class="question-status ${status}">${statusText}</span><button class="report-question-button" data-action="report-question" data-id="${esc(q.id)}" title="Report a question or answer-key issue" aria-label="Report question"><span aria-hidden="true">⚠</span><small>Report</small></button></div><div class="review-question question-markup">${renderQuestionContent(q)}</div>${options}<div class="review-note"><strong>Your answer:</strong> ${esc(answerLabel(q,answer))}<br><strong>${keyPending?'Verified answer:':'Correct answer:'}</strong> ${keyPending?'Pending verification':esc(verifiedAnswer)}</div><div class="review-actions"><button data-action="toggle-bookmark" data-id="${esc(q.id)}">${user.bookmarks.includes(q.id)?'📌 Bookmarked':'📌 Bookmark'}</button><button data-action="toggle-mistake" data-id="${esc(q.id)}">${user.mistakes.includes(q.id)?'🤦 Mistake recorded':'🤦 Silly mistake'}</button><button data-action="toggle-explanation" data-id="${esc(q.id)}">📖 ${q.explanationHtml||q.explanationText?'View explanation':'Explanation unavailable'}</button><button data-action="edit-note" data-id="${esc(q.id)}">📝 Notes</button></div><div class="review-explanation hidden" id="explanation-${esc(q.id)}">${explanation}</div><div class="review-explanation hidden" id="note-${esc(q.id)}"><textarea class="form-control question-note" data-id="${esc(q.id)}" placeholder="Add a note for this question…" style="width:100%">${esc(user.questionNotes?.[q.id]||'')}</textarea><button class="small-action" data-action="save-question-note" data-id="${esc(q.id)}">Save note</button></div></article>`;
}
function questionTimingChart(qs,attempt) {
  const rows=qs.map((q,i)=>{const seconds=Math.max(0,num(attempt.times?.[q.id])),index=attempt.questionIds.indexOf(q.id);const visited=Array.isArray(attempt.visited)?attempt.visited.includes(index):seconds>0;return {q,i,seconds,visited,status:attempt.evaluations[q.id]?.status||'unanswered'};});
  const observed=rows.filter(r=>r.visited),maxObserved=Math.max(0,...observed.map(r=>r.seconds));
  if(!observed.length)return `<div class="time-chart-empty">No per-question timing was recorded for this attempt.</div>`;
  const step=maxObserved<=20?5:maxObserved<=60?15:maxObserved<=180?30:maxObserved<=600?120:maxObserved<=1800?300:600;
  const maxTime=Math.max(step,Math.ceil(maxObserved/step)*step),W=760,H=300,L=62,R=20,T=20,B=50,plotW=W-L-R,plotH=H-T-B;
  const yLabel=v=>v<60?`${v}s`:v%60===0?`${v/60}m`:`${Math.round(v/60*10)/10}m`;
  const grid=Array.from({length:5},(_,i)=>{const value=maxTime*i/4,y=T+plotH-plotH*i/4;return `<line x1="${L}" y1="${y}" x2="${W-R}" y2="${y}" class="time-gridline"/><text x="${L-10}" y="${y+4}" class="time-axis-label" text-anchor="end">${yLabel(value)}</text>`}).join('');
  const maxQuestion=Math.max(1,qs.length),xTicks=[...new Set([1,Math.ceil(maxQuestion/4),Math.ceil(maxQuestion/2),Math.ceil(maxQuestion*3/4),maxQuestion])];
  const xAxis=xTicks.map(n=>{const x=L+(n-1)/Math.max(1,maxQuestion-1)*plotW;return `<line x1="${x}" y1="${T+plotH}" x2="${x}" y2="${T+plotH+4}" class="time-tick"/><text x="${x}" y="${H-28}" class="time-axis-label" text-anchor="middle">${n}</text>`}).join('');
  const points=observed.map(({q,i,seconds,status})=>{const x=L+i/Math.max(1,maxQuestion-1)*plotW,y=T+plotH-seconds/maxTime*plotH;const label=`Question ${q.questionNo??i+1} · ${q.topic||q.subject||'Uncategorized'} · ${fmtDuration(seconds)} · ${status}`;return `<circle cx="${x}" cy="${y}" r="5" class="time-point ${status}" tabindex="0"><title>${esc(label)}</title></circle>`}).join('');
  const average=observed.reduce((sum,r)=>sum+r.seconds,0)/observed.length;
  return `<div class="time-chart"><div class="time-chart-legend"><span><i class="correct"></i>Correct</span><span><i class="incorrect"></i>Incorrect</span><span><i class="unanswered"></i>Unanswered</span><span><i class="pending"></i>Key pending</span><span class="time-average">Average ${fmtDuration(average)} · ${observed.length} visited</span></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Time spent on each visited question, by question number. Average ${fmtDuration(average)} across ${observed.length} visited questions.">${grid}<line x1="${L}" y1="${T}" x2="${L}" y2="${T+plotH}" class="time-axis"/><line x1="${L}" y1="${T+plotH}" x2="${W-R}" y2="${T+plotH}" class="time-axis"/>${xAxis}${points}<text x="${L+plotW/2}" y="${H-5}" class="time-axis-title" text-anchor="middle">Question number</text><text x="17" y="${T+plotH/2}" class="time-axis-title" text-anchor="middle" transform="rotate(-90 17 ${T+plotH/2})">Time spent</text></svg><p class="time-chart-footnote">Only questions you visited are plotted.</p></div>`;
}
function applyReviewFilter() {
  const cards=[...app.querySelectorAll('.review-card[data-review-status]')];
  let visible=0;
  for(const card of cards){
    const show=reviewFilter==='all'||card.dataset.reviewStatus===reviewFilter;
    card.classList.toggle('hidden',!show);
    if(show)visible++;
  }
  const count=$('reviewCount');if(count)count.textContent=`${visible} of ${cards.length}`;
  const empty=$('reviewFilterEmpty');if(empty)empty.classList.toggle('hidden',visible!==0);
  const trigger=$('reviewFilterTrigger');
  if(trigger){
    const selected=app.querySelector(`[data-review-filter-option="${reviewFilter}"]`);
    trigger.querySelector('.review-filter-value').textContent=selected?.textContent||'All questions';
    app.querySelectorAll('[data-review-filter-option]').forEach(option=>option.setAttribute('aria-selected',String(option.dataset.reviewFilterOption===reviewFilter)));
  }
}
function renderResult() {
  const attempt=user.history.find(a=>a.id===activeResult)||user.history[0];
  if(!attempt){view='home';renderHome();return;}
  activeResult=attempt.id;
  const qs=attempt.questionIds.map(id=>questionById.get(id)).filter(Boolean);
  const total=attempt.totalMarks||qs.reduce((n,q)=>n+num(q.marks),0);
  const pct=total?Math.max(0,attempt.score/total*100):0;
  const notCaptured=Math.max(0,total-attempt.earned);
  const net=attempt.score;
  let earnedWidth=total?attempt.earned/total*100:0,negativeWidth=total?attempt.negative/total*100:0,pendingWidth=total?Math.max(0,100-earnedWidth-negativeWidth):0;
  const filters=['all','correct','incorrect','unanswered','pending'];
  const filteredCount=qs.filter(q=>reviewFilter==='all'||attempt.evaluations[q.id]?.status===reviewFilter).length;
  app.innerHTML=`${header()}<main class="page"><section class="surface result-top"><h1 class="result-title">📊 ${esc(attempt.title)} Result</h1><div class="result-actions"><button class="outline-button" data-action="retry-mistakes" data-result="${esc(attempt.id)}">🔄 Retry mistakes</button><button class="outline-button" data-action="retry-unanswered" data-result="${esc(attempt.id)}">⏭ Retry unanswered</button><button class="outline-button" data-action="go" data-view="bookmarks">📌 Bookmarks</button><button class="outline-button" data-action="go" data-view="mistakes">🤦 Silly mistakes</button><button class="primary-button" data-action="go" data-view="home">＋ New exam</button></div><div class="result-score-grid"><section class="score-panel"><div class="score-box"><strong>${net.toFixed(2)} / ${total.toFixed(2)}</strong><span>Total marks</span></div><div class="score-box highlight"><strong>${pct.toFixed(2)}%</strong><span>Score percentage</span></div><div class="score-box small good"><strong>${attempt.correct}</strong><span>Correct</span></div><div class="score-box small bad"><strong>${attempt.incorrect}</strong><span>Incorrect</span></div><div class="score-box small pending"><strong>${attempt.unanswered}</strong><span>Unanswered</span></div><div class="score-box small pending"><strong>${attempt.pending}</strong><span>Answer key pending</span></div></section><div class="donut-panel"><div class="donut" style="background:conic-gradient(#67b66d 0 ${qs.length?attempt.correct/qs.length*100:0}%,#d85757 ${qs.length?attempt.correct/qs.length*100:0}% ${qs.length?(attempt.correct+attempt.incorrect)/qs.length*100:0}%,#eca948 ${qs.length?(attempt.correct+attempt.incorrect)/qs.length*100:0}% 100%)"></div></div></div><section class="result-section"><h2>💰 Marks breakdown</h2><div class="metric-grid"><div class="metric"><strong>+${attempt.earned.toFixed(2)}</strong><small>Marks earned</small></div><div class="metric"><strong>−${attempt.negative.toFixed(2)}</strong><small>Negative marks</small></div><div class="metric"><strong>${net.toFixed(2)}</strong><small>Net score (of ${total.toFixed(2)})</small></div><div class="metric"><strong>${notCaptured.toFixed(2)}</strong><small>Marks not captured</small></div></div><div class="breakdown-bars"><i class="bar-earned" style="width:${earnedWidth}%"></i><i class="bar-negative" style="width:${negativeWidth}%"></i><i class="bar-pending" style="width:${pendingWidth}%"></i></div><div class="legend-inline"><span>● Earned (${earnedWidth.toFixed(1)}%)</span><span>● Lost to negatives (${negativeWidth.toFixed(1)}%)</span><span>● Not captured (${pendingWidth.toFixed(1)}%)</span></div></section><section class="result-section"><h2>⏱ Time spent per question</h2><p class="muted" style="font-size:11px">Each point shows the time recorded for that question. Color indicates the result.</p>${questionTimingChart(qs,attempt)}</section><div class="review-toolbar"><h2>Question by question review <span class="muted" id="reviewCount">${filteredCount} of ${qs.length}</span></h2><div class="review-filter"><button id="reviewFilterTrigger" class="review-filter-trigger" type="button" aria-label="Filter results" aria-haspopup="listbox" aria-expanded="false" data-action="toggle-review-filter"><span class="review-filter-value">All questions</span><span aria-hidden="true">▾</span></button><div class="review-filter-menu" id="reviewFilterMenu" role="listbox" aria-label="Filter results" hidden>${[['all','All questions'],['correct','Correct'],['incorrect','Incorrect'],['unanswered','Unanswered'],['pending','Answer key pending']].map(([value,label])=>`<button type="button" role="option" class="review-filter-option" data-action="set-review-filter" data-review-filter-option="${value}" aria-selected="${reviewFilter===value}">${label}</button>`).join('')}</div></div></div><section class="review-list">${qs.map(q=>reviewCard(q,attempt,attempt.evaluations[q.id],attempt.questionIds.indexOf(q.id))).join('')}<div class="surface empty-state ${filteredCount?'hidden':''}" id="reviewFilterEmpty"><strong>No matching questions</strong>Change the result filter to see more.</div></section></section></main>`;
  applyReviewFilter();
}
function analyticsTrendChart(attempts) {
  const recent=attempts.slice(0,8).reverse();
  const W=680,H=240,L=42,R=16,T=18,B=38,plotW=W-L-R,plotH=H-T-B;
  const pts=recent.map((a,i)=>({a,x:L+(recent.length===1?plotW/2:i*plotW/(recent.length-1)),y:T+plotH-(Math.max(0,Math.min(100,a.totalMarks?num(a.score)/num(a.totalMarks)*100:0))/100)*plotH}));
  const grid=[0,25,50,75,100].map(v=>{const y=T+plotH-v*plotH/100;return `<line x1="${L}" y1="${y}" x2="${W-R}" y2="${y}" class="chart-gridline"/><text x="${L-9}" y="${y+4}" text-anchor="end" class="chart-label">${v}%</text>`}).join('');
  const line=pts.length>1?`<polyline points="${pts.map(p=>`${p.x},${p.y}`).join(' ')}" class="trend-line"/>`:'';
  const dots=pts.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="5" class="trend-point"><title>${esc(p.a.title)}: ${p.a.totalMarks?Math.round(num(p.a.score)/num(p.a.totalMarks)*100):0}%</title></circle><text x="${p.x}" y="${H-12}" text-anchor="middle" class="chart-label">${esc(new Date(p.a.endedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'}))}</text>`).join('');
  return `<svg class="analytics-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score percentage across recent practice sets">${grid}${line}${dots}</svg>`;
}
function outcomeChart(attempts) {
  const recent=attempts.slice(0,6).reverse(),W=680,H=220,L=38,R=14,T=14,B=42,plotH=H-T-B;
  const max=Math.max(1,...recent.map(a=>num(a.correct)+num(a.incorrect)+num(a.unanswered)));
  const slot=(W-L-R)/Math.max(1,recent.length),barW=Math.min(40,slot*.54);
  const bars=recent.map((a,i)=>{const x=L+i*slot+(slot-barW)/2;let y=T+plotH;const segs=[['correct',num(a.correct)],['incorrect',num(a.incorrect)],['unanswered',num(a.unanswered)]];const rects=segs.map(([cls,n])=>{const h=n/max*plotH;y-=h;return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${h>5?3:0}" class="outcome-${cls}"><title>${cls}: ${n}</title></rect>`}).join('');return `${rects}<text x="${x+barW/2}" y="${H-13}" text-anchor="middle" class="chart-label">${esc(new Date(a.endedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'}))}</text>`}).join('');
  return `<svg class="analytics-chart-svg outcome-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Correct, incorrect and unanswered questions across recent practice sets"><line x1="${L}" y1="${T+plotH}" x2="${W-R}" y2="${T+plotH}" class="chart-gridline"/>${bars}</svg>`;
}
function renderAnalytics() {
  const attempts=user.history;const totalAnswered=attempts.reduce((n,a)=>n+a.correct+a.incorrect,0);const correct=attempts.reduce((n,a)=>n+a.correct,0);const score=attempts.reduce((n,a)=>n+a.score,0);const subjectsSeen=new Map();
  for(const a of attempts)for(const id of a.questionIds){const q=questionById.get(id);if(!q)continue;const item=subjectsSeen.get(q.subject)||{right:0,total:0};const g=a.evaluations[id]?.status;if(g==='correct')item.right++;if(g==='correct'||g==='incorrect')item.total++;subjectsSeen.set(q.subject,item);}
  const ranked=[...subjectsSeen.entries()].sort((a,b)=>(b[1].right/(b[1].total||1))-(a[1].right/(a[1].total||1)));
  app.innerHTML=`${header()}<main class="page analytics-page"><section class="hero analytics-hero"><div class="eyebrow">YOUR PERFORMANCE</div><h1>Analytics dashboard</h1><p>Review your practice history and accuracy across subjects.</p></section>${attempts.length?`<div class="analytics-grid"><div class="surface analytics-card"><span class="analytics-card-icon">↗</span><strong>${attempts.length}</strong><small>Completed sets</small></div><div class="surface analytics-card"><span class="analytics-card-icon">✓</span><strong>${correct}<small class="metric-denominator"> / ${totalAnswered||0}</small></strong><small>Questions correct</small></div><div class="surface analytics-card"><span class="analytics-card-icon">✦</span><strong>${score.toFixed(2)}</strong><small>Total practice marks</small></div></div><div class="analytics-chart-grid"><section class="surface dashboard-card chart-card"><div class="chart-card-head"><div><span class="chart-kicker">SCORE TREND</span><h2 class="section-title">Practice performance</h2></div><span class="chart-caption">Last ${Math.min(8,attempts.length)} sets</span></div>${analyticsTrendChart(attempts)}</section><section class="surface dashboard-card chart-card"><div class="chart-card-head"><div><span class="chart-kicker">QUESTION BREAKDOWN</span><h2 class="section-title">Response mix</h2></div></div><div class="chart-legend"><span><i class="legend-correct"></i>Correct</span><span><i class="legend-incorrect"></i>Incorrect</span><span><i class="legend-unanswered"></i>Unanswered</span></div>${outcomeChart(attempts)}</section></div><section class="surface dashboard-card analytics-subjects"><div class="chart-card-head"><div><span class="chart-kicker">BY SUBJECT</span><h2 class="section-title">Subject accuracy</h2></div></div>${ranked.length?ranked.map(([name,v])=>{const pct=v.total?Math.round(v.right/v.total*100):0;return `<div class="progress-row"><span>${esc(name)}</span><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><strong>${pct}% <small>${v.right}/${v.total}</small></strong></div>`;}).join(''):`<p class="muted">Answer more questions to see subject accuracy.</p>`}</section><section class="surface dashboard-card analytics-recent"><div class="chart-card-head"><div><span class="chart-kicker">HISTORY</span><h2 class="section-title">Recent practice</h2></div><span class="chart-caption">${attempts.length} total sets</span></div>${attempts.slice(0,12).map(a=>`<div class="topic-table-row"><span>${esc(a.title)}</span><span>${dateLabel(a.endedAt)}</span><strong>${num(a.score).toFixed(2)} / ${num(a.totalMarks).toFixed(2)}</strong><button class="small-action" data-action="view-result" data-result="${esc(a.id)}">Review →</button><button class="small-action" data-action="rename-history" data-result="${esc(a.id)}">Rename</button><button class="history-delete-button" data-action="delete-history" data-result="${esc(a.id)}" title="Delete this test from history" aria-label="Delete ${esc(a.title)} from history">×</button></div>`).join('')}</section>`:`<section class="surface empty-state"><strong>No exam history yet</strong>Start a practice set to see your scores and subject accuracy here.<p><button class="primary-button" data-action="go" data-view="home">Browse questions</button></p></section>`}</main>`;
}
function currentPracticeStats() {
  const solved = new Set();
  for (const attempt of user.history || []) for (const [id, grade] of Object.entries(attempt.evaluations || {})) if (grade?.status && grade.status !== 'unanswered' && grade.status !== 'pending') solved.add(id);
  const days = new Set((user.history || []).map(a => new Date(a.endedAt).toLocaleDateString('en-CA')));
  let streak = 0, day = new Date();
  if (!days.has(day.toLocaleDateString('en-CA'))) day.setDate(day.getDate() - 1);
  while (days.has(day.toLocaleDateString('en-CA'))) { streak++; day.setDate(day.getDate() - 1); }
  return { solved: solved.size, tests: (user.history || []).length, streak };
}
function leaderboardMarkup(rows) {
  if (!rows.length) return '<p class="muted">No leaderboard entries yet.</p>';
  const person = (row, rank, podium = false) => `<article class="${podium ? `leaderboard-podium-item podium-rank-${rank}` : 'leaderboard-list-row'}${row.is_current_user ? ' is-current-user' : ''}"${row.is_current_user ? ' aria-current="true"' : ''}>${podium ? `<div class="podium-medal">${rank === 1 ? '👑' : rank === 2 ? '🥈' : '🥉'}</div>` : ''}<span class="leaderboard-list-rank">${rank}</span>${row.avatar_url ? `<img class="${podium ? 'leaderboard-podium-avatar' : ''}" src="${esc(row.avatar_url)}" alt="">` : `<span class="${podium ? 'leaderboard-podium-avatar ' : ''}leaderboard-avatar">👤</span>`}<span class="leaderboard-person"><strong>${esc(row.display_name || 'Candidate')}${row.is_current_user ? '<em>You</em>' : ''}</strong><span class="leaderboard-solved">${num(row.questions_solved).toLocaleString()} <small>questions solved</small></span><span class="leaderboard-streak">🔥 ${num(row.streak_days)} day${num(row.streak_days) === 1 ? '' : 's'}</span></span>${podium ? `<div class="podium-step"><b>#${rank}</b></div>` : ''}</article>`;
  const podiumOrder = rows.length < 3
    ? rows.map((row, index) => ({ row, rank: index + 1 }))
    : [{ row: rows[1], rank: 2 }, { row: rows[0], rank: 1 }, { row: rows[2], rank: 3 }];
  const podium = podiumOrder.map(({ row, rank }) => person(row, rank, true)).join('');
  const rest = rows.slice(3).map(row => person(row, row.rank)).join('');
  return `${podium ? `<div class="leaderboard-podium podium-count-${podiumOrder.length}">${podium}</div>` : ''}${rest ? `<div class="leaderboard-list">${rest}</div>` : ''}`;
}
async function renderProfile() {
  if (!authUser) { app.innerHTML = `${header()}<main class="page home-page"><section class="surface empty-state"><strong>Sign in to view your profile</strong><button class="primary-button" data-action="auth-login">Sign in with Google</button></section></main>`; return; }
  const profile = SupaAuth.profile() || {}, stats = currentPracticeStats();
  app.innerHTML = `${header()}<main class="page home-page profile-page"><section class="hero home-hero profile-hero"><div class="eyebrow">YOUR ACCOUNT</div><h1>Your profile</h1><p>Track your practice and compare your progress with other learners.</p></section><section class="surface profile-editor dashboard-card"><div class="profile-photo-preview">${profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="Profile photo">` : '<span>👤</span>'}</div><div class="profile-editor-copy"><h2>${esc(profile.display_name || authUser.email || 'Candidate')}</h2><small>${esc(authUser.email || '')}</small><div class="profile-form-row"><label class="small-action" for="profilePhotoInput">Change photo</label><input id="profilePhotoInput" type="file" accept="image/*" hidden><input id="profileNameInput" class="form-control" maxlength="80" value="${esc(profile.display_name || '')}" placeholder="Your name"><button class="primary-button" data-action="save-profile">Save profile</button></div></div></section><section class="profile-stats-grid"><div class="surface dashboard-card profile-stat"><span class="profile-stat-icon">🔥</span><strong>${stats.streak}</strong><span>day streak</span></div><div class="surface dashboard-card profile-stat"><span class="profile-stat-icon">✓</span><strong>${stats.solved}</strong><span>questions solved</span></div><div class="surface dashboard-card profile-stat"><span class="profile-stat-icon">▤</span><strong>${stats.tests}</strong><span>tests taken</span></div></section><section class="surface leaderboard-card dashboard-card"><div class="home-section-heading leaderboard-heading"><div><h2>Leaderboard</h2><p>Ranked by questions solved, then tests taken. Your row is highlighted.</p></div><span class="leaderboard-trophy">🏆</span></div><div id="leaderboardRows" class="leaderboard-rows"><p class="muted">Loading leaderboard…</p></div></section><p class="muted profile-privacy-note">Leaderboard shows profile photos, names, solved-question counts, and streaks. Test history stays private.</p></main>`;
  try { const rows = await SupaAuth.loadLeaderboard(); const host = $('leaderboardRows'); if (host) host.innerHTML = leaderboardMarkup(rows); } catch (e) { const host = $('leaderboardRows'); if (host) host.innerHTML = '<p class="muted">Leaderboard is unavailable. Apply the latest Supabase migration.</p>'; }
}
function renderCollection(which) {
  const isBookmark=which==='bookmarks';const ids=isBookmark?user.bookmarks:user.mistakes;const items=ids.map(id=>questionById.get(id)).filter(Boolean).filter(q=>!collectionSearch||`${q.subject} ${q.topic} ${q.questionText} ${q.year}`.toLowerCase().includes(collectionSearch.toLowerCase()));
  const title=isBookmark?'Bookmarked questions':'Silly mistakes';
  app.innerHTML=`${header()}<main class="page"><section class="surface result-top"><h1 class="result-title">${isBookmark?'📌':'🤦'} ${title}</h1><div class="result-actions"><span class="muted">${ids.length} saved question${ids.length===1?'':'s'}</span><button class="outline-button" data-action="export-collection" data-kind="${which}">↧ Export JSON</button><button class="danger-button" data-action="clear-collection" data-kind="${which}">Clear all</button></div><div class="search-wrap"><span class="search-icon">⌕</span><input id="collectionSearch" class="search-input" value="${esc(collectionSearch)}" placeholder="Search saved questions…"></div></section><section class="review-list" style="margin-top:15px">${items.length?items.map(q=>{const prior=user.history.find(a=>a.answers&&a.answers[q.id]!==undefined);const grade=prior?.evaluations?.[q.id]||{status:q.answerStatus==='pending'?'pending':'unanswered'};return reviewCard(q,prior,grade,0);}).join(''):`<div class="surface empty-state"><strong>${isBookmark?'No bookmarked questions':'No mistakes recorded'}</strong>Save questions from a result review and they’ll appear here.</div>`}</section></main>`;
  $('collectionSearch').addEventListener('input',e=>{collectionSearch=e.target.value;const needle=collectionSearch.toLowerCase();app.querySelectorAll('.review-card').forEach(card=>{const q=questionById.get(card.id.replace('review-',''));card.classList.toggle('hidden',!`${q?.subject} ${q?.topic} ${q?.questionText} ${q?.year}`.toLowerCase().includes(needle));});});
}
function toggleSaved(kind,id) { const key=kind==='bookmark'?'bookmarks':'mistakes';if(user[key].includes(id))user[key]=user[key].filter(x=>x!==id);else user[key].push(id);saveUser();render(); }
function saveDownload(filename,data,type='application/json') {
  const blob=new Blob([JSON.stringify(data,null,2)],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function attemptById(id) { return user.history.find(a=>a.id===id); }
async function handleAction(action,el) {
  const subject=el.dataset.subject,topic=el.dataset.topic,year=el.dataset.year,session=el.dataset.session;
  if(action==='calendar-prev'||action==='calendar-next'){
    calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+(action==='calendar-prev'?-1:1),1);
    calendarSelectedDate='';const calendar=$('practiceCalendar');if(calendar)calendar.outerHTML=practiceCalendarHtml();return;
  }
  if(action==='calendar-select-day'){
    calendarSelectedDate=el.dataset.date||'';const calendar=$('practiceCalendar');if(calendar)calendar.outerHTML=practiceCalendarHtml();return;
  }
  if(action==='toggle-review-filter'){
    const menu=$('reviewFilterMenu'),trigger=$('reviewFilterTrigger');if(!menu||!trigger)return;
    menu.hidden=!menu.hidden;trigger.setAttribute('aria-expanded',String(!menu.hidden));
    if(!menu.hidden)menu.querySelector(`[data-review-filter-option="${reviewFilter}"]`)?.focus();return;
  }
  if(action==='set-review-filter'){
    reviewFilter=el.dataset.reviewFilterOption||'all';applyReviewFilter();return;
  }
  if(action==='go'){navigate(el.dataset.view);return;}
  if(action==='toggle-custom-subject'){
    const value=el.dataset.value||'';if(!value)return;
    customBuilder.subjects=toggleCustomChoice(customBuilder.subjects,value);
    customBuilder.topics=customBuilder.topics.filter(topic=>customAvailableTopics().includes(topic));
    renderCustom();return;
  }
  if(action==='toggle-custom-topic'){
    const value=el.dataset.value||'';if(!value)return;
    customBuilder.topics=toggleCustomChoice(customBuilder.topics,value);
    renderCustom();return;
  }
  if(action==='toggle-custom-type'){
    const value=el.dataset.value||'';if(!value)return;
    customBuilder.types=toggleCustomChoice(customBuilder.types,value);
    if(!customBuilder.types.length)customBuilder.types=['MCQ','MSQ','NAT'];
    renderCustom();return;
  }
  if(action==='custom-subjects-all'){customBuilder.subjects=[...subjects];renderCustom();return;}
  if(action==='custom-subjects-clear'){customBuilder.subjects=[];customBuilder.topics=[];renderCustom();return;}
  if(action==='custom-topics-all'){customBuilder.topics=[...customAvailableTopics()];renderCustom();return;}
  if(action==='custom-topics-clear'){customBuilder.topics=[];renderCustom();return;}
  if(action==='custom-types-all'||action==='custom-types-clear'){customBuilder.types=['MCQ','MSQ','NAT'];renderCustom();return;}
  if(action==='open-subject'){navigate('subject',{subject});return;}
  if(action==='open-topic'){navigate('topic',{topic});return;}
  if(action==='start-quick-practice'){
    const kind=el.dataset.kind,selection=app.querySelector(`.practice-select[data-kind="${kind}"]`)?.value;
    if(!selection){toast(`Choose a ${kind} first.`);return;}
    if(kind==='subject'){
      await ensureQuestionsForSubjects([selection]);
      const group=questions.filter(q=>q.subject===selection).sort(compareQuestions);
      prepareExam(group,`${selection} · All topics`,{subject:selection});return;
    }
    if(kind==='topic'){
      let pair;try{pair=JSON.parse(selection);}catch{return;}
      const [chosenSubject,chosenTopic]=pair;await ensureQuestionsForSubjects([chosenSubject]);const group=qsForTopic(chosenSubject,chosenTopic);
      const topicName=canonicalTopic(chosenSubject,chosenTopic);
      prepareExam(group,`${chosenSubject} · ${topicName}`,{subject:chosenSubject,topic:topicName});return;
    }
    if(kind==='year'){
      await ensureQuestionsForSubjects();
      const group=questions.filter(q=>String(q.year)===selection).sort((a,b)=>String(a.session||'').localeCompare(String(b.session||''))||num(a.questionNo)-num(b.questionNo));
      prepareExam(group,`GATE CE ${selection} · All sessions`,{year:Number(selection)});return;
    }
  }
  if(action==='start-made-easy-test'){
    try {
      const test=await loadMadeEasyTest(el.dataset.testId);
      prepareExam(test.questions, test.title, {source:'made-easy',testId:test.id,examLabel:test.examLabel,subject:'Civil Engineering',topic:test.group,durationSeconds:test.durationSeconds});
    } catch(error) { toast(error.message||'Could not open this Made Easy test.'); }
    return;
  }
  if(action==='practice-subject'){prepareExam(questions.filter(q=>q.subject===selectedSubject),`${selectedSubject} · All topics`,{subject:selectedSubject});return;}
  if(action==='practice-topic'){prepareExam(qsForTopic(selectedSubject,selectedTopic),`${selectedSubject} · ${selectedTopic}`,{subject:selectedSubject,topic:selectedTopic});return;}
  if(action==='practice-topic-year'){document.querySelector('.topic-table')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(action==='start-topic-year'){
    const group=qsForTopic(selectedSubject,selectedTopic).filter(q=>String(q.year)===String(year)&&(q.session||'Full year')===session);
    prepareExam(group,`${selectedSubject} · ${selectedTopic} · ${year} ${session==='Full year'?'':session}`.trim(),{subject:selectedSubject,topic:selectedTopic,year:Number(year),session});return;
  }
  if(action==='start-year'){
    const group=questions.filter(q=>String(q.year)===String(year)&&(q.session||'Full year')===session).sort((a,b)=>num(a.questionNo)-num(b.questionNo));
    prepareExam(group,`GATE CE ${year} · ${session}`,{year:Number(year),session});return;
  }
  if(action==='start-custom'){
    refreshCustomForm();
    const pool=customPool();
    if(!pool.length){toast('No questions match these filters.');return;}
    const requested=Math.max(1,Math.floor(num(customBuilder.count)||1));
    const durationMinutes=Math.max(1,Math.floor(num(customBuilder.durationMinutes)||1));
    const count=Math.min(requested,pool.length);
    const selected=[...pool];
    for(let i=selected.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[selected[i],selected[j]]=[selected[j],selected[i]];}
    selected.length=count;
    const title=customBuilder.title.trim()||`Custom test · ${count} questions`;
    const sourceLabel=({all:'Question bank',bookmarks:'Bookmarks',mistakes:'Mistakes'})[customBuilder.source]||'Question bank';
    prepareExam(selected,title,{
      customDurationSeconds:durationMinutes*60,
      filterSummary:{subjects:[...customBuilder.subjects],topics:[...customBuilder.topics],types:[...customBuilder.types],durationMinutes,sourceLabel}
    });return;
  }
 if(action==='resume'){if(user.activeExam){user.activeExam.questionStartedAt=Date.now();saveUser();}await ensureViewQuestions('exam');await enterExamFullscreen();view='exam';render();window.scrollTo(0,0);return;}
  if(action==='finish-later'){const e=user.activeExam;recordElapsedTime(e);saveUser();navigate('home');return;}
  if(action==='discard-exam'){dialogShow('Discard unfinished exam?','Your in-progress responses will be removed.','<button class="outline-button" data-dialog="close">Keep exam</button><button class="danger-button" data-dialog="discard-active">Discard exam</button>');return;}
  if(action==='start-topic'&&pendingExam){beginPendingExam();return;}
  if(action==='previous'){moveQuestion(user.activeExam.index-1);return;}
  if(action==='next'){moveQuestion(user.activeExam.index+1);return;}
  if(action==='mark-next'){moveQuestion(user.activeExam.index+1,true);return;}
  if(action==='jump'){moveQuestion(num(el.dataset.index));return;}
  if(action==='clear-answer'){const q=currentQuestion();delete user.activeExam.answers[q.id];saveUser();render();return;}
  if(action==='submit'){submitExam(false);return;}
  if(action==='instructions'){
    dialogShow('Instructions','<ol class="modal-list"><li>Choose one option for MCQ, all applicable options for MSQ, or type a number for NAT.</li><li>Save &amp; Next records your response. Mark for Review &amp; Next flags the question.</li><li>Use the palette to jump between questions. Unvisited and unanswered states are shown separately.</li><li>Answer keys marked pending are not scored until verified.</li><li>Your timer continues if you return to the home page; an unfinished attempt can be resumed.</li></ol>','<button class="primary-button" data-dialog="close">Got it</button>');return;
  }
  if(action==='paper'){
    const qs=currentExamQuestions();dialogShow('Question Paper',`<p>${countLabel(qs.length)} · ${qs.reduce((s,q)=>s+num(q.marks),0)} marks</p><ol class="modal-list">${qs.map((q,i)=>`<li>Q${i+1} · ${esc(q.year)} ${esc(q.session||'')} · ${esc(q.type)} · ${num(q.marks)} mark${num(q.marks)===1?'':'s'}</li>`).join('')}</ol>`,'<button class="primary-button" data-dialog="close">Close</button>');return;
  }
  if(action==='calculator'){
    showCalculator();return;
  }
  if(action==='retry-mistakes'||action==='retry-unanswered'){
    const a=attemptById(el.dataset.result),subset=a?.questionIds.filter(id=>action==='retry-mistakes'?user.mistakes.includes(id):a.evaluations[id]?.status==='unanswered');
    if(!subset?.length){toast(action==='retry-mistakes'?'No questions are marked as mistakes.':'No unanswered questions in this exam.');return;}
    prepareExam(subset.map(id=>questionById.get(id)).filter(Boolean),action==='retry-mistakes'?'Retry mistakes':'Retry unanswered');return;
  }
  if(action==='view-result'){navigate('results',{result:el.dataset.result});return;}
  if(action==='rename-history'){
    const attempt=user.history.find(item=>item.id===el.dataset.result);if(!attempt)return;
    dialogShow('Rename test',`<label>Test name<input id="renameTestTitle" class="form-control" type="text" maxlength="80" value="${esc(attempt.title)}"></label>`,`<button class="outline-button" data-dialog="close">Cancel</button><button class="primary-button" data-action="save-test-title" data-result="${esc(attempt.id)}">Save name</button>`);$('renameTestTitle')?.focus();$('renameTestTitle')?.select();return;
  }
  if(action==='save-test-title'){
    const attempt=user.history.find(item=>item.id===el.dataset.result),title=$('renameTestTitle')?.value.trim();if(!attempt)return;
    if(!title){toast('Enter a test name.');$('renameTestTitle')?.focus();return;}
    attempt.title=title.slice(0,80);saveUser();
    if(SupaAuth?.user())SupaAuth.saveTestAttempt(attempt).catch(error=>console.warn('[CloudSync] renamed test save error',error));
    dialogClose();render();toast('Test renamed.');return;
  }
  if(action==='delete-history'){
    const attempt=user.history.find(item=>item.id===el.dataset.result);if(!attempt)return;
    dialogShow('Delete this attempt?',`<p>Delete <strong>${esc(attempt.title)}</strong> and its saved answers and result from your practice history? This removes only this attempt from your account.</p>`,`<button class="outline-button" data-dialog="close">Keep attempt</button><button class="danger-button" data-action="confirm-delete-history" data-result="${esc(attempt.id)}">Delete attempt</button>`);return;
  }
  if(action==='confirm-delete-history'){
    const id=el.dataset.result,attempt=user.history.find(item=>item.id===id);if(!attempt)return;
    el.disabled=true;el.textContent='Removing…';
    try{
      if(SupaAuth?.user())await SupaAuth.deleteTestAttempt(id);
      user.history=user.history.filter(item=>item.id!==id);
      if(activeResult===id){activeResult=user.history[0]?.id||null;view='home';history.replaceState({},'','#home');}
      saveUser();dialogClose();render();toast('Test removed from history.');
    }catch(error){el.disabled=false;el.textContent='Delete attempt';toast(/delete_own_test_attempt|schema cache|Could not find the function/i.test(error.message||'')?'History deletion is not enabled in Supabase yet. Run the updated supabase-profile-cloud-reports-migration.sql in the SQL Editor, then retry.':(error.message||'Could not delete attempt.'));}
    return;
  }
  if(action==='toggle-bookmark'){toggleSaved('bookmark',el.dataset.id);return;}
  if(action==='toggle-mistake'){toggleSaved('mistake',el.dataset.id);return;}
  if(action==='toggle-explanation'){const box=$(`explanation-${CSS.escape(el.dataset.id)}`);if(box)box.classList.toggle('hidden');return;}
  if(action==='edit-note'){const box=$(`note-${CSS.escape(el.dataset.id)}`);if(box)box.classList.toggle('hidden');return;}
  if(action==='save-question-note'){
    const id=el.dataset.id,area=document.querySelector(`.question-note[data-id="${CSS.escape(id)}"]`);user.questionNotes=user.questionNotes||{};user.questionNotes[id]=area?.value||'';saveUser();toast('Note saved');return;
  }
  if(action==='theme'){user.theme=user.theme==='dark'?'light':'dark';saveUser();document.body.classList.toggle('dark',user.theme==='dark');render();return;}
  if(action==='backup'){showBackupDialog();return;}
  if(action==='backup-download'){saveDownload(`gate-ce-practice-backup-${backupStamp()}.json`,backupPayload());writeBackupMeta({lastDownloadAt:Date.now()});dialogClose();toast('Backup downloaded');return;}
  if(action==='backup-folder-pick'){
    try{
      const handle=await window.showDirectoryPicker({id:'gate-ce-practice-backup',mode:'readwrite',startIn:'documents'});
      await idbSet('folder',handle);backupFolder={handle,name:handle.name,state:'granted',error:''};
      await runFolderBackup({interactive:true});renderBackupDialog(`Backing up to “${handle.name}”. First backup saved.`);
    }catch(error){if(error.name==='AbortError')return;renderBackupDialog(error.message||'Could not use that folder.');}
    return;
  }
  if(action==='backup-folder-now'){
    el.disabled=true;el.textContent='Saving…';
    try{await runFolderBackup({interactive:true});renderBackupDialog('Backup saved to your folder.');}
    catch(error){backupFolder.error=error.message||'Folder backup failed.';renderBackupDialog(error.message||'Folder backup failed.');}
    return;
  }
  if(action==='backup-folder-restore'){
    try{const handle=await ensureFolderAccess(true);const file=await(await handle.getFileHandle('gate-ce-practice-latest.json')).getFile();stageRestore(await file.text(),file.name);}
    catch(error){renderBackupDialog(error.name==='NotFoundError'?'No backup file found in that folder yet.':(error.message||'Could not read the backup from the folder.'));}
    return;
  }
  if(action==='backup-folder-disconnect'){
    clearTimeout(autoBackupTimer);backupFolder={handle:null,name:'',state:'none',error:''};
    try{await idbSet('folder');}catch{}
    renderBackupDialog('Automatic folder backup is off. Files already in the folder are untouched.');return;
  }
  if(action==='restore'){getRestoreInput().click();return;}
  if(action==='restore-undo'){undoRestore();return;}
  if(action==='export-collection'){
    const ids=el.dataset.kind==='bookmarks'?user.bookmarks:user.mistakes;saveDownload(`${el.dataset.kind}.json`,{exportedAt:new Date().toISOString(),questions:ids.map(id=>questionById.get(id)).filter(Boolean)});return;
  }
  if(action==='clear-collection'){
    dialogShow('Clear saved questions?',`This removes all ${el.dataset.kind} from this browser.`,`<button class="outline-button" data-dialog="close">Cancel</button><button class="danger-button" data-dialog="clear-${el.dataset.kind}">Clear all</button>`);return;
  }
  if(action==='add-todo'){const text=$('todoInput')?.value.trim();if(!text)return;user.todos.unshift({text,done:false});user.todos=user.todos.slice(0,30);saveUser();renderHome();return;}
  if(action==='delete-todo'){user.todos.splice(num(el.dataset.index),1);saveUser();renderHome();return;}
  if(action==='show-pending'){await ensureQuestionsForSubjects();dialogShow('Answer keys pending',`<p><strong>${pendingKeyCount()}</strong> questions are currently unverified: ${questions.filter(q=>q.type==='NAT'&&q.answerStatus==='pending').length} NAT questions and ${questions.filter(q=>q.type!=='NAT'&&q.answerStatus==='pending').length} MCQ/MSQ records with no correct option.</p><p>They remain linked to the answer backlog by question ID and will be excluded from grading until verified.</p>`,'<button class="primary-button" data-dialog="close">Close</button>');return;}
  if(action==='report-question'){showQuestionReport(el.dataset.id);return;}
  if(action==='send-question-report'){
    const q=questionById.get(el.dataset.id),reason=$('reportReason')?.value,details=$('reportDetails')?.value.trim()||'';
    if(!q||!authUser)return;
    el.disabled=true;el.textContent='Sending…';
    try{await SupaAuth.submitReport({question_id:q.id,year:q.year,session:q.session||'',question_no:q.questionNo,topic:q.topic||'',reason,details,reporter_name:SupaAuth.profile()?.display_name||authUser.email||'Candidate'});dialogClose();toast('Report sent. Thank you.');}
    catch(error){el.disabled=false;el.textContent='Send report';toast(error.message||'Could not send the report.');}
    return;
  }
  if(action==='save-profile'){
    const display_name=$('profileNameInput')?.value.trim()||'';if(!display_name){toast('Enter a display name.');return;}
    try{await SupaAuth.updateProfile({display_name});render();toast('Profile saved.');}catch(error){toast(error.message||'Could not save profile.');}return;
  }
  if(action==='auth-login'){if(window.SupaAuth)SupaAuth.signInWithGoogle();return;}
  if(action==='auth-logout'){if(window.SupaAuth){await SupaAuth.signOut();authUser=null;render();}return;}
}

app.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el)handleAction(el.dataset.action,el);else if(!e.target.closest('.custom-dropdown'))app.querySelectorAll('.custom-dropdown-menu').forEach(menu=>{menu.hidden=true;menu.closest('.custom-dropdown')?.querySelector('.custom-dropdown-trigger')?.setAttribute('aria-expanded','false');});if(!e.target.closest('.review-filter')){const menu=$('reviewFilterMenu'),trigger=$('reviewFilterTrigger');if(menu&&!menu.hidden){menu.hidden=true;trigger?.setAttribute('aria-expanded','false');}}});
app.addEventListener('input',e=>{
  if(e.target.id==='profilePhotoInput'&&e.target.files?.[0]){SupaAuth.uploadAvatar(e.target.files[0]).then(()=>{render();toast('Profile photo updated.');}).catch(error=>toast(error.message||'Could not upload photo.'));}
  if(e.target.id==='librarySearch'){
    const needle=e.target.value.toLowerCase();app.querySelectorAll('.browse-item').forEach(el=>el.classList.toggle('hidden',!el.dataset.search?.includes(needle)));
  }
  if(e.target.id==='collectionSearch'){
    collectionSearch=e.target.value;const needle=collectionSearch.toLowerCase();app.querySelectorAll('.review-card').forEach(card=>{const q=questionById.get(card.id.slice(7));card.classList.toggle('hidden',!`${q?.subject} ${q?.topic} ${q?.questionText} ${q?.year}`.toLowerCase().includes(needle));});
  }
  if(e.target.classList.contains('nat-input'))updateCurrentAnswer(e.target);
});
app.addEventListener('change',e=>{
  if(e.target.classList.contains('answer-input')&&!e.target.classList.contains('nat-input'))updateCurrentAnswer(e.target);
  if(e.target.matches('.practice-select')){
    const button=app.querySelector(`[data-action="start-quick-practice"][data-kind="${e.target.dataset.kind}"]`);
    if(button)button.disabled=!e.target.value;
  }
  if(e.target.matches('#customCount,#customDuration,#customSourceSelect')){refreshCustomForm();if(e.target.id==='customSourceSelect')renderCustom();}
  if(e.target.matches('[data-action="toggle-todo"]')){user.todos[num(e.target.dataset.index)].done=e.target.checked;saveUser();}
});
dialog.addEventListener('click',e=>{
  const a=e.target.closest('[data-action]');if(a){e.stopPropagation();handleAction(a.dataset.action,a);return;}
});
dialog.addEventListener('click',e=>{
  const d=e.target.closest('[data-dialog]');if(!d)return;const action=d.dataset.dialog;
  if(action==='close'){if(user.activeExam&&!user.activeExam.questionStartedAt)user.activeExam.questionStartedAt=Date.now();dialogClose();return;}
  if(action==='confirm-restore'){confirmRestore();return;}
  if(action==='start'){beginPendingExam();return;}
  if(action==='confirm-submit'){finalizeExam();return;}
  if(action==='discard-active'){user.activeExam=null;saveUser();dialogClose();view='home';render();return;}
  if(action==='clear-bookmarks'||action==='clear-mistakes'){const key=action==='clear-bookmarks'?'bookmarks':'mistakes';user[key]=[];saveUser();dialogClose();renderCollection(key);return;}
});
dialog.addEventListener('close',()=>{if(user.activeExam&&!user.activeExam.questionStartedAt)user.activeExam.questionStartedAt=Date.now();});
dialog.addEventListener('click',e=>{
  const button=e.target.closest('[data-calc]');if(!button)return;const display=$('calcDisplay');const key=button.dataset.calc;
  if(key==='C')display.value='';else if(key==='⌫')display.value=display.value.slice(0,-1);else if(key==='='){try{const expr=display.value.replaceAll('×','*').replaceAll('÷','/').replaceAll('−','-');if(/^[0-9+\-*/().\s]+$/.test(expr))display.value=String(Function(`"use strict";return (${expr})`)());}catch{display.value='Error';}}else display.value+=key;
});
getRestoreInput().addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try{stageRestore(await file.text(),file.name);}
  catch(error){toast(error.message||'Could not read this backup file.');}
  finally{e.target.value='';}
});
window.addEventListener('popstate',async()=>{const path=location.hash.replace('#','').split('/')[0];if(path==='results'&&user.history.length){view='results';activeResult=user.history[0].id;}else if(['home','subject','topic','year','custom','analytics','bookmarks','mistakes','profile'].includes(path))view=path;else view=user.activeExam?'exam':'home';if((view==='subject'||view==='topic')&&!selectedSubject)selectedSubject=subjects[0];await ensureViewQuestions(view);render();});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')app.querySelectorAll('.custom-dropdown-menu').forEach(menu=>{menu.hidden=true;menu.closest('.custom-dropdown')?.querySelector('.custom-dropdown-trigger')?.setAttribute('aria-expanded','false');});
  if(e.key==='Escape'){const menu=$('reviewFilterMenu'),trigger=$('reviewFilterTrigger');if(menu&&!menu.hidden){menu.hidden=true;trigger?.setAttribute('aria-expanded','false');trigger?.focus();}}
  if(view!=='exam'||dialog.open||!user.activeExam)return;
  if(e.target.matches('input,textarea,select'))return;
  if(e.key==='ArrowRight'){e.preventDefault();moveQuestion(user.activeExam.index+1);}
  if(e.key==='ArrowLeft'){e.preventDefault();moveQuestion(user.activeExam.index-1);}
});

loadDataset().catch(error=>{app.innerHTML=`<main class="boot-screen"><strong>Could not load the question bank</strong><small>${esc(error.message)}. Start the site with a local web server from the project folder.</small></main>`;console.error(error);});
setInterval(updateExamCountdown,1000);
initBackupFolder().then(()=>{if(backupFolder.state==='granted')scheduleAutoBackup(3000);});

// ── Supabase auth bootstrap ──────────────────────────────────────────────────
if(window.SupaAuth){
  SupaAuth.init().then(()=>{
    SupaAuth.onAuthChange(async(event,session,profile)=>{
      const prevUser=authUser;
      authUser=session?.user??null;

      if(authUser && !prevUser){
        // Freshly logged in – load cloud data and merge into local state
        try{
          const [cloudBookmarks,cloudMistakes,cloudHistory,cloudState]=await Promise.all([
            SupaAuth.loadBookmarks(),
            SupaAuth.loadMistakes(),
            SupaAuth.loadTestHistory(),
            SupaAuth.loadCloudState(),
          ]);
          let changed=false;
          if(cloudState){
            if(Array.isArray(cloudState.todos)){
              const todos=new Map();for(const todo of [...cloudState.todos,...user.todos])if(todo?.text)todos.set(todo.text,{...(todos.get(todo.text)||{}),...todo});
              user.todos=[...todos.values()].slice(0,30);changed=true;
            }
            if(cloudState.answerOverrides)user.answerOverrides={...cloudState.answerOverrides,...user.answerOverrides};
            if(cloudState.questionNotes)user.questionNotes={...cloudState.questionNotes,...(user.questionNotes||{})};
            if(cloudState.theme)user.theme=cloudState.theme;
            if(cloudState.activeExam&&!user.activeExam)user.activeExam=cloudState.activeExam;
            if(Array.isArray(cloudState.history)&&cloudState.history.length){
              const byId=new Map(cloudState.history.map(a=>[a.id,a]));
              for(const attempt of user.history)if(!byId.has(attempt.id))byId.set(attempt.id,attempt);
              user.history=[...byId.values()].sort((a,b)=>num(b.endedAt)-num(a.endedAt)).slice(0,150);changed=true;
            }
          }
          if(cloudBookmarks){
            // Merge: union of cloud + local, cloud wins for order
            const merged=[...new Set([...cloudBookmarks,...user.bookmarks])];
            if(merged.length!==user.bookmarks.length||merged.some((id,i)=>id!==user.bookmarks[i])){user.bookmarks=merged;changed=true;}
          }
          if(cloudMistakes){
            const merged=[...new Set([...cloudMistakes,...user.mistakes])];
            if(merged.length!==user.mistakes.length||merged.some((id,i)=>id!==user.mistakes[i])){user.mistakes=merged;changed=true;}
          }
          if(cloudHistory&&cloudHistory.length){
            // Add cloud attempts that aren't in local history (by id)
            const localIds=new Set(user.history.map(a=>a.id));
            const newAttempts=cloudHistory.filter(a=>!localIds.has(a.id));
            if(newAttempts.length){user.history=[...newAttempts,...user.history].slice(0,150);changed=true;}
          }
          if(changed){localStorage.setItem(STORE_KEY,JSON.stringify(user));}
          await SupaAuth.saveCloudState(user);
        }catch(e){console.warn('[Auth] cloud data merge error',e);}
      }

      if(event==='SIGNED_OUT'){authUser=null;}

      if(questionManifest)render();
    });
  }).catch(e=>console.warn('[Auth] init error',e));
}
