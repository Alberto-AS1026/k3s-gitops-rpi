# Avisos por Telegram y gráficas históricas

Fecha: 2026-11-16 · Fuente: Antigravity (Gemini 3.8 Flash), revisado y corregido por Claude con el código y la documentación oficial. Los puntos A.1 y A.2 los sacó Claude directamente del código de Uptime Kuma 2.5.11 (Antigravity no disponible para esa parte: la llamada pasó de los 10 minutos y el reintento dio una respuesta incompleta).

## Resumen

- **Avisos de Uptime Kuma**: se crea un bot con @BotFather, se saca el `chat_id` con `getUpdates` y se registra la notificación por socket.io con `addNotification` (`type: "telegram"`, `telegramBotToken`, `telegramChatID`, `isDefault`, `applyExisting`). Con `applyExisting: true` queda enlazada a todos los monitores que ya existen. A los monitores que crees después por script hay que pasarles `notificationIDList`.
- **Gráficas**: en una Pi de 4 GB lo más ligero es un **montaje mínimo sin operador**: VictoriaMetrics single (guarda las métricas y además las recoge) + node-exporter + kube-state-metrics + Grafana. Cada uno con su chart de Helm y su Application de Argo CD. No instala CRD, así que no hace falta `ServerSideApply`.
- **Alertas de métricas a Telegram**: vmalert + Alertmanager (chart `victoria-metrics-alert`), con el token y el chat_id en un Secret creado a mano y leídos con `bot_token_file` y `chat_id_file`. En Git no va ningún secreto.
- **Consumo estimado** de todo el stack: entre 0,5 y 0,75 GiB de RAM de los ~2,2 GiB libres (es una estimación: no se encontraron medidas publicadas de VictoriaMetrics en una Pi). Las peticiones de recursos (requests) suman unos 530 MiB.
- **K3s**: corre todos los componentes del plano de control en un solo proceso, así que **cualquier** endpoint de métricas devuelve las de todos. Solo hay que recoger uno (o ninguno) para no duplicar series. Con SQLite no existe etcd.

---

# Parte A. Avisos por Telegram desde Uptime Kuma 2.5.11

> **socket.io** es el canal en tiempo real que usa la web de Uptime Kuma para hablar con su servidor. Cada acción es un "evento" con nombre (`addNotification`…), sus argumentos y una función *callback* que recibe la respuesta. Tu script `scripts/uptime-kuma-monitores.js` ya lo usa con el helper `call(ev, ...args)`.

## A.1 Campos del objeto de notificación (tipo `telegram`)

Comprobado en el código de la etiqueta `2.5.11` (publicada el 2026-11-12).

### Campos comunes (formulario `NotificationDialog.vue` y `server/notification.js`)

| Campo | Tipo | Qué hace |
|---|---|---|
| `name` | string | Nombre visible. Se guarda en la columna `notification.name`. |
| `type` | string | Proveedor: `"telegram"`. El formulario lo propone por defecto al crear una notificación. |
| `isDefault` | boolean | Se guarda en `is_default`. **Solo lo aplica la web**: al crear un monitor desde la interfaz, se marca solo. El evento `add` del servidor **no** lo aplica. |
| `applyExisting` | boolean | Se usa una sola vez y no se guarda (el servidor lo pone a `false` antes de guardar). Si es `true`, ejecuta `applyNotificationEveryMonitor()`, que crea una fila en `monitor_notification` para cada monitor del usuario que todavía no la tenga. |
| `active` | — | `save()` no lo escribe. La columna existe y `notificationList` la devuelve como booleano. |

Todo el objeto (incluido el token) se guarda como JSON en la columna `config` de la tabla `notification`, dentro de la base de datos SQLite de Uptime Kuma (en su PVC, no en Git).

### Campos propios de Telegram (`telegram.js` y `Telegram.vue`)

| Campo | Tipo | Por defecto | Uso en la petición a Telegram |
|---|---|---|---|
| `telegramBotToken` | string (obligatorio) | — | Va en la URL: `{servidor}/bot{token}/sendMessage` |
| `telegramChatID` | string (obligatorio) | — | `chat_id` |
| `telegramMessageThreadID` | string | vacío | `message_thread_id` (solo se envía si tiene valor; es el tema de un supergrupo con foros) |
| `telegramServerUrl` | string | `https://api.telegram.org` | Servidor de la Bot API (para usar uno local) |
| `telegramSendSilently` | boolean | `false` | `disable_notification` (llega sin sonido) |
| `telegramProtectContent` | boolean | `false` | `protect_content` (no se puede reenviar ni guardar) |
| `telegramUseTemplate` | boolean | `false` | Activa la plantilla propia |
| `telegramTemplate` | string | — | Plantilla Liquid (obligatoria si `telegramUseTemplate` es `true`) |
| `telegramTemplateParseMode` | `"plain"`, `"HTML"` o `"MarkdownV2"` | — | `parse_mode` (no se envía si es `plain`) |

Además, siempre envía `link_preview_options: { is_disabled: true }`, es decir, sin vista previa de enlaces.

Detalles del envío (`telegram.js`):
- Hace **POST** con cuerpo JSON (axios) a `${telegramServerUrl}/bot${telegramBotToken}/sendMessage`.
- Mensaje por defecto (`server/model/monitor.js`): `[<nombre del monitor>] [<icono> Up|Down] <mensaje del latido>`.
- `testNotification` envía el texto `"<name> Testing"`.
- Con `MarkdownV2`, Uptime Kuma escapa solo los caracteres especiales. **Con `HTML` no escapa nada**: si el nombre o el mensaje llevan `<` o `&`, Telegram puede rechazar el mensaje. Por eso la opción más segura es no usar plantilla o usar `MarkdownV2`.

## A.2 Eventos socket.io (`server/server.js`, 2.5.11)

| Evento | Argumentos | Respuesta del callback |
|---|---|---|
| `addNotification` | `(notification, notificationID, callback)`. `notificationID = null` crea una nueva; con un id la edita. | `{ ok: true, msg: "Saved.", msgi18n: true, id }` o `{ ok: false, msg }` |
| `testNotification` | `(notification, callback)`. No hace falta guardarla antes. | `{ ok: true, msg: "Sent Successfully." }` o `{ ok: false, msg }` |
| `deleteNotification` | `(notificationID, callback)` | `{ ok: true, msg: "successDeleted", msgi18n: true }` |
| `notificationList` (lo envía el servidor) | Llega justo después del `login` y después de cada add/delete | Array con `id`, `name`, `config` (JSON en texto), `isDefault`, `active`… |

Cómo enlazar la notificación con los monitores:
- **Monitores que ya existen**: `applyExisting: true` dentro de `addNotification`.
- **Monitores nuevos creados por script** (eventos `add`/`editMonitor`): añade `notificationIDList: { "<id>": true }` al objeto del monitor. El servidor, en `updateMonitorNotification()`, **borra** las relaciones del monitor y crea solo las que vienen en esa lista. Si no la mandas, el monitor se queda sin avisos.

Ejemplo con el estilo de tu script (el token y el chat_id llegan por variables de entorno y nunca se escriben en Git):

