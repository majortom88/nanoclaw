import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Saves an image buffer to the group's images directory.
 * Returns the container-side path (/workspace/group/images/{filename})
 * so the agent can use the Read tool to view it.
 */
export function saveImageToGroup(
  buffer: Buffer,
  groupDir: string,
  messageId: string,
  ext = 'jpg',
): string {
  const imagesDir = path.join(groupDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const filename = `${messageId}.${ext}`;
  const hostPath = path.join(imagesDir, filename);
  fs.writeFileSync(hostPath, buffer);
  logger.debug({ hostPath, size: buffer.length }, 'Image saved to group workspace');
  // The group dir is mounted at /workspace/group in the container
  return `/workspace/group/images/${filename}`;
}
