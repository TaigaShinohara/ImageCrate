# QA — v0.1

## Safari Web Extension (iOS / macOS) への適合・Xcode構成とモバイル自動選択 — 2026-11-03

- 本人指示「フェーズ3に進んで」を受け、iOS Safari / macOS Safari へのWeb Extension適合、Xcodeプロジェクト生成、モバイル環境向け保存先自動選択を実装・検証。
  - `extension/background.js`: `chrome.downloads` リスナー（`onChanged`, `onCreated`, `onDeterminingFilename`）をオプショナルチェーン化し、Safari等の未定義環境でも例外なくService Workerが起動するよう防御。
  - `extension/workspace.js`: モバイル端末（タッチ・UA）および `downloads` API 非存在環境を自動検知し、デフォルト保存先として `destination: 'zip'` を自動採用。ダウンロードAPI非対応環境では `destination-downloads` を無効化。
  - `scripts/safari-convert.mjs` / `npm run safari:convert`: `safari-web-extension-converter` を呼び出し、`safari/ImageCrate` に iOS/macOS 両対応の Xcode プロジェクトを生成。`extension/` フォルダのソースを直接相対参照する構成で、コードの二重管理を防止。
  - `scripts/check.mjs`: Safari互換性チェック（リスナーオプショナルチェーン確認、変換スクリプト構文検査）を追加。
- `npm test`: **351 PASS / 既存対象外1 SKIP**。
  - `tests/safari-compat.test.js`: `chrome.downloads` が完全に undefined の Safari 環境シミュレーションでの background 健全起動、モバイル/非対応環境での `zip` 自動判定、ZIP保存先ラベル生成の全件通過（PASS）。
- `npm run check`: **PASS**（manifest, CSP, ローカルモジュール参照, Safari互換性, JS構文検証OK）。
- `npm run safari:convert`: **PASS**（Xcodeプロジェクト生成・相対リソース参照確認OK）。
- `npm run test:browser`: **PASS**（全ジオメトリ、フィルター操作、保存ダイアログ回帰確認）。
- `npm run test:ux`: **29項目PASS**（全29項目正常通過、プレビュー読み込み時のタイムアウト要因解消確認）。
- 未確認: 実iPhone実機（iOS Safari）へのXcodeデプロイ・実機動作確認、App Store配布・署名審査。

## モバイル保存エンジン（ゼロ依存ZIP一括保存＆Web Share API共有シート連携） — 2026-11-03

- 本人指示「フェーズ2に進んで」を受け、モバイル環境（iOS/Android）向けのZIP一括保存・共有シート連携エンジンを実装・検証。
  - `extension/zip-writer.js`: 外部依存ゼロの `ZipArchive` クラス（PKZIP 2.0 Store圧縮、CRC-32計算、UTF-8対応）を実装。
  - `extension/web-share.js`: `canShareFiles()`, `shareOrDownloadZip()`, `downloadBlob()` を実装。Web Share API（`navigator.share`）とBlobダウンロードのハイブリッド連携を構築。
  - `extension/workspace.js`: 保存先 `zip` のUI選択、元形式画像Blob抽出（`readOriginalBlob`）、ZIPへの段階的追加、共有呼び出しを統合。
- `npm test`: **348 PASS / 既存対象外1 SKIP**。
  - `tests/zip-writer.test.js`: CRC-32算出、複数ファイル格納、UTF-8ファイル名、および OS の `unzip -t` コマンドによるバイナリ整合性検証（PASS）。
  - `tests/web-share.test.js`: Web Share API呼び出し、ユーザーキャンセル（`AbortError`）の安全処理、非対応環境でのBlobダウンロードフォールバック検証（PASS）。
  - `tests/utils.test.js`: `destination: 'zip'` の設定バリデーション・ラベル表示検証（PASS）。
- `npm run check`: **PASS**（manifest, CSP, ローカルモジュール参照, JS構文検証OK）。
- `npm run test:browser`: **PASS**（360px/640px/1280pxの全ジオメトリ、フィルター操作、保存ダイアログ回帰確認）。
- `npm run test:ux`: **29項目PASS**（広告トグル、12000要素境界、高解像度画像、キーボード操作、セッション復元、保存キュー等全件通過）。
- 未確認: 実iPhone/Android実機でのOS共有シート表示、「ファイルに保存」実行後のファイルアプリ内解凍動作、人間の操作感。

## モバイル・タッチUXの最適化（スワイプ前後送り・ダブルタップズーム・親指操作） — 2026-11-02

- 本人指示（スマホからでも体験を落とさずに使えるようにする計画、別ブランチでの進行）を受け、新ブランチ `feature/mobile-ux` にてモバイルタッチジェスチャーと親指最適化UIを実装。
  - 画像確認モーダル（`#image-preview`）に左右タッチスワイプ（前後の画像めくり）とダブルタップ（等倍ズーム切り替え）のジェスチャーを追加。等倍表示中のパン操作を優先する制御とスワイプ後のタップリセットを組み込み、指先でサクサク確認できるように改善。
  - デュアルレンジスライダーのつまみ（ノブ）に 44px×44px の透明タッチターゲット（`::before`）を完備し、モバイル親指でのドラッグ操作性を向上。
  - モバイル画面（幅 <= 480px）でのビューワー幅拡大（`calc(100vw - 16px)`）、ボタン高さ44px以上の確保、フッター保存ボタンの強化（高さ48px以上、太字）、カードタップ時の微細スケールフィードバックを追加。
