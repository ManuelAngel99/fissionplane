# Source: https://fissionplane.dev/de

# Sichere Sandboxes und Serverless-Funktionen auf Ihrer eigenen Infrastruktur

FissionPlane ist eine Open-Source-Compute-Plattform auf Basis von Firecracker-microVMs. Erstellen Sie interaktive Sandboxes für KI-Agenten in Millisekunden. Deployen Sie Funktionen, die auf null skalieren. Jedes Byte bleibt auf Hardware, die Sie betreiben.

## Deployen Sie in Ihre eigene Cloud

Ein Helm-Chart installiert die gesamte Plattform auf jedem Kubernetes-Cluster: EKS, GKE, AKS oder Ihre eigenen Maschinen.

![][base64-image]

- AWS
- Google Cloud
- Azure
- Kubernetes

Läuft auch auf k3s, Bare Metal und in Air-Gapped-Netzen.

## Ein FissionPlane-SDK verbinden

Erstellen Sie Sandboxes und deployen Sie Funktionen aus TypeScript, Python oder Rust.

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

Oder lassen Sie Ihren KI-Agenten ein eigenes SDK aus der OpenAPI-Spezifikation bauen

## Zwei Workloads. Eine Plattform.

Sandboxes und Funktionen laufen auf demselben Substrat: unveränderliche Templates, Firecracker-microVMs, Snapshots und Capability-Tokens.

### Sandboxes

Zustandsbehaftete, interaktive Linux-Umgebungen für Agenten und Tools.

- Erstellen Sie eine Sandbox aus einem Template in Millisekunden.
- Führen Sie Befehle aus und streamen Sie stdin, stdout und stderr.
- Öffnen Sie PTY-Sitzungen, senden Sie Signale und beobachten Sie Dateien.
- Geben Sie Gast-Ports über private oder öffentliche HTTPS-URLs frei.
- Pausieren Sie in den Objektspeicher. Setzen Sie mit intakten Prozessen fort.

### Funktionen

Code einmal deployen. FissionPlane führt ihn bei Bedarf aus.

- Deployen Sie versionierte Funktionen aus OCI-Images.
- Rufen Sie sie über HTTPS oder nach Zeitplan auf.
- Starten Sie aus warmen Snapshots in Millisekunden.
- Skalieren Sie zwischen Aufrufen auf null.
- Kehren Sie mit einem Aufruf zu einer früheren Version zurück.

## Ein Cluster. Vier Ebenen.

Die Control-Plane entscheidet, was wo läuft. Das Gateway leitet den Verkehr zum richtigen Node. Die Node-Laufzeit verwaltet die microVMs. Die Gast-Ebene gilt als feindlich. Die Control-Plane leitet niemals Workload-Verkehr weiter, daher laufen Sandboxes und Funktionen auch bei einem Ausfall der Control-Plane weiter.

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

## Was auf FissionPlane läuft

- ### KI-Agenten

 Geben Sie jedem Agenten einen vollständigen Linux-Arbeitsbereich mit eigenem Kernel.

- ### Code-Interpreter

 Führen Sie modellgenerierten Code aus. Erhalten Sie Dateien, Diagramme und Logs.

- ### Serverless-APIs

 Stellen Sie Funktionen hinter HTTPS-Endpunkte, die auf null skalieren.

- ### CI- und Build-Jobs

 Führen Sie jeden Job in einer sauberen microVM aus. Zerstören Sie sie nach dem Job.

- ### Datenanalyse

 Analysieren Sie nicht vertrauenswürdige Datensätze isoliert, nah an Ihren Daten.

- ### Geplante Jobs

 Führen Sie Funktionen nach Zeitplan aus. Cron, auf Ihrer eigenen Hardware.

## Was ist FissionPlane?

FissionPlane ist eine selbstgehostete Compute-Plattform für nicht vertrauenswürdigen Code. Sie gibt KI-Agenten, Code-Interpretern, Entwicklerwerkzeugen und CI-Systemen einen sicheren Ort zur Ausführung. Workloads laufen in Firecracker-microVMs auf Kubernetes-Nodes, die Sie betreiben.

