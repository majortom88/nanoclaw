/**
 * LinkedIn channel for NanoClaw.
 *
 * Uses LinkedIn's internal Voyager API (authenticated via saved browser state)
 * to poll for DMs and send messages/posts.
 *
 * First-time setup: run `npm run linkedin:auth` to authenticate.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { chromium, Browser, BrowserContext } from 'playwright';

import { logger as rootLogger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import type { ChannelOpts } from './registry.js';
import { registerChannel } from './registry.js';

const logger = rootLogger.child({ channel: 'linkedin' });

export const LINKEDIN_AUTH_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'linkedin-auth.json',
);

const POLL_INTERVAL_MS = 30_000;
const LINKEDIN_BASE = 'https://www.linkedin.com';

// ─── Voyager API helpers ─────────────────────────────────────────────────────

async function voyagerFetch(
  context: BrowserContext,
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const cookies = await context.cookies(LINKEDIN_BASE);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf =
    cookies.find((c) => c.name === 'JSESSIONID')?.value?.replace(/"/g, '') ??
    '';

  const res = await fetch(`${LINKEDIN_BASE}${endpoint}`, {
    ...options,
    headers: {
      Cookie: cookieHeader,
      'Csrf-Token': csrf,
      'X-Restli-Protocol-Version': '2.0.0',
      Accept: 'application/vnd.linkedin.normalized+json+2.1',
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    throw new Error(
      `LinkedIn API ${endpoint} → ${res.status} ${res.statusText}`,
    );
  }
  return res.json();
}

// ─── Channel implementation ──────────────────────────────────────────────────

class LinkedInChannel implements Channel {
  name = 'linkedin';

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;

  /** Per-conversation: timestamp (ms) of last delivered message */
  private lastDeliveredAt = new Map<string, number>();
  /** Set at startup — we only deliver messages newer than this */
  private startedAt = 0;

  constructor(
    private onMessage: OnInboundMessage,
    private onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    if (!fs.existsSync(LINKEDIN_AUTH_PATH)) {
      logger.warn(
        { path: LINKEDIN_AUTH_PATH },
        'LinkedIn auth not found — channel inactive. Run: npm run linkedin:auth',
      );
      return;
    }

    try {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({
        storageState: LINKEDIN_AUTH_PATH,
      });

      // Verify session — warn but don't crash if it fails
      try {
        await voyagerFetch(this.context, '/voyager/api/me');
      } catch (err) {
        logger.warn(
          { err },
          'LinkedIn session check failed — channel may be degraded. Re-run: npm run linkedin:auth',
        );
      }

      this.startedAt = Date.now();
      this.connected = true;
      logger.info(
        'LinkedIn connected, polling every %ds',
        POLL_INTERVAL_MS / 1000,
      );

      this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      void this.poll();
    } catch (err) {
      logger.warn(
        { err },
        'LinkedIn channel failed to start — continuing without it',
      );
      await this.browser?.close();
      this.browser = null;
      this.context = null;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    logger.info('LinkedIn disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('linkedin:');
  }

  // ── Outbound ────────────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.context) throw new Error('LinkedIn not connected');

    // linkedin:feed → post to feed
    if (jid === 'linkedin:feed') {
      await this.postToFeed(text);
      return;
    }

    const convUrn = jid.replace('linkedin:', '');
    await voyagerFetch(
      this.context,
      `/voyager/api/messaging/conversations/${encodeURIComponent(convUrn)}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          eventCreate: {
            value: {
              'com.linkedin.voyager.messaging.create.MessageCreate': {
                attributedBody: { text, attributes: [] },
                attachments: [],
              },
            },
          },
          dedupeByClientGeneratedToken: false,
        }),
      },
    );
  }

  private async postToFeed(text: string): Promise<void> {
    if (!this.context) throw new Error('LinkedIn not connected');

    // Use browser automation for posting — more stable than the API
    const page = await this.context.newPage();
    try {
      await page.goto(`${LINKEDIN_BASE}/feed/`, {
        waitUntil: 'domcontentloaded',
      });

      // Click "Start a post" button
      await page.getByRole('button', { name: /start a post/i }).click();
      await page.waitForTimeout(800);

      // Fill in the post text
      const editor = page.locator('[data-placeholder]').first();
      await editor.click();
      await editor.fill(text);
      await page.waitForTimeout(400);

      // Click the Post button
      await page.getByRole('button', { name: /^post$/i }).click();
      await page.waitForTimeout(1500);

      logger.info('LinkedIn feed post published');
    } finally {
      await page.close();
    }
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.connected || !this.context) return;

    try {
      const data = (await voyagerFetch(
        this.context,
        '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=inbox',
      )) as { elements?: ConversationElement[] };

      for (const conv of data.elements ?? []) {
        const convUrn = conv.entityUrn;
        const convId = convUrn.split(':').pop() ?? convUrn;
        const jid = `linkedin:${convId}`;
        const lastActivity = conv.lastActivityAt ?? 0;

        // Emit chat metadata so the group registry can pick up names
        this.onChatMetadata(
          jid,
          new Date(lastActivity).toISOString(),
          undefined,
          'linkedin',
          false,
        );

        // Only fetch thread if there's activity since our last check
        const lastChecked = this.lastDeliveredAt.get(jid) ?? this.startedAt;
        if (lastActivity > lastChecked) {
          await this.fetchAndDeliverMessages(jid, convUrn, lastChecked);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'LinkedIn poll failed');
    }
  }

  private async fetchAndDeliverMessages(
    jid: string,
    convUrn: string,
    since: number,
  ): Promise<void> {
    if (!this.context) return;

    const data = (await voyagerFetch(
      this.context,
      `/voyager/api/messaging/conversations/${encodeURIComponent(convUrn)}/events?keyVersion=LEGACY_INBOX`,
    )) as { elements?: MessageEvent[] };

    let latestTs = since;

    for (const event of [...(data.elements ?? [])].reverse()) {
      const ts = event.createdAt ?? 0;
      if (ts <= since) continue;

      const msgEvent =
        event.eventContent?.[
          'com.linkedin.voyager.messaging.event.MessageEvent'
        ];
      const text = msgEvent?.attributedBody?.text;
      if (!text?.trim()) continue;

      const member =
        event.from?.['com.linkedin.voyager.messaging.MessagingMember'];
      const profile = member?.miniProfile;
      const senderUrn = profile?.entityUrn ?? 'unknown';
      const senderName = profile
        ? `${profile.firstName} ${profile.lastName}`
        : 'Unknown';

      // Detect own messages by checking if the URN matches the authed user
      // (rough heuristic — accurate enough for routing)
      const isFromMe = senderUrn.includes('me') || senderUrn === '';

      const msg: NewMessage = {
        id: event.eventUrn,
        chat_jid: jid,
        sender: senderUrn,
        sender_name: senderName,
        content: text,
        timestamp: new Date(ts).toISOString(),
        is_from_me: isFromMe,
      };

      this.onMessage(jid, msg);
      if (ts > latestTs) latestTs = ts;
    }

    if (latestTs > since) {
      this.lastDeliveredAt.set(jid, latestTs);
    }
  }
}

// ─── Voyager API types ───────────────────────────────────────────────────────

interface ConversationElement {
  entityUrn: string;
  lastActivityAt: number;
  read?: boolean;
}

interface MessageEvent {
  eventUrn: string;
  createdAt: number;
  from?: {
    'com.linkedin.voyager.messaging.MessagingMember'?: {
      miniProfile?: {
        entityUrn: string;
        firstName: string;
        lastName: string;
      };
    };
  };
  eventContent?: {
    'com.linkedin.voyager.messaging.event.MessageEvent'?: {
      attributedBody?: { text: string };
    };
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function linkedInFactory(opts: ChannelOpts): Channel | null {
  if (!fs.existsSync(LINKEDIN_AUTH_PATH)) {
    logger.warn(
      { path: LINKEDIN_AUTH_PATH },
      'LinkedIn auth not found — channel skipped. Run: npm run linkedin:auth',
    );
    return null;
  }
  return new LinkedInChannel(opts.onMessage, opts.onChatMetadata);
}

registerChannel('linkedin', linkedInFactory);
