import dns from 'node:dns/promises';
import net from 'node:net';

export class NetworkValidator {
  private static readonly BLOCKED_IP_RANGES = [
    /^127\./,           // Localhost (127.0.0.0/8)
    /^10\./,            // Class A Private (10.0.0.0/8)
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B Private (172.16.0.0/12)
    /^192\.168\./,      // Class C Private (192.168.0.0/16)
    /^169\.254\./,      // Link-local (Cloud Metadata AWS/GCP 169.254.0.0/16)
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // CGNAT (100.64.0.0/10)
    /^0\./,             // Current network (0.0.0.0/8)
    /^(22[4-9]|23[0-9]|24[0-9]|25[0-5])\./, // Multicast & Reserved (224.0.0.0/3)
    /^::1$/,            // IPv6 Localhost
    /^::$/,             // IPv6 Unspecified
    /^0*:0*:0*:0*:0*:0*:0*:0*1$/i, // Expanded IPv6 Localhost
    /^0*:0*:0*:0*:0*:0*:0*:0*$/i,  // Expanded IPv6 Unspecified
    /^f[cd][0-9a-f]{2}:/i, // IPv6 Unique Local (fc00::/7)
    /^fe[89ab][0-9a-f]:/i, // IPv6 Link Local (fe80::/10)
    /^::ffff:(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|0\.)/i // IPv6-mapped IPv4
  ];

  private static readonly BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata',
    'instance-data'
  ]);

  /**
   * Normalizes IPv6-mapped IPv4 addresses in hex-hextet form (e.g. `::ffff:7f00:1`)
   * into dotted-quad form (`::ffff:127.0.0.1`) so IPv4-mapped regexes and checks apply.
   */
  public static normalizeIp(rawIp: string): string {
    const trimmed = rawIp.trim().replace(/^\[|\]$/g, '').toLowerCase();
    const hexMappedMatch = trimmed.match(/^(?:0*:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMappedMatch) {
      const hi = parseInt(hexMappedMatch[1], 16);
      const lo = parseInt(hexMappedMatch[2], 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      return `::ffff:${a}.${b}.${c}.${d}`;
    }
    const dottedMappedMatch = trimmed.match(/^(?:0*:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (dottedMappedMatch) {
      return `::ffff:${dottedMappedMatch[1]}`;
    }
    return trimmed;
  }

  public static isBlockedIp(rawIp: string): boolean {
    const normalized = this.normalizeIp(rawIp);
    for (const pattern of this.BLOCKED_IP_RANGES) {
      if (pattern.test(normalized) || pattern.test(rawIp)) {
        return true;
      }
    }
    if (normalized.startsWith('::ffff:')) {
      const embeddedIpv4 = normalized.slice('::ffff:'.length);
      for (const pattern of this.BLOCKED_IP_RANGES) {
        if (pattern.test(embeddedIpv4)) {
          return true;
        }
      }
    }
    return false;
  }

  public static async validateSafeTarget(targetUrl: string): Promise<string> {
    if (typeof targetUrl !== 'string' || targetUrl.trim() === '') {
      throw new Error('SSRF Blocked: Invalid target URL.');
    }
    if (targetUrl.includes('\r') || targetUrl.includes('\n')) {
      throw new Error('CRLF Injection detected in URL');
    }

    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('SSRF Blocked: Only HTTPS is allowed.');
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('SSRF Blocked: Credentials in URL are not allowed.');
    }

    const cleanHost = parsedUrl.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.+$/, '')
      .toLowerCase();

    if (!cleanHost) {
      throw new Error('SSRF Blocked: Invalid hostname.');
    }

    if (
      this.BLOCKED_HOSTNAMES.has(cleanHost) ||
      cleanHost.endsWith('.localhost') ||
      cleanHost.endsWith('.internal')
    ) {
      throw new Error(`SSRF Blocked: Target resolves to internal/private IP (${cleanHost})`);
    }

    // Reject octal/hex/integer IPv4 obfuscations (e.g. 2130706433 or 0x7f000001 or 0177.0.0.1)
    if (/^(0x[0-9a-f]+|\d+)$/i.test(cleanHost) || cleanHost.split('.').some((part) => /^0\d+$/.test(part))) {
      throw new Error(`SSRF Blocked: Target resolves to internal/private IP (${cleanHost})`);
    }

    const normalizedHost = this.normalizeIp(cleanHost);
    let addresses: string[] = [];

    if (net.isIP(cleanHost) || net.isIP(normalizedHost)) {
      addresses = [normalizedHost];
    } else {
      try {
        addresses = await dns.resolve(cleanHost);
      } catch {
        throw new Error('SSRF Blocked: Unresolvable hostname.');
      }

      if (!addresses || addresses.length === 0) {
        throw new Error('SSRF Blocked: Unresolvable hostname.');
      }
    }

    for (const ip of addresses) {
      if (this.isBlockedIp(ip)) {
        throw new Error(`SSRF Blocked: Target resolves to internal/private IP (${ip})`);
      }
    }

    return targetUrl;
  }
}
