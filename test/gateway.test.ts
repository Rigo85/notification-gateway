import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../src/worker.js';
import { enqueueNotification } from '../src/enqueue.js';
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

  it('20 solicitudes concurrentes con la misma dedup_key crean una sola notificación', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => post({
      recipients: ['+51987654321'],
      message: 'misma alerta',
      dedup_key: 'concurrente',
    })));
    expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(19);
    const { rows } = await ctx.db.query(
      `SELECT count(*) AS notifications, max(suppressed_count) AS suppressed FROM notifications`,
    );
    expect(Number(rows[0].notifications)).toBe(1);
    expect(rows[0].suppressed).toBe(19);
    const requests = await ctx.db.query(`SELECT count(*) AS n FROM notification_requests`);
    expect(Number(requests.rows[0].n)).toBe(20);
  });
});

describe('límites', () => {
  it('límite por destinatario suprime solo a ese destinatario', async () => {
    await setSetting(ctx.db, 'recipient_hourly_warning', 1);
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
    await setSetting(ctx.db, 'global_hourly_warning', 1);
    await setSetting(ctx.db, 'global_hourly_limit', 1);
    await setSetting(ctx.db, 'critical_hourly_reserve', 0);
    await post({ recipients: ['+51911111111'], message: 'primera' });
    const res = await post({ recipients: ['+51922222222'], message: 'segunda' });
    expect(res.statusCode).toBe(429);
    expect(res.json().status).toBe('suppressed');
    expect(res.json().deliveries_suppressed).toBe(1);
  });

  it('límite de la API key', async () => {
    await ctx.db.query(
      `UPDATE api_keys SET warning_limit_per_hour = 1, rate_limit_per_hour = 1 WHERE name = 'test-app'`,
    );
    await post({ recipients: ['+51911111111'], message: 'primera' });
    const res = await post({ recipients: ['+51922222222'], message: 'segunda' });
    expect(res.statusCode).toBe(429);
    const { rows } = await ctx.db.query(
      `SELECT last_error FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0].last_error).toBe('rate_limit:api_key');
  });

  it('límite global 1 con 20 solicitudes concurrentes acepta una sola delivery', async () => {
    await setSetting(ctx.db, 'global_hourly_warning', 1);
    await setSetting(ctx.db, 'global_hourly_limit', 1);
    await setSetting(ctx.db, 'critical_hourly_reserve', 0);
    await Promise.all(Array.from({ length: 20 }, (_, i) => post({
      recipients: ['+51987654321'],
      message: `alerta ${i}`,
    })));
    const { rows } = await ctx.db.query(
      `SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
              count(*) FILTER (WHERE status = 'suppressed') AS suppressed
       FROM deliveries`,
    );
    expect(Number(rows[0].queued)).toBe(1);
    expect(Number(rows[0].suppressed)).toBe(19);
  });

  it('límites por API key y destinatario permanecen estrictos bajo concurrencia', async () => {
    await ctx.db.query(
      `UPDATE api_keys SET warning_limit_per_hour = 1, rate_limit_per_hour = 1 WHERE name = 'test-app'`,
    );
    await setSetting(ctx.db, 'recipient_hourly_warning', 1);
    await setSetting(ctx.db, 'per_recipient_hourly_limit', 1);
    await Promise.all(Array.from({ length: 20 }, (_, i) => post({
      recipients: ['+51987654321'],
      message: `petición ${i}`,
    })));
    const { rows } = await ctx.db.query(
      `SELECT count(*) FILTER (WHERE status = 'queued') AS queued FROM deliveries`,
    );
    expect(Number(rows[0].queued)).toBe(1);
    const requests = await ctx.db.query(`SELECT count(*) AS n FROM notification_requests`);
    expect(Number(requests.rows[0].n)).toBe(20);
  });

  it('una petición multipartes consume solo el saldo disponible', async () => {
    await setSetting(ctx.db, 'global_hourly_warning', 1);
    await setSetting(ctx.db, 'global_hourly_limit', 1);
    await setSetting(ctx.db, 'critical_hourly_reserve', 0);
    const res = await post({ recipients: ['+51987654321'], message: 'a'.repeat(161) });
    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries_queued).toBe(1);
    expect(res.json().deliveries_suppressed).toBe(1);
  });

  it('critical omite cortes de API key y destinatario, pero conserva el corte global absoluto', async () => {
    await ctx.db.query(
      `UPDATE api_keys SET warning_limit_per_hour = 1, rate_limit_per_hour = 1 WHERE name = 'test-app'`,
    );
    await setSetting(ctx.db, 'recipient_hourly_warning', 1);
    await setSetting(ctx.db, 'per_recipient_hourly_limit', 1);
    await post({ recipients: ['+51987654321'], message: 'normal' });
    const critical = await post({
      recipients: ['+51987654321'],
      message: 'crítica',
      priority: 'critical',
    });
    expect(critical.json().deliveries_queued).toBe(1);
  });

  it('reserva capacidad global para la alerta interna sin superar el corte absoluto', async () => {
    await setSetting(ctx.db, 'global_hourly_warning', 1);
    await setSetting(ctx.db, 'global_hourly_limit', 3);
    await setSetting(ctx.db, 'critical_hourly_reserve', 1);
    const request = {
      source: 'reserva-test',
      keyWarningRateLimit: 100,
      keyRateLimit: 200,
      recipients: ['+51987654321'],
      message: 'normal',
      channel: 'sms',
      priority: 'normal',
      systemAlertRecipients: ['+51900000001'],
    };
    await enqueueNotification(ctx.db, request);
    await enqueueNotification(ctx.db, { ...request, message: 'normal 2' });
    const limited = await enqueueNotification(ctx.db, { ...request, message: 'normal 3' });
    expect(limited.kind).toBe('created');
    if (limited.kind === 'created') {
      expect(limited.queued).toBe(0);
      expect(limited.suppressed).toBe(1);
    }

    const { rows } = await ctx.db.query(
      `SELECT count(*) FILTER (WHERE status <> 'suppressed') AS physical,
              count(*) FILTER (WHERE status = 'suppressed') AS suppressed
       FROM deliveries`,
    );
    expect(Number(rows[0].physical)).toBe(3);
    expect(Number(rows[0].suppressed)).toBe(1);
    const event = await ctx.db.query(
      `SELECT alert_deliveries FROM rate_limit_events WHERE scope = 'global' AND level = 'hard'`,
    );
    expect(event.rows).toEqual([{ alert_deliveries: 1 }]);

    const absolute = await enqueueNotification(ctx.db, {
      ...request,
      message: 'crítica sin saldo',
      priority: 'critical',
    });
    expect(absolute.kind).toBe('created');
    if (absolute.kind === 'created') expect(absolute.queued).toBe(0);
  });

  it('audita el aviso y genera una sola alerta administrativa por corte y ventana', async () => {
    await ctx.db.query(
      `UPDATE api_keys SET warning_limit_per_hour = 1, rate_limit_per_hour = 1 WHERE name = 'test-app'`,
    );
    const request = {
      source: 'test-app',
      keyWarningRateLimit: 1,
      keyRateLimit: 1,
      recipients: ['+51987654321'],
      message: 'directa',
      channel: 'sms',
      priority: 'normal',
      systemAlertRecipients: ['+51900000001'],
    };
    await enqueueNotification(ctx.db, request);
    await enqueueNotification(ctx.db, { ...request, message: 'exceso 1' });
    await enqueueNotification(ctx.db, { ...request, message: 'exceso 2' });

    const events = await ctx.db.query(
      `SELECT level, alert_deliveries FROM rate_limit_events
       WHERE scope = 'api_key' ORDER BY level`,
    );
    expect(events.rows).toEqual([
      { level: 'hard', alert_deliveries: 1 },
      { level: 'warning', alert_deliveries: 0 },
    ]);
    const alerts = await ctx.db.query(
      `SELECT count(*) AS n FROM notifications WHERE source = 'notification-gateway'`,
    );
    expect(Number(alerts.rows[0].n)).toBe(1);
  });

  it('revierte petición, notificación y deliveries si falla un INSERT', async () => {
    await ctx.db.query(`
      CREATE FUNCTION test_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fallo de prueba'; END $$;
      CREATE TRIGGER test_fail_delivery BEFORE INSERT ON deliveries
      FOR EACH ROW EXECUTE FUNCTION test_fail_delivery();
    `);
    try {
      const res = await post({ recipients: ['+51987654321'], message: 'rollback' });
      expect(res.statusCode).toBe(500);
      const { rows } = await ctx.db.query(
        `SELECT
           (SELECT count(*) FROM notification_requests) AS requests,
           (SELECT count(*) FROM notifications) AS notifications,
           (SELECT count(*) FROM deliveries) AS deliveries`,
      );
      expect(rows[0]).toEqual({ requests: '0', notifications: '0', deliveries: '0' });
    } finally {
      await ctx.db.query('DROP TRIGGER test_fail_delivery ON deliveries');
      await ctx.db.query('DROP FUNCTION test_fail_delivery()');
    }
  });
});

describe('guarda de cola', () => {
  beforeEach(async () => {
    await setSetting(ctx.db, 'queue_warning_depth', 1);
    await setSetting(ctx.db, 'queue_normal_limit', 1);
    await setSetting(ctx.db, 'queue_critical_reserve', 1);
  });

  it('reserva la última posición para critical y responde 429 a normales', async () => {
    expect((await post({ recipients: ['+51987654321'], message: 'normal 1' })).statusCode).toBe(202);
    const blocked = await post({ recipients: ['+51987654321'], message: 'normal 2' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ status: 'suppressed', retryable: false });
    expect(blocked.json().reasons).toContain('queue_limit:reserved');

    const critical = await post({
      recipients: ['+51987654321'], message: 'critical', priority: 'critical',
    });
    expect(critical.statusCode).toBe(202);
    expect(critical.json().deliveries_queued).toBe(1);
  });

  it('responde 503 con Retry-After cuando también se llena la reserva critical', async () => {
    await post({ recipients: ['+51987654321'], message: 'normal' });
    await post({ recipients: ['+51987654321'], message: 'critical 1', priority: 'critical' });
    const full = await post({ recipients: ['+51987654321'], message: 'critical 2', priority: 'critical' });
    expect(full.statusCode).toBe(503);
    expect(full.headers['retry-after']).toBe('60');
    expect(full.json().reasons).toContain('queue_limit:absolute');
  });

  it('un reintento rechazado vuelve a evaluar capacidad y conserva 503 mientras siga llena', async () => {
    await post({ recipients: ['+51987654321'], message: 'normal' });
    await post({ recipients: ['+51987654321'], message: 'critical 1', priority: 'critical' });
    const body = {
      recipients: ['+51987654321'],
      message: 'critical sin espacio',
      priority: 'critical',
      dedup_key: 'queue-full-critical',
    };
    expect((await post(body)).statusCode).toBe(503);
    const duplicate = await post(body);
    expect(duplicate.statusCode).toBe(503);
    const { rows } = await ctx.db.query(
      `SELECT count(*) AS n FROM notifications WHERE dedup_key = 'queue-full-critical'`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it('un reintento critical entra cuando se libera capacidad', async () => {
    await post({ recipients: ['+51987654321'], message: 'normal' });
    const occupied = await post({
      recipients: ['+51987654321'], message: 'critical 1', priority: 'critical',
    });
    const body = {
      recipients: ['+51987654321'],
      message: 'critical reintentable',
      priority: 'critical',
      dedup_key: 'queue-retry-critical',
    };
    expect((await post(body)).statusCode).toBe(503);
    await ctx.db.query(
      `UPDATE deliveries SET status = 'sent', sent_at = now(), finished_at = now()
       WHERE notification_id = $1`,
      [occupied.json().notification_id],
    );
    const retried = await post(body);
    expect(retried.statusCode).toBe(202);
    expect(retried.json().deliveries_queued).toBe(1);
  });

  it('el corte por antigüedad bloquea normales, pero no critical', async () => {
    await setSetting(ctx.db, 'queue_normal_limit', 60);
    await setSetting(ctx.db, 'queue_hard_oldest_s', 900);
    const initial = await post({ recipients: ['+51987654321'], message: 'vieja' });
    await ctx.db.query(
      `UPDATE deliveries SET created_at = now() - interval '16 minutes'
       WHERE notification_id = $1`,
      [initial.json().notification_id],
    );
    const normal = await post({ recipients: ['+51987654321'], message: 'normal nueva' });
    expect(normal.statusCode).toBe(429);
    expect(normal.json().reasons).toContain('queue_limit:age');
    const critical = await post({
      recipients: ['+51987654321'], message: 'critical nueva', priority: 'critical',
    });
    expect(critical.statusCode).toBe(202);
  });

  it('un retrying futuro no activa por sí solo el corte de antigüedad', async () => {
    await setSetting(ctx.db, 'queue_normal_limit', 60);
    const initial = await post({ recipients: ['+51987654321'], message: 'retry futuro' });
    await ctx.db.query(
      `UPDATE deliveries SET status = 'retrying', created_at = now() - interval '20 minutes',
         next_retry_at = now() + interval '10 minutes'
       WHERE notification_id = $1`,
      [initial.json().notification_id],
    );
    const normal = await post({ recipients: ['+51987654321'], message: 'normal permitida' });
    expect(normal.statusCode).toBe(202);
  });

  it('el límite de cola permanece estricto con 20 solicitudes concurrentes', async () => {
    await setSetting(ctx.db, 'queue_critical_reserve', 0);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post({
      recipients: ['+51987654321'], message: `cola ${i}`,
    })));
    expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(19);
    const { rows } = await ctx.db.query(
      `SELECT count(*) FILTER (WHERE status = 'queued') AS queued FROM deliveries`,
    );
    expect(Number(rows[0].queued)).toBe(1);
  });

  it('la alerta administrativa usa la reserva sin recursión', async () => {
    const request = {
      source: 'queue-test',
      keyWarningRateLimit: 100,
      keyRateLimit: 200,
      recipients: ['+51987654321'],
      message: 'normal',
      channel: 'sms',
      priority: 'normal',
      systemAlertRecipients: ['+51900000001'],
    };
    await enqueueNotification(ctx.db, request);
    await enqueueNotification(ctx.db, { ...request, message: 'exceso' });
    const { rows } = await ctx.db.query(
      `SELECT count(*) FILTER (WHERE status <> 'suppressed') AS physical,
              count(*) FILTER (WHERE status = 'suppressed') AS suppressed
       FROM deliveries`,
    );
    expect(rows[0]).toEqual({ physical: '2', suppressed: '1' });
    const event = await ctx.db.query(
      `SELECT alert_deliveries FROM rate_limit_events
       WHERE scope = 'queue' AND scope_key = 'sms:depth' AND level = 'hard'`,
    );
    expect(event.rows).toEqual([{ alert_deliveries: 1 }]);
  });
});

describe('longitud máxima', () => {
  it('rechaza más de nueve partes antes de insertar', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'á'.repeat(595) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('máximo de 9 SMS');
    const { rows } = await ctx.db.query(
      `SELECT (SELECT count(*) FROM notification_requests) AS requests,
              (SELECT count(*) FROM notifications) AS notifications`,
    );
    expect(rows[0]).toEqual({ requests: '0', notifications: '0' });
  });
});

describe('reintentos y fallos', () => {
  it('fallo retryable → retrying con backoff; agota a exhausted', async () => {
    ctx.fake.behavior = { onSend: () => ({
      outcome: 'temporary', countsAsAttempt: true, error: 'provider not reply (2172)',
    }) };
    const res = await post({ recipients: ['+51987654321'], message: 'x' });
    const id = res.json().notification_id;

    await worker.runOnce('sms');
    let { rows } = await ctx.db.query(
      `SELECT status, attempts, next_retry_at, send_started_at, submitted_at, provider_id
       FROM deliveries WHERE notification_id = $1`, [id],
    );
    expect(rows[0].status).toBe('retrying');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0]).toMatchObject({ send_started_at: null, submitted_at: null, provider_id: null });
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
    ctx.fake.behavior = { onSend: () => ({
      outcome: 'permanent', countsAsAttempt: true, error: 'user or password error',
    }) };
    const res = await post({ recipients: ['+51987654321'], message: 'x' });
    await worker.runOnce('sms');
    const { rows } = await ctx.db.query(`SELECT status, attempts FROM deliveries WHERE notification_id = $1`, [
      res.json().notification_id,
    ]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(1);
  });

  it('busy no consume intento y conserva la ventana inicial', async () => {
    ctx.fake.behavior = { onSend: () => ({
      outcome: 'busy', countsAsAttempt: false, retryAfterMs: 1_000, error: 'L1 busy',
    }) };
    const res = await post({ recipients: ['+51987654321'], message: 'busy' });
    await worker.runOnce('sms');
    const { rows } = await ctx.db.query(
      `SELECT status, attempts, first_attempt_at, send_started_at FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0]).toMatchObject({ status: 'retrying', attempts: 0 });
    expect(rows[0].first_attempt_at).not.toBeNull();
    expect(rows[0].send_started_at).toBeNull();
  });

  it('health GSM caído no invoca send ni consume intento; al volver envía', async () => {
    let sends = 0;
    ctx.fake.behavior = {
      health: { ok: false, detail: { gsm_registered: false, signal: 99 } },
      onSend: () => {
        sends++;
        return { outcome: 'sent', countsAsAttempt: true, providerId: 'recovered' };
      },
    };
    const res = await post({ recipients: ['+51987654321'], message: 'espera GSM' });
    await worker.runOnce('sms');
    expect(sends).toBe(0);
    let { rows } = await ctx.db.query(
      `SELECT status, attempts, first_attempt_at FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0]).toMatchObject({ status: 'retrying', attempts: 0 });
    expect(rows[0].first_attempt_at).not.toBeNull();

    ctx.fake.behavior.health = { ok: true };
    await ctx.db.query(`UPDATE deliveries SET next_retry_at = now() WHERE notification_id = $1`, [res.json().notification_id]);
    await worker.runOnce('sms');
    ({ rows } = await ctx.db.query(
      `SELECT status, attempts FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    ));
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect(sends).toBe(1);
  });

  it('al cumplir una hora queda expired y conserva el registro sin enviar', async () => {
    ctx.fake.behavior = { health: { ok: false, detail: { gsm_registered: false } } };
    const res = await post({ recipients: ['+51987654321'], message: 'incidente antiguo' });
    await worker.runOnce('sms');
    await ctx.db.query(
      `UPDATE deliveries SET first_attempt_at = now() - interval '61 minutes', next_retry_at = now()
       WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    ctx.fake.behavior = {};
    await worker.runOnce('sms');
    const { rows } = await ctx.db.query(
      `SELECT status, attempts, last_error FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0]).toMatchObject({ status: 'expired', attempts: 0 });
    expect(rows[0].last_error).toContain('ventana de reintento');
    expect(ctx.fake.sentJobs).toHaveLength(0);
  });

  it('uncertain pausa el canal y se reconcilia por smskey sin duplicar', async () => {
    let reconciled = false;
    ctx.fake.behavior = {
      onSend: () => ({
        outcome: 'uncertain', countsAsAttempt: true, providerId: 'late-key', retryAfterMs: 1,
        error: 'sin DONE',
      }),
      onReconcile: (providerId) => reconciled
        ? { outcome: 'sent', countsAsAttempt: false, providerId }
        : { outcome: 'uncertain', countsAsAttempt: false, providerId, retryAfterMs: 1, error: 'STARTED' },
    };
    const first = await post({ recipients: ['+51987654321'], message: 'primera' });
    const second = await post({ recipients: ['+51987654321'], message: 'segunda' });
    await worker.runOnce('sms');
    await ctx.db.query(`UPDATE deliveries SET next_retry_at = now() WHERE notification_id = $1`, [first.json().notification_id]);
    await worker.runOnce('sms');
    let { rows } = await ctx.db.query(
      `SELECT n.message, d.status, d.attempts FROM deliveries d
       JOIN notifications n ON n.id = d.notification_id ORDER BY n.created_at`,
    );
    expect(rows).toEqual([
      { message: 'primera', status: 'uncertain', attempts: 1 },
      { message: 'segunda', status: 'queued', attempts: 0 },
    ]);

    reconciled = true;
    await ctx.db.query(`UPDATE deliveries SET next_retry_at = now() WHERE notification_id = $1`, [first.json().notification_id]);
    await worker.runOnce('sms');
    ctx.fake.behavior = {};
    await worker.runOnce('sms');
    ({ rows } = await ctx.db.query(
      `SELECT n.message, d.status, d.attempts FROM deliveries d
       JOIN notifications n ON n.id = d.notification_id ORDER BY n.created_at`,
    ));
    expect(rows).toEqual([
      { message: 'primera', status: 'sent', attempts: 1 },
      { message: 'segunda', status: 'sent', attempts: 1 },
    ]);
    expect(second.statusCode).toBe(202);
  });

  it('uncertain sin smskey se reintenta una vez y luego no bloquea el canal', async () => {
    let firstAttempts = 0;
    ctx.fake.behavior = {
      onSend: (job) => {
        if (job.payload === 'sin smskey') {
          firstAttempts++;
          return { outcome: 'uncertain', countsAsAttempt: true, error: 'respuesta perdida' };
        }
        return { outcome: 'sent', countsAsAttempt: true, providerId: 'second-ok' };
      },
    };
    const first = await post({ recipients: ['+51987654321'], message: 'sin smskey' });
    const second = await post({ recipients: ['+51987654321'], message: 'continúa cola' });

    await worker.runOnce('sms');
    await ctx.db.query(`UPDATE deliveries SET next_retry_at = now() WHERE notification_id = $1`, [first.json().notification_id]);
    await worker.runOnce('sms'); // libera el único reintento
    await worker.runOnce('sms'); // segundo intento del incierto
    await worker.runOnce('sms'); // la siguiente delivery ya no queda bloqueada

    const { rows } = await ctx.db.query(
      `SELECT n.message, d.status, d.attempts, d.provider_response
       FROM deliveries d JOIN notifications n ON n.id = d.notification_id ORDER BY n.created_at`,
    );
    expect(rows[0]).toMatchObject({ message: 'sin smskey', status: 'uncertain', attempts: 2 });
    expect(rows[0].provider_response).toMatchObject({ uncertain_without_smskey_first_error: 'respuesta perdida' });
    expect(rows[1]).toMatchObject({ message: 'continúa cola', status: 'sent', attempts: 1 });
    expect(firstAttempts).toBe(2);
    expect(await worker.runOnce('sms')).toBe(false);
    expect(firstAttempts).toBe(2);
    expect(second.statusCode).toBe(202);
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

  it('stop interrumpe los sleeps del worker sin esperar el ciclo de 60 segundos', async () => {
    const local = new Worker(ctx.db, ctx.providers, silentLog);
    local.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(Promise.race([
      local.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ])).resolves.toBe('stopped');
  });

  it('lock viejo ya aceptado pasa a uncertain y no se reenvía', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'aceptada antes del crash' });
    await ctx.db.query(
      `UPDATE deliveries SET status = 'processing', locked_at = now() - interval '10 minutes',
         provider_id = 'crash-key', submitted_at = now() - interval '10 minutes', first_attempt_at = now() - interval '10 minutes'
       WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(await worker.recoverStaleLocks()).toBe(1);
    const { rows } = await ctx.db.query(
      `SELECT status, attempts, provider_id FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0]).toEqual({ status: 'uncertain', attempts: 1, provider_id: 'crash-key' });
  });

  it('lock viejo iniciado sin smskey pasa a uncertain y no se reenvía', async () => {
    const res = await post({ recipients: ['+51987654321'], message: 'crash durante send.html' });
    await ctx.db.query(
      `UPDATE deliveries SET status = 'processing', locked_at = now() - interval '10 minutes',
         send_started_at = now() - interval '10 minutes', first_attempt_at = now() - interval '10 minutes'
       WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(await worker.recoverStaleLocks()).toBe(1);
    const { rows } = await ctx.db.query(
      `SELECT status, attempts, provider_id, last_error FROM deliveries WHERE notification_id = $1`,
      [res.json().notification_id],
    );
    expect(rows[0]).toMatchObject({ status: 'uncertain', attempts: 1, provider_id: null });
    expect(rows[0].last_error).toContain('interrumpido durante el envío');
    expect(ctx.fake.sentJobs).toHaveLength(0);
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
    expect(body.checks.queue).toMatchObject({ state: 'ok', ready: 1, absolute_limit: 80 });
  });

  it('GET /health se degrada cuando la cola queda solo para critical', async () => {
    await setSetting(ctx.db, 'queue_warning_depth', 1);
    await setSetting(ctx.db, 'queue_normal_limit', 1);
    await setSetting(ctx.db, 'queue_critical_reserve', 1);
    await post({ recipients: ['+51987654321'], message: 'ocupa capacidad normal' });
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().checks.queue).toMatchObject({
      state: 'critical_only', pending: 1, normal_limit: 1, absolute_limit: 2,
    });
  });

  it('GET /health conserva el diagnóstico si PostgreSQL no responde', async () => {
    const query = vi.spyOn(ctx.db, 'query').mockRejectedValue(new Error('db unavailable'));
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    query.mockRestore();

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().checks.db).toContain('db unavailable');
    expect(res.json().checks.queue).toMatchObject({ state: 'unknown' });
  });

  it('GET /health se degrada si el poller de entrantes queda obsoleto', async () => {
    await ctx.db.query(
      `UPDATE service_health SET last_success_at = now() - interval '10 minutes',
         last_error_at = NULL, last_error = NULL, detail = '{}' WHERE component = 'inbound_poller'`,
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.inbound_poller).toMatchObject({ state: 'degraded' });
    expect(res.json().ok).toBe(false);
  });

  it('GET /health se degrada si el poller nunca completa su primer ciclo', async () => {
    await ctx.db.query(
      `UPDATE service_health SET last_success_at = NULL, last_error_at = NULL,
         updated_at = now() - interval '10 minutes' WHERE component = 'inbound_poller'`,
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.json().checks.inbound_poller).toMatchObject({ state: 'degraded', last_success_at: null });
    expect(res.json().ok).toBe(false);
  });
});
