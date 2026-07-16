# notification-gateway

Gateway interno de notificaciones: los servicios envían por HTTP y el gateway
despacha por SMS a través de un GOIP de 1 canal (multi-canal a futuro: email, Telegram).

Documentos de diseño:

- `propuesta-notification-gateway-2026-07-11.md` — arquitectura, decisiones y plan por fases.
- `goip-validacion-2026-07-11.md` — validación del equipo real y reglas del provider.
- `resumen-goip-2026-07-11.md` — análisis previo del GOIP.

## Stack

Node 22+ / TypeScript / Fastify / PostgreSQL (la tabla `deliveries` es la cola,
con `FOR UPDATE SKIP LOCKED`; sin Redis a propósito — ver propuesta D1).

## Desarrollo

```bash
# Postgres local desechable
docker run -d --name ngw-dev-pg -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=notification_gateway -p 5433:5432 postgres:16

cp .env.example .env
npm install
npm test            # suite de tests contra el PG local
npm run dev         # server con provider fake (no envía SMS reales)
```

## Uso

```bash
# Usuarios del panel /admin (crear o cambiar contraseña; mínimo 8 caracteres)
npm run create-admin -- admin mi-contraseña-segura

npm run create-key -- mi-servicio      # genera API key (aviso 60/h, corte 120/h)

curl -X POST localhost:8090/api/notifications \
  -H "Authorization: Bearer ngw_..." -H "Content-Type: application/json" \
  -d '{"recipients":["+51987654321"],"message":"Nextcloud dejó de responder",
       "priority":"high","dedup_key":"nextcloud-down"}'
```

Endpoints: `POST /api/notifications`, `GET /api/notifications/:id`, `GET /health`.

Estados de una delivery: `queued → processing → sent` con
`retrying/exhausted/failed/suppressed/cancelled/expired/uncertain` según el caso. Los
reintentos automáticos se permiten durante una hora desde la primera evaluación del
worker; después la delivery queda `expired`, sin borrar su contenido. Un reintento manual
abre una ventana nueva.

Si el GOIP acepta un envío pero no se puede confirmar su resultado, la delivery queda
`uncertain` y pausa el canal SMS. Con `smskey`, el worker consulta el GOIP hasta obtener
`DONE`. Sin `smskey`, espera 60 segundos y hace un único reintento: puede duplicar el SMS,
pero evita que una respuesta perdida congele el canal. Si ese reintento también queda
incierto, la delivery se conserva para resolución manual y las posteriores continúan.
`L1 busy`, GSM desregistrado y health degradado no consumen intentos.
Protecciones: dedup por ventana (15 min), límites atómicos por hora (global /
destinatario / API key), reserva crítica, alerta administrativa de corte y división
íntegra de mensajes largos (≤160 ASCII / ≤70 Unicode, máximo 9 partes). Los umbrales
operativos son configurables en el panel y `SYSTEM_ALERT_RECIPIENTS` define por entorno
quién recibe las alertas internas.

La admisión también vigila profundidad y antigüedad de la cola. Por defecto, desde 60
deliveries pendientes solo admite `critical`, reserva 20 posiciones adicionales y bloquea
normales si la delivery lista más antigua supera 15 minutos. Un rechazo total normal
responde `429`; un `critical` sin capacidad absoluta responde `503` con `Retry-After`.

## Panel /admin

Login con usuario/contraseña (`npm run create-admin`), cookie de sesión firmada
(7 días), rate limit de login (5 fallos → 15 min). Pestañas: Dashboard (contadores,
salud del GOIP, envío de prueba), Notificaciones (filtros, detalle, reintentar/cancelar),
API Keys (crear/revocar) y Configuración (parámetros operativos en caliente).
Se actualiza en vivo por SSE.

El dashboard también muestra el estado del poller y la cantidad de entrantes visibles. Las
20 posiciones del GOIP son una ventana histórica rodante, no una cola ni una señal de
saturación: un mensaje nuevo aparece arriba y puede desplazar al más antiguo. El health se
degrada por ciclos fallidos u obsoletos, no por ver 20 entradas. La lectura no borra mensajes
del equipo; se conserva tanto su hora cruda como una fecha derivada para ordenarlos.

## Despliegue (PM2)

```bash
# 1. base de datos (una sola vez, en el Postgres existente)
docker exec <contenedor-postgres> psql -U postgres -c "CREATE DATABASE \"notification_gateway\""

# 2. código y build
cd ~/notification-gateway
npm ci && npm run build

# 3. .env de producción (ver .env.example):
#    DATABASE_URL=postgres://postgres:...@localhost:5432/notification_gateway
#    SESSION_SECRET=$(openssl rand -hex 32)
#    SMS_PROVIDER=goip  +  GOIP_BASE_URL/USER/PASSWORD
#    TRUST_PROXY=<IP/CIDR del proxy> (nunca true), o false sin proxy

# 4. migraciones corren solas al arrancar; configurar SYSTEM_ALERT_RECIPIENTS
#    con el mismo destinatario operativo de Atalaya y crear admin/keys:
npm run create-admin -- admin <contraseña>
npm run create-key -- <servicio>

# 5. arrancar
pm2 start ecosystem.config.cjs && pm2 save
```
