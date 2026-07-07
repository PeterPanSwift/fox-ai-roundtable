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

// 清掉上次留下的上傳圖片
for (const f of fs.readdirSync(WORKSPACE)) {
  if (/^img-[a-z0-9]+\.(png|jpe?g|webp|gif)$/.test(f)) fs.unlinkSync(path.join(WORKSPACE, f));
}

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// 圖片檔名只允許伺服器自己產生的格式，避免路徑穿越
function imagePath(name) {
  if (typeof name === 'string' && /^img-[a-z0-9]+\.(png|jpe?g|webp|gif)$/.test(name)) {
    const p = path.join(WORKSPACE, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Claude 與 agy 沒有 --image 參數，但都是能讀檔的 agent：把路徑寫進 prompt
function promptWithImage(prompt, img) {
  return img ? `附件圖片 / attached image: ${img}\n\n${prompt}` : prompt;
}

function run(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env: cleanEnv(), cwd: WORKSPACE });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    // setEncoding 讓 StringDecoder 處理跨 chunk 的多位元組字元，避免中文或 emoji 變成 �
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
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
  async claude(prompt, img) {
    const args = ['-p', '--output-format', 'json'];
    if (sessions.claude) args.push('--resume', sessions.claude);
    args.push(promptWithImage(prompt, img));
    const r = await run('claude', args);
    let answer = '';
    try {
      const data = JSON.parse(r.stdout);
      answer = (data.result || '').trim();
      if (data.session_id) sessions.claude = data.session_id; // resume 會產生新 id，每輪更新
    } catch { answer = r.stdout.trim(); }
    return { ...r, answer };
  },

  async codex(prompt, img) {
    const args = sessions.codex
      ? ['exec', 'resume', sessions.codex]
      : ['exec'];
    // -i 可吃多個值，要放在其他旗標前面，避免把 prompt 當成圖片檔名吞掉
    if (img) args.push('-i', img);
    args.push('--skip-git-repo-check', '--json', prompt);
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

  async gemini(prompt, img) {
    // Antigravity CLI（使用你的 Gemini 訂閱）
    const agy = path.join(os.homedir(), '.local', 'bin', 'agy');
    const fullPrompt = promptWithImage(prompt, img);
    if (sessions.gemini) {
      const r = await run(agy, ['--conversation', sessions.gemini, '-p', fullPrompt]);
      return { ...r, answer: r.stdout.trim() };
    }
    // 第一輪：從 log 檔撈出 conversation ID，之後用它接續
    const log = path.join(os.tmpdir(), `agy-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const r = await run(agy, ['--log-file', log, '-p', fullPrompt]);
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

  if (req.method === 'POST' && req.url === '/api/upload') {
    const ext = IMAGE_TYPES[req.headers['content-type']];
    if (!ext) return json(res, 400, { ok: false, error: '不支援的圖片格式 / unsupported image type' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_IMAGE_BYTES) { req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const name = `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(WORKSPACE, name), Buffer.concat(chunks));
      json(res, 200, { ok: true, file: name });
    });
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
      let provider, prompt, image;
      try { ({ provider, prompt, image } = JSON.parse(body)); } catch {}
      if (!providers[provider] || typeof prompt !== 'string' || !prompt.trim()) {
        return json(res, 400, { ok: false, error: 'provider 或 prompt 不正確 / invalid provider or prompt' });
      }
      const img = image ? imagePath(image) : null;
      if (image && !img) {
        return json(res, 400, { ok: false, error: '圖片不存在 / image not found' });
      }
      try {
        const r = await providers[provider](prompt.trim(), img);
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
