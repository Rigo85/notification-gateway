import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GoipProvider } from '../src/providers/goip.js';
import { InboundPoller, inferDeviceReceivedAt } from '../src/inbound.js';
import { hashPassword } from '../src/admin/session.js';
import { resetData, setupContext, teardownContext, type TestContext } from './helpers.js';

const silentLog = { info: () => {}, error: () => {} };

describe('GoipProvider.fetchInbox', () => {
  const CFG = { baseUrl: 'http://goip.test', user: 'admin', password: 'admin' };

  it('parsea el array embebido, respetando comas en el cuerpo', async () => {
    const page = `<html><script>
      sms= ["07-03 12:54:04,+51987654321,prueba","07-03 11:39:01,777,Hola, con comas, tres"];
    </script></html>`;
    const p = new GoipProvider(CFG, async () => page);
    const inbox = await p.fetchInbox();
    expect(inbox).toEqual([
      { deviceTime: '07-03 12:54:04', sender: '+51987654321', body: 'prueba' },
      { deviceTime: '07-03 11:39:01', sender: '777', body: 'Hola, con comas, tres' },
    ]);
  });

  it('inbox vacío o página sin array → lista vacía', async () => {
    const p1 = new GoipProvider(CFG, async () => 'sms= [];');
    expect(await p1.fetchInbox()).toEqual([]);
    const p2 = new GoipProvider(CFG, async () => '<html>sin datos</html>');
    expect(await p2.fetchInbox()).toEqual([]);
  });

  it('preserva comillas, backslashes, Unicode y corchetes del cuerpo', async () => {
    const entries = [
      '07-13 10:20:30,+51987654321,Texto "citado" \\ ruta ] ; á',
      '07-13 10:21:30,777,cuerpo que parece ]; cerrar',
    ];
    const page = `<script>sms=${JSON.stringify(entries)};</script>`;
    const inbox = await new GoipProvider(CFG, async () => page).fetchInbox();
    expect(inbox.map((message) => message.body)).toEqual([
      'Texto "citado" \\ ruta ] ; á',
      'cuerpo que parece ]; cerrar',
    ]);
  });
});

describe('inferDeviceReceivedAt', () => {
  it('infiere el año más cercano en hora Lima y conserva cruces de año', () => {
    expect(inferDeviceReceivedAt('12-31 23:59:00', new Date('2027-01-01T05:01:00Z'))?.toISOString())
      .toBe('2027-01-01T04:59:00.000Z');
    expect(inferDeviceReceivedAt('dato inválido')).toBeNull();
    expect(inferDeviceReceivedAt('02-31 10:00:00')).toBeNull();
  });
});

describe('InboundPoller', () => {
  let ctx: TestContext;
  let poller: InboundPoller;

  beforeAll(async () => {
    ctx = await setupContext();
    poller = new InboundPoller(ctx.db, ctx.providers, silentLog);
  });

  afterAll(async () => {
    await teardownContext(ctx);
  });

  beforeEach(async () => {
    await resetData(ctx.db, ctx.token);
    ctx.fake.inbox = [];
    ctx.fake.inboxCapacity = undefined;
  });

  it('ingiere mensajes nuevos y no duplica al releer', async () => {
    ctx.fake.inbox = [
      { deviceTime: '07-12 10:00:00', sender: '+51911111111', body: 'Test entrada' },
      { deviceTime: '07-12 10:01:00', sender: '777', body: 'spam' },
    ];
    expect(await poller.pollOnce()).toBe(2);
    // segundo poll con el mismo buffer rotativo: nada nuevo
    expect(await poller.pollOnce()).toBe(0);
    // llega uno nuevo, los viejos siguen en el buffer
    ctx.fake.inbox.push({ deviceTime: '07-12 10:05:00', sender: '+51911111111', body: 'otro' });
    expect(await poller.pollOnce()).toBe(1);
    const { rows } = await ctx.db.query('SELECT count(*) AS n FROM inbound_messages');
    expect(Number(rows[0].n)).toBe(3);
    const health = await ctx.db.query(`SELECT last_success_at, last_error FROM service_health WHERE component = 'inbound_poller'`);
    expect(health.rows[0].last_success_at).not.toBeNull();
    expect(health.rows[0].last_error).toBeNull();
  });

  it('marca el health degradable cuando el buffer visible está lleno', async () => {
    ctx.fake.inboxCapacity = 2;
    ctx.fake.inbox = [
      { deviceTime: '07-12 10:00:00', sender: '1', body: 'a' },
      { deviceTime: '07-12 10:01:00', sender: '2', body: 'b' },
    ];
    await poller.pollOnce();
    const health = await ctx.db.query(`SELECT detail FROM service_health WHERE component = 'inbound_poller'`);
    expect(health.rows[0].detail.sms).toMatchObject({ visible: 2, capacity: 2, at_capacity: true });
  });

  it('stop interrumpe inmediatamente una espera larga', async () => {
    await ctx.db.query(`UPDATE settings SET value = '300000' WHERE key = 'inbound_poll_ms'`);
    const local = new InboundPoller(ctx.db, ctx.providers, silentLog);
    local.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(Promise.race([
      local.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ])).resolves.toBe('stopped');
  });

  it('el endpoint /admin/api/inbound lista y filtra por remitente', async () => {
    await ctx.db.query(`INSERT INTO users (username, password_hash) VALUES ('rigo', $1)`, [
      hashPassword('clave-segura'),
    ]);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { username: 'rigo', password: 'clave-segura' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    ctx.fake.inbox = [
      { deviceTime: '07-12 10:00:00', sender: '+51911111111', body: 'mío' },
      { deviceTime: '07-12 10:01:00', sender: '777', body: 'spam claro' },
    ];
    await poller.pollOnce();

    const all = await ctx.app.inject({ method: 'GET', url: '/admin/api/inbound', headers: { cookie } });
    expect(all.json().messages).toHaveLength(2);

    const filtered = await ctx.app.inject({
      method: 'GET',
      url: '/admin/api/inbound?sender=777',
      headers: { cookie },
    });
    expect(filtered.json().messages).toHaveLength(1);
    expect(filtered.json().messages[0].body).toBe('spam claro');

    const noSession = await ctx.app.inject({ method: 'GET', url: '/admin/api/inbound' });
    expect(noSession.statusCode).toBe(401);
  });
});
