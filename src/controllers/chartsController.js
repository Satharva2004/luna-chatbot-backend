// src/controllers/chartsController.js
import { createClient } from "@supabase/supabase-js";
import { generateCharts } from "../helpers/charts.js";
import { generateContent } from "../helpers/gemini.js";
import env from "../config/env.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

function normalizeConversationId(rawId) {
  if (!rawId) return null;
  const value = typeof rawId === "string" ? rawId.trim() : rawId;
  if (!value || value === "null" || value === "undefined") {
    return null;
  }
  return value;
}

async function verifyConversationOwnership(conversationId, userId) {
  if (!conversationId) {
    return { conversationId: null };
  }

  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .single();

    if (error || !conversation) {
      return { error: "Conversation not found", status: 404 };
    }

    if (conversation.user_id && conversation.user_id !== userId) {
      return { error: "Access denied", status: 403 };
    }

    return { conversationId: conversation.id };
  } catch (err) {
    console.error("Failed to verify conversation ownership:", err);
    return { error: "Failed to verify conversation", status: 500 };
  }
}

async function fetchConversationHistory(conversationId) {
  if (!conversationId) {
    return [];
  }

  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    throw error;
  }

  return (data || [])
    .reverse()
    .filter((message) => typeof message?.content === "string" && message.content.trim().length > 0)
    .map((message) => {
      const normalizedRole = message.role === "assistant" ? "model" : message.role;
      const role = normalizedRole === "model" ? "model" : "user";
      return {
        role,
        parts: [{ text: message.content }],
      };
    });
}

async function saveChartMessage({ conversationId, chartUrl, prompt }) {
  if (!conversationId || !chartUrl) {
    return;
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.warn("Supabase credentials are missing; skipping chart persistence.");
    return;
  }

  try {
    const { data: existingMessages, error: fetchError } = await supabase
      .from("messages")
      .select("id, charts")
      .eq("conversation_id", conversationId)
      .eq("role", "model")
      .order("created_at", { ascending: false })
      .limit(1);

    if (fetchError) {
      console.error("Failed to fetch latest assistant message for chart attachment:", fetchError);
      return;
    }

    const latestMessage = existingMessages?.[0];

    if (!latestMessage) {
      console.warn(
        "No assistant message found to attach chart; skipping persistence for conversation",
        conversationId
      );
      return;
    }

    const shouldSkipUpdate = latestMessage.charts && latestMessage.charts === chartUrl;
    if (shouldSkipUpdate) {
      return;
    }

    const { error: updateMessageError } = await supabase
      .from("messages")
      .update({ charts: chartUrl })
      .eq("id", latestMessage.id);

    if (updateMessageError) {
      console.error("Failed to update existing message with chart:", updateMessageError);
      return;
    }

    const { error: updateError } = await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    if (updateError) {
      console.error("Failed to update conversation timestamp:", updateError);
    }
  } catch (error) {
    console.error("Failed to save chart message:", error);
  }
}

// Return only the charts JSON (non-stream)
export async function handleChartsGenerate(req, res) {
  try {
    const { prompt, conversationId: rawConversationId } = req.body || {};
    let { options } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    if (options && typeof options === 'string') {
      try { options = JSON.parse(options); } catch { options = {}; }
    }
    options = options || {};

    const uploads = Array.isArray(req.files) ? req.files : [];
    const includeSearch = typeof options.includeSearch === 'boolean' ? options.includeSearch : (uploads.length === 0);
    const userId = req.userId;
    const conversationId = normalizeConversationId(rawConversationId);

    const {
      conversationId: validatedConversationId,
      error: conversationError,
      status: conversationStatus
    } = await verifyConversationOwnership(conversationId, userId);

    if (conversationError) {
      return res.status(conversationStatus || 400).json({ error: conversationError });
    }

    const shouldResetHistory = uploads.length > 0 && options.keepHistoryWithFiles !== true;

    let chartHistory = [];
    if (validatedConversationId && !shouldResetHistory) {
      try {
        chartHistory = await fetchConversationHistory(validatedConversationId);
      } catch (historyError) {
        console.error('Failed to fetch chart conversation history:', historyError);
        return res.status(500).json({ error: 'Failed to fetch conversation history' });
      }
    }

    const result = await generateCharts(prompt, req.userId, { uploads, includeSearch, history: chartHistory });

    if (result.ok && validatedConversationId) {
      await saveChartMessage({
        conversationId: validatedConversationId,
        chartUrl: result.chartUrl,
        prompt,
      });
    }

    if (!result.ok) {
      console.error('Charts generation failed:', {
        error: result.error,
        raw: result.raw,
        processingTime: result.processingTime,
      });
      const status = result.errorCode === 'NO_CHART_FOUND' ? 422 : 500;
      return res.status(status).json({
        ok: false,
        error: result.error || 'Failed to generate chart',
        userMessage: result.userMessage || null,
        errorCode: result.errorCode || null,
        processingTime: result.processingTime || null,
      });
    }

    return res.json({
      chartUrl: result.chartUrl,
      quickChartSuccess: result.quickChartSuccess,
      conversationId: validatedConversationId,
    });
  } catch (error) {
    console.error('Error in handleChartsGenerate:', error);
    res.status(500).json({ error: error.message });
  }
}

