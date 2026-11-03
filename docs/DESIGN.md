# ImageCrate / VideoHarbor — initial design v1

## GitHub オープンソース（OSS）公開準備 — 2026-11-03

本人指示「githubでossとして公開したいので準備して」を受け、リポジトリをオープンソースとして健全かつ持続可能に公開・運用するためのガバナンス文書、メタデータ、CIパイプライン、テンプレートを整備。

1. **GitHub ガバナンス・コミュニティ整備**:
   - `CODE_OF_CONDUCT.md`: Contributor Covenant v2.1 に準拠した行動規範を設置。
   - `CONTRIBUTING.md`: 外部依存ゼロ・Manifest V3・プライバシー保護の設計原則、ローカル検証手順（Chrome / Safari）、テスト実行指針を明記したコントリビューションガイドへ刷新。
   - `SECURITY.md`: 脆弱性報告手順および合成データによる報告方針を維持・確認。
2. **GitHub Actions CI ＆ テンプレート (`.github/`)**:
   - `.github/workflows/ci.yml`: GitHub Actions 自動パイプライン（Node 22 による単体テスト `npm test`、静的検査 `npm run check`、およびヘッドレスブラウザテスト `npm run test:browser` / `test:ux`）。
   - `.github/ISSUE_TEMPLATE/`: 構造化されたバグ報告（`bug_report.yml`）および機能提案（`feature_request.yml`）、セキュリティ報告誘導（`config.yml`）を配置。
   - `.github/PULL_REQUEST_TEMPLATE.md`: 外部依存ゼロやManifest V3規約、Safari互換性、テスト完了を確認するPRテンプレートを配置。
3. **リポジトリメタデータ & 国際化**:
   - `package.json`: `license: MIT`, `repository`, `homepage`, `bugs`, `keywords` などのメタデータを整備。
   - `README.md` & `README_EN.md`: バッジ（CI, License, Chrome, Safari）、特徴、クイックスタート、プライバシーポリシー、ライセンス案内を整理し、日本語・英語の両言語対応を完備。
   - `.gitignore`: macOS/Windowsシステムファイル、テストカバレッジ、IDE設定、Xcode一時ファイル等を包括的に除外。

## Safari Web Extension (iOS / macOS) への適合・Xcode構成とモバイル自動選択 — 2026-11-03

本人指示「フェーズ3に進んで」を受け、iPhone / iPad (iOS Safari) および macOS Safari でImageCrateを動作させるためのWeb Extension適合・Xcodeプロジェクト構成・モバイル環境最適化を実装。

1. **Safari Web Extension / モバイル環境での未定義APIガード**:
   - iOS Safari では `chrome.downloads` API が存在しない、あるいは極めて限定的であるため、Service Worker 起動時のイベントリスナー登録（`chrome.downloads?.onChanged?.addListener`、`chrome.downloads?.onCreated?.addListener`、`chrome.downloads?.onDeterminingFilename?.addListener`）をすべてオプショナルチェーンで防護。
   - `chrome.downloads` が undefined の環境でも例外を起こさずService Workerが健全に起動。
   - もしダウンロードAPIが存在しない環境で `downloads` destination のジョブが試みられた場合も、クラッシュせず「このブラウザ環境ではダウンロードAPIを利用できません。ZIP保存をご利用ください。」の案内を返却。
2. **モバイル・Safari環境でのZIP保存自動選択**:
   - タッチデバイス（`navigator.maxTouchPoints > 0` / モバイルUA）または `chrome.downloads` がない環境を自動検知。
   - 初回起動時や保存先未選択時、自動的に `destination: 'zip'` をデフォルトとして採用。
   - モバイルユーザーは設定変更の手間なく、保存ボタンを1タップするだけでiOSネイティブの共有シート（ファイルに保存 / AirDrop 等）を呼び出し可能。
   - 保存先ダイアログにおいて、`downloads` API 非対応環境では `destination-downloads` ラジオボタンを安全に非活性化。
3. **Safari Web Extension プロジェクト構成と二重管理の排除（`scripts/safari-convert.mjs`）**:
   - `safari-web-extension-converter` を活用し、`safari/ImageCrate` に iOS (App/Extension) および macOS (App/Extension) の Xcode プロジェクトを生成。
   - `--copy-resources` を使用せず、`extension/` フォルダのソースを相対パス参照する構成を採用。これにより JavaScript/HTML/CSS の編集が Chrome と Safari の双方へ即時反映され、コードの乖離・二重管理を完全に防止。
   - `npm run safari:convert` コマンドにより、ワンステップで非対話的にXcodeプロジェクトを再生成・同期可能。

## モバイル保存エンジン（ゼロ依存ZIP一括保存＆Web Share API共有シート連携） — 2026-11-03

本人指示「フェーズ2に進んで」を受け、モバイル環境（iOS Safari / Android Chrome / 各種モバイルWebブラウザ）で課題となる「個別ダウンロードのポップアップ制限」および「`showDirectoryPicker` の非対応」を解決する軽量・堅牢なモバイル保存エンジンを実装。

1. **外部依存ゼロのストリーミングZIPアーカイバ（`extension/zip-writer.js`）**:
   - **PKZIP 2.0 規格準拠**: Local file header、Central directory header、End of central directory record を純粋な `Uint8Array` / `DataView` で構築。外部npmパッケージ（JSZip等）を一切追加せず、ブラウザ標準APIのみで完結。
   - **Store圧縮（無圧縮）とCRC-32高速計算**: JPEG/PNG/WebPなどの画像はすでに圧縮済みであるため、Deflateの再圧縮を行わず Store 方式を採用。CPU発熱・バッテリ消費・メモリフットプリントを最小化。
   - **UTF-8ファイル名対応**: フラグビット `0x0800` を付与し、日本語や特殊文字を含むファイル名がOS標準展開ツール（macOS Archive Utility, Windows Explorer, iOS ファイルアプリ, Android Files）で文字化けせず正常に解凍可能。
2. **Web Share APIとフォールバック共有連携（`extension/web-share.js`）**:
   - **ネイティブ共有シート連携**: `navigator.canShare({ files })` が利用可能な環境では、生成したZIPファイルを即座にOSネイティブの共有シート（iOS「ファイルに保存」「AirDrop」、Android「ニアバイシェア」「Googleドライブ」等）へ橋渡し。
   - **シームレスなフォールバック**: Web Share API非対応環境（デスクトップブラウザや非対応WebView）では、自動的に `<a download>` によるBlobダウンロードへフォールバック。
   - **ユーザーキャンセルの安全な処理**: ユーザーが共有シートを閉じた場合（`AbortError`）はエラー通知とせず、穏やかに完了状態へ遷移。