- `npm test`: **342 PASS / 既存対象外1 SKIP**。スワイプ送り（左右・垂直判定・ズーム中抑制）およびダブルタップズームの単体テストを含む全件通過。
- `npm run check` / `git diff --check`: PASS。
- `npm run test:browser`: **PASS**。360px、640px、1280pxの全ジオメトリ、リフロー、フッター・保存ボタン可読性、デュアルレンジバー操作の回帰を確認。
- 未確認: 実iPhone/Android実機タッチスクリーンでの操作感、iOS Safari Web Extension実環境。

## 画面情報の削減と初心者向け直感UIデザインへの刷新 — 2026-11-02

- 本人指示（画面情報の削減、初心者向け直感UI、別ブランチでの進行）を受け、新ブランチ `codex/simplify-ui` にてUIスリム化と直感化を実施。
  - ギャラリーカード下部の「大きく確認」ボタンをサムネイル右上のオーバーレイ虫眼鏡（🔍）アイコンボタンへ刷新し、カード高さを約40%削減。
  - ファイル名や余計な説明文を抑制し、寸法・形式をコンパクトなピルバッジへ整理。
  - フッターの保存先フルパスをアイコン付きピルへスリム化し、不要なヒント文を整理。
  - 広告除外フィルターにシールドアイコン（🛡️）とトグルスイッチ風の直感的なUIを導入。
- `npm test`: **343 PASS / 既存対象外1 SKIP**。単体テスト全件通過。
- `npm run check` / `git diff --check`: PASS。
- `npm run test:browser`: PASS。
- `npm run test:ux`: **29項目PASS**。360px / 640px / 1280pxジオメトリ、Chrome 200%拡大ズーム、キーボード操作（Space/Tab/Escape）、フィルター操作、プレビュー拡大、保存ダイアログの全チェックを回帰確認。
- 未確認: 実Chrome拡張機能ツールバーからの実サイト操作、実スクリーンリーダー（VoiceOver）での読み上げ、人間の直感的な使い心地。

## 広告除外フィルターの改良：広告の完全除外と元ページ画像の保護 — 2026-11-02

- 本人指示（広告の完全除外と元ページ画像の保護）を受け、広告判定（`adLike`）を大幅に強化。
  - 主要アドネットワーク・DSP（`bance.jp`, `doubleclick`, `googlesyndication`, `criteo`, `adnxs` 等）のホスト名検出、トラッキングビーコン（`imp`, `pixel`, `beacon`, `tracker`, `1x1`, `infomark` 等）の網羅、IAB標準バナーサイズ（728x90, 300x250, 160x600等）の一致を追加。
  - 縦スクロール漫画（Webtoon: `height > width` かつ 幅400px以上・高さ1200px以上）や超高解像度パノラマ（画素数80万px²以上）をコンテンツとして保護し、縦横比3:1以上による誤除外を防止。
- `npm test`: **341 PASS / 既存対象外1 SKIP**。主要アドネットワーク、トラッカー、標準バナーの除外と、Webtoon縦長漫画・パノラマ・通常コミックの保護判定を単体検証。
- `npm run check` / `git diff --check`: PASS。
- 未確認: 実サイトでの表示および本人の操作感。

## 1本のデュアルレンジバーによる最小・最大寸法絞り込みと縦横表記の明確化 — 2026-11-02

- 絞り込みフィルターにおいて、横幅および高さの寸法を1本のバーで最小と最大（〜以上・〜以下）を直感的に操作できるデュアルレンジスライダーを実装。軸別の範囲リセットボタン（`#reset-width`, `#reset-height`）を新設し、見出し・入力ラベル・ヒント文の冗長なテキストを整理してアイコンと図形的なタグ表現で初心者にわかりやすくした。
- `npm test`: **340 PASS / 既存対象外1 SKIP**。`matchesImage` と `candidateMatches` による上限寸法・範囲指定判定、未確認寸法の保持、双方向同期、セッション復元を単体検証。
- `npm run check` / `git diff --check`: PASS。構文・マニフェスト・参照・CSPに問題なし。
- `npm run test:browser`: PASS。360px、640px、デスクトップにおけるフィルターUIの表示、軸別範囲リセットボタン操作（`reset-width` 連動）、デュアルレンジバー操作（キーボードArrow/Home、チップ解除、全体リセット連動）、入力、フッター上の表示位置、タッチターゲット（全要素44px以上）、重複ゼロを確認。
- `npm run test:ux`: **29項目PASS**。360px/640px/1280pxのジオメトリ、フィルター開閉、スクロール位置、拡大・プレビュー自動取得、セッション保存と復元を回帰。
- 未確認: 実端末のタッチスクリーン操作、実スクリーンリーダー（VoiceOver）による音声読み上げ、通常利用中Chromeでの本人の使用感。


## 広告フィルターの初期ONと計測タグ（imp）除外 — 2026-11-02

- 本人指示（広告パーツの初期除外、imp除外）を受け、「広告らしい画像を除外」設定を初期ONに変更し、URLパス末尾が `imp` の計測タグを広告候補（`adLike`）判定に追加した。
- `npm test`: **338 PASS / 既存対象外1 SKIP**。`isAdBeacon` によるURL判定（クエリパラメータ付き・拡張子付き・大文字小文字対応、`important` 等の誤判定防止）、初期ON状態でのセッション独立性とシリアライズ復元、フィルターチップ表示を検証。
- `npm run check` / `git diff --check`: PASS。
- 実サイトでの見え方と本人の使用感は未確認。

