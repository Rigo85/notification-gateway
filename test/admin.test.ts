import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/admin/session.js';
import {
  authHeaders,
  resetData,
  setSetting,
  setupContext,
  teardownContext,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let cookie: string;

beforeAll(async () => {
  ctx = await setupContext();
});

afterAll(async () => {
  await teardownContext(ctx);
});

async function createAdminAndLogin(): Promise<string> {
  await ctx.db.query(`INSERT INTO users (username, password_hash) VALUES ('rigo', $1)`, [
    hashPassword('clave-segura'),
  ]);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { username: 'rigo', password: 'clave-segura' },
  });
  const setCookie = res.headers['set-cookie'];
  return String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;
}

beforeEach(async () => {
  await resetData(ctx.db, ctx.token);
  cookie = await createAdminAndLogin();
});

const withSession = () => ({ cookie });

describe('sesión del panel', () => {
  it('login correcto entrega cookie y /me responde', async () => {
    const me = await ctx.app.inject({ method: 'GET', url: '/admin/api/me', headers: withSession() });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe('rigo');
  });

  it('password incorrecta → 401; sin sesión → 401', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { username: 'rigo', password: 'incorrecta' },
    });
    expect(bad.statusCode).toBe(401);
    const noSession = await ctx.app.inject({ method: 'GET', url: '/admin/api/overview' });
    expect(noSession.statusCode).toBe(401);
  });

  it('cookie adulterada → 401', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/api/me',
      headers: { cookie: 'ngw_session=eyJmYWtlIjp0cnVlfQ.firma-falsa' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('overview y listado', () => {
  it('overview cuenta estados y trae recientes', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: authHeaders(ctx),
      payload: { recipients: ['+51987654321'], message: 'para overview' },
    });
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/api/overview', headers: withSession() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.last24h.queued).toBe(1);
    expect(body.recent[0].message).toBe('para overview');
    expect(body.providers.sms.ok).toBe(true);
    expect(body.queue).toMatchObject({ pendingTotal: 1, ready: 1, state: 'ok', absoluteLimit: 80 });
  });

  it('listado filtra por estado', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: authHeaders(ctx),
      payload: { recipients: ['+51987654321'], message: 'en cola' },
    });
    const queued = await ctx.app.inject({
      method: 'GET',
      url: '/admin/api/notifications?status=queued',
      headers: withSession(),
    });
    expect(queued.json().notifications).toHaveLength(1);
    const sent = await ctx.app.inject({
      method: 'GET',
      url: '/admin/api/notifications?status=sent',
      headers: withSession(),
    });
    expect(sent.json().notifications).toHaveLength(0);
  });

  it('listado resume uncertain como pendiente, unresolved separado y expired como fallido', async () => {
    const first = await ctx.app.inject({
      method: 'POST', url: '/api/notifications', headers: authHeaders(ctx),
      payload: { recipients: ['+51987654321'], message: 'incierta' },
    });
    const second = await ctx.app.inject({
      method: 'POST', url: '/api/notifications', headers: authHeaders(ctx),
      payload: { recipients: ['+51987654322'], message: 'expirada' },
    });
    const third = await ctx.app.inject({
      method: 'POST', url: '/api/notifications', headers: authHeaders(ctx),
      payload: { recipients: ['+51987654323'], message: 'desconocida' },
    });
    await ctx.db.query(`UPDATE deliveries SET status = 'uncertain' WHERE notification_id = $1`, [first.json().notification_id]);
    await ctx.db.query(`UPDATE deliveries SET status = 'expired' WHERE notification_id = $1`, [second.json().notification_id]);
    await ctx.db.query(`UPDATE deliveries SET status = 'unresolved' WHERE notification_id = $1`, [third.json().notification_id]);

    const res = await ctx.app.inject({ method: 'GET', url: '/admin/api/notifications', headers: withSession() });
    const uncertain = res.json().notifications.find((item: { message: string }) => item.message === 'incierta');
    const expired = res.json().notifications.find((item: { message: string }) => item.message === 'expirada');
    const unresolved = res.json().notifications.find((item: { message: string }) => item.message === 'desconocida');
    expect(uncertain).toMatchObject({ pending: '1', failed: '0' });
    expect(expired).toMatchObject({ pending: '0', failed: '1' });
    expect(unresolved).toMatchObject({ pending: '0', unresolved: '1', failed: '0' });
  });
});

