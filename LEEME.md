# IP Libres · UGEL Chincha

Escanea la red cada 5 minutos y lleva el inventario de equipos e IPs. Solo necesita Node.js 18 o superior; no requiere `npm install`.

## Archivos

| Archivo | Qué guarda |
|---|---|
| `server.js` | El servidor (escaneo, API e inventario) |
| `index.html` | La app web (celular y PC) |
| `config.json` | Segmentos, puerto, PIN y enlace del Google Sheet |
| `inventario.json` | **El inventario de equipos** (fuente principal, se edita desde la app) |
| `data.json` | Historial del escaneo, MACs y alertas |
| `inventario.csv` | Última copia descargada del Google Sheet |

Para respaldar, copia `inventario.json`, `data.json` y `config.json`.

## Inventario

- Se edita desde la app (pestaña **Inventario**): agregar, editar, borrar, con historial de cambios.
- No se permiten IPs repetidas: la app avisa antes de guardar.
- **Importar del Google Sheet** agrega las filas nuevas y actualiza nombres, sin pisar fichas que ya se editaron en la app.
- **Descargar en Excel (CSV)** exporta todo el inventario.
- Con `"pin": "1234"` en `config.json`, solo quien conozca el PIN puede editar.

## Windows 

```
cd /d C:\apps\ip-libres
pm2 start server.js --name ipLibres
pm2 save
```
Para aplicar cambios: `pm2 restart ipLibres` (o doble clic en `reiniciar.bat`).

## Migrar a Ubuntu Server

1. Instalar Node.js LTS y las herramientas de red:
   ```
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs iputils-ping iproute2 samba-common-bin
   ```
   (`samba-common-bin` trae `nmblookup`, para ver el nombre de las PCs Windows.)
2. Copiar la carpeta completa a `/opt/ip-libres` (incluye `inventario.json` y `data.json` para no perder datos).
3. Crear el usuario del servicio y darle la carpeta:
   ```
   sudo useradd -r -s /usr/sbin/nologin iplibres
   sudo chown -R iplibres:iplibres /opt/ip-libres
   ```
4. Instalar el servicio:
   ```
   sudo cp /opt/ip-libres/ip-libres.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now ip-libres
   sudo systemctl status ip-libres
   ```
5. Abrir el puerto: `sudo ufw allow 8090/tcp`
6. Ver los registros: `journalctl -u ip-libres -f`

El servidor Ubuntu debe estar en el mismo segmento de red que los equipos para que la detección por ARP funcione (encuentra PCs con el ping bloqueado).

## Estados de una IP

- **Libre**: no responde y no se ha visto en los últimos 7 días (`diasAusente`).
- **En uso**: respondió en el último escaneo.
- **Ausente**: no responde ahora, pero se vio hace poco (PC apagada). No asignar.
- **Asignada**: está en el inventario aunque ahora no responda.
- **Por DHCP**: un equipo del inventario (reconocido por su MAC) está usando esta IP porque el DHCP se la dio. Su IP asignada muestra un punto celeste y su ficha dice «DHCP → IP actual».

La MAC de cada ficha se aprende sola del escaneo; se puede corregir a mano en la ficha.
