// src/controllers/chatController.js
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import {
  generateContent,
  buildRequestBody,
  MODEL_ID,
  BASE_URL,
  extractTextFromUploads,
  extractImagesFromUploads,
  getGeminiMaxAttempts,
  getNextGeminiApiKey,
  isRetryableGeminiError,
  markGeminiApiKeyFailed,
  markGeminiApiKeyHealthy,
  rotateGeminiApiKey,
} from '../helpers/gemini.js';
import { searchImages } from '../helpers/imageSearch.js';
import { RESEARCH_ASSISTANT_PROMPT } from '../prompts/researchAssistantPrompt.js';
import YouTubeMCP from '../helpers/youtubeSearch.js';
import env from '../config/env.js';
import { processMermaidBlocks } from '../helpers/mermaid.js';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

// Initialize YouTube MCP
const youtubeMCP = env.YOUTUBE_API_KEY ? new YouTubeMCP(env.YOUTUBE_API_KEY) : null;
if (!youtubeMCP) {
  console.warn('⚠️  YouTube API key not configured - YouTube search will be disabled');
}

const STREAM_FINISH_DEBOUNCE_MS = 80;
const STREAM_CLOSE_DELAY_MS = 60;
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const FEATHERLESS_BASE_URL = env.FEATHERLESS_BASE_URL || 'https://api.featherless.ai/v1';
const FEATHERLESS_MODEL_NAME = env.FEATHERLESS_MODEL_NAME || 'Qwen/Qwen2.5-7B-Instruct';

function buildFallbackConversationTitle(prompt) {
  const normalized = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'New chat';
  }

  return normalized.length > 52 ? `${normalized.slice(0, 49)}...` : normalized;
}