## Liquid Glassアイコン — 2026-11-02

- 内蔵画像生成ツールで原本を作成し、1024pxと16／32／48／64／128pxのRGBA PNGを書き出した。manifestの拡張・actionアイコン、作業画面のヘッダー、faviconへローカル画像を設定。権限・CSP・外部通信の変更なし。
- 最新main（起動時の追加許可要求削除を含む）で`npm test`: 337 PASS / 1既存対象外SKIP。`npm run check` / `git diff --check`: PASS。
- 隔離Chrome 156.0.8078.80で正本manifestのコピーを読込。manifestの参照、ヘッダー38 CSS px／原画像128px、16／32px faviconの実decode、1280／360px幅の横overflowなし、pageerror 0、CSP違反0を確認した。作業画面はsessionなしで直接開いたため、既存の「作業情報が見つかりません」状態での表示確認。
- 明暗背景の16／32／48／64／128px比較と360px画面を主担当が目視。独立担当がローカル参照・寸法・装飾画像の空alt・権限不変を点検し、修正必須の指摘なし。結果と画面は `/private/tmp/imagecrate-icon-qa/`。
- 通常Chromeへの再読み込み、実toolbarでの見え方と本人の採否は未確認。既存の保存処理やOS pickerの実操作をこの検証で確認したとは扱わない。

## 起動時の追加許可を自動要求しない — 2026-11-02

本人の依頼に合わせ、下のCDN初回プレビューで追加した起動前probeと一括許可要求を削除。拡張アイコンから作業ページを直接開き、未許可画像は既存の明示的な表示操作から許可する。保存時に必要な配信元許可とmanifestは変更していない。

- `npm test`: **337 PASS / 既存対象外1 SKIP**。実backgroundのtoolbarハンドラーで、未許可CDNがある条件の作業ページ作成・再利用と、起動前の権限照会・要求・DOM probeがすべて0回であることを確認。起動の連打・別タブ・同期/非同期失敗後の再操作も確認。以前のprobe専用テストは削除した処理に合わせて置換。
- `npm run check` / `git diff --check`: PASS。独立コード審査で今回範囲の未解決must-fixなし。
- 隔離Chrome156.0.8078.80の `test:security`: **18項目PASS、pageerror 0**。未許可/拒否後の取得ゼロ、一覧からの配信元別許可と5枚の表示、既存許可/元ページアクセス/dataの自動表示、元形式保存、取得/形式失敗の再試行を回帰。起動時promptゼロは実backgroundのAPI境界回帰で確認し、このブラウザ試験の作業ページ直開きを実toolbar確認と扱わない。許可取消は既存の必須host grantを使うAPI境界fixture。

結果: `/private/tmp/imagecrate-no-startup-permission-security/security-report.json`。通常利用中のChromeでの拡張再読み込み・実toolbar・添付サイトの本人操作感、今回のChrome116・実VoiceOverは未確認。実OS pickerの確認は今回の変更に含めない。


## 取得・形式失敗と許可待ちの説明 — 2026-11-02

本人回答「上段の項目だけ」により、本文の必要WebPは表示済みと確認。HTTP400や未知/未対応を広告・非画像と断定せず、取得/形式/表示失敗にまで出ていた許可範囲の説明だけを修正した。

- `npm test`: **343 PASS / 既存対象外1 SKIP**。`npm run check` / `git diff --check`: PASS。
- 隔離Chrome156.0.8078.80の `test:security`: **18項目PASS、pageerror 0**。合成HTTP400/503・未知containerで、許可説明非表示、aria-describedby除去、hover titleに許可範囲なし、再試行可能、候補/選択保持、新しい権限要求ゼロを確認。503は実再試行で成功。未許可側は既存fixtureで説明・参照・titleの復帰を確認し、CDN5枚一括表示・取消・資源上限の既存回帰も通過。
- 「元形式で保存できます」は形式検査/画像表示失敗の文脈で「保存を試せます」へ修正し、保存成功を保証しない。独立設計/コード審査でUX-MIX-01（hidden説明のaria/title残存）を解消、対象範囲の新規must-fixなし。取得/decoder/候補分類/保存処理は変更していない。

結果: `/private/tmp/imagecrate-error-guidance-security/security-report.json` と `unrecognized-preview.png`。主担当が合成の失敗画面を目視。実サイトの広告配信元へテスト通信していない。HTTP400・形式未対応そのものを直した結果ではなく、状態の伝え方の修正。今回のChrome116・実VoiceOver・本人の修正後の理解/操作感は未確認。

## 別配信元CDNの初回プレビュー — 2026-11-02

本人の新規CDN5枚の許可待ち報告を起点に、拡張起動時の具体配信元の一括要求と、一覧上部の配信元別許可操作を追加。前節のsame-origin成功を新規CDNの成功へ流用しない。

