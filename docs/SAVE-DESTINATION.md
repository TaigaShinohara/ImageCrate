# 保存先とフォルダ名 — 2026-10-31

## 現行の適用・復旧契約

全14項目のうちP06/P12/P13/P14を反映した現行仕様を、この節で旧版に優先させる。全体の対応表・本人試用は [UX-COMPLETION.md](UX-COMPLETION.md)、検証記録は [QA.md](QA.md)、現行の処理上限・対応画像・保証範囲は [SECURITY-HARDENING.md](SECURITY-HARDENING.md) を参照する。

- dialogを開いた時点で適用済み設定からdraftを作り、名前・形式・フォルダの選択・次回用記憶はdraftだけへ反映する。「設定を適用」で確定し、キャンセル・閉じる・Escapeでは破棄して「変更」へfocusを戻す。適用だけでは保存を始めない。
- 新しいフォルダhandleは別のsessionキーへ準備する。準備中のキーも整理対象から保護し、worker設定commit後に適用済みhandleとして使う。設定の応答が失われたときはworkerの状態を照合し、確定済みhandleを無条件に削除しない。結果不明なら再確認の案内を出す。
- 「次の作業でもこの保存先を使う」は初期ONで、既存設定もONの挙動を維持する。次回用は適用した保存方法と最後のhandleをまとめたIndexedDB record。OFFを適用すると次回用の記録だけを原子的に取り除き、OFFのポリシーを残す。後の形式変更や別タブの古いdraftで復活させない。まとめるフォルダ名は新しいページ名、形式は元の形式から始める。旧handle-only記録はONのときに読み取り互換を持つ。
- 次回用がOFFでも、現在の作業・再読み込み・中断分の再試行に必要なsession/batchのhandleは保持する。新しい作業ページはChromeのダウンロード先から始まる。OFFは保存済みファイルやChromeの権限を消す操作ではない。詳しい保持範囲は [PRIVACY.md](PRIVACY.md) を参照する。
- 作業ページの開始時に継承先をsession固有の設定とhandleへ固定する。他の作業ページが最後の場所を変更しても、再読み込みで保存先を切り替えない。設定未記録の旧active batchは固定済みbatch設定を使い、処理中に設定を書き換えない。
- worker設定とIndexedDBの記憶をまたぐ単一transactionはない。今回の設定が適用済みでも次回用の記憶だけに失敗した場合は、その違いを表示する。適用失敗・確認待ちを成功扱いにせず、元の設定や準備handleを確認できる状態を保つ。
- 「中断分を再試行」は元batchの先・形式・名前で、結果が確定した中断分だけを処理する。結果不明のnative書き込みやChrome受付は照合を続け、同じ処理の再試行を許可しない。「中断分を新しい保存として準備」は通常の選択を変えず、中断分だけの別scopeで設定を開く。新規保存の直前に対象を明示し、元batch IDを由来に持つ別batchへ送る。取り消すと通常の選択保存へ戻る。
- 保存先の許可、配信元の許可、取得、変換、書込、Chrome受付を段階として区別し、失敗した段階と次の操作を表示する。受付が不明なChrome downloadは30秒を区切りに、確定した中断と決めず照合を続ける。拡張・batchの所有、時刻、名前などを照合して回復する。受付未確定・取消待ち・通常Chrome保存の全active jobsに内部アラームを使い、downloadイベント・起動時も照合する。画像予約の後片付けも確認し、照合対象が解消したら解除する。Chrome116互換の1分遅延を使い、背景処理やOSスリープで遅れるため、30秒以内の結果表示は保証しない。受付済みファイルをURLだけで別batchへ結び付けず、同じ画像の重複開始を避ける。
- 元形式では内容を変換しない。拡張子不明候補について、Chrome先ではChromeの画像MIME、任意先ではMIMEと限られた先頭署名から拡張子を補う。既知形式を確定できない候補は`.img`と形式不明表示を保つ。JPEG/PNG/WebP指定時は実変換と出力MIME確認を行う。命名イベント順序と実ファイル名・内容の受入結果はQAへ記録した。

Chrome116は公式テスト版の基本動作を確認した。本人は提示した操作試用を「試して問題なし」と回答した。これは以前の基本確認・試用の結果であり、今回追加した配信元同意・縮小表示・処理上限の理解を確認した結果ではない。実OS pickerの利用有無・実VoiceOverと個別条件は未確認で、今回の追試範囲はQAへ記録する。以下の当初審査と以前のPASS記録は、その時点の範囲に限る。

## 現行の画像取得・書き込み境界

