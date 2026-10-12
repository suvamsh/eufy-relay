"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.megaDecryptBody = exports.megaEncryptBody = exports.sharedKeyToAesKey = exports.sharedKeySigningKey = exports.finalizeKeyExchange = exports.buildKeyExchange = exports.presetDecrypt = exports.presetEncrypt = exports.generateKeyIdent = exports.xSignature = exports.MEGA_PRESET_KEY = void 0;
const crypto_1 = require("crypto");
/**
 * Eufy "eufy_mega" v6 transport crypto.
 *
 * Two layers:
 *  1. Bootstrap (handshake): body + signature use a STATIC per-app `presetKey`.
 *  2. Regular requests (post-handshake): body + signature use the per-cluster
 *     ECDH `sharedKey` derived from the key/exchange.
 */
/** Static preset key for the `eufy_security` category (`*.eufy.com`). Extracted from the app's
 *  `ESIotAppConfig`, stored in `MegaAppDomain.presetKeyMap` (one key per product category). */
exports.MEGA_PRESET_KEY = "2500a7d5617812f9d52515b2c8f20a3d";
/** NIST P-256 (prime256v1) — same curve the lib already uses for login. */
const CURVE = "prime256v1";
/**
 * X-Signature = HMAC-SHA256, hex lowercase, over `${ts}+${nonce}+${encryptedBody}`.
 * The HMAC key is the **ASCII string** of the key material (NOT hex-decoded).
 *
 * @param keyAscii presetKey (bootstrap) or sharedKey hex string (regular requests)
 */
const xSignature = (keyAscii, ts, nonce, encryptedBody) => {
    const parts = encryptedBody !== undefined ? [ts, nonce, encryptedBody] : [ts, nonce];
    return (0, crypto_1.createHmac)("sha256", Buffer.from(keyAscii, "utf8")).update(parts.join("+")).digest("hex");
};
exports.xSignature = xSignature;
/** Random 32-hex client-generated X-Key-Ident (one per cluster identity). */
const generateKeyIdent = () => (0, crypto_1.randomBytes)(16).toString("hex");
exports.generateKeyIdent = generateKeyIdent;
/**
 * Encrypt a payload AES-128-CBC/PKCS7 under the preset key, output `base64(IV ++ ciphertext)`.
 * The AES key is `bytes.fromhex(presetKey)` (16 bytes); a fresh random IV is prepended.
 * Used to wrap the client's EC public key in the key/exchange request body.
 */
const presetEncrypt = (plaintext, presetKeyHex = exports.MEGA_PRESET_KEY) => {
    const key = Buffer.from(presetKeyHex, "hex");
    const iv = (0, crypto_1.randomBytes)(16);
    const cipher = (0, crypto_1.createCipheriv)("aes-128-cbc", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, ct]).toString("base64");
};
exports.presetEncrypt = presetEncrypt;
/** Inverse of {@link presetEncrypt}: decode `base64(IV ++ ciphertext)` → plaintext. */
const presetDecrypt = (b64, presetKeyHex = exports.MEGA_PRESET_KEY) => {
    const blob = Buffer.from(b64, "base64");
    const key = Buffer.from(presetKeyHex, "hex");
    const decipher = (0, crypto_1.createDecipheriv)("aes-128-cbc", key, blob.subarray(0, 16));
    return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]).toString("utf8");
};
exports.presetDecrypt = presetDecrypt;
/**
 * Build the key/exchange request material.
 *
 * The exchange is ECIES-bootstrapped: the client's ephemeral EC public key is wrapped
 * with the static `presetKey`. The SESSION sharedKey is NOT derivable yet — it is
 * `ECDH(clientPriv, server_public_key)` where server_public_key comes back in the
 * response (see {@link finalizeKeyExchange}). We keep the ECDH object so the caller can
 * finish the derivation once the server replies.
 *
 * @returns the ECDH object (holds the client private key), the wrapped client_public_key
 *          body value, the client public key hex, and a fresh client-generated keyIdent.
 */
