import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function getEncryptionKey() {
  const value = process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("EMAIL_TOKEN_ENCRYPTION_KEY is not configured.");
  return createHash("sha256").update(value).digest();
}

export function encryptEmailToken(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptEmailToken(payload: string) {
  const [ivEncoded, authTagEncoded, encryptedEncoded] = payload.split(".");
  if (!ivEncoded || !authTagEncoded || !encryptedEncoded)
    throw new Error("Invalid encrypted email token.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
