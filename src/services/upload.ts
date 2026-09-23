import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import type { UploadResponse } from '@/shared';
import { env } from '../config/env.js';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

function parseCloudinaryUrl(url: string) {
  const match = url.match(/cloudinary:\/\/([^:]+):([^@]+)@(.+)/);
  if (!match) throw new Error('Invalid CLOUDINARY_URL format');
  return { apiKey: match[1], apiSecret: match[2], cloudName: match[3] };
}

export async function processUpload(file: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}): Promise<UploadResponse> {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new Error('Unsupported file type. Only JPEG, PNG, WEBP, GIF and PDF files are allowed.');
  }

  if (file.size > MAX_UPLOAD_BYTES || file.buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('File size exceeds the 10MB limit.');
  }

  // Use real Cloudinary upload if CLOUDINARY_URL is available
  if (env.CLOUDINARY_URL) {
    const { apiKey, apiSecret, cloudName } = parseCloudinaryUrl(env.CLOUDINARY_URL);
    const folder = 'tickettool';
    const timestamp = Math.round(new Date().getTime() / 1000).toString();
    
    const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash('sha1').update(signatureString).digest('hex');
    
    const base64Data = file.buffer.toString('base64');
    const fileUri = `data:${file.mimetype};base64,${base64Data}`;
    
    const formData = new FormData();
    formData.append('file', fileUri);
    formData.append('api_key', apiKey);
    formData.append('timestamp', timestamp);
    formData.append('signature', signature);
    formData.append('folder', folder);
    
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
      method: 'POST',
      body: formData,
    });
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Cloudinary upload failed: ${errorText}`);
    }
    
    const data = await res.json() as any;
    return {
      url: data.secure_url,
      publicId: data.public_id,
      bytes: data.bytes,
      mime: file.mimetype,
    };
  }

  const publicId = `cd_${randomUUID()}`;
  // Data URI / mock upload storage for environment resilience without needing external Cloudinary API keys during dev
  const base64 = file.buffer.toString('base64');
  const url = `data:${file.mimetype};base64,${base64}`;

  return {
    url,
    publicId,
    bytes: file.size,
    mime: file.mimetype,
  };
}
