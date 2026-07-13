import { describe, expect, it } from 'vitest';
import {
  maxSmsLen,
  normalizeRecipient,
  SmsTextTooLongError,
  splitSmsText,
} from '../src/sms-text.js';

describe('normalizeRecipient', () => {
  it('acepta E.164 con y sin +', () => {
    expect(normalizeRecipient('+51987654321')).toBe('+51987654321');
    expect(normalizeRecipient('51987654321')).toBe('+51987654321');
    expect(normalizeRecipient('51 987 654-321')).toBe('+51987654321');
  });
  it('rechaza basura', () => {
    expect(normalizeRecipient('abc')).toBeNull();
    expect(normalizeRecipient('0123')).toBeNull();
    expect(normalizeRecipient('')).toBeNull();
  });
});

describe('maxSmsLen', () => {
  it('160 para ASCII, 70 con tildes', () => {
    expect(maxSmsLen('hola mundo')).toBe(160);
    expect(maxSmsLen('conexión caída')).toBe(70);
  });
});

describe('splitSmsText', () => {
  it('mensaje corto queda entero', () => {
    expect(splitSmsText('alerta simple')).toEqual([{ payload: 'alerta simple', part: 1, parts: 1 }]);
  });

  it('divide ASCII largo en partes numeradas <=160', () => {
    const text = 'palabra '.repeat(45).trim(); // 359 chars
    const parts = splitSmsText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.payload.length).toBeLessThanOrEqual(160);
      expect(p.payload).toMatch(new RegExp(`^${p.part}/${p.parts} `));
    }
    const rejoined = parts.map((p) => p.payload.replace(/^\d+\/\d+ /, '')).join('');
    expect(rejoined).toBe(text);
  });

  it('divide Unicode largo en partes <=70', () => {
    const text = 'notificación crítica de sistema con acentuación española repetida varias veces para forzar división';
    const parts = splitSmsText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.payload.length).toBeLessThanOrEqual(70);
  });

  it('respeta exactamente los límites 160/161 ASCII y 70/71 Unicode', () => {
    expect(splitSmsText('a'.repeat(160))).toHaveLength(1);
    expect(splitSmsText('a'.repeat(161))).toHaveLength(2);
    expect(splitSmsText('á'.repeat(70))).toHaveLength(1);
    expect(splitSmsText('á'.repeat(71))).toHaveLength(2);
  });

  it('preserva espacios, saltos y palabras mayores que un segmento', () => {
    const text = `  ${'x'.repeat(320)}\n fin  `;
    const parts = splitSmsText(text);
    expect(reconstruct(parts)).toBe(text);
    expect(parts.every((part) => part.payload.length <= 160)).toBe(true);
  });

  it('no divide pares surrogate de emoji', () => {
    const text = `inicio ${'🚨'.repeat(80)} fin`;
    const parts = splitSmsText(text);
    expect(reconstruct(parts)).toBe(text);
    for (const part of parts) {
      expect(part.payload.length).toBeLessThanOrEqual(70);
      expect(hasUnpairedSurrogate(part.payload)).toBe(false);
    }
  });

  it('acepta nueve partes completas y rechaza la décima sin truncar', () => {
    const accepted = 'á'.repeat(9 * 66);
    expect(splitSmsText(accepted)).toHaveLength(9);
    expect(reconstruct(splitSmsText(accepted))).toBe(accepted);
    expect(() => splitSmsText(`${accepted}á`)).toThrow(SmsTextTooLongError);
  });
});

function reconstruct(parts: ReturnType<typeof splitSmsText>): string {
  if (parts.length === 1) return parts[0]!.payload;
  return parts.map((part) => part.payload.replace(/^\d+\/\d+ /, '')).join('');
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
