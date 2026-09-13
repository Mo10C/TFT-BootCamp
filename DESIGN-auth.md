# 設計判断メモ — Worker からの Firebase カスタムトークン発行

対象: マウンテンチョンク校 TFT ログイン式リーダーボード（v2.1 → v3.0）
日付: 2026-09-13

---

## 0. 結論（先に3行）

1. **トークン発行方式** → **案C: 短命チケット交換方式**を採用。
   カスタムトークンをURLフラグメントに載せず、2分有効のチケットを経由させる。KVは不要。
2. **データ模型** → **roster をサブコレクション `lboards/{bid}/players/{uid}` に分離**する。
   これをやらないとルールが書けない。ここが今回の本丸で、認証より作業量が大きい。
3. **フェーズ分割** → 認証導入とデータ分離は**同時にやる必要がある**（片方だけでは動かない）。
   ただし「配信用の読み取り専用ビュー」は分離後のほうが作りやすいので、順序はこの後に。

---

## 1. なぜ今のままではルールが書けないのか

これが一番重要な論点なので最初に置きます。

現状の `core.js` の `persist()` は **ボード全体を1ドキュメントに丸ごと `set()`** しています。

```js
if (mode === "firestore" && docRef) await docRef.set(JSON.parse(JSON.stringify(state)));
```

つまり、

- 一般プレイヤーが**ログインして自己登録する**（`upsertSelf`）とき → ボード全体を書く
- 一般プレイヤーが**自分の出欠にチェックを入れる**（`setPresent`）とき → ボード全体を書く

この2つは仕様上どうしても一般プレイヤーに許す必要があります。
したがって「`lboards/{id}` は管理者のみ書き込み可」というルールを入れると、**ログインも出欠も壊れます。**

かといって「一般プレイヤーも書いてよい、ただし自分の分だけ」をルールで表現しようとすると、
`request.resource.data.matches[0].tables[1].seats` のような**深くネストした配列の差分比較**が必要になり、
Firestore のルール言語では現実的に書けません（配列は要素単位の比較ができない）。

> **結論: 権限の境界と、ドキュメントの境界を一致させる必要がある。**
> 誰が書いてよいかが違うデータは、別のドキュメントに分ける。

---

## 2. データ模型の分割（案A採用）

### 検討した3案

| 案 | 内容 | 評価 |
|---|---|---|
| **A. サブコレクション分離** | 選手1人 = 1ドキュメント。本人が書く | ✅ **採用**。ルールが1行で書ける。ブラウザ完結を維持 |
| B. 全書き込みをWorker経由 | ルールは全拒否。WorkerがREST APIで書く | ルールは最も単純だが、全操作にネットワーク往復が増え、`onSnapshot` の即時反映感が失われる。Workerが単一障害点になる |
| C. 単一ドキュメント＋出欠だけWorker | 中間案 | 両方の複雑さを背負う。自己登録も通すなら結局Aと同じ作業量 |

### 採用する構造

```
lboards/{boardId}                     ← 管理者のみ書き込み可
  { mode, title, matchCount, tableCount,
    matches: [ { tables: [ { seats[8], placements{} } ] } ],
    updatedAt }
    ※ roster と present をここから抜く

lboards/{boardId}/players/{uid}       ← 本人 or 管理者が書き込み可
  { name, nameLocked, riotId, puuid,
    rank: {...},
    discord: { id, name, username, avatar },
    roles: [ {id, name, color} ],
    present: { "0": true, "1": false, "2": true },   ← 試合indexごとの出欠
    joinedAt, updatedAt }
```

**ポイント:**

- `uid` は Firebase Auth の UID をそのまま使う。UIDは `discord:<discordId>` とする。
  既存の `pid = "u_<discordId>"` とは別体系になるので、`core.js` に相互変換を1本置く
  （`pidToUid(pid)` / `uidToPid(uid)`）。既存データとの互換を保つため **pid の形式は変えない**。
- `present` を**選手ドキュメント側に持たせる**のがこの設計の肝です。
  「この試合に出るか」は本人の意思表示なので、所有者も本人。権限境界とデータ境界が一致します。