- `npm test`: **343 PASS / 既存対象外1 SKIP**。stateless probeのsource/URL/要素/仕事量制限、worker側のorigin再検証、既存許可/exact-origin除外、callback合流順、拒否・API例外・timeout・navigation/close・重複/4枠・同時request制御を追加。`npm run check` / `git diff --check`: PASS。
- Chrome for Testing116.0.5845.96・本番と同じmanifest権限・隔離profileで、実ツールバーから起動。未許可の別origin（127.0.0.1ページ→localhost）にある実WebP5枚で、具体CDNだけのnative許可promptが1回出ることを確認。許可後はカード操作なしに5枚を自動表示、選択0、一覧上部の許可案内も非表示。作業タブを閉じて元ページから実toolbarで開き直すと、requestを追加せず5枚を再表示した。主担当が画像を目視。元の実サイトにはテスト通信していない。
- Chrome156.0.8078.80の `test:security`: **16項目PASS、pageerror 0**。同じCDN5枚に対する一覧上部の許可操作1個、再描画で重複なし、拒否後zero-fetch、top/cardの重複要求防止、1回の許可後に5枚自動表示/選択不変を確認。1280/360pxで横overflowなし・44px以上、スクロールでCTA全体がsticky保存footerより上へ到達するgeometryと画面を確認。取消等は既存の明記したAPI境界fixture。
- 同Chromeの `test:browser`: PASS。選択・保存・再読み込み回復・保存優先/drain・実JPEG/PNG/WebP変換・download・metadata/データ保持・500候補を回帰。
- 独立設計/コード審査で対象範囲の再現可能な未解決must-fixなし。callback直結要求、source identity、具体origin、期限切れ/移動後の破棄、slot保持とsummaryの寿命を確認。

結果: `/private/tmp/imagecrate-cdn-security/`、native116: `/var/folders/6s/jk3mxwcn2x98rygsq4qz_mc80000gn/T/imagecrate-cdn-native-116-JDbVR9/report.json` と同階層の `five-automatic-previews.png`。

未確認: 添付の実サイト自体、本人の操作感・実VoiceOver。現行Chrome156の別profileでnative-toolbar試験も起動したが、操作ツールが通常利用中のChromeを選択したため、そのprofileには操作せず試験用processだけを終了した。Chrome156のnative prompt表示は未確認で、自動試験のAPI境界成功と区別する。Chrome116は実native promptを確認済み。worker再起動をまたぐ未着手の軽量probe呼出数は厳密保証外（DESIGN参照）。

## プレビューの初期ON — 2026-11-02

本人指定により、以下の過去記録にある「作業ページごとの同意」を廃止し、既存Chrome許可・元ページの一時アクセス・data画像で自動表示する。Chromeの追加許可がない別配信元だけ、実clickで要求する。

- `npm test`: **331 PASS / 既存対象外1 SKIP**。元ページの所有者/候補/同origin/移動・閉鎖、未許可の取得・権限要求・通知loopゼロ、取消/再許可、同host別port、確認中の権限追加、遅延予約・decoder出力の実解放を待つdrainを確認。`npm run check` / `git diff --check`: PASS。
- Chrome156.0.8078.80の `npm run test:browser`: PASS。自動表示、両labelによる選択、元形式・任意フォルダ・実JPEG/PNG/WebP変換・再試行・metadata/データ保持・500候補UIを回帰。保存中reload後に自動プレビューの実HTTP2件とfetch台帳2枠を保持した状態でRetryし、プレビュー中断→元保存batch完成→実SVGを確認。保存優先をテスト待ちの追加だけで隠していない。
- 同Chromeの `npm run test:ux`: **29項目PASS**。広告候補除外、未確認寸法、別候補/拡大、キーボード、reload、保存設定・handle復元、360/640/1280px、実200%zoom、実alarmと予算付き保存を回帰。自動previewと広告heuristicの元ページ情報検証は、合成responseを保留して区別した。
- 同Chromeの `npm run test:security`: **15項目PASS、pageerror 0**。既存許可/source fallback/dataの自動表示、未許可と拒否後の取得ゼロ、取消時の同期失効・再取得ゼロ・再許可後の復帰、許可再要求なしの通信失敗retry、CSP・redirect・容量/画素上限・中断と解放を確認。取消/再許可はテスト用必須host grantを外せないため明記したAPI境界fixtureで、実optional権限UIとは区別する。
- 実Chrome for Testing116.0.5845.96の `npm run test:compat`: **13項目PASS、pageerror 0**。自動プレビュー、収集/継続/復元、拡大、実保存/変換、metadata、EXIF、GIF静止画、codec workerとledger解放を確認。
- 別の隔離Chrome116・本番と同じmanifest権限で、実ツールバーの拡張メニューからImageCrateを操作した。`permissions.contains(localhost)=false`、永続host追加なしのまま、同一origin合成SVG2件を自動表示、640×480寸法、未選択、`permissions.request`呼出し0、表示操作ボタン0を確認。元ページをabout:blankへ移動すると旧画像が0になることも確認。主担当が自動表示の画面を目視した。個人profileや実サイトを使っていない。
- 独立設計/コード審査で、同host別portの未許可状態、確認中の権限追加、drain前に未確定だった予約と遅延decoder出力のreleaseを修正し、再現harness・回帰試験・再審査で解消。最終の対象範囲に未解決must-fixなし。

結果: `/private/tmp/imagecrate-auto-ux/`、`/private/tmp/imagecrate-auto-compat/`、`/private/tmp/imagecrate-auto-security-final/`。実toolbar試験: `/var/folders/6s/jk3mxwcn2x98rygsq4qz_mc80000gn/T/imagecrate-auto-native-eNe65e/results/report.json` と同階層の `../automatic-preview.png`。過去の本人回答をこの版の使い心地の確認には流用しない。

