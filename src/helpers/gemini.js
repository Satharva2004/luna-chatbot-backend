// helpers/gemini.js
import fetch from "node-fetch";
import { RESEARCH_ASSISTANT_PROMPT } from "../prompts/researchAssistantPrompt.js";
import { generateExcalidrawFlowchart } from "./groq.js";

import env from "../config/env.js";

export const AVAILABLE_MODELS = {
  fast: 'gemini-2.5-flash-lite-preview-06-17',
  smart: 'gemini-2.5-flash',
  best: 'gemini-2.5-pro',
};

const EXPERT_PROMPTS = {
  'research': RESEARCH_ASSISTANT_PROMPT,
  'default': RESEARCH_ASSISTANT_PROMPT,
};

function collectGeminiApiKeys() {
  const candidates = [
    env.GEMINI_API_KEYS,
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY2,
    env.GEMINI_API_KEY3,
    env.GEMINI_API_KEY4,
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4,
  ];

  const keys = candidates
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(keys));
}

const GEMINI_API_KEYS = collectGeminiApiKeys();
console.log(`[gemini] Key pool initialized: ${GEMINI_API_KEYS.length} key(s) loaded`);

export const MODEL_ID = "gemini-2.5-flash-lite";
export const GENERATE_CONTENT_API = "generateContent";
export const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Configuration constants
const CONFIG = {
  MAX_HISTORY_LENGTH: 10,
  MAX_OUTPUT_TOKENS: 65536,
  MAX_USERS: 100,
  RETRY_DELAY: 1000, // 1 second
  REQUEST_TIMEOUT: 90000,
  TITLE_FETCH_TIMEOUT: 5000,
  MAX_TITLE_LENGTH: 100,
  MAX_TITLE_CACHE_SIZE: 500,
};

// Excalidraw flowchart generation function declaration for Gemini
const EXCALIDRAW_FUNCTION_DECLARATION = {
  name: "generate_excalidraw_flowchart",
  description: "Generate an interactive diagram using Excalidraw. Use this function when the user asks for ANY type of diagram, chart, flowchart, visual representation, or graphical illustration including: flowcharts, process diagrams, workflow diagrams, use case diagrams, sequence diagrams, system architecture diagrams, data flow diagrams, mind maps, organizational charts, network diagrams, or any visual representation of concepts, processes, or relationships. This function returns Excalidraw-compatible JSON that renders as an interactive, editable diagram.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed description of the diagram to generate. Include all elements, relationships, flow direction, and labels. Be specific about what to show. Examples: 'User authentication flow with login and signup', 'E-commerce checkout process', 'Use case diagram for banking app with actors and use cases', 'System architecture showing frontend, backend, and database', 'Class diagram for e-commerce system'"
      },
      style: {
        type: "string",
        description: "Visual style preference for the diagram",
        enum: ["minimal", "modern", "detailed"]
      },
      complexity: {
        type: "string",
        description: "Complexity level of the diagram",
        enum: ["simple", "moderate", "detailed"]
      }
    },
    required: ["prompt"]
  }
};

// Retryable HTTP status codes
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

// Bounded LRU cache for page titles to avoid repeated requests and memory leaks
const titleCache = new Map();

class ChatHistoryManager {
  constructor(maxUsers = CONFIG.MAX_USERS) {
    // Uses Map insertion-order for O(1) LRU eviction
    this.history = new Map();
    this.maxUsers = maxUsers;
  }

  get(userId) {
    const entry = this.history.get(userId);
    if (entry !== undefined) {
      // Move to end (most recently used) by re-inserting
      this.history.delete(userId);
      this.history.set(userId, entry);
    }
    return entry || [];
  }

  set(userId, messages) {
    // Delete first so re-insert moves it to end
    this.history.delete(userId);

    // Evict oldest (first key in Map) if at capacity
    if (this.history.size >= this.maxUsers) {
      const oldestKey = this.history.keys().next().value;
      this.history.delete(oldestKey);
    }

    this.history.set(userId, messages);
  }

  clear(userId) {
    this.history.delete(userId);
  }
}

class APIKeyManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIndex = 0;
    this.failedKeys = new Set();
    this.keyRetryTime = new Map();
    this.requestCounts = new Map(); // keyIndex → total requests made
  }

  incrementCount(keyIndex) {
    this.requestCounts.set(keyIndex, (this.requestCounts.get(keyIndex) || 0) + 1);
  }

  getTotalRequests() {
    let total = 0;
    for (const count of this.requestCounts.values()) total += count;
    return total;
  }

  getCurrentKey() {
    if (this.keys.length === 0) return null;
    return this.keys[this.currentIndex];
  }

  markKeyFailed(keyIndex, retryAfter = 60000) { // 1 minute default
    this.failedKeys.add(keyIndex);
    this.keyRetryTime.set(keyIndex, Date.now() + retryAfter);
  }

  markKeyHealthy(keyIndex) {
    this.failedKeys.delete(keyIndex);
    this.keyRetryTime.delete(keyIndex);
  }

  getNextAvailableKey() {
    const now = Date.now();

    // Reset failed keys that are ready for retry
    for (const [keyIndex, retryTime] of this.keyRetryTime.entries()) {
      if (now >= retryTime) {
        this.failedKeys.delete(keyIndex);
        this.keyRetryTime.delete(keyIndex);
      }
    }

    // Find next available key
    for (let i = 0; i < this.keys.length; i++) {
      const keyIndex = (this.currentIndex + i) % this.keys.length;
      if (!this.failedKeys.has(keyIndex)) {
        this.currentIndex = keyIndex;
        return { key: this.keys[keyIndex], index: keyIndex };
      }
    }

    return null; // All keys failed
  }

  rotateKey() {
    if (this.keys.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
  }
}

/**
 * Fetch page title from URL
 * @param {string} url - The URL to fetch title from
 * @returns {Promise<string>} - The page title or fallback
 */
async function fetchPageTitle(url) {
  // Check cache first
  if (titleCache.has(url)) {
    return titleCache.get(url);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TITLE_FETCH_TIMEOUT);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();

    // Extract title using regex (simple but effective for most cases)
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = titleMatch ? titleMatch[1].trim() : '';

    // Clean up title
    if (title) {
      title = title
        .replace(/\s+/g, ' ') // Replace multiple spaces with single space
        .replace(/[\r\n\t]/g, ' ') // Replace newlines and tabs with spaces
        .trim();

      // Truncate if too long
      if (title.length > CONFIG.MAX_TITLE_LENGTH) {
        title = title.substring(0, CONFIG.MAX_TITLE_LENGTH - 3) + '...';
      }
    }

    // Fallback to domain name if no title found
    if (!title) {
      try {
        const urlObj = new URL(url);
        title = urlObj.hostname.replace(/^www\./, '');
      } catch (e) {
        title = 'Untitled';
      }
    }

    // Cache the result (bounded)
    if (titleCache.size >= CONFIG.MAX_TITLE_CACHE_SIZE) {
      const oldestKey = titleCache.keys().next().value;
      titleCache.delete(oldestKey);
    }
    titleCache.set(url, title);

    return title;
  } catch (error) {
    console.warn(`Failed to fetch title for ${url}:`, error.message);

    // Fallback to domain name
    try {
      const urlObj = new URL(url);
      const fallback = urlObj.hostname.replace(/^www\./, '');
      titleCache.set(url, fallback);
      return fallback;
    } catch (e) {
      const fallback = 'Link';
      titleCache.set(url, fallback);
      return fallback;
    }
  }
}

/**
 * Process sources to include titles
 * @param {Set<string>} sources - Set of URLs
 * @returns {Promise<Array>} - Array of source objects with titles
 */
