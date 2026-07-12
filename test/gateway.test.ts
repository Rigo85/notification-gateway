import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from '../src/worker.js';
import {
  authHeaders,
  drainQueue,
  resetData,
  setSetting,
  setupContext,
  teardownContext,
  type TestContext,
} from './helpers.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

let ctx: TestContext;
let worker: Worker;

beforeAll(async () => {
  ctx = await setupContext();
  worker = new Worker(ctx.db, ctx.providers, silentLog);
});

afterAll(async () => {
  await teardownContext(ctx);
});

beforeEach(async () => {
  await resetData(ctx.db, ctx.token);
  ctx.fake.behavior = {};
  ctx.fake.sentJobs.length = 0;
});

async function post(body: object, headers: Record<string, string> = authHeaders(ctx)) {
  return ctx.app.inject({ method: 'POST', url: '/api/notifications', headers, payload: body });
}

describe('autenticación', () => {
  it('401 sin API key', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'x' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('401 con key inválida', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'x' }, { authorization: 'Bearer ngw_falsa' });
    expect(res.statusCode).toBe(401);
  });
});

describe('encolado y envío', () => {
  it('encola y el worker envía (flujo feliz)', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'servicio caído' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.deliveries_queued).toBe(1);

    const processed = await drainQueue(ctx, worker);
    expect(processed).toBe(1);
    expect(ctx.fake.sentJobs).toHaveLength(1);
    expect(ctx.fake.sentJobs[0]?.recipient).toBe('+51987654321');

    const { rows } = await ctx.db.query(
      `SELECT status, sent_at, provider_id FROM deliveries WHERE notification_id = $1`,
      [body.notification_id],
    );
    expect(rows[0].status).toBe('sent');
    expect(rows[0].sent_at).not.toBeNull();
    expect(rows[0].provider_id).toMatch(/^fake-/);
  });

  it('varios destinatarios → una delivery por cada uno, secuenciales', async () => {
    const res = await post({ recipients: ['+51911111111', '+51922222222', '+51933333333'], message: 'alerta' });
    expect(res.json().deliveries_queued).toBe(3);
    expect(await drainQueue(ctx, worker)).toBe(3);
    expect(ctx.fake.sentJobs.map((j) => j.recipient).sort()).toEqual([
      '+51911111111',
      '+51922222222',
      '+51933333333',
    ]);
  });

  it('mensaje largo se divide en deliveries numeradas', async () => {
    const message = 'aviso repetido para forzar division en partes '.repeat(8).trim(); // ~366 chars
    const res = await post({ recipients: ['+51987654321'], message });
    const queued = res.json().deliveries_queued;
    expect(queued).toBeGreaterThan(1);
    await drainQueue(ctx, worker);
    const payloads = ctx.fake.sentJobs.map((j) => j.payload);
    expect(payloads[0]).toMatch(/^1\/\d /);
    expect(payloads.every((p) => p.length <= 160)).toBe(true);
  });

  it('destinatarios inválidos se reportan; todos inválidos → 400', async () => {
    const mixed = await post({ recipients: ['+51987654321', '00000000000'], message: 'x' });
    expect(mixed.json().invalid_recipients).toEqual(['00000000000']);
    expect(mixed.json().deliveries_queued).toBe(1);

    const bad = await post({ recipients: ['00000000000'], message: 'x' });
    expect(bad.statusCode).toBe(400);
  });

  it('prioridad: critical se procesa antes que normal', async () => {
    await post({ recipients: ['+51911111111'], message: 'normal primero en llegar', priority: 'normal' });
    await post({ recipients: ['+51922222222'], message: 'critical despues', priority: 'critical' });
    await worker.runOnce('sms');
    expect(ctx.fake.sentJobs[0]?.recipient).toBe('+51922222222');
  });
});

describe('deduplicación', () => {
  it('segunda notificación con misma dedup_key se suprime', async () => {
    const first = await post({ recipients: ['+51987654321'], message: 'caído', dedup_key: 'svc-down' });
    expect(first.statusCode).toBe(202);
    const second = await post({ recipients: ['+51987654321'], message: 'caído', dedup_key: 'svc-down' });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.status).toBe('suppressed');
    expect(body.reason).toBe('dedup');
    expect(body.suppressed_count).toBe(1);
    expect(body.window_remaining_s).toBeGreaterThan(0);
    expect(body.notification_id).toBe(first.json().notification_id);
  });

  it('dedup_keys distintas no interfieren', async () => {
    await post({ recipients: ['+51987654321'], message: 'a', dedup_key: 'k1' });
    const res = await post({ recipients: ['+51987654321'], message: 'b', dedup_key: 'k2' });
    expect(res.statusCode).toBe(202);
  });
});