3. **ワークスペースUIとのシームレスな統合**:
   - 保存設定ダイアログに「ZIP保存」オプション（`destination: 'zip'`）を追加。モバイル環境でのデフォルトまたは推奨保存先として機能。
   - バッチ保存実行時、選択画像（形式変換または元形式Blob）を順次ZIPに追加し、プログレスバーを更新しながら最終ZIPを共有・保存。

## モバイル・タッチUXの最適化（スワイプ前後送り・ダブルタップズーム・親指操作） — 2026-11-02

本人の「スマホからでもこのユーザー体験を落とさずに使えるようにしたい。別ブランチでその方針で進めて」を受け、新ブランチ `feature/mobile-ux` において、モバイル画面・タッチスクリーンでの操作性を向上させるタッチジェスチャーと親指ゾーンUIを実装。

1. **ビューワーのタッチジェスチャー対応（スワイプ前後送り＆ダブルタップズーム）**:
   - **左右水平スワイプ送り**: 画像確認モーダル（`#image-preview`）の `#preview-stage` において、指の左右スワイプ（450ms以内、水平移動40px以上、垂直移動比1.4倍以上）で前後の画像へシームレスに切り替え。ボタンを狙わずとも写真アプリのように次々と検品可能。
   - **パン操作との共存**: 等倍ズーム表示中（`actual-size`）は画像内スクロール（パン）を優先し、スワイプ送りを自動抑制。
   - **ダブルタップズーム**: 350ms以内の近傍2回タップで「全体表示」と「等倍表示」を即座にトグル。
   - **スワイプ誤判定防止**: スワイプ完了時に直前タップ時刻をリセットし、スワイプ直後のタップがダブルタップとして誤認識されるのを防止。
2. **タッチターゲットと親指操作レイアウトの強化**:
   - **デュアルレンジスライダーのタッチ当たり判定**: つまみ（ノブ）に `::before` 擬似要素で 44px×44px の透明タッチターゲットを完備し、スマホの指でも確実に掴めるように改善。
   - **ビューワーのモバイル最適化**: 480px以下ではモーダル幅を画面いっぱい（`calc(100vw - 16px)`）に広げ、下部コントロールのボタン高さを 44px 以上確保。
   - **保存ボタンの親指最適化**: モバイルフッターの主アクションボタン（`save-actions .primary`）を親指で押しやすい高さ（48px以上、フォント14px太字）に強化。
   - **カードのタッチフィードバック**: 画像カードタップ時に微細なスケールフィードバック（`scale(0.985)`）を提供。

## 画面情報の削減と初心者向け直感UIデザインへの刷新 — 2026-11-02

本人の「画面全体に関して情報を減らし、初心者でも使いやすくしたい。重複した情報は統一し、そこまで重要じゃない情報は折りたたむなどして隠し、不要な情報は消したい。そのうえで見やすくデザインし文字を減らし、アイコンや図形や UIを駆使してちょっかんてきに使えるようにしたい。別ブランチでその方針で進めて」を受け、新ブランチ `codex/simplify-ui` にて画面情報のスリム化と直感的なUIへの刷新を実施。

1. **重複情報の統合と不要情報の整理**:
   - 画面各所（ギャラリー見出し、タブ、フッター、保存ボタン）に散在していた件数・選択数表示を整理し、セグメントコントロールタブのバッジおよび保存ボタンに集約。
   - フッターの保存先フルパス（`Chromeのダウンロード先 / ImageCrate / ページ名`）をアイコン付きのコンパクトなピル `[📁 保存先: Chrome · 元の形式 変更]` にスリム化。
   - 乱雑なURL由来のファイル名表示を抑制し、不要な操作ヒント文や長文の注意書きを整理。
2. **画像が主役のギャラリーカード**:
   - カード下部に横長に常設されていた「大きく確認」ボタンを廃止し、サムネイル右上のオーバーレイアイコンボタン（虫眼鏡 🔍 アイコン付きピル）に置換。カードの高さを約40%削減。
   - 寸法・形式をコンパクトなピルバッジとして整理。
   - チェックボックスを円形・角丸の洗練されたトグルUIに刷新。
3. **ヘッダー・ツールバーの直感化**:
   - トップバーと取得元バーをシームレスに調和させ、アイコンボタンに統一。
   - 広告除外フィルターにシールドアイコン（🛡️）を導入し、トグルスイッチ風の直感的なUIへ強化。
   - デュアルレンジスライダーおよび範囲リセットボタンの操作感・視認性を向上。
4. **アクセシビリティ・既存テストの完全維持**:
   - 全自動テスト（343件のユニットテスト、browser-smoke、ux-browser全29項目）の互換性を保持し、タッチターゲット44px以上、キーボード操作性、フォーカスリングを完備。

## 広告除外フィルターの改良：広告の完全除外と元ページ画像の保護 — 2026-11-02

本人の「広告らしい画像を除外を改良したい。広告を完全に除外しつつ元のページの画像は残したい」を受け、広告判定（`adLike`）の精度を向上させ、広告やトラッカーを漏れなく除外するとともに、元のページの主要コンテンツ画像（漫画・イラスト・写真）を誤除外から保護する。

1. **広告・トラッカーの完全除外**:
   - **ビーコン・トラッカーの網羅**: `imp` に加え、`pixel`, `beacon`, `tracker`, `1x1`, `blank`, `spacer`, `clear`, `infomark` などのトラッキングファイル名、`/imp/` 等のパスセグメント、クエリパラメータ（`bid=`, `ad_id=` 等）を網羅して検出。
   - **広告配信ネットワーク（DSP/アドサーバー）の検出**: ホスト名に基づく判定により、`*.dsp.*`（`js.dsp.bance.jp` 等）、Google Ads / DoubleClick（`googlesyndication`, `doubleclick`, `pagead`）、Criteo、AppNexus、i-mobile、MicroAd、Fluct、AmoAd等の主要アドネットワーク・DSPドメインからの画像を確実に除外。
   - **標準バナーサイズへの一致**: IAB標準広告サイズ（728×90, 468×60, 320×50, 300×250, 160×600 等）に完全一致するバナーを確実に除外。
2. **元ページのコンテンツ画像の保護**:
   - **Webtoon（縦スクロール漫画）やパノラマの保護**: 縦スクロール漫画（`height > width` かつ 幅400px以上・高さ1200px以上）や、超高解像度のパノラマ画像（短辺500px以上・総画素数80万px²以上）は、縦横比が3:1以上であっても広告バナーと見なさずコンテンツとして強力に保護。
   - **高解像度コンテンツの維持**: コミック本文（`1.webp` 等）や記事の写真は、誤除外されることなく確実に残る。
3. **安全性の維持**:
   - フィルターをOFFにすればいつでも全候補を復元でき、不可逆なデータ破棄は行わない。

## 1本のデュアルレンジバーによる最小・最大寸法絞り込みと縦横表記の明確化 — 2026-11-02

