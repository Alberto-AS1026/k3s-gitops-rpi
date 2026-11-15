# 2. Instalación de K3s

Objetivo: tener un clúster Kubernetes de un nodo funcionando en la Pi, con Traefik recibiendo tráfico en los puertos 80/443 y `kubectl` operativo desde el ordenador de trabajo.

Fecha: 2026-11-13 (primer intento, en microSD) · 2026-11-15 (instalación definitiva, en SSD)

> En el SSD la instalación funcionó **a la primera y sin reinicios**: el problema 2.4 no se repitió y la corrección de 2.5 ya estaba en `bootstrap/traefik-config.yaml`.

## Resultado

| Elemento | Valor |
|---|---|
| K3s | `v1.37.2+k3s1` (versión fijada) |
| Nodo | `rpi-k3s`, `Ready`, rol `control-plane` |
| Runtime de contenedores | containerd 2.3.7 |
| Ingress Controller | Traefik 3.7.15 (chart 41.6.1), `hostPort` 80/443 |
| Almacenamiento | `local-path` (StorageClass por defecto) |
| Métricas | metrics-server (`kubectl top` funciona) |
| Recursos para pods | 3,5 CPU y 3,0 GiB de RAM (de 4 CPU y 3,7 GiB) |

## Conceptos básicos

- **Kubernetes:** sistema que ejecuta aplicaciones en contenedores y las mantiene en el estado que le pides. Ejemplo: "quiero 1 copia de esta web, con 256 MB de RAM como máximo". Si el contenedor se cae, lo vuelve a arrancar.
- **K3s:** una distribución de Kubernetes certificada y ligera, pensada para equipos pequeños como la Pi. Va en un solo binario de unos 70 MB e incluye de serie todo lo necesario: red, DNS, Ingress, almacenamiento y métricas.
- **Nodo:** cada máquina del clúster. Aquí solo hay uno, que hace de cerebro (`control-plane`) y de trabajador a la vez.
- **Pod:** la unidad mínima de Kubernetes, uno o varios contenedores que se ejecutan juntos.
- **kubectl:** la herramienta de línea de comandos para hablar con el clúster.

---

## 2.1 Elegir y fijar la versión

```bash
curl -s -o /dev/null -w '%{redirect_url}\n' https://update.k3s.io/v1-release/channels/stable
# → https://github.com/k3s-io/k3s/releases/tag/v1.37.2+k3s1
```

El canal `stable` apunta a la última versión estable. Se **fija** (`INSTALL_K3S_VERSION`) para que la instalación sea reproducible: si se repite dentro de seis meses, se obtiene exactamente lo mismo.

## 2.2 Ficheros de configuración (`bootstrap/`)

Se escriben en el proyecto, para que queden versionados en Git, y se copian a la Pi **antes** de instalar. Así K3s arranca ya configurado desde el primer momento.

### 2.2.1 `bootstrap/k3s-config.yaml` → `/etc/rancher/k3s/config.yaml`

K3s lee este fichero al arrancar. Cada clave equivale a un parámetro de la línea de comandos.

| Opción | Para qué |
|---|---|
| `write-kubeconfig-mode: "0600"` | El fichero con las credenciales de administrador (`k3s.yaml`) solo lo lee root. Con `0644`, cualquier usuario de la Pi sería administrador del clúster |
| `node-name: rpi-k3s` | Nombre del nodo dentro de Kubernetes |
| `disable: [servicelb]` | Quita el balanceador incluido (Klipper). Traefik escuchará directamente en los puertos de la Pi |
| `tls-san` | Nombres e IPs extra en el certificado del API server. Sin ellos, `kubectl` desde el portátil daría error de certificado al conectar por IP |
| `system-reserved` / `kube-reserved` | Aparta 250m de CPU y 256Mi de RAM para el sistema y otro tanto para K3s. Los pods no pueden usar esa parte |
| `eviction-hard` | Si quedan menos de 200Mi de RAM o menos del 10 % de disco, el kubelet expulsa pods antes de que el sistema se ahogue |