- プレビューは初期ONとし、保存用を含む既存のChrome host許可または元ページの一時アクセスで自動表示する。追加のChrome許可が必要な配信元だけ実操作で要求し、同じscheme・ホストの全パス・ポートへ及ぶ範囲を示す。プレビュー未読込・拒否・未対応でも、画像の選択と元形式のChrome保存は利用できる。
- プレビュー、変換、選択フォルダへの取得は`credentials:include`でブラウザのログイン状態を使う場合がある。Refererは送らず、HTTPリダイレクトを拒否する。認証情報やCookieの値を独自に読み取る権限は追加しない。
- 任意先の元形式は1試行128MiB・120秒。変換の入力・出力は別予算で、書き込み済みの出力を元画像の受信量として二重計上しない。ネットワーク受信量とローカル出力量は同じbatchに別々に記録する。
- write/close/abortが未完了のままUIが中断を表示することがある。この場合は結果不明として後続を止め、実I/Oの終了まで書き込みlockと出力Blob予約を保持する。時間だけでlockを解放せず、自分の不確定ファイルも自動削除しない。保存先の確認後に新しい保存として準備する。
- Chrome受付済みの変換Blobは、実complete/interruptedまでURLと出力予約を保持する。履歴が見つからないだけで成功・既知の中断とせず、背景処理でも所有者とIDを照合する。作業ページ終了後に確定した処理の予約も背景処理で解放する。
- 結果不明のnative書き込みに対する保守的な予約が残ると、新しい画像処理が上限で拒否されることがある。ブラウザ再起動でsessionの一時状態は消えるが、保存先の完成・未完成ファイルは消えない。先に保存先とChrome履歴を確認する。完成済みファイルを再試行で上書きしない。
- 元URLをChrome自身が取得する通常保存では、1試行128MiB・120秒・30秒無進捗、保存全体の入力/出力各512MiB・15分・初回を含め3試行を観測基準にし、超過を観測すると取消を要求する。拡張のstream writerと同じ「超過chunkを渡さない」制御はできない。Chromeから観測できる状態・byteの限界は[安全対策と上限](SECURITY-HARDENING.md#chrome自身が取得する保存)を参照する。

## 当初の設計と履歴

本人依頼: 保存する場所と、画像をまとめるフォルダの名前を指定したい。実装まで行い、使いやすい形を目指す。対象はImageCrateの保存導線だけとし、収集・フィルター・公開は範囲外。

コンセプト: 選んだ画像を、意図した場所と名前でまとめて残し、実際の結果を確認して終える。

## 設計と比較

既存の選択→保存は手順が少ないため維持。毎回の保存先選択を必須化せず、footerの保存先表示＋「変更」に設定を統合する。毎画像のsaveAsは大量保存の負担が大きいため不採用。Chrome全体の設定変更は拡張専用の保存先指定にならず不採用。名前だけの追加では今回の依頼を満たさないため、任意フォルダへ直接保存する方式を追加した。

詳細はnative dialogへ分離し、保存先→まとめる名前→実保存先プレビューの順に示す。viewport内で高さを制限し、本文scroll中も閉じる操作に到達可能。現行仕様ではEscapeはdraft取消で「変更」へfocusを戻し、適用ボタンだけで確定する。普段は従来の最短導線を維持し、適用した最後の場所を端末内で記憶する。初回・反復の使いやすさ向上は設計意図で、人間の理解・テンポは未評価。

Chrome設定先では `ImageCrate/入力名`、任意先では `選択したフォルダ/入力名`。空欄はページ名、安全化後をプレビュー。日本語・絵文字を分断せず160 UTF-8 bytes / 90 codepoints以内。フォルダ名を二度安全化しても変化しない。同名ファイルは連番suffixで区別し、既存画像を上書きしない。

## 状態と技術条件

- 開始時に対象URL、保存先、フォルダ名、batch IDとjob IDを固定。再試行も元batch先で中断分のみ。成功分は選択解除し、意図的な再選択は再保存可能。
- 元形式＋Chrome downloadsはworkerで追跡し、タブ閉鎖後も受理済みbatchを継続する。変換を使うChrome保存は作業ページを開いておく必要があり、閉鎖時は取消と実結果の照合へ進む。
- File System Access方式は作業ページでfetch→stream write→closeし、close成功後のみ完了。workerの寿命と全体serial queueを長時間writeで拘束しないため、この方式だけタブ保持を保存前から表示する。beforeunload警告、再読込後の中断回復、旧instance/jobからの遅い更新拒否を実装。
- フォルダpickerはclick直下。キャンセルは前設定保持。復元したhandleの書込許可が必要なら別clickで再接続。retryのフォルダ再許可とsite許可を一度のclickに重ねない。
- handleはIndexedDBに用途別で保存し、最後の保存方法とhandleは同一recordにする。不要handle整理はworkerのmutation queue内で最新のsession一覧と準備中キーから行い、別タブの新batchや未確定の準備handleを古いsnapshotで消さない。
- 常時hostアクセスは追加しない。HTTP/S optional host宣言から、選択URLの具体hostだけを保存clickで要求する。ワイルドカードhostを含む画像URLは拒否し、全サイトrequestへ拡大させない。Cookie値・debugger・webRequestの取得権限は追加しない。許可はChrome管理で保持され、設定から取り消せる。
- 同名判定からwrite確定までorigin共通Web Lockで拡張内の同時保存を直列化。HTTPエラー・HTML/JSON/XML応答・空body・30秒無進捗を中断扱い。失敗時は結果とabort成功が確認できた、自分で新規作成した空ファイルだけ後片付けする。結果不明・既存・置換・非空のファイルは削除しない。外部アプリによる同時編集の完全な排他は保証できない。

## 独立審査と開始判断

concept-driven-uxを使用。正本Page読取ツールが提供されていないため、同梱manual-snapshotとreview-protocolの必要章を参照（最新版差分未確認）。プランナー・技術担当の独立設計審査、artistのv2再審査を実施。artist UI-01〜04（高さ、正確な保存先、batch固定、安全化preview）はnative dialogと具体仕様で解消し、対象L1/L2/L3の実装開始可と判定。主担当ディレクターがこの範囲の実装を承認。

実装の独立コード審査では、handle整理競合・retryのuser activation切れ・予約名と先頭空白dotの安全化非冪等を指摘。worker内の最新一覧による整理、二段許可の別click化、安全化の順序とbyte予算修正を採用。検証結果と残件はQA.mdへ記録する。

技術根拠: [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)、[optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。実OS picker・実サイトの認証/リダイレクト・人間の体験は自動試験の合格へ含めない。

## 保存形式の追加 — 2026-10-31

本人依頼: ダウンロードする拡張子を選べるようにする。拡張子だけの変更は内容と拡張子が一致しなくなるため採用せず、元の形式（初期値）/JPEG(.jpg)/PNG(.png)/WebP(.webp)を実変換する方式を採用。品質sliderや画像ごとの設定を増やさず、既存dialogへ「保存形式」を統合。footerに次の保存形式、batchに今回の形式を表示し、元画像を絞り込む形式条件とは区別する。設定は作業ページ内で保持し、新作業ページでは元形式から開始する。

JPEGは白背景、PNG/WebPはalpha保持。同形式を選んでも再エンコードする。現行版はboundedな構造検査の後、専用WorkerのcodecとOffscreenCanvasで静止画を生成する。対応するアニメ画像は1コマにする。SVGは64KiB以下・ルートと単色矩形128個までの限定描画だけを直接描き、一般のSVG・AVIFは拒否する。元BlobをページのImageへ渡すfallbackは使わない。要求MIME・空でないBlobを確認し、他形式への暗黙fallbackは拒否する。

変換には選択した画像の具体hostだけの既存任意許可を使用し、manifest権限・外部依存は増やさない。元形式＋Chrome先の背景継続を保ち、`requiresWorkspace`で任意先または変換のbatchを共通管理する。変換する場合はChrome先でも作業タブ保持を開始前に表示する。形式・保存先・名前・対象はbatchへ固定し、変換失敗で元形式へ自動保存しない。

Chrome先への変換保存はpageが生成済みBlobを作り、workerがbatch/owner/job/自拡張Blob URLと出力予約の所有者を検証してdownload IDを保存する。Blob URLは受付時に破棄せず、Chromeの実complete/interruptedまで保持。応答喪失時も実状態を回復するまで早期解放しない。worker再起動後はIDを追跡し、元URLを代わりに開始しない。Stop/reload/closeはdownloadをcancel＋実状態を確認し、直前completeを保持。確定していないIDは処理中のままにして二重retryを防ぐ。未開始変換は中断へ回復する。

変換は入力32MiB/出力64MiB/2400万画素/片辺16384px、1試行全体120秒、30秒無進捗で中断する。作業ページで行う保存全体は入力・出力を別々に各512MiB、15分、同じ画像は初回を含め3試行までとし、再試行・再読み込みで予算を戻さない。Stop後の古い結果は採用せず、Workerを終了し、Blob・bitmap・canvas・URLを解放する。未settleの検査・native I/Oに属する予約は、その実処理が終了するまで保持する。これらは拡張が管理する受入・所有の上限であり、native decoder内部の一時allocationやネットワーク上の全byteの厳密上限ではない。

独立UX/技術設計審査で、FMT-01（管理主体）、FMT-02（Blob/download終端）、FMT-03（MIMEと静止画規則）を具体化。主担当ディレクターはこの範囲の実装開始を承認。独立コード審査では未対応形式のprototype名と、controller終了前retryの競合を指摘し、own-property検証と再試行guardを採用。正本Pageツール未提供のため、この案件も同梱UXマニュアルの参照を継続し、最新版差分は未確認。

形式の仕様根拠: [HTML ImageBitmap](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html)、[Canvas出力](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)。検証事実と残件はQA.mdへ記録する。