describe('límites', () => {
  it('límite por destinatario suprime solo a ese destinatario', async () => {
    await setSetting(ctx.db, 'per_recipient_hourly_limit', 1);
    await post({ recipients: ['+51911111111'], message: 'primera' });
    const res = await post({ recipients: ['+51911111111', '+51922222222'], message: 'segunda' });
    const body = res.json();
    expect(body.deliveries_suppressed).toBe(1);
    expect(body.deliveries_queued).toBe(1);
    const { rows } = await ctx.db.query(
      `SELECT recipient, status, last_error FROM deliveries WHERE notification_id = $1`,
      [body.notification_id],
    );
    const suppressed = rows.find((r) => r.status === 'suppressed');
    expect(suppressed.recipient).toBe('+51911111111');
    expect(suppressed.last_error).toBe('rate_limit:recipient');
  });

  it('límite global suprime todo', async () => {
    await setSetting(ctx.db, 'global_hourly_limit', 1);
    await post({ recipients: ['+51911111111'], message: 'primera' });
    const res = await post({ recipients: ['+51922222222'], message: 'segunda' });
    expect(res.json().status).toBe('suppressed');
    expect(res.json().deliveries_suppressed).toBe(1);
  });

  it('límite de la API key', async () => {
    await ctx.db.query(`UPDATE api_keys SET rate_limit_per_hour = 1 WHERE name = 'test-app'`);
    await post({ recipients: ['+51911111111'], message: 'primera' });
    const res = await post({ recipients: ['+51922222222'], message: 'segunda' });
    const { rows } = await ctx.db.query(
      `SELECT last_error FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0].last_error).toBe('rate_limit:api_key');
  });
});

describe('reintentos y fallos', () => {
  it('fallo retryable → retrying con backoff; agota a exhausted', async () => {
    ctx.fake.behavior = { onSend: () => ({ ok: false, error: 'provider not reply (2172)', retryable: true }) };
    const res = await post({ recipients: ['+51987654321'], message: 'x' });
    const id = res.json().notification_id;

    await worker.runOnce('sms');
    let { rows } = await ctx.db.query(`SELECT status, attempts, next_retry_at FROM deliveries WHERE notification_id = $1`, [id]);
    expect(rows[0].status).toBe('retrying');
    expect(rows[0].attempts).toBe(1);
    expect(new Date(rows[0].next_retry_at).getTime()).toBeGreaterThan(Date.now() + 25_000);

    // adelantar el reloj: forzar reintentos ya
    for (let i = 0; i < 2; i++) {
      await ctx.db.query(`UPDATE deliveries SET next_retry_at = now() WHERE notification_id = $1`, [id]);
      await worker.runOnce('sms');
    }
    ({ rows } = await ctx.db.query(`SELECT status, attempts, last_error FROM deliveries WHERE notification_id = $1`, [id]));
    expect(rows[0].status).toBe('exhausted');
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].last_error).toContain('2172');
  });

  it('fallo no-retryable → failed al primer intento', async () => {
    ctx.fake.behavior = { onSend: () => ({ ok: false, error: 'user or password error', retryable: false }) };
    const res = await post({ recipients: ['+51987654321'], message: 'x' });
    await worker.runOnce('sms');
    const { rows } = await ctx.db.query(`SELECT status, attempts FROM deliveries WHERE notification_id = $1`, [
      res.json().notification_id,
    ]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(1);
  });

  it('recupera deliveries con lock viejo', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'x' });
    await ctx.db.query(
      `UPDATE deliveries SET status = 'processing', locked_at = now() - interval '10 minutes'
       WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    const recovered = await worker.recoverStaleLocks();
    expect(recovered).toBe(1);
    expect(await drainQueue(ctx, worker)).toBe(1);
  });
});

describe('consulta y health', () => {
  it('GET /api/notifications/:id devuelve deliveries', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'consulta' });
    const id = res.json().notification_id;
    await drainQueue(ctx, worker);
    const get = await ctx.app.inject({ method: 'GET', url: `/api/notifications/${id}`, headers: authHeaders(ctx) });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.message).toBe('consulta');
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0].status).toBe('sent');
  });

  it('GET /health reporta db, provider y cola', async () => {
    await post({ recipients: ['+51987654321'], message: 'pendiente' });
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe('ok');
    expect(body.checks.provider_sms.ok).toBe(true);
    expect(body.checks.queue.pending).toBe(1);
  });
});
