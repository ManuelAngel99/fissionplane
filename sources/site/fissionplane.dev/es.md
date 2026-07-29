# Source: https://fissionplane.dev/es

# Ejecuta sandboxes seguros y funciones serverless en tu propia infraestructura

FissionPlane es una plataforma de cómputo de código abierto construida sobre microVMs Firecracker. Crea sandboxes interactivos para agentes de IA en milisegundos. Despliega funciones que escalan a cero. Cada byte permanece en hardware que tú operas.

## Despliégalo en tu propia nube

Un chart de Helm instala toda la plataforma en cualquier clúster de Kubernetes: EKS, GKE, AKS o tus propias máquinas.

![][base64-image]

- AWS
- Google Cloud
- Azure
- Kubernetes

También funciona en k3s, bare metal y redes air-gapped.

## Conecta un SDK de FissionPlane

Crea sandboxes y despliega funciones desde TypeScript, Python o Rust.

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

O deja que tu agente de IA construya tu propio SDK a partir de la especificación OpenAPI

## Dos cargas de trabajo. Una plataforma.

Los sandboxes y las funciones se ejecutan sobre el mismo sustrato: plantillas inmutables, microVMs Firecracker, snapshots y tokens de capacidad.

### Sandboxes

Entornos Linux interactivos y con estado para agentes y herramientas.

- Crea un sandbox desde una plantilla en milisegundos.
- Ejecuta comandos y transmite stdin, stdout y stderr.
- Abre sesiones PTY, envía señales y observa archivos.
- Expón puertos del invitado mediante URLs HTTPS privadas o públicas.
- Pausa hacia almacenamiento de objetos. Reanuda con los procesos intactos.

### Funciones

Despliega el código una vez. FissionPlane lo ejecuta bajo demanda.

- Despliega funciones versionadas desde imágenes OCI.
- Invócalas por HTTPS o de forma programada.
- Arrancan desde snapshots calientes en milisegundos.
- Escalan a cero entre invocaciones.
- Vuelve a una versión anterior con una sola llamada.

## Un clúster. Cuatro planos.

El plano de control decide qué se ejecuta y dónde. El gateway enruta el tráfico al nodo correcto. El runtime del nodo gestiona las microVMs. El plano invitado se considera hostil. El plano de control nunca actúa como proxy del tráfico, así que los sandboxes y funciones en ejecución siguen funcionando aunque el plano de control se caiga.

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

## Qué se ejecuta en FissionPlane

- ### Agentes de IA

 Da a cada agente un espacio de trabajo Linux completo con su propio kernel.

- ### Intérpretes de código

 Ejecuta código generado por modelos. Devuelve archivos, gráficas y logs.

- ### APIs serverless

 Publica funciones tras endpoints HTTPS que escalan a cero.

- ### CI y trabajos de build

 Ejecuta cada trabajo en una microVM limpia. Destrúyela al terminar.

- ### Análisis de datos

 Analiza datasets no confiables en aislamiento, junto a tus datos.

- ### Tareas programadas

 Ejecuta funciones de forma programada. Cron, en tu propio hardware.

## ¿Qué es FissionPlane?

FissionPlane es una plataforma de cómputo autoalojada para código no confiable. Da a agentes de IA, intérpretes de código, herramientas de desarrollo y sistemas de CI un lugar seguro donde ejecutarse. Las cargas de trabajo corren en microVMs Firecracker sobre nodos de Kubernetes que tú operas.