本人の「絞り込みでは〜以下でも絞れるようにして。現在は〜以上でしか絞り込めない。またそのピクセル数を選ぶ際はゲージで直感的に選べるようにしよう。また、縦の数値なのか横の数値なのかが理解できるようにも配慮して」「最小最大の設定は一つのバーで表現したい。バーの初めと終わりをいじれるように。」「範囲をリセットするボタンも用意して。また、そのうえで一度レイアウトや情報量を見直して初心者でも使いやすいように整理して。テキストは減らし極力アイコンや図形で表現できるのがりそう」を受け、絞り込みフィルターの寸法指定を拡張・統合し、情報構造を初心者に優しく整理する。

1. **〜以下（最大寸法）の絞り込みと範囲指定**:
   従来は「最小幅」「最小高さ」（〜以上）のみであったが、「最大幅（〜以下）」「最大高さ（〜以下）」を追加し、上限値での絞り込みおよび範囲指定（例: 幅400px以上1200px以下）を可能とする。値が 0 または未指定（右端最大値）の場合は上限なし（制限なし）として扱う。寸法未確認の候補は従来通り除外せず保持する。
2. **1本のバーで初め（最小）と終わり（最大）を操作できるデュアルレンジスライダー**:
   横幅および高さの各軸について、1本のバー（トラックと選択範囲ハイライト）上に「最小つまみ」と「最大つまみ」の2つのスライダーつまみを配置。バーの初め（左端）をつまんで最小値を、終わり（右端）をつまんで最大値を直感的にドラッグ・調整できる。つまみ中央にノブピクトグラムを配置し、視覚的に操作部とわかるデザインとした。
   また、キーボード操作（Arrowキーで10px単位、Shift+Arrowで100px単位、Home/Endキーで最小/最大端）とアクセシビリティ（`role="slider"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`）を完備。
3. **軸別の範囲リセットボタン**:
   各軸の見出し横に「リセット」ボタン（`#reset-width`, `#reset-height`、↺アイコン付き）を新設。範囲が絞り込まれている場合にハイライト表示され、ワンクリックでその軸の範囲を即座に初期値（0〜上限なし）へ復元できる。
4. **情報量とテキストの整理・図形化**:
   - 冗長な見出しテキストを整理し、「↔ 横幅」「↕ 高さ」「画像形式」のように明快なアイコン付き表現に統一。
   - 数値入力行を「[以上] [ 0 ] px 〜 [以下] [ なし ] px」というバッジ＋入力枠のコンパクトなレンジ表現に整理。
   - 広告フィルターの説明文（`#ad-filter-help`）や下部ヒントの長文を初心者向けに短縮・平易化し、情報過多による視覚的圧迫感を低減。
5. **レスポンシブとアクセシビリティ**:
   モバイル（360px）からデスクトップ（1280px）まで、タッチターゲットはすべて 44px 以上を確保。デスクトップでは横並びで高さを抑え、パネル開閉時にもカード表示やIntersectionObserverによるプレビュー自動読み込みを阻害しないコンパクトなレイアウトを維持する。適用中の条件はチップで確認・解除でき、条件リセットにも対応する。

## 広告フィルターの初期ONと計測タグ（imp）除外 — 2026-11-02

本人の「広告関連のパーツは最初から除外する設定にしておこう。「再試行」の impも除外」を受け、「広告らしい画像を除外」設定を初期ONに変更し、計測タグ（`imp`）を広告判定に追加する。

元ページと異なる広告配信元（`js.dsp.bance.jp` 等）のパーツ（インフォマーク等）やトラッキングビーコン（`imp`）が初期表示に混ざることで、追加の配信元許可バナーや非画像エラー（未知・未対応の画像形式）の再試行が発生していた。広告フィルターを初期ONとすることで、起動直後から本文画像を中心とした一覧が表示され、不要な外部配信元への許可要求も発生しなくなる。

さらに、寸法未確認かつ形式不明のまま候補に紛れ込む広告インプレッション計測ビーコン（URLの末尾セグメント・ベース名が `imp` の候補）を `adLike` 判定に含める。これにより、寸法が取れないトラッキングビーコンも広告フィルターで最初から確実に除外される。

フィルターをオフ（チェック解除またはチップ解除）にすれば全候補が再表示され、必要に応じて元の形式での保存等を試せる既存の契約を維持する。常時host権限の追加や候補の不可逆な完全破棄は行わない。

## 起動時の追加許可を自動要求しない — 2026-11-02

本人の「出ないようにできない？」を受け、下の「別配信元CDNの初回プレビュー」で追加した起動前の配信元調査・一括許可要求を廃止する。拡張アイコンからは作業ページを直接開き、既存のChrome許可・元ページの一時activeTab・data画像で自動表示する。初回・反復・拒否後の起動でも追加のChrome確認は自動表示しない。

未許可の別配信元は既存の一覧上部・画像ごとの明示的な表示操作から許可する。選択フォルダへの保存・画像変換で必要な配信元許可は保存操作時に残す。「元の形式＋Chromeのダウンロード先」は追加アクセス許可なしで利用できる。常時host権限やCookie等の権限は追加せず、収集・選択・保存・失敗復帰も変更しない。

起動前のprobeとそのcallback/timeout制御を削除し、同一タブの作業ページを開く処理中だけ連打をまとめる。開く処理が失敗した場合は既存のbadgeによる案内を保ち、次のクリックで再試行できる。自動権限要求ゼロと、既存の明示許可・拒否後の復帰を回帰確認する。

## 取得・形式失敗と許可待ちの説明 — 2026-11-02

追加の本人確認では本文画像は表示されており、上段の候補だけにHTTP400・未知/未対応・許可待ちが混在していた。画像の拡張子・表示名・エラーだけで広告や非画像と断定せず、候補の収集/選択/保存と既存フィルターを維持する。取得や形式の失敗にも許可範囲説明を再表示していたため、追加許可で直る状態と混同しやすい点を今回の対象とする。

配信元の全パス/全ポート・ログイン状態の説明、aria-describedby、許可範囲titleはneedsPermissionの状態だけに出す。取得/形式/表示失敗には理由と再試行を示し、再試行のtitleは画像の再取得に限定する。保存結果を保証しないため、形式検査・表示失敗の「保存できます」は「保存を試せます」へ直す。候補を隠す・削除する案は必要画像の取りこぼしの根拠が不足するため採らず、無関係な説明の削減に絞る。

主担当が案を作成し、独立担当 `preview_mixed_failures` が目的/周辺・状態・文言を審査。hiddenだけではaria-describedbyやtitleに許可説明が残るUX-MIX-01を採用し、参照/hover説明も揃えて切り替える条件で未解決設計must-fixなし。通常の狭い修正として主担当ディレクターが実装開始を承認。HTTP400/503・未知container・未許可を合成データで比較し、実際の広告サーバーや私的URLへ試験通信しない。

## 別配信元CDNの初回プレビュー — 2026-11-02

