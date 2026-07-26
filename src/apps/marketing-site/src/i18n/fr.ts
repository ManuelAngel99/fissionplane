import type { Dictionary } from "./types";

export const fr: Dictionary = {
  meta: {
    title: "FissionPlane — Sandboxes et fonctions serverless auto-hébergées",
    description:
      "FissionPlane est une plateforme open source qui exécute des sandboxes sécurisés et des fonctions serverless dans des microVMs Firecracker, sur votre propre infrastructure.",
    imageAlt:
      "FissionPlane — sandboxes et fonctions serverless auto-hébergées sur microVMs Firecracker",
  },
  nav: {
    contact: "Contact",
    github: "GitHub",
    githubTitle: "Code source de FissionPlane sur GitHub",
    docs: "Docs",
    docsTitle: "Documentation de FissionPlane",
    homeAriaLabel: "Accueil FissionPlane",
  },
  hero: {
    heading:
      "Exécutez des sandboxes sécurisés et des fonctions serverless sur votre propre infrastructure",
    body: "FissionPlane est une plateforme de calcul open source construite sur des microVMs Firecracker. Créez des sandboxes interactifs pour agents IA en quelques millisecondes. Déployez des fonctions qui redescendent à zéro. Chaque octet reste sur du matériel que vous opérez.",
  },
  platform: {
    heading: "Déployez sur votre propre cloud",
    tagline:
      "Un chart Helm installe toute la plateforme sur n'importe quel cluster Kubernetes : EKS, GKE, AKS ou vos propres machines.",
    note: "Fonctionne aussi sur k3s, bare metal et réseaux air-gapped.",
  },
  install: {
    heading: "Connectez un SDK FissionPlane",
    tagline:
      "Créez des sandboxes et déployez des fonctions depuis TypeScript, Python ou Rust.",
    groupLabel: "Choisir un SDK",
    copyLabel: "Copier la commande d'installation",
    copiedLabel: "Copié",
    copyCode: "Copier le code",
    agentPrefix: "Ou",
    agentLink:
      "laissez votre agent IA construire votre propre SDK à partir de la spécification OpenAPI",
    copiedToast: "Prompt copié dans le presse-papiers",
  },
  workloads: {
    heading: "Deux charges de travail. Une plateforme.",
    intro:
      "Sandboxes et fonctions s'exécutent sur le même socle : templates immuables, microVMs Firecracker, snapshots et jetons de capacité.",
    sandboxes: {
      title: "Sandboxes",
      tagline:
        "Environnements Linux interactifs et avec état pour agents et outils.",
      bullets: [
        "Créez un sandbox à partir d'un template en quelques millisecondes.",
        "Exécutez des commandes et diffusez stdin, stdout et stderr.",
        "Ouvrez des sessions PTY, envoyez des signaux, surveillez des fichiers.",
        "Exposez des ports invités via des URLs HTTPS privées ou publiques.",
        "Mettez en pause vers le stockage objet. Reprenez avec les processus intacts.",
      ],
    },
    functions: {
      title: "Fonctions",
      tagline: "Déployez le code une fois. FissionPlane l'exécute à la demande.",
      bullets: [
        "Déployez des fonctions versionnées depuis des images OCI.",
        "Invoquez-les via HTTPS ou selon un planning.",
        "Démarrez depuis des snapshots chauds en quelques millisecondes.",
        "Redescendez à zéro entre les invocations.",
        "Revenez à une version précédente en un seul appel.",
      ],
    },
  },
  architecture: {
    heading: "Un cluster. Quatre plans.",
    body: "Le plan de contrôle décide de ce qui s'exécute et où. La gateway route le trafic vers le bon nœud. Le runtime du nœud gère les microVMs. Le plan invité est présumé hostile. Le plan de contrôle ne fait jamais office de proxy pour le trafic, donc les sandboxes et fonctions en cours continuent de fonctionner même si le plan de contrôle tombe.",
    diagramLabel:
      "Schéma d'architecture : un SDK ou client REST se connecte en HTTPS à une gateway et à un plan de contrôle dans votre cluster Kubernetes. La gateway relaie le trafic vers des nœuds vm-host qui exécutent des microVMs Firecracker. Les snapshots circulent entre les nœuds et le stockage objet.",
  },
  useCases: {
    heading: "Ce qui tourne sur FissionPlane",
    items: [
      {
        title: "Agents IA",
        body: "Donnez à chaque agent un espace de travail Linux complet avec son propre noyau.",
      },
      {
        title: "Interpréteurs de code",
        body: "Exécutez du code généré par des modèles. Récupérez fichiers, graphiques et logs.",
      },
      {
        title: "APIs serverless",
        body: "Placez des fonctions derrière des endpoints HTTPS qui redescendent à zéro.",
      },
      {
        title: "CI et jobs de build",
        body: "Exécutez chaque job dans une microVM propre. Détruisez-la à la fin.",
      },
      {
        title: "Analyse de données",
        body: "Analysez des jeux de données non fiables en isolation, près de vos données.",
      },
      {
        title: "Tâches planifiées",
        body: "Exécutez des fonctions selon un planning. Cron, sur votre propre matériel.",
      },
    ],
  },
  what: {
    heading: "Qu'est-ce que FissionPlane ?",
    body: "FissionPlane est une plateforme de calcul auto-hébergée pour le code non fiable. Elle donne aux agents IA, interpréteurs de code, outils de développement et systèmes de CI un endroit sûr où s'exécuter. Les charges de travail tournent dans des microVMs Firecracker sur des nœuds Kubernetes que vous opérez.",
    bullets: [
      {
        strong: "Isolation matérielle.",
        text: "Chaque charge de travail s'exécute dans une microVM Firecracker avec son propre noyau, système de fichiers, namespace réseau et limites de ressources.",
      },
      {
        strong: "Sandboxes avec état.",
        text: "Mettez un sandbox en pause vers le stockage objet. Reprenez sa mémoire, ses processus et ses fichiers là où ils se sont arrêtés.",
      },
      {
        strong: "Fonctions serverless.",
        text: "Déployez des fonctions versionnées qui démarrent depuis des snapshots chauds et redescendent à zéro.",
      },
      {
        strong: "Pilotage par SDK.",
        text: "Gérez tout depuis TypeScript, Python ou Rust via des contrats OpenAPI partagés.",
      },
      {
        strong: "Entièrement auto-hébergé.",
        text: "Le plan de contrôle, le plan de données et le calcul tournent sur votre infrastructure. Aucun service propriétaire requis.",
      },
      {
        strong: "Natif Kubernetes.",
        text: "Un chart Helm s'installe dans un cluster existant. Pas d'opérateur. Pas de custom resources.",
      },
      {
        strong: "Chemin de données résilient.",
        text: "Les charges de travail continuent de tourner pendant une panne du plan de contrôle. Le plan de contrôle ne relaie jamais le trafic.",
      },
    ],
    link: "Lire la documentation de FissionPlane",
  },
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        question: "Qu'est-ce que FissionPlane ?",
        answer:
          "FissionPlane est une plateforme open source et auto-hébergée pour l'exécution sécurisée de code. Elle exécute deux types de charges de travail sur un même socle : des sandboxes interactifs et des fonctions serverless. Chaque charge tourne dans une microVM Firecracker isolée, avec des contrôles de commandes, de système de fichiers, de réseau et de cycle de vie.",
      },
      {
        question: "FissionPlane est-il open source ?",
        answer:
          "Oui. FissionPlane est un logiciel libre et open source sous licence Apache 2.0. Le plan de contrôle, la gateway, le runtime de nœud, les programmes invités, les contrats d'API et les SDK sont dans un seul dépôt. Vous pouvez l'utiliser dans des projets personnels et commerciaux, selon les termes de la licence.",
      },
      {
        question: "Quelle est la différence entre un sandbox et une fonction ?",
        answer:
          "Un sandbox est interactif et avec état. Vous le créez, exécutez des commandes, modifiez des fichiers, puis le supprimez quand vous avez terminé. Une fonction est déployée une fois et invoquée de nombreuses fois. FissionPlane démarre une microVM depuis un snapshot chaud à chaque invocation, exécute votre handler, puis redescend à zéro.",
      },
      {
        question: "Comment FissionPlane isole-t-il le code non fiable ?",
        answer:
          "Chaque charge de travail s'exécute dans une microVM Firecracker avec son propre noyau, système de fichiers, namespace réseau et limites de ressources. Les charges ne partagent rien avec l'hôte ni entre elles. FissionPlane traite chaque octet provenant de l'invité comme hostile.",
      },
      {
        question: "FissionPlane nécessite-t-il Kubernetes ?",
        answer:
          "Oui, pour le chemin d'installation documenté aujourd'hui : un chart Helm se déploie dans un cluster Kubernetes existant. Il n'exige ni opérateur, ni custom resources, ni changements à l'échelle du cluster.",
      },
      {
        question: "Quels SDK FissionPlane propose-t-il ?",
        answer:
          "TypeScript, Python et Rust. Les APIs de cycle de vie et du plan de données utilisent des contrats OpenAPI ; des clients peuvent donc suivre les mêmes contrats dans d'autres langages.",
      },
      {
        question:
          "Peut-on mettre en pause puis reprendre les sandboxes FissionPlane ?",
        answer:
          "Oui. Vous pouvez mettre un sandbox en pause vers le stockage objet, puis reprendre sa mémoire, ses processus, son système de fichiers et l'état de ses périphériques là où ils se sont arrêtés.",
      },
      {
        question:
          "Comment FissionPlane se compare-t-il aux plateformes de sandboxes hébergées ?",
        answer:
          "Les plateformes de sandbox hébergées exécutent vos charges de travail sur leur cloud. FissionPlane vous donne les mêmes primitives — sandboxes microVM rapides, snapshots et SDKs — sous forme de logiciel libre sur votre propre matériel. Pas de facturation à l'usage, aucune donnée ne quitte votre réseau, et les installations air-gapped fonctionnent.",
      },
      {
        question: "Qui opère l'infrastructure FissionPlane ?",
        answer:
          "Vous. FissionPlane ne requiert aucun service cloud propriétaire. Le plan de contrôle, le plan de données et le calcul restent sur une infrastructure que vous opérez. Les charges en cours continuent pendant une panne du plan de contrôle, car celui-ci ne relaie pas leur trafic.",
      },
    ],
  },
  cta: {
    heading: "Exécutez du code non fiable selon vos propres règles.",
    body: "Installez le plan de contrôle sur votre cluster Kubernetes avec un chart Helm. Créez votre premier sandbox ou déployez votre première fonction en quelques minutes.",
    link: "Ouvrir la documentation de FissionPlane",
  },
  footer: {
    github: "GitHub",
    docs: "Docs",
    changelog: "Changelog",
    license: "Licence",
    brand: "Marque",
    privacy: "Confidentialité",
    contact: "Contact",
    languageLabel: "Choisir la langue",
  },
  consent: {
    regionLabel: "Avis relatif aux cookies",
    heading: "Avis relatif aux cookies",
    body: "Nous utilisons des statistiques pour comprendre l'usage de ce site. Pas de publicité, pas de suivi entre sites.",
    learnMore: "En savoir plus",
    allow: "Accepter",
    decline: "Refuser",
  },
  privacy: {
    metaTitle: "Confidentialité — FissionPlane",
    metaDescription:
      "Comment le site FissionPlane utilise les statistiques et comment modifier votre choix.",
    heading: "Confidentialité",
    subtitle: "Comment ce site utilise les statistiques.",
    choice: {
      heading: "Votre choix",
      allowed: "Les statistiques sont activées.",
      declined: "Les statistiques sont désactivées.",
      undecided:
        "Vous n'avez pas encore choisi. Les statistiques restent désactivées jusque-là.",
      signalled:
        "Votre navigateur demande à ne pas être suivi : les statistiques restent désactivées.",
      allow: "Accepter les statistiques",
      decline: "Refuser les statistiques",
    },
    sections: [
      {
        heading: "Statistiques",
        body: "Nous utilisons Cloudflare Web Analytics pour compter les pages vues. Il ne dépose aucun cookie, n'enregistre rien sur votre appareil et ne vous suit pas d'un site à l'autre. Il ne se charge qu'après votre accord.",
      },
      {
        heading: "Vos données",
        body: "Nous ne diffusons pas de publicité, ne vendons ni ne partageons vos données et ne créons aucun profil vous concernant. Votre choix est enregistré dans votre navigateur et ne quitte jamais votre appareil. Si vous effacez les données de ce site, la question vous sera reposée.",
      },
    ],
  },
  brand: {
    metaTitle: "Charte graphique de FissionPlane",
    metaDescription:
      "Logos, logotypes, couleurs et règles d'usage de la marque FissionPlane. Téléchargez les ressources en SVG et PNG.",
    heading: "Charte graphique",
    subtitle: "Ressources et éléments de la marque FissionPlane.",
    downloadAll: "Télécharger toutes les ressources",
    assets: {
      icon: "Icône",
      wordmark: "Logotype",
      lockup: "Bloc-marque",
      darkVariant: "pour fonds clairs",
      lightVariant: "pour fonds sombres",
    },
    svgLabel: "SVG",
    pngLabel: "PNG",
    usageHeading: "Usage",
    usageRules: [
      "Utilisez le bloc-marque quand l'espace le permet. Utilisez l'icône aux petites tailles.",
      "Gardez la grille de pixels intacte. Redimensionnez les marques par multiples entiers.",
      "Ne recolorez pas, n'étirez pas, ne faites pas pivoter les marques et n'ajoutez pas d'effets.",
      "Conservez autour des marques un espace libre égal à la hauteur de l'icône.",
    ],
    colorsHeading: "Couleurs",
    colorsIntro:
      "FissionPlane utilise une palette de gris chauds. Les marques emploient les quatre tons de gris ci-dessous.",
  },
  contact: {
    metaTitle: "Contact — FissionPlane",
    metaDescription: "Contactez Manuel Suarez, le créateur de FissionPlane.",
    heading: "Contact",
    subtitle: "Questions, retours ou aide au déploiement — écrivez-moi.",
    directHeading: "Contact direct",
    directBody:
      "FissionPlane est développé par Manuel Suarez. Écrivez un e-mail ou retrouvez-moi ici :",
    emailChannel: "E-mail",
    formHeading: "Envoyer un message",
    formTagline: "Je lis chaque message et je réponds par e-mail.",
    emailLabel: "Votre adresse e-mail",
    messageLabel: "Message",
    messageHint: "Jusqu'à 3 000 caractères.",
    submit: "Envoyer le message",
    sending: "Envoi…",
    success: "Message envoyé. Je vous répondrai bientôt.",
    error: "Le message n'a pas été envoyé. Écrivez-moi directement par e-mail.",
  },
  notFound: {
    title: "Page introuvable — FissionPlane",
    heading: "Page introuvable",
    body: "Cette page n'existe pas.",
    homeLink: "Retourner à la page d'accueil.",
  },
};
