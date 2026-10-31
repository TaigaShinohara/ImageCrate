# QA — v0.1

以下の実施結果と、未実施の手順を区別します。

## 自動確認

- Node単体テスト: ファイル名、URL制限、配信形式分類、寸法フィルター、再スキャン統合、download状態の集計。
- 静的確認: MV3 manifest、権限、参照ファイル、全モジュールの構文。
- 隔離Chrome: localhost合成ページのみ。テストコピーに限定host権限を付与。配布manifestと個人プロファイルは変更しない。
- 画像: DOM・背景・srcset・open shadow・同origin frame、未選択開始、非表示選択込み保存、完了後選択解除、再スキャン、新規画像、中断と再試行。
- 動画: 直接ファイル/配信候補区別、実download、合成capture入力→実MediaRecorder→pause/resume/stop→全track停止→Blob保存、pickerキャンセル相当、360px横overflow。

## Chromeで実際に触る

1. extension/を読み込み、通常ページで拡張アイコンを押す。設定ページやWeb Storeで失敗理由が表示されることも確認。
2. 初回: 対象と次の操作が説明なしでわかるか。画像の選択3件のうち1件をフィルターで隠し、3件保存されることと件数表示を確認。
3. 反復: 成功分が選択解除され、中断分だけ再試行されること。再スキャンで追加分が未選択なこと。
4. 元ページを別originへ移動/閉じて再取得し、既存候補は残り再操作の案内が出ること。
5. 動画の元タブ録画を開始し、音声あり/なし、ブラウザ共有停止、元タブ終了、一時停止/再開を確認。完成WebMを再生する。
6. 画面/ウィンドウ/タブの共有picker、保存先pickerの各キャンセルで前回結果が残ること。OSの権限拒否から復帰する。
7. 順次保存を選び短い録画を保存。停止後の書込確定、遅い保存先、書込失敗で不完全ファイルの案内が出ること。
8. 複数作業タブ/worker再起動/作業タブ更新で録画排他と古いlock回収を確認。録画中の閉鎖警告を確認。
9. 30分・容量閾値、背景タブ、メモリ/ディスク使用量、OS音声を実環境で確認。
10. keyboard、スクリーンリーダー、360px、zoom200%、読みやすさ、初回と反復の判断の負担を人間が確認。

ブラウザ自動試験が通っても、実機OS picker・実音声・長時間動作・人間の理解は未確認として残します。


## 実施結果 — 2026-10-30

- `npm test`: 12件PASS / 1件対象外SKIP（動画録画lockのテスト）。
- `npm run check`: manifest・権限・ローカル参照・全JavaScript構文PASS。ビルド不要の構成のためbundle buildはありません。
- `npm run test:browser`: macOS上の隔離Chrome 156.0.8078.79 / Playwright 1.64.1 / localhost合成fixtureでPASS。
- 画像版: 画像・CSS背景・srcset・open shadow・同origin frameの取得、最初は未選択、非表示選択を含む一括保存、完了時の選択解除、再スキャン、新規画像追加、403応答による中断・中断分だけ再試行、360pxの横overflowなしを確認。
- 動画版: 元WebMの直接保存と配信候補の区別、合成display streamを実MediaRecorderで録画、pause/resume、stop、全track停止、未保存録画の置換防止、実download完了、完成WebMの再生、共有キャンセル相当で前回結果保持を確認。360×800で固定Stop操作がviewport内にあることを確認。
- 実際の拡張Service Workerを停止し、異なる起動IDで再起動したことと、作業ページ再読込後の候補・download結果復帰を両製品で確認。
- Chrome API mockで作業タブ閉鎖後batch継続・cancel直前complete保持、動画版ではnavigate済ownerからのlock回収を確認。
- 録画の集中テストでactivation順、失敗時の全track停止、順次write→最後のchunk→close、書込失敗、ブラウザ共有停止、pause時間、download中断後の再試行、出力pickerキャンセルを確認。

上記の他製品に関する記述は同日に別リポジトリで行った関連検証です。このリポジトリの実機能として混同しません。

初回自動検証時点の未実施（下記追試で一部確認）: 通常Chromeへのインストール/toolbar activeTab許可操作、実サイトでの互換性、実macOS picker/画面収録許可、実タブ・システム音声、30分・容量閾値・背景長時間の実測、スクリーンリーダー、利用者による体験評価。これらを公開前の確認として残します。


## 通常Chromeでの実サイト追試 — 2026-10-30

初回自動検証の後、本人の明示依頼で通常利用中のChromeに、正本のextension/を「パッケージ化されていない拡張機能」として読み込んだ。広いhost権限を足したテストコピーではない。デベロッパーモードは既にONだった。