- `present` のキーが無い試合は「参加」とみなす（現行の `present: null = 全員参加` と同じ既定値）。
- 席（`seats`）と順位（`placements`）はボード側に残す。これは運営の決定事項なので管理者のみ。

### 影響範囲（`core.js`）

| 関数 | 変更 |
|---|---|
| `init()` | `onSnapshot` を2つに（ボード本体＋playersサブコレクション）。両方揃ってから `emit()` |
| `persist()` | ボード本体のみ書く。roster は書かない |
| `upsertSelf()` | 自分の players ドキュメントだけ `set(..., {merge:true})` |
| `updatePlayer` / `setPlayerName` / `removePlayer` | 対象の players ドキュメントを直接操作 |
| `setPresent()` | 自分の players ドキュメントの `present.<matchIdx>` のみ更新 |
| `setAllPresent` / `setPresentByRole` | `writeBatch` で複数 players を一括更新（管理者のみ） |
| `normalize()` | roster を外から注入する形に。旧形式（roster内包）も読めるようにしておく |

**移行**: 既存ボードは roster がドキュメント内にあります。
`editor.html` に「🔁 新形式へ移行」ボタンを1つ置き、管理者が押すと
roster を players サブコレクションへ書き出してからボード本体の `roster` を空にする、という一度きりの操作にします。
自動移行にしないのは、失敗したときに何が起きたか分からなくなるのを避けるためです。
移行前に必ず JSON バックアップを取る導線も同じ場所に置きます。

---

## 3. トークン発行方式の判断

### 前提: カスタムトークンとは

Firebase Auth のカスタムトークンは、**サービスアカウントの秘密鍵で RS256 署名した JWT** です。
Cloudflare Worker の WebCrypto（`crypto.subtle`）で署名できるので、
Firebase Admin SDK を使わずに Worker 単体で発行できます。

```
header : { alg: "RS256", typ: "JWT" }
payload: {
  iss / sub : <サービスアカウントのメールアドレス>,
  aud : "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
  iat : now, exp : now + 3600,          ← 最大1時間
  uid : "discord:123456789012345678",
  claims : { admin: true, discordId: "...", adminUntil: <epoch> }   ← カスタムクレーム
}
```

クライアント側は `firebase.auth().signInWithCustomToken(token)` を呼ぶだけ。
以降、`request.auth.token.admin` がルールから参照できます。

### 検討した3案

| 案 | 仕組み | 判断 |
|---|---|---|
| A. フラグメント直渡し | `/auth/callback` の `#dc=` ペイロードにカスタムトークンを同梱 | ❌ 1時間有効な認証情報がURL（＝ブラウザ履歴）に残る。しかも一度サインインすればリフレッシュトークンで無期限に延命できてしまうため、漏洩時の被害が「1時間」で済まない |
| B. 一回限りコード＋KV | 短いコードをKVに保存し、POSTで交換 | ⭕ 安全だが Workers KV の設定が増え、結果整合性（書いた直後に読めないことがある）を踏む可能性がある |
| **C. 短命チケット（HMAC署名）** | Workerが**自分の秘密鍵でHMAC署名した2分有効のJWT**をフラグメントで渡し、クライアントがPOSTで交換 | ✅ **採用** |

### 案Cを採る理由

- **ステートレス**。KVもDurable Objectも不要。Worker の実装追加は30行程度。
- チケット自体は Firebase の認証情報ではないので、漏れても**2分後にはただの文字列**になる。
- 交換エンドポイント（`POST /auth/firebase`）は Origin チェックを掛けられる。
- 案Bの結果整合性の落とし穴を踏まない。

### フロー

