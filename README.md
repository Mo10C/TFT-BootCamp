# マウンテンチョンク校 TFT ログイン式リーダーボード

URLを踏むとまず **ログインページ** が開き、
① Riot ID（サモナー情報＋TFTランク取得）② Discord（アイコン・名前・**ロール**取得）
の2ステップを済ませた人だけがボードに入場できます。
入場した人は自動で選手登録され、**Discordロールを使ったフィルタ・組卓**ができます。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `login.html` | 入口。Riot ID検証 ＋ DiscordログインOAuth |
| `index.html` | 本番ボード（ログイン必須）。組卓・順位入力・全体順位 |
| `editor.html` | 管理コンソール（**管理者専用**）。メンバー管理・ランク一括更新・バックアップ |
| `core.js` | 共通ロジック（セッション / **権限** / Firestore同期 / 得点 / ロール組卓 / Riot API） |
| `config.js` | 設定（Firebase / Worker URL / region / **管理者** / 既定値） |
| `worker.js` | Cloudflare Worker（Riot中継 ＋ Discord OAuth ＋ ロール解決） |
| `wrangler.jsonc` | Worker のデプロイ設定 |
| `DESIGN-auth.md` | 次フェーズ（Firestoreルールの厳格化）の設計判断メモ |

---

# ★ 権限モデル（v2.1）

`config.js` の `admins` に載っている人だけが編集できます。

| 操作 | 管理者 | 一般プレイヤー |
|---|:--:|:--:|
| ボードの閲覧・全体順位 | ○ | ○ |
| ログイン時の自己登録（ランク・ロール更新） | ○ | ○ |
| **自分の**出欠チェック | ○ | ○ |
| 他人の出欠・出欠の一括操作 | ○ | ✗ |
| 大会名・試合数・卓数の変更 | ○ | ✗ |
| 自動組卓・席の配置・順位入力・⚡自動取得 | ○ | ✗ |
| `editor.html`（管理コンソール） | ○ | ✗（ロック画面） |

## 管理者の指定方法（3通り・併用可）

```js
admins: {
  discordIds: ["123456789012345678"],  // ★最も確実。開発者モード→自分を右クリック→ユーザーIDをコピー
  riotIds: ["Mo10C#819"]               // Riot ID（大文字小文字は無視）
},
roles: {
  adminRoleIds: ["運営ロールのID"]      // このロール保持者も管理者として扱う
}
```

> ⚠️ **3つとも空だと「セットアップ中」とみなして全員が管理者になります。**
> その場合は画面に `⚠️ 管理者未設定` バッジが出ます。必ずどれか埋めてください。

## 権限の実装レイヤー

ボタンを隠すだけでなく、**`core.js` の Store 側で全ミューテーションをガード**しています
（`store.setActor({pid, isAdmin})` が起点）。ガードに弾かれると `window` に
`lb-denied` イベントが飛び、画面側がトーストを出します。

> ⚠️ ただし現時点では **Firestoreのセキュリティルールは緩いまま**です。
> ブラウザのコンソールから直接 Firestore を叩けば書き換えは可能です。
> そこを塞ぐ設計は `DESIGN-auth.md` を参照。

---

# セットアップ手順

## 1. Discord アプリを用意（1回だけ）

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. **OAuth2** ページで
   - `CLIENT ID` と `CLIENT SECRET` を控える
   - **Redirects** に `https://<WorkerのURL>/auth/callback` を追加（Workerデプロイ後に確定）
3. **Bot** タブで Bot を作成し `TOKEN` を控える → サーバー（マウンテンチョンク校）に招待
   - 権限は不要（ロール一覧の読み取りだけに使用）。招待URL例:
     `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=0`
   - ※ 既存のランク表示Botを使い回してもOK（同じサーバーに入っていれば良い）
4. サーバーIDを控える（Discordの設定→詳細設定→開発者モードON → サーバー右クリック→IDをコピー）

## 2. Worker をデプロイ

```bash
# worker.js と wrangler.jsonc があるフォルダで
npx wrangler deploy

# シークレットを設定
npx wrangler secret put RIOT_API_KEY
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
```