> **Permisos:** `config.yaml` se deja en `0644` (lectura para todos). `kubectl` en K3s es el mismo binario que `k3s` e intenta leer este fichero; con `0600` cada comando muestra el aviso `open /etc/rancher/k3s/config.yaml: permission denied`. No contiene secretos, así que no hay riesgo.

### 2.2.2 `bootstrap/traefik-config.yaml` → `/var/lib/rancher/k3s/server/manifests/`

- **Traefik** es el **Ingress Controller**: recibe todo el tráfico HTTP/HTTPS que llega a la Pi y lo reparte entre las aplicaciones según el dominio (`Host`).
- K3s instala Traefik con **Helm**, el "gestor de paquetes" de Kubernetes. Un *chart* es un paquete, con opciones configurables (`values`).
- Para cambiar esas opciones sin tocar el chart original, K3s ofrece el objeto `HelmChartConfig`.
- Todo YAML que se deje en `/var/lib/rancher/k3s/server/manifests/` lo aplica K3s automáticamente, y vuelve a aplicarlo si cambia.

Valores que se cambian y por qué:

| Valor | Por qué |
|---|---|
| `service.spec.type: ClusterIP` | Sin ServiceLB, un Service `LoadBalancer` se queda en `<pending>` para siempre |
| `ports.web.hostPort: 80`, `ports.websecure.hostPort: 443` | Traefik ocupa directamente los puertos 80/443 de la Pi. Es la forma de recibir tráfico sin balanceador |
| `providers.kubernetesIngress.ingressEndpoint.ip: 192.168.0.27` | Traefik escribe esta IP en el estado de cada Ingress (columna `ADDRESS`). Sin ella, Argo CD vería los Ingress como `Progressing` para siempre |
| `publishedService.enabled: false` | Desactiva el método por defecto, que copia la IP del Service de Traefik (que ya no tiene) |
| `updateStrategy` `maxUnavailable: 1`, `maxSurge: 0` | Con hostPort, dos pods de Traefik no pueden ocupar el puerto 80 a la vez. Primero se para el viejo y luego arranca el nuevo; si no, la actualización se queda bloqueada |
| `resources` | Límites de CPU y RAM para Traefik |

## 2.3 Instalar K3s

```bash
# En la Pi: descargar el instalador y revisarlo ANTES de ejecutarlo
curl -sfL https://get.k3s.io -o /tmp/k3s-install.sh
grep -n "verify_binary" /tmp/k3s-install.sh       # comprueba el SHA-256 del binario

sudo INSTALL_K3S_VERSION="v1.37.2+k3s1" sh /tmp/k3s-install.sh
```

El instalador:

1. Descarga el binario `k3s-arm64` y su `sha256sum` de GitHub, y verifica que coinciden.
2. Lo instala en `/usr/local/bin/k3s` y crea enlaces `kubectl`, `crictl` y `ctr`. Es el mismo programa con varios nombres.
3. Crea el servicio de systemd `k3s.service` (arranca solo al encender la Pi) y los scripts `k3s-killall.sh` y `k3s-uninstall.sh`.

> El aviso `Host iptables-save/iptables-restore tools not found` es normal: Debian 13 no trae esas herramientas y K3s usa su propia copia.

## 2.4 Problema 1: kube-proxy no arranca (kernel dañado)

> Ocurrió en el primer intento, sobre la microSD.

### Síntoma

K3s arrancaba y se paraba a los pocos segundos. `kubectl` daba `connection refused` en el puerto 6443. En el registro:

```bash
sudo journalctl -u k3s -n 400 | grep -iE "level=(error|fatal)"
```

```
kube-proxy exited: iptables is not available on this host :
  iptables: Failed to initialize nft: Protocol not supported
```

### Explicación

- **kube-proxy** crea las reglas de red que hacen funcionar los Services de Kubernetes.
- Esas reglas las escribe con **iptables**, que en sistemas modernos funciona sobre **nftables**, el cortafuegos del kernel.
- `Protocol not supported` significa que el kernel no tenía cargado el soporte de nftables.

