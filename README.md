<div align="center">

# K3s + GitOps en Raspberry Pi

**Clúster Kubernetes ligero en una Raspberry Pi 4, gestionado con Argo CD.**
Un commit en este repositorio basta para cambiar lo que corre en el clúster.

![Raspberry Pi 4](https://img.shields.io/badge/Raspberry_Pi_4-4GB-A22846?logo=raspberrypi&logoColor=white)
![Debian 13](https://img.shields.io/badge/Debian-13-A81D33?logo=debian&logoColor=white)
![K3s](https://img.shields.io/badge/K3s-v1.37.2-FFC61C?logo=k3s&logoColor=black)
![Traefik](https://img.shields.io/badge/Traefik-3.7-24A1C1?logo=traefikproxy&logoColor=white)
![Argo CD](https://img.shields.io/badge/Argo_CD-v3.6.1-EF7B4D?logo=argo&logoColor=white)

</div>

## Qué es

Un laboratorio para administrar un clúster Kubernetes con prácticas de producción sobre hardware limitado:

- **K3s** instalado y ajustado a mano en una Raspberry Pi 4.
- **Traefik** para publicar las aplicaciones por dominio.
- **Argo CD** para desplegar todo desde Git (GitOps).
- **Uptime Kuma** para vigilar el propio clúster, con una página de estado pública.

## Arquitectura

```mermaid
flowchart LR
    U["Cliente"] -- "*.lab.home.arpa" --> T
    subgraph P["Raspberry Pi 4"]
        T["Traefik<br/>:80 / :443"] --> S["Service"] --> D["Pod"]
        A["Argo CD"] -- "aplica" --> S
        K["Uptime Kuma"] -. "vigila" .-> T
        K -. "vigila" .-> A
    end
    G["GitHub"] -- "sincroniza" --> A
```

## Stack

| Capa | Tecnología |
|---|---|
| Hardware | Raspberry Pi 4 Model B (4 GB) + SSD por USB 3 |
| Sistema | Raspberry Pi OS 64-bit (Debian 13) |
| Kubernetes | K3s v1.37.2 |
| Ingress | Traefik 3.7 |
| GitOps | Argo CD v3.6.1 |
| Aplicación de ejemplo | Uptime Kuma 2.5 con disco persistente |
| Monitorización | metrics-server (`kubectl top`) y Uptime Kuma |

## Documentación

1. [Preparación de la Raspberry Pi](docs/01-preparacion-pi.md)
2. [Instalación de K3s](docs/02-instalacion-k3s.md)
3. [GitOps con Argo CD](docs/03-gitops-argocd.md)
4. [Aplicación de ejemplo: Uptime Kuma](docs/04-aplicacion-uptime-kuma.md)
5. [Monitorización y troubleshooting](docs/05-monitorizacion-troubleshooting.md)

## Estructura

```
k3s-gitops-rpi/
├── bootstrap/   # configuración inicial, se aplica a mano una vez
├── apps/        # aplicaciones de Argo CD (una por fichero)
├── platform/    # configuración del clúster gestionada por Argo CD
├── workloads/   # manifiestos de las aplicaciones
├── scripts/     # utilidades: prueba del disco y monitores de Uptime Kuma
└── docs/        # documentación paso a paso
```

## Puesta en marcha

```bash
# 1. Instalar K3s (con los ficheros de bootstrap/ ya copiados en la Pi)
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.37.2+k3s1" sh -

# 2. Instalar Argo CD
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.6.1/manifests/install.yaml

# 3. Arrancar el GitOps
kubectl apply -f bootstrap/root-app.yaml

# 4. Crear los monitores de Uptime Kuma (ver docs/05, apartado 5.6)
TOKEN=$(kubectl -n uptime-kuma get secret monitor-api-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n uptime-kuma exec -i deploy/uptime-kuma -- node - "<contraseña de admin>" "$TOKEN" < scripts/uptime-kuma-monitores.js
```
