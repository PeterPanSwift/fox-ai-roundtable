# 小狐狸的 AI 圓桌 🦊

Ask once, get three answers — a tiny local web app that sends the same prompt to **Claude**, **Codex (GPT)** and **Antigravity (Gemini)** through their CLIs, side by side.

輸入一個問題，讓 Claude、Codex（GPT）、Antigravity（Gemini）三個 AI 同時回答。全部透過你本機已登入的 CLI 執行，**不需要任何 API key**，用的是你原本的訂閱方案。

![screenshot](fox.png)

## 需求

三個 CLI 都要先安裝並登入：

| AI | CLI | 安裝 |
|---|---|---|
| Claude | [Claude Code](https://claude.com/claude-code) | `brew install claude` 或官網安裝，執行 `claude` 登入 |
| Codex（GPT） | [Codex CLI](https://github.com/openai/codex) | `brew install codex`，執行 `codex` 登入 |
| Antigravity（Gemini） | [Antigravity](https://antigravity.google/) 的 `agy` | 安裝 Antigravity 後執行 CLI 設定，`agy` 會裝在 `~/.local/bin/` |

另外需要 Node.js（任何近期版本皆可，零相依套件）。

## 使用

```bash
node server.js
```

打開 http://localhost:3457 ，輸入問題按「送出」（或 ⌘ + Enter）。

- 三個 AI **同時**作答，各自完成就各自顯示，並標示耗時
- 支援**接續對話**：三個 AI 都會記得同一場對話的上下文
- 按「新對話」清除三家的對話記憶
- 上方勾選框可只問其中幾家
- 回答以 Markdown 渲染，支援深色模式

## 運作方式

伺服器（[server.js](server.js)，零相依的 Node HTTP server）收到 prompt 後同時執行：

- `claude -p --output-format json`，之後用 `--resume <session_id>` 接續對話
- `codex exec --json`，之後用 `codex exec resume <thread_id>` 接續
- `agy -p`，第一輪從 log 取得 conversation ID，之後用 `--conversation <id>` 接續

## 安全性

- 伺服器只綁定 `127.0.0.1`，區網內的其他裝置連不進來
- CLI 在專用的空資料夾 `~/.fox-ai-roundtable` 中執行，限縮 AI agent 能讀取的檔案範圍
- Prompt 以參數陣列傳給 `spawn`、不經過 shell，沒有指令注入風險
- AI 回答經 DOMPurify 消毒後才渲染

## License

MIT