ブラウザー操作ツールは拡張専用のchrome-extension:// URLへのアクセスを拒否し、他の操作経路での迂回も禁止した。このため拡張内の選択・録画・停止・保存操作は本人が行い、Codexが保存後の明示されたローカル成果物を解析した。AIが拡張内を自律操作できたという結果にはしない。


- 対象: https://en.wikipedia.org/wiki/Big_Buck_Bunny
- ChromeツールバーのImageCrateを押す、作業タブが開くところまではCodexが操作。
- 追試成果: 本人操作で選択保存されたWikipediaロゴSVG 2件を、当拡張のページ別downloadフォルダで確認。115,918 bytesと9,865 bytes。
- XMLを解析し、両方のルートがsvg、viewBoxが有効で、描画要素を持つ画像であることを確認。HTML等のエラー応答ではない。
- この2件について、通常Chromeの実activeTab導線→選択→保存までの代表動作を確認できた。画像選択UIの全操作・他形式・他サイト・全画像取得を保証する結果ではない。
- 残件: 他サイト、写真形式、サイト固有の認証/Referer/遅延読み込み、スクリーンリーダー、使いやすさの継続評価。

## UI整理の検証 — 2026-10-31

- `npm test`: 12 PASS / 1 SKIP（関連する動画製品用の既存対象外テスト）。`npm run check`: PASS。buildless構成を維持し、権限・runtime依存を追加していない。
- 隔離Chrome / localhost合成fixtureの`npm run test:browser`: PASS。従来の取得・選択・非表示選択込み保存・成功分解除・再スキャン・中断再試行・worker再起動に加え、以下を確認。
- 条件/使い方をEnterで開閉、Escapeで閉じsummaryへfocus復帰、開閉状態のaria同期。閉鎖中の有効条件数とチップ、個別解除時のfocus保持、全条件リセット、0件から復帰。native checkboxのSpace選択と画像情報/保存状態の関連付け。
- 360pxの2列、横overflowなし、保存ボタンがviewport内、末尾画像はスクロールでfooter上に到達。640 CSS px（1280pxの200%拡大に相当するreflow幅）も確認。実ブラウザのzoom操作自体とは区別する。
- 開いた条件欄の入力矩形・44px以上の高さ・viewport/パネル内配置・入力同士の非重複・検索行との非重複をdesktop/640px/360pxで確認。検索欄が開閉で縮んでいた初回表示を修正し、検索幅維持も再試験PASS。
- reduced-motionで開閉/カードの演出停止、forced-colorsでnative checkboxと選択outlineを確認。スクリーンリーダー実機の確認とは区別する。
- テスト専用sessionに500件の合成候補を一時注入し、5系列の連続検索・件数・focus保持・カード入場アニメなしを確認。ローカル計測例は5 / 3 / 1 / 0 / 8ms（同期処理、丸め値）。別環境の性能保証や人間の操作時間ではない。
- 変更前後の同じ合成fixtureで常設説明と条件欄が減り、通常状態のグリッド開始が504pxから365pxへ前進。理解・読みやすさ・快適さの改善は人間未確認。

今回の残件: 新UIを通常Chromeで再読込し、初回/反復の選択→絞込→非表示選択込み保存→結果確認を本人が試す。特に条件の見つけやすさ、保存対象の理解、文字の読みやすさ、動きのテンポ、スクリーンリーダーを確認する。実サイトの互換性の残件は継続。

## 保存先・フォルダ名の指定 — 2026-10-31