初期ONの追試で、同じCDNの画像5枚が追加許可待ちになるという本人報告を受けた。前節の成功は既存許可・同一origin・dataに限定され、新規CDNで手動操作が残る点を解消していなかった。今回の対象は、元ページと異なる配信元を含む初回の表示開始と、その許可導線。

拡張アイコンを押した操作から、小さなstateless probeでHTML imgのcurrentSrc/src/遅延属性の具体originを調べ、既存許可と元ページのexact originを除いた配信元をChromeへ1回で要求する。元ページのURL確認にbaseURIを使わず、候補URL解決だけに使う。Chrome116ではPromise継続へgestureが伝わらないため、actionから直接発行したexecuteScript/getAllのnative callback内で要求し、その後に作業ページを開く。全サイト常時host権限や直接の遠隔Image表示は追加しない。初回のChrome確認自体は省略しない。

probeはcollectのregistry/cursor/observerへ触れず、取得/codecも行わない。最大12000要素・500 URL試行・128 origin・131072文字・25ms目標、同一tab1件・worker内4件の軽量別枠とする。5秒待ちでUIへ戻しても未settle枠をcallback終端/元tab閉鎖まで保持する。worker再起動をまたぐブラウザ内未着手probeの厳密上限は保証しない。既存fullscanの永続flight・予算・画像取得上限は変えない。この限定した読み取りを、gestureを消す非同期予約の前置きが必要な本収集とは分ける。

拒否・API失敗・probe対象外のCSS/srcset/frameや後から発見したCDNは、一覧上部に配信元ごとの1つの許可操作を示す。確認できた未許可URLだけを集約し、無関係の配信元まで要求しない。再描画/scroll/reloadで自動再要求せず、許可後に同じ配信元の画像をまとめて表示する。保存・選択・変換は既存のまま。

通常変更として主担当がtoolbar/probeを設計し、独立担当 `cdn_permission_design` が目的/周辺、gesture・scope・期限・失効・失敗復帰の条件を審査。Chrome116の実toolbarで1-hop callbackのnative許可とgrant成功を先に確認した。条件を反映したv1の実装開始に未解決設計must-fixなし。主担当ディレクターが実装開始を承認し、galleryの集約操作は別担当が具体化。最終合否はCDN5枚の初回prompt1→自動5枚・次回prompt0、拒否・古い結果/重複・保存回帰と独立コード審査で確認する。本人の実サイトでの結果は別に扱う。

## プレビューの初期ON — 2026-11-02

本人の「プレビューは基本最初からオンでいいよ」を現行仕様として、下の作業ページごとの同意契約を更新する。画像を開いて見比べる最初の行為から、毎回の表示操作を除く。既存Chrome許可・元ページの一時activeTab・埋め込みdata画像で可視画像を自動表示し、追加許可が必要な配信元にだけ操作を残す。全サイトの常時host許可や自動permissions.requestは追加しない。

許可の再利用だけの案では初回の同一origin画像も止まるため、有効な元ページと候補をworkerで検証する一時アクセスを組み合わせる。元ページの移動・閉鎖やChrome許可取消で旧結果を失効させる。未許可は追加許可、取得/形式失敗は権限再要求のない「再試行」に分け、読込中は操作を隠して状態を示す。保存・選択・可視範囲の取得・資源上限・生成Blobだけの表示は維持する。

通常の機能内変更として主担当が作成し、独立担当 `auto_preview_design` がL1/L2の目的と周辺、L3/L4の権限・失敗・再操作を審査。追跡hostを残した取消失効、未許可の通知ループ防止、source検証、許可と再試行の分離を条件に未解決must-fixなし。主担当ディレクターはこの範囲の実装開始を承認した。旧UIの本人回答は自動表示版の人間評価に転用しない。参照はUXマニュアル保存版2026-10-02 sequence 4（正本Page読取ツールは利用できず最新版未確認）。独立コード審査と、初回/再読込・別host・拒否/取消/再許可・source失効・選択/保存の同条件試験で確認する。作業時間・待ち時間は未計測。

ブラウザ回帰で、自動プレビュー2件が作業ページのfetch枠を占有した瞬間の保存が即中断する問題を発見した。保存開始時は新規プレビューを一時停止し、保存の既存deadline内で、進行中の予約・生成・解放が実際に終わるのを待って保存を優先する。所有者の予約を強制解除せず、保存終了後に可視ページの自動プレビューを再開する。保留HTTP2件と実台帳2枠を使う同条件回帰で確認する。

独立担当 `auto_preview_code_review` の指摘により、同hostの別port候補をURL単位で追跡し、権限追加が非同期確認中に届いた場合も再確認する。停止後に遅れて届く予約とdecoder出力のreleaseもdrainへ含める。各指摘はdeferred回帰と再審査で解消し、対象範囲の未解決must-fixなし。試験と実Chrome116 toolbarの結果はQAへ記録し、本人の実サイトでの使い心地は別に残す。

## 情報保持の最小化と次回用保存先 — 2026-11-01

既存の選択・保存・中断復旧を保ちながら、表示だけに使うChromeの実保存先をbasenameへ限定する。旧sessionのjobs/historyも直列queueで移行し、revisionは正規の保存で単調増加させる。Chromeが返す生の絶対パスは、要求相対パスとの受付・所有照合にそのまま使う。

閉鎖した作業のトップレベルsource URL/titleを不要になった時点で消し、結果不明の保存job・予算・資源・参照は実終端まで保持する。運用URLのqueryや文書同一性の完全URLは使用中に維持し、時間だけの強制消去は行わない。

保存設定に「次の作業でもこの保存先を使う」を統合する。既存・初期ONを維持し、OFFの適用で次回用メモだけを忘れる。同一作業の再読込やbatch再試行用参照は別に保持する。キャンセル・Escapeはdraft取消、古い別タブdraftや形式変更はOFFを復活させない。既存dialog内の選択として提供し、常設modalや重複する全消去操作は加えない。

元形式のメタデータ保持と、変換の限定した保証範囲を既存の保存形式補足に示す。連絡先はプロジェクト用メールへ統一し、データ保持・通信・出力・Chrome履歴の境界を [PRIVACY.md](PRIVACY.md) にまとめる。実施結果と実OS/本人確認の境界はQAへ記録する。

## 広告候補の除外 — 2026-10-31

「絞り込み」の「広告らしい画像を除外」は初期OFFの単一checkbox。ONでは長辺÷短辺が3以上、短辺が200px未満、またはGIF形式の候補を除外する。縦横を対称に扱い、静止GIFも対象とする。広告判定の目安であり、広告以外も除外される場合がある。固定サイズの広告リストや他形式のアニメーション検出は行わない。

この概算条件に限り、元ページのsource寸法も使う。有限の正数の幅・高さが揃わない候補は寸法条件で落とさない。プレビューで検査した元画像の寸法と形式が分かれば優先し、縮小PNGの寸法・形式を元画像と混同しない。GIFの初期判定はURL末尾・data MIMEを用い、queryから推測しない。既存の最小幅・高さは従来どおりdecoded/measured寸法のみで判定する。

