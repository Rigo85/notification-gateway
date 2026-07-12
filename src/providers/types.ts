export interface DeliveryJob {
  id: string;
  recipient: string;
  payload: string;
  attempts: number;
}

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** false = fallo permanente (no reintentar). Default: true. */
  retryable?: boolean;
  response?: unknown;
}

export interface HealthStatus {
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface InboundSms {
  sender: string;
  body: string;
  /** hora reportada por el equipo (sin año), referencial */
  deviceTime: string;
}

export interface ChannelProvider {
  readonly channel: string;
  send(job: DeliveryJob): Promise<SendResult>;
  health(): Promise<HealthStatus>;
  /** lee los mensajes entrantes visibles (sin consumirlos del equipo) */
  fetchInbox?(): Promise<InboundSms[]>;
}
