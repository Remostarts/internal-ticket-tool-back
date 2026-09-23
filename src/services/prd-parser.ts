import { createHash } from 'crypto';
import mammoth from 'mammoth';

// Lazy-loaded: resolved once on first PDF call.
// Dynamic import() correctly handles CJS modules in ESM/tsx — the callable
// lands on the 'default' key of the namespace object.
let _pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;

async function getPdfParse(): Promise<(buf: Buffer) => Promise<{ text: string }>> {
  if (_pdfParse) return _pdfParse;
  const mod = await import('pdf-parse');
  // CJS default export arrives as mod.default in an ESM/tsx context
  const fn = (mod as any).default ?? mod;
  if (typeof fn !== 'function') throw new Error('pdf-parse module did not export a callable function');
  _pdfParse = fn as (buf: Buffer) => Promise<{ text: string }>;
  return _pdfParse;
}

/**
 * Extracts plain text from a file buffer based on its MIME type,
 * and returns both the text content and a stable SHA-256 hash for idempotency.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  mimetype: string,
  originalname: string,
): Promise<{ text: string; hash: string }> {
  let text = '';

  const lower = mimetype.toLowerCase();

  if (lower.includes('pdf')) {
    const pdfParse = await getPdfParse();
    const parsed = await pdfParse(buffer);
    text = parsed.text;
  } else if (
    lower.includes('officedocument.wordprocessingml') ||
    lower.includes('msword') ||
    originalname.endsWith('.docx') ||
    originalname.endsWith('.doc')
  ) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else {
    // markdown, plain text, etc.
    text = buffer.toString('utf-8');
  }

  const hash = createHash('sha256').update(text).digest('hex');
  return { text: text.trim(), hash };
}

export function extractTextFromString(content: string): { text: string; hash: string } {
  const text = content.trim();
  const hash = createHash('sha256').update(text).digest('hex');
  return { text, hash };
}