検査済み形式は既存の寸法更新経路・session・測定overrideと同じ寿命で保持し、許可した形式値だけ受理する。同寸法で形式だけ判明しても更新として扱い、カードをその場で消さず「確認した情報で条件を更新」を提示する。追加取得・追加権限はない。

検索・最小寸法・形式とはANDで組み合わせ、適用チップは1件。チップ解除と全リセットでOFFへ戻す。boolean設定は同じ作業タブの再読み込みで復元し、新規タブ・旧sessionの初期値はOFF。選択は解除せず、「選択済み」はこの条件も迂回して全選択を表示する。非表示選択込み保存の既存案内を維持する。

## プレビュー表示操作の発見性 — 2026-10-31

本人から「押したら表示されたが、そこを押せばいいとわからなかった」と確認。許可後の画像表示は動作するが、空の画像枠から離れた長い許可ボタンと、ボタン内の横並び説明が操作の発見を妨げていた。対象はプレビュー開始の導線のみ。画像を見比べて必要なものを選べる体験に向け、空のサムネイル内に「プレビューを表示」を置き、直下に配信元と許可範囲・同じ配信元への効果を縦に表示する。

折返しだけの変更では操作の位置が変わらず、自動読込では同意前に通信しない契約が変わるため、既存の同意操作を画像枠へ移す案を採用する。成功時は操作と説明を隠し、拒否・失敗時は同じ場所から再操作できる。画像枠と情報欄は同じcheckboxに関連付け、許可ボタンはlabelの外に置く。実click内の具体host要求、未同意fetchゼロ、選択と保存は維持する。

通常変更として主担当が設計し、独立担当 `consent_design_review` がL1/L2の対象選定・周辺とL3/L4のUI/技術条件を審査。案v1の実装開始に未解決must-fixなし。主担当ディレクターは上記範囲の実装開始を承認する。画面変更を伴わない保存・収集機能の別審査は省略。参照はUXマニュアル保存版2026-10-02・sequence 4（正本Page読取ツールがなく最新版未確認）。1280/640/360pxの同じ合成画像、未同意・拒否・成功・再操作・focus・選択独立で比較する。本人が修正版の操作を見つけられるかは未確認。作業時間・待ち時間は未計測。

実装後の同担当による独立コード審査もmust-fixなし。同じ配信元への効果と、許可確認中・画像取得中の反応を示す提案を採用した。設計/コードの2段階を審査し、ブラウザでの動作・画面確認は主担当が別に実施（結果はQA）。元画面の本人回答を修正版の体験確認へ流用しない。今回役立った審査はlabel分離・同host説明・処理中表示の確認であり、今後も狭い修正ではこの範囲の審査と同条件比較をまとめる。

## Chrome自身が取得する保存の監視 — 2026-10-31

「元の形式＋Chromeのダウンロード先」はChromeによる直接保存を維持する。開始前にbatch入力・出力各512MiB/15分と論理job3試行の予約を保存し、所有するdownload IDだけをUI照会・downloadイベント・worker起動・1分alarmで観測する。観測した受信量・出力量はhigh-waterで累積し、128MiB/件・120秒・30秒無進捗、batch上限に達したら取消意図を保存してChromeへ取消を要求する。既知の総容量は早期取消の根拠にするが受信済みbyteとは数えない。時計が戻れば同batchを安全側に停止する。

download受付APIの応答は30秒で区切り、未応答でもworker全体の変更queueを無期限に塞がない。未確定の受付はjob/tokenとURL・開始時刻・要求path・他jobの使用IDを照合し、期限だけで未保存と決めたり再送したりしない。正のAPI応答が遅れても同じ試行へ引き継ぎ、Chromeの確定済み完了を降格させない。API/eventのID不整合では他のdownloadを取り消さず、結果不明として保持する。ID 0も所有するIDとして監視する。旧版の予算がないqueued/retryは新しい保存を案内し、受理済みIDの監視は続ける。

閉鎖後も活動中のbatchは4作業枠へ数え、閉鎖による同時保存の増殖を防ぐ。後片付けだけを待つinactive tombstoneは別扱いにする。取消と完了が競合した場合は実Chrome結果を正本とし、完了済みファイルを自動削除しない。Chrome/OS停止中、alarm遅延、内部retryや圧縮などにより、native経路の書込前byte上限・厳密なwire量・120秒以内の取消完了は保証しない。

## 配信元ごとのプレビュー同意 — 2026-10-31

workspaceを開いただけでは遠隔画像のfetch・Image読込を開始しない。各カード/viewerにscheme・host・portと全path/portへの許可範囲、ログイン状態を使う取得であることを表示する。実click内で具体hostだけのChrome任意許可を要求し、workspace固有の同意も記録する。既存のChrome許可だけで新workspaceのプレビューを始めない。data画像も明示的なローカル同意を必要とする。拒否・未対応・容量超過ではplaceholderを表示し、通常の選択・元形式Chrome保存は利用できる。

previewは入力8MiB・20秒・24MP・8192pxまで、workspace累積256MiB。可視領域から外れた画像、絞込、再描画、viewer閉鎖、非表示化でconsumerを解放し、最後のconsumerがなくなれば進行中の処理を停止する。queue64・cache64件とし、権限はqueue実行時・cache使用時・生成後にも確認する。取消時は表示/cache/URLを失効させる。元画像URLをImageへ設定せず、検査済みの生成PNG Blobだけを表示する。thumbnail384px、viewer2048pxへの縮小と、元画像の検査済み寸法を分ける。「等倍」は生成プレビューの等倍表示を指す。

## 画像の事前検査と共有codec — 2026-10-31

プレビューと形式変換は共通のmetadata検査と専用workerを使う。PNG/APNG・JPEG・GIF・WebP・BMP・ICOのcontainer、寸法、frameや埋込画像の合計画素をnative decode前に検査する。入力1枚24MP、aggregate64MP・64frame・8192chunkまで。破損・未対応・不確実な形式は拒否し、元形式保存へ自動で切り替えない。AVIFと一般的なSVGは拒否する。SVGは明示的寸法を持つ単純な塗り矩形だけを独自に描画し、元SVGをnative Image/codecへ渡さない。

全workspace共通のWeb Lockでcodecを1つにし、session ledgerでencoded bytes128MiB・source/output pixels64MP・fetch4枠を共有する。生成後は実Blob量へ予約を縮小する。preview cacheはglobal32MiB/workspace16MiB、表示buffer換算はglobal64MiB/workspace32MiB、同時preview fetchはworkspace2枠。ledgerのbyte/pixel値はアプリ所有量の会計で、ブラウザ内部codecのRSS・copy・GPU割当の測定値ではない。