### Diagnóstico paso a paso

1. **¿Existen los módulos?**
   `zcat /proc/config.gz | grep NF_TABLES` → `CONFIG_NF_TABLES=m`. El soporte existe como **módulo**: un "plugin" del kernel que está en disco y se carga cuando hace falta.
2. **¿Se pueden cargar?**
   `sudo modprobe nf_tables` falló con `No such file or directory` y `xz: File is corrupt`. Faltaban ficheros y otros estaban dañados.
3. **¿De qué paquete son y cuánto daño hay?**
   ```bash
   dpkg -S /usr/lib/modules/$(uname -r)/kernel/net/netfilter/nft_masq.ko.xz
   # → linux-image-6.18.60+rpt-rpi-v8
   sudo dpkg -V linux-image-6.18.60+rpt-rpi-v8
   # → 64 ficheros "missing" y 45 con MD5 distinto ("??5??????")
   ```
   - `dpkg -V` compara cada fichero instalado con la huella que guardó el paquete al instalarse.
   - En Debian 13, `/lib` es un enlace a `/usr/lib` (*usrmerge*), y los paquetes registran sus ficheros con la ruta `/usr/lib/...`. Con `/lib/...`, `dpkg -S` no los encuentra.
4. **¿Es la tarjeta SD o fue una instalación interrumpida?**
   - Se repitió la verificación dos veces y dio el mismo resultado: la lectura es estable.
   - `dmesg` no mostraba errores de la SD ni de ext4.
   - Los demás paquetes probados estaban intactos; solo fallaba el kernel instalado el día anterior.
   - Conclusión **provisional**: actualización del kernel interrumpida.
5. **Conclusión definitiva (días después):** al desplegar Uptime Kuma apareció otro fichero corrupto, esta vez en una imagen de contenedor descargada y verificada. La causa real era la **microSD falsificada**, que corrompía datos al escribirlos (ver [4.4](04-aplicacion-uptime-kuma.md)). La lectura era estable porque el dato se *grababa* mal.

### Solución

```bash
sudo systemctl stop k3s
sudo apt-get install --reinstall -y linux-image-6.18.60+rpt-rpi-v8 linux-image-6.18.60+rpt-rpi-2712
sudo dpkg -V linux-image-6.18.60+rpt-rpi-v8      # → 0 problemas
sudo depmod -a
sudo modprobe nf_tables br_netfilter nf_conntrack nf_nat   # → todos cargan
sudo reboot
```

La reinstalación solo arregló el síntoma: la tarjeta siguió corrompiendo otros ficheros.

> **Lecciones:**
> - Ante un error "imposible", verifica la integridad de los paquetes con `dpkg -V`.
> - Si aparece corrupción de datos, sospecha primero del **hardware de almacenamiento**, aunque el kernel no registre errores.
> - Una conclusión provisional hay que revisarla en cuanto aparecen pruebas nuevas.

## 2.5 Problema 2: el Service de Traefik seguía en `<pending>`

### Síntoma

```
traefik   LoadBalancer   10.43.69.36   <pending>   80:31227/TCP,443:30766/TCP
```

El `hostPort` sí se aplicó, pero el tipo de Service no.

### Causa

En la versión 41 del chart de Traefik la opción se llama **`service.spec.type`**; antes era `service.type`. Helm **ignora sin avisar** las opciones que no existen. Se comprobó leyendo el `values.yaml` de la versión exacta que trae K3s:

```bash
sudo tar -xzf /var/lib/rancher/k3s/server/static/charts/traefik-41.6.101+up41.6.1.tgz traefik/values.yaml
```

### Solución

Corregir `traefik-config.yaml`, añadir `ingressEndpoint.ip` y volver a copiarlo a `manifests/`. K3s detecta el cambio y relanza la instalación de Traefik. La actualización se completó sin bloquearse gracias a `maxSurge: 0`.

> **Lección:** fija versiones y consulta la documentación **de esa versión exacta**. Las opciones de los charts cambian entre versiones.

