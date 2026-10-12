import { ECDH } from "crypto";
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
export declare const MEGA_PRESET_KEY = "2500a7d5617812f9d52515b2c8f20a3d";
/**
 * X-Signature = HMAC-SHA256, hex lowercase, over `${ts}+${nonce}+${encryptedBody}`.
 * The HMAC key is the **ASCII string** of the key material (NOT hex-decoded).
 *
 * @param keyAscii presetKey (bootstrap) or sharedKey hex string (regular requests)
 */
export declare const xSignature: (keyAscii: string, ts: string, nonce: string, encryptedBody?: string) => string;
/** Random 32-hex client-generated X-Key-Ident (one per cluster identity). */
export declare const generateKeyIdent: () => string;
/**
 * Encrypt a payload AES-128-CBC/PKCS7 under the preset key, output `base64(IV ++ ciphertext)`.
 * The AES key is `bytes.fromhex(presetKey)` (16 bytes); a fresh random IV is prepended.
 * Used to wrap the client's EC public key in the key/exchange request body.
 */
export declare const presetEncrypt: (plaintext: string, presetKeyHex?: string) => string;
/** Inverse of {@link presetEncrypt}: decode `base64(IV ++ ciphertext)` → plaintext. */
export declare const presetDecrypt: (b64: string, presetKeyHex?: string) => string;
/** Result of a key/exchange handshake, cached per cluster host. */
export interface MegaIdentity {
    keyIdent: string;
    /** ECDH shared secret as lowercase hex (raw 32-byte X coordinate). */
    sharedKey: string;
    /** Our ephemeral public key (uncompressed `04…`, hex) sent in the exchange. */
    clientPublicKey: string;
}
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
export declare const buildKeyExchange: () => {
    ecdh: ECDH;
    clientPublicKeyBody: string;
    clientPublicKey: string;
    keyIdent: string;
};
/**
 * Finalize the handshake: derive the session sharedKey from our ECDH private key and the
 * server's public key returned (preset-encrypted) in the key/exchange response.
 *
 * @param ecdh the ECDH object from {@link buildKeyExchange} (holds clientPriv)
 * @param serverPublicKeyEnc base64 `server_public_key` from the response (preset-wrapped)
 * @param keyIdent the client keyIdent used for this cluster
 * @param clientPublicKey our public key hex (for reference)
 */
export declare const finalizeKeyExchange: (ecdh: ECDH, serverPublicKeyEnc: string, keyIdent: string, clientPublicKey: string) => MegaIdentity;
/**
 * Per-request key material derived from the handshake sharedKey.
 *
 * The sharedKey is the ECDH X-coordinate as a 64-char hex string. For regular requests:
 *  - **HMAC/signature key** = the first 32 hex CHARS of sharedKey, used as an ASCII string.
 *  - **AES body key**       = `bytes.fromhex(sharedKey[:32])` → 16 bytes (AES-128); iv = key[:16].
 *
 * NOTE: only the first 32 hex chars (16 bytes) of the 64-char sharedKey are used.
 */
export declare const sharedKeySigningKey: (sharedKeyHex: string) => string;
/** AES key buffer for body encryption: bytes.fromhex(sharedKey[:32]) = 16 bytes (AES-128). */
export declare const sharedKeyToAesKey: (sharedKeyHex: string) => Buffer;
/**
 * Encrypt a regular (post-handshake) request/response body: AES-128-CBC/PKCS7 with a fresh
 * RANDOM IV, output `base64(IV ++ ciphertext)` — same envelope as the key/exchange body.
 */
export declare const megaEncryptBody: (plaintext: string, aesKey: Buffer) => string;
/** Inverse of {@link megaEncryptBody}: decode `base64(IV ++ ciphertext)` → plaintext. */
export declare const megaDecryptBody: (b64: string, aesKey: Buffer) => string;
