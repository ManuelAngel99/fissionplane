import type { Dictionary } from './types'

export const es: Dictionary = {
  meta: {
    title: 'FissionPlane — Sandboxes y funciones serverless autoalojadas',
    description:
      'FissionPlane es una plataforma de código abierto que ejecuta sandboxes seguros y funciones serverless en microVMs Firecracker sobre tu propia infraestructura.',
    imageAlt:
      'FissionPlane — sandboxes y funciones serverless autoalojadas sobre microVMs Firecracker',
  },
  nav: {
    contact: 'Contacto',
    github: 'GitHub',
    githubTitle: 'Código fuente de FissionPlane en GitHub',
    docs: 'Docs',
    docsTitle: 'Documentación de FissionPlane',
    homeAriaLabel: 'Inicio de FissionPlane',
  },
  hero: {
    heading:
      'Ejecuta sandboxes seguros y funciones serverless en tu propia infraestructura',
    body: 'FissionPlane es una plataforma de cómputo de código abierto construida sobre microVMs Firecracker. Crea sandboxes interactivos para agentes de IA en milisegundos. Despliega funciones que escalan a cero. Cada byte permanece en hardware que tú operas.',
  },
  platform: {
    heading: 'Despliégalo en tu propia nube',
    tagline:
      'Un chart de Helm instala toda la plataforma en cualquier clúster de Kubernetes: EKS, GKE, AKS o tus propias máquinas.',
    note: 'También funciona en k3s, bare metal y redes air-gapped.',
  },
  install: {
    heading: 'Conecta un SDK de FissionPlane',
    tagline:
      'Crea sandboxes y despliega funciones desde TypeScript, Python o Rust.',
    groupLabel: 'Elige un SDK',
    copyLabel: 'Copiar comando de instalación',
    copiedLabel: 'Copiado',
    copyCode: 'Copiar código',
    agentPrefix: 'O',
    agentLink:
      'deja que tu agente de IA construya tu propio SDK a partir de la especificación OpenAPI',
    copiedToast: 'Prompt copiado al portapapeles',
  },
  workloads: {
    heading: 'Dos cargas de trabajo. Una plataforma.',
    intro:
      'Los sandboxes y las funciones se ejecutan sobre el mismo sustrato: plantillas inmutables, microVMs Firecracker, snapshots y tokens de capacidad.',
    sandboxes: {
      title: 'Sandboxes',
      tagline:
        'Entornos Linux interactivos y con estado para agentes y herramientas.',
      bullets: [
        'Crea un sandbox desde una plantilla en milisegundos.',
        'Ejecuta comandos y transmite stdin, stdout y stderr.',
        'Abre sesiones PTY, envía señales y observa archivos.',
        'Expón puertos del invitado mediante URLs HTTPS privadas o públicas.',
        'Pausa en almacenamiento de objetos. Reanuda con los procesos intactos.',
      ],
    },
    functions: {
      title: 'Funciones',
      tagline:
        'Despliega el código una vez. FissionPlane lo ejecuta bajo demanda.',
      bullets: [
        'Despliega funciones versionadas desde imágenes OCI.',
        'Invócalas por HTTPS o de forma programada.',
        'Arranca desde snapshots calientes en milisegundos.',
        'Escala a cero entre invocaciones.',
        'Vuelve a una versión anterior con una sola llamada.',
      ],
    },
  },
  architecture: {
    heading: 'Un clúster. Cuatro planos.',
    body: 'El plano de control decide qué se ejecuta y dónde. El gateway enruta el tráfico al nodo correcto. El runtime del nodo gestiona las microVMs. El plano invitado se considera hostil. El plano de control nunca actúa como proxy del tráfico, así que los sandboxes y funciones en ejecución siguen funcionando aunque el plano de control se caiga.',
    diagramLabel:
      'Diagrama de arquitectura: un SDK o cliente REST se conecta por HTTPS a un gateway y a un plano de control dentro de tu clúster de Kubernetes. El gateway envía el tráfico a nodos vm-host que ejecutan microVMs Firecracker. Los snapshots se mueven entre los nodos y el almacenamiento de objetos.',
  },
  useCases: {
    heading: 'Qué se ejecuta en FissionPlane',
    items: [
      {
        title: 'Agentes de IA',
        body: 'Da a cada agente un espacio de trabajo Linux completo con su propio kernel.',
      },
      {
        title: 'Intérpretes de código',
        body: 'Ejecuta código generado por modelos. Devuelve archivos, gráficas y logs.',
      },
      {
        title: 'APIs serverless',
        body: 'Publica funciones tras endpoints HTTPS que escalan a cero.',
      },
      {
        title: 'CI y trabajos de build',
        body: 'Ejecuta cada trabajo en una microVM limpia. Destrúyela al terminar.',
      },
      {
        title: 'Análisis de datos',
        body: 'Analiza datasets no confiables en aislamiento, junto a tus datos.',
      },
      {
        title: 'Tareas programadas',
        body: 'Ejecuta funciones de forma programada. Cron, en tu propio hardware.',
      },
    ],
  },
  what: {
    heading: '¿Qué es FissionPlane?',
    body: 'FissionPlane es una plataforma de cómputo autoalojada para código no confiable. Da a agentes de IA, intérpretes de código, herramientas de desarrollo y sistemas de CI un lugar seguro donde ejecutarse. Las cargas de trabajo corren en microVMs Firecracker sobre nodos de Kubernetes que tú operas.',
    bullets: [
      {
        strong: 'Aislamiento por hardware.',
        text: 'Cada carga de trabajo se ejecuta en una microVM Firecracker con su propio kernel, sistema de archivos, namespace de red y límites de recursos.',
      },
      {
        strong: 'Sandboxes con estado.',
        text: 'Pausa un sandbox en almacenamiento de objetos. Reanuda su memoria, procesos y archivos donde se detuvieron.',
      },
      {
        strong: 'Funciones serverless.',
        text: 'Despliega funciones versionadas que arrancan desde snapshots calientes y escalan a cero.',
      },
      {
        strong: 'Control desde SDKs.',
        text: 'Gestiona todo desde TypeScript, Python o Rust contra contratos OpenAPI compartidos.',
      },
      {
        strong: 'Totalmente autoalojado.',
        text: 'El plano de control, el plano de datos y el cómputo corren en tu infraestructura. No se necesita ningún servicio propietario.',
      },
      {
        strong: 'Nativo de Kubernetes.',
        text: 'Un chart de Helm se instala en un clúster existente. Sin operador. Sin recursos personalizados.',
      },
      {
        strong: 'Ruta de datos resiliente.',
        text: 'Las cargas de trabajo siguen funcionando durante una caída del plano de control. El plano de control nunca actúa como proxy del tráfico.',
      },
    ],
    link: 'Lee la documentación de FissionPlane',
  },
  faq: {
    heading: 'Preguntas frecuentes',
    items: [
      {
        question: '¿Qué es FissionPlane?',
        answer:
          'FissionPlane es una plataforma autoalojada y de código abierto para la ejecución segura de código. Ejecuta dos tipos de carga de trabajo sobre un mismo sustrato: sandboxes interactivos y funciones serverless. Cada carga corre en una microVM Firecracker aislada, con controles de comandos, sistema de archivos, red y ciclo de vida.',
      },
      {
        question: '¿Es FissionPlane de código abierto?',
        answer:
          'Sí. FissionPlane es software libre y de código abierto bajo la licencia Apache 2.0. El plano de control, el gateway, el runtime de nodo, los programas invitados, los contratos de API y los SDK están en un único repositorio. Puedes usarlo en proyectos personales y comerciales, según los términos de la licencia.',
      },
      {
        question: '¿Cuál es la diferencia entre un sandbox y una función?',
        answer:
          'Un sandbox es interactivo y tiene estado. Lo creas, ejecutas comandos, editas archivos y lo eliminas al terminar. Una función se despliega una vez y se invoca muchas veces. FissionPlane arranca una microVM desde un snapshot caliente en cada invocación, ejecuta tu handler y vuelve a escalar a cero.',
      },
      {
        question: '¿Cómo aísla FissionPlane el código no confiable?',
        answer:
          'Cada carga de trabajo se ejecuta en una microVM Firecracker con su propio kernel, sistema de archivos, namespace de red y límites de recursos. Las cargas no comparten nada con el host ni entre sí. FissionPlane trata cada byte procedente del invitado como hostil.',
      },
      {
        question: '¿Requiere FissionPlane Kubernetes?',
        answer:
          'Sí, para la vía de instalación documentada hoy: un chart de Helm se despliega en un clúster de Kubernetes existente. No necesita operador, ni recursos personalizados, ni cambios a nivel de clúster.',
      },
      {
        question: '¿Qué SDKs ofrece FissionPlane?',
        answer:
          'TypeScript, Python y Rust. Las APIs de ciclo de vida y del plano de datos usan contratos OpenAPI, así que otros clientes pueden seguir los mismos contratos en otros lenguajes.',
      },
      {
        question: '¿Se pueden pausar y reanudar los sandboxes de FissionPlane?',
        answer:
          'Sí. Puedes pausar un sandbox en almacenamiento de objetos y reanudar su memoria, procesos, sistema de archivos y estado de dispositivos donde se detuvieron.',
      },
      {
        question:
          '¿Cómo se compara FissionPlane con las plataformas de sandboxes gestionadas?',
        answer:
          'Las plataformas de sandbox gestionadas ejecutan tus cargas en su nube. FissionPlane te da las mismas primitivas — sandboxes microVM rápidos, snapshots y SDKs — como software libre en tu propio hardware. No hay facturación por uso, ningún dato sale de tu red y funcionan las instalaciones air-gapped.',
      },
      {
        question: '¿Quién opera la infraestructura de FissionPlane?',
        answer:
          'Tú. FissionPlane no requiere ningún servicio propietario en la nube. El plano de control, el plano de datos y el cómputo permanecen en infraestructura que tú operas. Las cargas en ejecución continúan durante una caída del plano de control porque este no actúa como proxy de su tráfico.',
      },
    ],
  },
  cta: {
    heading: 'Ejecuta código no confiable en tus propios términos.',
    body: 'Instala el plano de control en tu clúster de Kubernetes con un chart de Helm. Crea tu primer sandbox o despliega tu primera función en minutos.',
    link: 'Abre la documentación de FissionPlane',
  },
  footer: {
    github: 'GitHub',
    docs: 'Docs',
    changelog: 'Novedades',
    license: 'Licencia',
    brand: 'Marca',
    privacy: 'Privacidad',
    contact: 'Contacto',
    languageLabel: 'Seleccionar idioma',
  },
  consent: {
    regionLabel: 'Aviso de cookies',
    heading: 'Aviso de cookies',
    body: 'Usamos analítica para saber cómo se usa este sitio. Sin anuncios y sin seguimiento entre sitios.',
    learnMore: 'Más información',
    allow: 'Aceptar',
    decline: 'Rechazar',
  },
  privacy: {
    metaTitle: 'Privacidad — FissionPlane',
    metaDescription:
      'Cómo usa la analítica el sitio de FissionPlane y cómo cambiar tu elección.',
    heading: 'Privacidad',
    subtitle: 'Cómo usa este sitio la analítica.',
    choice: {
      heading: 'Tu elección',
      allowed: 'La analítica está activada.',
      declined: 'La analítica está desactivada.',
      undecided:
        'Todavía no has elegido. La analítica seguirá desactivada hasta que lo hagas.',
      signalled:
        'Tu navegador pide no ser rastreado, así que la analítica sigue desactivada.',
      allow: 'Aceptar la analítica',
      decline: 'Rechazar la analítica',
    },
    sections: [
      {
        heading: 'Analítica',
        body: 'Usamos Cloudflare Web Analytics para contar las visitas a las páginas. No instala cookies, no guarda nada en tu dispositivo y no te rastrea entre sitios. Solo se carga si lo aceptas.',
      },
      {
        heading: 'Tus datos',
        body: 'No mostramos anuncios, no vendemos ni compartimos tus datos y no creamos un perfil sobre ti. Tu elección se guarda en tu navegador y nunca sale de tu dispositivo. Si borras los datos de este sitio, volveremos a preguntar.',
      },
    ],
  },
  brand: {
    metaTitle: 'Guía de marca de FissionPlane',
    metaDescription:
      'Logotipos, marcas denominativas, colores y normas de uso de la marca FissionPlane. Descarga los recursos en SVG y PNG.',
    heading: 'Guía de marca',
    subtitle: 'Recursos y materiales de la marca FissionPlane.',
    downloadAll: 'Descargar todos los recursos',
    assets: {
      icon: 'Icono',
      wordmark: 'Logotipo',
      lockup: 'Composición',
      darkVariant: 'para fondos claros',
      lightVariant: 'para fondos oscuros',
    },
    svgLabel: 'SVG',
    pngLabel: 'PNG',
    usageHeading: 'Uso',
    usageRules: [
      'Usa la composición cuando el espacio lo permita. Usa el icono en tamaños pequeños.',
      'Mantén intacta la rejilla de píxeles. Escala las marcas en múltiplos enteros.',
      'No recolorees, estires, rotes ni añadas efectos a las marcas.',
      'Deja un espacio libre alrededor de las marcas igual a la altura del icono.',
    ],
    colorsHeading: 'Colores',
    colorsIntro:
      'FissionPlane usa una paleta de grises cálidos. Las marcas emplean los cuatro tonos de gris siguientes.',
  },
  contact: {
    metaTitle: 'Contacto — FissionPlane',
    metaDescription: 'Contacta con Manuel Suarez, el creador de FissionPlane.',
    heading: 'Contacto',
    subtitle: 'Preguntas, comentarios o ayuda con el despliegue: escríbeme.',
    directHeading: 'Contacto directo',
    directBody:
      'FissionPlane es obra de Manuel Suarez. Escríbeme un correo o encuéntrame aquí:',
    emailChannel: 'Correo',
    formHeading: 'Envía un mensaje',
    formTagline: 'Leo todos los mensajes y respondo por correo.',
    emailLabel: 'Tu correo electrónico',
    messageLabel: 'Mensaje',
    messageHint: 'Hasta 3.000 caracteres.',
    submit: 'Enviar mensaje',
    sending: 'Enviando…',
    success: 'Mensaje enviado. Te responderé pronto.',
    error: 'No se pudo enviar el mensaje. Escríbeme directamente por correo.',
  },
  notFound: {
    title: 'Página no encontrada — FissionPlane',
    heading: 'Página no encontrada',
    body: 'Esta página no existe.',
    homeLink: 'Volver a la página de inicio.',
  },
}
