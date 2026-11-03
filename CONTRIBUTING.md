# Contributing to ImageCrate

ImageCrate への貢献をご検討いただきありがとうございます！
バグ報告、機能提案、コード改善、ドキュメントの拡充など、あらゆる貢献を歓迎します。

セキュリティやプライバシーに関する脆弱性の報告は、公開 Issue ではなく [SECURITY.md](SECURITY.md) に記載された連絡先宛にお願いします。

---

## 基本原則と設計方針

ImageCrate は、ユーザーのプライバシー保護と高い堅牢性を最優先に設計されています。プルリクエストを作成する際は、以下の原則をご確認ください。

1. **外部依存ゼロ (Zero External Runtime Dependencies)**:
   - 実行時の外部ライブラリ（npm パッケージ、CDN スクリプト、外部分析ツール等）は追加しません。
   - ブラウザ標準 API（Manifest V3、Web API、標準 JavaScript モジュール）のみで実装します。
2. **完全ローカル処理 & プライバシー優先**:
   - 外部サーバーへのテレメトリ、解析データ、ユーザーメディアの送信は一切行いません。
   - サイトの Cookie や認証情報、ブラウザ履歴への広範なアクセスを求めず、必要最小限の権限で動作します。
3. **Chrome & Safari (iOS / macOS) 両対応**:
   - `extension/` 配下のソースコードは Chrome と Safari Web Extension の両方から直接参照されます。
   - ブラウザ固有 API（`chrome.downloads` など）を呼ぶ際は、他環境でクラッシュしないようオプショナルチェーンや存在確認ガードを徹底してください。

---

## 開発環境のセットアップ

### 前提要件
- **Node.js**: v22 以上
- **Google Chrome**: 116 以上（拡張の読み込み・動作確認用）
- *(Safari開発時)*: macOS + Xcode（Command Line Tools 含む）

### 手順
```sh
# リポジトリをフォークし、ローカルにクローン
git clone https://github.com/<your-username>/ImageCrate.git
cd ImageCrate

# テスト用依存（Playwright）のインストール（ブラウザテスト用）
npm ci

# 単体テストと静的検査の実行
npm test
npm run check
```

---

## 拡張機能のローカル動作確認

### Google Chrome
1. Chrome で `chrome://extensions` を開き、右上の「デベロッパーモード」を ON にします。
2. 「パッケージ化されていない拡張機能を読み込む」をクリックし、このリポジトリの **`extension/`** ディレクトリを選択します。
3. 任意の Web ページで拡張機能アイコンをクリックして動作を確認します。
4. コード変更後は、`chrome://extensions` で拡張機能の再読み込みボタンを押してください。

### Safari (iOS / macOS)
1. `npm run safari:convert` を実行します（`safari/ImageCrate` に Xcode プロジェクトが生成・同期されます）。
2. Xcode で `safari/ImageCrate/ImageCrate.xcodeproj` を開きます。
3. 実機またはシミュレータを選び、実行（Cmd+R）します。
4. `extension/` のコード変更は Safari 側にも直接反映されます。

---

## テストと検証

変更を加えた際は、必ず以下のコマンドを実行してテストが通ることを確認してください。

```sh
# 単体テスト（Node.js 標準 test runner）
npm test

# 静的構文・権限・CSP・Safari互換性検査
npm run check

# ブラウザ結合テスト（ヘッドレス Chrome）
npm run test:browser
npm run test:ux
```

---

## プルリクエスト（PR）のガイドライン

1. **トピックブランチを作成**: `main` から分岐したわかりやすいブランチ名（例: `fix/viewer-swipe`, `feat/export-csv`）を使用してください。
2. **コミットの粒度**: 変更理由がわかるコミットメッセージを作成してください。
3. **合成テストの追加**: 新機能やバグ修正には、可能な限り対応するテスト（`tests/*.test.js`）を追加してください。
4. **機密情報の排除**: 署名付き URL、トークン、個人データ、実メディアファイルはコミットや PR に含めないでください。テストには合成 fixture（`docs/fixtures/` 等）を使用します。
5. **ドキュメントの更新**: 必要に応じて `README.md`、`docs/DESIGN.md`、`docs/QA.md` などのドキュメントを更新してください。

---

## 行動規範

本プロジェクトへのすべての参加者には、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) に定める行動規範の遵守をお願いしています。