```
[参加者]                [Worker]                      [Discord]      [Firebase]
   |                       |                              |              |
   |-- /auth/login ------->|-- 認可画面へ 302 ----------->|              |
   |                       |<-- code ---------------------|              |
   |                       |-- token交換・/users/@me・ロール解決 -->      |
   |                       |                                             |
   |<-- 302 <return>#t=<チケット(HS256, exp=+120s)> ------|              |
   |                       |                                             |
   |-- POST /auth/firebase { ticket } -------------------->|             |
   |                       |  チケット検証 → プロフィール＋              |
   |                       |  カスタムトークン(RS256署名)を返す          |
   |<----------------------|                                             |
   |                                                                     |
   |-- signInWithCustomToken(customToken) ----------------------------->|
   |<-- IDトークン（claims: admin, discordId を含む）--------------------|
   |                                                                     |
   |-- Firestore 読み書き（ルールが claims を見て判定）---------------->|
```

**副次的な利点**: 現在フラグメントに載っているプロフィールJSON（アイコンURL・ロール一覧）も
交換レスポンス側に移せるので、URLが短くなり、ロール一覧がURL履歴に残らなくなります。

---

## 4. 管理者判定をどこで行うか（重要な変更）

**現在**: `config.js` の `admins` をブラウザが読んで判定 → **クライアントを信用している**
**変更後**: **Worker が判定し、カスタムクレームに焼き込む** → サーバーが判定する

これが今回の一番大きな意味の変化です。`config.js` の `admins` は公開リポジトリに置かれる
ただのJSONなので、書き換えれば誰でも管理者になれます（画面側のロックは所詮飾り）。
判定を Worker に移すことで初めて本物の権限になります。

Worker 側の環境変数:

```
ADMIN_DISCORD_IDS = "123456789012345678,987654321098765432"
ADMIN_ROLE_IDS    = "運営ロールのID"
```

- Riot ID による指定は**サーバー側判定からは外す**ことを推奨します。
  Riot ID は本人がログイン画面で自由に入力する文字列で、Worker は「その人が本当にそのRiotアカウントの
  持ち主か」を検証していません（`/account` は存在確認しかしていない）。
  つまり誰でも `Mo10C#819` と打てば管理者になれてしまいます。
  **Discord ID か Discord ロールだけを管理者の根拠にしてください。**
  → `config.js` の `admins.riotIds` は**画面表示のヒント用途に格下げ**、または削除。

> これは現行 v2.1 の設計にも当てはまる指摘です。今すぐできる緩和策として、
> `config.js` の `admins.discordIds` に自分のIDを入れ、`riotIds` は空にしておくのを勧めます。

### クレームの寿命問題

カスタムクレームは**サインイン時点の値がセッション中ずっと保持**されます
（IDトークンが自動更新されてもクレームは変わらない）。
つまり **ロールを剥奪しても、その人が再ログインするまで管理者のまま**です。

対策として `adminUntil`（epoch秒）をクレームに含め、ルール側で有効期限を見ます:

```
function isAdmin() {
  return request.auth != null
      && request.auth.token.admin == true
      && request.auth.token.adminUntil > request.time.toMillis() / 1000;
}
```

`adminUntil = now + 7日` にしておけば、権限の取りこぼしは最長7日で自然解消します。
運営メンバーは大会のたびにログインし直すので、実運用上の負担はありません。

---

