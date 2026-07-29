# Source: https://fissionplane.dev/ja

# 自社インフラでセキュアなサンドボックスとサーバーレス関数を実行

FissionPlane は Firecracker microVM 上に構築されたオープンソースのコンピュートプラットフォームです。AI エージェント向けの対話型サンドボックスをミリ秒で作成できます。ゼロまでスケールダウンする関数をデプロイできます。すべてのデータは自分で運用するハードウェアに残ります。

## 自分のクラウドにデプロイ

1 つの Helm チャートで、EKS・GKE・AKS や自前のマシンなど、任意の Kubernetes クラスターにプラットフォーム全体をインストールできます。

![][base64-image]

- AWS
- Google Cloud
- Azure
- Kubernetes

k3s、ベアメタル、エアギャップ環境にも対応します。

## FissionPlane SDK を接続

TypeScript・Python・Rust からサンドボックスの作成と関数のデプロイを行います。

TypeScriptPythonRust

npm install @fissionplane/sdk

```
import { FissionPlane } from '@fissionplane/sdk'

const client = new FissionPlane()
const sandbox = await client.sandboxes.create({ template: 'base' })

const result = await sandbox.commands.run('echo', {
  args: ['hello from a microVM'],
})

console.log(result.stdout)
await sandbox.delete()
```

pip install fissionplane

```
from fissionplane import FissionPlane

client = FissionPlane()
sandbox = client.sandboxes.create("base")

result = sandbox.commands.run(
    "echo",
    args=["hello from a microVM"],
)

print(result.stdout)
sandbox.delete()
```

cargo add fissionplane

```
use fissionplane::models::{CreateSandboxRequest, RunCommandRequest};
use fissionplane::{ClientOptions, FissionPlane};

#[tokio::main]
async fn main() -> Result<(), fissionplane::Error> {
    let client = FissionPlane::new(ClientOptions::new())?;

    let request = CreateSandboxRequest {
        template: "base".to_owned(),
        ..Default::default()
    };
    let sandbox = client.sandboxes().create(request, None).await?;

    let run = RunCommandRequest {
        command: "echo".to_owned(),
        args: Some(vec!["hello from a microVM".to_owned()]),
        ..Default::default()
    };
    let result = sandbox.commands()?.run(run).await?;

    println!("{}", result.stdout);
    sandbox.delete().await?;
    Ok(())
}
```

または、 AI エージェントに OpenAPI 仕様から独自の SDK を構築させる

## 2 つのワークロード。1 つのプラットフォーム。

サンドボックスと関数は同じ基盤の上で動作します。不変テンプレート、Firecracker microVM、スナップショット、ケイパビリティトークンです。

### サンドボックス

エージェントとツールのための、状態を持つ対話型 Linux 環境。

- テンプレートからサンドボックスをミリ秒で作成します。
- コマンドを実行し、stdin・stdout・stderr をストリームします。
- PTY セッションを開き、シグナルを送り、ファイルを監視します。
- ゲストのポートをプライベートまたはパブリックな HTTPS URL で公開します。
- オブジェクトストレージへ一時停止し、プロセスを保ったまま再開します。

### 関数

コードを一度デプロイすれば、FissionPlane がオンデマンドで実行します。

- OCI イメージからバージョン管理された関数をデプロイします。
- HTTPS またはスケジュールで呼び出します。
- ウォームスナップショットからミリ秒で起動します。
- 呼び出しの合間はゼロまでスケールダウンします。
- 1 回の呼び出しで以前のバージョンへロールバックします。

## 1 つのクラスター。4 つのプレーン。

コントロールプレーンは何をどこで実行するかを決めます。ゲートウェイはトラフィックを適切なノードへ届けます。ノードランタイムは microVM を管理します。ゲストプレーンは敵対的なものとして扱います。コントロールプレーンはワークロードのトラフィックを中継しないため、コントロールプレーンが停止しても実行中のサンドボックスと関数は動き続けます。

