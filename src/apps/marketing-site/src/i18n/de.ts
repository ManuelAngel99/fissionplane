import type { Dictionary } from './types'

export const de: Dictionary = {
  meta: {
    title: 'FissionPlane — Selbstgehostete Sandboxes und Serverless-Funktionen',
    description:
      'FissionPlane ist eine Open-Source-Plattform, die sichere Sandboxes und Serverless-Funktionen in Firecracker-microVMs auf Ihrer eigenen Infrastruktur ausführt.',
    imageAlt:
      'FissionPlane — selbstgehostete Sandboxes und Serverless-Funktionen auf Firecracker-microVMs',
  },
  nav: {
    contact: 'Kontakt',
    github: 'GitHub',
    githubTitle: 'FissionPlane-Quellcode auf GitHub',
    docs: 'Docs',
    docsTitle: 'FissionPlane-Dokumentation',
    homeAriaLabel: 'FissionPlane-Startseite',
  },
  hero: {
    heading:
      'Sichere Sandboxes und Serverless-Funktionen auf Ihrer eigenen Infrastruktur',
    body: 'FissionPlane ist eine Open-Source-Compute-Plattform auf Basis von Firecracker-microVMs. Erstellen Sie interaktive Sandboxes für KI-Agenten in Millisekunden. Deployen Sie Funktionen, die auf null skalieren. Jedes Byte bleibt auf Hardware, die Sie betreiben.',
  },
  platform: {
    heading: 'Deployen Sie in Ihre eigene Cloud',
    tagline:
      'Ein Helm-Chart installiert die gesamte Plattform auf jedem Kubernetes-Cluster: EKS, GKE, AKS oder auf Ihren eigenen Maschinen.',
    note: 'Läuft auch auf k3s, Bare Metal und in Air-Gapped-Netzen.',
  },
  install: {
    heading: 'Ein FissionPlane-SDK verbinden',
    tagline:
      'Erstellen Sie Sandboxes und deployen Sie Funktionen aus TypeScript, Python oder Rust.',
    groupLabel: 'SDK auswählen',
    copyLabel: 'Installationsbefehl kopieren',
    copiedLabel: 'Kopiert',
    copyCode: 'Code kopieren',
    agentPrefix: 'Oder',
    agentLink:
      'lassen Sie Ihren KI-Agenten ein eigenes SDK aus der OpenAPI-Spezifikation bauen',
    copiedToast: 'Prompt in die Zwischenablage kopiert',
  },
  workloads: {
    heading: 'Zwei Workloads. Eine Plattform.',
    intro:
      'Sandboxes und Funktionen laufen auf demselben Substrat: unveränderliche Templates, Firecracker-microVMs, Snapshots und Capability-Tokens.',
    sandboxes: {
      title: 'Sandboxes',
      tagline:
        'Zustandsbehaftete, interaktive Linux-Umgebungen für Agenten und Tools.',
      bullets: [
        'Erstellen Sie eine Sandbox aus einem Template in Millisekunden.',
        'Führen Sie Befehle aus und streamen Sie stdin, stdout und stderr.',
        'Öffnen Sie PTY-Sitzungen, senden Sie Signale und beobachten Sie Dateien.',
        'Geben Sie Gast-Ports über private oder öffentliche HTTPS-URLs frei.',
        'Pausieren Sie im Objektspeicher. Setzen Sie mit intakten Prozessen fort.',
      ],
    },
    functions: {
      title: 'Funktionen',
      tagline: 'Code einmal deployen. FissionPlane führt ihn bei Bedarf aus.',
      bullets: [
        'Deployen Sie versionierte Funktionen aus OCI-Images.',
        'Rufen Sie sie über HTTPS oder nach Zeitplan auf.',
        'Starten Sie aus warmen Snapshots in Millisekunden.',
        'Skalieren Sie zwischen Aufrufen auf null.',
        'Kehren Sie mit einem Aufruf zu einer früheren Version zurück.',
      ],
    },
  },
  architecture: {
    heading: 'Ein Cluster. Vier Ebenen.',
    body: 'Die Control-Plane entscheidet, was wo läuft. Das Gateway leitet den Verkehr zum richtigen Node. Die Node-Laufzeit verwaltet die microVMs. Die Gast-Ebene gilt als feindlich. Die Control-Plane leitet niemals Workload-Verkehr weiter, daher laufen Sandboxes und Funktionen auch bei einem Ausfall der Control-Plane weiter.',
    diagramLabel:
      'Architekturdiagramm: Ein SDK- oder REST-Client verbindet sich über HTTPS mit einem Gateway und einer Control-Plane in Ihrem Kubernetes-Cluster. Das Gateway leitet den Verkehr an vm-host-Nodes weiter, die Firecracker-microVMs ausführen. Snapshots bewegen sich zwischen Nodes und Objektspeicher.',
  },
  useCases: {
    heading: 'Was auf FissionPlane läuft',
    items: [
      {
        title: 'KI-Agenten',
        body: 'Geben Sie jedem Agenten einen vollständigen Linux-Arbeitsbereich mit eigenem Kernel.',
      },
      {
        title: 'Code-Interpreter',
        body: 'Führen Sie modellgenerierten Code aus. Erhalten Sie Dateien, Diagramme und Logs.',
      },
      {
        title: 'Serverless-APIs',
        body: 'Stellen Sie Funktionen hinter HTTPS-Endpunkte, die auf null skalieren.',
      },
      {
        title: 'CI- und Build-Jobs',
        body: 'Führen Sie jeden Job in einer sauberen microVM aus. Zerstören Sie sie nach dem Job.',
      },
      {
        title: 'Datenanalyse',
        body: 'Analysieren Sie nicht vertrauenswürdige Datensätze isoliert, nah an Ihren Daten.',
      },
      {
        title: 'Geplante Jobs',
        body: 'Führen Sie Funktionen nach Zeitplan aus. Cron, auf Ihrer eigenen Hardware.',
      },
    ],
  },
  what: {
    heading: 'Was ist FissionPlane?',
    body: 'FissionPlane ist eine selbstgehostete Compute-Plattform für nicht vertrauenswürdigen Code. Sie gibt KI-Agenten, Code-Interpretern, Entwicklerwerkzeugen und CI-Systemen einen sicheren Ort zur Ausführung. Workloads laufen in Firecracker-microVMs auf Kubernetes-Nodes, die Sie betreiben.',
    bullets: [
      {
        strong: 'Hardware-Isolation.',
        text: 'Jeder Workload läuft in einer Firecracker-microVM mit eigenem Kernel, Dateisystem, Netzwerk-Namespace und Ressourcenlimits.',
      },
      {
        strong: 'Zustandsbehaftete Sandboxes.',
        text: 'Pausieren Sie eine Sandbox im Objektspeicher. Setzen Sie Speicher, Prozesse und Dateien dort fort, wo sie gestoppt wurden.',
      },
      {
        strong: 'Serverless-Funktionen.',
        text: 'Deployen Sie versionierte Funktionen, die aus warmen Snapshots starten und auf null skalieren.',
      },
      {
        strong: 'Steuerung per SDK.',
        text: 'Verwalten Sie alles aus TypeScript, Python oder Rust über gemeinsame OpenAPI-Verträge.',
      },
      {
        strong: 'Vollständig selbstgehostet.',
        text: 'Control-Plane, Data-Plane und Compute laufen auf Ihrer Infrastruktur. Kein proprietärer Dienst erforderlich.',
      },
      {
        strong: 'Kubernetes-nativ.',
        text: 'Lässt sich mit einem Helm-Chart in einen bestehenden Cluster installieren. Kein Operator. Keine Custom Resources.',
      },
      {
        strong: 'Resilienter Datenpfad.',
        text: 'Workloads laufen bei einem Ausfall der Control-Plane weiter. Die Control-Plane leitet niemals Verkehr weiter.',
      },
    ],
    link: 'FissionPlane-Dokumentation lesen',
  },
  faq: {
    heading: 'Häufig gestellte Fragen',
    items: [
      {
        question: 'Was ist FissionPlane?',
        answer:
          'FissionPlane ist eine quelloffene, selbstgehostete Plattform für sichere Codeausführung. Sie führt zwei Workload-Typen auf einem Substrat aus: interaktive Sandboxes und Serverless-Funktionen. Jeder Workload läuft in einer isolierten Firecracker-microVM mit Kontrollen für Befehle, Dateisystem, Netzwerk und Lebenszyklus.',
      },
      {
        question: 'Ist FissionPlane Open Source?',
        answer:
          'Ja. FissionPlane ist freie Open-Source-Software unter der Apache-Lizenz 2.0. Control-Plane, Gateway, Node-Laufzeit, Gastprogramme, API-Verträge und SDKs liegen in einem Repository. Sie dürfen es in persönlichen und kommerziellen Projekten nutzen, gemäß den Lizenzbedingungen.',
      },
      {
        question:
          'Was ist der Unterschied zwischen einer Sandbox und einer Funktion?',
        answer:
          'Eine Sandbox ist zustandsbehaftet und interaktiv. Sie erstellen sie, führen Befehle aus, bearbeiten Dateien und löschen sie am Ende. Eine Funktion wird einmal deployt und viele Male aufgerufen. FissionPlane startet für jeden Aufruf eine microVM aus einem warmen Snapshot, führt Ihren Handler aus und skaliert zurück auf null.',
      },
      {
        question: 'Wie isoliert FissionPlane nicht vertrauenswürdigen Code?',
        answer:
          'Jeder Workload läuft in einer Firecracker-microVM mit eigenem Kernel, Dateisystem, Netzwerk-Namespace und Ressourcenlimits. Workloads teilen nichts mit dem Host oder untereinander. FissionPlane behandelt jedes Byte aus dem Gast als feindlich.',
      },
      {
        question: 'Benötigt FissionPlane Kubernetes?',
        answer:
          'Ja, für den heute dokumentierten Installationsweg: Ein Helm-Chart wird in einen bestehenden Kubernetes-Cluster deployt. Es braucht keinen Operator, keine Custom Resources und keine clusterweiten Änderungen.',
      },
      {
        question: 'Welche SDKs bietet FissionPlane?',
        answer:
          'TypeScript, Python und Rust. Lifecycle- und Data-Plane-APIs verwenden OpenAPI-Verträge, sodass Clients denselben Verträgen in anderen Sprachen folgen können.',
      },
      {
        question:
          'Können FissionPlane-Sandboxes pausiert und fortgesetzt werden?',
        answer:
          'Ja. Sie können eine Sandbox im Objektspeicher pausieren und Speicher, Prozesse, Dateisystem und Gerätezustand dort fortsetzen, wo sie gestoppt wurden.',
      },
      {
        question:
          'Wie unterscheidet sich FissionPlane von gehosteten Sandbox-Plattformen?',
        answer:
          'Gehostete Sandbox-Plattformen führen Ihre Workloads in deren Cloud aus. FissionPlane gibt Ihnen dieselben Primitive — schnelle microVM-Sandboxes, Snapshots und SDKs — als freie Software auf Ihrer eigenen Hardware. Es gibt keine nutzungsbasierte Abrechnung, keine Daten verlassen Ihr Netzwerk, und Air-Gapped-Installationen funktionieren.',
      },
      {
        question: 'Wer betreibt die FissionPlane-Infrastruktur?',
        answer:
          'Sie. FissionPlane benötigt keinen proprietären Cloud-Dienst. Control-Plane, Data-Plane und Compute bleiben in Infrastruktur, die Sie betreiben. Laufende Workloads überstehen einen Ausfall der Control-Plane, weil diese ihren Verkehr nicht weiterleitet.',
      },
    ],
  },
  cta: {
    heading:
      'Führen Sie nicht vertrauenswürdigen Code zu Ihren Bedingungen aus.',
    body: 'Installieren Sie die Control-Plane mit einem Helm-Chart auf Ihrem Kubernetes-Cluster. Erstellen Sie Ihre erste Sandbox oder deployen Sie Ihre erste Funktion in Minuten.',
    link: 'FissionPlane-Dokumentation öffnen',
  },
  footer: {
    github: 'GitHub',
    docs: 'Docs',
    changelog: 'Changelog',
    license: 'Lizenz',
    brand: 'Marke',
    privacy: 'Datenschutz',
    contact: 'Kontakt',
    languageLabel: 'Sprache auswählen',
  },
  consent: {
    regionLabel: 'Cookie-Hinweis',
    heading: 'Cookie-Hinweis',
    body: 'Wir nutzen Analytics, um zu sehen, wie diese Website genutzt wird. Keine Werbung und kein Tracking über Websites hinweg.',
    privacyLink: 'Datenschutzhinweise lesen',
    allow: 'Akzeptieren',
    decline: 'Ablehnen',
  },
  privacy: {
    metaTitle: 'Datenschutz — FissionPlane',
    metaDescription:
      'Wie die FissionPlane-Website Analytics nutzt und wie Sie Ihre Auswahl ändern.',
    heading: 'Datenschutz',
    subtitle: 'Wie diese Website Analytics nutzt.',
    choice: {
      heading: 'Ihre Auswahl',
      allowed: 'Analytics ist aktiviert.',
      declined: 'Analytics ist deaktiviert.',
      undecided:
        'Sie haben noch nicht gewählt. Analytics bleibt deaktiviert, bis Sie es tun.',
      signalled:
        'Ihr Browser bittet darum, nicht getrackt zu werden. Analytics bleibt deshalb deaktiviert.',
      allow: 'Analytics akzeptieren',
      decline: 'Analytics ablehnen',
    },
    sections: [
      {
        heading: 'Analytics',
        body: 'Wir nutzen Cloudflare Web Analytics, um Seitenaufrufe zu zählen. Es setzt keine Cookies, speichert nichts auf Ihrem Gerät und trackt Sie nicht über Websites hinweg. Es wird nur geladen, wenn Sie zustimmen.',
      },
      {
        heading: 'Ihre Daten',
        body: 'Wir schalten keine Werbung, verkaufen oder teilen Ihre Daten nicht und erstellen kein Profil von Ihnen. Ihre Auswahl wird in Ihrem Browser gespeichert und verlässt Ihr Gerät nie. Wenn Sie die Daten dieser Website löschen, fragen wir erneut.',
      },
    ],
  },
  brand: {
    metaTitle: 'FissionPlane-Markenrichtlinien',
    metaDescription:
      'Logos, Wortmarken, Farben und Nutzungsregeln der Marke FissionPlane. Laden Sie die Assets als SVG und PNG herunter.',
    heading: 'Markenrichtlinien',
    subtitle: 'Ressourcen und Assets für die Marke FissionPlane.',
    downloadAll: 'Alle Assets herunterladen',
    assets: {
      icon: 'Icon',
      wordmark: 'Wortmarke',
      lockup: 'Kombination',
      darkVariant: 'für helle Hintergründe',
      lightVariant: 'für dunkle Hintergründe',
    },
    svgLabel: 'SVG',
    pngLabel: 'PNG',
    usageHeading: 'Verwendung',
    usageRules: [
      'Verwenden Sie die Kombination, wo der Platz es erlaubt. Verwenden Sie das Icon in kleinen Größen.',
      'Lassen Sie das Pixelraster intakt. Skalieren Sie die Marken in ganzen Vielfachen.',
      'Färben, dehnen, drehen Sie die Marken nicht und fügen Sie keine Effekte hinzu.',
      'Halten Sie um die Marken einen Freiraum in Höhe des Icons ein.',
    ],
    colorsHeading: 'Farben',
    colorsIntro:
      'FissionPlane verwendet eine warme Graustufen-Palette. Die Marken nutzen die vier folgenden Grautöne.',
  },
  contact: {
    metaTitle: 'Kontakt — FissionPlane',
    metaDescription:
      'Kontaktieren Sie Manuel Suarez, den Entwickler von FissionPlane.',
    heading: 'Kontakt',
    subtitle:
      'Fragen, Feedback oder Hilfe beim Deployment — schreiben Sie mir.',
    directHeading: 'Direkter Kontakt',
    directBody:
      'FissionPlane wird von Manuel Suarez entwickelt. Schreiben Sie eine E-Mail oder finden Sie mich hier:',
    emailChannel: 'E-Mail',
    formHeading: 'Nachricht senden',
    formTagline: 'Ich lese jede Nachricht und antworte per E-Mail.',
    emailLabel: 'Ihre E-Mail-Adresse',
    messageLabel: 'Nachricht',
    messageHint: 'Bis zu 3.000 Zeichen.',
    submit: 'Nachricht senden',
    sending: 'Wird gesendet…',
    success: 'Nachricht gesendet. Ich antworte bald.',
    error:
      'Die Nachricht wurde nicht gesendet. Bitte schreiben Sie mir direkt eine E-Mail.',
  },
  notFound: {
    title: 'Seite nicht gefunden — FissionPlane',
    heading: 'Seite nicht gefunden',
    body: 'Diese Seite existiert nicht.',
    homeLink: 'Zur Startseite zurückkehren.',
  },
}