## 5. Firestore ルール（案）

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function isAdmin() {
      return signedIn()
          && request.auth.token.admin == true
          && request.auth.token.adminUntil > request.time.toMillis() / 1000;
    }

    // ---- 既存リーダーボード（別アプリ）は触らない ----
    match /boards/{id}       { allow read, write: if true; }
    match /board_index/{id}  { allow read, write: if true; }

    // ---- ログイン式リーダーボード ----
    match /lboards/{bid} {
      allow read:  if signedIn();
      allow write: if isAdmin();

      match /players/{uid} {
        allow read:   if signedIn();
        allow create: if isAdmin() || request.auth.uid == uid;
        allow update: if isAdmin() || request.auth.uid == uid;
        allow delete: if isAdmin();
      }
    }

    match /lboard_index/{id} {
      allow read:  if signedIn();
      allow write: if isAdmin();
    }
  }
}
```

### 付随して必要になる変更

- **`upsertIndex()` を管理者のみに制限**。現在は `init()` の中で全員が呼んでいるため、
  上のルールを入れると一般プレイヤーのコンソールに permission-denied のエラーが出続けます。
  `if (!actor.isAdmin) return;` を先頭に足す。
- **各HTMLに `firebase-auth-compat.js` を追加**（`<script src=".../firebase-auth-compat.js">`）。
- **`login.html` のフローに「Firebaseサインイン」を挟む**。
  失敗したらボードに入れないので、エラー表示を明示的に用意する。
- **未サインイン時の挙動**: `read` もログイン必須にしたので、セッション切れ時は
  `onSnapshot` がエラーになります。`login.html` に飛ばす導線を `init()` のエラーハンドラに入れる。

### 残る穴（許容する）

- 一般プレイヤーは**自分の players ドキュメントを自由に書ける**ので、
  自分のランクを CHALLENGER と詐称したり、表示名を変えたりできます。
  管理者の `nameLocked` も自分で外せます。
  → 実害は表示だけ（得点計算には影響しない）ので**許容**。
  気になるならルールでフィールド単位の検証を足せますが、ランクはWorker経由で取得した値なので
  厳密にやるならランク更新も Worker 経由にする必要があり、費用対効果が悪い。
- `signedIn()` = Discordログインさえ通れば読める、なので**サーバー外部の人も読める**（招待リンクが漏れた場合）。
  ギルド未参加者を弾くなら、クレームに `inGuild` を足して `read` の条件に入れる。

---

## 6. 作業量の見積もり

| 項目 | 規模 | 備考 |
|---|---|---|
| Worker: RS256署名・カスタムトークン発行 | +90行 | `crypto.subtle` でPKCS#8を読んで署名 |
| Worker: チケット発行・検証（HS256） | +30行 | ステートレス |
| Worker: 管理者判定 + `/auth/callback` 改修 | +40行 | 環境変数から判定 |
| `core.js`: roster サブコレクション分離 | **大** | Store のほぼ全面改修。ここが山場 |
| `core.js`: Firebase サインイン処理 | +40行 | |
| `login.html` / `index.html` / `editor.html` | 各 小〜中 | auth SDK追加、サインイン導線、エラー処理 |
| `editor.html`: 新形式への移行ボタン | +50行 | 一度きりの操作 |
| Firestore ルール差し替え | 小 | |

新たに必要なシークレット:

```
npx wrangler secret put FIREBASE_SA_EMAIL        # サービスアカウントのメール
npx wrangler secret put FIREBASE_SA_PRIVATE_KEY  # PEM（-----BEGIN PRIVATE KEY----- ...）
npx wrangler secret put TICKET_SECRET            # チケット署名用のランダム文字列
```

サービスアカウントの鍵は Firebase コンソール →
プロジェクトの設定 → サービスアカウント → 新しい秘密鍵を生成（JSONがダウンロードされる）。
**このJSONはリポジトリに絶対に置かない**（Worker のシークレットにのみ入れる）。

---

## 7. やらない判断

以下は今回のスコープから外します。

- **Firebase Auth の Discord プロバイダ連携**: Firebase は Discord を標準サポートしていないので、
  結局カスタムトークンになります。遠回りなだけ。
- **Workers KV / Durable Objects の導入**: 案Cで不要になったため。
  将来「監査ログ」を持つなら、そのときに Firestore 側のコレクションで持てば足ります。
- **Riot ID の所有権検証**: TFTのプロフィールアイコンを指定のものに変更してもらう等の
  確認フローが必要で、コミュニティ内大会には過剰。Discord ID を権限の根拠にすれば不要。

---

## 8. 進めるときの順番

1. Firebase サービスアカウント鍵を用意し、Worker にシークレット3つを登録
2. Worker にカスタムトークン発行を実装 → `/auth/firebase` を curl で叩いて JWT が返ることを確認
3. `core.js` を roster サブコレクション対応に改修（**ルールは緩いまま**で先に動作確認）
4. `editor.html` に移行ボタンを付け、既存ボードを新形式へ移行
5. **最後に** Firestore ルールを差し替える（ここで初めて締まる）

> 3と5を同時にやると、動かないときに「コードのバグ」か「ルールで弾かれた」かの切り分けができません。
> **ルールの差し替えは必ず最後**にしてください。