- `npm test`: 32 PASS / 1 SKIP（既存の関連動画製品用テスト）。Chrome既定先の名前指定、任意先batchのowner/更新/停止/閉鎖/再読込、元の先への中断分再試行、ファイル非上書き、close確定待ち、通信/書込失敗、空応答、30秒無進捗、同時保存、日本語/絵文字/予約名、安全化の冪等性、具体hostだけの許可要求を確認。
- `npm run check` と `git diff --check`: PASS。Chrome116+ / MV3 / buildlessを維持。常時host権限・Cookie・debugger・webRequest・実行時ライブラリは追加していない。HTTP/S optional host宣言を追加し、保存対象の具体hostだけを任意方式の保存clickで要求する。
- `npm run test:browser`: 隔離Chrome156.0.8078.79 / Playwright1.64.1 / localhost合成画像でPASS。通常の収集/選択/非表示選択込み保存/解除/再スキャン/中断再試行/worker再起動/500件検索も回帰確認。
- 新規UI: dialogのkeyboard移動・Escape・閉鎖後focus、空名のページ名補完・安全化preview・リセット、確定時の設定保存、任意名を渡したChrome downloadの実完了とSVG内容を確認。CDPのdownloadPath制御が拡張の相対フォルダ/ファイル名を上書きするため、通常方式はAPIへ渡した相対pathの完全一致と実ファイル内容の検証に限定。通常Chromeで今回の新しい任意名を物理サブフォルダに作る操作は未実施。
- 任意先: OS pickerだけを境界で差し替え、実際のOPFS DirectoryHandleを使用。IndexedDBへのhandleのstructured clone、実fetch→stream→File System Access write→close→SVG内容、再選択保存でsuffix付与と旧ファイル保持、再読込後の場所/名前復元を確認。配信元の許可拒否・復元handleの許可拒否は権限API境界を差し替え、選択/旧設定/batch保持と無書込を確認。実OSの許可操作とは区別する。
- 実fetchを先頭chunk後で止め、Stop→自分の未完成ファイルの後片付け→設定名変更→元batchの場所へretryを確認。別の保存でbeforeunload警告を受け入れて再読込し、未完了を中断へ回復→retry→実ファイル完成まで確認。
- 640 CSS pxと360×800で長い日本語名・custom説明・batch表示が共存し、横overflowなし、保存ボタンとfooterがviewport内、dialogの全文折返し・sticky閉じる・scrollによる確定操作への到達を確認。スクリーンショットも主担当が目視。実ブラウザzoom操作・スクリーンリーダー・人間の理解や快適さは未評価。
- 独立設計審査とコードレビューを実施。handle整理の別タブ競合、二段許可のuser activation、preview/実pathの安全化差、確定直後reloadと確定中再編集を修正。最終コードレビューで対象範囲の未解決指摘なし。

残件: 通常Chromeで拡張を再読込し、実OS folder pickerで任意の場所を選んで画像を保存する代表試験。実際の書込権限の拒否/再許可、サイト固有の認証/リダイレクト、外付け/ネットワーク保存先、スクリーンリーダー、本人の理解・操作感は未確認。強制終了等で後片付けが走らない場合は、未完成の空ファイルが残ることがある。既存の完成ファイルは上書きせず、新しい名前で再試行する。

## 保存形式の選択と実変換 — 2026-10-31

- `npm test`: 58 PASS / 1既存対象外SKIP。変換上限/拒否/timeout/Stop/遅延decoderの解放、要求MIMEと拡張子、JPEG白背景、alpha保持、SVG自然寸法fallback、Blobの非上書き保存、形式と保存先のbatch固定を確認。worker mockでBlobの受理/owner/job、downloadIdの保持、cancel直前complete、reload/close/worker再起動、Chrome確定前のretry拒否と元URLの無断開始防止を確認。
- `npm run check` / `git diff --check`: PASS。manifest・実行時依存・ビルド不要の構成を維持し、新しい権限は追加していない。
- 隔離Chrome156 / Playwright1.64.1の`npm run test:browser`: PASS。合成の透明PNGをJPEG/PNG/WebPへ実変換し、生成BlobのMIME・magic bytes・16×12の寸法・赤色内容・JPEGの白背景・PNG/WebPのalphaをdecodeし直して確認。同形式の元データ末尾に付けた合成markerが再エンコード後に残らないことも確認。
- 各形式を実OPFS folderへ書込し、さらにChrome既定先にも実download。固定されたjob拡張子と、Chromeの完了・MIME・実ファイル内容の形式/寸法/画素を確認。CDPが物理basenameを変更する制約は従来と同じで、通常Chromeの物理pathそのものの追試とは区別。
- 2frameの合成GIFは元形式で全byteと2frame保持。PNG変換では複数回同じ最初の赤frameになることと実保存を確認。SVGを自然寸法で実ラスタ化。壊れた画像は両保存先で中断し、原形式の無断fallbackファイル/downloadが作られないことを確認。
- PNGで失敗したbatchの後に次回設定をJPEG/別名へ変え、retryが元のPNG・元の場所を使うことを実保存で確認。変換＋Chrome先でも具体hostだけを要求し、API境界の拒否でbatch不変・選択保持を確認。
- 独立設計/コード審査でFMT-01〜03の管理主体・Blob終端・MIME/静止画規則を具体化。未対応形式のprototype名、controller終了前retryの競合を修正し、最終コードレビューの対象範囲で未解決指摘なし。
- 変換したChrome downloadのURLとBlob URLを対応させ、実complete後にURLが解放されることを観測。長い日本語名・JPEG変換・任意先・完了batchの共存状態で、640/360×800のfooter Save/Change・形式/条件表示・dialog/selector領域・横overflowなし・Escape後focus復帰を確認。主担当が同条件の画面も目視した。

残件: 実サイトの認証/配信元制限とリダイレクト、実OS folder picker・書込先、実Chrome116での追試、利用者が保存形式を見つけ選択できるか・変換結果を理解できるかの体験評価。native decoder内部の一時メモリ割当上限は測定・保証していない。変換は端末内で実施し、新しい変換サービスへの外部送信は追加していない。
