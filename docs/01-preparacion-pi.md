# 1. Preparación de la Raspberry Pi

Objetivo: dejar la Raspberry Pi lista para instalar Kubernetes (K3s): disco verificado, acceso seguro, sistema actualizado y kernel configurado.

Fecha: 2026-11-15

## Punto de partida

| Elemento | Valor |
|---|---|
| Placa | Raspberry Pi 4 Model B Rev 1.5, 4 núcleos, 4 GB de RAM (3,7 GiB útiles) |
| Sistema | Raspberry Pi OS 64-bit basado en Debian 13 "trixie", kernel 6.18 `aarch64` |
| Disco | **SSD Intenso de 2 TB por USB 3** (`/dev/sda`), la Pi arranca desde él |
| Red | Cable (`eth0`), IP `192.168.0.27` por DHCP; router `192.168.0.1` |
| Usuario | `admin` (creado con Raspberry Pi Imager) |
| Ordenador de trabajo | `192.168.0.26` (red `192.168.0.0/24`) |

> **¿Por qué un SSD?** El primer intento se hizo en una microSD de 64 GB que resultó ser **falsificada**: corrompía ficheros en silencio (ver [4.4](04-aplicacion-uptime-kuma.md)). Además, K3s escribe en disco sin parar (su base de datos SQLite) y las tarjetas SD se desgastan con ese uso. Un SSD por USB 3 es más fiable y bastante más rápido.

---

## 1.1 Encontrar la Pi y activar SSH

```bash
ip -4 -brief addr                     # qué IP y red tiene mi ordenador
nmap -p 22 --open 192.168.0.0/24      # qué equipos tienen SSH abierto
ip neigh | grep d8:3a:dd              # buscar la Pi por su MAC
```

- `ip -4 -brief addr` muestra que el ordenador está en `192.168.0.26/24`. El `/24` significa que la red local va de `192.168.0.1` a `192.168.0.254`.
- `nmap` es un escáner de red. Con `-p 22 --open` pregunta a todas las direcciones si tienen abierto el **puerto 22**, el de **SSH** (el servicio para controlar un equipo por terminal a distancia).
- La **MAC** es el identificador físico de una tarjeta de red. Sus tres primeros bloques indican el fabricante: `d8:3a:dd` es Raspberry Pi.

**Problema:** la Pi respondía al `ping` en `192.168.0.27`, pero el puerto 22 daba `Connection refused`, es decir, ningún programa escuchaba en él. Raspberry Pi OS trae **SSH desactivado** salvo que se active al grabar la imagen. Se activó desde la propia Pi, con teclado y pantalla:

```bash
sudo systemctl enable --now ssh    # enable: arranca en cada inicio · --now: arranca ya
```

Alternativa: en Raspberry Pi Imager → "Editar ajustes" → "Servicios" → "Activar SSH".

## 1.2 Comprobar que el disco es fiable

Antes de instalar nada se comprueba el disco. Los SSD de mucha capacidad y bajo precio son de los productos más falsificados: anuncian 2 TB y tienen 64 o 128 GB reales. Lo que se escribe "de más" se pierde o machaca otros datos **sin dar ningún error**.

### 1.2.1 Identidad y salud (SMART)

```bash
sudo apt-get install -y smartmontools
lsusb                          # → VIA Labs TX100 (la caja USB)
sudo smartctl -i -H -A /dev/sda
```

- **SMART** es la "autoevaluación" que lleva todo disco: modelo, horas de uso, sectores dañados, temperatura…
- Resultado: SSD SATA real (`INTENSO SSD`, firmware `W0814A0`, 2,04 TB), salud `PASSED`, 0 sectores reasignados, 104 horas de uso, 38 °C.
- Las falsificaciones suelen dar datos SMART vacíos o absurdos. Pero SMART lo informa el propio disco y un controlador falso puede mentir, así que hace falta una prueba real.

### 1.2.2 Prueba de capacidad real por muestreo

La comprobación definitiva es **escribir datos por todo el disco y comprobar que se leen igual**. Llenar 2 TB tardaría horas, así que se hace por muestreo (la misma idea que la herramienta `f3`):

1. Se reserva casi todo el espacio libre en un fichero con `fallocate`. Es instantáneo: no escribe datos, solo aparta el espacio, que llega hasta el final físico del disco.
2. Se escriben **512 bloques de 4 MiB con contenido único** repartidos por todo el fichero. Se usa escritura directa (`O_DIRECT`), sin pasar por la caché de RAM.
3. Se vacía la caché y se **releen los 512 bloques**, comparando su huella SHA-256.

