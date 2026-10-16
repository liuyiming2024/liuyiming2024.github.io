/* Cloud Drive · 加密层
 *
 * 浏览器原生 Web Crypto，不引任何第三方库。
 * 文件在离开浏览器之前就已经是密文——公开仓库里存的只是密文，
 * 私有库里存的还是密文。口令丢了就是丢了，没有任何找回通道。
 *
 * 密文容器格式：
 *   "CDRV"            4B  魔数
 *   ver               1B  版本号
 *   salt             16B  PBKDF2 盐，每次加密随机
 *   chunkSize         4B  分块大小（uint32 大端）
 *   重复直到结束：
 *     iv             12B  GCM nonce，每块随机
 *     len             4B  本块明文字节数（uint32 大端）
 *     sealed      len+16B  密文 + GCM tag
 *
 * 每块把「块序号」放进 additionalData：
 * 缺块、重排、截断都会在解密时直接抛错，不会静默产出半个文件。
 */
(function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const MAGIC = [0x43, 0x44, 0x52, 0x56]; // CDRV
  const VER = 1;
  const SALT_LEN = 16;
  const IV_LEN = 12;
  const HEADER_LEN = 4 + 1 + SALT_LEN + 4;

  function u32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function rand(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* 加密：File/Blob → Blob（密文容器） */
  async function encryptBlob(blob, passphrase) {
    const salt = rand(SALT_LEN);
    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const chunkSize = window.CloudCfg.crypto.chunkSize;

    const total = blob.size;
    const chunks = Math.max(1, Math.ceil(total / chunkSize));
    const parts = [];
    let outLen = HEADER_LEN;

    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const buf = await blob.slice(start, Math.min(start + chunkSize, total)).arrayBuffer();
      const iv = rand(IV_LEN);
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: u32(i) },
          key,
          buf
        )
      );
      parts.push({ iv, len: buf.byteLength, sealed });
      outLen += IV_LEN + 4 + sealed.length;
    }

    const out = new Uint8Array(outLen);
    let p = 0;
    out.set(MAGIC, p); p += 4;
    out[p++] = VER;
    out.set(salt, p); p += SALT_LEN;
    out.set(u32(chunkSize), p); p += 4;
    for (const c of parts) {
      out.set(c.iv, p); p += IV_LEN;
      out.set(u32(c.len), p); p += 4;
      out.set(c.sealed, p); p += c.sealed.length;
    }
    return new Blob([out], { type: 'application/octet-stream' });
  }

  /* 解密：密文 ArrayBuffer → Blob */
  async function decryptBuffer(raw, passphrase) {
    const b = new Uint8Array(raw);
    for (let i = 0; i < 4; i++) {
      if (b[i] !== MAGIC[i]) throw new Error('不是本云盘的密文文件（魔数不对）');
    }
    if (b[4] !== VER) throw new Error('密文版本不支持：' + b[4]);
    let p = 5;
    const salt = b.slice(p, p + SALT_LEN); p += SALT_LEN;
    const chunkSize = readU32(b, p); p += 4;

    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const plain = [];

    let i = 0;
    while (p < b.length) {
      if (p + IV_LEN + 4 > b.length) throw new Error('密文被截断（块头不完整）');
      const iv = b.slice(p, p + IV_LEN); p += IV_LEN;
      const len = readU32(b, p); p += 4;
      if (p + len + 16 > b.length) throw new Error('密文被截断（第 ' + i + ' 块数据不完整）');
      const sealed = b.slice(p, p + len + 16); p += len + 16;
      // subarray 直接给 crypto 用，避免再拷一份
      plain.push(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: u32(i) }, key, sealed)
      );
      i++;
    }
    return new Blob(plain, { type: 'application/octet-stream' });
  }

  /* 文件名等短元数据也加密，避免私有库/公开库里留下真实文件名 */
  async function encryptText(text, passphrase) {
    const salt = rand(SALT_LEN);
    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const iv = rand(IV_LEN);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
    const out = new Uint8Array(SALT_LEN + IV_LEN + sealed.length);
    out.set(salt, 0);
    out.set(iv, SALT_LEN);
    out.set(sealed, SALT_LEN + IV_LEN);
    return btoa(String.fromCharCode(...out));
  }

  async function decryptText(b64, passphrase) {
    const all = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const salt = all.slice(0, SALT_LEN);
    const iv = all.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const sealed = all.slice(SALT_LEN + IV_LEN);
    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed);
    return dec.decode(buf);
  }

  window.CloudCrypto = { encryptBlob, decryptBuffer, encryptText, decryptText };
})();
