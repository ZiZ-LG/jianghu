import type { SourceRegistryEntry } from '../src/content/sources.ts';
import {
  readBoundedResponseBody,
  ResponseBodyByteLimitError,
} from './stephen-bounded-response.ts';

export interface RssFeedEntry {
  readonly title: string;
  readonly link: string;
  readonly guid: string;
  readonly publishedAt: string;
  readonly descriptionText: string;
}

export interface ParsedRssFeed {
  readonly channelTitle: string;
  readonly entries: readonly RssFeedEntry[];
}

export interface FetchedRssDocument {
  readonly xml: string;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly redirectCount: number;
}

function decodeXmlEntities(value: string) {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (match, entity: string) => {
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity.toLocaleLowerCase()] ?? match;
  });
}

function extractTag(xml: string, tagName: string) {
  const match = xml.match(new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  ));
  return match?.[1] ?? '';
}

function toPlainText(value: string) {
  const withoutCdata = value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeXmlEntities(withoutCdata).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum).trimEnd();
}

export function parseRss2Feed(
  xml: string,
  options: { readonly maxItems: number },
): ParsedRssFeed {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new Error('RSS DTD and ENTITY declarations are not allowed');
  }
  if (!Number.isInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 50) {
    throw new Error('RSS maxItems is outside the allowed range');
  }

  const channelMatch = xml.match(/<rss\b[^>]*>[\s\S]*?<channel\b[^>]*>([\s\S]*?)<\/channel>[\s\S]*?<\/rss>/i);
  if (!channelMatch) {
    throw new Error('RSS 2.0 structure drift detected');
  }
  const channelXml = channelMatch[1];
  const itemMatches = [...channelXml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if (itemMatches.length === 0) {
    throw new Error('RSS 2.0 structure drift detected');
  }

  const entries = itemMatches.slice(0, options.maxItems).map((match) => {
    const itemXml = match[1];
    return {
      title: toPlainText(extractTag(itemXml, 'title')),
      link: toPlainText(extractTag(itemXml, 'link')),
      guid: toPlainText(extractTag(itemXml, 'guid')),
      publishedAt: toPlainText(extractTag(itemXml, 'pubDate')),
      descriptionText: truncate(toPlainText(extractTag(itemXml, 'description')), 1_000),
    } satisfies RssFeedEntry;
  });

  return {
    channelTitle: toPlainText(extractTag(channelXml, 'title')),
    entries,
  };
}

export async function fetchAllowlistedRss(
  source: SourceRegistryEntry,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<FetchedRssDocument> {
  const ingestion = source.ingestion;
  if (!ingestion || ingestion.protocol !== 'rss2') {
    throw new Error('source has no approved RSS ingestion configuration');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let currentUrl = ingestion.endpoint;
  let redirectCount = 0;

  while (true) {
    const endpoint = new URL(currentUrl);
    if (endpoint.protocol !== 'https:'
      || !ingestion.allowedEndpointHosts.includes(endpoint.hostname)) {
      throw new Error('RSS endpoint host is not allowlisted');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ingestion.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          accept: 'application/rss+xml, application/xml, text/xml;q=0.9',
        },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) throw new Error('RSS request timed out');
      throw new Error('RSS request failed closed');
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timeout);
      const location = response.headers.get('location');
      if (!location) throw new Error('RSS redirect is missing a location');
      if (redirectCount >= ingestion.maxRedirects) {
        throw new Error('RSS redirect limit exceeded');
      }
      const redirected = new URL(location, currentUrl);
      if (redirected.protocol !== 'https:'
        || !ingestion.allowedEndpointHosts.includes(redirected.hostname)) {
        throw new Error('RSS redirect host is not allowlisted');
      }
      currentUrl = redirected.href;
      redirectCount += 1;
      continue;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      throw new Error(`RSS request returned status ${response.status}`);
    }
    const contentType = response.headers.get('content-type')
      ?.split(';', 1)[0]
      .trim()
      .toLocaleLowerCase() ?? '';
    if (!['application/rss+xml', 'application/xml', 'text/xml'].includes(contentType)) {
      clearTimeout(timeout);
      throw new Error('RSS response content type is not allowlisted');
    }
    let body: Uint8Array;
    try {
      body = await readBoundedResponseBody(
        response,
        ingestion.maxBytes,
        controller.signal,
      );
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) throw new Error('RSS request timed out');
      if (error instanceof ResponseBodyByteLimitError) {
        throw new Error('RSS response exceeds the byte limit');
      }
      throw new Error('RSS response body could not be read');
    }
    clearTimeout(timeout);
    if (controller.signal.aborted) throw new Error('RSS request timed out');
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(body);
    if (!xml.trim()) throw new Error('RSS response body is empty');

    return {
      xml,
      contentType,
      finalUrl: currentUrl,
      redirectCount,
    };
  }
}
