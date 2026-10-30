import crypto from "node:crypto";
function encryptionKey(secret: string) {
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32)
    throw new Error(
      "META_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  return key;
}
// Keep the persisted format compatible with existing connections and Page choices:
// base64(iv).base64(authentication tag).base64(ciphertext), using AES-256-GCM.
export function encryptToken(value: string, secret: string) {
  const key = encryptionKey(secret),
    iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}
export function decryptToken(value: string, secret: string) {
  const key = encryptionKey(secret);
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted Meta token.");
  const [iv, tag, ciphertext] = parts.map((part) =>
    Buffer.from(part, "base64"),
  );
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid encrypted Meta token.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
