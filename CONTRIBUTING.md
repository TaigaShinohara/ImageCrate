# Contributing

現在は非公開リポジトリで開発しています。問い合わせ先は [deeple+imagecratestaff@inkboxmail.com](mailto:deeple+imagecratestaff@inkboxmail.com) です。セキュリティ・プライバシーの報告方法は [SECURITY.md](SECURITY.md) を参照してください。

1. READMEとdocs/DESIGN.mdで対象と非対応を確認します。
2. 実行時の依存を追加せず、Manifest V3のローカルモジュールで実装します。
3. `npm test` と `npm run check` を実行し、必要な変更は `npm run test:browser` とdocs/QA.mdの該当場面で検証します。
4. 権限追加・保存規則・録画方式を変える場合は、必要性と初回・反復時への影響、失敗からの復帰を説明してください。

ログイン情報・署名付きURL・私的なメディア・ブラウザプロファイルはコミットや報告へ含めないでください。合成fixtureを使います。保存・復旧の変更時は [データ保持の契約](docs/PRIVACY.md) と、結果不明の処理の所有を保つことを確認します。公開・ストア申請は別途判断します。