```js
// Tras el login (ya lo hace tu script), el servidor emite "notificationList".
let existentes = [];
s.on("notificationList", (lista) => { existentes = lista; });

const notificacion = {
  name: "Telegram",
  type: "telegram",
  isDefault: true,          // la web la marcará en los monitores nuevos
  applyExisting: true,      // enlazarla ya con los 7 monitores actuales
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatID: process.env.TELEGRAM_CHAT_ID,
  telegramServerUrl: "https://api.telegram.org",
  telegramSendSilently: false,
  telegramProtectContent: false,
  telegramUseTemplate: false,
};

// 1) Probar antes de guardar
const prueba = await call("testNotification", notificacion);
if (!prueba.ok) throw new Error(prueba.msg);

// 2) Crear o actualizar (idempotente: reutiliza el id si ya existe con ese nombre)
const previa = existentes.find((n) => n.name === notificacion.name);
const res = await call("addNotification", notificacion, previa ? previa.id : null);
console.log(res); // { ok: true, msg: "Saved.", msgi18n: true, id: 1 }

// 3) En los monitores que cree el script a partir de ahora:
//    monitor.notificationIDList = { [res.id]: true };
```

## A.3 Crear el bot y obtener el chat_id

**Crear el bot** (documentación oficial de *Bot Features*):
1. En Telegram abre **@BotFather** (la cuenta verificada) y envía `/newbot`.
2. Escribe el nombre visible (por ejemplo "Avisos Pi").
3. Escribe el *username*: de 5 a 32 caracteres, solo letras latinas, números y guion bajo, y **debe terminar en `bot`** (por ejemplo `avisos_pi_bot`).
4. BotFather te da el **token** (`123456789:ABC...`). Quien lo tenga controla el bot. Si se filtra, genera uno nuevo con `/token` (corregido tras verificar: la documentación oficial cita `/token`, no `/revoke`).

**Obtener el chat_id**. El bot no puede escribirte primero: antes tienes que enviarle tú cualquier mensaje (por ejemplo `/start`).

```bash
# Pega el token sin que quede en el historial de la shell
read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN

# Comprobar que el token es válido
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"

# Ver los mensajes pendientes; el chat_id está en result[].message.chat.id
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | python3 -m json.tool
# (con jq) solo los chats:
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
  | jq '.result[] | (.message // .channel_post).chat | {id, type, title, username}'

# Mensaje de prueba (silencioso)
export TELEGRAM_CHAT_ID=123456789
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": ${TELEGRAM_CHAT_ID}, \"text\": \"Prueba desde la Pi\", \"disable_notification\": true}"
```

- Chat privado: id positivo. Grupos: negativo. Supergrupos y canales: empiezan por `-100`. En un canal, el mensaje aparece en `channel_post` en lugar de `message` (el botón "Auto Get" de Uptime Kuma mira los dos).
- `getUpdates` sale vacío si: hay un webhook configurado ("This method will not work if an outgoing webhook is set up"), el mensaje tiene más de 24 horas (Telegram no guarda los updates más tiempo) o, en un grupo con *privacy mode*, el mensaje no era un comando dirigido al bot.
- El botón **"Auto Get"** de Uptime Kuma hace la misma llamada `getUpdates` desde tu navegador y coge el último chat.

## A.4 Opciones útiles y límites de la API

Versión actual de la Bot API: **10.4 (9 de noviembre de 2026)**.

| Opción de `sendMessage` | Para qué sirve | En Uptime Kuma |
|---|---|---|
| `disable_notification` | Envío silencioso (sin sonido) | `telegramSendSilently` |
| `protect_content` | No se puede reenviar ni guardar | `telegramProtectContent` |
| `message_thread_id` | Publicar en un tema concreto de un supergrupo | `telegramMessageThreadID` |
| `parse_mode` | `HTML` o `MarkdownV2` | `telegramTemplateParseMode` |
| `link_preview_options` | Vista previa de enlaces (sustituye a `disable_web_page_preview`) | Siempre desactivada |

En `MarkdownV2` hay que escapar con `\` estos caracteres (Uptime Kuma ya lo hace):

```text
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

**Plantilla de ejemplo** (Liquid). Las variables disponibles son `status`, `name`, `hostnameOrURL`, `msg`, `monitorJSON` y `heartbeatJSON`:

```
Uptime Kuma: {{ name }}
{{ status }}
{{ hostnameOrURL }}
{{ msg }}
```

Con `parse_mode` en `plain` no hay que escapar nada. Para avisos de pocos monitores, el mensaje por defecto (sin plantilla) es suficiente.

**Límites** (FAQ oficial de bots):
- En un mismo chat, como mucho unos **1 mensaje por segundo** (se toleran ráfagas cortas).
- En un grupo, **20 mensajes por minuto**.
- En envíos masivos, unos **30 mensajes por segundo** (hasta 1000/s con *paid broadcasts*).
- Si te pasas, Telegram responde **HTTP 429** con `parameters.retry_after` (los segundos que hay que esperar).
- Texto del mensaje: de 1 a **4096 caracteres**.

Con 7 monitores no se llega a estos límites, salvo que caigan todos a la vez en un grupo.

---

# Parte B. Gráficas históricas en el clúster

> **Conceptos**
> - Una **serie temporal** es una métrica con unas etiquetas concretas, por ejemplo `node_memory_MemAvailable_bytes{node="rpi-k3s"}`. La RAM de la base de datos depende sobre todo de cuántas series "activas" hay.
> - **Scrape** (recoger): cada cierto tiempo, el recolector pide la página `/metrics` de cada programa. El intervalo (30 s, 60 s) marca cuántas muestras se guardan.
> - **Exporter**: programa que traduce el estado de algo a métricas. *node-exporter* mide el nodo (CPU, RAM, disco, temperatura) y *kube-state-metrics* mide los objetos de Kubernetes (pods, reinicios, deployments).
> - **Operador + CRD**: un controlador que añade tipos nuevos a Kubernetes (`ServiceMonitor`, `VMSingle`…). Es cómodo en clústeres grandes, pero en un solo nodo es una pieza más que consume RAM.

## B.1 Comparativa de opciones

Versiones comprobadas en Artifact Hub y GitHub (a fecha 2026-11-16):

