import { describe, expect, it } from 'vitest';
import { GoipProvider } from '../src/providers/goip.js';

const CFG = { baseUrl: 'http://goip.test', user: 'admin', password: 'admin' };
const JOB = { id: 'd1', recipient: '+51987654321', payload: 'alerta', attempts: 0 };

function statusXml(smskey: string, status: string, error = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?><send-sms-status>
    <smskey1>${smskey}</smskey1><status1>${status}</status1><error1>${error}</error1>
  </send-sms-status>`;
}

function provider(handler: (url: string) => string): GoipProvider {
  return new GoipProvider(CFG, async (url) => handler(url));
}

describe('GoipProvider.send', () => {
  it('flujo feliz: Sending → DONE sin error', async () => {
    const p = provider((url) =>
      url.includes('send.html')
        ? '\nSending,L1 Send SMS to:51987654321; ID:6a52acc8\n'
        : statusXml('6a52acc8', 'DONE'),
    );
    const result = await p.send(JOB);
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('6a52acc8');
  });

  it('envía el número sin + y el payload URL-encoded', async () => {
    let sendUrl = '';
    const p = provider((url) => {
      if (url.includes('send.html')) {
        sendUrl = url;
        return 'Sending,L1 Send SMS to:51987654321; ID:abc123';
      }
      return statusXml('abc123', 'DONE');
    });
    await p.send({ ...JOB, payload: 'conexión caída' });
    expect(sendUrl).toContain('n=51987654321');
    expect(sendUrl).not.toContain('n=%2B');
    expect(sendUrl).toContain('m=conexi%C3%B3n+ca%C3%ADda');
  });

  it('corchete inicial se antepone con punto (quirk del firmware: 500)', async () => {
    let sendUrl = '';
    const p = provider((url) => {
      if (url.includes('send.html')) {
        sendUrl = url;
        return 'Sending,L1 Send SMS to:51987654321; ID:q1';
      }
      return statusXml('q1', 'DONE');
    });
    await p.send({ ...JOB, payload: '[PM2] algo paso' });
    expect(sendUrl).toContain('m=.%5BPM2%5D');
  });

  it('L1 busy → fallo retryable', async () => {
    const result = await provider(() => 'ERROR,L1 busy').send(JOB);
    expect(result.ok).toBe(false);
    expect(result.retryable).not.toBe(false);
    expect(result.error).toContain('L1 busy');
  });

  it('GSM logout → fallo retryable', async () => {
    const result = await provider(() => 'ERROR,L1 GSM logout').send(JOB);
    expect(result.ok).toBe(false);
    expect(result.retryable).not.toBe(false);
  });

  it('credenciales malas → fallo permanente', async () => {
    const result = await provider(() => 'ERROR,user or password error').send(JOB);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('DONE con código de error (2172) → fallo retryable, NO entregado', async () => {
    const p = provider((url) =>
      url.includes('send.html')
        ? 'Sending,L1 Send SMS to:51987654321; ID:6a52d52c'
        : statusXml('6a52d52c', 'DONE', '2172'),
    );
    const result = await p.send(JOB);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2172');
    expect(result.retryable).not.toBe(false);
  });

  it('espera pasando por estados intermedios hasta DONE', async () => {
    let polls = 0;
    const p = provider((url) => {
      if (url.includes('send.html')) return 'Sending,L1 Send SMS to:51987654321; ID:k1';
      polls++;
      return polls < 3 ? statusXml('k1', 'STARTED') : statusXml('k1', 'DONE');
    });
    const result = await p.send(JOB);
    expect(result.ok).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(3);
  }, 15_000);
});

describe('GoipProvider.health', () => {
  it('parsea status.xml del firmware real (con font tags escapados)', async () => {
    const p = provider(
      () => `<?xml version="1.0" encoding="gb2312"?><status>
        <l1_gsm_sim>Y</l1_gsm_sim>
        <l1_gsm_status>Y</l1_gsm_status>
        <l1_gsm_signal>&lt;font color="#FF0000">9&lt;/font></l1_gsm_signal>
        <l1_gsm_cur_oper>CLARO PER</l1_gsm_cur_oper>
      </status>`,
    );
    const h = await p.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatchObject({ gsm_registered: true, sim: true, signal: 9, operator: 'CLARO PER' });
  });

  it('módulo desregistrado → not ok', async () => {
    const p = provider(
      () => `<status>
        <l1_gsm_sim>Y</l1_gsm_sim>
        <l1_gsm_status>&lt;font color="#FF0000">N&lt;/font></l1_gsm_status>
        <l1_gsm_signal>&lt;font color="#FF0000">99&lt;/font></l1_gsm_signal>
        <l1_gsm_cur_oper></l1_gsm_cur_oper>
      </status>`,
    );
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.detail?.signal).toBe(99);
  });

  it('GOIP inalcanzable → not ok con error', async () => {
    const p = provider(() => {
      throw new Error('ECONNREFUSED');
    });
    const h = await p.health();
    expect(h.ok).toBe(false);
  });
});
