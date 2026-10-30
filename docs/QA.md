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

未実施: 通常Chromeへのインストール/toolbar activeTab許可操作、実サイトでの互換性、実macOS picker/画面収録許可、実タブ・システム音声、30分・容量閾値・背景長時間の実測、スクリーンリーダー、利用者による体験評価。これらを公開前の確認として残します。