変換は入力32MiB・出力64MiB、JPEG/PNG/WebPの実MIMEを確認する。sourceと検査用copyの予約は検査/decodeの実Promise終了まで保持し、生成出力の予約は書込完了またはChromeの実terminal結果まで引き渡す。生存workspaceがBlob/URLを持つ間はbackgroundが先に資源を解放しない。閉鎖・reloadが確定した旧ownerだけをbackgroundが回収し、未確定のnative書込は保守的に保持する。後片付け記録はsessionに残し、worker再起動で再開する。native書込が永久に未確定の予約はブラウザsession終了まで残る場合がある。

## 管理保存の通信・書込予算 — 2026-10-31

任意フォルダへの元形式保存と形式変換は、共通のstream readerで実際の展開後bodyを数える。Content-Lengthは早期拒否だけに使い、未知長・圧縮応答も各chunkを上限検査してから呼出側へ渡す。元形式は128MiB/120秒、変換入力は32MiB/120秒、無進捗は30秒。redirectは追従せず、認証は選択した配信元への既存Cookieをfetchのcredentialsで利用する。Cookie APIや広い常時host権限は使わない。絶対期限は待機・fetch・変換・書込を通じて進み、停止直後やタイマー遅延後も再検査する。

各batchは入力512MiB・出力512MiB・15分、論理jobごと初回を含め3試行。workerが入力・出力の最大使用量をsessionへ原子的に予約してからworkspaceへ開始を許可する。retry、reload、worker再起動で予算と期限を初期化しない。既知の終了では未使用予約だけを返す。実際の受信量や書込結果が不明なら予約全量を使用済みとして保持し、同じ結果不明jobのretryを認めない。新しい保存の明示操作は別batchになる。

任意フォルダは内容を一括Blob化せず、検査済みchunkから書く。非上書きの名前確保とWeb Lockを維持し、closeの成功前に保存完了と表示しない。native I/OはAbortSignalだけで停止を証明できないため、UIへ先に停止を返しても実際のwrite/close/abortが終わるまで所有lockと資源を保持する。結果不明なファイルを自動削除・再試行せず、保存先の確認と新しい保存を案内する。これはアプリが受け渡すbyteの制限であり、ブラウザのネットワーク受信量・内部コピー・native I/O完了時間の厳密な上限ではない。

## 収集処理の資源制限 — 2026-10-31

候補数・要素数・保存情報量に加え、無効・重複URLを含む字句処理を1回128Ki文字・4096試行・25ms目標で区切る。途中位置は明示的なparser stateへ保持し、候補0件でも「続きの候補」で再開できる。属性は1Mi文字、URL/baseは131072文字、descriptorは64文字まで。scan全体は16Mi文字・65536試行・100000要素までとし、継続で予算を初期化しない。大量のmutationはNodeListを展開せず保守的に継続を無効化する。観測root/document数も制限する。これは協調的なアプリ処理量であり、ブラウザ内部のDOM/style呼出しやGCの実時間上限ではない。

workerは取得の開始・採用だけを変更queueで直列化し、executeScript/disposeの応答をqueue内で待たない。source epoch、document ID、operation IDと所有workspaceを照合して最新の選択へ候補を統合する。同URLの再読込も旧取得を失効させる。注入の応答期限は5秒。同じ文書で未settleの注入は重ねず、全体4件まで保持する。期限切れは注入そのものの停止を意味しない。閉鎖や元ページ移動後の古い結果は採用しない。仕事量だけ進んだ空の応答は、既存候補・選択を消さない。

注入と後始末の予約はworkspaceとは別のsession記録へ保存し、worker再起動や作業タブの閉鎖で未確定の予約を忘れない。loading中の元ページへ新しい注入をしない。workerが応答を再取得できない予約は保守的に保持し、元タブを閉じた通知で解放する。通常の新規取得はcollector自身が旧controllerを整理し、重複したdispose注入を増やさない。

## ImageCrate — 全14項目の現行契約、2026-10-31

ImageCrateについては、この節と [UX-COMPLETION.md](UX-COMPLETION.md) を旧版より優先する。下のv1/v2、VideoHarbor、従来の実施結果は設計履歴であり、本変更の最終合格や人間による体験確認を表さない。公開・ストア申請は行わない。

- 取得は1回500候補・12000要素で区切り、cursorで続きを取得する。上限到達で残りを永久に切り捨てない。DOM変更・期限切れは選択を保った先頭再スキャンへ案内し、保存失敗時の取得ページも再送可能にする。各取得分は現在表示する未選択候補を置換し、前の取得分の選択だけを別保持する。
- 同じimg/pictureの候補は由来・descriptor・media・type・currentSrcの関係を持つ。通常一覧は代表候補を表示し、拡大表示から別候補を比較・選択できる。「選択済み」は条件・グループ・取得ページをまたぐ全選択を表示する。「今回追加」は直前の取得で増えたURLを示す。
- 元ページ由来のnaturalWidth等は`source`であり、取得ファイルの実画素数と混同しない。拡張の画像表示で確認した`decoded`/`measured`寸法だけを最小寸法判定へ使い、未確認候補は残す。画像の読み込み直後に一覧を勝手に消さず、確認済み寸法で更新する操作を示す。
- 選択・表示条件・表示モード・開閉状態・scroll位置・focusの起点はsessionに保持する。作業タブ再読み込み時に復元するが、ブラウザ終了や拡張再読み込み後の永続復元は保証しない。選択は各作業タブ500件、全作業タブの候補情報6MiB・session情報8MiBを上限予算とし、超過は状態を壊さず通知する。
- 保存設定dialogはdraftを編集し、「設定を適用」でworker設定を確定する。キャンセル・閉じる・Escapeはdraftを破棄し、最後に適用した設定とhandleを保持する。新handleは別キーへ準備し、commit済みの応答を失った場合も実状態を確認して回復する。保存方法と最後のhandleは同じIndexedDB recordに記憶し、ページ別名と形式は新作業ページへ引き継がない。
- 選択labelと拡大・保存移動buttonを分離し、altを選択名へ反映する。キーボードで保存操作へ移動し、一覧の候補へ戻れる。再描画・別候補・前後移動・dialog終了後に操作位置を復元する。キーボード用の保存移動buttonはoverlay表示とし、focusでカードや拡大buttonの位置を動かさない。
- 再試行は元batchの中断分だけを、元の先・名前・形式で保存する。「新しい保存として準備」は中断分だけの別scopeを明示し、通常選択を保持する。取消時は通常選択へ戻し、確定時は元batch IDを由来として持つ新batchを作る。許可・取得・変換・書込・保存受付を区別してエラーと次の操作を示す。
- Chromeの保存受付が未確定の間は、URLだけで別batchのdownloadを引き継がない。30秒でAPIの応答待ちを区切り、所有・時刻・名前を照合する。結果不明は期限だけで解消せず、照合と再試行拒否を保持して重複送信を防ぐ。内部`chrome.alarms`は受付未確定・取消待ち・全owned active native保存・回収可能な画像資源の後片付けを対象に1件使い、onCreated/onChanged/startupも照合する。対象がなくなれば解除する。Chrome116互換の1分遅延を使い、背景処理・OSスリープで遅れるため30秒以内の結果表示は保証しない。downloadの受付と実保存完了は区別する。host権限の範囲や外部通信は増やさない。
- 元形式は内容を変換せず、拡張子不明候補へ既知画像MIMEによる名前を補う。任意フォルダでは先頭の限定的な署名確認も使う。確定できない形式は中立な`.img`と形式不明表示を使い、変換保存は実際の出力MIMEと一致する拡張子にする。

