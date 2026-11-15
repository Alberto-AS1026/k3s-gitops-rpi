# 3. GitOps con Argo CD

Objetivo: que el clúster se gestione desde este repositorio de GitHub. Un commit cambia lo que corre en la Pi, y cualquier cambio hecho a mano en el clúster se revierte solo.

Fecha: 2026-11-13 · reconstrucción en SSD: 2026-11-15

## Resultado

| Elemento | Valor |
|---|---|
| Argo CD | `v3.6.1`, namespace `argocd` |
| Repositorio | https://github.com/Alberto-AS1026/k3s-gitops-rpi (público) |
| Patrón | *app-of-apps*: `root` → `apps/` → una Application por fichero |
| Sincronización | Automática, con `prune` y `selfHeal` |
| Interfaz web | http://argocd.lab.home.arpa (vía Traefik) |
| Consumo | ~277 MiB de RAM y ~45m de CPU en reposo |

## Conceptos básicos

- **GitOps:** forma de operar en la que **Git es la única fuente de verdad**. No se hacen `kubectl apply` a mano: se cambia un fichero, se hace commit, y un agente dentro del clúster aplica la diferencia.
  - Ventajas: historial de quién cambió qué y cuándo, marcha atrás con `git revert`, y el clúster se puede reconstruir desde cero con el repo.
- **Modelo *pull*:** Argo CD, que vive **dentro** del clúster, consulta GitHub cada ~3 minutos. GitHub nunca entra en la Pi, así que no hace falta abrir puertos a Internet.
- **Application:** objeto de Argo CD que dice "lo que hay en esta carpeta de este repo tiene que estar desplegado en este namespace".
- **Sync status:**
  - `Synced`: el clúster coincide con Git.
  - `OutOfSync`: hay diferencias.
- **Health status:**
  - `Healthy`: los objetos funcionan.
  - `Progressing`: se están creando.
  - `Degraded`: algo falla.
- **`prune`:** si borras un fichero de Git, Argo CD borra ese objeto del clúster.
- **`selfHeal`:** si alguien modifica o borra algo en el clúster a mano, Argo CD lo devuelve al estado de Git.

## 3.1 Repositorio en GitHub

```bash
cd k3s-gitops-rpi
git init -b main
git add … && git commit …
gh repo create k3s-gitops-rpi --public --source . --remote origin --push
gh repo edit --add-topic kubernetes,k3s,gitops,argocd,traefik,raspberry-pi,homelab,devops,sysadmin
```

- **Público:** Argo CD lo lee sin credenciales, y sirve como portafolio.
- **`.gitignore`:** excluye kubeconfigs, claves y ficheros `secret*.yaml`. **En un repo público nunca se suben secretos.**
- Antes de publicar se revisó la documentación en busca de contraseñas y datos personales (`grep -rniE "password|token|secret…"`).
- Los commits siguen la misma numeración que la documentación (`1.`, `2.`, `3.1`…).

## 3.2 Instalación de Argo CD

```bash
curl -sSfL https://raw.githubusercontent.com/argoproj/argo-cd/v3.6.1/manifests/install.yaml -o install.yaml
grep -E "^\s+image:" install.yaml | sort | uniq -c     # revisar qué imágenes se van a ejecutar
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts -f install.yaml
```

- **Versión fijada** (`v3.6.1`), no `stable`, para que la instalación sea reproducible.
- Se **revisa el manifiesto antes de aplicarlo**: 3 imágenes (argocd, redis, dex), 6 Deployments, 1 StatefulSet, RBAC y 7 NetworkPolicies.
- La imagen `quay.io/argoproj/argocd` es multi-arquitectura (`manifest_list: true`), así que funciona en arm64.
- **`--server-side`:** los CRD de Argo CD son tan grandes que el `apply` normal falla con `metadata.annotations: Too long`, porque intenta guardar una copia del objeto en una anotación de 256 KB como máximo. Con *server-side apply*, el servidor lleva el control de los cambios y no necesita esa anotación.

### Componentes

| Componente | Función |
|---|---|
| `argocd-application-controller` | El "cerebro": compara Git con el clúster y aplica las diferencias |
| `argocd-repo-server` | Descarga el repositorio y genera los manifiestos finales |
| `argocd-server` | API e interfaz web |
| `argocd-redis` | Caché |
| `argocd-applicationset-controller` | Genera Applications a partir de plantillas (no se usa todavía) |
| `argocd-notifications-controller` | Avisos (Slack, correo…) (no se usa todavía) |
| `argocd-dex-server` | Inicio de sesión SSO → **desactivado** |