const buildKeyExchange = () => {
    const ecdh = (0, crypto_1.createECDH)(CURVE);
    ecdh.generateKeys();
    const clientPubHex = ecdh.getPublicKey("hex");
    const clientPublicKeyBody = (0, exports.presetEncrypt)(clientPubHex);
    return { ecdh, clientPublicKeyBody, clientPublicKey: clientPubHex, keyIdent: (0, exports.generateKeyIdent)() };
};
exports.buildKeyExchange = buildKeyExchange;
/**
 * Finalize the handshake: derive the session sharedKey from our ECDH private key and the
 * server's public key returned (preset-encrypted) in the key/exchange response.
 *
 * @param ecdh the ECDH object from {@link buildKeyExchange} (holds clientPriv)
 * @param serverPublicKeyEnc base64 `server_public_key` from the response (preset-wrapped)
 * @param keyIdent the client keyIdent used for this cluster
 * @param clientPublicKey our public key hex (for reference)
 */
const finalizeKeyExchange = (ecdh, serverPublicKeyEnc, keyIdent, clientPublicKey) => {
    const serverPubHex = (0, exports.presetDecrypt)(serverPublicKeyEnc);
    if (!/^04[0-9a-f]{128}$/i.test(serverPubHex)) {
        throw new Error("key/exchange: unexpected server public key format");
    }
    let sharedKey;
    try {
        sharedKey = ecdh.computeSecret(Buffer.from(serverPubHex, "hex")).toString("hex");
    }
    catch (err) {
        throw new Error(`key/exchange: ECDH computeSecret failed (${err.message})`);
    }
    return { keyIdent, sharedKey, clientPublicKey };
};
exports.finalizeKeyExchange = finalizeKeyExchange;
/**
 * Per-request key material derived from the handshake sharedKey.
 *
 * The sharedKey is the ECDH X-coordinate as a 64-char hex string. For regular requests:
 *  - **HMAC/signature key** = the first 32 hex CHARS of sharedKey, used as an ASCII string.
 *  - **AES body key**       = `bytes.fromhex(sharedKey[:32])` → 16 bytes (AES-128); iv = key[:16].
 *
 * NOTE: only the first 32 hex chars (16 bytes) of the 64-char sharedKey are used.
 */
const sharedKeySigningKey = (sharedKeyHex) => sharedKeyHex.slice(0, 32);
exports.sharedKeySigningKey = sharedKeySigningKey;
/** AES key buffer for body encryption: bytes.fromhex(sharedKey[:32]) = 16 bytes (AES-128). */
const sharedKeyToAesKey = (sharedKeyHex) => Buffer.from(sharedKeyHex.slice(0, 32), "hex");
exports.sharedKeyToAesKey = sharedKeyToAesKey;
/**
 * Encrypt a regular (post-handshake) request/response body: AES-128-CBC/PKCS7 with a fresh
 * RANDOM IV, output `base64(IV ++ ciphertext)` — same envelope as the key/exchange body.
 */
const megaEncryptBody = (plaintext, aesKey) => {
    const iv = (0, crypto_1.randomBytes)(16);
    const cipher = (0, crypto_1.createCipheriv)("aes-128-cbc", aesKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, ct]).toString("base64");
};
exports.megaEncryptBody = megaEncryptBody;
/** Inverse of {@link megaEncryptBody}: decode `base64(IV ++ ciphertext)` → plaintext. */
const megaDecryptBody = (b64, aesKey) => {
    const blob = Buffer.from(b64, "base64");
    const decipher = (0, crypto_1.createDecipheriv)("aes-128-cbc", aesKey, blob.subarray(0, 16));
    return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]).toString("utf8");
};
exports.megaDecryptBody = megaDecryptBody;
//# sourceMappingURL=megaCrypto.js.map