| | kube-prometheus-stack | victoria-metrics-k8s-stack | Montaje mínimo (recomendado) |
|---|---|---|---|
| Chart | 93.3.0 (2026-11-13), operador v0.95.2 | 0.98.1 (2026-11-09), operador v0.75.2 | 4-5 charts sueltos (tabla B.2) |
| Componentes | Prometheus Operator, Prometheus 3.x, Alertmanager, Grafana, kube-state-metrics, node-exporter, CRD y cientos de reglas y dashboards | Operador VM, VMSingle, VMAgent, VMAlert, VMAlertmanager, Grafana 13.2.3, kube-state-metrics, node-exporter y CRD | VictoriaMetrics single (almacena y recoge), node-exporter, kube-state-metrics, Grafana y, para alertas, vmalert + Alertmanager. **Sin CRD ni operador.** |
| RAM medida en arm64 | Turing Pi (arm64, julio de 2026, en reposo): Prometheus ~352 MiB, Grafana 311 MiB, Alertmanager 25 MiB, kube-state-metrics 18 MiB, node-exporter 8-9 MiB por pod. El operador no se midió. Total: más de 0,7 GiB. En un foro de SUSE, Prometheus sufría OOM una y otra vez en Pi 4 de 2 GB. | No se encontraron medidas publicadas en Pi | No se encontraron medidas publicadas en Pi. Estimación: 0,5-0,75 GiB con alertas incluidas (ver "Recomendación final") |
| CPU | Sin medidas fiables publicadas | Sin medidas | Sin medidas (es poco: se recogen ~500 muestras por segundo o menos) |
| Complejidad | Alta: CRD enormes (exigen ServerSideApply en Argo CD), muchas reglas que en K3s dan falsos positivos | Media-alta: CRD y operador propios | Baja: Deployments/StatefulSets normales y un `scrape.yml` estándar de Prometheus |
| Imágenes arm64 | Sí (comprobado: prometheus v3.16.0, prometheus-operator y config-reloader v0.95.2) | Sí (comprobado: operator v0.75.2, vmagent, vmalert, victoria-metrics v1.156.0) | Sí (comprobado: todas las de la tabla B.2) |

Contexto de K3s en una Pi 4 (página oficial *Resource Profiling*): el proceso `k3s server` con SQLite usa unos **1215 MB** de RAM sin carga. Por eso en tu Pi solo quedan ~2,2 GiB libres.

## B.2 Recomendación: montaje mínimo con VictoriaMetrics single

Motivo: es la opción con menos piezas. VictoriaMetrics single guarda las métricas y además las recoge (no necesita vmagent), sin operador ni CRD. La pila de Prometheus ya pasa de 0,7 GiB en reposo según las medidas en arm64, que en esta Pi sería un tercio de la RAM libre.

| Componente | Repositorio Helm | Chart | Aplicación | Imagen |
|---|---|---|---|---|
| VictoriaMetrics single | `https://victoriametrics.github.io/helm-charts/` | `victoria-metrics-single` **0.51.0** | **v1.156.0** (2026-11-09) | `victoriametrics/victoria-metrics:v1.156.0` |
| node-exporter | `https://prometheus-community.github.io/helm-charts` | `prometheus-node-exporter` **5.1.0** | **v1.12.1** | `quay.io/prometheus/node-exporter:v1.12.1` |
| kube-state-metrics | `https://prometheus-community.github.io/helm-charts` | `kube-state-metrics` **9.0.1** | **v2.20.0** | `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0` |
| Grafana | `https://grafana-community.github.io/helm-charts` | `grafana` **14.4.1** | **13.3.1** (2026-11-10) | `docker.io/grafana/grafana:13.3.1-distroless` |
| vmalert + Alertmanager | `https://victoriametrics.github.io/helm-charts/` | `victoria-metrics-alert` **0.53.0** | vmalert **v1.156.0**; Alertmanager **v0.35.0** (el chart trae v0.34.2 por defecto) | `victoriametrics/vmalert:v1.156.0`, `prom/alertmanager:v0.35.0` |