未確認: 通常Chromeへ修正版を再読み込みした実サイトでの本人操作感、実optional host許可の取消/再許可UI、スクリーンリーダー。native OS pickerの結果は今回の自動表示変更の確認に含めない。

## 情報保持・保存先記憶の制御 — 2026-11-01

対象は保存結果のbasename化・旧session移行、閉鎖済みsource情報の削減、次回用保存先のON/OFF、連絡先と保持説明、合成メタデータ検証。実装・自動検証・実UI・本人試用は分けて記録する。

- `npm test`: **318 PASS / 既存対象外1 SKIP**。POSIX/Windows/UNCの旧jobs/historyの移行、revisionの単調増加、移行失敗後の再試行、新規保存の抑止、閉鎖後の受付回復、IDBの原子的OFF・CAS競合・旧記録・破損記録を確認。`npm run check` / `git diff --check`: PASS。manifest・権限・runtime依存は変更せず、buildlessを維持。
- Chrome **156.0.8078.80** / Playwright **1.64.1** の `npm run test:browser`: PASS。既存の選択・保存・再試行・worker回復と、実エンコーダによるPNG/JPEG/WebPの9組合せを確認。合成の妥当なEXIF Artist/GPS/orientation、JPEG IPTC/XMP、WebP XMP、PNG textを対象に、元形式3種のbyte保持と、9組合せをChrome既定先・実OPFSへ保存した出力の対象フィールド/marker不残存を検査。EXIF6のJPEGは各出力形式で12×16への回転と画素を確認。既存のalpha・JPEG白背景・MIME/署名・非上書きも維持。
- 同Chromeの `npm run test:ux`: **29項目PASS**。記憶OFF後の新規作業はChrome先、同一作業のreloadは固定済みフォルダを維持。古い別タブdraftの形式変更、IDB失敗を注入した後の再試行、ON/OFF往復後の明示競合、記憶失敗時のdialog/表示を確認。未編集の古いONが失敗後に明示ONとして復活する経路を修正した。読込み中のcheckboxは操作不可・aria-busyと専用表示になり、試験も読込み完了を待つ。360/640/1280px、200% zoom、Escape・Cancel、既存の選択・保存を回帰。主担当が360/1280pxの設定画面も目視。
- 同Chromeの `npm run test:security`: **12項目PASS**。未同意/拒否の画像取得ゼロ、CSP、具体host同意、合成Cookieの到達・Referer不在、redirect拒否、入力/画素上限、取消と資源解放を回帰。取消はテスト用必須host grantを外せないため、従来どおり明示したAPI境界fixtureで確認。
- 公式Chrome for Testing **116.0.5845.96** の `npm run test:compat`: **13項目PASS**。実IDBのOFF維持・古いrevision拒否・作業/batch handle保護、9組合せのメタデータ検査、EXIF6の寸法・画素を確認。実Worker13生成/13終了と最後の共有ledger解放を確認。Chrome116での設定取消・元形式保存も回帰。
- 独立コードレビューでsession移行/復旧、保存先記憶と競合、合成メタデータ構造、説明文を相互確認。指摘された未編集ONの再試行問題を修正し、対象範囲の未解決must-fixなし。試験したメタデータ構造だけの結果であり、完全除去・匿名化の保証にはしない。

実UIを別途確認した範囲: 正本extensionの全ファイルhashと一致するコピー・追加host grantやJS hookのない隔離Chrome116で、実ツールバーactiveTabから合成2画像を収集、実localhost許可プロンプトの拒否→再要求→許可、許可後640×480プレビュー、記憶ONからOFFの適用と実reload後のOFF保持、実OS pickerのキャンセルと旧設定保持を確認した。個人用Chromeプロフィールは試験に使っていない。

実OS pickerの選択確定は未確認。専用の空フォルダへ移動し、そのフォルダ行を選択しても「選択」が無効のままで、画面表示でも確認した。無効な操作を強制せずキャンセルした。原因は未特定で、アプリの不具合と断定しない。現行Chrome156の別の隔離プロセスも準備したが、UI操作ツールは通常利用側を選択したため、それ以上の操作を行わず試験プロセスだけを正常終了した。

残件: 実OS picker確定後の書込、実書込権限拒否/再許可、実optional host権限の取消、通常Chromeでの最新版再読み込み、VoiceOver、本人の初回・反復試用。既存の本人確認待ちの担当・条件を維持する。OPFSやAPI境界fixtureの成功を実OS操作の成功とは扱わない。

## 広告候補の除外フィルター — 2026-10-31

- 初期OFFの単一checkboxで、縦横比3:1以上・短辺200px未満・GIFをまとめて除外する。元ページの寸法を概算に使い、プレビューの検査済み実寸法・形式を優先する。不明情報はその条件では除外しない。追加の取得・権限・実行時依存はない。
- `npm test`: **305 PASS / 既存対象外1 SKIP**。境界の縦横対称性、有限正数の検証、source概算と既存の最小寸法の区別、URL/data GIF・検査済み形式優先、同寸法の形式のみ更新、boolean検証・session復元、worker再起動後のmetadataと選択保持を確認。
- 隔離Chrome156 / localhost合成画像の `npm run test:ux`: **26項目PASS**。除外だけでは画像取得しないこと、Space操作、チップ1件、選択済み表示・reload復元・新規作業タブOFFを確認。拡張子なしGIFがプレビュー直後には残り、明示更新で除外されること、GIF拡張子の実PNGを実形式で判定すること、非表示の選択済みバナーを実Chromeで保存し元データを保持することを確認。
- 独立コードレビューで、空状態の「条件をリセット」も既存のリセット処理へ統合し、checkbox・チップ・件数・sessionを同期するよう修正した。最終UX試験でも空状態のボタンから7候補へ復帰し、設定OFF・チップ0件・バッジ非表示・session保存を確認した。
- `npm run check` / `git diff --check`: PASS。既存の保存・変換を含む `npm run test:browser` もPASS。360pxの条件欄は開閉後のスクロールが整ってから位置を検査し、既存入力と新checkboxの44px以上の操作領域・パネル内配置・footerとの非重複を確認した。
- 未確認: 通常Chromeへの拡張再読み込み後の本人操作、実サイトでの広告除外率・必要画像の巻き込み、実Chrome116、スクリーンリーダーと人間の理解・操作感。広告検出の精度を自動試験の成功で保証する結果とはしない。