## 2.6 Prueba de punta a punta

Se desplegó una app de prueba (`traefik/whoami`) con su Service e Ingress para `whoami.lab.home.arpa`, y se llamó desde el ordenador:

```bash
curl -H "Host: whoami.lab.home.arpa" http://192.168.0.27/
```

La respuesta muestra cada salto del camino:

| Cabecera / campo | Valor | Significado |
|---|---|---|
| `X-Real-Ip` | `192.168.0.26` | La petición salió del ordenador |
| `X-Forwarded-Server` | `traefik-…` | Pasó por Traefik |
| `RemoteAddr` | `10.42.0.10` | Traefik (IP interna de su pod) la reenvió… |
| `Hostname` / `IP` | `whoami-…` / `10.42.0.11` | …al pod de la aplicación, que respondió |

Sin la cabecera `Host`, Traefik responde **404**, que es lo correcto: no hay ninguna regla para esa petición. La prueba se borró después (`kubectl delete namespace prueba`).

## 2.7 `kubectl` para el usuario `admin` (en la Pi)

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u):$(id -g)" ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=$HOME/.kube/config' >> ~/.bashrc
```

- El **kubeconfig** contiene la dirección del clúster y un certificado de **administrador total**. Se copia al usuario `admin` con permisos `600` (solo él puede leerlo).
- La variable `KUBECONFIG` le dice a `kubectl` dónde está. Sin ella, el `kubectl` de K3s intenta leer `/etc/rancher/k3s/k3s.yaml`, que es solo de root.

## 2.8 `kubectl` en el ordenador de trabajo

```bash
# Instalar kubectl (misma versión que el clúster), verificando su huella
curl -LO https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl
curl -LO https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl.sha256
echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check
install -m 0755 kubectl ~/.local/bin/kubectl

# Traer el kubeconfig, apuntarlo a la IP de la Pi y renombrar el contexto
mkdir -p ~/.kube && chmod 700 ~/.kube
ssh rpi-k3s 'cat ~/.kube/config' \
  | sed -e 's#https://127.0.0.1:6443#https://192.168.0.27:6443#' -e 's#\bdefault\b#rpi-k3s#g' \
  > ~/.kube/config
chmod 600 ~/.kube/config
kubectl get nodes
```

- En la Pi, el kubeconfig apunta a `127.0.0.1` ("yo mismo"). Desde el ordenador hay que cambiarlo a la IP de la Pi.
- Funciona sin errores de certificado porque `192.168.0.27` está en `tls-san`.
- El contexto `default` se renombra a `rpi-k3s` para saber siempre a qué clúster hablas.
- ⚠️ **Este fichero nunca se sube a Git:** da control total del clúster.

## Comprobaciones finales

```bash
kubectl get nodes -o wide       # rpi-k3s Ready, v1.37.2+k3s1
kubectl get pods -A             # coredns, local-path-provisioner, metrics-server, traefik: Running
kubectl get svc -n kube-system traefik     # ClusterIP (sin <pending>)
kubectl top node                # ~400m CPU, ~1,1 GiB RAM en reposo
kubectl get node rpi-k3s -o jsonpath='{.status.allocatable}'
```

| Recurso | Capacidad | Asignable a pods | Reservado |
|---|---|---|---|
| CPU | 4 | 3,5 | 0,5 (250m sistema + 250m K3s) |
| RAM | 3,71 GiB | 3,01 GiB | 712 MiB (256 + 256 + 200 de margen) |

## Comandos útiles

| Comando | Para qué |
|---|---|
| `sudo systemctl status k3s` | Estado del servicio |
| `sudo journalctl -u k3s -f` | Registro de K3s en directo |
| `sudo k3s check-config` | Comprueba que el kernel tiene lo que K3s necesita |
| `/usr/local/bin/k3s-killall.sh` | Para K3s y todos los contenedores |
| `/usr/local/bin/k3s-uninstall.sh` | Desinstala K3s por completo (**borra el clúster**) |
