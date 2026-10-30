# 席替えドラフト会議システム

ブラウザだけで動く、リアルタイム同期の席替えドラフトアプリです。Firebase の無料プラン（Spark）で動きます。

- 生徒用: `https://<プロジェクトID>.web.app/`（参加コードか QR で入る）
- 教員用: `https://<プロジェクトID>.web.app/admin.html`（Google ログイン＋事前登録が必要。生徒画面にリンクはありません）

仕様の詳細は [SPEC.md](SPEC.md) を参照してください。

---

## 初回デプロイ手順

### 1. Firebase プロジェクトを用意する（ブラウザで操作）

1. <https://console.firebase.google.com/> で「プロジェクトを追加」。Google アナリティクスは不要です。料金プランは **Spark（無料）のまま**で構いません。
2. **Authentication** →「始める」→「ログイン方法」で次の2つを有効にします。
   - **匿名**（生徒用）
   - **Google**（教員用）
3. **Firestore Database** →「データベースを作成」
   - ロケーション: `asia-northeast1`（東京）をおすすめします。
   - **本番環境モード**で開始します（ルールはこの後のデプロイで上書きされます）。
4. **Hosting** →「始める」。画面の手順は飛ばして構いません（デプロイはこの後のコマンドで行います）。

### 2. 自動デプロイを設定する

`master` ブランチに push すると、GitHub Actions（`.github/workflows/deploy.yml`）がテストを実行し、成功したら Firebase にデプロイします。そのために、次の2つを設定します。

1. **デプロイ用の鍵**: Google Cloud コンソールでサービスアカウント（ロール「Firebase 管理者」）を作り、JSON 鍵を発行します。その中身を、GitHub リポジトリの Settings → Secrets and variables → Actions に `FIREBASE_SERVICE_ACCOUNT` という名前で登録します。
2. **デプロイ先**: `.firebaserc` の `projects.prod` に、本番のプロジェクト ID を書きます。

どちらかが欠けている場合、デプロイはスキップされます（テストだけ実行されます）。

手元のパソコンからデプロイすることもできます（Node.js 20 以上と Java 11 以上が必要です）。

```bash
npm install
```

```bash
npx firebase login
```

```bash
npm run deploy -- --project prod
```

### 3. 自分を管理者として登録する

1. `https://<プロジェクトID>.web.app/admin.html` を開き、Google でログインします。
2. 「管理者として登録されていません」という画面に表示される **UID** をコピーします。
3. Firebase コンソール → Firestore Database →「コレクションを開始」
   - コレクション ID: `admins`
   - ドキュメント ID: コピーした UID
   - フィールド: `name`（文字列、例: 自分の名前。内容は自由です）
4. 管理画面を再読み込みすると、部屋一覧が表示されます。

**他の先生にも使ってもらう場合**は、その先生にも同じく admin.html でログインしてもらい、表示された UID を `admins` に追加してください。先生ごとに自分の部屋だけを作成・操作できます（他の先生の部屋は操作できません）。

---

## 当日の使い方

1. 管理画面で「新しい部屋を作る」を押し、クラス名を入力します。
2. 「参加用 QR を表示」をプロジェクターに映し、生徒が参加します。
3. 座席の縦横の数、男子席・女子席・使用不可の席、固定席を設定し、「投票開始」を押します。
4. 「締め切って結果を確定」を押すと、生徒の画面に結果が表示されます。競合した人は教室内でじゃんけんをします。
5. 「第2回投票へ（競合者のみ）」を押して再投票します。これを最大3回（設定で変更可）まで繰り返し、最後に「残りを自動振り分けして終了」を押します。
6. 印刷、CSV 出力をします。必要がなくなったら「この部屋を削除」で生徒の名前ごと削除します。

---

## ローカルで試す（任意）

```bash
npm run dev
```

ブラウザで <http://localhost:5000/admin.html> を開き、「テスト用ログイン（ローカル実行時のみ）」を押します。表示された UID を、別のターミナルで次のように登録してください（`<UID>` は置き換えてください）。

```bash
curl -X POST -H "Authorization: Bearer owner" -H "Content-Type: application/json" -d '{"fields":{"name":{"stringValue":"local"}}}' "http://127.0.0.1:8080/v1/projects/demo-seat-draft/databases/(default)/documents/admins?documentId=<UID>"
```

生徒画面は <http://localhost:5000/> です。生徒を複数人試す場合は、別のブラウザやシークレットウィンドウを使ってください。ローカルのデータは本番とは完全に別で、エミュレータを止めると消えます。

## テスト

```bash
npm test
```

- `tests/draft.test.mjs`: 集計、自動振り分けのロジック
- `tests/rules.test.mjs`: Security Rules（なりすまし、投票の変更、他人の投票の盗み見、管理者権限などが拒否されること）

## 無料枠について

Spark プランの Firestore 無料枠は、1日あたり読み取り 5万回・書き込み 2万回です。40人のクラスで1回席替えをしても、読み取りは数千回程度なので十分収まります。無料枠を超えた場合はその日の操作が止まるだけで、課金されることはありません。

## ファイル構成

```
firestore.rules        Security Rules（権限の要）
firebase.json          Hosting / Firestore / エミュレータの設定
src/draft.js           集計・自動振り分けなどの純粋ロジック
src/student.js         生徒画面
src/admin.js           教員画面
src/ui.js, firebase.js 共通部品
public/                公開されるファイル（public/js は npm run build で生成）
tests/                 自動テスト
```