describe('acciones sobre deliveries', () => {
  async function makeDelivery(status: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: authHeaders(ctx),
      payload: { recipients: ['+51987654321'], message: 'accionable' },
    });
    const { rows } = await ctx.db.query(
      `UPDATE deliveries SET status = $2 WHERE notification_id = $1 RETURNING id`,
      [res.json().notification_id, status],
    );
    return rows[0].id;
  }

  it('retry repone una exhausted a queued con intentos en cero', async () => {
    const id = await makeDelivery('exhausted');
    const res = await ctx.app.inject({ method: 'POST', url: `/admin/api/deliveries/${id}/retry`, headers: withSession() });
    expect(res.statusCode).toBe(200);
    const { rows } = await ctx.db.query('SELECT status, attempts FROM deliveries WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('retry sobre una sent → 409', async () => {
    const id = await makeDelivery('sent');
    const res = await ctx.app.inject({ method: 'POST', url: `/admin/api/deliveries/${id}/retry`, headers: withSession() });
    expect(res.statusCode).toBe(409);
  });

  it('cancel sobre una queued → cancelled', async () => {
    const id = await makeDelivery('queued');
    const res = await ctx.app.inject({ method: 'POST', url: `/admin/api/deliveries/${id}/cancel`, headers: withSession() });
    expect(res.statusCode).toBe(200);
    const { rows } = await ctx.db.query('SELECT status FROM deliveries WHERE id = $1', [id]);
    expect(rows[0].status).toBe('cancelled');
  });
});