- **Hardware-Isolation.** Jeder Workload läuft in einer Firecracker-microVM mit eigenem Kernel, Dateisystem, Netzwerk-Namespace und Ressourcenlimits.
- **Zustandsbehaftete Sandboxes.** Pausieren Sie eine Sandbox in den Objektspeicher. Setzen Sie Speicher, Prozesse und Dateien dort fort, wo sie angehalten haben.
- **Serverless-Funktionen.** Deployen Sie versionierte Funktionen, die aus warmen Snapshots starten und auf null skalieren.
- **Steuerung per SDK.** Verwalten Sie alles aus TypeScript, Python oder Rust über gemeinsame OpenAPI-Verträge.
- **Vollständig selbstgehostet.** Control-Plane, Data-Plane und Compute laufen auf Ihrer Infrastruktur. Kein proprietärer Dienst erforderlich.
- **Kubernetes-nativ.** Ein Helm-Chart installiert in einen bestehenden Cluster. Kein Operator. Keine Custom Resources.
- **Resilienter Datenpfad.** Workloads laufen bei einem Ausfall der Control-Plane weiter. Die Control-Plane leitet niemals Verkehr weiter.

[FissionPlane-Dokumentation lesen](https://docs.fissionplane.dev)

## Häufig gestellte Fragen

- ### Was ist FissionPlane?

 FissionPlane ist eine quelloffene, selbstgehostete Plattform für sichere Codeausführung. Sie führt zwei Workload-Typen auf einem Substrat aus: interaktive Sandboxes und Serverless-Funktionen. Jeder Workload läuft in einer isolierten Firecracker-microVM mit Kontrollen für Befehle, Dateisystem, Netzwerk und Lebenszyklus.

- ### Ist FissionPlane Open Source?

 Ja. FissionPlane ist freie Open-Source-Software unter der Apache-Lizenz 2.0. Control-Plane, Gateway, Node-Laufzeit, Gastprogramme, API-Verträge und SDKs liegen in einem Repository. Sie dürfen es in persönlichen und kommerziellen Projekten nutzen, gemäß den Lizenzbedingungen.

- ### Was ist der Unterschied zwischen einer Sandbox und einer Funktion?

 Eine Sandbox ist zustandsbehaftet und interaktiv. Sie erstellen sie, führen Befehle aus, bearbeiten Dateien und löschen sie am Ende. Eine Funktion wird einmal deployt und viele Male aufgerufen. FissionPlane startet für jeden Aufruf eine microVM aus einem warmen Snapshot, führt Ihren Handler aus und skaliert zurück auf null.

- ### Wie isoliert FissionPlane nicht vertrauenswürdigen Code?

 Jeder Workload läuft in einer Firecracker-microVM mit eigenem Kernel, Dateisystem, Netzwerk-Namespace und Ressourcenlimits. Workloads teilen nichts mit dem Host oder untereinander. FissionPlane behandelt jedes Byte aus dem Gast als feindlich.

- ### Benötigt FissionPlane Kubernetes?

 Ja, für den heute dokumentierten Installationsweg: Ein Helm-Chart wird in einen bestehenden Kubernetes-Cluster deployt. Es braucht keinen Operator, keine Custom Resources und keine clusterweiten Änderungen.

- ### Welche SDKs bietet FissionPlane?

 TypeScript, Python und Rust. Lifecycle- und Data-Plane-APIs verwenden OpenAPI-Verträge, sodass Clients denselben Verträgen in anderen Sprachen folgen können.

- ### Können FissionPlane-Sandboxes pausiert und fortgesetzt werden?

 Ja. Sie können eine Sandbox in den Objektspeicher pausieren und Speicher, Prozesse, Dateisystem und Gerätezustand dort fortsetzen, wo sie angehalten haben.

- ### Wie unterscheidet sich FissionPlane von gehosteten Sandbox-Plattformen?

 Gehostete Sandbox-Plattformen führen Ihre Workloads in deren Cloud aus. FissionPlane gibt Ihnen dieselben Primitive — schnelle microVM-Sandboxes, Snapshots und SDKs — als freie Software auf Ihrer eigenen Hardware. Es gibt keine nutzungsbasierte Abrechnung, keine Daten verlassen Ihr Netzwerk, und Air-Gapped-Installationen funktionieren.

- ### Wer betreibt die FissionPlane-Infrastruktur?

 Sie. FissionPlane benötigt keinen proprietären Cloud-Dienst. Control-Plane, Data-Plane und Compute bleiben in Infrastruktur, die Sie betreiben. Laufende Workloads überstehen einen Ausfall der Control-Plane, weil diese ihren Verkehr nicht weiterleitet.

**Führen Sie nicht vertrauenswürdigen Code zu Ihren Bedingungen aus.**

Installieren Sie die Control-Plane mit einem Helm-Chart auf Ihrem Kubernetes-Cluster. Erstellen Sie Ihre erste Sandbox oder deployen Sie Ihre erste Funktion in Minuten.

[FissionPlane-Dokumentation öffnen](https://docs.fissionplane.dev)