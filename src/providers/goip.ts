import http from 'node:http';
import type {
  AcceptedCallback,
  ChannelProvider,
  DeliveryJob,
  HealthStatus,
  InboundSms,
  SendResult,
} from './types.js';

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

export type HttpGet = (url: string, authHeader: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>;

// El firmware responde HTTP no estándar (líneas con LF sin CR); undici/fetch lo
// rechaza, así que se usa node:http con insecureHTTPParser.
const defaultHttpGet: HttpGet = (url, authHeader, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { headers: { authorization: authHeader }, insecureHTTPParser: true, timeout: timeoutMs, signal },
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

interface GoipTimings {
  statusPollMs: number;
  statusTimeoutMs: number;
  httpTimeoutMs: number;
}

export class GoipProvider implements ChannelProvider {
  readonly channel = 'sms';
  readonly inboxCapacity = 20;
  private cfg: GoipConfig;
  private authHeader: string;
  private httpGet: HttpGet;
  private timings: GoipTimings;

  constructor(
    cfg: GoipConfig,
    httpGet: HttpGet = defaultHttpGet,
    timings: Partial<GoipTimings> = {},
  ) {
    if (!cfg.baseUrl || !cfg.user || !cfg.password) {
      throw new Error('GoipProvider requiere GOIP_BASE_URL, GOIP_USER y GOIP_PASSWORD');
    }
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') };
    this.authHeader = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    this.httpGet = httpGet;
    this.timings = {
      statusPollMs: timings.statusPollMs ?? STATUS_POLL_MS,
      statusTimeoutMs: timings.statusTimeoutMs ?? STATUS_TIMEOUT_MS,
      httpTimeoutMs: timings.httpTimeoutMs ?? HTTP_TIMEOUT_MS,
    };
  }

  async send(job: DeliveryJob, onAccepted?: AcceptedCallback, signal?: AbortSignal): Promise<SendResult> {
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
    let raw: string;
    try {
      raw = await this.httpText(`${this.cfg.baseUrl}/default/en_US/send.html?${params}`, signal);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(error)) {
        return { outcome: 'unavailable', countsAsAttempt: false, retryAfterMs: 30_000, error };
      }
      return {
        outcome: 'uncertain',
        countsAsAttempt: true,
        error: `resultado incierto al invocar send.html: ${error}`,
      };
    }
    const text = raw.trim();

    if (text.toUpperCase().startsWith('ERROR')) {
      const reason = text.replace(/^ERROR[,:]?\s*/i, '');
      if (/L1 busy/i.test(reason)) {
        return {
          outcome: 'busy', countsAsAttempt: false, retryAfterMs: 5_000,
          error: `GOIP rechazó el envío: ${reason}`, response: { raw: text },
        };
      }
      if (/GSM logout/i.test(reason)) {
        return {
          outcome: 'unavailable', countsAsAttempt: false, retryAfterMs: 30_000,
          error: `GOIP rechazó el envío: ${reason}`, response: { raw: text },
        };
      }
      return {
        outcome: /user or password/i.test(reason) ? 'permanent' : 'temporary',
        countsAsAttempt: true,
        error: `GOIP rechazó el envío: ${reason}`,
        response: { raw: text },
      };
    }

    const idMatch = text.match(/ID:\s*([0-9a-zA-Z]+)/);
    if (!idMatch) {
      return {
        outcome: 'uncertain', countsAsAttempt: true,
        error: `respuesta inesperada del GOIP: ${text}`, response: { raw: text },
      };
    }
    const smskey = idMatch[1]!;
    await onAccepted?.(smskey);

    // poll hasta estado terminal (DONE); el equipo puede pasar por errores
    // intermedios y aun así terminar en DONE (goip-validacion §5.5)
    const deadline = Date.now() + this.timings.statusTimeoutMs;
    let last: Record<string, string> = {};
    while (Date.now() < deadline) {
      await sleep(this.timings.statusPollMs, signal);
      try {
        last = await this.fetchSendStatus(signal);
      } catch {
        continue; // fallo puntual del poll: seguir intentando hasta el deadline
      }
      if (last.smskey1 !== smskey) continue;
      if (last.status1 === 'DONE') {
        return this.doneResult(smskey, last);
      }
    }
    return {
      outcome: 'uncertain',
      countsAsAttempt: true,
      providerId: smskey,
      retryAfterMs: 10_000,
      error: `timeout: el GOIP no reportó DONE en ${this.timings.statusTimeoutMs / 1000}s`,
      response: last,
    };
  }

  async reconcile(providerId: string, signal?: AbortSignal): Promise<SendResult> {
    let status: Record<string, string>;
    try {
      status = await this.fetchSendStatus(signal);
    } catch (err) {
      return {
        outcome: 'uncertain', providerId, countsAsAttempt: false, retryAfterMs: 10_000,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (status.smskey1 !== providerId) {
      return {
        outcome: 'uncertain', providerId, countsAsAttempt: false, retryAfterMs: 10_000,
        error: 'el slot de estado del GOIP ya no corresponde al smskey esperado', response: status,
      };
    }
    if (status.status1 !== 'DONE') {
      return {
        outcome: 'uncertain', providerId, countsAsAttempt: false, retryAfterMs: 10_000,
        error: `GOIP todavía reporta ${status.status1 || 'estado vacío'}`, response: status,
      };
    }
    return this.doneResult(providerId, status, false);
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    try {
      const xml = await this.httpText(`${this.cfg.baseUrl}/default/en_US/status.xml`, signal);
      const gsmUp = stripTags(tag(xml, 'l1_gsm_status')) === 'Y';
      const simOk = stripTags(tag(xml, 'l1_gsm_sim')) === 'Y';
      const signalRaw = stripTags(tag(xml, 'l1_gsm_signal'));
      const signalStrength = Number(signalRaw.match(/\d+/)?.[0] ?? NaN);
      const operator = stripTags(tag(xml, 'l1_gsm_cur_oper'));
      return {
        ok: gsmUp && simOk,
        detail: {
          gsm_registered: gsmUp,
          sim: simOk,
          // 0-31; 99 = desconocida; <10 es débil (el equipo actual ronda 8-9)
          signal: Number.isNaN(signalStrength) ? null : signalStrength,
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
  async fetchInbox(signal?: AbortSignal): Promise<InboundSms[]> {
    const html = await this.httpText(
      `${this.cfg.baseUrl}/default/en_US/tools.html?type=sms_inbox&line=1&pos=-1`,
      signal,
    );
    const literal = extractJsonArrayAssignment(html, 'sms');
    if (!literal) return [];
    let entries: unknown;
    try {
      entries = JSON.parse(literal);
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

  private async fetchSendStatus(signal?: AbortSignal): Promise<Record<string, string>> {
    const xml = await this.httpText(`${this.cfg.baseUrl}/default/en_US/send_sms_status.xml`, signal);
    return {
      smskey1: tag(xml, 'smskey1'),
      status1: tag(xml, 'status1'),
      error1: tag(xml, 'error1'),
    };
  }

  private doneResult(providerId: string, response: Record<string, string>, countsAsAttempt = true): SendResult {
    if (response.error1) {
      return {
        outcome: 'temporary', providerId, countsAsAttempt,
        error: `GOIP reportó error ${response.error1} (no entregado)`, response,
      };
    }
    return { outcome: 'sent', providerId, countsAsAttempt, response };
  }

  private httpText(url: string, signal?: AbortSignal): Promise<string> {
    return this.httpGet(url, this.authHeader, this.timings.httpTimeoutMs, signal);
  }
}

function extractJsonArrayAssignment(source: string, variable: string): string | null {
  const assignment = new RegExp(`\\b${variable}\\s*=`).exec(source);
  if (!assignment) return null;
  const start = source.indexOf('[', assignment.index + assignment[0].length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('operación abortada'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('operación abortada'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
