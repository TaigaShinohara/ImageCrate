# 保存先とフォルダ名 — 2026-10-31

本人依頼: 保存する場所と、画像をまとめるフォルダの名前を指定したい。実装まで行い、使いやすい形を目指す。対象はImageCrateの保存導線だけとし、収集・フィルター・公開は範囲外。

コンセプト: 選んだ画像を、意図した場所と名前でまとめて残し、実際の結果を確認して終える。

## 設計と比較

既存の選択→保存は手順が少ないため維持。毎回の保存先選択を必須化せず、footerの保存先表示＋「変更」に設定を統合する。毎画像のsaveAsは大量保存の負担が大きいため不採用。Chrome全体の設定変更は拡張専用の保存先指定にならず不採用。名前だけの追加では今回の依頼を満たさないため、任意フォルダへ直接保存する方式を追加した。

詳細はnative dialogへ分離し、保存先→まとめる名前→実保存先プレビューの順に示す。viewport内で高さを制限し、本文scroll中も閉じる操作に到達可能。Escapeで「変更」へfocusを戻す。普段は従来の最短導線を維持し、任意先は最後の場所を端末内で記憶する。初回・反復の使いやすさ向上は設計意図で、人間の理解・テンポは未評価。

Chrome設定先では `ImageCrate/入力名`、任意先では `選択したフォルダ/入力名`。空欄はページ名、安全化後をプレビュー。日本語・絵文字を分断せず160 UTF-8 bytes / 90 codepoints以内。フォルダ名を二度安全化しても変化しない。同名ファイルは連番suffixで区別し、既存画像を上書きしない。

## 状態と技術条件

- 開始時に対象URL、保存先、フォルダ名、batch IDとjob IDを固定。再試行も元batch先で中断分のみ。成功分は選択解除し、意図的な再選択は再保存可能。
- Chrome downloadsは従来どおりworkerで追跡し、タブ閉鎖後も受理済みbatchを継続する。
- File System Access方式は作業ページでfetch→stream write→closeし、close成功後のみ完了。workerの寿命と全体serial queueを長時間writeで拘束しないため、この方式だけタブ保持を保存前から表示する。beforeunload警告、再読込後の中断回復、旧instance/jobからの遅い更新拒否を実装。
- フォルダpickerはclick直下。キャンセルは前設定保持。復元したhandleの書込許可が必要なら別clickで再接続。retryのフォルダ再許可とsite許可を一度のclickに重ねない。
- handleはIndexedDBにlast/session/batch別で保存。不要handle整理はworkerのmutation queue内で最新のsession一覧から行い、別タブの新batchを古いsnapshotで消さない。
- 常時hostアクセスは追加しない。HTTP/S optional host宣言から、選択URLの具体hostだけを保存clickで要求する。ワイルドカードhostを含む画像URLは拒否し、全サイトrequestへ拡大させない。Cookie値・debugger・webRequestの取得権限は追加しない。許可はChrome管理で保持され、設定から取り消せる。
- 同名判定からwrite確定までorigin共通Web Lockで拡張内の同時保存を直列化。HTTPエラー・HTML/JSON/XML応答・空body・30秒無進捗を中断扱い。失敗時は自分で新規作成した空ファイルだけ後片付けし、既存/置換/非空のファイルは削除しない。外部アプリによる同時編集の完全な排他は保証できない。

## 独立審査と開始判断

concept-driven-uxを使用。正本Page読取ツールが提供されていないため、同梱manual-snapshotとreview-protocolの必要章を参照（最新版差分未確認）。プランナー・技術担当の独立設計審査、artistのv2再審査を実施。artist UI-01〜04（高さ、正確な保存先、batch固定、安全化preview）はnative dialogと具体仕様で解消し、対象L1/L2/L3の実装開始可と判定。主担当ディレクターがこの範囲の実装を承認。

実装の独立コード審査では、handle整理競合・retryのuser activation切れ・予約名と先頭空白dotの安全化非冪等を指摘。worker内の最新一覧による整理、二段許可の別click化、安全化の順序とbyte予算修正を採用。検証結果と残件はQA.mdへ記録する。

技術根拠: [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)、[optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。実OS picker・実サイトの認証/リダイレクト・人間の体験は自動試験の合格へ含めない。
