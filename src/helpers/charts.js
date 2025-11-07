// src/helpers/charts.js
import fetch from "node-fetch";
import env from "../config/env.js";
import { CHARTS_PROMPT } from "../prompts/charts.js";
import { buildRequestBody, BASE_URL, MODEL_ID, extractTextFromUploads, extractImagesFromUploads } from "./gemini.js";

const GENERATE_CONTENT_API = "generateContent";
const QUICKCHART_API_URL = "https://quickchart.io/chart/create";
const MAX_HISTORY_MESSAGES = 10;

async function callQuickChartAPI(chartConfig) {
  try {
    const response = await fetch(QUICKCHART_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chartConfig),
    });

    const data = await response.json();

    if (response.ok && data.success && data.url) {
      return {
        success: true,
        url: data.url,
        error: null,
      };
    }

    return {
      success: false,
      url: null,
      error: data.error || 'QuickChart API request failed',
    };
  } catch (error) {
    return {
      success: false,
      url: null,
      error: `QuickChart API error: ${error.message}`,
    };
  }
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: "Empty response from model" };
  }

  let t = text.trim();

  // 1) Strip Markdown fences ```json ... ``` or ``` ... ```
  const fenceRe = /```(?:json|javascript)?\s*([\s\S]*?)```/i;
  const fenced = t.match(fenceRe);
  if (fenced && fenced[1]) {
    t = fenced[1].trim();
  }

  // 2) Quick parse attempt
  try {
    const parsed = JSON.parse(t);
    if (validateChartConfig(parsed)) {
      return { ok: true, value: parsed };
    }
  } catch (_) {}

  // 3) Extract first JSON object from text using first '{' and last '}'
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = t.slice(first, last + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (validateChartConfig(parsed)) {
        return { ok: true, value: parsed };
      }
    } catch (_) {}
  }

  // 4) Fix common JSON issues
  let fixed = t
    .replace(/,\s*([}\]])/g, '$1')  // Remove trailing commas
    .replace(/"data":\s*,/g, '"data": []')  // Fix empty data arrays
    .replace(/:\s*,/g, ': null,')  // Fix missing values
    .replace(/,\s*}/g, '}')  // Remove trailing commas before }
    .replace(/,\s*]/g, ']');  // Remove trailing commas before ]

  try {
    const parsed = JSON.parse(fixed);
    if (validateChartConfig(parsed)) {
      return { ok: true, value: parsed };
    }
  } catch (_) {}

  return { ok: false, error: "Invalid JSON from model" };
}

function extractChartConfig(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  if (config.chart && typeof config.chart === 'object') {
    return config.chart;
  }

  return config;
}

function validateChartConfig(config) {
  const chart = extractChartConfig(config);
  if (!chart || typeof chart !== 'object') {
    return false;
  }

  if (!chart.type || typeof chart.type !== 'string') {
    return false;
  }

  if (!chart.data || typeof chart.data !== 'object') {
    return false;
  }

  const { labels, datasets } = chart.data;

  if (!Array.isArray(datasets) || datasets.length === 0) {
    return false;
  }

  if (labels && !Array.isArray(labels)) {
    return false;
  }

  for (const dataset of datasets) {
    if (!Array.isArray(dataset.data) || dataset.data.length === 0) {
      return false;
    }
    for (const val of dataset.data) {
      if (typeof val !== 'number' || Number.isNaN(val)) {
        return false;
      }
    }
    if (labels && dataset.data.length !== labels.length) {
      return false;
    }
  }

  return true;
}

function normalizeChartPayload(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  if (config.chart && typeof config.chart === 'object') {
    return config;
  }

  const {
    width,
    height,
    backgroundColor,
    devicePixelRatio,
    format,
    version,
    ...chartConfig
  } = config;

  const payload = { chart: chartConfig };

  if (typeof version !== 'undefined') payload.version = version;
  if (typeof width !== 'undefined') payload.width = width;
  if (typeof height !== 'undefined') payload.height = height;
  if (typeof backgroundColor !== 'undefined') payload.backgroundColor = backgroundColor;
  if (typeof devicePixelRatio !== 'undefined') payload.devicePixelRatio = devicePixelRatio;
  if (typeof format !== 'undefined') payload.format = format;

  return payload;
}

export async function generateCharts(prompt, userId = 'default', options = {}) {
  const start = Date.now();
  const uploads = Array.isArray(options.uploads) ? options.uploads : [];
  const includeSearch = typeof options.includeSearch === 'boolean' ? options.includeSearch : (uploads.length === 0);
  const history = Array.isArray(options.history) ? options.history : [];

  // Compose user message with uploads (same behavior as chat helper)
  let composedText = String(prompt || '');
  const uploadedText = await extractTextFromUploads(uploads);
  const uploadedImages = await extractImagesFromUploads(uploads);
  if (uploadedText) composedText += `\n\n--- Uploaded Files Text ---\n${uploadedText}`;

  const parts = [{ text: composedText }];
  for (const img of uploadedImages) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }

  const trimmedHistory = history
    .filter((message) => message && typeof message === 'object' && Array.isArray(message.parts))
    .slice(-MAX_HISTORY_MESSAGES);

  const messages = [...trimmedHistory, { role: 'user', parts }];
  const body = buildRequestBody(messages, CHARTS_PROMPT, includeSearch);

  const url = `${BASE_URL}/${MODEL_ID}:${GENERATE_CONTENT_API}?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `${res.status} ${res.statusText}`;
    return {
      ok: false,
      error: message,
      status: res.status,
      processingTime: Date.now() - start
    };
  }

  // Collect all text parts from the first candidate
  const cand = data?.candidates?.[0];
  const text = Array.isArray(cand?.content?.parts)
    ? cand.content.parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('')
    : '';

  // Log the raw response from Gemini for debugging
  console.log('=== Gemini Raw Response ===');
  console.log(text);
  console.log('==========================');

  const parsed = tryParseJson(text.trim());

  if (parsed.ok) {
    const quickChartPayload = normalizeChartPayload(parsed.value);

    if (!quickChartPayload) {
      return {
        ok: false,
        chartConfig: null,
        chartUrl: null,
        quickChartSuccess: false,
        raw: text,
        error: 'Model returned an invalid chart configuration',
        processingTime: Date.now() - start
      };
    }

    // Call QuickChart API with the generated JSON
    const quickChartResult = await callQuickChartAPI(quickChartPayload);
    
    if (!quickChartResult.success || !quickChartResult.url) {
      return {
        ok: false,
        chartConfig: quickChartPayload.chart,
        chartUrl: null,
        quickChartSuccess: false,
        raw: text,
        error: quickChartResult.error || 'Failed to generate chart image',
        processingTime: Date.now() - start
      };
    }

    return {
      ok: true,
      chartConfig: quickChartPayload.chart,
      chartUrl: quickChartResult.url,
      quickChartSuccess: true,
      raw: text,
      error: null,
      processingTime: Date.now() - start
    };
  }

  return {
    ok: false,
    chartConfig: null,
    chartUrl: null,
    quickChartSuccess: false,
    raw: text,
    error: parsed.error || 'Invalid chart configuration returned by the model',
    processingTime: Date.now() - start
  };
}
