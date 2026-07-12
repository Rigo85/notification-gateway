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

export interface ChannelProvider {
  readonly channel: string;
  send(job: DeliveryJob): Promise<SendResult>;
  health(): Promise<HealthStatus>;
}
