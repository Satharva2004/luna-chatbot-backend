// src/helpers/charts.js
import fetch from "node-fetch";
import env from "../config/env.js";
import { CHARTS_PROMPT } from "../prompts/charts.js";
import { extractTextFromUploads, extractImagesFromUploads } from "./gemini.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const QUICKCHART_API_URL = "https://quickchart.io/chart/create";
const MAX_HISTORY_MESSAGES = 10;
const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});
const SUPPORTED_CHART_TYPES = new Set([
  "bar",
  "line",
  "pie",
  "doughnut",
  "polararea",
  "radar",
  "scatter",
  "bubble",
  "horizontalbar",
]);
const HUMANIZED_NO_CHART_MESSAGE =
  "I couldn’t find a chart that fits that request. Try rephrasing it with more specific data or a chart type.";
const NO_CHART_FOUND_CODE = "NO_CHART_FOUND";

const datasetSchema = z.object({
  label: z.string().optional(),
  data: z.array(z.number()).nonempty(),
}).passthrough();

const chartConfigSchema = z.object({
  type: z.string(),
  data: z.object({
    labels: z.array(z.string()).optional(),
    datasets: z.array(datasetSchema).nonempty(),
  }),
  options: z.object({
    plugins: z.record(z.any()).optional(),
  }).passthrough().optional(),
}).passthrough();

const chartPayloadSchema = z.object({
  width: z.string(),
  height: z.string(),
  devicePixelRatio: z.number(),
  format: z.enum(["png", "svg", "webp"]).optional(),
  backgroundColor: z.string().optional(),
  version: z.string().optional(),
  key: z.string().optional(),
  chart: chartConfigSchema,
});

// Simpler schema for Gemini's responseJsonSchema to avoid excessive nesting depth
// Still enforces that chart.type exists and chart.data.datasets contains numbers.
const geminiResponseSchema = z.object({
  width: z.string(),
  height: z.string(),
  devicePixelRatio: z.number(),
  format: z.enum(["png", "svg", "webp"]).optional(),
  backgroundColor: z.string().optional(),
  version: z.string().optional(),
  key: z.string().optional(),
  chart: z.object({
    type: z.string(),
    data: z.object({
      labels: z.array(z.string()).optional(),
      datasets: z.array(
        z.object({
          label: z.string().optional(),
          data: z.array(z.number()).nonempty(),
        }).passthrough()
      ).nonempty(),
    }),
  }).passthrough(),
});

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

export async function generateCharts(prompt, userId = 'default', options = {}) {
  const start = Date.now();
  const uploads = Array.isArray(options.uploads) ? options.uploads : [];
  const includeSearch = typeof options.includeSearch === 'boolean' ? options.includeSearch : (uploads.length === 0);
  const history = Array.isArray(options.history) ? options.history : [];

  const buildNoChartFoundResult = ({
    chartConfig = null,
    rawText = null,
    developerMessage = 'Failed to generate chart configuration',
  } = {}) => ({
    ok: false,
    chartConfig,
    chartUrl: null,
    quickChartSuccess: false,
    raw: rawText,
    error: developerMessage,
    userMessage: HUMANIZED_NO_CHART_MESSAGE,
    errorCode: NO_CHART_FOUND_CODE,
    processingTime: Date.now() - start,
  });

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

  const contents = [...trimmedHistory, { role: 'user', parts }];

  const config = {
    systemInstruction: CHARTS_PROMPT,
    responseMimeType: 'application/json',
  };

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents,
      config,
    });
  } catch (error) {
    console.error('Gemini generateContent failed for charts:', error);
    if (error && typeof error.message === 'string') {
      console.error('Gemini error message (charts):', error.message);
      try {
        const parsed = JSON.parse(error.message);
        console.error('Gemini error message parsed JSON (charts):', parsed);
      } catch (_) {
        // message was not JSON, ignore
      }
    }
    return {
      ok: false,
      error: error?.message || 'Failed to generate chart configuration',
      status: null,
      processingTime: Date.now() - start,
    };
  }

  const text = typeof response.text === 'string' ? response.text : String(response.text || '');

  console.log('=== Gemini Raw Response ===');
  console.log(text);
  console.log('==========================');

  let chartPayload;
  let parsed;
  try {
    parsed = JSON.parse(text);

    // Check if the model explicitly decided no chart is needed
    if (parsed && typeof parsed === 'object' && parsed.no_chart_needed === true) {
      console.log('Model decided no chart is needed:', parsed.reason || 'No reason provided');
      return {
        ok: true,
        chartConfig: null,
        chartUrl: null,
        quickChartSuccess: false,
        raw: text,
        error: null,
        userMessage: null,
        errorCode: null,
        processingTime: Date.now() - start,
        noChartNeeded: true,
        reason: parsed.reason || null
      };
    }

    chartPayload = chartPayloadSchema.parse(parsed);
  } catch (error) {
    console.error('Gemini chart payload validation failed:', error);
    return buildNoChartFoundResult({
      rawText: text,
      developerMessage: 'Invalid chart configuration returned by the model',
    });
  }

  const chartType = typeof chartPayload?.chart?.type === 'string'
    ? chartPayload.chart.type.trim().toLowerCase()
    : '';
  if (!SUPPORTED_CHART_TYPES.has(chartType)) {
    console.warn('Unsupported or missing chart type for payload:', chartPayload?.chart?.type);
    return buildNoChartFoundResult({
      chartConfig: chartPayload.chart || null,
      rawText: text,
      developerMessage: chartType
        ? `Unsupported chart type "${chartPayload.chart.type}"`
        : 'Missing chart type in payload',
    });
  }

  const quickChartResult = await callQuickChartAPI(chartPayload);

  if (!quickChartResult.success || !quickChartResult.url) {
    return buildNoChartFoundResult({
      chartConfig: chartPayload.chart || null,
      rawText: text,
      developerMessage: quickChartResult.error || 'Failed to generate chart image',
    });
  }

  return {
    ok: true,
    chartConfig: chartPayload.chart,
    chartUrl: quickChartResult.url,
    quickChartSuccess: true,
    raw: text,
    error: null,
    userMessage: null,
    errorCode: null,
    processingTime: Date.now() - start,
  };
}
