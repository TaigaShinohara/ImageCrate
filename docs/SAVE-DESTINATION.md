# 保存先とフォルダ名 — 2026-10-31

## 現行の適用・復旧契約

全14項目のうちP06/P12/P13/P14を反映した現行仕様を、この節で旧版に優先させる。全体の対応表・本人試用は [UX-COMPLETION.md](UX-COMPLETION.md)、検証記録は [QA.md](QA.md) を参照する。

- dialogを開いた時点で適用済み設定からdraftを作り、名前・形式・フォルダの選択はdraftだけへ反映する。「設定を適用」で確定し、キャンセル・閉じる・Escapeでは破棄して「変更」へfocusを戻す。適用だけでは保存を始めない。
- 新しいフォルダhandleは別のsessionキーへ準備する。準備中のキーも整理対象から保護し、worker設定commit後に適用済みhandleとして使う。設定の応答が失われたときはworkerの状態を照合し、確定済みhandleを無条件に削除しない。結果不明なら再確認の案内を出す。
- 次の作業ページへ記憶するのは、適用した保存方法と最後のhandleをまとめたIndexedDB recordだけ。Chromeのダウンロード先へ戻しても最後のhandleを保持できる。まとめるフォルダ名は新しいページ名、形式は元の形式から始める。旧handle-onlyの記録は読み取り互換を持つ。
- 作業ページの開始時に継承先をsession固有の設定とhandleへ固定する。他の作業ページが最後の場所を変更しても、再読み込みで保存先を切り替えない。設定未記録の旧active batchは固定済みbatch設定を使い、処理中に設定を書き換えない。
- worker設定とIndexedDBの記憶をまたぐ単一transactionはない。今回の設定が適用済みでも次回用の記憶だけに失敗した場合は、その違いを表示する。適用失敗・確認待ちを成功扱いにせず、元の設定や準備handleを確認できる状態を保つ。
- 「中断分を再試行」は元batchの先・形式・名前で、中断分だけを処理する。「中断分を新しい保存として準備」は通常の選択を変えず、中断分だけの別scopeで設定を開く。新規保存の直前に対象を明示し、元batch IDを由来に持つ別batchへ送る。取り消すと通常の選択保存へ戻る。
- 保存先の許可、配信元の許可、取得、変換、書込、Chrome受付を段階として区別し、失敗した段階と次の操作を表示する。受付が不明なChrome downloadは30秒を照合の判定期限とし、拡張・batchの所有、時刻、名前などを照合して回復する。未確定分だけに内部アラームを1件設定し、downloadイベント・起動時も照合、全件解消後に解除する。Chrome116互換の1分遅延を使い、背景処理やOSスリープで遅れるため、30秒以内の結果表示は保証しない。受付済みファイルをURLだけで別batchへ結び付けず、同じ画像の重複開始を避ける。
- 元形式では内容を変換しない。拡張子不明候補について、Chrome先ではChromeの画像MIME、任意先ではMIMEと限られた先頭署名から拡張子を補う。既知形式を確定できない候補は`.img`と形式不明表示を保つ。JPEG/PNG/WebP指定時は実変換と出力MIME確認を行う。命名イベント順序と実ファイル名・内容の受入結果はQAへ記録した。

Chrome116は公式テスト版の基本動作を確認した。本人は提示した操作試用を「試して問題なし」と回答した。実OS pickerの利用有無・実VoiceOverと個別条件は未確認で、詳細はQAへ記録する。以下の当初審査と以前のPASS記録は、その時点の範囲に限る。

## 当初の設計と履歴

本人依頼: 保存する場所と、画像をまとめるフォルダの名前を指定したい。実装まで行い、使いやすい形を目指す。対象はImageCrateの保存導線だけとし、収集・フィルター・公開は範囲外。

コンセプト: 選んだ画像を、意図した場所と名前でまとめて残し、実際の結果を確認して終える。

## 設計と比較

既存の選択→保存は手順が少ないため維持。毎回の保存先選択を必須化せず、footerの保存先表示＋「変更」に設定を統合する。毎画像のsaveAsは大量保存の負担が大きいため不採用。Chrome全体の設定変更は拡張専用の保存先指定にならず不採用。名前だけの追加では今回の依頼を満たさないため、任意フォルダへ直接保存する方式を追加した。

詳細はnative dialogへ分離し、保存先→まとめる名前→実保存先プレビューの順に示す。viewport内で高さを制限し、本文scroll中も閉じる操作に到達可能。現行仕様ではEscapeはdraft取消で「変更」へfocusを戻し、適用ボタンだけで確定する。普段は従来の最短導線を維持し、適用した最後の場所を端末内で記憶する。初回・反復の使いやすさ向上は設計意図で、人間の理解・テンポは未評価。

Chrome設定先では `ImageCrate/入力名`、任意先では `選択したフォルダ/入力名`。空欄はページ名、安全化後をプレビュー。日本語・絵文字を分断せず160 UTF-8 bytes / 90 codepoints以内。フォルダ名を二度安全化しても変化しない。同名ファイルは連番suffixで区別し、既存画像を上書きしない。

## 状態と技術条件

