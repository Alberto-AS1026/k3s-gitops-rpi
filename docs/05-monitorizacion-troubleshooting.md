# 5. Monitorización y troubleshooting

Objetivo: saber diagnosticar cualquier fallo del clúster con método, vigilar sus recursos y que el propio clúster avise cuando algo se cae.

Fecha: 2026-11-16

## Resultado

| Elemento | Valor |
|---|---|
| Guía de diagnóstico | Orden de comandos de arriba abajo: nodo → pods → eventos → logs → red → almacenamiento → GitOps |
| Laboratorio de fallos | 7 averías provocadas a propósito y diagnosticadas (sus salidas reales están abajo) |
| Monitores | 7 monitores en Uptime Kuma: API, DNS, Argo CD, GitHub, Ingress de Traefik y SSH de la Pi |
| Página de estado pública | http://status.lab.home.arpa/status/cluster |
| Detección de caídas | 85 s en detectar una caída de Argo CD y 28 s en ver que se ha recuperado |
| Registro del sistema | Persistente entre reinicios (`journald`) |

---

## 5.1 Método de diagnóstico

**Regla:** primero se mira, después se toca. Se va de lo general (el nodo) a lo concreto (un contenedor) y no se cambia nada hasta entender el síntoma.

```
¿El nodo está Ready? ──no──▶ journalctl -u k3s · describe node (Conditions)
        │ sí
¿Hay pods no Running? ──sí──▶ describe pod (Events) · logs --previous
        │ no
¿El Service tiene endpoints? ──no──▶ selector ≠ etiquetas · readinessProbe
        │ sí
¿Responde por el Ingress? ──no──▶ Host correcto · logs de Traefik
        │ sí
¿Argo CD está Synced/Healthy? ──no──▶ describe application (conditions)
```

### 5.1.1 Nodo

```bash
kubectl get nodes -o wide                                        # Ready, versión, IP, kernel
kubectl describe node rpi-k3s | sed -n '/^Conditions:/,/^Addresses:/p'
kubectl describe node rpi-k3s | sed -n '/Allocated resources:/,/Events:/p'
sudo journalctl -u k3s -f                                        # registro de K3s en directo
```

Salida real (sano):

```
MemoryPressure  False     ← ¿se queda sin RAM?
DiskPressure    False     ← ¿se queda sin disco?
PIDPressure     False     ← ¿demasiados procesos?
Ready           True

  Resource           Requests     Limits
  cpu                350m (10%)   1 (28%)
  memory             396Mi (12%)  938Mi (30%)
```

- **Requests** es la suma de lo **garantizado** a todos los pods: decide si cabe un pod nuevo.
- **Limits** es la suma de los **techos**: puede pasar del 100 % (*overcommit*) porque no todos los pods llegan a su techo a la vez.

### 5.1.2 Pods

```bash
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded   # solo los que no están bien
kubectl get pods -A -o custom-columns='NS:.metadata.namespace,POD:.metadata.name,REINICIOS:.status.containerStatuses[*].restartCount'
kubectl -n <ns> describe pod <pod>          # la sección Events del final es lo más útil
kubectl -n <ns> logs <pod>                  # salida del contenedor actual
kubectl -n <ns> logs <pod> --previous       # salida del contenedor que se cayó
kubectl -n <ns> logs deploy/<nombre> -f     # en directo
```

> **Pista:** si **todos** los pods tienen el mismo número de reinicios, el problema no es de una aplicación: se ha reiniciado el nodo o K3s (ver 5.4).

### 5.1.3 Eventos

```bash
kubectl get events -A --sort-by=.lastTimestamp | tail -20
kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp
```

Los **eventos** son el "diario" del clúster: imágenes descargadas, sondas fallidas, pods que no caben… Kubernetes los guarda solo una hora, así que hay que mirarlos pronto.

### 5.1.4 Red, Services e Ingress

```bash
kubectl -n <ns> get svc,endpointslices,ingress
kubectl -n <ns> port-forward svc/<servicio> 8080:80      # saltarse Traefik para aislar el fallo
kubectl -n kube-system logs deploy/traefik --tail=50
kubectl get ingress -A -o custom-columns='NS:.metadata.namespace,HOST:.spec.rules[*].host,ADDRESS:.status.loadBalancer.ingress[*].ip'
kubectl run dns-test -it --rm --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default
```

### 5.1.5 Almacenamiento

