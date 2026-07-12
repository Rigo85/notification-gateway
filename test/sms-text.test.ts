import { describe, expect, it } from 'vitest';
import { maxSmsLen, normalizeRecipient, splitSmsText } from '../src/sms-text.js';

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
    const rejoined = parts.map((p) => p.payload.replace(/^\d+\/\d+ /, '')).join(' ');
    expect(rejoined).toBe(text);
  });

  it('divide Unicode largo en partes <=70', () => {
    const text = 'notificación crítica de sistema con acentuación española repetida varias veces para forzar división';
    const parts = splitSmsText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.payload.length).toBeLessThanOrEqual(70);
  });
});
