import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/admin/session.js';
import {
  authHeaders,
  resetData,
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
      payload: { name: 'nuevo-servicio', rate_limit_per_hour: 5 },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token;
    expect(token).toMatch(/^ngw_/);

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
});
