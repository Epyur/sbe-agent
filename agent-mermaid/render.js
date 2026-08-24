'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
// mermaid-cli v11+ не экспортирует API через require — вызываем CLI-бинарь mmdc.
const MM_DC = path.join(__dirname, 'node_modules', '.bin', 'mmdc');
// контейнер работает от root — chromium нужен --no-sandbox (конфиг для puppeteer)
const PUPPETEER_CONFIG = path.join(os.tmpdir(), 'puppeteer.json');
fs.writeFileSync(PUPPETEER_CONFIG, JSON.stringify({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
}));

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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
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

server.listen(PORT, () => {
  console.log(`agent-mermaid listening on :${PORT}`);
});
