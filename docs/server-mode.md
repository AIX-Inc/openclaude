# OpenClaude Server Mode

OpenClaude Server Mode は、HTTP/WebSocket API を通じて外部アプリケーションから Claude CLI セッションをプログラマティックに操作するための機能です。

## クイックスタート

```bash
# サーバー起動（ポート自動割り当て）
claude server

# ポート指定で起動
claude server --port 3456

# 認証トークン指定（省略時は自動生成）
claude server --port 3456 --auth-token my-secret-token
```

起動すると以下が表示されます:

```
Claude Code Server listening on http://0.0.0.0:3456
Auth token: sk-ant-cc-xxxxxxxxxxxxxxxx
Max sessions: 8
Idle timeout: 600000ms
```

## コマンドオプション

| オプション | デフォルト | 説明 |
|---|---|---|
| `--port <number>` | `0` (自動) | HTTP ポート番号 |
| `--host <string>` | `0.0.0.0` | バインドアドレス |
| `--auth-token <token>` | 自動生成 | Bearer 認証トークン |
| `--unix <path>` | - | Unix ドメインソケットパス |
| `--workspace <dir>` | - | セッションのデフォルト作業ディレクトリ |
| `--idle-timeout <ms>` | `600000` (10分) | アイドルタイムアウト (0 = 無制限) |
| `--max-sessions <n>` | `8` | 最大同時セッション数 (0 = 無制限) |

## API リファレンス

### GET /health

サーバーの死活確認。認証不要。

```bash
curl http://localhost:3456/health
```

**レスポンス:**
```json
{"status": "ok", "sessions": 0}
```

### POST /sessions

新しいセッションを作成。CLI サブプロセスが起動され、WebSocket URL が返されます。

```bash
curl -X POST http://localhost:3456/sessions \
  -H "Authorization: Bearer <auth-token>" \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/path/to/workspace"}'
```

**リクエストボディ:**
| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `cwd` | string | いいえ | セッションの作業ディレクトリ (省略時: --workspace または cwd) |
| `env` | object | いいえ | サブプロセスに渡す環境変数 |

**レスポンス (201):**
```json
{
  "session_id": "87d741bb-fc6a-47f1-bbd2-10ff71a153bd",
  "ws_url": "ws://0.0.0.0:3456/ws/87d741bb-fc6a-47f1-bbd2-10ff71a153bd",
  "work_dir": "/path/to/workspace"
}
```

**エラーレスポンス:**
| ステータス | 説明 |
|---|---|
| 401 | 認証トークンが不正 |
| 503 | 最大セッション数に到達 |

### WebSocket /ws/:sessionId

セッションとの双方向 NDJSON ストリーミング。

```bash
# wscat での接続例
wscat -c "ws://localhost:3456/ws/<session_id>" \
  -H "Authorization: Bearer <auth-token>"
```

#### クライアント → サーバー (メッセージ送信)

```json
{"type":"user","message":{"role":"user","content":"Hello, Claude!"},"parent_tool_use_id":null,"session_id":""}
```

#### サーバー → クライアント (応答ストリーム)

NDJSON 形式で複数行が送信されます:

```jsonl
{"type":"system", ...}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}
{"type":"result","subtype":"success"}
```

**主要メッセージタイプ:**

| type | 説明 |
|---|---|
| `system` | システム初期化メッセージ |
| `assistant` | LLM からの応答 (テキスト、ツール呼び出し等) |
| `result` | セッション完了通知 (`subtype: "success"` or エラー) |
| `control_request` | ツール実行の許可リクエスト |

## 使用例: Node.js クライアント

```javascript
import http from 'http'
import WebSocket from 'ws'

const PORT = 3456
const TOKEN = 'your-auth-token'

// 1. セッション作成
const session = await fetch(`http://localhost:${PORT}/sessions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ cwd: '/path/to/workspace' }),
}).then(r => r.json())

console.log('Session ID:', session.session_id)

// 2. WebSocket 接続
const ws = new WebSocket(session.ws_url, {
  headers: { 'Authorization': `Bearer ${TOKEN}` },
})

ws.on('open', () => {
  // メッセージ送信
  ws.send(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'プロジェクトの構成を教えて' },
    parent_tool_use_id: null,
    session_id: '',
  }))
})

ws.on('message', (data) => {
  const line = data.toString().trim()
  if (!line) return

  const msg = JSON.parse(line)

  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text') {
        console.log('[AI]', block.text)
      }
    }
  } else if (msg.type === 'result') {
    console.log('完了:', msg.subtype)
    ws.close()
  }
})
```

## アーキテクチャ

```
クライアント (BizWiki等)
    │
    ├─ POST /sessions ──→ セッション作成
    │                      └─ CLI サブプロセス spawn
    │                           (--print --input-format stream-json
    │                            --output-format stream-json --verbose)
    │
    └─ WS /ws/:id ─────→ NDJSON 双方向ストリーム
         │                    │
         │  client→server     │  server→client
         │  (user message)    │  (assistant/result/system)
         │                    │
         └──→ subprocess      └──← subprocess stdout
              stdin (NDJSON)        (NDJSON)
                    │
                    ▼
              LLM API (Anthropic/OpenAI互換)
```

## セッション管理

### ライフサイクル

1. **作成**: `POST /sessions` → サブプロセス起動 → session_id 発行
2. **実行中**: WebSocket 経由でメッセージ送受信
3. **終了**: 以下のいずれかで自動クリーンアップ
   - サブプロセス正常終了
   - アイドルタイムアウト
   - サブプロセスクラッシュ (reaper による自動検出)
   - サーバーシャットダウン

### リソース制限

- **最大セッション数**: デフォルト 8。超過時は `POST /sessions` が 503 を返す
- **アイドルタイムアウト**: 最後のメッセージから 10 分で自動破棄

### ロックファイル

サーバー起動時に `~/.claude/server.lock` を作成。同一マシンでの重複起動を防止します。サーバー停止時またはプロセス終了時に自動削除されます。

## 環境変数

サーバー自体の LLM 接続には、通常の OpenClaude 環境変数を使用します:

| 変数 | 説明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 互換 API キー |
| `ANTHROPIC_BASE_URL` | API エンドポイント |
| `CLAUDE_CODE_USE_OPENAI=1` | OpenAI 互換プロバイダー使用時 |
| `OPENAI_API_KEY` | OpenAI API キー |
| `OPENAI_BASE_URL` | OpenAI API エンドポイント |
| `OPENAI_MODEL` | 使用モデル名 |

セッション作成時に `env` フィールドで追加の環境変数をサブプロセスに渡すことも可能です。

## トラブルシューティング

### サーバーが既に起動している

```
A claude server is already running (pid 12345) at http://0.0.0.0:3456
```

→ 既存のサーバープロセスを停止するか、別のポートで起動してください。プロセスが異常終了した場合は `~/.claude/server.lock` を手動で削除してください。

### セッション作成で 503 が返る

```json
{"error": "Maximum concurrent sessions reached (8)"}
```

→ 既存セッションの完了を待つか、`--max-sessions` を増やしてください。

### WebSocket 接続が 404 を返す

→ session_id が正しいか、セッションがまだ存在するか確認してください。アイドルタイムアウトやサブプロセスクラッシュで自動削除されている可能性があります。
