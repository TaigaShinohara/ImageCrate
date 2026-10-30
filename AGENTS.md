# ImageCrate

- README.md、docs/DESIGN.md、docs/QA.mdを読んでから必要範囲のみ変更する。
- 既存のdirty workとメディアを保持する。実行時の外部依存・解析送信は追加しない。
- 一時activeTabを優先し、広いhost権限・Cookie・debugger・webRequest権限を無断で追加しない。
- Chrome 116+ / Manifest V3、ビルドなしでextension/を読み込む構成を保つ。
- 変更に比例してnpm test / npm run check、必要ならブラウザ検証を行う。実OS picker・音声・人間の体験を自動テスト結果で確認済みにしない。
- Git操作はユーザーの継続承認方針に従う。GitHub/ストアへの初回公開は明示依頼を待つ。
