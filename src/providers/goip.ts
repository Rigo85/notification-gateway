import http from 'node:http';
import type { ChannelProvider, DeliveryJob, HealthStatus, InboundSms, SendResult } from './types.js';

// Provider para GoIP-1 (firmware GHSFVT-1.1-67, Hybertone).
// Comportamiento validado con el equipo real — ver goip-validacion §3, §5:
//  - envío: GET send.html → "Sending,L1 Send SMS to:NUM; ID:xxxx" o "ERROR,<motivo>"
//  - estado: send_sms_status.xml, terminal cuando status1=DONE
//    (error1 vacío = enviado; error1 con código, p.ej. 2172 = NO se entregó)
//  - sin cola interna ("L1 busy"): el worker serial garantiza un envío a la vez
//  - "GSM logout": módulo desregistrado, se recupera solo en ~2 min

export interface GoipConfig {
  baseUrl: string;
  user: string;
  password: string;
}

export type HttpGet = (url: string, authHeader: string, timeoutMs: number) => Promise<string>;

// El firmware responde HTTP no estándar (líneas con LF sin CR); undici/fetch lo
// rechaza, así que se usa node:http con insecureHTTPParser.
const defaultHttpGet: HttpGet = (url, authHeader, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { headers: { authorization: authHeader }, insecureHTTPParser: true, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GOIP HTTP ${res.statusCode} en ${new URL(url).pathname}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`GOIP timeout tras ${timeoutMs} ms`)));
  });

const STATUS_POLL_MS = 2000;
const STATUS_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;

export class GoipProvider implements ChannelProvider {
  readonly channel = 'sms';
  private cfg: GoipConfig;
  private authHeader: string;
  private httpGet: HttpGet;

  constructor(cfg: GoipConfig, httpGet: HttpGet = defaultHttpGet) {
    if (!cfg.baseUrl || !cfg.user || !cfg.password) {
      throw new Error('GoipProvider requiere GOIP_BASE_URL, GOIP_USER y GOIP_PASSWORD');
    }
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') };
    this.authHeader = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    this.httpGet = httpGet;
  }

  async send(job: DeliveryJob): Promise<SendResult> {
    // Quirk del firmware (verificado 2026-07-12): un mensaje que EMPIEZA con '['
    // falla siempre con error 500; con '[' en medio del texto funciona.
    const payload = job.payload.startsWith('[') ? `.${job.payload}` : job.payload;
    const params = new URLSearchParams({
      u: this.cfg.user,
      p: this.cfg.password,
      l: '1',
      n: job.recipient.replace(/^\+/, ''),
      m: payload,
    });
    const raw = await this.httpText(`${this.cfg.baseUrl}/default/en_US/send.html?${params}`);
    const text = raw.trim();

    if (text.toUpperCase().startsWith('ERROR')) {
      const reason = text.replace(/^ERROR[,:]?\s*/i, '');
      return {
        ok: false,
        error: `GOIP rechazó el envío: ${reason}`,
        // credenciales mal = permanente; "L1 busy" / "GSM logout" = transitorios
        retryable: !/user or password/i.test(reason),
        response: { raw: text },
      };
    }

    const idMatch = text.match(/ID:\s*([0-9a-zA-Z]+)/);
    if (!idMatch) {
      return { ok: false, error: `respuesta inesperada del GOIP: ${text}`, retryable: true, response: { raw: text } };
    }
    const smskey = idMatch[1]!;

    // poll hasta estado terminal (DONE); el equipo puede pasar por errores
    // intermedios y aun así terminar en DONE (goip-validacion §5.5)
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    let last: Record<string, string> = {};
    while (Date.now() < deadline) {
      await sleep(STATUS_POLL_MS);
      try {
        last = await this.fetchSendStatus();
      } catch {
        continue; // fallo puntual del poll: seguir intentando hasta el deadline
      }
      if (last.smskey1 !== smskey) continue;
      if (last.status1 === 'DONE') {
        if (last.error1) {
          return {
            ok: false,
            providerId: smskey,
            error: `GOIP reportó error ${last.error1} (no entregado)`,
            retryable: true,
            response: last,
          };
        }
        return { ok: true, providerId: smskey, response: last };
      }
    }
    return {
      ok: false,
      providerId: smskey,
      error: `timeout: el GOIP no reportó DONE en ${STATUS_TIMEOUT_MS / 1000}s`,
      retryable: true,
      response: last,
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const xml = await this.httpText(`${this.cfg.baseUrl}/default/en_US/status.xml`);
      const gsmUp = stripTags(tag(xml, 'l1_gsm_status')) === 'Y';
      const simOk = stripTags(tag(xml, 'l1_gsm_sim')) === 'Y';
      const signalRaw = stripTags(tag(xml, 'l1_gsm_signal'));
      const signal = Number(signalRaw.match(/\d+/)?.[0] ?? NaN);
      const operator = stripTags(tag(xml, 'l1_gsm_cur_oper'));
      return {
        ok: gsmUp && simOk,
        detail: {
          gsm_registered: gsmUp,
          sim: simOk,
          // 0-31; 99 = desconocida; <10 es débil (el equipo actual ronda 8-9)
          signal: Number.isNaN(signal) ? null : signal,
          operator,
        },
      };
    } catch (err) {
      return { ok: false, detail: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /**
   * Inbox del equipo: la página embebe los mensajes en un array JS
   * `sms= ["MM-DD HH:MM:SS,remitente,cuerpo", ...]` (goip-validacion §3.3).
   * El cuerpo puede contener comas: solo se cortan las 2 primeras.
   * Lectura pura; la dedup la hace el poller con hash persistente.
   */
  async fetchInbox(): Promise<InboundSms[]> {
    const html = await this.httpText(
      `${this.cfg.baseUrl}/default/en_US/tools.html?type=sms_inbox&line=1&pos=-1`,
    );
    const match = html.match(/sms\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!match) return [];
    let entries: unknown;
    try {
      entries = JSON.parse(match[1]!);
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];
    const result: InboundSms[] = [];
    for (const raw of entries) {
      if (typeof raw !== 'string') continue;
      const c1 = raw.indexOf(',');
      const c2 = raw.indexOf(',', c1 + 1);
      if (c1 < 0 || c2 < 0) continue;
      result.push({
        deviceTime: raw.slice(0, c1).trim(),
        sender: raw.slice(c1 + 1, c2).trim(),
        body: raw.slice(c2 + 1),
      });
    }
    return result;
  }

  private async fetchSendStatus(): Promise<Record<string, string>> {
    const xml = await this.httpText(`${this.cfg.baseUrl}/default/en_US/send_sms_status.xml`);
    return {
      smskey1: tag(xml, 'smskey1'),
      status1: tag(xml, 'status1'),
      error1: tag(xml, 'error1'),
    };
  }

  private httpText(url: string): Promise<string> {
    return this.httpGet(url, this.authHeader, HTTP_TIMEOUT_MS);
  }
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return (m?.[1] ?? '').trim();
}

function stripTags(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
