TFT BOOTCAMP — UI v6

HOME・ログインを、全幅のメインビジュアルと大きな見出しを使ったゲームサイト形式へ再構成しました。
既存の水色・白・ゴールドを継続し、ダークテーマにも対応しています。

主な変更
・HOME / ログインの構成を刷新。雲海のアリーナ、新しいワードマーク、見出し、参加導線を追加。
・HOMEは大きなメニュー入口＋縦型のリンク一覧。表示順、公開設定、準備中、ロール制限は従来の設定を反映。
・プレイヤー情報をコンパクトな横帯へ変更。
・大会、LP、予定表、メンバー紹介、管理画面に共通のヘッダー・タイトル帯を適用。
・スマホはメインビジュアル→タイトル→操作の順に最適化。動きを減らすOS設定にも対応。

反映するファイル
8画面: home.html / login.html / boards.html / index.html / lp.html / members.html / schedule.html / editor.html
共通: portal.css / portal.js
素材: assets/portal/ フォルダ
既存のassetsフォルダは残し、その中にportalフォルダを追加してください。
config.js、core.js、home-common.js、ui.css、worker.js、wrangler.jsoncは元ZIPから変更していません。
前版で補完したLP画面のrenderNote関数を維持しています。

プレビュー
UI-preview.html: ログイン不要の外観確認用。表示名・ランクはサンプルです。
プレビューはサーバーのデータを取得・更新しません。メニューリンクは画面内に移動します。
UI-preview-desktop.png / UI-preview-mobile.png / UI-preview-dark.png: 表示例。
本番ページでは元のログインと接続設定が必要です。

検証
ローカルのサンプルセッションで8画面＋プレビューを確認。
PC 1440px・スマホ390pxでページ全体の横はみ出しなし、未捕捉JavaScript例外なし。
ローカル管理者テストデータで管理画面の表示を確認。
プレビューのCTA移動とテーマ切替を確認。元の要素IDを保持。
外部通信は遮断して検証したため、本番認証・Firebase同期・通知送信は未検証です。

画像・フォント
assets/portal/sky-arena.webp: サイト用に新規生成した背景。WebPで約350KB。
生成方式と最終プロンプト: assets/portal/ARTWORK-NOTES.txt。
欧文見出しフォントは同梱。ライセンス: assets/portal/FONT-LICENSE.txt。
