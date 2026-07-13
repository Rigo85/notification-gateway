export interface DeliveryJob {
  id: string;
  recipient: string;
  payload: string;
  attempts: number;
}

export type SendOutcome =
  | 'sent'
  | 'busy'
  | 'unavailable'
  | 'temporary'
  | 'permanent'
  | 'uncertain';

export interface SendResult {
  outcome: SendOutcome;
  providerId?: string;
  error?: string;
  /** Indica si hubo una entrega real al provider que consume un intento. */
  countsAsAttempt: boolean;
  retryAfterMs?: number;
  response?: unknown;
}

export type AcceptedCallback = (providerId: string) => Promise<void>;

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
  send(job: DeliveryJob, onAccepted?: AcceptedCallback, signal?: AbortSignal): Promise<SendResult>;
  /** Reconsulta un envio previamente aceptado sin volver a enviarlo. */
  reconcile?(providerId: string, signal?: AbortSignal): Promise<SendResult>;
  health(signal?: AbortSignal): Promise<HealthStatus>;
  /** lee los mensajes entrantes visibles (sin consumirlos del equipo) */
  fetchInbox?(signal?: AbortSignal): Promise<InboundSms[]>;
  /** Capacidad visible del buffer entrante, si el equipo la expone como límite fijo. */
  inboxCapacity?: number;
}
