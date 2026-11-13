# 1. Preparación de la Raspberry Pi

Objetivo: dejar la Raspberry Pi lista para instalar Kubernetes (K3s): acceso seguro, sistema actualizado y kernel configurado.

Fecha: 2026-11-13

## Punto de partida

| Elemento | Valor |
|---|---|
| Placa | Raspberry Pi 4 Model B Rev 1.5, 4 núcleos, 4 GB de RAM (3,7 GiB útiles) |
| Sistema | Raspberry Pi OS 64-bit basado en Debian 13 "trixie", kernel 6.18 `aarch64` |
| Disco | Tarjeta microSD de 64 GB (`/dev/mmcblk0`) |
| Red | Cable (`eth0`), IP `192.168.0.27` por DHCP; router `192.168.0.1` |
| Usuario | `admin` (contraseña inicial débil; el acceso por contraseña se desactiva en 1.3.2) |
| Ordenador de trabajo | `192.168.0.26` (red `192.168.0.0/24`) |

> **Aviso sobre la microSD:** K3s escribe en disco continuamente (su base de datos SQLite). Las tarjetas SD se desgastan con ese uso. Para un laboratorio vale, pero si el proyecto va a estar encendido meses, conviene pasar a un SSD por USB.

---

## 1.1 Encontrar la Pi en la red

```bash
ip -4 -brief addr                     # qué IP y red tiene mi ordenador
nmap -p 22 --open 192.168.0.0/24      # qué equipos tienen SSH abierto
ip neigh | grep d8:3a:dd              # confirmar por la MAC
```

- `ip -4 -brief addr` mostró que el ordenador está en `192.168.0.26/24`. El `/24` significa que la red local va de `192.168.0.1` a `192.168.0.254`.
- `nmap` es un escáner de red. Con `-p 22 --open` pregunta a todas las direcciones de la red si tienen abierto el **puerto 22**, el de **SSH** (el servicio para controlar un equipo por terminal a distancia). Solo respondió `192.168.0.27`.
- La **MAC** es el identificador físico de una tarjeta de red. Sus tres primeros bloques indican el fabricante: `d8:3a:dd` pertenece a Raspberry Pi.
- La Pi también respondía al nombre `raspberrypi.local`, que anuncia ella misma por **mDNS** (un sistema para encontrar equipos por nombre en la red local sin servidor DNS).

## 1.2 Acceso por clave SSH

### 1.2.1 Crear una clave solo para este proyecto (en el ordenador)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/rpi_k3s -N "" -C "rpi-k3s-cluster"
```

Una **clave SSH** es un par de ficheros:

- `~/.ssh/rpi_k3s` → **clave privada**. Nunca sale del ordenador. Es la llave.
- `~/.ssh/rpi_k3s.pub` → **clave pública**. Se copia a la Pi. Es la cerradura.

Al conectar, la Pi comprueba que tienes la llave que abre su cerradura, sin pedir contraseña. Detalles de las opciones:

- `-t ed25519` usa el tipo de clave moderno: corto, rápido y seguro.
- `-N ""` crea la clave sin frase de paso, para poder automatizar comandos. A cambio, quien copie ese fichero podría entrar en la Pi; en un laboratorio casero es aceptable.

### 1.2.2 Alias en `~/.ssh/config` (en el ordenador)

```
Host rpi-k3s
    HostName 192.168.0.27
    User admin
    IdentityFile ~/.ssh/rpi_k3s
    IdentitiesOnly yes
