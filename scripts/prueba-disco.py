#!/usr/bin/env python3
"""Prueba de capacidad real de un disco por muestreo (misma idea que f3).

Escribe N bloques con contenido único repartidos por un fichero que ocupa
casi todo el disco, vacía la caché de RAM y comprueba que se leen igual.
Un disco falsificado pierde o machaca lo que se escribe más allá de su
capacidad real, y algunos bloques no coincidirían.

Uso (ver docs/01, apartado 1.2.2):
    F=/var/tmp/prueba-capacidad.bin
    sudo fallocate -l $(( $(df -B1 --output=avail / | tail -1) - 20*1024**3 )) $F
    sudo python3 -I scripts/prueba-disco.py $F 512
    sudo rm $F && sudo fstrim -v /
"""
import hashlib
import mmap
import os
import sys

path, n = sys.argv[1], int(sys.argv[2])
BS = 4 * 1024 * 1024
size = os.path.getsize(path)
step = (size - BS) // (n - 1)
offsets = [(i * step) // BS * BS for i in range(n)]


def block(i):
    """Contenido único y reproducible para el bloque i."""
    seed = hashlib.sha256(f"bloque-{i}".encode()).digest()
    out = bytearray()
    while len(out) < BS:
        seed = hashlib.sha256(seed).digest()
        out += seed * 128
    return bytes(out[:BS])


buf = mmap.mmap(-1, BS)  # memoria alineada, necesaria para O_DIRECT

# 1. Escribir sin pasar por la caché (O_DIRECT)
fd = os.open(path, os.O_RDWR | os.O_DIRECT)
expected = []
for i, off in enumerate(offsets):
    data = block(i)
    buf.seek(0)
    buf.write(data)
    os.pwrite(fd, buf, off)
    expected.append(hashlib.sha256(data).hexdigest())
os.fsync(fd)
os.close(fd)

# 2. Vaciar la caché de RAM para obligar a leer del disco
os.sync()
with open("/proc/sys/vm/drop_caches", "w") as f:
    f.write("3\n")

# 3. Releer y comparar
fd = os.open(path, os.O_RDONLY | os.O_DIRECT)
bad = []
for i, off in enumerate(offsets):
    os.preadv(fd, [buf], off)
    if hashlib.sha256(buf[:]).hexdigest() != expected[i]:
        bad.append((i, off))
os.close(fd)

print(f"bloques probados: {n} de {BS // 1048576} MiB, repartidos en {size / 1e12:.2f} TB")
print(f"posición del último bloque: {offsets[-1] / 1e9:.1f} GB")
print(f"bloques erróneos: {len(bad)}")
for i, off in bad[:10]:
    print(f"  ERROR bloque {i} en {off / 1e9:.1f} GB")
print("RESULTADO:", "OK" if not bad else "FALLO")