全14項目の対応、独立審査で修正した安全性・focusの問題、今回の自動確認と本人試用の未確認範囲は [UX-COMPLETION.md](UX-COMPLETION.md) に集約する。最終suiteの数値は最終実行後に主担当が追記する。

## ImageCrate — 保存先とフォルダ名、2026-10-31

追加の保存形式（元の形式/JPEG/PNG/WebP）、変換時の静止画・透過・batch・Blobの契約は [SAVE-DESTINATION.md](SAVE-DESTINATION.md) の「保存形式の追加」を優先する。保存先と名前に続けて形式を指定し、画面下で現在の形式を確認できる。

保存先の指定・まとめるフォルダ名・batch固定・権限と状態の契約は同資料を優先する。従来のChromeダウンロード先を初期値にし、任意フォルダへの直接保存を選べる。保存先はfooterで確認、編集はdialog。元の形式＋Chrome先のタブ閉鎖後継続を維持し、任意フォルダまたは形式変換のときはタブ保持を開始前に表示する。

## ImageCrate v3 — gallery refinement, 2026-10-31

ImageCrateの画面表現は [UX-REFINEMENT.md](UX-REFINEMENT.md) の現行追補を優先する。検索、画像グリッド、選択保存を常時表示。最小寸法/形式と使い方は開閉式とし、適用条件のチップと解除経路は閉鎖時も残す。カードの寸法/形式/保存状態、非表示選択件数、完了/中断/再試行は維持する。ローカルSVG、短い選択/開閉の反応、実状態に対応した進捗バーを用い、reduced-motionに対応。権限方針とローカル処理を維持し、取得・保存・sessionの現行契約は上の全14項目の節へ更新する。独立審査、案の比較、検証条件と人間評価の未確認範囲はリンク先を参照。

## v2 amendments (supersede v1 wording below)

- PL-01 / ART-02: Video workspace has two clearly labeled views, default '動画を保存', second '画面を録画'. Direct file saves are '元のファイルを保存'. Stream/blob candidates grouped separately as '直接保存に未対応。録画を試せます' with only a link to recording settings, never automatic start. Empty results also link to settings. Recording explains '選んだタブ・画面全体をWebMで実時間録画。音声の可否は共有対象・OSによる。保護された映像は保存できない場合があります'. Active capture and result show actual track audio presence, method and format.
- PL-02 / ART-01: Freeze each download batch when Save is clicked. Disable duplicate save and re-scan until its jobs reach terminal status. Filtering may change view only, never the batch. Show visible/total counts, selected/hidden counts and batch completed/interrupted/in-progress counts separately. Successful image download automatically deselects only that image. Failures retain selection; retry queues failed jobs only. Deliberate reselection permits re-saving. Re-scan merges state by URL and adds new images unselected. Empty scan and empty filter have different recovery instructions.
- ART-03 / PL-03: Recording controls order target → audio → output mode → output choice → start. File-choice cancel preserves previous chosen output/result and is never treated as new ready/saved. Display picker cancel preserves previous recording result. Previous unsaved memory recording blocks a new start until explicitly saved or discarded; beforeunload warns. During starting/recording/paused/finalizing disable scan/target/audio/output/new starts. Always-visible panel shows method, target, actual audio, elapsed, bytes, pause/resume and Stop. '保存を確定中', 'ファイル保存完了', '録画できました・保存してください' and failure are distinct. Write failure leaves a possibly incomplete file and explicit recovery guidance; never 'saved'. No claim of guaranteed screen recording.
- TECH constraints: recording lock persisted in storage.session with owner workspace tab; clear on tab close and verify owner exists before acquisition. tabCapture.getCapturedTabs supplements lock. For display capture invoke getDisplayMedia immediately in the click handler before any await, acquire lock after capture resolves and stop tracks on lock denial. Tab capture acquires lock in worker, returns stream ID to the consumer tab and consumes immediately. File handle is chosen beforehand; createWritable only after capture consent; writes serialized with promise chain. Finalize after recorder stop/final dataavailable → writes → close. Bound application buffering at 256 MiB (stop threshold, not a strict process-memory cap); 30-minute active recording limit including disk mode. Disk writes have queued-byte limit. onChanged tracks terminal states, active search polling supplies download progress and recovers missed events. Never alter regular Chrome profile. Extension workspace messages accepted only from own workspace page and associated tab/session. Scan rejects a source tab with changed URL/origin, tells user to invoke extension again on that page. Cap source scans and session count with visible notices/controlled error.
- ART details: Header source title/domain and source-tab button, quiet rescan; image toolbar (query/min width/min height/type), visible-count row, native-checkbox grid, sticky action footer. Video direct/record navigation switches focus to selected view heading; active recorder remains primary. Thumbnails use contain, lazy loading, per-card error placeholder. All labels/focus rings visible, status aria-live only aggregates, no high-frequency progress announcements. Width responsive down to 360px. No decorative animation necessary.

Independent reviews requested from planner, artist and programmer; v2 was reviewed before director implementation approval. Human experience remains unverified; this is initial functional implementation, not a public release.

## Director approval — 2026-10-30

v1 independent reviews: planner L1/L2 pass, PL-01/02 must-fix; artist ART-01/02/03 hold; programmer TD-01–06 must-reflect. v2 re-reviewed by the same independent specialists with concrete revised flows: planner L1–L3 pass, artist L1–L3 pass (real L4 pending), programmer pass for bounded v0.1 implementation. All fixed-ID design items resolved in v2. Technical clarification: scanner injects only top document and recursively accesses same-origin frame DOM; capture lock mutation uses one worker queue and per-page owner token, cleans stale reload ownership. Main agent director approves implementation of v2 as a local initial functional version. No public release, real macOS picker/audio claim or human-experience approval. Artist→planner→director integration checked against v2; no conflicting requirements remain. Reviewer input and original verdicts retained in this chat; project DESIGN.md records findings and amendments.

User: create two separate Chrome extensions under separate repository folders; image bulk save with selection before saving, and video save with several methods including screen recording. Future OSS release, no publication now. New empty repositories, no existing source/dirty work, no GitHub remote. Buildless JavaScript ES modules, MV3, Chrome 116+, no runtime third-party dependencies or server. Japanese UI, keyboard usable, local processing, no analytics.

