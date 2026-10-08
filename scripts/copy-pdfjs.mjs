// Copies pdf.js character maps and standard fonts into public/ so the reader can load them.
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('node_modules/pdfjs-dist');
const dest = path.resolve('public/pdfjs');
for (const dir of ['cmaps', 'standard_fonts']) {
  fs.rmSync(path.join(dest, dir), { recursive: true, force: true });
  fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
