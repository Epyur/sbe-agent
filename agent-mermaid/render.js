'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
// Общий токен между agent-service и agent-mermaid (ревью 2.4): без него любой
// контейнер/процесс в docker-сети мог бы рендерить mermaid-код через chromium.
const AUTH_TOKEN = process.env.MERMAID_AUTH_TOKEN || '';
// Лимит тела запроса (1 МБ) — защита от DoS памятью (ревью 1.4).
const MAX_BODY_BYTES = 1024 * 1024;
// mermaid-cli v11+ не экспортирует API через require — вызываем CLI-бинарь mmdc.
const MM_DC = path.join(__dirname, 'node_modules', '.bin', 'mmdc');
// контейнер работает от root — chromium нужен --no-sandbox (конфиг для puppeteer)
const PUPPETEER_CONFIG = path.join(os.tmpdir(), 'puppeteer.json');
fs.writeFileSync(PUPPETEER_CONFIG, JSON.stringify({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
}));

// Constant-time сравнение токена (crypto.timingSafeEqual).
function tokenMatches(provided) {
  if (!AUTH_TOKEN || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

// Ограничение одновременных рендеров (chromium на каждый): 2. Очередь без ошибок.
const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;
const renderWaiters = [];

async function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return;
  }
  await new Promise((resolve) => { renderWaiters.push(resolve); });
  activeRenders++;
}

function releaseRenderSlot() {
  activeRenders--;
  const next = renderWaiters.shift();
  if (next) next();
}

function render(code, format) {
  return new Promise((resolve, reject) => {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
    const infile = path.join(os.tmpdir(), `mmd-${stamp}.mmd`);
    const outfile = path.join(os.tmpdir(), `mmd-${stamp}.${format}`);
    fs.writeFileSync(infile, code, 'utf8');
    const cleanup = () => {
      try { fs.unlinkSync(infile); } catch (e) { /* noop */ }
      try { fs.unlinkSync(outfile); } catch (e) { /* noop */ }
    };
    execFile(
      MM_DC,
      ['-i', infile, '-o', outfile, '-e', format, '-p', PUPPETEER_CONFIG, '-q'],
      { timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
      (err) => {
        if (err) {
          cleanup();
          reject(err);
          return;
        }
        const data = fs.readFileSync(outfile);
        cleanup();
        resolve(data);
      },
    );
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/render') {
    // Ревью 2.4: рендер доступен только agent-service (Bearer-токен, общий env).
    if (!tokenMatches(bearerToken(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = '';
    let tooLarge = false;
    req.on('error', () => { /* клиент оборвал соединение — не роняем процесс */ });
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request too large' }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooLarge) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      const code = String(parsed.code || '');
      const format = String(parsed.format || 'svg') === 'png' ? 'png' : 'svg';
      if (!code.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'code is required' }));
        return;
      }
      try {
        await acquireRenderSlot();
        try {
          const data = await render(code, format);
          res.writeHead(200, { 'Content-Type': format === 'png' ? 'image/png' : 'image/svg+xml' });
          res.end(data);
        } finally {
          releaseRenderSlot();
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// Слушаем на всех интерфейсах: agent-service ходит сюда из другого контейнера
// по internal-сети (127.0.0.1 не пересекает границы контейнеров). Наружу маршрута
// в Caddy нет, защита — Bearer-токен (ревью 2.4).
server.listen(PORT, () => {
  console.log(`agent-mermaid listening on :${PORT}`);
});
