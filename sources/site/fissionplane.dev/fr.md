# Source: https://fissionplane.dev/fr

# Exécutez des sandboxes sécurisés et des fonctions serverless sur votre propre infrastructure

FissionPlane est une plateforme de calcul open source construite sur des microVMs Firecracker. Créez des sandboxes interactifs pour agents IA en quelques millisecondes. Déployez des fonctions qui redescendent à zéro. Chaque octet reste sur du matériel que vous opérez.

## Déployez sur votre propre cloud

Un chart Helm installe toute la plateforme sur n'importe quel cluster Kubernetes : EKS, GKE, AKS ou vos propres machines.

![][base64-image]

- AWS
- Google Cloud
- Azure
- Kubernetes

Fonctionne aussi sur k3s, bare metal et réseaux air-gapped.

## Connectez un SDK FissionPlane

Créez des sandboxes et déployez des fonctions depuis TypeScript, Python ou Rust.

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

Ou laissez votre agent IA construire votre propre SDK à partir de la spécification OpenAPI

## Deux charges de travail. Une plateforme.

Sandboxes et fonctions s'exécutent sur le même socle : templates immuables, microVMs Firecracker, snapshots et jetons de capacité.

### Sandboxes

Environnements Linux interactifs et avec état pour agents et outils.

- Créez un sandbox à partir d'un template en quelques millisecondes.
- Exécutez des commandes et diffusez stdin, stdout et stderr.
- Ouvrez des sessions PTY, envoyez des signaux, surveillez des fichiers.
- Exposez des ports invités via des URLs HTTPS privées ou publiques.
- Mettez en pause vers le stockage objet. Reprenez avec les processus intacts.

### Fonctions

Déployez le code une fois. FissionPlane l'exécute à la demande.

- Déployez des fonctions versionnées depuis des images OCI.
- Invoquez-les via HTTPS ou selon un planning.
- Démarrez depuis des snapshots chauds en quelques millisecondes.
- Redescendez à zéro entre les invocations.
- Revenez à une version précédente en un seul appel.

## Un cluster. Quatre plans.

Le plan de contrôle décide de ce qui s'exécute et où. La gateway route le trafic vers le bon nœud. Le runtime du nœud gère les microVMs. Le plan invité est présumé hostile. Le plan de contrôle ne fait jamais office de proxy pour le trafic, donc les sandboxes et fonctions en cours continuent de fonctionner même si le plan de contrôle tombe.

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

## Ce qui tourne sur FissionPlane

- ### Agents IA

 Donnez à chaque agent un espace de travail Linux complet avec son propre noyau.

- ### Interpréteurs de code

 Exécutez du code généré par des modèles. Récupérez fichiers, graphiques et logs.

- ### APIs serverless

 Placez des fonctions derrière des endpoints HTTPS qui redescendent à zéro.

- ### CI et jobs de build

 Exécutez chaque job dans une microVM propre. Détruisez-la à la fin.

- ### Analyse de données

 Analysez des jeux de données non fiables en isolation, près de vos données.

- ### Tâches planifiées

 Exécutez des fonctions selon un planning. Cron, sur votre propre matériel.

## Qu'est-ce que FissionPlane ?

FissionPlane est une plateforme de calcul auto-hébergée pour le code non fiable. Elle donne aux agents IA, interpréteurs de code, outils de développement et systèmes de CI un endroit sûr où s'exécuter. Les charges de travail tournent dans des microVMs Firecracker sur des nœuds Kubernetes que vous opérez.

- **Isolation matérielle.** Chaque charge de travail s'exécute dans une microVM Firecracker avec son propre noyau, système de fichiers, namespace réseau et limites de ressources.
- **Sandboxes avec état.** Mettez un sandbox en pause vers le stockage objet. Reprenez sa mémoire, ses processus et ses fichiers là où ils se sont arrêtés.
- **Fonctions serverless.** Déployez des fonctions versionnées qui démarrent depuis des snapshots chauds et redescendent à zéro.
- **Pilotage par SDK.** Gérez tout depuis TypeScript, Python ou Rust via des contrats OpenAPI partagés.
- **Entièrement auto-hébergé.** Le plan de contrôle, le plan de données et le calcul tournent sur votre infrastructure. Aucun service propriétaire requis.
- **Natif Kubernetes.** Un chart Helm s'installe dans un cluster existant. Pas d'opérateur. Pas de custom resources.
- **Chemin de données résilient.** Les charges de travail continuent de tourner pendant une panne du plan de contrôle. Le plan de contrôle ne relaie jamais le trafic.

