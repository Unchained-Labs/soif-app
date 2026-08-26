import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for source credentials.
 *
 * The dashboard asks operators for an admin-scoped API key. That key is the
 * primary risk in this codebase — larger than anything the estimates can get
 * wrong — so it is sealed at rest under a per-source data key, which is itself
 * wrapped by a master key that never enters the database.
 *
 *   plaintext --AES-256-GCM(DEK)--> ciphertext
 *   DEK       --AES-256-GCM(KEK)--> wrapped DEK      (stored beside the ciphertext)
 *   KEK       from SOIF_ENCRYPTION_KEY               (never stored)
 *
 * Per-source DEKs mean compromising one row does not decrypt the others, and
 * rotating the master key rewraps a small key rather than re-encrypting every
 * secret.
 *
 * The sealed form carries a key id so a rotation can be staged: new writes seal
 * under the new key while old rows still decrypt under the old one.
 */

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretError extends Error {
  constructor(message: string) {
    // Never interpolate plaintext, ciphertext, or key material into this.
    super(message);
    this.name = "SecretError";
  }
}

export interface MasterKey {
  id: string;
  key: Buffer;
}

/**
 * Load the master key from the environment.
 *
 * Accepts base64 or hex, and requires a full 32 bytes — a short passphrase
 * stretched by a hash would look like it worked while offering far less
 * entropy than the format implies.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): MasterKey {
  const raw = env.SOIF_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new SecretError(
      "SOIF_ENCRYPTION_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = decodeKey(raw);
  if (key.length !== KEY_BYTES) {
    throw new SecretError(
      `SOIF_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate a fresh one rather than padding a passphrase.",
    );
  }
  return { id: keyId(key), key };
}

/** Short, non-reversible fingerprint used to tag which key sealed a value. */
export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Seal a credential. Returns an opaque string safe to store in a database
 * column — but still never safe to log or return from an API route.
 */
export function seal(plaintext: string, master: MasterKey): string {
  if (plaintext.length === 0) throw new SecretError("refusing to seal an empty credential");

  const dek = randomBytes(KEY_BYTES);
  const payload = encrypt(Buffer.from(plaintext, "utf8"), dek);
  const wrapped = encrypt(dek, master.key);
  dek.fill(0);

  return [FORMAT_VERSION, master.id, b64(wrapped), b64(payload)].join(".");
}

/** Open a sealed credential. Throws if the master key does not match. */
export function open(sealed: string, master: MasterKey): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new SecretError("malformed sealed credential");
  const [version, id, wrapped, payload] = parts as [string, string, string, string];

  if (version !== FORMAT_VERSION) {
    throw new SecretError(`unsupported sealed-credential format "${version}"`);
  }
  if (!constantTimeEquals(id, master.id)) {
    throw new SecretError(
      `sealed under key ${id}, but SOIF_ENCRYPTION_KEY is ${master.id}. ` +
        "Restore the original key or re-enter the credential.",
    );
  }

  let dek: Buffer | undefined;
  try {
    dek = decrypt(unb64(wrapped), master.key);
    return decrypt(unb64(payload), dek).toString("utf8");
  } catch (error) {
    if (error instanceof SecretError) throw error;
    // GCM authentication failure: the blob was tampered with or truncated.
    throw new SecretError("could not decrypt credential (wrong key or corrupted data)");
  } finally {
    dek?.fill(0);
  }
}

/** Which key id sealed a value, without needing that key. */
export function sealedKeyId(sealed: string): string | null {
  const parts = sealed.split(".");
  return parts.length === 4 && parts[0] === FORMAT_VERSION ? parts[1]! : null;
}

/** Re-seal under a new master key, for staged rotation. */
export function rotate(sealed: string, from: MasterKey, to: MasterKey): string {
  return seal(open(sealed, from), to);
}

/**
 * A display-safe fingerprint of a credential: last four characters only.
 *
 * The UI needs to show *which* key is configured without ever revealing it, and
 * the tail is what an operator recognises from their own console.
 */
export function fingerprint(plaintext: string): string {
  return plaintext.length <= 4 ? "…" : `…${plaintext.slice(-4)}`;
}

function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new SecretError("sealed value is truncated");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function decodeKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return Buffer.from(raw, "base64");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");