## プレビュー表示操作の発見性 — 2026-10-31

- 本人の「押したら表示されたが、そこを押せばいいとわからなかった」を起点に、空の画像枠へ「プレビューを表示」を移し、配信元・許可範囲を別行に整理した。画像の取得不具合としては扱わない。
- `npm test`: **296 PASS / 既存対象外1 SKIP**。`npm run check` / `git diff --check`: PASS。
- 隔離Chrome156 / localhost合成画像の `npm run test:browser`: PASS。同じ配信元の画像が1回の許可で複数表示され、許可操作で選択が変わらないこと、画像枠と情報欄の両labelで同じcheckboxを切り替えられること、既存の選択・保存・再試行・変換を確認。
- `npm run test:security`: 12項目PASS、pageerror 0。未同意・許可拒否時の画像取得ゼロ、具体host同意、許可後focus、生成Blob表示、取消時の失効を回帰。1280/640/360pxで表示ボタンが画像枠内にありcheckboxと重ならず44px以上、配信元と範囲が縦に並び横overflowなし、説明とのaria関連を確認。長い合成配信元文字列も折返し・非クリップを確認。
- 独立コード審査は対象範囲のmust-fixなし。同じ合成ページの変更前後画面を保存し、主担当が画像枠と表示操作の近接を目視確認した。結果と画面は `/private/tmp/imagecrate-preview-before-results/` と `/private/tmp/imagecrate-preview-after-results/`。元のユーザー画像のサイトへテスト通信していない。

未確認: 修正版を通常Chromeへ再読み込みした状態、本人が案内なしで表示操作を発見できるか、実optional host許可の拒否/取消UI、実スクリーンリーダー。今回Chrome116での再試験は行っていない。既存の通信・権限境界を保ち、runtime依存や公開範囲を追加していない。

## セキュリティ補強の最終検証 — 2026-10-31

現行の収集・保存・プレビューの上限と保証範囲は [SECURITY-HARDENING.md](SECURITY-HARDENING.md) を参照。この節は、以下に残す過去の検証結果より新しい。

- `npm test`: **296 PASS / 既存対象外1 SKIP**。巨大・不正・重複候補の仕事量、注入待機の分離、入力/出力/試行予算、deadline・idle timer遅延と時計逆行、遅延Promise、native I/O未確定、資源/lockの保持、worker回復、Chrome受付・所有ID・取消と完了の競合を含む。対象外は関連動画製品の録画lockテスト。
- `npm run check` / `git diff --check`: PASS。Chrome116+ / MV3 / buildless、既存の権限とruntime依存を維持。CSPは画像表示をself/Blobに限定し、remote/dataの直接Image表示を拒否する。
- `npm run test:browser`: 隔離Chrome **156.0.8078.79**でPASS。収集・選択・非表示選択込み保存・再試行・500件検索・worker再起動を回帰。JPEG/PNG/WebPの実再エンコード、署名・画素・alpha/JPEG白背景、2frame GIFの先頭静止画、実OPFS書込とChrome download、元形式のbyte保持、未知/破損形式の拒否を確認。
- `npm run test:ux`: 同Chromeで **23項目PASS**。同意前placeholder、source寸法と384px/2048px生成画像の分離、条件・選択・draft/handle復元、checkbox→Tab→保存導線、viewer/別候補、360/640/1280px、実200% zoom、閉鎖後の実alarmによる所有ID照合・予算付きqueue継続を確認。スクリーンショットを主担当が目視。alarm試験は発火時刻だけ3秒へ短縮し、productionは1分のまま。
- `npm run test:security`: 同Chromeで **12項目PASS、pageerror 0**。未同意/拒否時の追加画像取得ゼロ、別hostの同意分離、可視host/全path/portの説明、許可操作後focus、remote/data属性画像の実CSP拒否、生成BlobだけのImage表示、redirect拒否、既知/未知長の8MiB制限、30MP宣言のcodec未到達、filter/close/取消による失効・URL/ledger解放を確認。
- 合成HttpOnly/SameSite=Lax Cookieだけを隔離profileへ設定。127.0.0.1/localhost両方でCookie到達、Refererなし、CORS許可ヘッダーのない別hostも明示同意後に取得成功。Cookie値やheaderは保存していない。この構成の観測であり、実サイトの全認証方式の保証ではない。
- `CHROME_EXECUTABLE=<Chrome for Testing 116> npm run test:compat`: 実 **116.0.5845.96で10項目PASS、pageerror 0**。既存8項目にPNG/JPEG/WebP source×3encoderの9組と2frame GIF→先頭静止画を追加。実worker10生成/10終了、MIME・署名・寸法・画素・透明/JPEG白背景、各出力lease解放・最終共有ledgerゼロを確認。プレビューの本物のsuspend/disposeとChrome実終端を待ち、台帳の直接削除はしていない。
- 最終のブラウザ自動試験は`chromiumSandbox:true`、個別の一時profile/拡張コピー・localhost合成データを使い、直列に実行。正本manifestへfixture用常時host権限やテストhookを追加していない。
- 独立レビューでcollector、reader/writer、metadata/worker、preview、workspace/backgroundを相互点検。遅延出力の所有、live/retired owner、cleanup失敗後のtombstone、全fetch枠の合算、wildcard host、API/event不整合、ID 0、受付後の検索/保存失敗を修正し、対象範囲の未解決must-fixなし。

