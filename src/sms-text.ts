// División de mensajes en SMS independientes.
//
// Regla derivada de la validación con el GOIP real (goip-validacion §5.4/5.7):
// los concatenados largos tumbaron el módulo GSM, así que el gateway divide
// él mismo y envía SMS separados numerados, nunca delega concatenación.
//
// Límites conservadores: 160 si el texto es ASCII puro (GSM-7 seguro),
// 70 si lleva tildes/ñ/emoji (el equipo pasa a UCS-2).

const ASCII_RE = /^[\x20-\x7E\r\n]*$/;

export function maxSmsLen(text: string): number {
  return ASCII_RE.test(text) ? 160 : 70;
}

export interface SmsPart {
  payload: string;
  part: number;
  parts: number;
}

export function splitSmsText(text: string): SmsPart[] {
  const clean = text.trim();
  const limit = maxSmsLen(clean);
  if (clean.length <= limit) return [{ payload: clean, part: 1, parts: 1 }];

  // Reservar espacio para el prefijo "i/N " (máx. "9/9 " = 4 chars; tope 9 partes)
  const chunkLimit = limit - 4;
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < 9) {
    if (rest.length <= chunkLimit) {
      chunks.push(rest);
      break;
    }
    // cortar en el último espacio dentro del límite si existe
    let cut = rest.lastIndexOf(' ', chunkLimit);
    if (cut < chunkLimit * 0.5) cut = chunkLimit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  // si quedó texto tras 9 partes, se trunca (un SMS de alerta jamás debería llegar aquí)
  return chunks.map((payload, i) => ({
    payload: `${i + 1}/${chunks.length} ${payload}`,
    part: i + 1,
    parts: chunks.length,
  }));
}

// E.164 laxo: dígitos con + opcional, 7-15 dígitos, sin 0 inicial.
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

export function normalizeRecipient(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (!PHONE_RE.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}