describe('API keys y settings', () => {
  it('crear key devuelve token una vez y la key funciona', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/admin/api/keys',
      headers: withSession(),
      payload: { name: 'nuevo-servicio', warning_limit_per_hour: 3, rate_limit_per_hour: 5 },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token;
    expect(token).toMatch(/^ngw_/);
    const keys = await ctx.app.inject({ method: 'GET', url: '/admin/api/keys', headers: withSession() });
    expect(keys.json().keys[0]).toMatchObject({ warning_limit_per_hour: 3, rate_limit_per_hour: 5 });

    const use = await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: { recipients: ['+51987654321'], message: 'con key nueva' },
    });
    expect(use.statusCode).toBe(202);
  });

  it('revocar una key la deja inservible', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/admin/api/keys',
      headers: withSession(),
      payload: { name: 'revocable' },
    });
    const { id, token } = created.json();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/api/keys/${id}`,
      headers: withSession(),
      payload: { enabled: false },
    });
    const use = await ctx.app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${token}` },
      payload: { recipients: ['+51987654321'], message: 'no debería' },
    });
    expect(use.statusCode).toBe(401);
  });

  it('actualiza aviso y corte de una API key existente', async () => {
    const { rows } = await ctx.db.query(`SELECT id FROM api_keys WHERE name = 'test-app'`);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/api/keys/${rows[0].id}`,
      headers: withSession(),
      payload: { warning_limit_per_hour: 200, rate_limit_per_hour: 400 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ warning_limit_per_hour: 200, rate_limit_per_hour: 400 });
  });

  it('rechaza límites incoherentes de una API key sin modificarla', async () => {
    const { rows } = await ctx.db.query(
      `SELECT id, warning_limit_per_hour, rate_limit_per_hour FROM api_keys WHERE name = 'test-app'`,
    );
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/api/keys/${rows[0].id}`,
      headers: withSession(),
      payload: { warning_limit_per_hour: 500, rate_limit_per_hour: 100 },
    });
    expect(res.statusCode).toBe(400);
    const after = await ctx.db.query(
      `SELECT warning_limit_per_hour, rate_limit_per_hour FROM api_keys WHERE id = $1`,
      [rows[0].id],
    );
    expect(after.rows[0]).toMatchObject({
      warning_limit_per_hour: rows[0].warning_limit_per_hour,
      rate_limit_per_hour: rows[0].rate_limit_per_hour,
    });
  });

  it('PUT settings cambia el comportamiento (dedup_window_s)', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: withSession(),
      payload: { dedup_window_s: 5, campo_prohibido: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dedup_window_s).toBe(5);
    expect(res.json()).not.toHaveProperty('campo_prohibido');
  });

  it('actualiza límites relacionados en una sola operación', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: withSession(),
      payload: {
        global_hourly_warning: 300,
        global_hourly_limit: 500,
        critical_hourly_reserve: 20,
        recipient_hourly_warning: 200,
        per_recipient_hourly_limit: 400,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      global_hourly_warning: 300,
      global_hourly_limit: 500,
      critical_hourly_reserve: 20,
      recipient_hourly_warning: 200,
      per_recipient_hourly_limit: 400,
    });
  });

  it('rechaza relaciones inválidas y no modifica ningún límite', async () => {
    const before = await ctx.db.query(
      `SELECT key, value FROM settings
       WHERE key IN ('global_hourly_warning', 'global_hourly_limit', 'critical_hourly_reserve')`,
    );
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: withSession(),
      payload: { global_hourly_warning: 230, global_hourly_limit: 240, critical_hourly_reserve: 20 },
    });
    expect(res.statusCode).toBe(400);
    const after = await ctx.db.query(
      `SELECT key, value FROM settings
       WHERE key IN ('global_hourly_warning', 'global_hourly_limit', 'critical_hourly_reserve')`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('valida conjuntamente profundidad, reserva y antigüedad de cola', async () => {
    const valid = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: withSession(),
      payload: {
        queue_warning_depth: 30,
        queue_normal_limit: 80,
        queue_critical_reserve: 20,
        queue_warning_oldest_s: 600,
        queue_hard_oldest_s: 1200,
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ queue_normal_limit: 80, queue_critical_reserve: 20 });

    const invalid = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: withSession(),
      payload: { queue_warning_depth: 90, queue_normal_limit: 80 },
    });
    expect(invalid.statusCode).toBe(400);
    const settings = await ctx.app.inject({ method: 'GET', url: '/admin/api/settings', headers: withSession() });
    expect(settings.json()).toMatchObject({ queue_warning_depth: 30, queue_normal_limit: 80 });
  });

  it('rechaza settings operativos fuera de rango o backoff insuficiente', async () => {
    for (const payload of [
      { send_gap_ms: 999 },
      { poll_ms: 100 },
      { retry_window_s: 30 },
      { max_attempts: 4, retry_backoff_s: [10, 20] },
      { inbound_poll_ms: 999 },
    ]) {
      const res = await ctx.app.inject({
        method: 'PUT', url: '/admin/api/settings', headers: withSession(), payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('reset de settings restaura los valores por defecto', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: withSession(),
      payload: { dedup_window_s: 5, send_gap_ms: 9999 },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/api/settings/reset',
      headers: withSession(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dedup_window_s).toBe(900);
    expect(res.json().send_gap_ms).toBe(3000);
    expect(res.json()).toMatchObject({ queue_normal_limit: 60, queue_critical_reserve: 20 });
  });

  it('test-send encola con source panel-test', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/api/test-send',
      headers: withSession(),
      payload: { recipient: '+51987654321', message: 'prueba desde panel' },
    });
    expect(res.statusCode).toBe(202);
    const { rows } = await ctx.db.query(`SELECT source FROM notifications WHERE message = 'prueba desde panel'`);
    expect(rows[0].source).toBe('panel-test');
  });

  it('test-send devuelve 429 si la guarda de cola lo suprime', async () => {
    await setSetting(ctx.db, 'queue_warning_depth', 1);
    await setSetting(ctx.db, 'queue_normal_limit', 1);
    await setSetting(ctx.db, 'queue_critical_reserve', 0);
    await ctx.app.inject({
      method: 'POST', url: '/admin/api/test-send', headers: withSession(),
      payload: { recipient: '+51987654321', message: 'ocupa cola' },
    });
    const blocked = await ctx.app.inject({
      method: 'POST', url: '/admin/api/test-send', headers: withSession(),
      payload: { recipient: '+51987654321', message: 'sin capacidad' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().reasons).toContain('queue_limit:reserved');
  });

  it('resuelve uncertain o unresolved manualmente y retry de expired abre una ventana nueva', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/admin/api/test-send', headers: withSession(),
      payload: { recipient: '+51987654321', message: 'incierta' },
    });
    expect(created.statusCode).toBe(202);
    const notificationId = created.json().notificationId;
    const delivery = await ctx.db.query(
      `UPDATE deliveries SET status = 'uncertain', first_attempt_at = now() - interval '2 hours',
         provider_id = 'manual-key' WHERE notification_id = $1 RETURNING id`,
      [notificationId],
    );
    const id = delivery.rows[0].id;
    const resolved = await ctx.app.inject({
      method: 'POST', url: `/admin/api/deliveries/${id}/resolve-uncertain`, headers: withSession(),
      payload: { status: 'failed' },
    });
    expect(resolved.statusCode).toBe(200);
    await ctx.db.query(`UPDATE deliveries SET status = 'unresolved' WHERE id = $1`, [id]);
    const resolvedUnresolved = await ctx.app.inject({
      method: 'POST', url: `/admin/api/deliveries/${id}/resolve-uncertain`, headers: withSession(),
      payload: { status: 'sent' },
    });
    expect(resolvedUnresolved.statusCode).toBe(200);
    await ctx.db.query(`UPDATE deliveries SET status = 'expired' WHERE id = $1`, [id]);
    const retried = await ctx.app.inject({
      method: 'POST', url: `/admin/api/deliveries/${id}/retry`, headers: withSession(),
    });
    expect(retried.statusCode).toBe(200);
    const { rows } = await ctx.db.query(
      `SELECT status, attempts, first_attempt_at, send_started_at, provider_id FROM deliveries WHERE id = $1`, [id],
    );
    expect(rows[0]).toEqual({
      status: 'queued', attempts: 0, first_attempt_at: null, send_started_at: null, provider_id: null,
    });
  });
});