async function processSourcesWithTitles(sources) {
  if (!sources || sources.size === 0) return [];

  const sourceArray = Array.from(sources);
  const processedSources = [];

  // Process sources concurrently but limit to avoid overwhelming servers
  const BATCH_SIZE = 3;
  for (let i = 0; i < sourceArray.length; i += BATCH_SIZE) {
    const batch = sourceArray.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (url) => {
      const title = await fetchPageTitle(url);
      return { url, title };
    });

    try {
      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          processedSources.push(result.value);
        } else {
          // Fallback if promise rejected
          const url = batch[index];
          try {
            const urlObj = new URL(url);
            processedSources.push({
              url,
              title: urlObj.hostname.replace(/^www\./, '')
            });
          } catch (e) {
            processedSources.push({ url, title: 'Link' });
          }
        }
      });
    } catch (error) {
      console.warn('Error processing source batch:', error);
      // Add remaining URLs with fallback titles
      batch.forEach(url => {
        try {
          const urlObj = new URL(url);
          processedSources.push({
            url,
            title: urlObj.hostname.replace(/^www\./, '')
          });
        } catch (e) {
          processedSources.push({ url, title: 'Link' });
        }
      });
    }
  }
  return processedSources;
}

async function processGeminiResponse(response) {
  const result = { content: '', sources: new Set(), codeSnippets: [], executionOutputs: [], functionCalls: [] };

  try {
    // Handle streaming response (array of chunks) vs single response
    const responseChunks = Array.isArray(response) ? response : [response];

    let hasValidContent = false;
    let lastFinishReason = null;

    for (let i = 0; i < responseChunks.length; i++) {
      const chunk = responseChunks[i];

      const candidates = chunk.candidates;
      if (!candidates?.length) {
        console.warn(`No candidates in chunk ${i + 1}`);

        // Check for prompt feedback only in first chunk
        if (i === 0 && chunk.promptFeedback) {
          console.warn('Prompt feedback:', chunk.promptFeedback);
          if (chunk.promptFeedback.blockReason) {
            result.content = `Content blocked: ${chunk.promptFeedback.blockReason}`;
            return { content: result.content, sources: [], codeSnippets: [], executionOutputs: [], functionCalls: [] };
          }
        }
        continue;
      }

      const candidate = candidates[0];

      // Track finish reason from last chunk
      if (candidate.finishReason) {
        lastFinishReason = candidate.finishReason;
        console.log(`Chunk ${i + 1} finish reason:`, candidate.finishReason);
      }

      // Extract content from this chunk
      const parts = candidate.content?.parts;
      if (parts && Array.isArray(parts)) {
        const textParts = parts.filter(part => part.text && typeof part.text === 'string');

        if (textParts.length > 0) {
          const chunkContent = textParts.map(part => part.text).join('');
          result.content += chunkContent;
          hasValidContent = true;
          console.log(`Chunk ${i + 1} added ${chunkContent.length} characters`);
        }

        // Capture function calls (e.g., Excalidraw flowchart generation)
        for (const part of parts) {
          if (part.functionCall) {
            console.log('Function call detected:', part.functionCall);
            result.functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args
            });
          }

          // Capture executable code and code execution results when present
          if (part.executableCode && typeof part.executableCode.code === 'string') {
            result.codeSnippets.push({
              language: part.executableCode.language || 'unknown',
              code: part.executableCode.code
            });
          }

          if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
            result.executionOutputs.push({
              outcome: part.codeExecutionResult.outcome || 'unknown',
              output: part.codeExecutionResult.output
            });
          }
        }
      }

      // Extract sources from this chunk
      const groundingChunks = candidate.groundingMetadata?.groundingChunks;
      if (groundingChunks && Array.isArray(groundingChunks)) {
        groundingChunks
          .filter(chunk => chunk.web?.uri)
          .forEach(chunk => result.sources.add(chunk.web.uri));
      }
    }

    // Check final finish reason for blocking
    if (lastFinishReason === 'SAFETY') {
      result.content = 'Response blocked due to safety filters';
      return { content: result.content, sources: [], codeSnippets: [], executionOutputs: [], functionCalls: [] };
    }
    if (lastFinishReason === 'RECITATION') {
      result.content = 'Response blocked due to recitation concerns';
      return { content: result.content, sources: [], codeSnippets: [], executionOutputs: [], functionCalls: [] };
    }

    // If we have content, extract URLs (markdown links and plain URLs) into sources
    if (result.content && result.content.length > 0) {
      try {
        const text = result.content;
        // Extract markdown links: [title](url)
        const mdLinkRe = /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g;
        let m;
        while ((m = mdLinkRe.exec(text)) !== null) {
          if (m[1]) result.sources.add(m[1]);
        }
        // Extract plain URLs
        const urlRe = /(https?:\/\/[^\s)]+)(?![^\(]*\))/g;
        let u;
        while ((u = urlRe.exec(text)) !== null) {
          if (u[1]) result.sources.add(u[1]);
        }
      } catch (e) {
        console.warn('URL extraction from content failed:', e?.message || e);
      }

      // Light cleanup while preserving markdown links so users can click them
      result.content = result.content
        .replace(/\*\*\*.*?\*\*\*/g, '') // Remove triple-asterisk bold artifacts if any
        .replace(/\n{3,}/g, '\n\n')       // Remove excessive newlines
        .trim();
    }

    // Process sources with titles
    const processedSources = await processSourcesWithTitles(result.sources);

    // Execute function calls if any (e.g., Excalidraw flowchart generation)
    const excalidrawData = [];
    for (const functionCall of result.functionCalls) {
      if (functionCall.name === 'generate_excalidraw_flowchart') {
        try {
          console.log('Executing Excalidraw flowchart generation:', functionCall.args);
          const flowchartData = await generateExcalidrawFlowchart(
            functionCall.args.prompt,
            {
              style: functionCall.args.style || 'modern',
              complexity: functionCall.args.complexity || 'detailed'
            }
          );
          excalidrawData.push(flowchartData);
          console.log('Excalidraw flowchart generated successfully');
        } catch (error) {
          console.error('Error generating Excalidraw flowchart:', error);
          result.content += `\n\n[Note: Failed to generate flowchart: ${error.message}]`;
        }
      }
    }

    console.log(`Processed: ${result.content?.length || 0} chars, ${processedSources.length} sources, ${excalidrawData.length} diagrams`);

    return {
      content: result.content,
      sources: processedSources,
      codeSnippets: result.codeSnippets,
      executionOutputs: result.executionOutputs,
      functionCalls: result.functionCalls,
      excalidrawData: excalidrawData.length > 0 ? excalidrawData : undefined
    };

  } catch (error) {
    console.error('Error processing Gemini response:', error);
    return {
      content: `Error processing response: ${error.message}`,
      sources: [],
      codeSnippets: [],
      executionOutputs: [],
      functionCalls: []
    };
  }
}
export function buildRequestBody(messages, systemPrompt = null, includeSearch = true) {
  const body = {
    contents: messages,

    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_ONLY_HIGH"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_ONLY_HIGH"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_ONLY_HIGH"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_ONLY_HIGH"
      }
    ]
  };

  // Add system instruction if provided
  // Note: systemInstruction does not take a 'role' field in the Gemini API
  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  body.tools = [];

  // If search is requested, we prioritize it because combining custom functions
  // with google_search can sometimes lead to "unsupported" errors even on Pro models.
  if (includeSearch) {
    body.tools.push({
      google_search: {}
    });
  } else {
    // Only add Excalidraw if search is NOT enabled to avoid incompatibility errors
    body.tools.push({
      function_declarations: [EXCALIDRAW_FUNCTION_DECLARATION]
    });
  }

  return body;
}