実UIの途中確認: 同意UI統合時の隔離Chrome116で、正本manifestの実toolbar activeTab→収集、具体localhostの追加権限prompt、許可後の640×480寸法表示、macOS folder pickerのキャンセルと旧設定保持を確認。pickerの確定は操作ツール上で選択が無効と表示され、完了を確認できなかった。原因は未特定で、アプリの不具合と断定しない。現行Chromeの別processを操作対象として選べず、個人profileを変更しての追試は行っていない。

未確認: 実OS pickerでの選択確定・書込許可拒否/再許可、実optional host権限の拒否/取消UI、通常Chromeで最新版を再読み込みした代表操作、実サイト固有の認証・リダイレクト、外付け/ネットワーク保存先、スクリーンリーダー、本人の理解・操作感。security suiteの権限拒否/取消は、必須localhost grantを削除できないため明記したAPI境界fixture。OPFSの成功を実OS pickerの成功扱いにしない。

native Chrome保存の上限は観測と取消要求であり、書込前byte上限・wire総量・停止時刻やcodec内部RSSの厳密な保証ではない。通常profileへの反映確認と上の実操作は本人確認の残件とする。公開・ストア配布は行っていない。

## セキュリティ補強・収集処理 — 2026-10-31

- `node --test tests/background.test.js tests/collector.test.js`: 98 PASS / 1既存の録画対象外SKIP。重複・不正token、途中再開、累積上限、mutation/root制限、空work応答、別workspaceの操作継続、同URL reload、旧結果破棄、未settle注入/後始末の再起動をまたぐ予約、元タブ閉鎖後の回復を確認。
- この時点の結果は単体検証。実toolbarのactiveTab、実Chrome権限UI、ブラウザ内部の処理時間上限を確認したものではない。実ブラウザの統合結果は後続の検証記録へ追記する。

以下の実施結果と、未実施の手順を区別します。

## 全14項目の現在の到達点 — 2026-10-31

現行仕様とP01〜P14の対応表、通常Chromeで修正版を試す手順は [UX-COMPLETION.md](UX-COMPLETION.md) に集約する。下に残す過去の件数・PASSは当時の差分の記録であり、今回の最終suite結果へ流用しない。

- 実装: 継続取得、寸法未確認候補の保持、拡大と別候補、全選択表示、session復元、設定draft、読み上げ用の名前、focus移動、中断分の新規保存scope、元形式命名を反映。保存受付の再照合に内部`alarms`権限だけを追加し、host範囲・外部通信・実行時依存・公開範囲は増やさない。
- 最終コード `b1dd0cf`: 単体140 PASS / 1既存対象外SKIP。`npm run check` / `git diff --check`: PASS。
- Chrome156.0.8078.79 / Playwright1.64.1: 既存browser回帰PASS、新UX受入23チェックPASS。実200%zoom、通常download命名と元bytes一致、閉鎖後の実alarmイベントによる再照合を含む。
- 公式Chrome for Testing116.0.5845.96: 基本互換8チェックPASS。権限によって自拡張tabのURLが返らない場合のowner確認を`runtime.getContexts()`へ対応し、実SVG保存とPNG変換まで確認。
- 独立技術審査の修正: 準備handleと整理の競合、保存受付の永久activeと別batch誤認、再スキャンで旧500候補が新候補を押し出す問題、空の容量制限ページで再送後も回復できない問題を修正し、対象を再審査。設定commitの応答喪失時にhandleを削除する経路も修正した。
- 追加PR審査: 初期継承先が他タブの保存先変更に連動する問題をsession固有snapshotで修正。選択済みpreviewから別候補を追加した際の一覧と非表示件数も即時更新し、複数タブと実dialogの受入で確認した。
- galleryの独立確認: 再描画時の拡大button、別候補buttonの再生成、最終前後buttonの無効化でfocusが消える経路と、focusでカード配置が変わる問題を修正。隔離Chromeと合成画像で、1クリックの拡大、候補選択、前後移動、Escape復帰、起点再生成後の復帰、360pxのoutlineと横overflowを確認した。
- 保存受付の照合は30秒を判定期限とするが、作業タブ閉鎖・worker停止後も再確認できるよう、未確定分がある間だけ内部アラームを1件設定する。onCreated/onChanged/startupも照合し、解消後は解除。Chrome116互換の1分遅延と背景処理・OSスリープの遅延を考慮し、30秒以内の結果表示は保証しない。
- 本人試用ページの準備確認: 隔離Chromeで合成SVGの表示、初期7候補とpicture descriptor、1件追加・削除、501 data-src追加後の500+8件の継続取得、外部HTTP画像要求なしを確認。これは本人の試用結果ではない。
- 本人確認: 提示した「拡大して2件選ぶ→選択済み→設定をEsc取消→希望先を適用して保存」の試用は「試して問題なし」と回答。試用時の正確なコード版・Chrome版・実OS picker利用有無は未取得。
- 未確認: 実OS folder pickerの選択/拒否/再許可の個別条件、実VoiceOver、初回・反復の個別評価。実サイトの認証・Referer・redirect・外付け/ネットワーク保存先、長時間の実測は別途残る。