```
                 ╔═ your kubernetes cluster ═══════════════════════════╗ 
╔══════════════╗ ║   ┌───────────────┐          ┌──────────────────┐   ║░
║  SDK / REST  ║─╫──▶│    gateway    │──mTLS───▶│  node · vm-host  │   ║░
╚══════════════╝ ║   │ TLS · routing │          │  ┌────────────┐  │   ║░
 ░░░░░░░░░░░░░░  ║   └───────────────┘          │  │ ▪ microVM  │  │   ║░
                 ║   ┌───────────────┐          │  │ ▪ microVM  │  │   ║░
                 ║   │ control plane │──gRPC───▶│  │ ▪ microVM  │  │   ║░
                 ║   │ place · quota │          │  └────────────┘  │   ║░
                 ║   └───────────────┘          └────────┬─────────┘   ║░
                 ║                                 pause │ resume      ║░
                 ║                              ┌────────▼─────────┐   ║░
                 ║                              │  object storage  │   ║░
                 ║                              └──────────────────┘   ║░
                 ╚═════════════════════════════════════════════════════╝░
                  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

## FissionPlane で動くもの

- ### AI エージェント

 各エージェントに専用カーネルを持つ完全な Linux ワークスペースを提供します。

- ### コードインタープリター

 モデルが生成したコードを実行し、ファイル・グラフ・ログを返します。

- ### サーバーレス API

 ゼロまでスケールダウンする HTTPS エンドポイントの背後に関数を配置します。

- ### CI・ビルドジョブ

 各ジョブをクリーンな microVM で実行し、終了後に破棄します。

- ### データ分析

 信頼できないデータセットを、データの近くで隔離したまま分析します。

- ### スケジュールジョブ

 関数をスケジュール実行します。自社ハードウェア上の cron です。

## FissionPlane とは？

FissionPlane は信頼できないコードのためのセルフホスト型コンピュートプラットフォームです。AI エージェント、コードインタープリター、開発ツール、CI システムに安全な実行環境を提供します。ワークロードは、自分で運用する Kubernetes ノード上の Firecracker microVM で実行されます。

- **ハードウェア分離。** 各ワークロードは専用のカーネル、ファイルシステム、ネットワーク名前空間、リソース制限を持つ Firecracker microVM で実行されます。
- **状態を持つサンドボックス。** サンドボックスをオブジェクトストレージへ一時停止し、メモリ・プロセス・ファイルを停止した箇所から再開します。
- **サーバーレス関数。** ウォームスナップショットから起動し、ゼロまでスケールダウンするバージョン管理された関数をデプロイします。
- **SDK による制御。** 共有の OpenAPI コントラクトに基づき、TypeScript・Python・Rust からすべてを管理します。
- **完全セルフホスト。** コントロールプレーン、データプレーン、コンピュートはすべて自社インフラで動作します。プロプライエタリなサービスは不要です。
- **Kubernetes ネイティブ。** 1 つの Helm チャートで既存クラスターにインストールできます。オペレーターもカスタムリソースも不要です。
- **耐障害性のあるデータパス。** コントロールプレーンが停止してもワークロードは動き続けます。コントロールプレーンはトラフィックを中継しません。

[FissionPlane ドキュメントを読む](https://docs.fissionplane.dev)

## よくある質問

- ### FissionPlane とは何ですか？

 FissionPlane はセキュアなコード実行のためのオープンソース・セルフホスト型プラットフォームです。1 つの基盤の上で 2 種類のワークロード、すなわち対話型サンドボックスとサーバーレス関数を実行します。各ワークロードは、コマンド・ファイルシステム・ネットワーク・ライフサイクルの制御を備えた隔離済み Firecracker microVM で実行されます。

- ### FissionPlane はオープンソースですか？

 はい。FissionPlane は Apache License 2.0 のもとで公開される自由なオープンソースソフトウェアです。コントロールプレーン、ゲートウェイ、ノードランタイム、ゲストプログラム、API コントラクト、SDK はすべて 1 つのリポジトリにあります。ライセンス条項に従い、個人・商用プロジェクトで利用できます。

- ### サンドボックスと関数の違いは何ですか？

 サンドボックスは状態を持つ対話型の環境です。作成し、コマンドを実行し、ファイルを編集し、終わったら削除します。関数は一度デプロイして何度も呼び出します。FissionPlane は呼び出しごとにウォームスナップショットから microVM を起動してハンドラーを実行し、その後ゼロまでスケールダウンします。

- ### FissionPlane はどのように信頼できないコードを隔離しますか？

 各ワークロードは専用のカーネル、ファイルシステム、ネットワーク名前空間、リソース制限を持つ Firecracker microVM で実行されます。ワークロードはホストとも互いとも何も共有しません。FissionPlane はゲストから届くすべてのバイトを敵対的なものとして扱います。

- ### FissionPlane には Kubernetes が必要ですか？

 はい。現在ドキュメント化されているインストール方法では、1 つの Helm チャートを既存の Kubernetes クラスターへデプロイします。オペレーターもカスタムリソースもクラスター全体の変更も不要です。

- ### FissionPlane はどの SDK を提供しますか？

 TypeScript、Python、Rust です。ライフサイクル API とデータプレーン API は OpenAPI コントラクトを使うため、他の言語のクライアントも同じコントラクトに従えます。

- ### FissionPlane のサンドボックスは一時停止と再開ができますか？

 はい。サンドボックスをオブジェクトストレージへ一時停止し、メモリ・プロセス・ファイルシステム・デバイスの状態を停止した箇所から再開できます。

- ### ホスト型サンドボックスプラットフォームとの違いは何ですか？

 ホスト型サンドボックスプラットフォームは、ワークロードを各社のクラウドで実行します。FissionPlane は同じプリミティブ — 高速な microVM サンドボックス、スナップショット、SDK — を自由なソフトウェアとして自社ハードウェア上で提供します。従量課金はなく、データはネットワークの外に出ず、エアギャップ環境へのインストールも可能です。

- ### FissionPlane のインフラは誰が運用しますか？

 あなた自身です。FissionPlane はプロプライエタリなクラウドサービスを必要としません。コントロールプレーン、データプレーン、コンピュートは自分で運用するインフラに置かれます。コントロールプレーンはトラフィックを中継しないため、停止しても実行中のワークロードは動き続けます。

**信頼できないコードを、自分の条件で実行する。**

1 つの Helm チャートで Kubernetes クラスターにコントロールプレーンをインストールします。数分で最初のサンドボックスを作成するか、最初の関数をデプロイできます。

[FissionPlane ドキュメントを開く](https://docs.fissionplane.dev)