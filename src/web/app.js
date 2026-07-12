/* Panel del notification-gateway — vanilla JS, sin dependencias. */
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(`/admin/api${path}`, {
    headers: { 'content-type': 'application/json' },
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
  const pending = (s.queued ?? 0) + (s.retrying ?? 0) + (s.processing ?? 0);
  const failed = (s.failed ?? 0) + (s.exhausted ?? 0);
  $('#counters').innerHTML =
    counterCard('Enviados (24 h)', s.sent ?? 0, 'ok') +
    counterCard('En cola', pending, pending ? 'warn' : '') +
    counterCard('Fallidos (24 h)', failed, failed ? 'err' : '') +
    counterCard('Suprimidos (24 h)', s.suppressed ?? 0);
  $('#provider-health').innerHTML = Object.entries(data.providers).map(([ch, h]) => {
    const d = h.detail || {};
    if (d.provider === 'fake') return counterCard(`Canal ${ch}`, 'fake', 'warn');
    if (!h.ok) {
      const reason = d.error ? 'inalcanzable' : d.gsm_registered === false ? 'sin registro GSM' : d.sim === false ? 'sin SIM' : 'caído';
      return counterCard(`GOIP · canal ${ch}`, `✗ ${reason}`, 'err');
    }
    return signalCard(ch, d);
  }).join('');
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
        <td><span class="badge ${['sent','delivered'].includes(d.status) ? 'sent' : ['failed','exhausted'].includes(d.status) ? 'failed' : ['queued','retrying','processing'].includes(d.status) ? 'pending' : 'suppressed'}">${d.status}</span></td>
        <td>${d.attempts}</td>
        <td class="msg" title="${esc(d.last_error ?? '')}">${esc(d.last_error ?? '—')}</td>
        <td>${fmtDate(d.sent_at)}</td>
        <td class="actions">
          ${['failed','exhausted','cancelled','suppressed'].includes(d.status) ? `<button data-act="retry" data-id="${d.id}">Reintentar</button>` : ''}
          ${['queued','retrying'].includes(d.status) ? `<button data-act="cancel" data-id="${d.id}" class="ghost">Cancelar</button>` : ''}
        </td>
      </tr>`).join('')}
    </tbody></table>`;
  box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await api(`/deliveries/${btn.dataset.id}/${btn.dataset.act}`, { method: 'POST' });
      showDetail(id);
    } catch (err) { alert(err.message); }
  }));
  box.scrollIntoView({ behavior: 'smooth' });
}

// ---------- API keys ----------
async function loadKeys() {
  const data = await api('/keys');
  $('#keys-table tbody').innerHTML = data.keys.map((k) => `
    <tr>
      <td>${esc(k.name)}</td><td>${k.rate_limit_per_hour}</td>
      <td>${fmtDate(k.last_used_at)}</td>
      <td><span class="badge ${k.enabled ? 'sent' : 'failed'}">${k.enabled ? 'activa' : 'revocada'}</span></td>
      <td class="actions"><button data-id="${k.id}" data-en="${!k.enabled}" class="ghost">
        ${k.enabled ? 'Revocar' : 'Reactivar'}</button></td>
    </tr>`).join('');
  $('#keys-table tbody').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
    await api(`/keys/${btn.dataset.id}`, { method: 'PATCH', body: { enabled: btn.dataset.en === 'true' } });
    loadKeys();
  }));
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const r = await api('/keys', { method: 'POST', body: {
      name: form.get('name'),
      rate_limit_per_hour: Number(form.get('rate_limit_per_hour')) || 20,
    }});
    const tok = $('#key-token');
    tok.classList.remove('hidden');
    tok.textContent = `Token de '${r.name}' (cópialo ahora, no se vuelve a mostrar): ${r.token}`;
    e.target.reset();
    loadKeys();
  } catch (err) { alert(err.message); }
});

// ---------- settings ----------
const SETTING_LABELS = {
  send_gap_ms: 'Pausa entre SMS (ms)',
  poll_ms: 'Intervalo de poll (ms)',
  max_attempts: 'Intentos máximos',
  retry_backoff_s: 'Backoff de reintentos (s, JSON)',
  dedup_window_s: 'Ventana de dedup (s)',
  global_hourly_limit: 'Límite global por hora',
  per_recipient_hourly_limit: 'Límite por destinatario/hora',
};
async function loadSettings() {
  const s = await api('/settings');
  $('#settings-form').innerHTML = Object.entries(SETTING_LABELS).map(([key, label]) => `
    <label for="set-${key}">${label}</label>
    <input id="set-${key}" name="${key}" value='${esc(JSON.stringify(s[key]))}'>`).join('');
}
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
