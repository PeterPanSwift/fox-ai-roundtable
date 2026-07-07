#!/usr/bin/env node
// 多 AI 聊天伺服器：把同一個 prompt 丟給 Claude CLI、Codex CLI、Gemini CLI，回傳各自的答案。
// 啟動:  node server.js   →  http://localhost:3457

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3457;
const TIMEOUT_MS = 180_000;

// 避免巢狀 CLI 偵測到彼此的環境變數而行為異常
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete env[k];
  }
  return env;
}

// CLI 的專用工作目錄：限縮 AI agent 能接觸的檔案範圍（不要用家目錄）
const WORKSPACE = path.join(os.homedir(), '.fox-ai-roundtable');
fs.mkdirSync(WORKSPACE, { recursive: true });

function run(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env: cleanEnv(), cwd: WORKSPACE });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (input !== undefined) { child.stdin.write(input); }
    child.stdin.end();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), elapsed: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsed: Date.now() - started });
    });
  });
}

// 各家 CLI 的對話 session（伺服器重啟或按「新對話」即重置）
const sessions = { claude: null, codex: null, gemini: null };

const providers = {
  async claude(prompt) {
    const args = ['-p', '--output-format', 'json'];
    if (sessions.claude) args.push('--resume', sessions.claude);
    args.push(prompt);
    const r = await run('claude', args);
    let answer = '';
    try {
      const data = JSON.parse(r.stdout);
      answer = (data.result || '').trim();
      if (data.session_id) sessions.claude = data.session_id; // resume 會產生新 id，每輪更新
    } catch { answer = r.stdout.trim(); }
    return { ...r, answer };
  },

  async codex(prompt) {
    const args = sessions.codex
      ? ['exec', 'resume', sessions.codex, '--skip-git-repo-check', '--json', prompt]
      : ['exec', '--skip-git-repo-check', '--json', prompt];
    const r = await run('codex', args);
    let answer = '';
    for (const line of r.stdout.split('\n')) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'thread.started' && ev.thread_id) sessions.codex = ev.thread_id;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') answer = ev.item.text.trim();
      } catch {}
    }
    return { ...r, answer };
  },

  async gemini(prompt) {
    // Antigravity CLI（使用你的 Gemini 訂閱）
    const agy = path.join(os.homedir(), '.local', 'bin', 'agy');
    if (sessions.gemini) {
      const r = await run(agy, ['--conversation', sessions.gemini, '-p', prompt]);
      return { ...r, answer: r.stdout.trim() };
    }
    // 第一輪：從 log 檔撈出 conversation ID，之後用它接續
    const log = path.join(os.tmpdir(), `agy-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const r = await run(agy, ['--log-file', log, '-p', prompt]);
    try {
      const m = fs.readFileSync(log, 'utf8').match(/Created conversation ([a-f0-9-]+)/);
      if (m) sessions.gemini = m[1];
      fs.unlinkSync(log);
    } catch {}
    return { ...r, answer: r.stdout.trim() };
  },
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  if (req.method === 'GET' && req.url === '/fox.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    res.end(fs.readFileSync(path.join(__dirname, 'fox.png')));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reset') {
    for (const k of Object.keys(sessions)) sessions[k] = null;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/api/ask') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let provider, prompt;
      try { ({ provider, prompt } = JSON.parse(body)); } catch {}
      if (!providers[provider] || typeof prompt !== 'string' || !prompt.trim()) {
        return json(res, 400, { ok: false, error: 'provider 或 prompt 不正確 / invalid provider or prompt' });
      }
      try {
        const r = await providers[provider](prompt.trim());
        if (r.answer) {
          json(res, 200, { ok: true, answer: r.answer, elapsed: r.elapsed });
        } else {
          json(res, 200, { ok: false, error: (r.stderr || '沒有輸出 / no output').trim().slice(-2000), elapsed: r.elapsed });
        }
      } catch (err) {
        json(res, 500, { ok: false, error: String(err) });
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// 只綁定本機：避免區網裡的其他人使用你的訂閱額度或透過 AI 讀取檔案
server.listen(PORT, '127.0.0.1', () => {
  console.log(`小狐狸的 AI 圓桌已啟動： http://localhost:${PORT}`);
});