```bash
kubectl get pvc,pv -A
kubectl -n kube-system logs deploy/local-path-provisioner
sudo sh -c 'du -sh /var/lib/rancher/k3s/storage/*'      # datos reales en el SSD
```

> `sudo sh -c '…*…'`: el comodín `*` lo tiene que expandir root, porque el usuario normal no puede ver esa carpeta.

### 5.1.6 GitOps (Argo CD)

```bash
kubectl -n argocd get applications
kubectl -n argocd get application <app> -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}'
kubectl -n argocd logs deploy/argocd-repo-server --since=10m | grep -i error
kubectl -n argocd annotate application <app> argocd.argoproj.io/refresh=hard --overwrite   # forzar relectura del repo
```

## 5.2 Laboratorio de fallos

Para aprender a reconocer los errores, se provocaron a propósito en un namespace temporal, `laboratorio-fallos`, fuera de GitOps y borrado al terminar:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Namespace
metadata: {name: laboratorio-fallos}
---
apiVersion: v1
kind: Pod
metadata: {name: come-memoria, namespace: laboratorio-fallos}
spec:
  restartPolicy: Never
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "echo 'reservando memoria...'; tail /dev/zero"]   # consume RAM sin parar
    resources: {requests: {memory: 48Mi}, limits: {memory: 48Mi}}
# … (resto de casos de la tabla)
EOF
kubectl delete namespace laboratorio-fallos      # limpieza
```

| # | Caso provocado | Estado visible | Comando que lo explica | Mensaje real | Solución |
|---|---|---|---|---|---|
| 1 | Imagen `busybox:no-existe` | `ImagePullBackOff` | `describe pod` → Events | `Failed to pull image "busybox:no-existe": … NotFound` | Corregir nombre o etiqueta. En la Pi, comprobar que existe versión `arm64` |
| 2 | Programa que termina con error | `CrashLoopBackOff` / `Error` | `logs` y `logs --previous` | `ERROR: no encuentro /config/app.conf` · `exitCode=1` | Leer los logs: el fallo está en la aplicación o en su configuración |
| 3 | Consumo de RAM por encima del límite (48 Mi) | `OOMKilled` | `get pod -o jsonpath='{…state.terminated}'` y `dmesg` | `reason=OOMKilled exitCode=137` · `Memory cgroup out of memory: Killed process (tail)` | Subir `limits.memory` o corregir el consumo |
| 4 | Pide 6 GiB (hay 3 GiB asignables) | `Pending` | `describe pod` → `FailedScheduling` | `0/1 nodes are available: 1 Insufficient memory` | Bajar `requests` o añadir capacidad |
| 5 | La *readinessProbe* nunca pasa | `Running` pero `0/1` | `describe pod` → `Unhealthy` | `Readiness probe failed: HTTP probe failed with statuscode: 404` | Corregir la ruta o el puerto de la sonda |
| 6 | Service con selector `app: wep` (errata) | El Service existe, pero no responde | `get endpointslices` + `get pods --show-labels` | `ENDPOINTS <unset>` · selector `app=wep` frente a etiqueta `app=web` | Hacer coincidir el selector con las etiquetas |
| 7 | Dominio mal escrito (`statsu.…`) | `404 page not found` | `get ingress -A` | Traefik no tiene ninguna regla para ese `Host` | Corregir el DNS, el `Host` o el Ingress |

Detalles que conviene saber:

- **`exitCode=137`** = 128 + 9: el proceso murió por la señal 9 (`SIGKILL`). Junto a `OOMKilled`, significa "el kernel lo mató por pasarse de memoria".
- **`CrashLoopBackOff`** no es un error en sí: es Kubernetes esperando cada vez más (10 s, 20 s, 40 s… hasta 5 min) antes de reintentar. La causa está en los logs.
- **`logs` frente a `logs --previous`:** si el contenedor acaba de terminar, su salida se lee con `logs`; `--previous` muestra el intento anterior, que puede haberse limpiado ya.
- **`Running 0/1`** es engañoso: el proceso funciona, pero el Service **no le envía tráfico** hasta que la *readiness* pase.

## 5.3 Monitoreo de recursos

### 5.3.1 Clúster

```bash
kubectl top node
kubectl top pods -A --sort-by=memory
kubectl top pods -A --no-headers | awk '{gsub("Mi","",$4); m[$1]+=$4} END {for (n in m) print n, m[n] " Mi"}'
```

Foto real en reposo:

| Namespace | Memoria | Pods principales |
|---|---|---|
| `argocd` | 401 Mi | server 136 Mi, application-controller 121 Mi, repo-server 56 Mi |
| `kube-system` | 367 Mi | Traefik 154 Mi, metrics-server 83 Mi, CoreDNS 78 Mi |
| `uptime-kuma` | 200 Mi | (límite 512 Mi) |

> **Interpretación correcta:** `kubectl top node` marcaba **76 %** de memoria, mientras que `free -h` decía **2,2 GiB disponibles**. No es una contradicción:
> - El porcentaje se calcula sobre la memoria **asignable a pods** (3,0 GiB), no sobre el total (3,7 GiB).
> - El *working set* incluye parte de la **caché de ficheros**, que el kernel libera en cuanto alguien la necesita.
>
> Para saber si de verdad falta memoria hay que mirar `MemoryPressure` (5.1.1) y la columna `available` de `free`.

### 5.3.2 Raspberry Pi

```bash
vcgencmd measure_temp          # temp=50.6'C (por encima de ~80 °C la CPU se frena)
vcgencmd get_throttled         # 0x0 = sin problemas de alimentación ni temperatura
cat /proc/loadavg              # carga media de 1, 5 y 15 min (4 núcleos: < 4 es holgado)
free -h ; df -h /
```

`get_throttled` es un mapa de bits. Los más útiles:

| Bit | Valor | Significado |
|---|---|---|
| 0 | `0x1` | Tensión baja **ahora** (fuente de alimentación insuficiente) |
| 2 | `0x4` | CPU frenada **ahora** |
| 16 | `0x10000` | Ha habido tensión baja desde el arranque |
| 18 | `0x40000` | Ha habido frenado desde el arranque |

### 5.3.3 `k3s check-config`: falsos positivos

```bash
sudo k3s check-config
# CONFIG_IP_NF_FILTER: missing (fail)
# CONFIG_IP_NF_NAT: missing (fail)
# CONFIG_IP_NF_TARGET_MASQUERADE: missing (fail)
# STATUS: 3 (fail)
```

Los 3 "fallos" son los módulos del **iptables antiguo (legacy)**. El kernel de esta Raspberry Pi solo trae **nftables**, y K3s usa iptables en modo nft, así que no los necesita. Se comprobó antes de darlo por bueno:

```bash
sudo /var/lib/rancher/k3s/data/*/bin/aux/iptables --version   # → iptables v1.8.11 (nf_tables)
sudo /var/lib/rancher/k3s/data/*/bin/aux/iptables -t nat -S | grep -c KUBE-   # → 140 reglas de Kubernetes
```

Y la prueba funcional: desde un pod, `http://argocd-server.argocd.svc.cluster.local/healthz` → `ok`.

