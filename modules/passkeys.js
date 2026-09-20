// ShareWeb Native WebAuthn & Passkeys Client Module
// Supports Touch ID, Face ID, Windows Hello, and FIDO2 Security Keys

export function base64urlToBuffer(base64url) {
  if (!base64url) return new ArrayBuffer(0);
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const atobFn = typeof window !== 'undefined' && window.atob ? window.atob.bind(window) : globalThis.atob;
  const rawData = atobFn(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer;
}

export function bufferToBase64url(buffer) {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const btoaFn = typeof window !== 'undefined' && window.btoa ? window.btoa.bind(window) : globalThis.btoa;
  const base64 = btoaFn(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Check if platform authenticators (Touch ID, Face ID, Windows Hello) are supported */
export async function isPasskeySupported() {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
  if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
    return false;
  }
  try {
    const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return Boolean(available);
  } catch {
    return false;
  }
}

/** Start WebAuthn registration ceremony */
export async function registerPasskey(name = '') {
  const res = await fetch('/api/auth/passkey/register-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to get passkey registration options');
  }
  const options = await res.json();

  options.challenge = base64urlToBuffer(options.challenge);
  options.user.id = base64urlToBuffer(options.user.id);
  if (options.excludeCredentials) {
    options.excludeCredentials = options.excludeCredentials.map((cred) => ({
      ...cred,
      id: base64urlToBuffer(cred.id),
    }));
  }

  const credential = await navigator.credentials.create({ publicKey: options });
  if (!credential) throw new Error('Passkey creation was cancelled');

  const body = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    name: name || undefined,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64url(credential.response.attestationObject),
      transports: typeof credential.response.getTransports === 'function' ? credential.response.getTransports() : undefined,
    },
  };

  const verifyRes = await fetch('/api/auth/passkey/register-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) {
    throw new Error(data.error || 'Failed to verify passkey registration');
  }
  return data;
}

/** Start WebAuthn authentication / login ceremony */
export async function authenticatePasskey(email, token = '') {
  const res = await fetch('/api/auth/passkey/login-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to get passkey login options');
  }
  const options = await res.json();

  options.challenge = base64urlToBuffer(options.challenge);
  if (options.allowCredentials) {
    options.allowCredentials = options.allowCredentials.map((cred) => ({
      ...cred,
      id: base64urlToBuffer(cred.id),
    }));
  }

  const assertion = await navigator.credentials.get({ publicKey: options });
  if (!assertion) throw new Error('Passkey verification was cancelled');

  const body = {
    email,
    token: token || undefined,
    response: {
      id: assertion.id,
      rawId: bufferToBase64url(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
        authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
        signature: bufferToBase64url(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufferToBase64url(assertion.response.userHandle) : null,
      },
    },
  };

  const verifyRes = await fetch('/api/auth/passkey/login-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) {
    throw new Error(data.error || 'Passkey authentication failed');
  }
  return data;
}

/** Fetch all passkeys for the current account */
export async function getAccountPasskeys() {
  const res = await fetch('/api/account/passkeys');
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return data.passkeys || [];
}

/** Delete a passkey by ID */
export async function deleteAccountPasskey(id) {
  const res = await fetch(`/api/account/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  return data.ok;
}