- `wrangler.jsonc` の `DISCORD_GUILD_ID` にサーバーIDを記入
- `RETURN_ORIGINS` は本番オリジン（`https://mo10c.github.io`）＋ローカル確認用を推奨
- デプロイ後のURL（例 `https://mcc-login-board.xxx.workers.dev`）を
  **Discord Developer PortalのRedirects**（`.../auth/callback`）と **config.js の workerUrl** に設定

動作確認: `https://<Worker URL>/health` が `{"ok":true}` を返せばOK。

## 3. config.js を設定

- `workerUrl`: 手順2のURL
- `firebase`: 既存リーダーボードと同じ値のままでOK（プリフィル済み）
- `platform`: JPサーバーなら `jp1` のまま
- **`admins.discordIds`**: 自分のDiscordユーザーIDを入れる（最優先で設定）

## 4. Firestore ルールに新コレクションを追加

既存プロジェクトを使う場合、`lboards` / `lboard_index` を許可します（Firebaseコンソール → Firestore → ルール）:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /boards/{id} { allow read, write: if true; }        // 既存
    match /board_index/{id} { allow read, write: if true; }   // 既存
    match /lboards/{id} { allow read, write: if true; }       // ★追加
    match /lboard_index/{id} { allow read, write: if true; }  // ★追加
  }
}
```

## 5. GitHub Pages に配置

このフォルダ一式（`login.html` `index.html` `editor.html` `core.js` `config.js`）をリポジトリの任意フォルダへ。
アバター画像を使う場合は `assets/moto-hero.png` も同じ階層の `assets/` に置いてください（無ければ自動で非表示）。

> ポータル（マウンテンチョンク校TOOLS）へ載せる場合は、運用ルール通り **ポータルの editor.html からツール追加** で `login.html` へのリンクを登録してください。

## 6. 使い方

1. 共有するのは **login.html のURL**（`?board=大会ID` を付けると大会別）
   例: `https://mo10c.github.io/lboard/login.html?board=camp-2026-08`
2. 参加者は Riot ID確認 → Discordログイン → 入場（自動で選手登録）
3. 主催は組卓 → 対戦 → 結果タブで順位入力 or ⚡自動取得
4. 🏆全体順位が累計ptで自動集計（得点は既存と同じ 1位8pt〜8位1pt）

---

# よくあるハマりどころ

- **Discordログイン後にエラー**: Redirects の登録URL（`/auth/callback` まで完全一致）と `RETURN_ORIGINS` を確認
- **ロール名が出ない（IDだけになる）**: `DISCORD_BOT_TOKEN` 未設定か、Botがサーバーに入っていない
- **ランクが「ランクなし」**: そのアカウントが今セットでランク戦未プレイ（正常動作）
- **`_nojekyll` 問題**: GitHub Pages では `.nojekyll`（先頭ドット）である点に注意
- **開発キーの期限**: Riot開発キーは24時間で失効。切れたら Worker のシークレットを更新
- **自分が管理者なのにロック画面が出る**: `config.js` の `admins` に自分が入っているか確認。
  Riot ID指定の場合、ログイン時に入力した Riot ID と完全一致（タグ含む）が必要

---

# 変更履歴

## v2.1（2026-09）— 権限ロック＋バグ修正

- **権限モデルを導入**（`admins` 設定、Store側ガード、`editor.html` の管理者専用化）
- **🐛 `prompt=none` を削除**：初回ログインの参加者が `consent_required` で必ず弾かれていた致命的バグ
- **🐛 表示名の上書きを修正**：`nameLocked` フラグを追加。管理者が付けた名前が本人の再ログインで
  Discord名に戻らなくなった（空欄で保存するとロック解除）
- **🐛 `isAdmin()` の骨抜きを修正**：`adminRoleIds` 未設定なら全員 true だった

## v2.0 — たたき台

- ログイン = Riot ID + Discord の2要素、ロールフィルタ、ロール連動の自動組卓（4方式）
- Firestoreでリアルタイム共有（コレクション `lboards`）

---

# 次の拡張候補

- **Firestoreルールの厳格化**（→ `DESIGN-auth.md`。Firebase Auth カスタムトークン発行）
- チーム戦（4v4）/ ダブルアップ対応（core.jsの `pointsFor` は既に3モード対応済み）
- ボードのアーカイブ / 名前変更 / 削除（既存版の board_index 運用を移植）
- 配信・観戦モード（OBS埋め込み用の読み取り専用ビュー）
- ログインセッションの有効期限・再認証フロー