async function generateConversationTitle(prompt, answer = '') {
  const apiKey = env.FEATHERLESS_API_KEY;
  const fallbackTitle = buildFallbackConversationTitle(prompt);

  if (!apiKey) {
    return fallbackTitle;
  }

  const promptSnippet = String(prompt || '').replace(/\s+/g, ' ').trim();
  const answerSnippet = String(answer || '').replace(/\s+/g, ' ').trim().slice(0, 600);

  if (!promptSnippet) {
    return fallbackTitle;
  }

  try {
    const completionPrompt = [
      'Generate a short chat title for this conversation.',
      'Rules:',
      '- 3 to 6 words only',
      '- no quotes',
      '- no markdown',
      '- concise, natural, title case',
      '- summarize the user intent',
      '',
      `User: ${promptSnippet}`,
      answerSnippet ? `Assistant: ${answerSnippet}` : '',
      '',
      'Title:'
    ].filter(Boolean).join('\n');

    const response = await fetch(`${FEATHERLESS_BASE_URL}/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: FEATHERLESS_MODEL_NAME,
        prompt: completionPrompt,
        max_tokens: 24,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`Featherless HTTP ${response.status}`);
    }

    const data = await response.json();
    const rawTitle = typeof data?.choices?.[0]?.text === 'string'
      ? data.choices[0].text
      : typeof data?.text === 'string'
        ? data.text
        : '';

    const cleanedTitle = rawTitle
      .replace(/[\r\n]+/g, ' ')
      .replace(/^title\s*:\s*/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanedTitle) {
      return fallbackTitle;
    }

    return cleanedTitle.length > 60 ? cleanedTitle.slice(0, 57).trimEnd() + '...' : cleanedTitle;
  } catch (error) {
    console.warn('[conversation-title] Failed to generate title:', error?.message || error);
    return fallbackTitle;
  }
}

async function updateConversationTitle(conversationId, prompt, answer = '') {
  if (!conversationId) {
    return null;
  }

  const title = await generateConversationTitle(prompt, answer);

  try {
    const { error } = await supabase
      .from('conversations')
      .update({
        title,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId);

    if (error) {
      throw error;
    }

    return title;
  } catch (error) {
    console.error('[conversation-title] Failed to persist title:', error);
    return null;
  }
}

/**
 * Fetch page title from URL
 * @param {string} url - The URL to fetch title from
 * @returns {Promise<string>} - The page title or fallback
 */
async function fetchPageTitle(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = titleMatch ? titleMatch[1].trim() : '';

    if (title) {
      title = title.replace(/\s+/g, ' ').trim();
      if (title.length > 100) {
        title = title.substring(0, 97) + '...';
      }
    }

    if (!title) {
      const urlObj = new URL(url);
      title = urlObj.hostname.replace(/^www\./, '');
    }

    return title;
  } catch (error) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
      return 'Link';
    }
  }
}

function buildContextualSearchQuery({ prompt, history, extra, maxLength = 200 }) {
  const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  const extraText = typeof extra === 'string' ? extra.trim() : '';
  const normalize = (value = '') => String(value)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const recentUserPrompts = [];

  if (Array.isArray(history) && history.length) {
    for (const message of history) {
      const text = normalize(message?.content);
      if (!text) {
        continue;
      }

      if (message.role === 'user') {
        recentUserPrompts.push(text);
      }

      if (recentUserPrompts.length >= 4) {
        break;
      }
    }
  }

  const latestTopic = recentUserPrompts[0] || '';
  const previousTopic = recentUserPrompts[1] || '';
  const cleanPrompt = normalize(trimmedPrompt);
  const lowerPrompt = cleanPrompt.toLowerCase();
  const isContextDependentPrompt =
    cleanPrompt.length < 24 ||
    /^(more|continue|go on|what else|next|another|again|same|that|this|these|those)\b/i.test(cleanPrompt) ||
    /\b(more|deeper|advanced|examples|resources|videos|video|images|image|tutorials|tutorial|courses|books|docs|documentation|roadmap)\b/i.test(lowerPrompt);

  const segments = [];

  if (isContextDependentPrompt && latestTopic) {
    segments.push(latestTopic);
    if (previousTopic && previousTopic.toLowerCase() !== latestTopic.toLowerCase()) {
      segments.push(previousTopic);
    }
    if (cleanPrompt && cleanPrompt.toLowerCase() !== latestTopic.toLowerCase()) {
      segments.push(cleanPrompt);
    }
  } else if (cleanPrompt) {
    segments.push(cleanPrompt);
    if (latestTopic && latestTopic.toLowerCase() !== cleanPrompt.toLowerCase()) {
      segments.push(latestTopic);
    }
  } else if (latestTopic) {
    segments.push(latestTopic);
  }

  if (extraText) {
    segments.push(normalize(extraText));
  }

  const combined = segments
    .filter(Boolean)
    .join(' | ')
    .slice(0, maxLength)
    .trim();

  return combined;
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'for', 'from',
  'give', 'get', 'hai', 'he', 'her', 'his', 'how', 'i', 'in', 'is', 'it', 'its',
  'ka', 'ke', 'ki', 'ko', 'me', 'mein', 'of', 'on', 'or', 'please', 'provide',
  'show', 'tell', 'that', 'the', 'their', 'this', 'to', 'what', 'when', 'where',
  'who', 'why', 'with', 'you', 'your'
]);

function normalizeSearchText(value = '') {
  return String(value)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_>#|()[\]{}"'“”‘’]/g, ' ')
    .replace(/[?!,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchTokens(query = '') {
  return Array.from(new Set(
    normalizeSearchText(query)
      .toLowerCase()
      .split(/\s+/)
      .map(token => token.replace(/[^a-z0-9]+/gi, ''))
      .filter(token => token.length > 2 && !SEARCH_STOP_WORDS.has(token))
  ));
}

function latestUserTopic(history = []) {
  if (!Array.isArray(history)) {
    return '';
  }

  for (const message of history) {
    if (message?.role !== 'user') {
      continue;
    }

    const text = normalizeSearchText(message.content);
    if (!text) {
      continue;
    }

    const isMediaOnlyFollowUp =
      text.length < 40 &&
      /\b(more|another|again|same|that|this|these|those|image|images|photo|photos|picture|pictures|video|videos|youtube|tutorial|resources)\b/i.test(text);

    if (!isMediaOnlyFollowUp) {
      return text;
    }
  }

  return '';
}

function cleanMediaQuery(rawQuery = '', type = 'image', maxLength = 96) {
  let query = normalizeSearchText(rawQuery);

  query = query
    .replace(/\b(can you|could you|would you|please|pls|kindly)\b/gi, ' ')
    .replace(/\b(tell me|show me|find me|get me|give me|bring me|i want|i need|want me to)\b/gi, ' ')
    .replace(/\b(who is|what is|what are|explain|describe|analyze|analyse|identify|provide|create|make)\b/gi, ' ')
    .replace(/\b(proper|relevant|best|good|some|only|latest)\b/gi, ' ');

  if (type === 'image') {
    query = query.replace(/\b(image|images|photo|photos|picture|pictures|visual|look like|looks like)\b/gi, ' ');
  } else {
    query = query.replace(/\b(youtube|video|videos|watch|resources?)\b/gi, ' ');
  }

  query = normalizeSearchText(query);

  if (!query) {
    return '';
  }

  if (type === 'youtube' && !/\b(explained|tutorial|lecture|guide|course)\b/i.test(query)) {
    query = `${query} explained`;
  }

  return query.slice(0, maxLength).trim();
}

function buildMediaSearchPlan({ prompt, history, extra } = {}) {
  const cleanPrompt = normalizeSearchText(prompt);
  const lowerPrompt = cleanPrompt.toLowerCase();
  const topicFromHistory = latestUserTopic(history);
  const isFollowUp =
    cleanPrompt.length < 36 ||
    /^(more|continue|next|another|again|same|that|this|these|those)\b/i.test(cleanPrompt);

  const baseTopic = isFollowUp && topicFromHistory
    ? `${topicFromHistory} ${cleanPrompt}`
    : cleanPrompt || topicFromHistory;

  const explicitImageIntent = /\b(image|images|photo|photos|picture|pictures|look like|looks like|visual)\b/i.test(lowerPrompt);
  const explicitVideoIntent = /\b(youtube|video|videos|tutorial|tutorials|lecture|lectures|course|courses|watch)\b/i.test(lowerPrompt);
  const visualEntityIntent =
    /\b(who is|what does|how does|look like|looks like)\b/i.test(lowerPrompt) ||
    /\b(cat|dog|animal|person|actor|actress|character|logo|place|monument|map|diagram|graph|chart|flowchart)\b/i.test(lowerPrompt);
  const abstractAnalysisIntent = /\b(analyze|analyse|transaction|network|financial pattern|layering|round tripping|benami|code|debug|error)\b/i.test(lowerPrompt);

  const imageQuery = cleanMediaQuery(
    [baseTopic, explicitImageIntent || visualEntityIntent ? '' : extra].filter(Boolean).join(' '),
    'image'
  );
  const youtubeQuery = cleanMediaQuery(baseTopic, 'youtube');

  return {
    originalPrompt: cleanPrompt,
    imageQuery,
    youtubeQuery,
    shouldFetchImages: Boolean(imageQuery && (explicitImageIntent || (visualEntityIntent && !abstractAnalysisIntent))),
    shouldFetchVideos: Boolean(youtubeQuery && explicitVideoIntent),
  };
}

function hostnameFromUrl(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function scoreSearchResult(result, query, fields = {}) {
  const tokens = searchTokens(query);
  if (!tokens.length) {
    return 0;
  }

  const title = String(fields.title ?? result?.title ?? '').toLowerCase();
  const description = String(fields.description ?? result?.description ?? '').toLowerCase();
  const url = String(fields.url ?? result?.pageUrl ?? result?.url ?? result?.imageUrl ?? '').toLowerCase();
  const channel = String(fields.channel ?? result?.channelTitle ?? '').toLowerCase();
  const combined = `${title} ${description} ${url} ${channel}`;
  const compactQuery = normalizeSearchText(query).toLowerCase();

  let score = compactQuery.length > 8 && combined.includes(compactQuery) ? 8 : 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 4;
    if (description.includes(token)) score += 2;
    if (url.includes(token)) score += 1;
    if (channel.includes(token)) score += 1;
  }

  return score;
}

function rerankImageResults(results = [], query, limit = 6) {
  const seen = new Set();
  return results
    .map(result => {
      const pageHost = hostnameFromUrl(result?.pageUrl);
      const imageHost = hostnameFromUrl(result?.imageUrl);
      const key = `${result?.imageUrl || ''}|${result?.pageUrl || ''}`;
      let score = scoreSearchResult(result, query);
      if (/instagram|pinterest|facebook|tiktok/.test(pageHost)) {
        score -= 2;
      }
      return { result, score, key, host: pageHost || imageHost };
    })
    .filter(item => item.result?.imageUrl && item.score >= 2 && !seen.has(item.key) && seen.add(item.key))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.result);
}

function rerankVideoResults(results = [], query, limit = 5) {
  const seen = new Set();
  return results
    .map(result => ({
      result,
      score: scoreSearchResult(result, query, {
        title: result?.title,
        description: result?.description,
        channel: result?.channelTitle,
        url: result?.url,
      }),
      key: result?.videoId || result?.url || result?.title,
    }))
    .filter(item => item.result && item.key && item.score >= 2 && !seen.has(item.key) && seen.add(item.key))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.result);
}

function logMediaDiagnostics(plan, payload = {}) {
  if (process.env.NODE_ENV !== 'development') {
    return;
  }

  console.log('[mediaSearch]', {
    prompt: plan.originalPrompt,
    imageQuery: plan.imageQuery,
    youtubeQuery: plan.youtubeQuery,
    shouldFetchImages: plan.shouldFetchImages,
    shouldFetchVideos: plan.shouldFetchVideos,
    imageTitles: payload.images?.map(item => item.title).filter(Boolean),
    videoTitles: payload.videos?.map(item => item.title).filter(Boolean),
  });
}

function geminiRetryDelayFromHeaders(headers, fallbackMs = 300000) {
  const retryAfter = headers?.get?.('retry-after');
  if (!retryAfter) {
    return fallbackMs;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, seconds * 1000);
  }

  const retryDate = Date.parse(retryAfter);
  if (Number.isFinite(retryDate)) {
    return Math.max(1000, retryDate - Date.now());
  }

  return fallbackMs;
}

async function fetchGeminiStreamWithKeyRotation({ body, signal }) {
  const maxAttempts = getGeminiMaxAttempts();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const keyInfo = getNextGeminiApiKey();
    if (!keyInfo) {
      lastError = new Error('All Gemini API keys are currently cooling down');
      break;
    }

    const url = `${BASE_URL}/${MODEL_ID}:streamGenerateContent?alt=sse&key=${keyInfo.key}`;
    console.log(`[chatStream] Gemini stream attempt ${attempt}/${maxAttempts} using key index ${keyInfo.index}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
        },
        body: JSON.stringify(body),
        signal
      });

      if (response.ok && response.body) {
        markGeminiApiKeyHealthy(keyInfo.index);
        rotateGeminiApiKey();
        return { upstream: response, attempts: attempt };
      }

      const text = await response.text().catch(() => response.statusText);
      lastError = new Error(text || response.statusText || `Gemini HTTP ${response.status}`);

      if (isRetryableGeminiError(response.status, text) && attempt < maxAttempts) {
        const retryAfterMs = geminiRetryDelayFromHeaders(response.headers);
        console.warn(`[chatStream] Gemini key index ${keyInfo.index} hit retryable status ${response.status}; trying next key`);
        markGeminiApiKeyFailed(keyInfo.index, retryAfterMs);
        await sleep(250 * attempt);
        continue;
      }

      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[chatStream] Gemini stream attempt ${attempt} failed: ${message}`);

      if ((message.includes('timeout') || message.includes('fetch') || message.includes('aborted')) && attempt < maxAttempts) {
        markGeminiApiKeyFailed(keyInfo.index, 60000);
        await sleep(250 * attempt);
        continue;
      }

      break;
    }
  }

  return { upstream: null, error: lastError, attempts: maxAttempts };
}

/**
 * Search YouTube videos using MCP
 * @param {string} query - Search query
 * @param {string} userId - User ID for rate limiting
 * @returns {Promise<Array>} - Array of video results
 */
async function searchYouTubeVideos(query, userId, options = {}) {
  if (!youtubeMCP) {
    console.log('[YouTube MCP] YouTube search disabled - no API key configured');
    return [];
  }

  try {
    console.log('[YouTube MCP] Searching for:', query);
    const result = await youtubeMCP.search({
      query,
      maxResults: options.maxResults || 12,
      order: 'relevance',
      userId
    });

    if (result.success && result.results) {
      console.log(`[YouTube MCP] Found ${result.results.length} videos`);
      return result.results;
    }

    return [];
  } catch (error) {
    console.error('[YouTube MCP] Search failed:', error.message);
    // Don't fail the entire request if YouTube search fails
    return [];
  }
}

// Generate chat response and store in conversation
export async function handleChatGenerate(req, res) {
  try {
    const start = Date.now();
    // For multipart/form-data, fields come as strings; parse options safely
    const { prompt, conversationId } = req.body || {};
    let { options } = req.body || {};
    if (options && typeof options === 'string') {
      try { options = JSON.parse(options); } catch { options = {}; }
    }
    options = options || {};

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    // userId is set by optionalAuth middleware
    const userId = req.userId;
    let currentConversationId = conversationId;

    // After getting the userId from req.userId
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('username, email') // Select the fields you need
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('Error fetching user data:', userError);
      // Handle error or continue without username
    }

    const username = userData?.username || 'User';
    const userEmail = userData?.email || '';

    console.log('[handleChatGenerate] User info:', { userId, username, userEmail });

    // If no conversation ID provided, create a new conversation
    const isNewConversation = !currentConversationId;
    if (!currentConversationId) {
      const initialConversationTitle = await generateConversationTitle(prompt);
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .insert({
          user_id: userId,
          title: initialConversationTitle
        })
        .select()
        .single();

      if (convError) {
        console.error('Error creating conversation:', convError);
        return res.status(500).json({ error: 'Failed to create conversation' });
      }

      currentConversationId = conversation.id;
    }

    // Get last 10 messages for context
    const { data: messages, error: historyError } = await supabase
      .from('messages')
      .select('role, content, sources, images, videos, excalidraw')
      .eq('conversation_id', currentConversationId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (historyError) {
      console.error('Error fetching history:', historyError);
      return res.status(500).json({ error: 'Failed to fetch conversation history' });
    }

    // Reverse to get chronological order
    const chatHistory = messages ? [...messages].reverse().map(m => ({
      role: m.role,
      parts: [{ text: m.content }]
    })) : [];

    // Add current user message to history
    chatHistory.push({
      role: 'user',
      parts: [{ text: prompt }]
    });

    // Determine includeSearch similar to geminiController: default false if files provided
    const uploads = Array.isArray(req.files) ? req.files : [];
    const effectiveIncludeSearch = typeof options.includeSearch === 'boolean'
      ? options.includeSearch
      : (uploads.length === 0);

    // Generate AI response
    const response = await generateContent(prompt, userId, {
      history: chatHistory.slice(-10), // Only keep last 10 messages for context
      includeSearch: effectiveIncludeSearch,
      uploads,
      username,
      // Reset history when new files arrive unless explicitly kept
      resetHistory: uploads.length > 0 && options.keepHistoryWithFiles !== true
    });

    const processingTime = Date.now() - start;
    const mediaPlan = buildMediaSearchPlan({ prompt, history: messages });
    const includeImageSearch =
      options.includeImageSearch === true ||
      (options.includeImageSearch !== false && mediaPlan.shouldFetchImages);
    const rawImageResults = includeImageSearch && mediaPlan.imageQuery
      ? await searchImages(mediaPlan.imageQuery, { num: 10 })
      : [];
    const imageResults = rerankImageResults(rawImageResults, mediaPlan.imageQuery);
    logMediaDiagnostics(mediaPlan, { images: imageResults });

    const aiContent = response?.content || response?.text || '';
    const aiSources = Array.isArray(response?.sources) ? response.sources : [];
    const aiCodeSnippets = Array.isArray(response?.codeSnippets) ? response.codeSnippets : [];
    const aiExecutionOutputs = Array.isArray(response?.executionOutputs) ? response.executionOutputs : [];
    const aiExcalidrawData = Array.isArray(response?.excalidrawData) ? response.excalidrawData : null;

    // If content is empty but we have excalidrawData, add a default message
    let finalContent = aiContent;
    if (!finalContent && aiExcalidrawData && aiExcalidrawData.length > 0) {
      finalContent = "I've created a flowchart for you. You can view, download, or expand it below.";
    }

    const { error: saveError } = await supabase
      .from('messages')
      .insert([
        {
          conversation_id: currentConversationId,
          role: 'user',
          content: prompt,
          sources: [],
          images: null
        },
        {
          conversation_id: currentConversationId,
          role: 'model',
          content: finalContent,
          sources: aiSources,
          images: imageResults.length > 0 ? imageResults : null,
          excalidraw: aiExcalidrawData // Store in new column
        }
      ]);

    if (saveError) {
      console.error('Error saving messages:', saveError);
      // Don't fail the request, just log the error
    }

    // Optionally bump conversation updated_at
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', currentConversationId);

    if (isNewConversation) {
      void updateConversationTitle(currentConversationId, prompt, finalContent);
    }

    const apiResponse = {
      content: finalContent,
      sources: aiSources,
      images: imageResults,
      codeSnippets: aiCodeSnippets,
      executionOutputs: aiExecutionOutputs,
      excalidrawData: aiExcalidrawData, // Include in API response
      timestamp: new Date().toISOString(),
      processingTime,
      attempts: response?.attempts || 1,
      conversationId: currentConversationId
    };

    res.json(apiResponse);

  } catch (error) {
    console.error('Error in handleChatGenerate:', error);
    res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Stream chat response with database persistence
export async function handleChatStreamGenerate(req, res) {
  try {
    const { prompt: rawPrompt, conversationId } = req.body || {};
    // Parse options (may be JSON string for multipart)
    let { options: rawOptions } = req.body || {};
    if (rawOptions && typeof rawOptions === 'string') {
      try { rawOptions = JSON.parse(rawOptions); } catch { rawOptions = {}; }
    }
    const options = typeof rawOptions === 'object' && rawOptions !== null ? rawOptions : {};
    const prompt = String(rawPrompt || '').trim();

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const userId = req.userId;
    let currentConversationId = conversationId;
    let streamedContent = '';
    const streamedSources = new Set();
    let finalSourcesWithTitles = []; // Store final sources to save to DB
    let streamedExcalidrawData = []; // Capture generated charts
    let streamComplete = false; // Track if we received finishReason: "STOP"
    let lastFinishReason = null; // Store the finish reason for validation
    // After getting the userId from req.userId
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('username, email') // Select the fields you need
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('Error fetching user data:', userError);
      // Handle error or continue without username
    }

    const username = userData?.username || 'User';
    const userEmail = userData?.email || '';

    console.log('[handleChatStreamGenerate] User info:', { userId, username, userEmail });
    // If no conversation ID provided, create a new conversation
    const isNewConversation = !currentConversationId;
    if (!currentConversationId) {
      const initialConversationTitle = await generateConversationTitle(prompt);
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .insert({
          user_id: userId,
          title: initialConversationTitle
        })
        .select()
        .single();

      if (convError) {
        console.error('Error creating conversation:', convError);
        return res.status(500).json({ error: 'Failed to create conversation' });
      }

      currentConversationId = conversation.id;
    }

    // Get conversation history for context
    const { data: messages, error: historyError } = await supabase
      .from('messages')
      .select('role, content, sources, images, videos')
      .eq('conversation_id', currentConversationId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (historyError) {
      console.error('Error fetching history:', historyError);
      return res.status(500).json({ error: 'Failed to fetch conversation history' });
    }

    // Build chat history for Gemini (prior messages)
    const chatHistory = messages ? [...messages].reverse().map(m => ({
      role: m.role,
      parts: [{ text: m.content }]
    })) : [];

    // If uploads provided via multipart/form-data, include their extracted text and images
    let composedText = String(prompt);
    let imageParts = [];
    let uploadedText = '';
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length) {
        const extractedText = await extractTextFromUploads(files);
        const uploadedImages = await extractImagesFromUploads(files);
        if (extractedText) {
          uploadedText = extractedText;
          composedText += `\n\n--- Uploaded Files Text ---\n${extractedText}`;
        }
        if (uploadedImages.length) {
          imageParts = uploadedImages.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
        }
      }
    } catch (_) {
      // ignore upload extraction errors to keep streaming resilient
    }

    // Add current user message (text + any image inlineData)
    const userParts = [{ text: composedText }, ...imageParts];
    chatHistory.push({
      role: 'user',
      parts: userParts
    });

    // Default includeSearch to false when files exist unless explicitly overridden
    const files = Array.isArray(req.files) ? req.files : [];
    const includeSearch = typeof options.includeSearch === 'boolean' ? options.includeSearch : (files.length === 0);
    const systemPrompt = options.systemPrompt || RESEARCH_ASSISTANT_PROMPT({ username });
    const uploadContext = uploadedText ? uploadedText.slice(0, 400) : '';
    const mediaPlan = buildMediaSearchPlan({ prompt, history: messages, extra: uploadContext });
    const includeImageSearch =
      options.includeImageSearch === true ||
      (options.includeImageSearch !== false && mediaPlan.shouldFetchImages);
    const includeYouTube = options.includeYouTube === true || mediaPlan.shouldFetchVideos;

    // Prepare SSE response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const emitStatus = (id, label, state = 'running', detail) => {
      if (res.writableEnded) return;
      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify({ id, label, state, detail })}\n\n`);
    };

    // Send conversation ID immediately
    res.write(`event: conversationId\n`);
    res.write(`data: ${JSON.stringify({ conversationId: currentConversationId })}\n\n`);

    const body = buildRequestBody(chatHistory.slice(-10), systemPrompt, includeSearch);
    emitStatus('request-context', files.length > 0 ? 'Reading uploaded files' : 'Preparing context', 'complete');

    // Parallel search for images and YouTube videos
    console.log('[chatStream] includeYouTube:', includeYouTube, 'mediaPlan:', mediaPlan);
    if (includeImageSearch && mediaPlan.imageQuery) {
      emitStatus('image-search', 'Searching images', 'running', mediaPlan.imageQuery);
    }
    if (includeYouTube && mediaPlan.youtubeQuery) {
      emitStatus('youtube-search', 'Searching videos', 'running', mediaPlan.youtubeQuery);
    }

    const imageResultsPromise = includeImageSearch && mediaPlan.imageQuery
      ? searchImages(mediaPlan.imageQuery, { num: 10 })
      : Promise.resolve([]);
    const youtubeResultsPromise = includeYouTube && mediaPlan.youtubeQuery
      ? searchYouTubeVideos(mediaPlan.youtubeQuery, userId, { maxResults: 12 })
      : Promise.resolve(null);

    const [rawImageResults, youtubeResultsPayload] = await Promise.all([imageResultsPromise, youtubeResultsPromise]);
    const imageResults = rerankImageResults(rawImageResults, mediaPlan.imageQuery);
    console.log('[chatStream] youtubeResultsPayload:', youtubeResultsPayload);
    const rawYoutubeVideos = Array.isArray(youtubeResultsPayload)
      ? youtubeResultsPayload
      : Array.isArray(youtubeResultsPayload?.results)
        ? youtubeResultsPayload.results
        : [];
    const youtubeVideos = rerankVideoResults(rawYoutubeVideos, mediaPlan.youtubeQuery);
    console.log('[chatStream] youtubeVideos count:', youtubeVideos.length);
    logMediaDiagnostics(mediaPlan, { images: imageResults, videos: youtubeVideos });

    if (includeImageSearch && mediaPlan.imageQuery) {
      emitStatus(
        'image-search',
        imageResults.length > 0 ? 'Found image references' : 'No image references found',
        'complete',
        imageResults.length > 0 ? `${imageResults.length} result${imageResults.length === 1 ? '' : 's'}` : undefined
      );
    }
    if (includeYouTube && mediaPlan.youtubeQuery) {
      emitStatus(
        'youtube-search',
        youtubeVideos.length > 0 ? 'Found video references' : 'No video references found',
        'complete',
        youtubeVideos.length > 0 ? `${youtubeVideos.length} result${youtubeVideos.length === 1 ? '' : 's'}` : undefined
      );
    }

    if (imageResults.length > 0) {
      res.write(`event: images\n`);
      res.write(`data: ${JSON.stringify({ images: imageResults })}\n\n`);
    }

    if (youtubeVideos.length > 0) {
      res.write(`event: youtubeResults\n`);
      res.write(`data: ${JSON.stringify({ videos: youtubeVideos })}\n\n`);
    }

    emitStatus('model-generation', 'Generating answer', 'running');
    const streamResult = await fetchGeminiStreamWithKeyRotation({ body });
    const upstream = streamResult.upstream;

    if (!upstream?.body) {
      const errorMessage = streamResult.error?.message || "Gemini stream unavailable";
      emitStatus('model-generation', 'Generation failed', 'error', errorMessage);
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: errorMessage, attempts: streamResult.attempts })}\n\n`);
      return res.end();
    }

    // Track content for database persistence and emit SSE events for text, code, and sources
    let sseBuffer = '';

    const processSSEBlock = async (block) => {
      const dataLine = block
        .split(/\r?\n/)
        .find(l => l.startsWith('data: '));

      if (!dataLine) return;
      const payload = dataLine.slice(6).trim();
      if (!payload || payload === '[DONE]') return;

      try {
        const obj = JSON.parse(payload);
        const cand = obj?.candidates?.[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            // Text chunks
            if (typeof p?.text === 'string' && p.text.length) {
              streamedContent += p.text;
              res.write(`event: message\n`);
              res.write(`data: ${JSON.stringify({ text: p.text })}\n\n`);
            }

            // Executable code
            if (p?.executableCode && typeof p.executableCode.code === 'string') {
              const codePayload = {
                language: p.executableCode.language || 'unknown',
                code: p.executableCode.code
              };
              res.write(`event: code\n`);
              res.write(`data: ${JSON.stringify(codePayload)}\n\n`);
            }

            // Code execution result
            if (p?.codeExecutionResult && typeof p.codeExecutionResult.output === 'string') {
              const resultPayload = {
                outcome: p.codeExecutionResult.outcome || 'unknown',
                output: p.codeExecutionResult.output
              };
              res.write(`event: codeResult\n`);
              res.write(`data: ${JSON.stringify(resultPayload)}\n\n`);
            }

            // Function calls (e.g., Excalidraw generation)
            if (p?.functionCall) {
              console.log('[chatStream] Function call detected:', p.functionCall);

              // Handle Excalidraw flowchart generation
              if (p.functionCall.name === 'generate_excalidraw_flowchart') {
                try {
                  console.log('[chatStream] Executing Excalidraw generation');
                  emitStatus('flowchart-generation', 'Creating flowchart', 'running');
                  const { generateExcalidrawFlowchart } = await import('../helpers/groq.js');
                  const flowchartData = await generateExcalidrawFlowchart(
                    p.functionCall.args.prompt,
                    {
                      style: p.functionCall.args.style || 'modern',
                      complexity: p.functionCall.args.complexity || 'detailed'
                    }
                  );

                  // Capture for DB save
                  streamedExcalidrawData.push(flowchartData);

                  // Emit excalidraw event
                  res.write(`event: excalidraw\n`);
                  res.write(`data: ${JSON.stringify({ excalidrawData: [flowchartData] })}\n\n`);

                  // Also emit a text message about the flowchart
                  const message = "I've created a flowchart for you. You can view, download, or expand it below.";
                  streamedContent += message;
                  res.write(`event: message\n`);
                  res.write(`data: ${JSON.stringify({ text: message })}\n\n`);

                  emitStatus('flowchart-generation', 'Flowchart ready', 'complete');
                  console.log('[chatStream] Excalidraw flowchart generated and emitted');
                } catch (error) {
                  console.error('[chatStream] Error generating Excalidraw:', error);
                  emitStatus('flowchart-generation', 'Flowchart failed', 'error', error.message);
                  const errorMsg = `\n\n[Note: Failed to generate flowchart: ${error.message}]`;
                  streamedContent += errorMsg;
                  res.write(`event: message\n`);
                  res.write(`data: ${JSON.stringify({ text: errorMsg })}\n\n`);
                }
              }
            }
          }
        }

        // Collect sources from grounding metadata if present
        const groundingChunks = cand?.groundingMetadata?.groundingChunks;
        if (Array.isArray(groundingChunks)) {
          for (const gc of groundingChunks) {
            const uri = gc?.web?.uri;
            if (typeof uri === 'string' && uri.startsWith('http')) {
              streamedSources.add(uri);
            }
          }
          if (groundingChunks.length) {
            console.log(
              '[chatStream] collected grounding URLs from chunk:',
              groundingChunks.map(g => g?.web?.uri).filter(Boolean)
            );
          }
        }

        // Track finish reason to ensure stream completion
        if (cand?.finishReason) {
          lastFinishReason = cand.finishReason;
          if (cand.finishReason === 'STOP') {
            streamComplete = true;
            console.log('[chatStream] Received finishReason: STOP - stream is complete');
          }
          const emitFinish = () => {
            if (res.writableEnded) return;
            res.write(`event: finish\n`);
            res.write(`data: ${JSON.stringify({ finishReason: cand.finishReason })}\n\n`);
          };

          if (cand.finishReason === 'STOP') {
            setTimeout(emitFinish, STREAM_FINISH_DEBOUNCE_MS);
          } else {
            emitFinish();
          }
        }
      } catch (e) {
        // Most parse errors will be due to partial JSON; the remainder stays in sseBuffer
        console.warn('Failed to parse SSE JSON block:', e.message);
      }
    };

    upstream.body.on("data", async (chunk) => {
      const chunkStr = chunk.toString();
      console.log('Received chunk from Gemini:', chunkStr);
      sseBuffer += chunkStr;

      // Split into SSE blocks; last block may be incomplete and stays in buffer
      const blocks = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = blocks.pop() || '';

      for (const block of blocks) {
        await processSSEBlock(block);
      }
    });

    upstream.body.on("end", async () => {
      console.log('Gemini stream ended');
      console.log(`[chatStream] Stream completion status: streamComplete=${streamComplete}, lastFinishReason=${lastFinishReason}, contentLength=${streamedContent.length}`);

      // Process any trailing buffer that lacked the final delimiter
      if (sseBuffer.trim().length > 0) {
        console.log('[chatStream] Flushing trailing SSE buffer block');
        await processSSEBlock(sseBuffer);
        sseBuffer = '';
      }

      try {
        let mermaidProcessingResult = { content: streamedContent, blocks: [] };
        try {
          emitStatus('diagram-check', 'Checking diagrams', 'running');
          mermaidProcessingResult = await processMermaidBlocks({
            content: streamedContent,
            prompt,
            userId,
          });
          streamedContent = mermaidProcessingResult.content;
          if (mermaidProcessingResult.blocks.length > 0 && !res.writableEnded) {
            res.write(`event: mermaid\n`);
            res.write(`data: ${JSON.stringify({ blocks: mermaidProcessingResult.blocks })}\n\n`);
          }
          emitStatus(
            'diagram-check',
            mermaidProcessingResult.blocks.length > 0 ? 'Diagrams updated' : 'No diagrams to update',
            'complete'
          );
        } catch (mermaidError) {
          console.warn('Mermaid processing failed:', mermaidError?.message || mermaidError);
          emitStatus('diagram-check', 'Diagram check failed', 'error', mermaidError?.message || 'Unable to check diagrams');
        }

        if (streamedSources.size > 0) {
          console.log(`[chatStream] emitting sources from streamed grounding: count=${streamedSources.size}`);
          emitStatus('source-fetch', 'Resolving web sources', 'running', `${streamedSources.size} source${streamedSources.size === 1 ? '' : 's'}`);
          // Resolve titles for sources concurrently (limit simple)
          const urls = Array.from(streamedSources);
          const titlePromises = urls.map(async (u) => ({ url: u, title: await fetchPageTitle(u) }));
          try {
            finalSourcesWithTitles = await Promise.all(titlePromises);
          } catch (_) {
            finalSourcesWithTitles = urls.map(u => ({ url: u }));
          }

          // Emit structured sources event
          console.log('[chatStream] sourcesWithTitles:', finalSourcesWithTitles);
          res.write(`event: sources\n`);
          res.write(`data: ${JSON.stringify({ sources: finalSourcesWithTitles })}\n\n`);
          emitStatus('source-fetch', 'Sources ready', 'complete', `${finalSourcesWithTitles.length} source${finalSourcesWithTitles.length === 1 ? '' : 's'}`);
        } else {
          console.log('[chatStream] no streamed grounding sources found');
          if (!res.writableEnded) {
            res.write(`event: sources\n`);
            res.write(`data: {"sources": []}\n\n`);
          }
          emitStatus('source-fetch', 'No web sources found', 'complete');
        }
      } catch (e) {
        console.warn('Failed to emit sources/title message:', e?.message || e);
      }

      // Save messages to database ONLY after streaming completes with finishReason: STOP
      try {
        if (!streamComplete) {
          console.warn('[chatStream] WARNING: Stream ended without finishReason: STOP. Content may be incomplete. streamComplete=', streamComplete, 'lastFinishReason=', lastFinishReason);
        }

        console.log(`[chatStream] Saving to database: contentLength=${streamedContent.length}, sourcesCount=${finalSourcesWithTitles.length}, streamComplete=${streamComplete}`);

        const { data: insertedStreamMessages, error: saveError } = await supabase
          .from('messages')
          .insert([
            {
              conversation_id: currentConversationId,
              role: 'user',
              content: prompt,
              sources: []
            },
            {
              conversation_id: currentConversationId,
              role: 'model',
              content: streamedContent,
              sources: finalSourcesWithTitles,
              images: imageResults,
              videos: youtubeVideos.length > 0 ? youtubeVideos : null,
              excalidraw: streamedExcalidrawData.length > 0 ? streamedExcalidrawData : null
            }
          ]);

        if (saveError) {
          console.error('Error saving streamed messages:', saveError);
        } else {
          console.log(`[chatStream] Successfully saved messages with ${finalSourcesWithTitles.length} sources and ${streamedContent.length} characters`);
        }

        // Update conversation timestamp
        await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', currentConversationId);

        if (isNewConversation) {
          void updateConversationTitle(currentConversationId, prompt, streamedContent);
        }

      } catch (dbError) {
        console.error('Database error after streaming:', dbError);
      }

      await sleep(STREAM_CLOSE_DELAY_MS);
      emitStatus('model-generation', 'Answer complete', 'complete');
      res.end();
    });

    upstream.body.on("error", (err) => {
      console.error('Gemini stream error:', err);
      try {
        emitStatus('model-generation', 'Generation failed', 'error', err?.message || 'stream error');
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: err?.message || "stream error" })}\n\n`);
      } finally {
        res.end();
      }
    });

  } catch (error) {
    console.error('Error in handleChatStreamGenerate:', error);
    // Ensure we don't hang the stream on unexpected errors
    try {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
      }
      if (!res.writableEnded) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: error?.message || 'stream error' })}\n\n`);
      }
    } catch (_) {
      // swallow
    } finally {
      if (!res.writableEnded) {
        try { res.end(); } catch { }
      }
    }
  }
}

// Get all conversations for the authenticated user
export async function getConversations(req, res) {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: conversations, error } = await supabase
      .from('conversations')
      .select('id, title, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('Error fetching conversations:', error);
      return res.status(500).json({ error: 'Failed to fetch conversations' });
    }

    res.json(conversations);
  } catch (error) {
    console.error('Error in getConversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getConversationHistory(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    // Fetch conversation and verify ownership (if user is authenticated)
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, user_id, title, created_at, updated_at')
      .eq('id', conversationId)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (userId && conversation.user_id && conversation.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select('id, role, content, sources, charts, images, videos, excalidraw, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (messagesError) {
      console.error('Error fetching conversation history:', messagesError);
      return res.status(500).json({ error: 'Failed to fetch conversation history' });
    }

    res.json({
      id: conversation.id,
      title: conversation.title,
      user_id: conversation.user_id,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
      messages: messages || []
    });
  } catch (error) {
    console.error('Error in getConversationHistory:', error);
    const isNetwork = (error?.message || '').toLowerCase().includes('fetch failed');
    res.status(isNetwork ? 503 : 500).json({
      error: isNetwork ? 'Supabase network error while fetching conversation' : error.message,
      hint: isNetwork ? 'Verify SUPABASE_URL/SUPABASE_ANON_KEY and internet connectivity on the server' : undefined
    });
  }
}

// Delete a conversation and its messages (requires authentication)
export async function deleteConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    // Verify ownership
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, user_id')
      .eq('id', conversationId)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete messages first
    const { error: msgDelError } = await supabase
      .from('messages')
      .delete()
      .eq('conversation_id', conversationId);
    if (msgDelError) {
      console.error('Error deleting messages:', msgDelError);
      return res.status(500).json({ error: 'Failed to delete conversation messages' });
    }

    // Delete conversation
    const { error: convDelError } = await supabase
      .from('conversations')
      .delete()
      .eq('id', conversationId);
    if (convDelError) {
      console.error('Error deleting conversation:', convDelError);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error in deleteConversation:', error);
    res.status(500).json({ error: error.message });
  }
}
