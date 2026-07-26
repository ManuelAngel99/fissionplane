import type { Dictionary } from "./types";

export const ja: Dictionary = {
  meta: {
    title: "FissionPlane — セルフホスト型サンドボックスとサーバーレス関数",
    description:
      "FissionPlane は、自社インフラ上の Firecracker microVM でセキュアなサンドボックスとサーバーレス関数を実行するオープンソースのプラットフォームです。",
    imageAlt:
      "FissionPlane — Firecracker microVM 上のセルフホスト型サンドボックスとサーバーレス関数",
  },
  nav: {
    contact: "お問い合わせ",
    github: "GitHub",
    githubTitle: "GitHub 上の FissionPlane ソースコード",
    docs: "ドキュメント",
    docsTitle: "FissionPlane ドキュメント",
    homeAriaLabel: "FissionPlane ホーム",
  },
  hero: {
    heading:
      "自社インフラでセキュアなサンドボックスとサーバーレス関数を実行",
    body: "FissionPlane は Firecracker microVM 上に構築されたオープンソースのコンピュートプラットフォームです。AI エージェント向けの対話型サンドボックスをミリ秒で作成できます。ゼロまでスケールダウンする関数をデプロイできます。すべてのデータは自分で運用するハードウェアに残ります。",
  },
  platform: {
    heading: "自社クラウドにデプロイ",
    tagline:
      "1 つの Helm チャートで、EKS・GKE・AKS や自前のマシンなど、任意の Kubernetes クラスターにプラットフォーム全体をインストールできます。",
    note: "k3s、ベアメタル、エアギャップ環境にも対応します。",
  },
  install: {
    heading: "FissionPlane SDK を接続",
    tagline:
      "TypeScript・Python・Rust からサンドボックスの作成と関数のデプロイを行います。",
    groupLabel: "SDK を選択",
    copyLabel: "インストールコマンドをコピー",
    copiedLabel: "コピーしました",
    copyCode: "コードをコピー",
    agentPrefix: "または、",
    agentLink: "AI エージェントに OpenAPI 仕様から独自の SDK を構築させる",
    copiedToast: "プロンプトをクリップボードにコピーしました",
  },
  workloads: {
    heading: "2 つのワークロード。1 つのプラットフォーム。",
    intro:
      "サンドボックスと関数は同じ基盤の上で動作します。不変テンプレート、Firecracker microVM、スナップショット、ケイパビリティトークンです。",
    sandboxes: {
      title: "サンドボックス",
      tagline: "エージェントとツールのための、状態を持つ対話型 Linux 環境。",
      bullets: [
        "テンプレートからサンドボックスをミリ秒で作成します。",
        "コマンドを実行し、stdin・stdout・stderr をストリームします。",
        "PTY セッションを開き、シグナルを送り、ファイルを監視します。",
        "ゲストのポートをプライベートまたはパブリックな HTTPS URL で公開します。",
        "オブジェクトストレージに一時停止し、プロセスを保ったまま再開します。",
      ],
    },
    functions: {
      title: "関数",
      tagline: "コードを一度デプロイすれば、FissionPlane がオンデマンドで実行します。",
      bullets: [
        "OCI イメージからバージョン管理された関数をデプロイします。",
        "HTTPS またはスケジュールで呼び出します。",
        "ウォームスナップショットからミリ秒で起動します。",
        "呼び出しの合間はゼロまでスケールダウンします。",
        "1 回の呼び出しで以前のバージョンへロールバックします。",
      ],
    },
  },
  architecture: {
    heading: "1 つのクラスター。4 つのプレーン。",
    body: "コントロールプレーンは何をどこで実行するかを決めます。ゲートウェイはトラフィックを適切なノードへ届けます。ノードランタイムは microVM を管理します。ゲストプレーンは敵対的なものとして扱います。コントロールプレーンはワークロードのトラフィックを中継しないため、コントロールプレーンが停止しても実行中のサンドボックスと関数は動き続けます。",
    diagramLabel:
      "アーキテクチャ図: SDK または REST クライアントが HTTPS で Kubernetes クラスター内のゲートウェイとコントロールプレーンに接続します。ゲートウェイは Firecracker microVM を実行する vm-host ノードへトラフィックを中継します。スナップショットはノードとオブジェクトストレージの間を移動します。",
  },
  useCases: {
    heading: "FissionPlane で動くもの",
    items: [
      {
        title: "AI エージェント",
        body: "各エージェントに専用カーネルを持つ完全な Linux ワークスペースを提供します。",
      },
      {
        title: "コードインタープリター",
        body: "モデルが生成したコードを実行し、ファイル・グラフ・ログを返します。",
      },
      {
        title: "サーバーレス API",
        body: "ゼロまでスケールダウンする HTTPS エンドポイントの背後に関数を配置します。",
      },
      {
        title: "CI・ビルドジョブ",
        body: "各ジョブをクリーンな microVM で実行し、終了後に破棄します。",
      },
      {
        title: "データ分析",
        body: "信頼できないデータセットを、データの近くで隔離したまま分析します。",
      },
      {
        title: "スケジュールジョブ",
        body: "関数をスケジュール実行します。自社ハードウェア上の cron です。",
      },
    ],
  },
  what: {
    heading: "FissionPlane とは？",
    body: "FissionPlane は信頼できないコードのためのセルフホスト型コンピュートプラットフォームです。AI エージェント、コードインタープリター、開発ツール、CI システムに安全な実行環境を提供します。ワークロードは、自分で運用する Kubernetes ノード上の Firecracker microVM で実行されます。",
    bullets: [
      {
        strong: "ハードウェア分離。",
        text: "各ワークロードは専用のカーネル、ファイルシステム、ネットワーク名前空間、リソース制限を持つ Firecracker microVM で実行されます。",
      },
      {
        strong: "状態を持つサンドボックス。",
        text: "サンドボックスをオブジェクトストレージに一時停止し、メモリ・プロセス・ファイルを停止した箇所から再開します。",
      },
      {
        strong: "サーバーレス関数。",
        text: "ウォームスナップショットから起動し、ゼロまでスケールダウンするバージョン管理された関数をデプロイします。",
      },
      {
        strong: "SDK による制御。",
        text: "共有の OpenAPI コントラクトに基づき、TypeScript・Python・Rust からすべてを管理します。",
      },
      {
        strong: "完全セルフホスト。",
        text: "コントロールプレーン、データプレーン、コンピュートはすべて自社インフラで動作します。プロプライエタリなサービスは不要です。",
      },
      {
        strong: "Kubernetes ネイティブ。",
        text: "1 つの Helm チャートで既存クラスターにインストールできます。オペレーターもカスタムリソースも不要です。",
      },
      {
        strong: "耐障害性のあるデータパス。",
        text: "コントロールプレーンが停止してもワークロードは動き続けます。コントロールプレーンはトラフィックを中継しません。",
      },
    ],
    link: "FissionPlane ドキュメントを読む",
  },
  faq: {
    heading: "よくある質問",
    items: [
      {
        question: "FissionPlane とは何ですか？",
        answer:
          "FissionPlane はセキュアなコード実行のためのオープンソース・セルフホスト型プラットフォームです。1 つの基盤の上で 2 種類のワークロード、すなわち対話型サンドボックスとサーバーレス関数を実行します。各ワークロードは、コマンド・ファイルシステム・ネットワーク・ライフサイクルの制御を備えた隔離済み Firecracker microVM で実行されます。",
      },
      {
        question: "FissionPlane はオープンソースですか？",
        answer:
          "はい。FissionPlane は Apache License 2.0 のもとで公開される自由なオープンソースソフトウェアです。コントロールプレーン、ゲートウェイ、ノードランタイム、ゲストプログラム、API コントラクト、SDK はすべて 1 つのリポジトリにあります。ライセンス条項に従い、個人・商用プロジェクトで利用できます。",
      },
      {
        question: "サンドボックスと関数の違いは何ですか？",
        answer:
          "サンドボックスは状態を持つ対話型の環境です。作成し、コマンドを実行し、ファイルを編集し、終わったら削除します。関数は一度デプロイして何度も呼び出します。FissionPlane は呼び出しごとにウォームスナップショットから microVM を起動してハンドラーを実行し、その後ゼロまでスケールダウンします。",
      },
      {
        question: "FissionPlane はどのように信頼できないコードを隔離しますか？",
        answer:
          "各ワークロードは専用のカーネル、ファイルシステム、ネットワーク名前空間、リソース制限を持つ Firecracker microVM で実行されます。ワークロードはホストとも互いとも何も共有しません。FissionPlane はゲストから届くすべてのバイトを敵対的なものとして扱います。",
      },
      {
        question: "FissionPlane には Kubernetes が必要ですか？",
        answer:
          "はい。現在ドキュメント化されているインストール方法では、1 つの Helm チャートを既存の Kubernetes クラスターへデプロイします。オペレーターもカスタムリソースもクラスター全体の変更も不要です。",
      },
      {
        question: "FissionPlane はどの SDK を提供しますか？",
        answer:
          "TypeScript、Python、Rust です。ライフサイクル API とデータプレーン API は OpenAPI コントラクトを使うため、他の言語のクライアントも同じコントラクトに従えます。",
      },
      {
        question: "FissionPlane のサンドボックスは一時停止と再開ができますか？",
        answer:
          "はい。サンドボックスをオブジェクトストレージに一時停止し、メモリ・プロセス・ファイルシステム・デバイスの状態を停止した箇所から再開できます。",
      },
      {
        question: "ホスト型サンドボックスプラットフォームとの違いは何ですか？",
        answer:
          "ホスト型サンドボックスプラットフォームは、ワークロードを各社のクラウドで実行します。FissionPlane は同じプリミティブ — 高速な microVM サンドボックス、スナップショット、SDK — を自由なソフトウェアとして自社ハードウェア上で提供します。従量課金はなく、データはネットワークの外に出ず、エアギャップ環境へのインストールも可能です。",
      },
      {
        question: "FissionPlane のインフラは誰が運用しますか？",
        answer:
          "あなた自身です。FissionPlane はプロプライエタリなクラウドサービスを必要としません。コントロールプレーン、データプレーン、コンピュートは自分で運用するインフラに置かれます。コントロールプレーンはトラフィックを中継しないため、停止しても実行中のワークロードは動き続けます。",
      },
    ],
  },
  cta: {
    heading: "信頼できないコードを、自分の条件で実行する。",
    body: "1 つの Helm チャートで Kubernetes クラスターにコントロールプレーンをインストールします。数分で最初のサンドボックスを作成するか、最初の関数をデプロイできます。",
    link: "FissionPlane ドキュメントを開く",
  },
  footer: {
    github: "GitHub",
    docs: "ドキュメント",
    changelog: "変更履歴",
    license: "ライセンス",
    brand: "ブランド",
    privacy: "プライバシー",
    contact: "お問い合わせ",
    languageLabel: "言語を選択",
  },
  consent: {
    regionLabel: "Cookie に関するお知らせ",
    heading: "Cookie に関するお知らせ",
    body: "このサイトの利用状況を把握するためにアクセス解析を使用します。広告やサイトをまたいだ追跡は行いません。",
    learnMore: "詳細",
    allow: "同意する",
    decline: "拒否する",
  },
  privacy: {
    metaTitle: "プライバシー — FissionPlane",
    metaDescription:
      "FissionPlane のウェブサイトにおけるアクセス解析の利用方法と、選択の変更方法。",
    heading: "プライバシー",
    subtitle: "このサイトにおけるアクセス解析の利用方法。",
    choice: {
      heading: "あなたの選択",
      allowed: "アクセス解析は有効です。",
      declined: "アクセス解析は無効です。",
      undecided:
        "まだ選択されていません。選択するまでアクセス解析は無効のままです。",
      signalled:
        "お使いのブラウザが追跡拒否を通知しているため、アクセス解析は無効のままです。",
      allow: "アクセス解析に同意する",
      decline: "アクセス解析を拒否する",
    },
    sections: [
      {
        heading: "アクセス解析",
        body: "ページビューの計測に Cloudflare Web Analytics を使用します。Cookie は使用せず、お使いのデバイスには何も保存せず、サイトをまたいで追跡することもありません。同意された場合にのみ読み込まれます。",
      },
      {
        heading: "あなたのデータ",
        body: "広告の配信、データの販売や共有、プロファイルの作成は行いません。選択内容はブラウザに保存され、デバイスの外に出ることはありません。このサイトのデータを消去すると、再度お尋ねします。",
      },
    ],
  },
  brand: {
    metaTitle: "FissionPlane ブランドガイドライン",
    metaDescription:
      "FissionPlane ブランドのロゴ、ワードマーク、カラー、使用ルール。アセットは SVG と PNG でダウンロードできます。",
    heading: "ブランドガイドライン",
    subtitle: "FissionPlane ブランドのリソースとアセット。",
    downloadAll: "すべてのアセットをダウンロード",
    assets: {
      icon: "アイコン",
      wordmark: "ワードマーク",
      lockup: "ロックアップ",
      darkVariant: "明るい背景用",
      lightVariant: "暗い背景用",
    },
    svgLabel: "SVG",
    pngLabel: "PNG",
    usageHeading: "使用方法",
    usageRules: [
      "スペースがある場合はロックアップを使用します。小さいサイズではアイコンを使用します。",
      "ピクセルグリッドを保ってください。マークは整数倍で拡大縮小します。",
      "マークの色変更、伸縮、回転、効果の追加はしないでください。",
      "マークの周囲にはアイコンの高さと同じ余白を確保してください。",
    ],
    colorsHeading: "カラー",
    colorsIntro:
      "FissionPlane は温かみのあるグレースケールのパレットを使用します。マークは以下の 4 つのグレートーンを使います。",
  },
  contact: {
    metaTitle: "お問い合わせ — FissionPlane",
    metaDescription: "FissionPlane の開発者 Manuel Suarez への連絡方法。",
    heading: "お問い合わせ",
    subtitle:
      "質問、フィードバック、デプロイの相談など、お気軽にご連絡ください。",
    directHeading: "直接の連絡先",
    directBody:
      "FissionPlane は Manuel Suarez が開発しています。メール、または以下のリンクからご連絡ください。",
    emailChannel: "メール",
    formHeading: "メッセージを送る",
    formTagline: "すべてのメッセージに目を通し、メールで返信します。",
    emailLabel: "メールアドレス",
    messageLabel: "メッセージ",
    messageHint: "3,000 文字まで。",
    submit: "送信",
    sending: "送信中…",
    success: "メッセージを送信しました。折り返しご連絡します。",
    error: "送信できませんでした。直接メールでご連絡ください。",
  },
  notFound: {
    title: "ページが見つかりません — FissionPlane",
    heading: "ページが見つかりません",
    body: "このページは存在しません。",
    homeLink: "ホームページへ戻る。",
  },
};