- **Grafana**: el chart antiguo `grafana/helm-charts` está **marcado como obsoleto** en Artifact Hub (última versión 10.5.15, enero de 2026). El vigente es `grafana-community/helm-charts`, que es también el que usa kube-prometheus-stack 93.3.0 como dependencia.
- **Alertmanager v0.35.0** merece la pena frente a v0.34.2: oculta el token del bot en los errores que escribe en el log (#5254).

## B.3 Values mínimos, retención, disco e intervalo

### Cuántas series y cuánto disco

Estimación de series activas en este clúster (calculada por Claude, sin fuente; compruébala después en la interfaz de VictoriaMetrics, `/vmui` → *Cardinality*):
- node-exporter en una Pi: ~1-2 mil.
- kube-state-metrics con ~30-50 pods: ~3-6 mil.
- cAdvisor (CPU/RAM por contenedor): ~3-5 mil.
- VictoriaMetrics midiéndose a sí mismo: ~1 mil.
- Total: **~10-15 mil series**. Si además recoges un endpoint de K3s (apiserver/kubelet `/metrics`), súmale del orden de 20 mil más (dato de la issue k3s#2262, medido en K3s 1.18).

Fórmula oficial de VictoriaMetrics (guía *Understand your setup size*): `bytes por muestra (~1) × muestras por segundo × (retención + 1 ciclo) × 1,25`. Si la retención es de 30 días o menos, el ciclo es de un día; si es mayor, de un mes. Por eso conviene poner `30d` y no `1` (un mes).

| Series | Scrape | Retención 15 d | Retención 30 d |
|---|---|---|---|
| 15.000 | 60 s | ~0,4 GB | ~0,8 GB |
| 15.000 | 30 s | ~0,9 GB | ~1,7 GB |
| 30.000 | 30 s | ~1,7 GB | ~3,4 GB |
| 50.000 | 30 s | ~2,9 GB | ~5,6 GB |

Recomendación: `retentionPeriod: 30d`, PVC de **10Gi** y scrape cada **30 s**.
- La RAM depende de las series, no tanto del intervalo. A 30 s se ingieren ~500 muestras por segundo, que para VictoriaMetrics es muy poco, y se ve mejor el detalle en las gráficas.
- Ojo: local-path **no limita** el tamaño real del PVC, porque es una carpeta del SSD. Vigílalo con la alerta de disco.
- La documentación oficial pide dejar al menos un **20 % de disco libre** en `-storageDataPath`.
- VictoriaMetrics usa para cachés hasta el **60 %** de la memoria que ve (`-memory.allowedPercent=60`). Con `limits.memory` de 512Mi, eso son unos 300 MiB como máximo para cachés.

### Organización por namespaces

- `monitoring` (PSA **restricted** + ResourceQuota): VictoriaMetrics, kube-state-metrics, Grafana, vmalert y Alertmanager.
- `monitoring-node` (PSA **privileged**, ver B.6): solo node-exporter.

### 1) VictoriaMetrics single (`victoria-metrics-single` 0.51.0) en `monitoring`

```yaml
server:
  fullnameOverride: vmsingle            # Service: vmsingle.monitoring.svc:8428 (comprobar con kubectl get svc)
  retentionPeriod: 30d
  persistentVolume:
    enabled: true
    storageClassName: local-path
    size: 10Gi
  resources:
    requests: { cpu: 50m, memory: 192Mi }
    limits:   { cpu: "1", memory: 512Mi }
  # El chart no pone securityContext por defecto: hay que darlo para PSA restricted
  podSecurityContext:
    enabled: true
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
    seccompProfile: { type: RuntimeDefault }
  securityContext:
    enabled: true
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: { drop: [ALL] }
  scrape:
    enabled: true                       # crea el ConfigMap, el ClusterRole (nodes, nodes/metrics, endpoints…) y monta scrape.yml
    config:                             # sustituye entera la lista por defecto del chart
      global:
        scrape_interval: 30s
      scrape_configs:
        - job_name: victoriametrics
          static_configs:
            - targets: ["localhost:8428"]

        # CPU/RAM por contenedor (cAdvisor dentro del kubelet de K3s, puerto 10250)
        - job_name: kubernetes-nodes-cadvisor
          scheme: https
          tls_config:
            ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
            insecure_skip_verify: true
          bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
          kubernetes_sd_configs:
            - role: node
          metrics_path: /metrics/cadvisor
          honor_timestamps: false       # recomendado por VictoriaMetrics para cAdvisor
          relabel_configs:
            - action: labelmap
              regex: __meta_kubernetes_node_label_(.+)

        - job_name: node-exporter
          kubernetes_sd_configs:
            - role: endpoints
              namespaces: { names: [monitoring-node] }
          relabel_configs:
            - source_labels: [__meta_kubernetes_service_name]
              regex: node-exporter
              action: keep
            - source_labels: [__meta_kubernetes_pod_node_name]
              target_label: node

        - job_name: kube-state-metrics
          honor_labels: true
          kubernetes_sd_configs:
            - role: endpoints
              namespaces: { names: [monitoring] }
          relabel_configs:
            - source_labels: [__meta_kubernetes_service_name]
              regex: kube-state-metrics
              action: keep
            - source_labels: [__meta_kubernetes_endpoint_port_name]
              regex: http
              action: keep

        # OPCIONAL: métricas de K3s (apiserver, scheduler, controller-manager, kubelet…).
        # Recoge SOLO este endpoint (ver B.4). Añade del orden de 20k series.
        # - job_name: k3s
        #   scheme: https
        #   tls_config: { ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt, insecure_skip_verify: true }
        #   bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        #   kubernetes_sd_configs: [ { role: node } ]
```

Nota: desde Kubernetes 1.33 la API `Endpoints` está obsoleta (solo da avisos, sigue funcionando). Si quieres evitarlo, usa `role: endpointslice` y cambia `__meta_kubernetes_endpoint_port_name` por `__meta_kubernetes_endpointslice_port_name`; el ClusterRole del chart ya incluye `endpointslices`.

Los trabajos de recogida se han escrito a mano para que sean fáciles de leer. Por defecto, el chart trae unos genéricos (`kubernetes-apiservers`, `kubernetes-nodes`, `kubernetes-nodes-cadvisor` y `kubernetes-service-endpoints`), pero en K3s los dos primeros duplicarían métricas, y el último exige que los Services lleven las anotaciones `prometheus.io/scrape` y `prometheus.io/port`.

### 2) node-exporter (`prometheus-node-exporter` 5.1.0) en `monitoring-node`

Por defecto el chart ya trae `hostNetwork: true`, `hostPID: true`, el `/` del host montado en `/host/root` y un securityContext no-root (65534, drop ALL, seccomp RuntimeDefault). Los colectores `thermal_zone` y `hwmon` vienen activos por defecto.

```yaml
fullnameOverride: node-exporter
resources:
  requests: { cpu: 20m, memory: 32Mi }
  limits:   { cpu: 200m, memory: 64Mi }
extraArgs:   # sustituye la lista por defecto: se copian los dos valores del chart y se añaden las rutas de K3s
  - --collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run/containerd/.+|run/k3s/.+|var/lib/docker/.+|var/lib/kubelet/.+|var/lib/rancher/k3s/agent/.+)($|/)
  - --collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs|erofs)$
  - --collector.textfile.directory=/host/root/var/lib/node_exporter/textfile_collector   # métricas de throttling (B.7)
```

### 3) kube-state-metrics (`kube-state-metrics` 9.0.1) en `monitoring`

Por defecto ya cumple *restricted* (65534, seccomp RuntimeDefault, drop ALL, raíz de solo lectura).

```yaml
fullnameOverride: kube-state-metrics
resources:
  requests: { cpu: 20m, memory: 48Mi }
  limits:   { cpu: 200m, memory: 128Mi }
```

### 4) Grafana (`grafana` 14.4.1) en `monitoring`: ver B.8
### 5) vmalert + Alertmanager (`victoria-metrics-alert` 0.53.0) en `monitoring`: ver B.9

Todas las cifras de requests y limits son un punto de partida. Tras 24 horas, mide con `kubectl top pods -n monitoring` y ajústalas.

## B.4 Particularidades de K3s

- **Todo en un proceso, un solo registro de métricas.** Documentación oficial de K3s: Kubernetes usa un registro Prometheus por proceso, así que *"every exposed endpoint returns metrics for all components"*. Recoger varios endpoints solo duplica datos (la issue k3s#2262 habla de unas 21.598 métricas extra). **Recoge un solo endpoint de K3s, o ninguno.** Para gráficas de nodo y pods no hace falta ninguno.
- **etcd**: con SQLite (kine) no existe. No hay nada que recoger.
- **scheduler, controller-manager y kube-proxy**: escuchan en `127.0.0.1` y sus métricas ya salen en cualquier endpoint de K3s. Si quisieras exponerlos (no hace falta), existen los flags `kube-scheduler-arg`, `kube-controller-manager-arg: bind-address=0.0.0.0` y `kube-proxy-arg: metrics-bind-address=0.0.0.0:10249`.
- **Opción oficial nueva**: con `supervisor-metrics: true` en `config.yaml`, K3s expone `/metrics` en el puerto 6443, con las métricas propias de K3s (`k3s_certificate_expiration_seconds`, etc.) y las de los componentes.
- **kubelet y cAdvisor**: en `https://<IP-del-nodo>:10250/metrics/cadvisor`, con el token de la ServiceAccount (RBAC `nodes/metrics`, que el chart crea) e `insecure_skip_verify` (el certificado del kubelet no lo firma la CA del token). La alternativa por el proxy del apiserver (`/api/v1/nodes/<nodo>/proxy/metrics/cadvisor`) funciona, pero carga más el apiserver.
- **Si usaras kube-prometheus-stack** (no recomendado): pon `kubeEtcd.enabled`, `kubeScheduler.enabled`, `kubeControllerManager.enabled` y `kubeProxy.enabled` a `false`; si no, aparecen alertas falsas tipo `KubeSchedulerDown` o `TargetDown`. Las mismas claves existen en victoria-metrics-k8s-stack 0.98.1 (comprobado en sus values). En el montaje mínimo no hay que desactivar nada, porque no trae reglas.

## B.5 Despliegue con Argo CD 3.6

- **Una Application por chart**, cada una en un fichero de `apps/` (encaja con el patrón app-of-apps que ya usas). La documentación de *multiple sources* avisa de que, con más de 2-3 fuentes en una Application, *"you are almost certainly abusing this feature"*.
- **`helm.valuesObject`**: los values van como YAML dentro de la propia Application. Si conviven, `valuesObject` manda sobre `values`.
- **ServerSideApply**: hace falta cuando un recurso no cabe en la anotación de 262144 bytes (por ejemplo, los CRD de Prometheus Operator). El montaje mínimo **no tiene CRD**, así que no hace falta.
- **Hooks de test de Helm**: Argo CD no los soporta (`test-success`/`test-failure`, *"No equivalent in Argo CD"*). Pon `testFramework.enabled: false` en Grafana.
- **Secretos**: si Grafana generase su contraseña al azar, cada render daría una distinta. Con `admin.existingSecret` el chart no crea ningún Secret y Argo CD no ve diferencias. Los Secrets creados a mano no los gestiona Argo CD, así que `prune` no los borra.
- **Namespaces**: créalos desde Git con sus etiquetas PSA y su ResourceQuota (como `workloads/uptime-kuma/namespace.yaml`). La otra vía es `CreateNamespace=true` + `managedNamespaceMetadata`, que también puede poner etiquetas, pero no crea la ResourceQuota.

Ejemplo (`apps/victoria-metrics.yaml`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: victoria-metrics
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://victoriametrics.github.io/helm-charts/
    chart: victoria-metrics-single
    targetRevision: 0.51.0
    helm:
      releaseName: victoria-metrics
      valuesObject:
        server:
          fullnameOverride: vmsingle
          retentionPeriod: 30d
          # ... resto de values de B.3
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      limit: 5
      backoff: { duration: 10s, factor: 2, maxDuration: 3m }
```

Las demás Applications siguen el mismo patrón: cambian `repoURL`, `chart`, `targetRevision` y `destination.namespace` (node-exporter va a `monitoring-node`).

## B.6 node-exporter y Pod Security Admission

- El perfil **baseline** (y por tanto también *restricted*) prohíbe `spec.hostNetwork`, `spec.hostPID` y `spec.hostIPC` (*"Sharing the host namespaces must be disallowed"*), los volúmenes `hostPath` (*"HostPath volumes must be forbidden"*) y los `hostPort`. node-exporter usa las tres cosas, así que su namespace necesita **`privileged`**.
- Organización recomendada: node-exporter **solo** en `monitoring-node` con `pod-security.kubernetes.io/enforce: privileged`, y el resto en `monitoring` con `restricted`. Aunque el namespace sea *privileged*, el pod sigue corriendo como no-root, con drop ALL y raíz de solo lectura (valores por defecto del chart).
- Lo que hace falta para *restricted* en cada chart:
  - VictoriaMetrics y vmalert: el chart no pone securityContext; hay que darlo (B.3 y B.9).
  - Alertmanager del chart `victoria-metrics-alert`: viene con `securityContext.enabled: false`; hay que activarlo (B.9).
  - Grafana: lo cumple por defecto, **salvo** el contenedor `init-chown-data` (corre como root con CHOWN). Desactívalo con `initChownData.enabled: false`. Con local-path no hace falta, porque la carpeta del volumen se crea con permisos abiertos (igual que ya ocurre con Uptime Kuma rootless).
  - kube-state-metrics: lo cumple por defecto.
- **ResourceQuota**: con una cuota en el namespace, **todos** los contenedores, incluidos los init, deben declarar requests y limits. En Grafana eso afecta al init `download-dashboards` (ver `downloadDashboards.resources` en B.8).

Namespaces (`workloads/monitoring/namespaces.yaml`):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring-node
  labels:
    pod-security.kubernetes.io/enforce: privileged   # solo node-exporter (hostNetwork, hostPID, hostPath)
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: monitoring-quota
  namespace: monitoring
spec:
  hard:
    requests.cpu: "500m"
    requests.memory: 768Mi
    limits.cpu: "3"
    limits.memory: 2Gi
    persistentvolumeclaims: "3"
    requests.storage: 15Gi
```

## B.7 Temperatura y throttling de la Pi 4

**Temperatura** (node-exporter v1.12.1):
- `node_thermal_zone_temp{type="cpu-thermal", zone="0"}` va **en grados Celsius**: el código divide entre 1000 lo que lee de `/sys/class/thermal` (corregido tras verificar: Antigravity decía milésimas de grado).
- La misma temperatura aparece también como `node_hwmon_temp_celsius{chip=…, sensor="temp1"}`. Es la que muestra el dashboard *Node Exporter Full* (no usa `thermal_zone`).
- Las etiquetas exactas en tu Pi compruébalas así: `curl -s http://localhost:9100/metrics | grep -E 'thermal_zone_temp|hwmon_temp|hwmon_chip_names'`.

Umbrales oficiales de la Pi 4: entre 80 y 85 °C los núcleos Arm se frenan poco a poco; a 85 °C se frenan los núcleos y la GPU. La Pi 4 no tiene límite suave (*soft limit*). Por eso la alerta va en 75 °C.

**`vcgencmd get_throttled`**: no hay métrica estándar. La forma más simple es el **textfile collector** de node-exporter: un script del host escribe un fichero `.prom` y node-exporter lo publica junto a sus métricas. No hay que añadir ningún contenedor. Raspberry Pi OS ya trae `vcgencmd` (lo usas en `docs/05`). En Debian puro no está empaquetado.

Bits oficiales: `0x1` subtensión ahora, `0x2` frecuencia limitada ahora, `0x4` frenado ahora, `0x8` límite suave ahora; `0x10000`, `0x20000`, `0x40000` y `0x80000` indican lo mismo, pero "ha ocurrido desde el arranque".

`/usr/local/bin/rpi-throttled.sh`:

```bash
#!/bin/bash
# Publica el estado de "vcgencmd get_throttled" para el textfile collector de node-exporter.
set -euo pipefail
DIR=/var/lib/node_exporter/textfile_collector
mkdir -p "$DIR"
VAL=$(( $(vcgencmd get_throttled | cut -d= -f2) ))   # p. ej. "throttled=0x0" -> 0
TMP="$DIR/rpi_throttled.prom.$$"
{
  echo "# HELP rpi_throttled_raw Valor de vcgencmd get_throttled"
  echo "# TYPE rpi_throttled_raw gauge"
  echo "rpi_throttled_raw $VAL"
  echo "# HELP rpi_undervoltage_now 1 si hay subtension ahora"
  echo "# TYPE rpi_undervoltage_now gauge"
  echo "rpi_undervoltage_now $(( (VAL & 0x1) != 0 ))"
  echo "# HELP rpi_throttled_now 1 si la CPU esta frenada ahora"
  echo "# TYPE rpi_throttled_now gauge"
  echo "rpi_throttled_now $(( (VAL & 0x4) != 0 ))"
  echo "# HELP rpi_undervoltage_occurred 1 si hubo subtension desde el arranque"
  echo "# TYPE rpi_undervoltage_occurred gauge"
  echo "rpi_undervoltage_occurred $(( (VAL & 0x10000) != 0 ))"
  echo "# HELP rpi_throttled_occurred 1 si hubo frenado desde el arranque"
  echo "# TYPE rpi_throttled_occurred gauge"
  echo "rpi_throttled_occurred $(( (VAL & 0x40000) != 0 ))"
} > "$TMP"
chmod 644 "$TMP"
mv -f "$TMP" "$DIR/rpi_throttled.prom"   # escritura atómica: node-exporter nunca lee un fichero a medias
```

Se lanza cada 30 s con un *timer* de systemd que corre como root:

```ini
# /etc/systemd/system/rpi-throttled.service
[Unit]
Description=Exporta vcgencmd get_throttled para node-exporter
[Service]
Type=oneshot
ExecStart=/usr/local/bin/rpi-throttled.sh

# /etc/systemd/system/rpi-throttled.timer
[Unit]
Description=Lanza rpi-throttled cada 30 s
[Timer]
OnBootSec=1min
OnUnitActiveSec=30s
[Install]
WantedBy=timers.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now rpi-throttled.timer`

El contenedor de node-exporter lee la carpeta en `/host/root/var/lib/node_exporter/textfile_collector`, porque el chart ya monta el `/` del host en `/host/root` (ver `extraArgs` en B.3). Así no hace falta ningún volumen extra.

## B.8 Grafana

- **Versión**: chart `grafana` 14.4.1 (grafana-community) con Grafana **13.3.1**. Usa por defecto la imagen `-distroless` (sin shell).
- **Contraseña de admin fuera de Git**: crea el Secret a mano una vez y en los values solo pon su nombre.

```bash
read -rs GRAFANA_PASS
kubectl -n monitoring create secret generic grafana-admin \
  --from-literal=admin-user=admin --from-literal=admin-password="$GRAFANA_PASS"
unset GRAFANA_PASS
```

- **Dashboards**: dos formas de cargarlos.
  - *Sidecar*: un contenedor extra que vigila los ConfigMaps con la etiqueta `grafana_dashboard`. Viene **desactivado** por defecto y ocupa RAM todo el tiempo.
  - **Descarga al arrancar**, con `gnetId` (grafana.com) o `url` (recomendado aquí). La hace el init container `download-dashboards` (imagen `curlimages/curl:8.23.0`), que termina y libera su memoria. Necesita internet al arrancar el pod. **Pon siempre `revision`**: si falta, el chart descarga la revisión 1.

Dashboards comprobados (revisión actual en grafana.com):

| Dashboard | ID | Revisión | Notas |
|---|---|---|---|
| Node Exporter Full | 1860 | **46** | Variable de datasource `ds_prometheus`; temperatura vía `node_hwmon_temp_celsius` |
| Kubernetes / Views / Global (dotdc) | 15757 | 43 | Necesita kube-state-metrics + node-exporter |
| Kubernetes / Views / Namespaces | 15758 | 46 | |
| Kubernetes / Views / Nodes | 15759 | 40 | Falla si la etiqueta `node` no coincide con `nodename` de node-exporter (ver nota) |
| Kubernetes / Views / Pods | 15760 | 41 | Usa cAdvisor |
| Kubernetes / System / API Server | 15761 | 21 | Solo si activas el job opcional `k3s` |
| VictoriaMetrics - single-node | 10229 | 61 | Estado de la propia base de datos |

dotdc recomienda cargar sus dashboards por `url`. Aquí van fijados a la etiqueta **v3.0.8** (2026-09-20) en lugar de `master`, para que no cambien solos. Todos estos dashboards tienen variable de datasource, así que no hay que sustituir `${DS_PROMETHEUS}`.

Nota sobre el nombre del nodo: tu nodo se llama `rpi-k3s` (`node-name` en `config.yaml`). Si el `hostname` de la Pi es otro, el dashboard *Nodes* de dotdc no casa `node` con `nodename`. Compruébalo con `hostname`. Si no coinciden, su README trae un *relabeling* para arreglarlo.

Values (`valuesObject` de la Application de Grafana):

```yaml
testFramework:
  enabled: false
admin:
  existingSecret: grafana-admin
  userKey: admin-user
  passwordKey: admin-password
initChownData:
  enabled: false                   # el init corre como root: incompatible con restricted
persistence:
  enabled: true
  storageClassName: local-path
  size: 1Gi
resources:
  requests: { cpu: 50m, memory: 192Mi }
  limits:   { cpu: 500m, memory: 512Mi }
downloadDashboards:
  resources:                       # obligatorio con ResourceQuota
    requests: { cpu: 10m, memory: 16Mi }
    limits:   { cpu: 100m, memory: 64Mi }
ingress:
  enabled: true
  ingressClassName: traefik
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web
  hosts: [grafana.lab.home.arpa]
grafana.ini:
  server:
    root_url: http://grafana.lab.home.arpa
  analytics:
    reporting_enabled: false
    check_for_updates: false
datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
      - name: VictoriaMetrics
        uid: victoriametrics
        type: prometheus           # VictoriaMetrics es compatible con la API de Prometheus
        access: proxy
        url: http://vmsingle.monitoring.svc:8428
        isDefault: true
        jsonData:
          timeInterval: 30s        # igual que el scrape_interval
dashboardProviders:
  dashboardproviders.yaml:
    apiVersion: 1
    providers:
      - name: nodo
        orgId: 1
        folder: Nodo
        type: file
        disableDeletion: true
        editable: false
        options: { path: /var/lib/grafana/dashboards/nodo }
      - name: kubernetes
        orgId: 1
        folder: Kubernetes
        type: file
        disableDeletion: true
        editable: false
        options: { path: /var/lib/grafana/dashboards/kubernetes }
dashboards:
  nodo:
    node-exporter-full:  { gnetId: 1860,  revision: 46 }
    victoriametrics:     { gnetId: 10229, revision: 61 }
  kubernetes:
    k8s-views-global:     { url: https://raw.githubusercontent.com/dotdc/grafana-dashboards-kubernetes/v3.0.8/dashboards/k8s-views-global.json }
    k8s-views-namespaces: { url: https://raw.githubusercontent.com/dotdc/grafana-dashboards-kubernetes/v3.0.8/dashboards/k8s-views-namespaces.json }
    k8s-views-nodes:      { url: https://raw.githubusercontent.com/dotdc/grafana-dashboards-kubernetes/v3.0.8/dashboards/k8s-views-nodes.json }
    k8s-views-pods:       { url: https://raw.githubusercontent.com/dotdc/grafana-dashboards-kubernetes/v3.0.8/dashboards/k8s-views-pods.json }
```

## B.9 Alertas a Telegram desde las métricas

| | vmalert + Alertmanager (recomendado) | Alertas de Grafana |
|---|---|---|
| Pods extra | 2 (Alertmanager midió ~25 MiB en reposo en arm64; vmalert es un binario Go pequeño, sin medida publicada) | 0 (el motor va dentro de Grafana) |
| Reglas | Formato estándar de Prometheus (corto y fácil de leer) | Formato de provisión de Grafana (largo: refId, expresiones…) |
| Token fuera de Git | `bot_token_file` y `chat_id_file` (desde Alertmanager 0.26 y 0.31) leyendo un Secret montado | Variable de entorno desde un Secret y, en la provisión, `$VAR` o `${VAR}` (corregido tras verificar: no `$__env{}`) |
| Si Grafana cae | Las alertas siguen funcionando | No hay alertas |

**Lo más ligero son las alertas de Grafana** (ningún pod más). Aun así, la recomendación es vmalert + Alertmanager: cuesta unas decenas de MiB, las reglas son más simples de mantener en Git y no dependen de Grafana. Si prefieres la opción de Grafana, el contact point se provisiona con `type: telegram`, `bottoken: $TELEGRAM_BOT_TOKEN` y `chatid: $TELEGRAM_CHAT_ID`, y las variables se cargan con `envValueFrom` o `envFromSecret` del chart.

**Secret creado a mano (no va en Git):**

```bash
read -rs TELEGRAM_BOT_TOKEN
kubectl -n monitoring create secret generic alertmanager-telegram \
  --from-literal=bot-token="$TELEGRAM_BOT_TOKEN" --from-literal=chat-id=123456789
unset TELEGRAM_BOT_TOKEN
```

Values de `victoria-metrics-alert` 0.53.0. El chart genera la configuración de Alertmanager como Secret a partir de `alertmanager.config` con `toYaml`, así que `{{ $labels }}` y `{{ $value }}` pasan tal cuál. Si dejas vacío `server.notifier`, el chart conecta vmalert con su Alertmanager automáticamente.

```yaml
server:
  datasource:
    url: http://vmsingle.monitoring.svc:8428
  resources:
    requests: { cpu: 10m, memory: 32Mi }
    limits:   { cpu: 200m, memory: 128Mi }
  podSecurityContext:
    enabled: true
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    seccompProfile: { type: RuntimeDefault }
  securityContext:
    enabled: true
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: { drop: [ALL] }
  config:
    alerts:
      groups:
        - name: raspberry-pi
          rules:
            - alert: PiTemperaturaAlta
              expr: max(node_thermal_zone_temp{type="cpu-thermal"}) > 75
              for: 5m
              labels: { severity: warning }
              annotations:
                summary: 'CPU de la Pi a {{ $value | printf "%.1f" }} °C (se frena a partir de 80 °C)'
            - alert: PiMemoriaBaja
              expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100 < 10
              for: 5m
              labels: { severity: critical }
              annotations:
                summary: 'Memoria disponible del nodo: {{ $value | printf "%.0f" }} % (K3s expulsa pods con menos de 200Mi)'
            - alert: PiDiscoCasiLleno
              expr: node_filesystem_avail_bytes{mountpoint="/",fstype!="rootfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="rootfs"} * 100 < 15
              for: 10m
              labels: { severity: warning }
              annotations:
                summary: 'Disco raíz con {{ $value | printf "%.0f" }} % libre'
            - alert: PodReiniciandose
              expr: increase(kube_pod_container_status_restarts_total[15m]) > 2
              for: 1m
              labels: { severity: warning }
              annotations:
                summary: '{{ $labels.namespace }}/{{ $labels.pod }} ({{ $labels.container }}) se ha reiniciado {{ $value | printf "%.0f" }} veces en 15 min'
            # Opcional, con el script de B.7:
            - alert: PiSubtensionOFrenado
              expr: max(rpi_undervoltage_now) == 1 or max(rpi_throttled_now) == 1
              for: 1m
              labels: { severity: warning }
              annotations:
                summary: 'La Pi tiene subtensión o la CPU está frenada (vcgencmd get_throttled)'

alertmanager:
  enabled: true
  image:
    tag: v0.35.0
  resources:
    requests: { cpu: 10m, memory: 32Mi }
    limits:   { cpu: 200m, memory: 96Mi }
  podSecurityContext:
    enabled: true
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
    seccompProfile: { type: RuntimeDefault }
  securityContext:
    enabled: true
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: { drop: [ALL] }
  config:
    route:
      receiver: telegram
      group_by: [alertname]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 12h
    receivers:
      - name: telegram
        telegram_configs:
          - bot_token_file: /etc/alertmanager/telegram/bot-token
            chat_id_file: /etc/alertmanager/telegram/chat-id
            parse_mode: HTML          # valor por defecto
            send_resolved: true       # avisa también cuando se resuelve
  extraVolumes:
    - name: telegram
      secret:
        secretName: alertmanager-telegram
  extraVolumeMounts:
    - name: telegram
      mountPath: /etc/alertmanager/telegram
      readOnly: true
```

Si el mensaje pasa del límite de Telegram, Alertmanager lo recorta, o en modo HTML envía un mensaje alternativo.

---

# Recomendación final

**Componentes y versiones**

| Pieza | Chart | App | Namespace | requests / limits de RAM |
|---|---|---|---|---|
| VictoriaMetrics single | victoria-metrics-single 0.51.0 | v1.156.0 | monitoring | 192Mi / 512Mi |
| node-exporter | prometheus-node-exporter 5.1.0 | v1.12.1 | monitoring-node (privileged) | 32Mi / 64Mi |
| kube-state-metrics | kube-state-metrics 9.0.1 | v2.20.0 | monitoring | 48Mi / 128Mi |
| Grafana | grafana 14.4.1 (grafana-community) | 13.3.1 | monitoring | 192Mi / 512Mi |
| vmalert | victoria-metrics-alert 0.53.0 | v1.156.0 | monitoring | 32Mi / 128Mi |
| Alertmanager | (mismo chart) | v0.35.0 | monitoring | 32Mi / 96Mi |
| **Total** | | | | **~530Mi / ~1,4Gi** |

**Consumo esperado**: entre **0,5 y 0,75 GiB** de RAM real. Es una estimación hecha con las medidas en arm64 de Grafana, Alertmanager, kube-state-metrics y node-exporter y con una cifra prudente para VictoriaMetrics (no hay medidas publicadas en una Pi). Te quedaría ~1,5 GiB libre. CPU: casi nula en reposo. Disco: 1-4 GB para 30 días (PVC de 10Gi).

**Organización en el repo**
- `workloads/monitoring/`: `namespaces.yaml` (monitoring + monitoring-node + ResourceQuota) y `kustomization.yaml`, desplegados por `apps/monitoring.yaml`.
- `apps/victoria-metrics.yaml`, `apps/node-exporter.yaml`, `apps/kube-state-metrics.yaml`, `apps/grafana.yaml` y `apps/alertas.yaml`: una Application de tipo chart Helm con `valuesObject` cada una.
- Script y units de systemd del throttling: junto al resto de configuración del host (por ejemplo en `bootstrap/`).
- Fuera de Git: los Secrets `grafana-admin` y `alertmanager-telegram`, y el token dentro de Uptime Kuma.

**Pasos en orden**
1. **Bot de Telegram**: `/newbot` en @BotFather, mandarle un mensaje, sacar el `chat_id` con `getUpdates` y probar con `sendMessage` (A.3).
2. **Uptime Kuma**: añadir al script `testNotification` y luego `addNotification` con `applyExisting: true` e `isDefault: true`, pasando token y chat_id por variables de entorno. Hacer que los monitores nuevos lleven `notificationIDList` (A.2). Comprobar que llega el aviso parando un monitor.
3. **En la Pi**: instalar `rpi-throttled.sh` y su timer de systemd (B.7) y comprobar que se crea `/var/lib/node_exporter/textfile_collector/rpi_throttled.prom`.
4. **Namespaces**: commit de `workloads/monitoring/` + `apps/monitoring.yaml`, y esperar a que Argo CD cree `monitoring` y `monitoring-node`.
5. **Secrets a mano**: `grafana-admin` (B.8) y `alertmanager-telegram` (B.9).
6. **Métricas**: commit de las Applications de VictoriaMetrics, node-exporter y kube-state-metrics. Comprobar los targets en `kubectl -n monitoring port-forward svc/vmsingle 8428` → `http://localhost:8428/targets` (todos en *up*) y que existe `node_thermal_zone_temp`.
7. **Grafana**: commit de `apps/grafana.yaml`, entrar en `http://grafana.lab.home.arpa` y revisar los dashboards (si falta el de *Nodes*, revisar el nombre del nodo).
8. **Alertas**: commit de `apps/alertas.yaml`. Para probar Telegram sin esperar a una alerta real: `kubectl -n monitoring port-forward svc/<servicio-alertmanager> 9093` y luego `curl -XPOST localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{"labels":{"alertname":"Prueba"}}]'`.
9. **Medir y ajustar**: a las 24 h, `kubectl top pods -n monitoring` y `kubectl top pods -n monitoring-node`, y la cardinalidad en `/vmui`. Ajustar limits y cuota.
10. **Vigilar lo nuevo**: añadir a Uptime Kuma un monitor HTTP para Grafana.

---

## Correcciones respecto a la respuesta de Antigravity

- Grafana: la app es **13.3.1** con el chart **14.4.1**, no 11.6.0 con el 14.2.0 (corregido tras verificar).
- node-exporter: app **v1.12.1**, no v1.9.0. kube-state-metrics: chart **9.0.1**, no 9.0.0 (corregido tras verificar).
- Dashboard de VictoriaMetrics: es el **10229**. El 13665 es un dashboard de Speedtest (corregido tras verificar).
- Revisiones: Node Exporter Full va por la **46** (no la 37) y los de dotdc por la 21-46 (no la 5) (corregido tras verificar).
- `node_thermal_zone_temp` va en **°C**, no en milésimas (corregido tras verificar).
- Variables en la provisión de Grafana: `$VAR` / `${VAR}`, no `$__env{VAR}` (corregido tras verificar).
- Ejemplos de Argo CD con versiones viejas (kube-prometheus-stack 65.8.1, k8s-stack 0.25.0). Las actuales son 93.3.0 y 0.98.1 (corregido tras verificar).
- Uptime Kuma: el reintento omitía `telegramServerUrl`, `telegramUseTemplate`, `telegramTemplate`, `telegramTemplateParseMode` y `link_preview_options`, y afirmaba que `save()` guarda `active`, cosa que no hace (corregido tras verificar en el código).
- BotFather: la documentación oficial habla de `/token` para regenerar el token (corregido tras verificar).
- Se quitaron cifras de RAM sin fuente (incluida una referencia a un blog que no se pudo comprobar) y la idea de poner `adminPassword` en los values, porque el repo es público.

## Fuentes

- Uptime Kuma 2.5.11, código: https://github.com/louislam/uptime-kuma/blob/2.5.11/server/notification-providers/telegram.js (verificada) · https://github.com/louislam/uptime-kuma/blob/2.5.11/src/components/notifications/Telegram.vue (verificada) · https://github.com/louislam/uptime-kuma/blob/2.5.11/server/notification.js (verificada) · https://github.com/louislam/uptime-kuma/blob/2.5.11/server/server.js (verificada) · https://github.com/louislam/uptime-kuma/blob/2.5.11/src/components/NotificationDialog.vue (verificada) · https://github.com/louislam/uptime-kuma/blob/2.5.11/server/notification-providers/notification-provider.js (verificada)
- Telegram Bot API 10.4: https://core.telegram.org/bots/api (verificada) · FAQ y límites: https://core.telegram.org/bots/faq (verificada) · BotFather: https://core.telegram.org/bots/features (verificada)
- Artifact Hub (versiones de los charts): https://artifacthub.io/packages/helm/victoriametrics/victoria-metrics-single · https://artifacthub.io/packages/helm/prometheus-community/prometheus-node-exporter · https://artifacthub.io/packages/helm/prometheus-community/kube-state-metrics · https://artifacthub.io/packages/helm/grafana-community/grafana · https://artifacthub.io/packages/helm/victoriametrics/victoria-metrics-alert · https://artifacthub.io/packages/helm/prometheus-community/kube-prometheus-stack · https://artifacthub.io/packages/helm/victoriametrics/victoria-metrics-k8s-stack (verificadas por API)
- Values de los charts: https://github.com/VictoriaMetrics/helm-charts/blob/victoria-metrics-single-0.51.0/charts/victoria-metrics-single/values.yaml · https://github.com/VictoriaMetrics/helm-charts/blob/victoria-metrics-alert-0.53.0/charts/victoria-metrics-alert/values.yaml · https://github.com/prometheus-community/helm-charts/blob/prometheus-node-exporter-5.1.0/charts/prometheus-node-exporter/values.yaml · https://github.com/prometheus-community/helm-charts/blob/kube-state-metrics-9.0.1/charts/kube-state-metrics/values.yaml · https://github.com/grafana-community/helm-charts/blob/grafana-14.4.1/charts/grafana/values.yaml (verificadas)
- VictoriaMetrics: https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/ (verificada) · https://docs.victoriametrics.com/guides/understand-your-setup-size/ (verificada)
- K3s: https://docs.k3s.io/reference/metrics (verificada) · https://docs.k3s.io/reference/resource-profiling (verificada) · https://github.com/k3s-io/k3s/issues/2262 (verificada)
- Argo CD: https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/ (verificada) · https://argo-cd.readthedocs.io/en/stable/user-guide/helm/ (verificada) · https://argo-cd.readthedocs.io/en/stable/user-guide/multiple_sources/ (verificada)
- Pod Security Standards: https://kubernetes.io/docs/concepts/security/pod-security-standards/ (verificada)
- node_exporter v1.12.1: https://github.com/prometheus/node_exporter/blob/v1.12.1/collector/thermal_zone_linux.go (verificada)
- Raspberry Pi: https://www.raspberrypi.com/documentation/computers/os.html (get_throttled, verificada) · https://www.raspberrypi.com/documentation/computers/raspberry-pi.html (umbrales térmicos, verificada)
- Alertmanager: https://prometheus.io/docs/alerting/latest/configuration/ (telegram_config, verificada) · https://github.com/prometheus/alertmanager/blob/main/CHANGELOG.md (versiones de bot_token_file, chat_id_file y message_thread_id, verificada)
- Grafana: https://grafana.com/docs/grafana/latest/administration/provisioning/ (variables de entorno, verificada) · https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/ (verificada)
- Dashboards: https://grafana.com/grafana/dashboards/1860 · https://grafana.com/grafana/dashboards/10229 · https://github.com/dotdc/grafana-dashboards-kubernetes (revisiones verificadas con la API de grafana.com)
- Medidas de consumo en arm64: https://turingpi.com/?p=722145 (kube-prometheus-stack, julio de 2026, verificada) · https://forums.suse.com/t/lightweight-metrics-options-for-k3s-pi-cluster/18796 (OOM de Prometheus en Pi 4 de 2 GB, solo vista en el buscador)