Concept: people browsing a page can inspect what can be saved and deliberately keep the items or scene they need, with an honest result and a recovery path.

ImageCrate: action click opens a persistent full-page gallery for that source tab. Temporary activeTab + scripting access; no permanent all-sites host permissions. Scan img/currentSrc/src/srcset/lazy src, picture sources, CSS background images, open shadow roots and accessible frames. Dedupe by full URL (preserve query). Scan only already-present DOM; no automatic scrolling or network sniffing. Explain inaccessible cross-origin frames and lazy loading. HTTP(S) and image data URLs only in v0.1; page blob URLs explicitly unsupported. Show thumbnail, dimensions when known, source filename. Nothing selected initially. Filter by text, minimum dimensions, image type; select visible/clear selection; hidden selected count and total count remain explicit. Save selection includes all selected; no silent inclusion. Chrome downloads to ImageCrate/<sanitized source title>, unique conflict names, sequential queue. Per-item queued/in-progress/completed/interrupted status, no false 'saved' on request acceptance, retry failed. Re-scan replaces the current candidate page while retaining selected records and completed results; continuation also keeps prior-page selections. Unknown file dimensions stay visible until measured in the extension. Empty/error/retry states and source-tab navigation/closure handled with visible error; action click on source grants again. Preview requests are limited to shown thumbnails with no referrer. Scan size bounded with visible truncation notice.

VideoHarbor: same persistent workspace with two primary sections, found videos and recording. Scan video/src/source, direct links ending in known video or m3u8/mpd suffixes, performance resource entries with known media suffix (no webRequest). List direct HTTP(S) media files vs streaming manifests/blob/MSE needing recording. Direct save through Chrome downloads, sanitized name, progress/failure/retry. Do not claim all sites supported. DRM/protected content unsupported; no protection bypass. Do not play remote preview automatically or load video URLs merely by listing. No broad host permissions.

Recording: (1) current source-tab capture via tabCapture.getMediaStreamId({targetTabId, consumerTabId: managerTabId}) in service worker, consumed promptly by extension manager using getUserMedia; (2) getDisplayMedia from a direct button click, browser picker chooses tab/window/screen. Explicit start, audio checkbox (system/tab, no microphone), stop/pause/resume. Inline muted preview, recording elapsed time and bytes, audible tab playback restored by AudioContext only for tabCapture. Before start choose output using showSaveFilePicker, but separate 'choose output' and 'start' actions preserve user activation for display picker. Stream chunks via writable file when supported (no large memory growth); fallback in-memory capped at 256 MiB and 30 minutes with visible limit, auto-stop then retain a Blob to save manually. Detect supported WebM MIME; audio track presence shown. User browser stop and source-tab close trigger orderly finalization. Close/reload warns while recording/unsaved Blob; cannot guarantee crash recovery. File output is finalized before reporting ready, on write failure stop recording and show partial-file limitation; no false success. Disable second start/scan conflicts during state transition, prevent overlapping capture across managers using live getCapturedTabs for tab mode and a lightweight worker lock cleared when manager closes. Stop all tracks, close AudioContext after finalize; Blob URL alive through download completion. Keep completed recording available for retry until explicit replacement. No offscreen recording v0.1: workspace must stay open; background-tab throttling/platform behavior to test.

UI: warm off-white canvas, dark ink, indigo selection for images / teal recording for video, clear text labels. Header product + source title; primary action sticky footer; explanatory detail collapsed. Save/record state visible without color dependence, aria-live status and native form labels/focus rings. Initial flow open→inspect→select/start→save result. Repeat use re-scan without onboarding. Compare: popup-only loses state/recordings on close (reject), all-site sniffing adds unnecessary access (defer), combined product creates competing modes (user explicitly requires separate), tab + display capture complement direct download. HLS/DASH assembly, network interception, FFmpeg remux, ZIP image export, region crop and scheduled automation are roadmap items, never dead buttons.

Verification: Node unit tests for URL/filename/filter/merge/media classification/queue states; isolated Chromium with both unpacked extensions and synthetic local fixture for selection/rescan/download completion and recording/cancel/track teardown/save. No existing user Chrome profile or real private page used. Actual macOS display-picker/audio behavior and human experience remain explicitly unverified if isolated automation cannot cover them. README install (chrome://extensions Load unpacked extension/), permissions/privacy/limits, CONTRIBUTING, SECURITY, provisional MIT LICENSE, manual QA matrix and roadmap. Local commits; no GitHub creation/publication because future release only. Director will record implementation-start approval after independent design review resolves requirements.


## v0.1 implementation review and verification — 2026-10-30

- Planner PLI-01 was withdrawn after checking the complete HTML (the download footer existed). PLI-02/03 resolved: per-URL download history is separate from the current batch, recording cannot switch away from its controls while active. Independent planner re-review passed for those code paths.
- Programmer BG-01/02/03 resolved: accepted download batches continue after the workspace closes, capture ownership checks the owner's extension URL, cancellation reconciles Chrome's actual state to avoid marking completed downloads as failures. Independent requirement-based Chrome API mock tests pass.
- Programmer BG-04 resolved: srcset tokenization preserves commas within CDN URL tokens. Dedicated regression tests pass.
- Artist ART-03-UI01 resolved: capture state, actual audio, elapsed time and pause/stop live in a fixed control panel during starting/recording/paused/finalizing. A 360×800 browser check confirms Stop remains in the viewport after scrolling. Independent visual re-review passed with no remaining must-fix findings in that scope.
- Root independently reviewed RecorderController cleanup, final chunk/write ordering, saved-result retention, browser errors and output-handle presentation. The chosen output filename is distinct from the previous result filename; capture-control errors retain safe actionable local explanations.
- Automatic browser tests use a temporary Chrome profile and localhost fixtures. Test-only host access and a test entry point are added only to the temporary copy, never to extension/manifest.json. Image collection/selection/save/retry/rescan and video direct save plus synthetic capture → actual MediaRecorder → pause/resume/stop → saved WebM playback passed. Browser worker stop/restart is verified by a changed boot ID, followed by session result recovery. Tests remove only their own temporary profiles afterward.
- Human first/repeat experience, real toolbar activeTab invocation, native macOS screen/file pickers, actual tab/system audio, protection-dependent output and long background sessions remain unverified. Automatic tests do not claim public-release readiness. No measurement of subjective ease, confidence or timing was performed.

### Scope and priorities after v0.1

Initial functional implementation is delivered locally. Before public release, validate the manual QA matrix and supported-site behavior, choose the final product names/license/attribution, and prepare distribution materials. HLS/DASH assembly, ZIP, remux and other roadmap items remain unimplemented. Future improvements should follow observed demand; no monitoring or publication was enabled.