```bash
F=/var/tmp/prueba-capacidad.bin
SZ=$(( $(df -B1 --output=avail / | tail -1) - 20*1024**3 ))    # libre menos 20 GB
sudo fallocate -l $SZ $F
sudo filefrag -v $F | tail -3          # zona física que ocupa: de 11 GB a 2043 GB
sudo python3 -I scripts/prueba-disco.py $F 512
sudo rm $F && sudo fstrim -v /         # fstrim: avisa al SSD de que ese espacio vuelve a estar libre
```

El script está en [`scripts/prueba-disco.py`](../scripts/prueba-disco.py) (comentado paso a paso).

Resultado: **0 bloques erróneos de 512**, hasta los 1904 GB del fichero (2043 GB físicos), en 47 segundos. El disco tiene la capacidad real que anuncia.

> Es segura para el sistema: todo ocurre dentro de un fichero, que en un disco legítimo no puede tocar otros datos.

### 1.2.3 Integridad del sistema instalado

```bash
sudo dpkg -V
```

`dpkg -V` compara cada fichero instalado con la huella que guardó su paquete. Resultado: 0 errores, 0 ficheros perdidos; solo aparecen ficheros de configuración que la propia Raspberry Pi OS personaliza. En la microSD falsa, este mismo comando mostró decenas de ficheros dañados.

## 1.3 Acceso por clave SSH

### 1.3.1 Crear una clave solo para este proyecto (en el ordenador)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/rpi_k3s -N "" -C "rpi-k3s-cluster"
```

Una **clave SSH** es un par de ficheros:

- `~/.ssh/rpi_k3s` → **clave privada**. Nunca sale del ordenador. Es la llave.
- `~/.ssh/rpi_k3s.pub` → **clave pública**. Se copia a la Pi. Es la cerradura.

Al conectar, la Pi comprueba que tienes la llave que abre su cerradura. Detalles de las opciones:

- `-t ed25519` usa el tipo de clave moderno: corto, rápido y seguro.
- `-N ""` crea la clave sin frase de paso, para poder automatizar comandos. A cambio, quien copie ese fichero podría entrar en la Pi; en un laboratorio casero es aceptable.

### 1.3.2 Alias en `~/.ssh/config` (en el ordenador)

```
Host rpi-k3s
    HostName 192.168.0.27
    User admin
    IdentityFile ~/.ssh/rpi_k3s
    IdentitiesOnly yes