> **Lección:** un "fail" de una herramienta de comprobación hay que entenderlo antes de arreglarlo.

## 5.4 Caso real: reinicio inesperado y registro que se perdía

### Síntoma

Al revisar el clúster, **todos** los pods tenían 1 reinicio y había avisos de hacía 15 minutos (`Unauthorized` al actualizar endpoints, sondas fallidas).

### Diagnóstico

```bash
uptime -s                                               # → 23:15 (la Pi llevaba 16 min encendida)
systemctl show k3s -p ActiveEnterTimestamp,NRestarts    # → "activo desde" 00:55 del día anterior, 0 reinicios
journalctl --list-boots                                 # → un solo arranque registrado
```

- **Contradicción aparente:** la Pi llevaba 16 minutos encendida, pero K3s figuraba "activo" desde 23 horas antes. La explicación: **la Raspberry Pi no tiene reloj con pila (RTC)**. Al arrancar recupera la última hora guardada en disco (`/var/lib/systemd/timesync/clock`) y unos segundos después la corrige por NTP. K3s arrancó antes de esa corrección y quedó registrado con la hora vieja.
- **Un solo arranque registrado:** Raspberry Pi OS guarda el *journal* (el registro del sistema) **solo en RAM** (`Storage=volatile`, en `/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf`) para no desgastar las tarjetas SD. Al reiniciarse se perdió el registro del arranque anterior y no se podía saber el motivo.

### Solución: registro persistente

Fichero `/etc/systemd/journald.conf.d/90-persistente.conf`:

```
[Journal]
Storage=persistent
SystemMaxUse=200M
```

```bash
sudo systemctl restart systemd-journald && sudo journalctl --flush
sudo journalctl --disk-usage
```