export async function handleChatWithChartsParallel(req, res) {
  try {
    const { prompt, conversationId: rawConversationId } = req.body || {};
    let { options } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    if (options && typeof options === 'string') {
      try { options = JSON.parse(options); } catch { options = {}; }
    }
    options = options || {};

    const uploads = Array.isArray(req.files) ? req.files : [];
    const includeSearch = typeof options.includeSearch === 'boolean' ? options.includeSearch : (uploads.length === 0);
    const userId = req.userId;
    const conversationId = normalizeConversationId(rawConversationId);

    const {
      conversationId: validatedConversationId,
      error: conversationError,
      status: conversationStatus
    } = await verifyConversationOwnership(conversationId, userId);

    if (conversationError) {
      return res.status(conversationStatus || 400).json({ error: conversationError });
    }

    const shouldResetHistory = uploads.length > 0 && options.keepHistoryWithFiles !== true;

    let chartHistory = [];
    if (validatedConversationId && !shouldResetHistory) {
      try {
        chartHistory = await fetchConversationHistory(validatedConversationId);
      } catch (historyError) {
        console.error('Failed to fetch chart conversation history:', historyError);
        return res.status(500).json({ error: 'Failed to fetch conversation history' });
      }
    }

    const [chatRes, chartsRes] = await Promise.allSettled([
      generateContent(prompt, userId, {
        includeSearch,
        uploads,
        resetHistory: shouldResetHistory,
        expert: options.expert,
        systemPrompt: options.systemPrompt
      }),
      generateCharts(prompt, userId, { includeSearch, uploads, history: chartHistory })
    ]);

    const chat = chatRes.status === 'fulfilled'
      ? {
          content: chatRes.value?.content || null,
          sources: Array.isArray(chatRes.value?.sources) ? chatRes.value.sources : [],
          error: null,
          metadata: {
            attempts: chatRes.value?.attempts || null,
            processingTime: chatRes.value?.processingTime || null,
            timestamp: chatRes.value?.timestamp || null,
          }
        }
      : {
          content: null,
          sources: [],
          error: chatRes.reason?.message || 'Failed to generate chat',
          metadata: null,
        };

    const charts = chartsRes.status === 'fulfilled'
      ? chartsRes.value
      : { ok: false, error: chartsRes.reason?.message || 'Charts generation failed' };

    if (charts?.ok === true && validatedConversationId) {
      await saveChartMessage({
        conversationId: validatedConversationId,
        chartUrl: charts.chartUrl,
        prompt,
      });
    }

    return res.json({
      conversationId: validatedConversationId,
      chat,
      charts: {
        chartUrl: charts?.chartUrl || null,
        chartConfig: charts?.chartConfig || null,
        quickChartSuccess: charts?.quickChartSuccess === true,
        error: charts?.ok === true ? null : (charts?.error || 'Failed to generate charts'),
        userMessage: charts?.ok === true ? null : (charts?.userMessage || null),
        errorCode: charts?.ok === true ? null : (charts?.errorCode || null),
      }
    });
  } catch (error) {
    console.error('Error in handleChatWithChartsParallel:', error);
    res.status(500).json({ error: error.message });
  }
}