```

Con esto, `ssh rpi-k3s` equivale a `ssh -i ~/.ssh/rpi_k3s admin@192.168.0.27`. `IdentitiesOnly yes` hace que SSH use solo esa clave y no pruebe las de otros proyectos.

### 1.3.3 Copiar la clave pública a la Pi

```bash
ssh-keygen -R 192.168.0.27                 # borrar la huella de la instalación anterior
ssh-copy-id -i ~/.ssh/rpi_k3s.pub rpi-k3s
```

- **Huella del servidor (*host key*):** la primera vez que te conectas, SSH guarda en `~/.ssh/known_hosts` la "huella" de la Pi. Si cambia, bloquea la conexión con `REMOTE HOST IDENTIFICATION HAS CHANGED`, por si alguien se hace pasar por ella. Al reinstalar el sistema la huella es nueva, así que se borra la antigua con `ssh-keygen -R`.
- `ssh-copy-id` entra con la contraseña y añade la clave pública a `~/.ssh/authorized_keys` de la Pi.

> **Problema encontrado:** al lanzarlo desde Claude Code con `!` no hay terminal interactiva, así que SSH no puede pedir la contraseña e intenta usar `ssh-askpass`, un programa gráfico que no está instalado. **Solución:** ejecutarlo en una terminal normal, o usar un script temporal de `SSH_ASKPASS` que entregue la contraseña y borrarlo justo después.

Comprobación: `ssh rpi-k3s whoami` → `admin`, sin pedir contraseña.

## 1.4 Endurecer el acceso

### 1.4.1 `sudo` sin contraseña para `admin`

```bash
echo "admin ALL=(ALL) NOPASSWD: ALL" > /tmp/090_admin-nopasswd
sudo visudo -cf /tmp/090_admin-nopasswd          # valida la sintaxis
sudo install -m 0440 -o root -g root /tmp/090_admin-nopasswd /etc/sudoers.d/090_admin-nopasswd
```

- `sudo` permite ejecutar comandos como administrador (root). Los ficheros de `/etc/sudoers.d/` definen quién puede usarlo y cómo.
- **Siempre se valida con `visudo -c` antes de instalar el fichero.** Un error de sintaxis en sudoers puede dejarte sin `sudo` y sin forma de arreglarlo por SSH.
- `0440` deja el fichero solo de lectura para root; `sudo` exige esos permisos.

> **Detalle de Raspberry Pi OS:** en el primer arranque, `sudo` funciona sin contraseña, pero ese permiso es temporal y desaparece tras el primer reinicio. Por eso se crea un fichero propio.

### 1.4.2 SSH: clave y contraseña

Fichero `/etc/ssh/sshd_config.d/10-hardening.conf`:

```
PasswordAuthentication yes
PubkeyAuthentication yes
PermitRootLogin no
MaxAuthTries 3
X11Forwarding no
```

| Línea | Qué hace |
|---|---|
| `PasswordAuthentication yes` | Se mantiene la entrada con contraseña, para poder conectar desde cualquier equipo con `ssh admin@192.168.0.27` |
| `PubkeyAuthentication yes` | Entrada con clave (la que se usa para la administración automatizada) |
| `PermitRootLogin no` | Prohíbe entrar directamente como root |
| `MaxAuthTries 3` | Máximo 3 intentos de contraseña por conexión; frena los ataques de adivinar contraseñas |
| `X11Forwarding no` | Desactiva el reenvío de ventanas gráficas, que no se necesita |

```bash
sudo sshd -t                 # comprueba la sintaxis antes de aplicar
sudo systemctl reload ssh    # aplica sin cortar las sesiones abiertas
sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin|maxauthtries) "   # configuración efectiva
```

- Se usa un fichero en `sshd_config.d/` en lugar de editar `sshd_config`: se ve de un vistazo qué se ha cambiado y las actualizaciones del sistema no lo pisan.
- **Contraseña:** con el acceso por contraseña abierto, la seguridad depende de que sea **larga y única**. Para máxima seguridad, cambiar a `PasswordAuthentication no` y entrar solo con clave.

> **Regla de oro:** antes de cerrar la sesión actual, prueba que puedes abrir una **nueva**. Si algo falla, la sesión abierta sirve para deshacer el cambio.

## 1.5 Actualizar el sistema

```bash
sudo apt-get update
sudo apt-get full-upgrade -y
```

- `update` descarga la lista de versiones disponibles.
- `full-upgrade` instala las nuevas versiones y, si hace falta, añade o quita dependencias.

El sistema ya estaba al día. Había un kernel nuevo (`6.18.60`) instalado que se activa con el reinicio de 1.7.

## 1.6 Ajustes del sistema para Kubernetes

### 1.6.1 Nombre del equipo

```bash
sudo hostnamectl set-hostname rpi-k3s
sudo sed -i 's/^127\.0\.1\.1.*/127.0.1.1\trpi-k3s/' /etc/hosts
```

Kubernetes usa el nombre del equipo como nombre del **nodo**. También se actualiza `/etc/hosts` para que la Pi sepa resolver su propio nombre; si no, `sudo` avisa con `unable to resolve host` (sale una vez, entre los dos comandos, y es normal).

### 1.6.2 IP fija

```bash
sudo nmcli con mod "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.168.0.27/24 ipv4.gateway 192.168.0.1 ipv4.dns 192.168.0.1
```

- Un servidor necesita una IP que no cambie: el DNS, los certificados y el kubeconfig apuntan a ella.
- `nmcli` es la herramienta de NetworkManager, el gestor de red de Raspberry Pi OS.
- Se mantiene la misma IP que ya tenía para no cortar la conexión SSH.

> **Recomendado:** crear también una **reserva DHCP** en el router para la MAC `d8:3a:dd:37:6a:d9` → `192.168.0.27`, para que el router no reparta esa IP a otro equipo.

### 1.6.3 Arrancar sin escritorio gráfico

```bash
sudo systemctl set-default multi-user.target
```

- El escritorio (labwc, panel, gestor de archivos…) ocupa unos 250-400 MB de RAM, que es mejor dejar para Kubernetes.
- `multi-user.target` es el modo "solo consola" de systemd. No se desinstala nada.
- **Para volver atrás:** `sudo systemctl set-default graphical.target`.

### 1.6.4 Activar el cgroup de memoria

Al final de la única línea de `/boot/firmware/cmdline.txt` se añade:

```
cgroup_memory=1 cgroup_enable=memory
```

- **cgroups** ("grupos de control") es la función del kernel que limita cuánta CPU y RAM puede usar un grupo de procesos. Kubernetes la usa para aplicar los `requests` y `limits` de cada contenedor.
- El kernel de Raspberry Pi arranca con `cgroup_disable=memory`, es decir, con el control de memoria **apagado**. Sin él, K3s no arranca.
- `cmdline.txt` son los parámetros que el firmware pasa al kernel al arrancar. **Debe ser una sola línea**: si añades un salto de línea, la Pi puede no arrancar. Antes de editarlo se guardó una copia en `cmdline.txt.bak`.
- El último parámetro gana: `cgroup_enable=memory` anula al `cgroup_disable=memory` que pone el firmware.

### 1.6.5 Desactivar el swap

Fichero `/etc/rpi/swap.conf.d/90-k3s.conf`:

```
[Main]
Mechanism=none
```

- El **swap** es memoria "de reserva" en disco o, en este sistema, RAM comprimida (zram). Cuando la RAM se llena, el sistema mueve ahí datos.
- En Kubernetes es mejor que no haya swap: los límites de memoria tienen que ser reales, y un nodo que tira de swap se vuelve lento de forma impredecible en lugar de fallar de forma clara.
- En trixie el swap lo gestiona el paquete `rpi-swap` (antes era `dphys-swapfile`). Su manual (`man 5 swap.conf`) documenta `Mechanism=none`.

### 1.6.6 Parámetros del kernel (sysctl)

Fichero `/etc/sysctl.d/90-k3s.conf`:

```
net.ipv4.ip_forward = 1
fs.inotify.max_user_instances = 512
fs.inotify.max_user_watches = 524288
vm.overcommit_memory = 1
vm.panic_on_oom = 0
kernel.panic = 10
kernel.panic_on_oops = 1
```

| Parámetro | Para qué |
|---|---|
| `net.ipv4.ip_forward` | Permite a la Pi reenviar paquetes entre la red de los contenedores y la red de casa (hacer de "router" interno) |
| `fs.inotify.*` | inotify avisa a un programa cuando cambia un fichero. Kubernetes y sus controladores vigilan muchos; los valores por defecto se quedan cortos y dan errores `too many open files` |
| `vm.overcommit_memory = 1` | Valor que espera el kubelet: el kernel no rechaza reservas de memoria por adelantado |
| `vm.panic_on_oom = 0` | Si se acaba la memoria, el kernel mata un proceso en vez de colgar todo el sistema |
| `kernel.panic = 10` / `panic_on_oops = 1` | Ante un error grave del kernel, reinicia a los 10 s en lugar de quedarse bloqueado |

Se aplican con `sudo sysctl --system` y se mantienen tras reiniciar.

> `sysctl` está en `/usr/sbin`. Con el usuario normal hay que llamarlo con la ruta completa (`/usr/sbin/sysctl`) o con `sudo`.

## 1.7 Reinicio y verificación

```bash
sudo systemctl reboot
```

| Comprobación | Resultado |
|---|---|
| `uname -r` | `6.18.60+rpt-rpi-v8` (kernel nuevo) ✅ |
| `cat /sys/fs/cgroup/cgroup.controllers` | `cpuset cpu io memory pids` ✅ |
| `free -h` | `Swap: 0B` ✅ |
| `systemctl get-default` | `multi-user.target` ✅ |
| RAM usada en reposo | 256 Mi ✅ |
| `hostname` | `rpi-k3s` ✅ |
| IP | `192.168.0.27`, método `manual` ✅ |
| `sshd -T` | `passwordauthentication yes`, `permitrootlogin no` ✅ |
| `vcgencmd get_throttled` | `0x0` (sin problemas de tensión ni temperatura) ✅ |

Antes de instalar K3s se comprobó también que cargan los módulos de red que necesita (ver [2.4](02-instalacion-k3s.md)):

```bash
sudo modprobe br_netfilter nf_conntrack nf_nat nf_tables nft_compat nft_chain_nat vxlan
sudo dpkg -V linux-image-$(uname -r)     # → 0 problemas
```

## Cómo deshacer cada cambio

| Cambio | Deshacer |
|---|---|
| sudo sin contraseña | `sudo rm /etc/sudoers.d/090_admin-nopasswd` |
| Endurecimiento de SSH | `sudo rm /etc/ssh/sshd_config.d/10-hardening.conf && sudo systemctl reload ssh` |
| Escritorio desactivado | `sudo systemctl set-default graphical.target` |
| cgroups | `sudo cp /boot/firmware/cmdline.txt.bak /boot/firmware/cmdline.txt` |
| Swap desactivado | `sudo rm /etc/rpi/swap.conf.d/90-k3s.conf` y reiniciar |
| sysctl | `sudo rm /etc/sysctl.d/90-k3s.conf` y reiniciar |
| IP fija | `sudo nmcli con mod "Wired connection 1" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""` |