- El fichero en `/etc` (`90-…`) se lee después del del sistema (`40-…`) y gana.
- `SystemMaxUse=200M` impide que el registro crezca sin control.
- A partir de ahora, tras un reinicio: `journalctl -b -1` muestra el arranque anterior, y sus últimas líneas, cómo terminó.

La causa probable del reinicio apareció en el caso siguiente.

## 5.5 Caso real: caché de Git de Argo CD dañada por un corte de luz

### Síntoma

Tras subir un commit, la Application `uptime-kuma` quedó en `Unknown` y no aplicaba los cambios.

### Diagnóstico

```bash
kubectl -n argocd get application uptime-kuma -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}'
```

```
ComparisonError: … git fetch origin acf7fd8… failed exit status 128:
error: object file .git/objects/5e/55b52d35a2fe… is empty
fatal: unpack-objects failed
```

- `argocd-repo-server` guarda una copia del repositorio en un `emptyDir`, un directorio temporal ligado al pod.
- Varios ficheros de esa copia existían pero tenían **0 bytes**. Uno de ellos era justo el commit `5e55b52`, el último que Argo CD había descargado antes del reinicio.
- **Un fichero creado pero vacío es la huella típica de un corte de corriente:** ext4 escribe primero en RAM y vuelca al disco segundos después (*delayed allocation*). Si la luz se va en ese intervalo, el fichero queda creado pero sin contenido.
- Se comprobó que nada importante se había dañado:
  ```bash
  python3 -c "import sqlite3; print(sqlite3.connect('/tmp/state-copia.db').execute('PRAGMA integrity_check').fetchone())"   # K3s → ok
  # Uptime Kuma (kuma.db) → ok
  sudo tune2fs -l /dev/sda2 | grep state     # → clean
  ```
  SQLite, que usan K3s y Uptime Kuma, está diseñado para sobrevivir a cortes de luz.

### Solución

```bash
kubectl -n argocd delete pod -l app.kubernetes.io/name=argocd-repo-server    # nuevo pod = caché nueva
kubectl -n argocd annotate application uptime-kuma argocd.argoproj.io/refresh=hard --overwrite
```

En segundos, las tres Applications volvieron a `Synced/Healthy` en el último commit.

> **Lecciones:**
> - Apagar la Pi siempre con `sudo poweroff`, nunca desenchufándola.
> - Una **caché** dañada se arregla borrándola. Los datos de verdad (SQLite, PVC) hay que comprobarlos con `integrity_check`.
> - El fallo apareció **lejos de su causa**, en Argo CD y no en el disco: por eso conviene leer siempre el mensaje completo de error.

## 5.6 Uptime Kuma vigilando el propio clúster

### 5.6.1 Identidad con mínimo privilegio para la API

La API de Kubernetes responde `401` a peticiones anónimas, porque K3s desactiva el acceso anónimo. Para vigilarla sin dar permisos de más (`workloads/uptime-kuma/monitor-api.yaml`):

- **ServiceAccount `monitor-api`** sin ningún Role ni RoleBinding. Kubernetes permite a cualquier identidad válida consultar `/livez`, `/readyz`, `/healthz` y `/version` (rol `system:public-info-viewer`), y nada más.
- **Secret de tipo `kubernetes.io/service-account-token`:** en Git no hay ningún secreto. Kubernetes genera el token y lo guarda en el Secret.
- **`automountServiceAccountToken: false`** en el Deployment de Uptime Kuma: la aplicación no necesita la API, así que no se le monta ningún token. Si alguien la comprometiera, no tendría credenciales del clúster.

```bash
kubectl auth can-i get pods -A --as=system:serviceaccount:uptime-kuma:monitor-api          # → no
kubectl auth can-i list secrets -A --as=system:serviceaccount:uptime-kuma:monitor-api      # → no
# con su token: GET /readyz → 200 · GET /api/v1/pods → 403
```

### 5.6.2 Monitores

| Grupo | Monitor | Tipo | Destino |
|---|---|---|---|
| Kubernetes | API de Kubernetes | HTTP + `Authorization: Bearer` | `https://kubernetes.default.svc.cluster.local/readyz` |
| Kubernetes | DNS del clúster (CoreDNS) | DNS | Resolver `kubernetes.default.svc.cluster.local` en `10.43.0.10` |
| GitOps | Argo CD | HTTP | `http://argocd-server.argocd.svc.cluster.local/healthz` |
| GitOps | GitHub (repositorio GitOps) | HTTP, cada 5 min | El repositorio del que lee Argo CD |
| Entrada (Traefik) | Traefik → Argo CD | HTTP + cabecera `Host` | `http://traefik.kube-system.svc.cluster.local/` con `Host: argocd.lab.home.arpa` |
| Entrada (Traefik) | Traefik → Uptime Kuma | HTTP + `Host`, acepta 3xx | Igual, con `Host: status.lab.home.arpa` |
| Nodo | SSH de la Raspberry Pi | Puerto TCP | `192.168.0.27:22` |

