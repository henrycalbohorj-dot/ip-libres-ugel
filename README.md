# IP Libres · UGEL Chincha

App web (celular y PC) que **escanea la red cada 5 minutos** y muestra qué IPs están libres, ocupadas o asignadas, cruzando el escaneo con el inventario de equipos. Reemplaza el uso de Advanced IP Scanner de escritorio para todo el equipo de soporte.

**Stack:** Node.js 18+ sin dependencias (no requiere `npm install`) · systemd · Ubuntu.

## Qué hace

- Escaneo por **ping + ARP** (detecta PCs con el ping bloqueado si están en la misma subred).
- **Inventario editable** desde la app (con historial), importable desde un Google Sheet publicado como CSV.
- Estado de cada IP: asignada › ocupada sin registrar › ausente reciente › libre, y **sugerencia de la próxima IP libre**.
- Recibe los préstamos del **DHCP de Windows Server** (endpoint `/api/dhcp` protegido por token) para reconocer equipos por MAC aunque cambien de IP, y genera el script de reservas.
- `mapa.html`: **mapa 3D del edificio** con los equipos por piso y área, basado en la topología de Cisco Packet Tracer (también se usa de fondo en la TV del Centro de avisos).

## Instalación

```bash
sudo useradd -r -s /usr/sbin/nologin iplibres
sudo mkdir /opt/ip-libres && sudo cp -r . /opt/ip-libres
sudo cp config.example.json /opt/ip-libres/config.json   # edita segmentos, PIN y token
sudo chown -R iplibres: /opt/ip-libres
sudo cp ip-libres.service /etc/systemd/system/ && sudo systemctl enable --now ip-libres
```

Abre `http://IP_DEL_SERVIDOR:8090`. Más detalles de uso en [LEEME.md](LEEME.md).

## Datos que no se publican

`config.json`, `inventario.json`, `inventario.csv`, `data.json` y `topologia.json` contienen la red real de la institución y están en `.gitignore`. Se incluyen `config.example.json` e `inventario.example.csv` como plantilla.

---
Desarrollado por **Henry Braulio Pachas Dávalos** · Área de Informática, UGEL Chincha.
