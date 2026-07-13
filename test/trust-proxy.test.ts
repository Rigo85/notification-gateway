import { describe, expect, it } from 'vitest';
import { parseTrustedProxies } from '../src/trust-proxy.js';

describe('parseTrustedProxies', () => {
  it('desactiva proxy trust por defecto o con false', () => {
    expect(parseTrustedProxies(undefined)).toBe(false);
    expect(parseTrustedProxies('false')).toBe(false);
  });

  it('acepta solo la lista explícita de IPs/CIDR', () => {
    expect(parseTrustedProxies('10.10.0.3, 127.0.0.1/32')).toEqual(['10.10.0.3', '127.0.0.1/32']);
  });

  it('rechaza el booleano global true', () => {
    expect(() => parseTrustedProxies('true')).toThrow('no se permite confiar en cualquier origen');
  });
});
