export function parseTrustedProxies(value: string | undefined): false | string[] {
  const raw = value?.trim();
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') {
    throw new Error('TRUST_PROXY debe listar IPs/CIDR concretos; no se permite confiar en cualquier origen');
  }
  const proxies = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (proxies.length === 0) throw new Error('TRUST_PROXY no contiene ninguna IP/CIDR válida');
  return proxies;
}
