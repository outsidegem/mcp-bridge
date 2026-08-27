export interface CredentialProvider {
  resolve(credentialRef: string): Promise<string | undefined>;
}

export class EnvironmentCredentialProvider implements CredentialProvider {
  async resolve(credentialRef: string): Promise<string | undefined> {
    const secret = process.env[credentialRef];
    if (!secret) {
      console.warn(`[AUDIT] Credential resolution failed for ref: ${credentialRef}`);
    }
    return secret;
  }
}
