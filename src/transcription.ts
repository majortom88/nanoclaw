import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Transcribes an audio buffer using OpenAI Whisper.
 * Returns the transcription text, or null if transcription fails or is not configured.
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY || readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping voice transcription');
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/ogg' }), filename);
    form.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, text }, 'Whisper API error');
      return null;
    }

    const data = (await response.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'Voice transcription failed');
    return null;
  }
}
