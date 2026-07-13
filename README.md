# マウンテンチョンク校 TFT ログイン式リーダーボード（たたき台）

URLを踏むとまず **ログインページ** が開き、
① Riot ID（サモナー情報＋TFTランク取得）② Discord（アイコン・名前・**ロール**取得）
の2ステップを済ませた人だけがボードに入場できます。
入場した人は自動で選手登録され、**Discordロールを使ったフィルタ・組卓**ができます。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `login.html` | 入口。Riot ID検証 ＋ DiscordログインOAuth |
| `index.html` | 本番ボード（ログイン必須）。組卓・順位入力・全体順位 |
| `editor.html` | 管理コンソール。メンバー管理・ランク一括更新・バックアップ |
| `core.js` | 共通ロジック（セッション / Firestore同期 / 得点 / ロール組卓 / Riot API） |
| `config.js` | 設定（Firebase / Worker URL / region / 既定値） |
| `worker.js` | Cloudflare Worker（Riot中継 ＋ Discord OAuth ＋ ロール解決） |
| `wrangler.jsonc` | Worker のデプロイ設定 |

## できること（たたき台の範囲）

- ログイン = Riot ID + Discord の2要素。ログインした人が自動で選手登録（再ログインでランク・ロールが最新化）
- **ロールフィルタ**: 参加者バーの上のチップでロール別に絞り込み／「表示中だけ参加」で一括出欠
- **ロール連動の自動組卓**（4方式）
  - 完全ランダム
  - pt近い順（2試合目以降のスイス式風）
  - **ロールを各卓に均等分散**（例: コーチロールを各卓1人ずつ）
  - **同ロールを同卓に固める**
- 順位は手入力（1〜8位セレクト）または **⚡自動取得**（卓全員のpuuidで直近マッチを照合）
- Firestoreでリアルタイム共有（コレクション `lboards` — 既存リーダーボードの `boards` とは別なので共存OK）
- 🔗共有ボタンは **ログインページのURL** をコピーします（未ログインの人も正しい導線に乗る）

> ⚠️ たたき台は **個人戦（solo）のみ**。チーム戦 / ダブルアップは既存のv2モデルを踏襲して次段階で拡張できる構造にしてあります。

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

# 次の拡張候補（このたたき台の先）

- チーム戦（4v4）/ ダブルアップ対応（core.jsの `pointsFor` は既に3モード対応済み）
- 管理者ロール（`config.js roles.adminRoleIds`）による editor.html の強制ガード
- ボードのアーカイブ / 名前変更 / 削除（既存版の board_index 運用を移植）
- ログインセッションの有効期限・再認証フロー