[Lire la documentation de FissionPlane](https://docs.fissionplane.dev)

## Questions fréquentes

- ### Qu'est-ce que FissionPlane ?

 FissionPlane est une plateforme open source et auto-hébergée pour l'exécution sécurisée de code. Elle exécute deux types de charges de travail sur un même socle : des sandboxes interactifs et des fonctions serverless. Chaque charge tourne dans une microVM Firecracker isolée, avec des contrôles de commandes, de système de fichiers, de réseau et de cycle de vie.

- ### FissionPlane est-il open source ?

 Oui. FissionPlane est un logiciel libre et open source sous licence Apache 2.0. Le plan de contrôle, la gateway, le runtime de nœud, les programmes invités, les contrats d'API et les SDK sont dans un seul dépôt. Vous pouvez l'utiliser dans des projets personnels et commerciaux, selon les termes de la licence.

- ### Quelle est la différence entre un sandbox et une fonction ?

 Un sandbox est interactif et avec état. Vous le créez, exécutez des commandes, modifiez des fichiers, puis le supprimez quand vous avez terminé. Une fonction est déployée une fois et invoquée de nombreuses fois. FissionPlane démarre une microVM depuis un snapshot chaud à chaque invocation, exécute votre handler, puis redescend à zéro.

- ### Comment FissionPlane isole-t-il le code non fiable ?

 Chaque charge de travail s'exécute dans une microVM Firecracker avec son propre noyau, système de fichiers, namespace réseau et limites de ressources. Les charges ne partagent rien avec l'hôte ni entre elles. FissionPlane traite chaque octet provenant de l'invité comme hostile.

- ### FissionPlane nécessite-t-il Kubernetes ?

 Oui, pour le chemin d'installation documenté aujourd'hui : un chart Helm se déploie dans un cluster Kubernetes existant. Il n'exige ni opérateur, ni custom resources, ni changements à l'échelle du cluster.

- ### Quels SDK FissionPlane propose-t-il ?

 TypeScript, Python et Rust. Les APIs de cycle de vie et du plan de données utilisent des contrats OpenAPI ; des clients peuvent donc suivre les mêmes contrats dans d'autres langages.

- ### Peut-on mettre en pause puis reprendre les sandboxes FissionPlane ?

 Oui. Vous pouvez mettre un sandbox en pause vers le stockage objet, puis reprendre sa mémoire, ses processus, son système de fichiers et l'état de ses périphériques là où ils se sont arrêtés.

- ### Comment FissionPlane se compare-t-il aux plateformes de sandboxes hébergées ?

 Les plateformes de sandbox hébergées exécutent vos charges de travail sur leur cloud. FissionPlane vous donne les mêmes primitives — sandboxes microVM rapides, snapshots et SDKs — sous forme de logiciel libre sur votre propre matériel. Pas de facturation à l'usage, aucune donnée ne quitte votre réseau, et les installations air-gapped fonctionnent.

- ### Qui opère l'infrastructure FissionPlane ?

 Vous. FissionPlane ne requiert aucun service cloud propriétaire. Le plan de contrôle, le plan de données et le calcul restent sur une infrastructure que vous opérez. Les charges en cours continuent pendant une panne du plan de contrôle, car celui-ci ne relaie pas leur trafic.

**Exécutez du code non fiable selon vos propres règles.**

Installez le plan de contrôle sur votre cluster Kubernetes avec un chart Helm. Créez votre premier sandbox ou déployez votre première fonction en quelques minutes.

[Ouvrir la documentation de FissionPlane](https://docs.fissionplane.dev)