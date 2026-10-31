# ImageCrate / VideoHarbor — initial design v1

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
