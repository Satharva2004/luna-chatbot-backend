import fetch from 'node-fetch';
import env from '../config/env.js';

const GOOGLE_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';
const DEFAULT_RESULT_COUNT = 8;

function sanitizeResults(items = []) {
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const link = typeof item.link === 'string' ? item.link : null;
      const imageContextLink = item.image?.contextLink || item.contextLink || link;
      const thumbnail = item.image?.thumbnailLink || null;

      return {
        title: typeof item.title === 'string' ? item.title : null,
        imageUrl: link,
        pageUrl: typeof imageContextLink === 'string' ? imageContextLink : link,
        thumbnailUrl: thumbnail,
      };
    })
    .filter((result) => Boolean(result.imageUrl));
}

export async function searchImages(query, options = {}) {
  const apiKey = env.GOOGLE_API_KEY;
  const cseId = env.GOOGLE_CSE_ID;

  if (!apiKey || !cseId) {
    console.warn('[imageSearch] Missing GOOGLE_API_KEY or GOOGLE_CSE_ID; skipping image search.');
    return [];
  }

  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (!trimmedQuery) {
    return [];
  }

  const requestedCount = Number.isFinite(options.num) ? options.num : DEFAULT_RESULT_COUNT;
  const num = Math.min(Math.max(requestedCount, 1), 10);
  const requestedImgSize = typeof options.imgSize === 'string' ? options.imgSize : 'large';
  const requestedImgType = typeof options.imgType === 'string' ? options.imgType : 'photo';

  const params = new URLSearchParams({
    key: apiKey,
    cx: cseId,
    q: trimmedQuery,
    searchType: 'image',
    num: String(num),
    safe: 'active',
    imgSize: requestedImgSize,
    imgType: requestedImgType,
  });

  try {
    const response = await fetch(`${GOOGLE_SEARCH_URL}?${params.toString()}`);
    if (!response.ok) {
      console.warn('[imageSearch] Google API request failed:', response.status, response.statusText);
      return [];
    }

    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.items)) {
      return [];
    }

    return sanitizeResults(data.items);
  } catch (error) {
    console.error('[imageSearch] Failed to fetch images:', error);
    return [];
  }
}