```

Con esto, `ssh rpi-k3s` equivale a `ssh -i ~/.ssh/rpi_k3s admin@192.168.0.27`. `IdentitiesOnly yes` hace que SSH use solo esa clave y no pruebe las de otros proyectos.

### 1.2.3 Copiar la clave pública a la Pi

```bash
ssh-copy-id -i ~/.ssh/rpi_k3s.pub rpi-k3s
```

Entra una última vez con la contraseña y añade la clave pública a `~/.ssh/authorized_keys` en la Pi, que es la lista de claves autorizadas.

> **Problema encontrado:** al lanzarlo desde Claude Code con `!` no hay terminal interactiva, así que SSH no puede pedir la contraseña e intenta usar `ssh-askpass`, un programa gráfico que no está instalado. **Solución:** ejecutarlo en una terminal normal, o usar un script temporal de `SSH_ASKPASS` que entregue la contraseña y borrarlo justo después.

Comprobación: `ssh rpi-k3s whoami` → `admin`, sin pedir contraseña.

## 1.3 Endurecer el acceso

### 1.3.1 `sudo` sin contraseña para `admin`

```bash
echo "admin ALL=(ALL) NOPASSWD: ALL" > /tmp/090_admin-nopasswd
sudo visudo -cf /tmp/090_admin-nopasswd          # valida la sintaxis
sudo install -m 0440 -o root -g root /tmp/090_admin-nopasswd /etc/sudoers.d/090_admin-nopasswd
```

- `sudo` permite ejecutar comandos como administrador (root). Los ficheros de `/etc/sudoers.d/` definen quién puede usarlo y cómo.
- **Siempre se valida con `visudo -c` antes de instalar el fichero.** Un error de sintaxis en sudoers puede dejarte sin `sudo` y sin forma de arreglarlo por SSH.
- `0440` deja el fichero solo de lectura para root; `sudo` exige esos permisos.
- **¿Por qué es aceptable?** El paso siguiente prohíbe entrar con contraseña. Para usar `sudo` primero hay que tener la clave privada.

### 1.3.2 SSH solo con clave

Fichero `/etc/ssh/sshd_config.d/10-hardening.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
X11Forwarding no
```

| Línea | Qué hace |
|---|---|
| `PasswordAuthentication no` | Nadie puede entrar adivinando la contraseña (la de `admin` era muy débil) |
| `KbdInteractiveAuthentication no` | Cierra otra vía de contraseña ("teclado interactivo") |
| `PubkeyAuthentication yes` | Permite entrar con clave |
| `PermitRootLogin no` | Prohíbe entrar directamente como root |
| `X11Forwarding no` | Desactiva el reenvío de ventanas gráficas, que no se necesita |

```bash
sudo sshd -t                 # comprueba la sintaxis antes de aplicar
sudo systemctl reload ssh    # aplica sin cortar las sesiones abiertas
```

Se usa un fichero en `sshd_config.d/` en lugar de editar `sshd_config` porque es más limpio: se ve de un vistazo qué hemos cambiado y las actualizaciones del sistema no lo pisan.

**Verificación:**

- Con clave: entra.
- Forzando contraseña: `Permission denied (publickey)`.
- El servidor solo ofrece el método `publickey`.

> **Regla de oro:** antes de cerrar la sesión actual, prueba que puedes abrir una **nueva**. Si algo falla, la sesión abierta sirve para deshacer el cambio.

### 1.3.3 Otros accesos remotos

No hay VNC ni RDP activos. Solo escuchan el puerto 22 (SSH) y el 111 (`rpcbind`, usado por NFS; se puede desactivar más adelante).

## 1.4 Actualizar el sistema

```bash
sudo apt-get update
sudo apt-get full-upgrade -y
```

- `update` descarga la lista de versiones disponibles.
- `full-upgrade` instala las nuevas versiones y, si hace falta, añade o quita dependencias.

Solo había 2 paquetes pendientes.

## 1.5 Ajustes del sistema para Kubernetes

### 1.5.1 Nombre del equipo

```bash
sudo hostnamectl set-hostname rpi-k3s
sudo sed -i 's/^127\.0\.1\.1.*/127.0.1.1\trpi-k3s/' /etc/hosts
```

Kubernetes usa el nombre del equipo como nombre del **nodo**. También se actualiza `/etc/hosts` para que la Pi sepa resolver su propio nombre; si no, `sudo` avisa con `unable to resolve host`. Ahora la Pi se anuncia en la red como `rpi-k3s.local`.

### 1.5.2 IP fija

```bash
sudo nmcli con mod "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.168.0.27/24 ipv4.gateway 192.168.0.1 ipv4.dns 192.168.0.1
```

- Un servidor necesita una IP que no cambie: el DNS, los certificados y el kubeconfig apuntan a ella.
- `nmcli` es la herramienta de NetworkManager, el gestor de red de Raspberry Pi OS.
- Se mantiene la misma IP que ya tenía para no cortar la conexión SSH.

> **Pendiente:** el router no sabe que esa IP está "reservada". Si la reparte a otro equipo habría un conflicto. Solución: crear una **reserva DHCP** en el router para la MAC `d8:3a:dd:37:6a:d9` → `192.168.0.27`.

### 1.5.3 Arrancar sin escritorio gráfico

```bash
sudo systemctl set-default multi-user.target
```

- El escritorio (labwc, panel, gestor de archivos…) ocupaba unos 400 MB de RAM, un 10 % de la Pi, que es mejor dejar para Kubernetes.
- `multi-user.target` es el modo "solo consola" de systemd. No se desinstala nada.
- **Para volver atrás:** `sudo systemctl set-default graphical.target`.

Resultado: RAM usada en reposo, de **485 Mi a 222 Mi**.

### 1.5.4 Activar el cgroup de memoria

Al final de la única línea de `/boot/firmware/cmdline.txt` se añade:

```
cgroup_memory=1 cgroup_enable=memory
```

- **cgroups** ("grupos de control") es la función del kernel que limita cuánta CPU y RAM puede usar un grupo de procesos. Kubernetes la usa para aplicar los `requests` y `limits` de cada contenedor.
- El kernel de Raspberry Pi arranca con `cgroup_disable=memory`, es decir, con el control de memoria **apagado**. Sin él, K3s no arranca.
- `cmdline.txt` son los parámetros que el firmware pasa al kernel al arrancar. **Debe ser una sola línea**: si añades un salto de línea, la Pi puede no arrancar. Antes de editarlo se guardó una copia en `cmdline.txt.bak`.
- El último parámetro gana: `cgroup_enable=memory` anula al `cgroup_disable=memory` que pone el firmware.

Comprobación: `cat /sys/fs/cgroup/cgroup.controllers` → `cpuset cpu io memory pids`. Antes faltaba `memory`.

### 1.5.5 Desactivar el swap

Fichero `/etc/rpi/swap.conf.d/90-k3s.conf`:

```
[Main]
Mechanism=none
```

- El **swap** es memoria "de reserva" en disco o, en este sistema, RAM comprimida (zram). Cuando la RAM se llena, el sistema mueve ahí datos.
- En Kubernetes es mejor que no haya swap: los límites de memoria tienen que ser reales, y un nodo que tira de swap se vuelve lento de forma impredecible en lugar de fallar de forma clara.
- En trixie el swap lo gestiona el paquete `rpi-swap` (antes era `dphys-swapfile`). Su manual (`man 5 swap.conf`) documenta `Mechanism=none`.
- Se usa un fichero en `swap.conf.d/` en lugar de editar `swap.conf`, igual que con SSH.

Comprobación: `free -h` → `Swap: 0B`.

### 1.5.6 Parámetros del kernel (sysctl)

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

## 1.6 Reinicio y verificación

```bash
sudo systemctl reboot
```

| Comprobación | Resultado |
|---|---|
| `cat /sys/fs/cgroup/cgroup.controllers` | `cpuset cpu io memory pids` ✅ |
| `free -h` | `Swap: 0B` ✅ |
| `systemctl get-default` | `multi-user.target` ✅ |
| RAM usada en reposo | 222 Mi (antes 485 Mi) ✅ |
| `hostname` | `rpi-k3s` ✅ |
| IP | `192.168.0.27`, método `manual` ✅ |
| `vcgencmd get_throttled` | `0x0` (sin problemas de tensión ni temperatura) ✅ |

## Cómo deshacer cada cambio

| Cambio | Deshacer |
|---|---|
| sudo sin contraseña | `sudo rm /etc/sudoers.d/090_admin-nopasswd` |
| SSH solo con clave | `sudo rm /etc/ssh/sshd_config.d/10-hardening.conf && sudo systemctl reload ssh` |
| Escritorio desactivado | `sudo systemctl set-default graphical.target` |
| cgroups | `sudo cp /boot/firmware/cmdline.txt.bak /boot/firmware/cmdline.txt` |
| Swap desactivado | `sudo rm /etc/rpi/swap.conf.d/90-k3s.conf` y reiniciar |
| sysctl | `sudo rm /etc/sysctl.d/90-k3s.conf` y reiniciar |
| IP fija | `sudo nmcli con mod "Wired connection 1" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""` |