async function fetchWithTimeout(url, options, timeout = CONFIG.REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

const chatHistory = new ChatHistoryManager();
const keyManager = new APIKeyManager(GEMINI_API_KEYS);

export function isRetryableGeminiError(status, message = '') {
  const normalizedMessage = String(message || '').toLowerCase();
  return (
    status === 429 ||
    RETRYABLE_STATUS_CODES.has(status) ||
    normalizedMessage.includes('quota') ||
    normalizedMessage.includes('exhausted') ||
    normalizedMessage.includes('resource has been exhausted') ||
    normalizedMessage.includes('rate limit')
  );
}

export function getGeminiMaxAttempts() {
  return Math.max(1, Math.min(GEMINI_API_KEYS.length * 2, 8));
}

export function getNextGeminiApiKey() {
  return keyManager.getNextAvailableKey();
}

export function markGeminiApiKeyFailed(keyIndex, retryAfter = 300000) {
  keyManager.markKeyFailed(keyIndex, retryAfter);
  keyManager.rotateKey();
}

export function markGeminiApiKeyHealthy(keyIndex) {
  keyManager.markKeyHealthy(keyIndex);
}

export function rotateGeminiApiKey() {
  keyManager.rotateKey();
}

export function incrementGeminiKeyCount(keyIndex) {
  keyManager.incrementCount(keyIndex);
}

async function parsePdfBuffer(buf) {
  try {
    const mod = await import('pdf-parse');
    const pdfParse = mod?.default || mod;
    const result = await pdfParse(buf);
    return result?.text || '';
  } catch (e) {
    console.warn('pdf-parse not available or failed to parse PDF:', e?.message || e);
    return '';
  }
}

async function parseDocxBuffer(buf) {
  try {
    const mod = await import('mammoth');
    const mammoth = mod?.default || mod;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
    return result?.value || '';
  } catch (e) {
    console.warn('mammoth not available or failed to parse DOCX:', e?.message || e);
    return '';
  }
}

async function parseSpreadsheetBuffer(buf) {
  try {
    const mod = await import('xlsx');
    const XLSX = mod?.default || mod;
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetNames = wb.SheetNames || [];
    let out = '';
    for (const name of sheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const csv = XLSX.utils.sheet_to_csv(ws);
      if (csv && csv.trim()) {
        out += `--- Sheet: ${name} ---\n${csv}\n`;
      }
    }
    return out.trim();
  } catch (e) {
    console.warn('xlsx not available or failed to parse spreadsheet:', e?.message || e);
    return '';
  }
}

// MIME types that can be read as plain UTF-8 text
const PLAINTEXT_MIMES = new Set([
  'application/json',
  'application/rtf',
]);

/**
 * Resolve a parser for the given MIME type / filename.
 * Returns one of: 'pdf', 'docx', 'spreadsheet', 'text', or null.
 */
function resolveFileParser(mime, filename) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text'; // covers text/plain, text/csv, text/html, text/markdown
  if (PLAINTEXT_MIMES.has(mime)) return 'text';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mime === 'application/vnd.ms-excel' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'spreadsheet';

  // Fallback: try to infer from extension
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'spreadsheet';

  return null;
}

