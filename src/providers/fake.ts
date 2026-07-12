import type { ChannelProvider, DeliveryJob, HealthStatus, SendResult } from './types.js';

export interface FakeBehavior {
  latencyMs?: number;
  /** decide el resultado por job; por defecto siempre éxito */
  onSend?: (job: DeliveryJob) => SendResult;
}

/** Provider de desarrollo/tests: no envía nada, registra lo que "envió". */
export class FakeProvider implements ChannelProvider {
  readonly channel = 'sms';
  readonly sentJobs: DeliveryJob[] = [];
  behavior: FakeBehavior;

  constructor(behavior: FakeBehavior = {}) {
    this.behavior = behavior;
  }

  async send(job: DeliveryJob): Promise<SendResult> {
    if (this.behavior.latencyMs) {
      await new Promise((r) => setTimeout(r, this.behavior.latencyMs));
    }
    const result = this.behavior.onSend?.(job) ?? {
      ok: true,
      providerId: `fake-${job.id.slice(0, 8)}`,
      response: { fake: true },
    };
    if (result.ok) this.sentJobs.push(job);
    return result;
  }

  async health(): Promise<HealthStatus> {
    return { ok: true, detail: { provider: 'fake' } };
  }
}