reportと画面: `/private/tmp/imagecrate-ux-final/`、`/private/tmp/imagecrate-chrome116-results/`。詳しい境界と本人試用はUX-COMPLETION.md参照。実装・自動検証の完了と、人間の体験を含む全体完了は分ける。公開・ストア申請は実施しない。

## 自動確認

- Node単体テスト: ファイル名、URL制限、形式判定、未確認/測定済み寸法の条件、候補関係、継続取得、選択/session予算、再スキャン置換、設定記憶、download状態と受付回復。
- 静的確認: MV3 manifest、権限、参照ファイル、全モジュールの構文。
- 隔離Chrome: localhost合成ページのみ。テストコピーに限定host権限を付与。配布manifestと個人プロファイルは変更しない。
- 画像: DOM・背景・srcset・open shadow・同origin frame、取得の区切りと継続、未選択開始、全選択表示、非表示選択込み保存、完了後選択解除、再スキャン、新規画像、拡大・別候補、draft取消/適用、中断と再試行。
- 動画: 直接ファイル/配信候補区別、実download、合成capture入力→実MediaRecorder→pause/resume/stop→全track停止→Blob保存、pickerキャンセル相当、360px横overflow。

## Chromeで実際に触る

1. extension/を読み込み、通常ページで拡張アイコンを押す。設定ページやWeb Storeで失敗理由が表示されることも確認。
2. 初回: 対象と次の操作が説明なしでわかるか。画像の選択3件のうち1件をフィルターで隠し、3件保存されることと件数表示を確認。
3. 反復: 成功分が選択解除され、中断分だけ再試行されること。再スキャンで追加分が未選択なこと。
4. 元ページを別originへ移動/閉じて再取得し、選択済みを失わず再操作の案内が出ること。同じページ内のDOM変更後は、再スキャンで未選択の旧候補が入れ替わること。
5. 動画の元タブ録画を開始し、音声あり/なし、ブラウザ共有停止、元タブ終了、一時停止/再開を確認。完成WebMを再生する。
6. 画面/ウィンドウ/タブの共有picker、保存先pickerの各キャンセルで前回結果が残ること。OSの権限拒否から復帰する。
7. 順次保存を選び短い録画を保存。停止後の書込確定、遅い保存先、書込失敗で不完全ファイルの案内が出ること。
8. 複数作業タブ/worker再起動/作業タブ更新で録画排他と古いlock回収を確認。録画中の閉鎖警告を確認。
9. 30分・容量閾値、背景タブ、メモリ/ディスク使用量、OS音声を実環境で確認。
10. keyboard、スクリーンリーダー、360px、zoom200%、読みやすさ、初回と反復の判断の負担を人間が確認。

ブラウザ自動試験が通っても、実機OS picker・実音声・長時間動作・人間の理解は未確認として残します。

上の動画項目は関連製品の履歴を含む。今回のImageCrateの本人試用は、[5つの課題](UX-COMPLETION.md#本人試用の5課題) を使う。`tests/ux-browser.mjs`は隔離プロファイルだけの自動受入で、通常Chromeへ拡張を読み込んで本人が操作した結果とは区別する。


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

## UIスリム化・広告クイック除外・インストール時一括ホスト権限 — 2026-11-03

- ユーザー要求:
  1. 画面の情報を減らし、重複情報を統一し、初心者でも直感的に使えるUIに刷新。
  2. ページや画像ごとにアクセス許可ダイアログが出ないよう、拡張機能インストール時の1回のみの許可で以後は自動取得するように変更。
- 実装変更:
  - `manifest.json`: `optional_host_permissions` から `host_permissions: ["http://*/*", "https://*/*"]` へ移行。初回導入時にChromeが1回だけ権限を確認し、利用中の個別ダイアログを撤廃。
  - `scripts/check.mjs`: `host_permissions` を前提としたチェック規則に更新。
  - `workspace.html` & `workspace.css`:
    - ツールバーに `[🛡️ 広告除外]` クイックトグルボタンを新設。ワンタップでトラッカー・広告画像（`bance.jp` 等）を即座に除外可能に。
    - バナー・カード内の「プレビューのアクセス許可」スタイル競合（白文字白背景）を解消し、紫背景＋白文字ボタンに統一。
    - 保存先表示をカプセル型ピル（`.destination-pill`）に集約し、長いタイトル時の崩れを防止。
    - サムネイル内の「大きく確認」ボタンを右上の虫眼鏡オーバーレイへ変更し、カード高さを約40%圧縮。
    - brand-icon を `<span>` の CSS 背景画像へ切り替え、テスト時の `img` タグ探索との衝突を回避。
- 検証結果:
  - `npm test`: 351 PASS / 1 SKIP
  - `npm run check`: OK
  - `npm run test:browser`: PASS
  - `node tests/security-browser.mjs`: 18 checks PASS
  - `npm run test:ux`: 29 checks PASS