Cada destino se probó antes desde el pod. Dos detalles que salieron en esas pruebas:

- La función `fetch` de Node **ignora la cabecera `Host`**, porque el estándar web la prohíbe, y daba un 404 falso. Uptime Kuma usa el cliente HTTP clásico de Node, que sí la respeta: con él, `200` y `302`.
- Los monitores de "Traefik → …" van al Service **interno** de Traefik, así que comprueban el enrutado de los Ingress sin depender del DNS de casa.

### 5.6.3 Creación automática (`scripts/uptime-kuma-monitores.js`)

Uptime Kuma no tiene API REST para configurar monitores: su interfaz habla con el servidor por **socket.io**. El script hace lo mismo que la web:

1. `login`.
2. Recibe la lista de monitores existentes (`monitorList`) y crea solo los que faltan (`add`). Por eso se puede ejecutar varias veces sin duplicar.
3. Crea o actualiza la página de estado (`addStatusPage` + `saveStatusPage`).

Los campos de cada monitor se tomaron de los valores por defecto del formulario de la interfaz (`src/pages/EditMonitor.vue`, v2.5.11).

```bash
TOKEN=$(kubectl -n uptime-kuma get secret monitor-api-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n uptime-kuma exec -i deploy/uptime-kuma -- node - "<contraseña de admin>" "$TOKEN" < scripts/uptime-kuma-monitores.js
```

```
creado:    API de Kubernetes (id 1)
creado:    DNS del clúster (CoreDNS) (id 2)
…
página de estado: /status/cluster
```

> Los monitores viven en la base de datos de Uptime Kuma (en el PVC), no en Git. Si el clúster se reconstruye, Argo CD recrea la aplicación y este script recrea los monitores.
>
> La primera ejecución, justo después de recrearse el pod, no recibió respuesta; la segunda funcionó sin cambios (el servidor aún estaba arrancando). Como no crea duplicados, repetirla es seguro.

### 5.6.4 Página de estado pública

http://status.lab.home.arpa/status/cluster muestra los 7 monitores agrupados, sin iniciar sesión. También se puede consultar por API:

```bash
curl -s http://status.lab.home.arpa/api/status-page/heartbeat/cluster    # último estado de cada monitor
```

| Monitor | Estado | Respuesta |
|---|---|---|
| API de Kubernetes | OK | 74 ms |
| DNS del clúster (CoreDNS) | OK | 7 ms |
| Argo CD | OK | 17 ms |
| GitHub (repositorio GitOps) | OK | 858 ms |
| Traefik → Argo CD | OK | 19 ms |
| Traefik → Uptime Kuma | OK | 23 ms |
| SSH de la Raspberry Pi | OK | 2 ms |

### 5.6.5 Prueba: ¿detecta una caída?

```bash
kubectl -n argocd scale deploy argocd-server --replicas=0    # 00:48:28 apagado
# Uptime Kuma marca "Argo CD" como CAÍDO                     # 00:49:53 (85 s)
kubectl -n argocd scale deploy argocd-server --replicas=1    # 00:51:25 encendido
# Uptime Kuma marca "Argo CD" como OK                        # 00:51:53 (28 s)
```

- **85 s para detectar:** intervalo de 60 s más 1 reintento (`maxretries: 1`), para no dar falsas alarmas por un fallo puntual.
- **28 s para ver la recuperación:** el reintento de un monitor caído es más rápido.

> `argocd-server` no lo gestiona Argo CD (se instaló a mano en 3.2), así que no hubo *self-heal*: es una buena forma de probar los monitores.

## Siguientes pasos posibles

- **Avisos:** conectar Uptime Kuma a Telegram, Discord o correo (*Notifications*) para recibir un mensaje cuando algo cae.
- **Métricas históricas:** Prometheus + Grafana (o VictoriaMetrics, más ligero) para gráficas de CPU y memoria a lo largo del tiempo.
- **Alertas de recursos:** avisar si la temperatura de la Pi pasa de 70 °C o si un pod se acerca a su límite de memoria.
