import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = path.join(ROOT, '.runtime');
const CONFIG_FILE = path.join(PRIVATE_DIR, 'telegram.json');
const BACKUP_FILE = path.join(PRIVATE_DIR, 'latest-backup.json');
const PORT = Number(process.env.PORT || 8000);
const HOST = '127.0.0.1';
let config = null;
let latestBackup = null;
let polling = false;

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function savePrivate(file, value) {
  await fs.mkdir(PRIVATE_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
async function telegram(method, params = {}) {
  if (!config?.token) throw new Error('Telegram is not connected.');
  const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram request failed (${response.status}).`);
  return result.result;
}
async function updateLoop() {
  if (polling || !config?.token || config.chatId) return;
  polling = true;
  try {
    const updates = await telegram('getUpdates', { offset: config.updateOffset || 0, timeout: 0, allowed_updates: ['message'] });
    for (const update of updates) {
      config.updateOffset = update.update_id + 1;
      const message = update.message;
      const text = (message?.text || '').trim();
      if (message?.chat?.type === 'private' && /^\/start(?:\s|$|@)/i.test(text)) {
        config.chatId = message.chat.id;
        config.chatName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Telegram chat';
        await savePrivate(CONFIG_FILE, config);
        await telegram('sendMessage', { chat_id: config.chatId, text: 'GATE CE backup bot connected. Your latest practice backup will be sent daily at 00:00 (India time) while your local backup service is running.' });
        break;
      }
    }
    if (!config.chatId) await savePrivate(CONFIG_FILE, config);
  } catch (error) {
    config.lastError = error.message;
  } finally { polling = false; }
}
function backupFileName() {
  const d = new Date();
  return `gate-ce-backup-${d.toISOString().slice(0, 10)}.json`;
}
async function sendBackup() {
  if (!config?.chatId || !latestBackup) return false;
  const buffer = Buffer.from(JSON.stringify(latestBackup, null, 2));
  const boundary = `----gatece${Date.now()}`;
  const metadata = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${config.chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nYour daily GATE CE practice backup\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${backupFileName()}"\r\nContent-Type: application/json\r\n\r\n`);
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([metadata, buffer, end]);
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendDocument`, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body, signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram could not send the backup.');
  config.lastSentAt = new Date().toISOString(); config.lastError = null;
  await savePrivate(CONFIG_FILE, config);
  return true;
}
async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function status() {
  return { connected: Boolean(config?.chatId), botName: config?.botName || '', chatName: config?.chatName || '', lastSentAt: config?.lastSentAt || null, hasBackup: Boolean(latestBackup), lastError: config?.lastError || null };
}
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.gz':'application/gzip','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.host && !/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host)) return sendJson(res, 403, { error: 'Local access only.' });
      const origin = req.headers.origin;
      if (origin && ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(origin)) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.method === 'GET' && url.pathname === '/api/telegram/status') return sendJson(res, 200, status());
      if (req.method === 'POST' && url.pathname === '/api/telegram/connect') {
        const input = JSON.parse(await readBody(req, 4096));
        const token = String(input.token || '').trim();
        if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return sendJson(res, 400, { error: 'That does not look like a Telegram bot token.' });
        const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
        const result = await response.json();
        if (!response.ok || !result.ok) return sendJson(res, 400, { error: result.description || 'Telegram could not verify that token.' });
        config = { token, botName: result.result.username, updateOffset: 0, createdAt: new Date().toISOString() };
        await savePrivate(CONFIG_FILE, config);
        await updateLoop();
        return sendJson(res, 200, status());
      }
      if (req.method === 'POST' && url.pathname === '/api/telegram/pair') { await updateLoop(); return sendJson(res, 200, status()); }
      if (req.method === 'POST' && url.pathname === '/api/telegram/backup') {
        latestBackup = JSON.parse(await readBody(req));
        await savePrivate(BACKUP_FILE, latestBackup);
        return sendJson(res, 200, { saved: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/telegram/send-test') {
        try { const sent = await sendBackup(); return sent ? sendJson(res, 200, status()) : sendJson(res, 400, { error: 'No practice backup is available yet.' }); }
        catch (error) { return sendJson(res, 502, { error: error.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/telegram/disconnect') {
        config = null;
        await fs.rm(CONFIG_FILE, { force: true });
        return sendJson(res, 200, { connected: false });
      }
      return sendJson(res, 404, { error: 'Not found.' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname.startsWith('/.runtime') || pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404); return res.end('Not found'); }
    const file = path.resolve(ROOT, `.${pathname}`);
    if (!file.startsWith(`${ROOT}${path.sep}`)) { res.writeHead(403); return res.end(); }
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (req.url?.startsWith('/api/')) sendJson(res, 500, { error: error.message || 'Unexpected server error.' });
    else { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error'); }
  }
});

config = await readJson(CONFIG_FILE);
latestBackup = await readJson(BACKUP_FILE);
setInterval(() => { updateLoop(); }, 5000);
setInterval(async () => {
  if (!config?.chatId || !latestBackup) return;
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const today = `${local.year}-${local.month}-${local.day}`;
  if (local.hour === '00' && local.minute === '00' && config.lastDailyDate !== today) {
    try { await sendBackup(); config.lastDailyDate = today; await savePrivate(CONFIG_FILE, config); }
    catch (error) { config.lastError = error.message; await savePrivate(CONFIG_FILE, config); }
  }
}, 15000);
server.listen(PORT, HOST, () => console.log(`GATE CE local app + Telegram backup service: http://localhost:${PORT}`));