export async function extractTextFromUploads(files = []) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const parts = [];
  const MAX_TOTAL_CHARS = 50000;
  let total = 0;
  for (const f of files) {
    try {
      const name = f.originalname || 'file';
      const mime = f.mimetype || '';
      const buf = f.buffer;
      if (!buf || !Buffer.isBuffer(buf)) continue;

      const parser = resolveFileParser(mime, name);
      let text = '';
      switch (parser) {
        case 'pdf': text = await parsePdfBuffer(buf); break;
        case 'docx': text = await parseDocxBuffer(buf); break;
        case 'spreadsheet': text = await parseSpreadsheetBuffer(buf); break;
        case 'text': text = buf.toString('utf8'); break;
        default: text = ''; break;
      }

      if (text) {
        const remaining = Math.max(0, MAX_TOTAL_CHARS - total);
        const snippet = text.length > remaining ? text.slice(0, remaining) : text;
        if (snippet.length > 0) {
          parts.push(`--- Uploaded: ${name} ---\n\n${snippet}\n\n`);
          total += snippet.length;
        }
        if (total >= MAX_TOTAL_CHARS) {
          console.warn('Total extracted text truncated to MAX_TOTAL_CHARS');
          break;
        }
      }
    } catch (e) {
    }
  }
  return parts.join('');
}

export async function extractImagesFromUploads(files = []) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const images = [];
  for (const f of files) {
    try {
      const mime = f?.mimetype || '';
      if (!mime.startsWith('image/')) continue;
      const name = f.originalname || 'image';
      const buf = f.buffer;
      if (!buf || !Buffer.isBuffer(buf)) continue;
      const data = buf.toString('base64');
      images.push({ name, mimeType: mime, data });
    } catch (_) {
      /* ignore single file errors */
    }
  }
  return images;
}

