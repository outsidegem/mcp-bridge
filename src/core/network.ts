import dns from 'node:dns/promises';
import net from 'node:net';

export class NetworkValidator {
  private static readonly BLOCKED_IP_RANGES = [
    /^127\./,           // Localhost
    /^10\./,            // Class A Private
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B Private
    /^192\.168\./,      // Class C Private
    /^169\.254\./,      // Link-local (Cloud Metadata AWS/GCP)
    /^0\./,             // Current network
    /^::1$/,            // IPv6 Localhost
    /^fc00:/,           // IPv6 Unique Local
    /^fe80:/            // IPv6 Link Local
  ];

  public static async validateSafeTarget(targetUrl: string): Promise<string> {
    if (targetUrl.includes('\r') || targetUrl.includes('\n')) {
      throw new Error('CRLF Injection detected in URL');
    }

    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('SSRF Blocked: Only HTTPS is allowed.');
    }

    let addresses: string[] = [];

    // If the hostname is already an IP address, skip DNS resolution
    if (net.isIP(parsedUrl.hostname)) {
      addresses = [parsedUrl.hostname];
    } else {
      // Resolve domain to IP to prevent DNS rebinding attacks
      try {
        addresses = await dns.resolve(parsedUrl.hostname);
      } catch (e) {
        throw new Error('SSRF Blocked: Unresolvable hostname.');
      }
      
      if (!addresses || addresses.length === 0) {
        throw new Error('SSRF Blocked: Unresolvable hostname.');
      }
    }

    for (const ip of addresses) {
      for (const pattern of this.BLOCKED_IP_RANGES) {
        if (pattern.test(ip)) {
          throw new Error(`SSRF Blocked: Target resolves to internal/private IP (${ip})`);
        }
      }
    }
    return targetUrl;
  }
}