## 3.3 Ajustes para la Raspberry Pi

```bash
# Interfaz por HTTP dentro del clúster: Traefik es la puerta de entrada
kubectl -n argocd patch configmap argocd-cmd-params-cm --type merge \
  -p '{"data":{"server.insecure":"true"}}'
kubectl -n argocd rollout restart deploy argocd-server

# Sin SSO: Dex no hace falta
kubectl -n argocd scale deploy argocd-dex-server --replicas=0
```

- **`server.insecure`:** por defecto `argocd-server` redirige todo a HTTPS con un certificado propio. Detrás de Traefik eso provoca un bucle de redirecciones. Con `insecure`, Argo CD habla HTTP y el cifrado, si se quiere, se pone en Traefik.
- **Dex:** permite iniciar sesión con Google, GitHub, etc. En un laboratorio basta con el usuario `admin` local, y así se ahorra RAM.

## 3.4 Estructura GitOps (app-of-apps)

```
bootstrap/root-app.yaml        ← se aplica a mano UNA vez
        │ vigila
        ▼
apps/                          ← una Application por fichero
└── platform.yaml ──vigila──▶  platform/
                               └── argocd-ingress.yaml
```

### `bootstrap/root-app.yaml`

Application `root`: apunta a la carpeta `apps/` de la rama `main`.

- `finalizers: resources-finalizer.argocd.argoproj.io`: si se borra la Application, Argo CD borra también todo lo que creó. Sin él, los objetos se quedarían "huérfanos" en el clúster.
- `syncPolicy.automated` con `prune: true` y `selfHeal: true`.

> Al aplicarla, Kubernetes avisa: `prefer a domain-qualified finalizer name including a path`. Es una recomendación genérica; el nombre es el oficial de Argo CD y funciona correctamente.

### `apps/platform.yaml`

Application `platform`: apunta a `platform/`, la configuración del propio clúster. Añade `retry` con espera creciente (10 s, 20 s, 40 s… hasta 3 min), por si algo falla de forma temporal.

### `platform/argocd-ingress.yaml`

Ingress de Traefik: `argocd.lab.home.arpa` → Service `argocd-server`, puerto 80.

### Validación antes de subir

```bash
kubectl apply --dry-run=server -f bootstrap/root-app.yaml -f apps/platform.yaml -f platform/argocd-ingress.yaml
```

`--dry-run=server` envía los objetos a la API, que los valida contra los tipos reales (incluidos los CRD de Argo CD), pero **no crea nada**.

## 3.5 Arranque del GitOps

```bash
git push                                   # Argo CD lee de GitHub: primero hay que subir
kubectl apply -f bootstrap/root-app.yaml   # el ÚNICO apply manual
kubectl -n argocd get applications
```

```
NAME       SYNC STATUS   HEALTH STATUS
platform   Synced        Healthy
root       Synced        Healthy
```

En ~15 segundos Argo CD leyó el repo, creó la Application `platform`, y esta creó el Ingress. El Ingress aparece con `ADDRESS 192.168.0.27` gracias al `ingressEndpoint` configurado en Traefik ([2.5](02-instalacion-k3s.md)). Sin él, `platform` se habría quedado en `Progressing` para siempre.

## 3.6 Prueba de self-heal

```bash
kubectl -n argocd delete ingress argocd-server     # "error humano" simulado
kubectl -n argocd get ingress argocd-server        # vuelve a existir
```

| | UID del Ingress | Creado |
|---|---|---|
| Antes | `9cff648d-…` | 23:37:21 |
| Después | `4414cb1d-…` | 23:37:38 |

Argo CD lo recreó en **1 segundo**. El UID nuevo demuestra que es un objeto distinto, creado de nuevo a partir de Git.

> Es una buena demo para una entrevista: modifica algo a mano (`kubectl scale`, `kubectl delete`…) y enseña cómo el clúster vuelve solo al estado declarado en Git.

## 3.7 Acceso a la interfaz web

1. **DNS:** el ordenador tiene que saber que `argocd.lab.home.arpa` es la Pi. Lo más rápido es `/etc/hosts`, la "agenda" local de nombres, que se consulta antes que el DNS:
   ```bash
   echo "192.168.0.27  argocd.lab.home.arpa" | sudo tee -a /etc/hosts
   ```
   Para toda la red, lo ideal es un registro comodín `*.lab.home.arpa → 192.168.0.27` en el DNS del router o en Pi-hole.
   > Se usa `home.arpa` porque es el dominio reservado para redes domésticas (RFC 8375). `.local` choca con mDNS.
