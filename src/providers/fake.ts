import type { ChannelProvider, DeliveryJob, HealthStatus, InboundSms, SendResult } from './types.js';

export interface FakeBehavior {
  latencyMs?: number;
  /** decide el resultado por job; por defecto siempre éxito */
  onSend?: (job: DeliveryJob) => SendResult;
  onReconcile?: (providerId: string) => SendResult;
  health?: HealthStatus;
}

/** Provider de desarrollo/tests: no envía nada, registra lo que "envió". */
export class FakeProvider implements ChannelProvider {
  readonly channel = 'sms';
  inboxCapacity?: number;
  readonly sentJobs: DeliveryJob[] = [];
  behavior: FakeBehavior;

  constructor(behavior: FakeBehavior = {}) {
    this.behavior = behavior;
  }

  async send(
    job: DeliveryJob,
    onAccepted?: (providerId: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<SendResult> {
    if (this.behavior.latencyMs) {
      await sleep(this.behavior.latencyMs, signal);
    }
    const result = this.behavior.onSend?.(job) ?? {
      outcome: 'sent' as const,
      providerId: `fake-${job.id.slice(0, 8)}`,
      countsAsAttempt: true,
      response: { fake: true },
    };
    if (result.providerId) await onAccepted?.(result.providerId);
    if (result.outcome === 'sent') this.sentJobs.push(job);
    return result;
  }

  async reconcile(providerId: string): Promise<SendResult> {
    return this.behavior.onReconcile?.(providerId) ?? {
      outcome: 'uncertain',
      providerId,
      countsAsAttempt: false,
      retryAfterMs: 10_000,
      error: 'fake: estado aun incierto',
    };
  }

  async health(): Promise<HealthStatus> {
    return this.behavior.health ?? { ok: true, detail: { provider: 'fake' } };
  }

  /** bandeja de entrada simulada: los tests inyectan mensajes aquí */
  inbox: InboundSms[] = [];

  async fetchInbox(): Promise<InboundSms[]> {
    return [...this.inbox];
  }
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
