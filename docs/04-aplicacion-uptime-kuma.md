# 4. Aplicación de ejemplo: Uptime Kuma con almacenamiento persistente

Objetivo: desplegar una aplicación real **solo con GitOps** (commit → Argo CD), con namespace propio, límites de recursos, disco persistente, seguridad estricta e Ingress.

Fecha: 2026-11-14 (primer intento, en microSD) · 2026-11-15 (despliegue definitivo, en SSD)

## Resultado

| Elemento | Valor |
|---|---|
| Aplicación | [Uptime Kuma](https://github.com/louislam/uptime-kuma) 2.5.11: panel que vigila si tus servicios están caídos |
| Imagen | `louislam/uptime-kuma:2.5.11-slim-rootless` (arm64) |
| URL | http://status.lab.home.arpa |
| Namespace | `uptime-kuma`, Pod Security `restricted` y ResourceQuota |
| Datos | PVC `local-path` de 2 Gi con SQLite, protegido frente al *prune* de Argo CD |
| Consumo | ~56m de CPU y ~106 Mi de RAM (límite: 1 CPU y 512 Mi) |

## Conceptos básicos

- **Namespace:** "carpeta" lógica dentro del clúster. Aísla los objetos de una aplicación y permite ponerle límites propios.
- **Deployment:** dice qué contenedor ejecutar y cuántas copias. Si el pod muere, crea otro.
- **Service (ClusterIP):** IP virtual estable delante de los pods. Los pods cambian de IP al recrearse; el Service no.
- **Ingress:** regla "si el dominio es X, envía la petición al Service Y". La aplica Traefik.
- **PersistentVolumeClaim (PVC):** una "petición de disco". Los contenedores son efímeros: al recrearse pierden todo lo que escribieron. Lo que se guarda en un PVC sobrevive.
- **Kustomize:** herramienta integrada en `kubectl` y en Argo CD que junta varios manifiestos y les aplica cambios comunes (namespace, etiquetas…).

## 4.1 Elección de la imagen

```bash
curl -s https://api.github.com/repos/louislam/uptime-kuma/releases/latest | grep tag_name    # → 2.5.11
curl -s "https://hub.docker.com/v2/repositories/louislam/uptime-kuma/tags?page_size=25"     # variantes y arquitecturas
```

| Variante | Qué es |
|---|---|
| normal | Incluye MariaDB y Chromium embebidos (más pesada) |
| `slim` | Sin MariaDB ni Chromium; usa **SQLite** (una base de datos que es un simple fichero) |
| `rootless` | El proceso no se ejecuta como root dentro del contenedor |
| **`slim-rootless`** | Las dos ventajas: la más ligera y la más segura → **elegida** |

Antes de escribir los manifiestos se comprobó en el **código fuente de esa versión exacta**:

| Dato | Dónde | Valor |
|---|---|---|
| Usuario | `docker/dockerfile` → `USER node` | UID 1000 |
| Puerto | `EXPOSE 3001` | 3001 |
| Carpeta de datos | `server/server.js` (`./data`, con `WORKDIR /app`) | `/app/data` |
| Saltar el asistente inicial de base de datos | `server/setup-database.js`: si existe `UPTIME_KUMA_DB_TYPE`, `needSetup = false` | `UPTIME_KUMA_DB_TYPE=sqlite` |
| Endpoint ligero para las sondas | `server/routers/api-router.js` | `/api/entry-page` |

## 4.2 Manifiestos (`workloads/uptime-kuma/`)

```
apps/uptime-kuma.yaml          ← Application de Argo CD
workloads/uptime-kuma/
├── kustomization.yaml         ← lista de manifiestos + etiquetas comunes
├── namespace.yaml             ← Namespace + ResourceQuota
├── pvc.yaml                   ← disco persistente
├── deployment.yaml            ← el contenedor
├── service.yaml               ← IP estable
└── ingress.yaml               ← status.lab.home.arpa
```

### 4.2.1 `namespace.yaml`: Namespace y ResourceQuota

- Etiqueta `pod-security.kubernetes.io/enforce: restricted`: **Pod Security Admission** es un control integrado en Kubernetes que **rechaza** cualquier pod de este namespace que no cumpla el perfil `restricted` (sin root, sin privilegios, sin capacidades extra…).
- **ResourceQuota:** el máximo que pueden pedir **todos** los pods del namespace juntos. Aunque alguien suba un manifiesto mal hecho, nunca podrá saturar la Pi.

| Recurso | Máximo |
|---|---|
| `requests.cpu` / `requests.memory` | 500m / 512 Mi |
| `limits.cpu` / `limits.memory` | 2 / 1 Gi |
| PVCs / almacenamiento | 2 / 5 Gi |

### 4.2.2 `pvc.yaml`: disco persistente

- `storageClassName: local-path`: el provisionador de K3s crea una carpeta en `/var/lib/rancher/k3s/storage/` de la Pi y la monta en el pod.
- `ReadWriteOnce`: lo monta un solo nodo a la vez.
- `storage: 2Gi`: local-path **no impone** el tamaño; es orientativo.
- Anotación `argocd.argoproj.io/sync-options: Prune=false`: **protección de datos**. La `reclaimPolicy` de local-path es `Delete`, así que borrar el PVC borra los datos. Con esta anotación, Argo CD nunca lo borra aunque el fichero desaparezca de Git.

### 4.2.3 `deployment.yaml`: el contenedor

| Ajuste | Por qué |
|---|---|
| `replicas: 1` y `strategy: Recreate` | Primero se para el pod viejo y luego arranca el nuevo. Con un disco `ReadWriteOnce` y SQLite **nunca debe haber dos pods escribiendo** en la misma base de datos |
| `enableServiceLinks: false` | **Trampa conocida:** Kubernetes inyecta en cada pod variables con los datos de los Services, como `UPTIME_KUMA_PORT=tcp://10.43.x.x:80` para un Service llamado `uptime-kuma`. Uptime Kuma lee `UPTIME_KUMA_PORT` como su puerto y no arrancaría |
| `runAsNonRoot`, `runAsUser/Group: 1000`, `fsGroup: 1000` | Se ejecuta como el usuario `node` de la imagen, y el volumen pertenece a su grupo para poder escribir |
| `seccompProfile: RuntimeDefault` | Filtro del kernel que bloquea llamadas al sistema peligrosas |
| `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]` | El proceso no puede ganar privilegios ni usar capacidades especiales del kernel |
| `env UPTIME_KUMA_DB_TYPE=sqlite` | Sin asistente inicial de base de datos |
| `env TZ=Europe/Madrid` | Hora local en la aplicación |

**Recursos:**

| | CPU | RAM | Significado |
|---|---|---|---|
| `requests` | 100m | 192 Mi | Lo **garantizado**: el planificador solo pone el pod donde quepa |
| `limits` | 1 | 512 Mi | El **techo**: si pasa de 512 Mi el kernel lo mata (`OOMKilled`); si pasa de 1 CPU solo se le frena (*throttling*) |

> `100m` = 100 milicores = una décima parte de un núcleo.

**Sondas de salud** (las tres llaman a `GET /api/entry-page`):

| Sonda | Configuración | Qué hace si falla |
|---|---|---|
| `startupProbe` | cada 10 s, hasta 30 fallos | Da hasta 5 minutos al primer arranque, que crea la base de datos. Mientras no pase, las otras dos no actúan |
| `readinessProbe` | cada 10 s | El pod deja de recibir tráfico del Service (pero no se reinicia) |
| `livenessProbe` | cada 30 s, 3 fallos | Kubernetes reinicia el contenedor (por ejemplo, si se cuelga) |

### 4.2.4 `service.yaml` e `ingress.yaml`

- **Service** `ClusterIP`: puerto 80 → puerto `http` (3001) del contenedor. Usar el **nombre** del puerto en lugar del número evita errores si cambia.
- **Ingress**: `status.lab.home.arpa` → Service `uptime-kuma:80`, por el *entrypoint* `web` (puerto 80) de Traefik. Uptime Kuma usa WebSockets y Traefik los soporta sin configuración extra.

### 4.2.5 `kustomization.yaml` y `apps/uptime-kuma.yaml`

- Kustomize añade `namespace: uptime-kuma` y la etiqueta `app.kubernetes.io/part-of: k3s-gitops-rpi` a todo.
  - Se usa `labels` con `includeSelectors: false` en lugar del antiguo `commonLabels`, que también modifica los **selectores**. Los selectores de un Deployment son inmutables: cambiarlos obligaría a borrarlo y recrearlo.
- La Application de Argo CD apunta a `workloads/uptime-kuma`, con `prune`, `selfHeal`, `PruneLast` (al borrar, lo que sobra se elimina al final) y reintentos.

## 4.3 Validación antes de subir

```bash
kubectl kustomize workloads/uptime-kuma               # ver el resultado final, como lo verá Argo CD
kubectl apply --dry-run=server -k workloads/uptime-kuma
```

**Limitación de `--dry-run`:** el Namespace "se crea" solo en simulación, así que el resto de objetos falla con `namespaces "uptime-kuma" not found`. No es un error de los manifiestos. Se validaron contra el namespace `default`, que sí existe:

```bash
kubectl kustomize workloads/uptime-kuma | python3 -c "
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if d and d['kind'] != 'Namespace']
for d in docs: d['metadata']['namespace'] = 'default'
print(yaml.safe_dump_all(docs))" | kubectl apply --dry-run=server -f -
# → los 5 objetos: created (server dry run)
```

## 4.4 Problema: `CrashLoopBackOff` por una microSD falsificada

> Primer intento, sobre la microSD. Es el problema más importante del proyecto.

### Síntoma

Argo CD desplegó todo (`Synced`): PVC `Bound`, Service e Ingress creados. Pero el pod estaba en `CrashLoopBackOff`: el contenedor arranca, se cae y Kubernetes lo reinicia en bucle, esperando cada vez más.

### Diagnóstico

```bash
kubectl -n uptime-kuma get events --sort-by=.lastTimestamp     # qué ha pasado
kubectl -n uptime-kuma logs <pod> --previous                   # logs del intento que falló
```

```
/app/node_modules/@redis/client/dist/lib/commands/ACL_LOG_RESET.js:1
"use str��������
SyntaxError: Invalid or unexpected token
```

Un fichero **de la propia imagen** estaba corrupto: donde debería poner `"use strict"` había bytes basura.

1. **La imagen llegó bien:** containerd verifica la huella SHA-256 de cada capa al descargarla. Por tanto, el fichero se dañó **al grabarse en la tarjeta**.
2. **¿Lee mal o escribe mal?** Se leyó el fichero tres veces, vaciando la caché de RAM entre lecturas (`echo 3 > /proc/sys/vm/drop_caches`). El contenido dañado fue idéntico las tres veces, así que la tarjeta **escribe mal**.
3. **¿Lo detecta el kernel?** `dmesg` no mostraba ni un error de E/S. La corrupción era **silenciosa**.
4. **¿Hay más daños?** `sudo dpkg -V` se cortó con `control file 'md5sums' for package 'firmware-mediatek' is missing value`: **la base de datos de paquetes también estaba dañada**. Esto explica además el kernel dañado de [2.4](02-instalacion-k3s.md).
5. **Identidad de la tarjeta** (registro CID):
   ```bash
   cat /sys/block/mmcblk0/device/{name,manfid,oemid,date}
   # → NCard  0x000089  0x0303  10/2023
   ```
   - El fabricante `0x89` no corresponde a ningún fabricante conocido de memorias (SanDisk es `0x03`, Samsung `0x1b`, Kingston `0x41`).
   - En una tarjeta legítima, el OEM son dos letras legibles; aquí era `0x0303`.

### Conclusión

**microSD falsificada:** anuncia 64 GB pero tiene menos memoria real, y al escribir más allá de su capacidad real **machaca en silencio** datos ya existentes. Por eso los daños aparecían en ficheros al azar (módulos del kernel, una imagen de contenedor, la base de datos de `dpkg`).

### Solución

Cambiar a un **SSD por USB 3**, verificado antes de usarlo ([1.2](01-preparacion-pi.md)), y reinstalar. Gracias a GitOps, el clúster entero se reconstruyó desde Git en 82 segundos ([3.8](03-gitops-argocd.md)). En el SSD, **la misma imagen y los mismos manifiestos** arrancaron a la primera, con 0 reinicios: la configuración nunca fue el problema.

> **Lecciones:**
> - Un `CrashLoopBackOff` no siempre es un fallo de la aplicación o de la configuración: lee los logs del intento anterior (`--previous`) antes de cambiar nada.
> - Corrupción en ficheros que llegaron verificados = **problema de almacenamiento**.
> - Verifica el hardware nuevo antes de confiar en él: SMART + prueba de escritura y lectura.

## 4.5 Despliegue por GitOps

```bash
git add workloads/ apps/uptime-kuma.yaml
git commit -m "4.1 Uptime Kuma con almacenamiento persistente"
git push
# Opcional: que Argo CD mire el repo ya, sin esperar ~3 min
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=normal --overwrite
```

No se ejecuta ningún `kubectl apply` de la aplicación: Argo CD ve el fichero nuevo en `apps/`, crea la Application `uptime-kuma`, y esta despliega `workloads/uptime-kuma/`.

## 4.6 Verificación

### 4.6.1 De punta a punta

```bash
curl -I -H "Host: status.lab.home.arpa" http://192.168.0.27/              # → 302 /dashboard
curl -H "Host: status.lab.home.arpa" http://192.168.0.27/api/entry-page   # → {"type":"entryPage",...}
kubectl -n uptime-kuma logs deploy/uptime-kuma | grep -E "Version|SQLite"
# → Uptime Kuma Version: 2.5.11 · Using single connection for SQLite
```

### 4.6.2 Seguridad

```bash
kubectl -n uptime-kuma exec deploy/uptime-kuma -- id
# → uid=1000(node) gid=1000(node)

kubectl -n uptime-kuma run intruso --image=busybox:1.36 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"intruso","image":"busybox:1.36","securityContext":{"privileged":true}}]}}'
# → Error from server (Forbidden): pods "intruso" is forbidden: violates PodSecurity "restricted:latest":
#   privileged, allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile
```

El pod privilegiado se **rechaza**, y Kubernetes lista cada regla que incumple.

```bash
kubectl -n uptime-kuma describe resourcequota
```

| Recurso | Usado | Máximo |
|---|---|---|
| `requests.cpu` | 100m | 500m |
| `requests.memory` | 192 Mi | 512 Mi |
| `limits.cpu` | 1 | 2 |
| `limits.memory` | 512 Mi | 1 Gi |
| PVCs | 1 | 2 |

### 4.6.3 Persistencia

```bash
kubectl -n uptime-kuma exec <pod-1> -- sh -c 'date > /app/data/prueba-persistencia.txt; ls -li /app/data/kuma.db'
kubectl -n uptime-kuma delete pod <pod-1>
kubectl -n uptime-kuma exec <pod-2> -- sh -c 'cat /app/data/prueba-persistencia.txt; ls -li /app/data/kuma.db'
```

| | Pod | `prueba-persistencia.txt` | Inodo de `kuma.db` |
|---|---|---|---|
| Antes | `…-2cwd9` | escrito por `…-2cwd9` | `662011` |
| Después | `…-z48g8` (nuevo) | sigue ahí, "escrito por `…-2cwd9`" | `662011` (el **mismo fichero**) |

En la Pi, los datos están en `/var/lib/rancher/k3s/storage/pvc-…_uptime-kuma_uptime-kuma-data/` (`kuma.db`, `kuma.db-wal`…).

> Dos curiosidades:
> - **En la Pi los ficheros aparecen como de `admin`.** No es un error: el contenedor escribe con el UID 1000 y en la Pi el UID 1000 es el usuario `admin`. Linux guarda números, no nombres.
> - **En la Pi la hora es UTC y en el pod Europe/Madrid**, por la variable `TZ`.

### 4.6.4 Self-heal sobre la aplicación

```bash
kubectl -n uptime-kuma scale deploy uptime-kuma --replicas=0    # "error humano" simulado
kubectl -n uptime-kuma get deploy uptime-kuma                   # → vuelve a 1 réplica
```

Argo CD lo devolvió a 1 réplica en **1 segundo**, porque Git dice `replicas: 1`. Los datos siguieron intactos: están en el PVC, no en el pod.

### 4.6.5 Consumo

```bash
kubectl top pod -n uptime-kuma     # → 56m CPU, 106 Mi
kubectl top node                   # → todo el nodo: ~270m CPU, ~2 GiB (64 % de lo asignable)
```

## 4.7 Acceso

1. Añadir el nombre al ordenador (o un comodín `*.lab.home.arpa` en el DNS del router):
   ```bash
   echo "192.168.0.27  status.lab.home.arpa argocd.lab.home.arpa" | sudo tee -a /etc/hosts
   ```
2. Abrir http://status.lab.home.arpa y **crear el usuario administrador** en la primera pantalla. La primera persona que entre lo crea, así que conviene hacerlo nada más desplegar.

## Comandos útiles

| Comando | Para qué |
|---|---|
| `kubectl -n uptime-kuma get pods,pvc,svc,ingress` | Estado de todo |
| `kubectl -n uptime-kuma logs deploy/uptime-kuma -f` | Logs en directo |
| `kubectl -n uptime-kuma logs <pod> --previous` | Logs del contenedor que se cayó |
| `kubectl -n uptime-kuma get events --sort-by=.lastTimestamp` | Qué ha pasado, en orden |
| `kubectl -n uptime-kuma describe pod <pod>` | Detalle del pod; la sección Events del final es clave |
| `kubectl -n uptime-kuma rollout restart deploy uptime-kuma` | Reiniciar la aplicación |