- **Aislamiento por hardware.** Cada carga de trabajo se ejecuta en una microVM Firecracker con su propio kernel, sistema de archivos, namespace de red y límites de recursos.
- **Sandboxes con estado.** Pausa un sandbox hacia almacenamiento de objetos. Reanuda su memoria, procesos y archivos donde se detuvieron.
- **Funciones serverless.** Despliega funciones versionadas que arrancan desde snapshots calientes y escalan a cero.
- **Control desde SDKs.** Gestiona todo desde TypeScript, Python o Rust contra contratos OpenAPI compartidos.
- **Totalmente autoalojado.** El plano de control, el plano de datos y el cómputo corren en tu infraestructura. No se necesita ningún servicio propietario.
- **Nativo de Kubernetes.** Un chart de Helm se instala en un clúster existente. Sin operador. Sin recursos personalizados.
- **Ruta de datos resiliente.** Las cargas de trabajo siguen funcionando durante una caída del plano de control. El plano de control nunca actúa como proxy del tráfico.

[Lee la documentación de FissionPlane](https://docs.fissionplane.dev)

## Preguntas frecuentes

- ### ¿Qué es FissionPlane?

 FissionPlane es una plataforma autoalojada y de código abierto para la ejecución segura de código. Ejecuta dos tipos de carga de trabajo sobre un mismo sustrato: sandboxes interactivos y funciones serverless. Cada carga corre en una microVM Firecracker aislada, con controles de comandos, sistema de archivos, red y ciclo de vida.

- ### ¿Es FissionPlane de código abierto?

 Sí. FissionPlane es software libre y de código abierto bajo la licencia Apache 2.0. El plano de control, el gateway, el runtime de nodo, los programas invitados, los contratos de API y los SDK están en un único repositorio. Puedes usarlo en proyectos personales y comerciales, según los términos de la licencia.

- ### ¿Cuál es la diferencia entre un sandbox y una función?

 Un sandbox es interactivo y tiene estado. Lo creas, ejecutas comandos, editas archivos y lo eliminas al terminar. Una función se despliega una vez y se invoca muchas veces. FissionPlane arranca una microVM desde un snapshot caliente en cada invocación, ejecuta tu handler y vuelve a escalar a cero.

- ### ¿Cómo aísla FissionPlane el código no confiable?

 Cada carga de trabajo se ejecuta en una microVM Firecracker con su propio kernel, sistema de archivos, namespace de red y límites de recursos. Las cargas no comparten nada con el host ni entre sí. FissionPlane trata cada byte procedente del invitado como hostil.

- ### ¿Requiere FissionPlane Kubernetes?

 Sí, para la vía de instalación documentada hoy: un chart de Helm se despliega en un clúster de Kubernetes existente. No necesita operador, ni recursos personalizados, ni cambios a nivel de clúster.

- ### ¿Qué SDKs ofrece FissionPlane?

 TypeScript, Python y Rust. Las APIs de ciclo de vida y del plano de datos usan contratos OpenAPI, así que otros clientes pueden seguir los mismos contratos en otros lenguajes.

- ### ¿Se pueden pausar y reanudar los sandboxes de FissionPlane?

 Sí. Puedes pausar un sandbox hacia almacenamiento de objetos y reanudar su memoria, procesos, sistema de archivos y estado de dispositivos donde se detuvieron.

- ### ¿Cómo se compara FissionPlane con las plataformas de sandboxes gestionadas?

 Las plataformas de sandbox gestionadas ejecutan tus cargas en su nube. FissionPlane te da las mismas primitivas — sandboxes microVM rápidos, snapshots y SDKs — como software libre en tu propio hardware. No hay facturación por uso, ningún dato sale de tu red y funcionan las instalaciones air-gapped.

- ### ¿Quién opera la infraestructura de FissionPlane?

 Tú. FissionPlane no requiere ningún servicio propietario en la nube. El plano de control, el plano de datos y el cómputo permanecen en infraestructura que tú operas. Las cargas en ejecución continúan durante una caída del plano de control porque este no actúa como proxy de su tráfico.

**Ejecuta código no confiable en tus propios términos.**

Instala el plano de control en tu clúster de Kubernetes con un chart de Helm. Crea tu primer sandbox o despliega tu primera función en minutos.

[Abre la documentación de FissionPlane](https://docs.fissionplane.dev)