- 開始時に対象URL、保存先、フォルダ名、batch IDとjob IDを固定。再試行も元batch先で中断分のみ。成功分は選択解除し、意図的な再選択は再保存可能。
- Chrome downloadsは従来どおりworkerで追跡し、タブ閉鎖後も受理済みbatchを継続する。
- File System Access方式は作業ページでfetch→stream write→closeし、close成功後のみ完了。workerの寿命と全体serial queueを長時間writeで拘束しないため、この方式だけタブ保持を保存前から表示する。beforeunload警告、再読込後の中断回復、旧instance/jobからの遅い更新拒否を実装。
- フォルダpickerはclick直下。キャンセルは前設定保持。復元したhandleの書込許可が必要なら別clickで再接続。retryのフォルダ再許可とsite許可を一度のclickに重ねない。
- handleはIndexedDBに用途別で保存し、最後の保存方法とhandleは同一recordにする。不要handle整理はworkerのmutation queue内で最新のsession一覧と準備中キーから行い、別タブの新batchや未確定の準備handleを古いsnapshotで消さない。
- 常時hostアクセスは追加しない。HTTP/S optional host宣言から、選択URLの具体hostだけを保存clickで要求する。ワイルドカードhostを含む画像URLは拒否し、全サイトrequestへ拡大させない。Cookie値・debugger・webRequestの取得権限は追加しない。許可はChrome管理で保持され、設定から取り消せる。
- 同名判定からwrite確定までorigin共通Web Lockで拡張内の同時保存を直列化。HTTPエラー・HTML/JSON/XML応答・空body・30秒無進捗を中断扱い。失敗時は自分で新規作成した空ファイルだけ後片付けし、既存/置換/非空のファイルは削除しない。外部アプリによる同時編集の完全な排他は保証できない。

## 独立審査と開始判断

concept-driven-uxを使用。正本Page読取ツールが提供されていないため、同梱manual-snapshotとreview-protocolの必要章を参照（最新版差分未確認）。プランナー・技術担当の独立設計審査、artistのv2再審査を実施。artist UI-01〜04（高さ、正確な保存先、batch固定、安全化preview）はnative dialogと具体仕様で解消し、対象L1/L2/L3の実装開始可と判定。主担当ディレクターがこの範囲の実装を承認。

実装の独立コード審査では、handle整理競合・retryのuser activation切れ・予約名と先頭空白dotの安全化非冪等を指摘。worker内の最新一覧による整理、二段許可の別click化、安全化の順序とbyte予算修正を採用。検証結果と残件はQA.mdへ記録する。

技術根拠: [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)、[optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。実OS picker・実サイトの認証/リダイレクト・人間の体験は自動試験の合格へ含めない。

## 保存形式の追加 — 2026-10-31

本人依頼: ダウンロードする拡張子を選べるようにする。拡張子だけの変更は内容と拡張子が一致しなくなるため採用せず、元の形式（初期値）/JPEG(.jpg)/PNG(.png)/WebP(.webp)を実変換する方式を採用。品質sliderや画像ごとの設定を増やさず、既存dialogへ「保存形式」を統合。footerに次の保存形式、batchに今回の形式を表示し、元画像を絞り込む形式条件とは区別する。設定は作業ページ内で保持し、新作業ページでは元形式から開始する。

JPEGは白背景、PNG/WebPはalpha保持。browser image decoderとOffscreenCanvasを利用し、同形式を選んでも再エンコードする。アニメ画像は既定画像/なければ最初のframeを静止画にし、SVGはdecodeした自然寸法で画像化。ChromiumでSVG Blobの直接decodeが拒否される場合はinert Image.decode→自然寸法を明示したbitmapを使用する。要求MIME・空でないBlobを確認し、PNGへの暗黙fallbackは拒否する。

変換には選択した画像の具体hostだけの既存任意許可を使用し、manifest権限・外部依存は増やさない。元形式＋Chrome先の背景継続を保ち、`requiresWorkspace`で任意先または変換のbatchを共通管理する。変換する場合はChrome先でも作業タブ保持を開始前に表示する。形式・保存先・名前・対象はbatchへ固定し、変換失敗で元形式へ自動保存しない。

Chrome先への変換保存はpageがBlobを作り、workerがbatch/owner/job/自拡張Blob URLを検証してdownload IDを保存する。Blob URLは受付時に破棄せず、Chromeの実complete/interruptedまで保持。応答喪失時も実状態を回復するまで早期解放しない。worker再起動後はIDを追跡し、元URLを代わりに開始しない。Stop/reload/closeはdownloadをcancel＋実状態を確認し、直前completeを保持。確定していないIDは処理中のままにして二重retryを防ぐ。未開始変換は中断へ回復する。

圧縮入力32MiB/出力64MiB/2400万画素/片辺16384px、30秒無進捗timeout、1件ずつ処理する。Stop後に遅れてdecodeしたbitmapはclose、encode結果は破棄し保存を始めない。これは保持する入力/canvasの上限でnative decoder内部の一時allocationの厳密上限ではない。

独立UX/技術設計審査で、FMT-01（管理主体）、FMT-02（Blob/download終端）、FMT-03（MIMEと静止画規則）を具体化。主担当ディレクターはこの範囲の実装開始を承認。独立コード審査では未対応形式のprototype名と、controller終了前retryの競合を指摘し、own-property検証と再試行guardを採用。正本Pageツール未提供のため、この案件も同梱UXマニュアルの参照を継続し、最新版差分は未確認。

形式の仕様根拠: [HTML ImageBitmap](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html)、[Canvas出力](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)。検証事実と残件はQA.mdへ記録する。
