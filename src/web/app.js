/* Panel del notification-gateway — vanilla JS, sin dependencias. */
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(`/admin/api${path}`, {
    // content-type solo cuando hay cuerpo: un POST vacío declarado como JSON es 400 en Fastify
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('sesión expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => d ? new Date(d).toLocaleString('es-PE', { hour12: false }) : '—';
const fmtDuration = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value} s`;
  if (value < 3600) return `${Math.ceil(value / 60)} min`;
  return `${(value / 3600).toFixed(1)} h`;
};

// ---------- login ----------
function showLogin() { $('#login-view').classList.remove('hidden'); $('#main-view').classList.add('hidden'); }
function showMain() { $('#login-view').classList.add('hidden'); $('#main-view').classList.remove('hidden'); }

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    $('#login-error').textContent = '';
    e.target.reset();
    enter();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  stopStream();
  showLogin();
});

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-content').forEach((s) => s.classList.add('hidden'));
  $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
  // el token de una key recién creada solo vive mientras no se navegue
  $('#key-token').classList.add('hidden');
  refreshTab(btn.dataset.tab);
}));
const activeTab = () => document.querySelector('.tab.active').dataset.tab;
function refreshTab(tab) {
  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'notifications') loadNotifications();
  else if (tab === 'inbound') loadInbound();
  else if (tab === 'keys') loadKeys();
  else if (tab === 'settings') loadSettings();
}

// ---------- dashboard ----------
function counterCard(label, value, cls = '') {
  return `<div class="card ${cls}"><div class="num">${value}</div><div class="lbl">${label}</div></div>`;
}

/* Señal GSM 0-31 (99 = desconocida) como barras tipo celular + valor numérico. */
function signalCard(channel, d) {
  const sig = d.signal;
  const unknown = sig == null || sig === 99;
  // umbrales GSM habituales: <8 mala, 8-14 regular, >=15 buena
  const cls = unknown ? 'warn' : sig >= 15 ? 'ok' : sig >= 8 ? 'warn' : 'err';
  const level = unknown ? 0 : Math.max(1, Math.min(5, Math.ceil((sig / 31) * 5)));
  const bars = [1, 2, 3, 4, 5].map((i) =>
    `<span class="bar ${i <= level ? 'on' : ''}" style="height:${4 + i * 3}px"></span>`).join('');
  return `<div class="card ${cls}">
    <div class="num signal"><span class="bars">${bars}</span> ${unknown ? '?' : `${sig}<small>/31</small>`}</div>
    <div class="lbl">GOIP · ${esc(d.operator || 'sin operador')}${unknown ? ' · señal desconocida' : ''}</div>
  </div>`;
}
function summaryBadges(n) {
  let html = '';
  if (Number(n.sent)) html += `<span class="badge sent">${n.sent} ✓</span>`;
  if (Number(n.pending)) html += `<span class="badge pending">${n.pending} ⏳</span>`;
  if (Number(n.failed)) html += `<span class="badge failed">${n.failed} ✗</span>`;
  if (Number(n.suppressed)) html += `<span class="badge suppressed">${n.suppressed} ⊘</span>`;
  if (Number(n.suppressed_count)) html += `<span class="badge suppressed">×${Number(n.suppressed_count) + 1}</span>`;
  return html || '<span class="badge">—</span>';
}
async function loadDashboard() {
  const data = await api('/overview');
  const s = data.last24h;
  const queue = data.queue;
  const failed = (s.failed ?? 0) + (s.exhausted ?? 0) + (s.expired ?? 0);
  const queueClass = queue.state === 'full' || queue.state === 'critical_only'
    ? 'err'
    : queue.state === 'warning' ? 'warn' : 'ok';
  $('#counters').innerHTML =
    counterCard('Enviados (24 h)', s.sent ?? 0, 'ok') +
    counterCard('Cola SMS', `${queue.pendingTotal}/${queue.absoluteLimit}`, queueClass) +
    counterCard('Más antigua lista', fmtDuration(queue.oldestReadyS), queueClass) +
    counterCard('Vaciado estimado', fmtDuration(queue.estimatedDrainS), queueClass) +
    counterCard('Fallidos (24 h)', failed, failed ? 'err' : '') +
    counterCard('Inciertos (24 h)', s.uncertain ?? 0, s.uncertain ? 'err' : '') +
    counterCard('Suprimidos (24 h)', s.suppressed ?? 0);
  const providerCards = Object.entries(data.providers).map(([ch, h]) => {
    const d = h.detail || {};
    if (d.provider === 'fake') return counterCard(`Canal ${ch}`, 'fake', 'warn');
    if (!h.ok) {
      const reason = d.error ? 'inalcanzable' : d.gsm_registered === false ? 'sin registro GSM' : d.sim === false ? 'sin SIM' : 'caído';
      return counterCard(`GOIP · canal ${ch}`, `✗ ${reason}`, 'err');
    }
    return signalCard(ch, d);
  }).join('');
  const inbound = data.serviceHealth?.find((item) => item.component === 'inbound_poller');
  const inbox = inbound?.detail?.sms;
  const inboundFailed = Boolean(inbound?.last_error_at &&
    (!inbound.last_success_at || new Date(inbound.last_error_at) > new Date(inbound.last_success_at)));
  const inboundStale = Number(inbound?.reference_age_s ?? 0) > data.inboundStaleAfterS;
  const inboundCard = !inbound?.last_success_at && inboundStale
    ? counterCard('Entrantes GOIP', 'sin primer ciclo', 'err')
    : !inbound?.last_success_at
    ? counterCard('Entrantes GOIP', 'iniciando', 'warn')
    : inboundStale
      ? counterCard('Entrantes GOIP', `sin ciclo hace ${fmtDuration(inbound.age_s)}`, 'err')
    : inboundFailed
      ? counterCard('Entrantes GOIP', 'poll fallido', 'err')
      : counterCard('Entrantes GOIP', `${inbox?.visible ?? 0} visibles`, 'ok');
  $('#provider-health').innerHTML = providerCards + inboundCard;
  $('#recent-table tbody').innerHTML = data.recent.map((n) => `
    <tr data-id="${n.id}">
      <td>${fmtDate(n.created_at)}</td><td>${esc(n.source)}</td>
      <td class="msg">${esc(n.message)}</td>
      <td><span class="badge prio-${n.priority}">${n.priority}</span></td>
      <td>${summaryBadges(n)}</td>
    </tr>`).join('');
  $('#recent-table tbody').querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', () => openDetailInTab(tr.dataset.id)));
}

$('#test-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const out = $('#test-result');
  out.textContent = '';
  try {
    await api('/test-send', { method: 'POST', body: { recipient: form.get('recipient'), message: form.get('message') } });
    // sin mensaje de éxito: la notificación aparece abajo y se actualiza sola
    e.target.reset();
  } catch (err) { out.textContent = err.message; }
});

// ---------- notificaciones ----------
$('#filter-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // el detalle abierto corresponde al listado anterior: cerrarlo al filtrar
  $('#notif-detail').classList.add('hidden');
  $('#notif-detail').innerHTML = '';
  loadNotifications();
});

async function loadNotifications() {
  const form = new FormData($('#filter-form'));
  const params = new URLSearchParams();
  for (const [k, v] of form) if (v) params.set(k, k === 'to' ? `${v}T23:59:59` : v);
  const data = await api(`/notifications?${params}`);
  $('#notif-table tbody').innerHTML = data.notifications.map((n) => `
    <tr data-id="${n.id}">
      <td>${fmtDate(n.created_at)}</td><td>${esc(n.source)}</td>
      <td class="msg">${esc(n.message)}</td>
      <td><span class="badge prio-${n.priority}">${n.priority}</span></td>
      <td>${summaryBadges(n)}</td>
    </tr>`).join('');
  $('#notif-table tbody').querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', () => showDetail(tr.dataset.id)));
}

function openDetailInTab(id) {
  document.querySelector('[data-tab="notifications"]').click();
  showDetail(id);
}

async function showDetail(id) {
  const n = await api(`/notifications/${id}`);
  const box = $('#notif-detail');
  box.classList.remove('hidden');
  box.innerHTML = `
    <h2>Detalle</h2>
    <dl class="detail-grid">
      <dt>Mensaje</dt><dd>${esc(n.message)}</dd>
      <dt>Origen / canal</dt><dd>${esc(n.source)} · ${esc(n.channel)}</dd>
      <dt>Prioridad</dt><dd>${esc(n.priority)}</dd>
      <dt>Dedup</dt><dd>${esc(n.dedup_key ?? '—')} ${n.suppressed_count ? `(suprimidas: ${n.suppressed_count})` : ''}</dd>
      <dt>Creada</dt><dd>${fmtDate(n.created_at)}</dd>
    </dl>
    <table><thead><tr>
      <th>Destinatario</th><th>Parte</th><th>Estado</th><th>Intentos</th><th>Error</th><th>Enviado</th><th></th>
    </tr></thead><tbody>
    ${n.deliveries.map((d) => `
      <tr>
        <td>${esc(d.recipient)}</td><td>${d.part}/${d.parts}</td>
        <td><span class="badge ${['sent','delivered'].includes(d.status) ? 'sent' : ['failed','exhausted','expired'].includes(d.status) ? 'failed' : ['queued','retrying','processing'].includes(d.status) ? 'pending' : d.status === 'uncertain' ? 'failed' : 'suppressed'}">${d.status}</span></td>
        <td>${d.attempts}</td>
        <td class="msg" title="${esc(d.last_error ?? '')}">${esc(d.last_error ?? '—')}</td>
        <td>${fmtDate(d.sent_at)}</td>
        <td class="actions">
          ${['failed','exhausted','expired','cancelled','suppressed'].includes(d.status) ? `<button data-act="retry" data-id="${d.id}">Reintentar</button>` : ''}
          ${['queued','retrying'].includes(d.status) ? `<button data-act="cancel" data-id="${d.id}" class="ghost">Cancelar</button>` : ''}
          ${d.status === 'uncertain' ? `<button data-act="resolve-uncertain" data-status="sent" data-id="${d.id}">Marcar enviado</button><button data-act="resolve-uncertain" data-status="failed" data-id="${d.id}" class="ghost">Marcar fallido</button>` : ''}
        </td>
      </tr>`).join('')}
    </tbody></table>`;
  box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.act === 'resolve-uncertain') {
      const label = btn.dataset.status === 'sent' ? 'enviado' : 'fallido';
      if (!confirm(`¿Marcar este resultado incierto como ${label}? Esta acción libera el canal SMS.`)) return;
    }
    try {
      await api(`/deliveries/${btn.dataset.id}/${btn.dataset.act}`, {
        method: 'POST',
        ...(btn.dataset.status ? { body: { status: btn.dataset.status } } : {}),
      });
      showDetail(id);
    } catch (err) { alert(err.message); }
  }));
  box.scrollIntoView({ behavior: 'smooth' });
}

// ---------- entrantes ----------
$('#inbound-filter').addEventListener('submit', (e) => { e.preventDefault(); loadInbound(); });

async function loadInbound() {
  const sender = new FormData($('#inbound-filter')).get('sender');
  const params = sender ? `?sender=${encodeURIComponent(sender)}` : '';
  const data = await api(`/inbound${params}`);
  $('#inbound-table tbody').innerHTML = data.messages.map((m) => `
    <tr>
      <td>${fmtDate(m.received_at)}</td>
      <td>${esc(m.device_time ?? '—')}</td>
      <td>${esc(m.sender)}</td>
      <td class="msg" title="${esc(m.body)}">${esc(m.body)}</td>
    </tr>`).join('');
}

// ---------- API keys ----------
async function loadKeys() {
  const data = await api('/keys');
  $('#keys-table tbody').innerHTML = data.keys.map((k) => `
    <tr data-id="${k.id}">
      <td>${esc(k.name)}</td>
      <td><input class="key-limit-input" data-key-limit="warning" type="number" min="1" max="1000000" value="${k.warning_limit_per_hour}" aria-label="Aviso por hora de ${esc(k.name)}"></td>
      <td><input class="key-limit-input" data-key-limit="hard" type="number" min="1" max="1000000" value="${k.rate_limit_per_hour}" aria-label="Corte por hora de ${esc(k.name)}"></td>
      <td>${fmtDate(k.last_used_at)}</td>
      <td><span class="badge ${k.enabled ? 'sent' : 'failed'}">${k.enabled ? 'activa' : 'revocada'}</span></td>
      <td class="actions">
        <button data-action="save-limits" class="ghost">Guardar</button>
        <button data-action="toggle" data-en="${!k.enabled}" class="ghost">${k.enabled ? 'Revocar' : 'Reactivar'}</button>
      </td>
    </tr>`).join('');
  $('#keys-table tbody').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
    const row = btn.closest('tr');
    try {
      if (btn.dataset.action === 'toggle') {
        await api(`/keys/${row.dataset.id}`, { method: 'PATCH', body: { enabled: btn.dataset.en === 'true' } });
      } else {
        await api(`/keys/${row.dataset.id}`, { method: 'PATCH', body: {
          warning_limit_per_hour: Number(row.querySelector('[data-key-limit="warning"]').value),
          rate_limit_per_hour: Number(row.querySelector('[data-key-limit="hard"]').value),
        }});
      }
      await loadKeys();
    } catch (err) { alert(err.message); }
  }));
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const r = await api('/keys', { method: 'POST', body: {
      name: form.get('name'),
      warning_limit_per_hour: Number(form.get('warning_limit_per_hour')) || 60,
      rate_limit_per_hour: Number(form.get('rate_limit_per_hour')) || 120,
    }});
    const tok = $('#key-token');
    tok.classList.remove('hidden');
    tok.textContent = `Token de '${r.name}' (cópialo ahora, no se vuelve a mostrar): ${r.token}`;
    e.target.reset();
    loadKeys();
  } catch (err) { alert(err.message); }
});

// ---------- settings ----------
const SETTING_META = {
  global_hourly_warning: {
    section: 'Límites de envío', label: 'Aviso global', summary: 'Registra que el volumen normal se acerca al corte.',
    detail: [
      'Cantidad de deliveries físicas acumuladas en la última hora a partir de la cual se genera un evento de aviso y un log estructurado.',
      'No bloquea ni suprime SMS. Debe ser menor o igual que la capacidad normal: corte global menos reserva crítica.',
      'Una petición con varios destinatarios o varias partes consume una delivery por cada destinatario y parte.',
    ], min: 1,
  },
  global_hourly_limit: {
    section: 'Límites de envío', label: 'Corte global absoluto', summary: 'Máximo total de deliveries físicas por hora.',
    detail: [
      'Es el techo absoluto para todos los SMS: normales, critical y alertas internas del gateway.',
      'Los mensajes normales dejan de aceptarse antes, al llegar a corte global menos reserva crítica. Los critical pueden usar la reserva restante.',
      'Al alcanzar este valor tampoco se aceptan mensajes critical. Aumentarlo amplía la capacidad total del equipo.',
    ], min: 1,
  },
  critical_hourly_reserve: {
    section: 'Límites de envío', label: 'Reserva crítica', summary: 'Parte del límite global reservada para critical y alertas internas.',
    detail: [
      'Estas deliveries se mantienen libres para que una tormenta de mensajes normales no impida notificar una caída crítica.',
      'Capacidad normal = corte global absoluto menos reserva crítica. Aumentar solo la reserva reduce la capacidad normal; no aumenta el máximo total.',
      'Para ampliar normales y critical al mismo tiempo, aumenta también el corte global absoluto.',
    ], min: 0,
  },
  recipient_hourly_warning: {
    section: 'Límites de envío', label: 'Aviso por destinatario', summary: 'Avisa cuando un número se acerca a su corte individual.',
    detail: [
      'Cuenta deliveries físicas dirigidas al mismo número durante la última hora y genera auditoría/log al alcanzar el valor.',
      'No suprime SMS. Debe ser menor o igual que el corte por destinatario.',
    ], min: 1,
  },
  per_recipient_hourly_limit: {
    section: 'Límites de envío', label: 'Corte por destinatario', summary: 'Máximo normal destinado al mismo número por hora.',
    detail: [
      'Suprime el exceso de mensajes no críticos dirigido a un número concreto, aunque todavía exista capacidad global.',
      'Los mensajes critical se contabilizan, pero pueden superar este corte; siguen sujetos al corte global absoluto.',
    ], min: 1,
  },
  queue_warning_depth: {
    section: 'Guarda de cola', label: 'Aviso de profundidad', summary: 'Avisa cuando la cola empieza a acumular retraso.',
    detail: [
      'Cuenta todas las deliveries queued, retrying y processing. Al alcanzar este valor se registra auditoría y logging, pero todavía se aceptan mensajes.',
      'Debe ser menor o igual que el límite normal de cola. Con el GOIP actual, 20 deliveries representan aproximadamente 4-5 minutos de trabajo.',
    ], min: 1,
  },
  queue_normal_limit: {
    section: 'Guarda de cola', label: 'Límite normal de cola', summary: 'A partir de aquí solo se admiten mensajes critical.',
    detail: [
      'Cuando la cola alcanza esta profundidad, las nuevas deliveries no críticas se suprimen con HTTP 429.',
      'Los mensajes critical todavía pueden usar la reserva de cola. Con el valor 60, la espera acumulada estimada es de 12-15 minutos.',
    ], min: 1,
  },
  queue_critical_reserve: {
    section: 'Guarda de cola', label: 'Reserva critical de cola', summary: 'Espacios adicionales exclusivos para mensajes critical.',
    detail: [
      'Límite absoluto de cola = límite normal más reserva critical. Estos espacios permiten que una tormenta normal no bloquee una alerta urgente.',
      'Cuando también se llena la reserva, el gateway responde HTTP 503 con Retry-After y Atalaya vuelve a intentarlo.',
    ], min: 0,
  },
  queue_warning_oldest_s: {
    section: 'Guarda de cola', label: 'Aviso por antigüedad', summary: 'Avisa si una delivery lista lleva demasiado tiempo esperando.',
    detail: [
      'Se expresa en segundos y mide solo trabajo listo para enviar. Un reintento programado para el futuro no activa por sí solo esta guarda.',
      'El valor inicial de 300 segundos equivale a 5 minutos.',
    ], min: 1,
  },
  queue_hard_oldest_s: {
    section: 'Guarda de cola', label: 'Corte por antigüedad', summary: 'Bloquea normales cuando la cola lista está estancada.',
    detail: [
      'Al alcanzar esta antigüedad se suprimen nuevas deliveries no críticas aunque la cola sea pequeña. Los mensajes critical conservan acceso a su reserva.',
      'El valor inicial de 900 segundos equivale a 15 minutos y debe ser mayor o igual que el aviso.',
    ], min: 1,
  },
  send_gap_ms: {
    section: 'Operación', label: 'Pausa entre SMS', summary: 'Espera mínima entre dos envíos al GOIP, en milisegundos.',
    detail: ['Protege el módem evitando envíos consecutivos demasiado rápidos. No modifica los límites por hora.'], min: 1000,
  },
  poll_ms: {
    section: 'Operación', label: 'Intervalo de cola', summary: 'Frecuencia con que el worker busca SMS pendientes.',
    detail: ['Un valor menor reduce latencia, pero consulta PostgreSQL con mayor frecuencia. Se expresa en milisegundos.'], min: 250,
  },
  max_attempts: {
    section: 'Operación', label: 'Intentos máximos', summary: 'Cantidad máxima de intentos antes de marcar un envío agotado.',
    detail: ['Incluye el primer intento y los reintentos entregados al provider. Busy, GSM logout y consultas de reconciliación no consumen intentos.'], min: 1,
  },
  retry_backoff_s: {
    section: 'Operación', label: 'Espera entre reintentos', summary: 'Secuencia de esperas en segundos, escrita como arreglo JSON.',
    detail: ['Ejemplo: [30, 120, 600] reintenta después de 30 segundos, luego 2 minutos y finalmente 10 minutos.'], type: 'text',
  },
  dedup_window_s: {
    section: 'Operación', label: 'Ventana de deduplicación', summary: 'Tiempo durante el que una dedup_key repetida se suprime.',
    detail: ['La primera notificación se envía inmediatamente. Las repeticiones se cuentan para el panel y no generan nuevas deliveries. Se expresa en segundos.'], min: 0,
  },
  retry_window_s: {
    section: 'Operación', label: 'Ventana máxima de reintento', summary: 'Tiempo máximo para reintentar automáticamente un incidente.',
    detail: ['Se cuenta desde la primera evaluación de la delivery por el worker. Al vencer, queda expired y se conserva; un reintento manual abre una ventana nueva. Valor acordado: 3600 segundos.'], min: 60,
  },
  unavailable_retry_s: {
    section: 'Operación', label: 'Espera si GOIP no está disponible', summary: 'Pausa antes de reevaluar GSM logout o health degradado.',
    detail: ['No consume intentos. Permite que otras deliveries sean evaluadas y comiencen su propia ventana sin intentar transmitir mientras el GOIP está desregistrado.'], min: 1,
  },
  uncertain_poll_s: {
    section: 'Operación', label: 'Consulta de envío incierto', summary: 'Frecuencia de reconciliación del smskey pendiente.',
    detail: ['Mientras exista un uncertain no se envían nuevos SMS, porque el GOIP solo conserva el estado actual de la línea. Se expresa en segundos.'], min: 1,
  },
  uncertain_without_smskey_retry_s: {
    section: 'Operación', label: 'Espera antes de reintento sin smskey', summary: 'Demora antes de un único reintento cuando GOIP no devolvió identificador.',
    detail: [
      'Sin smskey no se puede asociar la delivery con el único estado que conserva el GOIP. Tras esta espera se hace un solo reintento, que puede producir un SMS duplicado.',
      'Si ese segundo intento también queda incierto, se conserva para revisión manual pero ya no bloquea las deliveries posteriores.',
      'Se expresa en segundos. El valor inicial de 60 segundos da tiempo al módem a terminar una solicitud cuya respuesta se perdió.',
    ], min: 10,
  },
  inbound_poll_ms: {
    section: 'Operación', label: 'Consulta de entrantes', summary: 'Frecuencia de lectura del inbox del GOIP.',
    detail: ['Controla cada cuántos milisegundos se consultan SMS entrantes. No afecta el envío de alertas.'], min: 1000,
  },
  api_key_warning: {
    label: 'Aviso por API key', detail: [
      'Cuenta peticiones HTTP recibidas durante la última hora para una API key concreta.',
      'Al alcanzarlo genera auditoría y logging, pero todavía acepta peticiones. Cada petición cuenta una vez aunque produzca varias deliveries.',
    ],
  },
  api_key_limit: {
    label: 'Corte por API key', detail: [
      'Suprime las deliveries no críticas de las peticiones que superen este número por hora para el servicio.',
      'Las peticiones critical se contabilizan, pero pueden superar este corte y siguen sujetas al máximo global absoluto.',
    ],
  },
};
async function loadSettings() {
  const s = await api('/settings');
  const sections = ['Límites de envío', 'Guarda de cola', 'Operación'];
  $('#settings-form').innerHTML = sections.map((section) => `
    <fieldset class="settings-section">
      <h3>${section}</h3>
      ${Object.entries(SETTING_META).filter(([, meta]) => meta.section === section).map(([key, meta]) => `
        <div class="setting-row">
          <div class="setting-copy">
            <div class="setting-label">
              <label for="set-${key}">${meta.label}</label>
              <button type="button" class="info-button" data-setting-info="${key}" aria-label="Información sobre ${meta.label}" title="Más información">i</button>
            </div>
            <p>${meta.summary}</p>
          </div>
          <input id="set-${key}" name="${key}" type="${meta.type || 'number'}"
            ${meta.type === 'text' ? '' : `min="${meta.min}" max="1000000" step="1"`}
            value='${esc(JSON.stringify(s[key]))}'>
        </div>`).join('')}
    </fieldset>`).join('');
  $('#settings-form').querySelectorAll('input').forEach((input) => input.addEventListener('input', updateLimitCapacity));
  updateLimitCapacity();
}

function updateLimitCapacity() {
  const global = Number($('#set-global_hourly_limit')?.value);
  const reserve = Number($('#set-critical_hourly_reserve')?.value);
  const warning = Number($('#set-global_hourly_warning')?.value);
  const queueWarning = Number($('#set-queue_warning_depth')?.value);
  const queueNormal = Number($('#set-queue_normal_limit')?.value);
  const queueReserve = Number($('#set-queue_critical_reserve')?.value);
  const ageWarning = Number($('#set-queue_warning_oldest_s')?.value);
  const ageHard = Number($('#set-queue_hard_oldest_s')?.value);
  if (![global, reserve, warning, queueWarning, queueNormal, queueReserve, ageWarning, ageHard].every(Number.isFinite)) return;
  const normal = global - reserve;
  const queueAbsolute = queueNormal + queueReserve;
  const box = $('#limit-capacity');
  const valid = reserve >= 0 && reserve < global && warning <= normal &&
    queueReserve >= 0 && queueWarning <= queueNormal && ageWarning <= ageHard;
  box.classList.toggle('invalid', !valid);
  box.innerHTML = valid
    ? `Por hora: <strong>${normal} normales + ${reserve} critical = ${global}</strong><br>Cola: <strong>${queueNormal} normales + ${queueReserve} critical = ${queueAbsolute}</strong>`
    : 'Combinación inválida: revisa avisos, cortes y reservas.';
}

function showSettingInfo(key) {
  const meta = SETTING_META[key];
  if (!meta) return;
  $('#setting-info-title').textContent = meta.label;
  $('#setting-info-body').innerHTML = meta.detail.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('');
  $('#setting-info-dialog').showModal();
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-setting-info]') : null;
  if (button) showSettingInfo(button.dataset.settingInfo);
});
$('#setting-info-close').addEventListener('click', () => $('#setting-info-dialog').close());
$('#setting-info-dialog').addEventListener('click', (event) => {
  if (event.target === $('#setting-info-dialog')) $('#setting-info-dialog').close();
});
$('#settings-save').addEventListener('click', async () => {
  const body = {};
  const out = $('#settings-result');
  try {
    for (const input of $('#settings-form').querySelectorAll('input')) body[input.name] = JSON.parse(input.value);
    await api('/settings', { method: 'PUT', body });
    out.textContent = 'guardado ✓';
    setTimeout(() => (out.textContent = ''), 2000);
  } catch (err) { out.textContent = err.message; }
});

$('#settings-reset').addEventListener('click', async () => {
  if (!confirm('¿Restaurar toda la configuración a los valores por defecto?')) return;
  const out = $('#settings-result');
  try {
    await api('/settings/reset', { method: 'POST' });
    await loadSettings();
    out.textContent = 'restaurado ✓';
    setTimeout(() => (out.textContent = ''), 2000);
  } catch (err) { out.textContent = err.message; }
});

// ---------- SSE ----------
let stream = null;
let refreshPending = null;
function startStream() {
  stopStream();
  stream = new EventSource('/admin/api/stream');
  stream.addEventListener('hello', () => $('#live-dot').classList.add('on'));
  stream.addEventListener('change', () => {
    clearTimeout(refreshPending);
    refreshPending = setTimeout(() => refreshTab(activeTab()), 400);
  });
  stream.onerror = () => $('#live-dot').classList.remove('on');
}
function stopStream() { stream?.close(); stream = null; $('#live-dot').classList.remove('on'); }

// ---------- arranque ----------
async function enter() {
  showMain();
  startStream();
  refreshTab(activeTab());
}
api('/me').then(enter).catch(showLogin);