/**
 * Generate content using Gemini API
 * @param {string} prompt - The user's input prompt
 * @param {string} [userId='default'] - Unique identifier for the user's chat session
 * @param {Object} [options={}] - Additional options
 * @param {string} [options.expert='research'] - The expert type to use
 * @param {string} [options.systemPrompt] - Custom system prompt (overrides expert prompt)
 * @param {boolean} [options.includeSearch=true] - Whether to include web search
 * @param {Array} [options.uploads] - Array of uploaded files
 * @returns {Promise<Object>} The generated content response
 */
export async function generateContent(
  prompt,
  userId = 'default',
  options = {}
) {

  const startTime = Date.now();

  try {
    // Select the appropriate system prompt based on expert type
    const expertType = (options.expert || 'research').toLowerCase();
    const customSystemPrompt = options.systemPrompt;
    let selectedSystemPrompt = customSystemPrompt;

    if (!selectedSystemPrompt) {
      const promptEntry = EXPERT_PROMPTS[expertType] || EXPERT_PROMPTS.default;
      if (typeof promptEntry === 'function') {
        try {
          selectedSystemPrompt = promptEntry({ username: options.username || 'User' });
        } catch (_) {
          selectedSystemPrompt = '';
        }
      } else {
        selectedSystemPrompt = promptEntry;
      }
    }

    // System prompt is used as-is without Mermaid rules
    // Flowcharts are now generated via function calling

    // Get user history and prepare messages
    const userHistory = chatHistory.get(userId);

    // Incorporate uploaded text and images if provided
    // Extract text and images concurrently
    const [uploadedText, uploadedImages] = await Promise.all([
      extractTextFromUploads(options.uploads),
      extractImagesFromUploads(options.uploads),
    ]);

    let composedPrompt = prompt || '';
    if (uploadedText) {
      composedPrompt += `\n\n--- Uploaded Files Text ---\n${uploadedText}`;
    }

    const parts = [{ text: composedPrompt }];
    // Each uploaded image should be an object: { name?, mimeType, data(base64) }
    for (const img of uploadedImages) {
      if (img && img.data && img.mimeType) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
    }


    const userMessage = {
      role: 'user',
      parts
    };

    let messages = [...userHistory, userMessage];

    // Ensure we don't exceed max history length and only include valid roles
    const validMessages = messages.filter(m => m.role === 'user' || m.role === 'model');
    messages = validMessages.slice(-(CONFIG.MAX_HISTORY_LENGTH * 2));

    const requestBody = buildRequestBody(messages, selectedSystemPrompt, options.includeSearch !== false);
    let lastError = null;
    let attemptsCount = 0;
    const maxAttempts = getGeminiMaxAttempts();

    // Retry logic with exponential backoff
    while (attemptsCount < maxAttempts) {
      const keyInfo = keyManager.getNextAvailableKey();

      if (!keyInfo) {
        lastError = new Error('All API keys are currently unavailable');
        break;
      }

      attemptsCount++;
      console.log(`Attempt ${attemptsCount}/${maxAttempts} using key #${keyInfo.index}`);

      try {
        const selectedModel = options.model || MODEL_ID;
        const url = `${BASE_URL}/${selectedModel}:${GENERATE_CONTENT_API}?key=${keyInfo.key}`;

        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Research-Assistant/1.0'
          },
          body: JSON.stringify(requestBody)
        });

        const data = await response.json().catch(err => {
          console.error('Failed to parse response as JSON:', err.message);
          return { error: { message: 'Invalid JSON response' } };
        });

        if (!response.ok) {
          const errorMessage = data?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
          const error = new Error(errorMessage);

          // Handle retryable errors or specific quota/resource exhausted messages
          // Gemini sometimes matches these patterns even if status isn't strictly 429
          const isQuotaError = isRetryableGeminiError(response.status, errorMessage);

          if (isQuotaError || RETRYABLE_STATUS_CODES.has(response.status)) {
            console.warn(`Retryable error (${response.status} - ${errorMessage}), trying next key...`);

            // Mark key as failed for a simpler 1 minute if it's just a flake, or 5 mins if quota
            keyManager.markKeyFailed(keyInfo.index, isQuotaError ? 300000 : 60000);
            keyManager.rotateKey();

            if (attemptsCount < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * attemptsCount));
              continue;
            }
          }

          throw error;
        }

        // Process successful response
        const result = await processGeminiResponse(data);
        keyManager.markKeyHealthy(keyInfo.index);
        keyManager.incrementCount(keyInfo.index);
        keyManager.rotateKey();

        // Check if we got empty content and handle it
        if (!result.content || result.content.trim().length === 0) {
          console.warn('Received empty content from API');

          // If we have attempts left and this might be a temporary issue, retry
          if (attemptsCount < maxAttempts) {
            console.log('Retrying due to empty content...');
            keyManager.rotateKey();
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            continue;
          } else {
            // Last attempt - return with helpful message
            result.content = 'No content generated. This might be due to safety filters or the prompt being too restrictive.';
            result.warning = 'EMPTY_CONTENT';
          }
        }

        // Update chat history only on successful response with content
        if (result.content?.trim()) {
          const updatedHistory = [...userHistory];

          // Add user message
          updatedHistory.push(userMessage);

          // Add assistant response
          updatedHistory.push({
            role: 'model',
            parts: [{ text: result.content }]
          });

          // Maintain history size
          if (updatedHistory.length > CONFIG.MAX_HISTORY_LENGTH * 2) {
            updatedHistory.splice(0, updatedHistory.length - (CONFIG.MAX_HISTORY_LENGTH * 2));
          }

          chatHistory.set(userId, updatedHistory);
        }

        // Add metadata
        result.timestamp = new Date().toISOString();
        result.processingTime = Date.now() - startTime;
        result.attempts = attemptsCount;

        console.log(`Gemini request OK in ${result.processingTime}ms (${attemptsCount} attempt(s))`);
        return result;

      } catch (error) {
        lastError = error;
        console.error(`Attempt ${attemptsCount} failed:`, error.message);

        // For non-retryable errors, break immediately
        if (!error.message.includes('timeout') && !error.message.includes('fetch')) {
          break;
        }

        keyManager.rotateKey();

        if (attemptsCount < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * attemptsCount));
        }
      }
    }

    // All attempts failed
    console.error('All attempts failed:', lastError);
    return {
      content: `Error: ${lastError?.message || 'All API attempts failed'}`,
      sources: [],
      timestamp: new Date().toISOString(),
      processingTime: Date.now() - startTime,
      attempts: attemptsCount,
      error: 'API_FAILURE'
    };

  } catch (error) {
    console.error('Unexpected error in generateContent:', error);
    return {
      content: `Unexpected error: ${error.message}`,
      sources: [],
      timestamp: new Date().toISOString(),
      processingTime: Date.now() - startTime,
      error: 'UNEXPECTED_ERROR'
    };
  }
}

// Utility functions for chat management
export function clearChatHistory(userId) {
  chatHistory.clear(userId);
}

export function getChatHistory(userId) {
  return chatHistory.get(userId);
}

export function getAPIKeyStatus() {
  const now = Date.now()
  let nextRefreshMs = null
  for (const [, retryTime] of keyManager.keyRetryTime.entries()) {
    if (retryTime > now) {
      const diff = retryTime - now
      if (nextRefreshMs === null || diff < nextRefreshMs) nextRefreshMs = diff
    }
  }
  return {
    totalKeys: GEMINI_API_KEYS.length,
    currentKeyIndex: keyManager.currentIndex,
    failedKeys: Array.from(keyManager.failedKeys),
    availableKeys: GEMINI_API_KEYS.length - keyManager.failedKeys.size,
    nextRefreshMs,
    totalRequests: keyManager.getTotalRequests(),
  };
}

// Utility function to clear title cache (useful for testing or memory management)
export function clearTitleCache() {
  titleCache.clear();
}

// Utility function to get cache stats
export function getTitleCacheStats() {
  return {
    size: titleCache.size,
    entries: Array.from(titleCache.entries())
  };
}
