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

export class SmsTextTooLongError extends Error {
  readonly maxParts = 9;

  constructor() {
    super('El mensaje excede el máximo de 9 SMS');
  }
}

export function splitSmsText(text: string): SmsPart[] {
  const limit = maxSmsLen(text);
  if (smsUnits(text) <= limit) return [{ payload: text, part: 1, parts: 1 }];

  for (let expectedParts = 2; expectedParts <= 9; expectedParts++) {
    const chunks = splitForPartCount(text, limit, expectedParts);
    if (chunks && chunks.length === expectedParts) {
      return chunks.map((chunk, i) => ({
        payload: `${i + 1}/${expectedParts} ${chunk}`,
        part: i + 1,
        parts: expectedParts,
      }));
    }
  }

  throw new SmsTextTooLongError();
}

function splitForPartCount(text: string, limit: number, expectedParts: number): string[] | null {
  const chunks: string[] = [];
  let offset = 0;
  for (let i = 1; i <= expectedParts && offset < text.length; i++) {
    const prefix = `${i}/${expectedParts} `;
    const capacity = limit - smsUnits(prefix);
    const end = chunkEnd(text, offset, capacity);
    if (end <= offset) return null;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return offset === text.length ? chunks : null;
}

function chunkEnd(text: string, start: number, capacity: number): number {
  let units = 0;
  let end = start;
  let lastWhitespaceEnd = -1;

  for (const char of text.slice(start)) {
    const nextUnits = units + smsUnits(char);
    if (nextUnits > capacity) break;
    units = nextUnits;
    end += char.length;
    if (/\s/u.test(char)) lastWhitespaceEnd = end;
  }

  if (end === text.length) return end;
  if (lastWhitespaceEnd > start && lastWhitespaceEnd - start >= (end - start) / 2) {
    return lastWhitespaceEnd;
  }
  return end;
}

function smsUnits(text: string): number {
  // En modo conservador UCS-2, un carácter fuera del BMP ocupa dos unidades.
  let units = 0;
  for (const char of text) units += char.length;
  return units;
}

// E.164 laxo: dígitos con + opcional, 7-15 dígitos, sin 0 inicial.
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

export function normalizeRecipient(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (!PHONE_RE.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}
