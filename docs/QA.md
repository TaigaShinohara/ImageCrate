# QA — v0.1

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