2. **Contraseña inicial** del usuario `admin` de Argo CD (la genera Argo CD al instalarse):
   ```bash
   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
   ```
3. Abrir http://argocd.lab.home.arpa, entrar como `admin`, **cambiar la contraseña** (User Info → Update Password) y borrar el secreto inicial:
   ```bash
   kubectl -n argocd delete secret argocd-initial-admin-secret
   ```

También se puede cambiar la contraseña sin navegador, con la API de Argo CD:

```bash
API=http://192.168.0.27/api/v1; H="Host: argocd.lab.home.arpa"
INIT=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)
NEW=$(python3 -c 'import secrets; print(secrets.token_urlsafe(16))')
TOKEN=$(curl -s -H "$H" -X POST $API/session -d "{\"username\":\"admin\",\"password\":\"$INIT\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
curl -s -H "$H" -H "Authorization: Bearer $TOKEN" -X PUT $API/account/password \
  -d "{\"name\":\"admin\",\"currentPassword\":\"$INIT\",\"newPassword\":\"$NEW\"}"
kubectl -n argocd delete secret argocd-initial-admin-secret
```

1. `POST /session` entrega un **token** (un pase temporal) a cambio de usuario y contraseña.
2. `PUT /account/password` cambia la contraseña presentando ese token.
3. Comprobación: la contraseña nueva da `200` y la inicial, `401` (no autorizado).

Comprobación sin navegador:

```bash
curl -H "Host: argocd.lab.home.arpa" http://192.168.0.27/api/version    # → "Version":"v3.6.1"
```

## 3.8 Reconstrucción del clúster desde Git

Tras cambiar la microSD falsificada por un SSD (ver [4.4](04-aplicacion-uptime-kuma.md)), el clúster se reinstaló desde cero. Con el repositorio ya completo en GitHub, bastó con:

```bash
# 1. Instalar K3s con los ficheros de bootstrap/ (ver 2.)
# 2. Instalar Argo CD y aplicar los ajustes de 3.3
# 3. Arrancar el GitOps:
kubectl apply -f bootstrap/root-app.yaml
```

| Tiempo desde `kubectl apply` | Estado |
|---|---|
| 0 s | Solo existe la Application `root` |
| **82 s** | `root`, `platform` y `uptime-kuma` en `Synced/Healthy`, con Uptime Kuma funcionando, su disco persistente y su Ingress |

Ningún manifiesto se volvió a escribir ni a aplicar a mano: Argo CD lo recreó todo a partir de Git. Esa es la ventaja principal de GitOps: **el repositorio es el clúster**. Si la Pi se rompe, se reconstruye igual en minutos.

> En el SSD, Argo CD tardó 73 s en estar listo, frente a unos 3 minutos en la microSD: la descarga y descompresión de imágenes depende mucho de la velocidad del disco.

## Consumo de recursos

```bash
kubectl top pods -n argocd --sort-by=memory
```

| Pod | CPU | RAM |
|---|---|---|
| application-controller | 23m | 160 Mi |
| server | 6m | 40 Mi |
| repo-server | 2m | 28 Mi |
| notifications-controller | 3m | 22 Mi |
| applicationset-controller | 3m | 21 Mi |
| redis | 7m | 6 Mi |
| **Total** | **~45m** | **~277 Mi** |

El nodo completo, con K3s, Traefik y Argo CD, usa el 55 % de la memoria asignable.

## Cómo añadir una aplicación nueva

1. Crear sus manifiestos en una carpeta, por ejemplo `workloads/mi-app/`.
2. Crear `apps/mi-app.yaml`: una Application que apunte a esa carpeta (copiando `apps/platform.yaml`).
3. `git commit` y `git push`.
4. En ≤ 3 minutos aparece en el clúster. Para no esperar: botón **Refresh** en la interfaz, o
   `kubectl -n argocd annotate application root argocd.argoproj.io/refresh=normal --overwrite`.

## Comandos útiles

| Comando | Para qué |
|---|---|
| `kubectl -n argocd get applications` | Estado de sync y health de todas las aplicaciones |
| `kubectl -n argocd describe application <app>` | Detalle: recursos, errores, último sync |
| `kubectl -n argocd logs statefulset/argocd-application-controller` | Registro del "cerebro" de Argo CD |
| `kubectl -n argocd logs deploy/argocd-repo-server` | Errores al leer el repo o generar manifiestos |
