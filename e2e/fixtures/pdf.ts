import { createHash } from 'node:crypto';

// Deterministic, dependency-free PDF fixtures. The encrypted variant implements
// PDF Standard Security revision 2 for testing password-required handling only.
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const pad = (password: string) => Buffer.concat([Buffer.from(password), padding]).subarray(0, 32);
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest();
function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0; j = 0;
  return Buffer.from(input.map(byte => { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; return byte ^ state[(state[i] + state[j]) & 255]; }));
}
export const pdfText = (text: string, x = 50, y = 740) => `BT /F1 16 Tf ${x} ${y} Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
export const imagePage = 'q 120 0 0 100 50 650 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID FF000000FF000000FFFFFFFF> EI Q';

export function makePdf(contents: string[], encrypted = false): Buffer {
  const fileId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const owner = rc4(md5(pad('fixture-owner')).subarray(0, 5), pad('fixture-password'));
  const permission = Buffer.alloc(4); permission.writeInt32LE(-4);
  const key = md5(Buffer.concat([pad('fixture-password'), owner, permission, fileId])).subarray(0, 5);
  const user = rc4(key, padding);
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Count ${contents.length} /Kids [${contents.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ];
  contents.forEach((content, index) => {
    const streamId = 5 + index * 2;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`));
    let bytes = Buffer.from(content);
    if (encrypted) {
      const suffix = Buffer.from([streamId & 255, (streamId >> 8) & 255, (streamId >> 16) & 255, 0, 0]);
      bytes = rc4(md5(Buffer.concat([key, suffix])).subarray(0, 10), bytes);
    }
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]));
  });
  const encryptId = objects.length + 1;
  if (encrypted) objects.push(Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`));
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0]; let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${encryptId} 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]` : ''} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
