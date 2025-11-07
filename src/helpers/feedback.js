import { createClient } from "@supabase/supabase-js";
import env from "../config/env.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

const allowedStatuses = new Set(["new", "in_progress", "resolved", "dismissed"]);

function toArrayOfStrings(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0) || null;
}

function ensureObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}

function validationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

export async function createFeedbackEntry(input) {
    const {
        title,
        message,
        category = "general",
        url,
        userId,
        conversationId,
        email,
        image
    } = input ?? {};

    if (!title?.trim() || !message?.trim()) {
        throw validationError("Title and message are required");
    }

    const payload = {
        title: title.trim(),
        message: message.trim(),
        category,
        source_url: url ?? null,
        user_id: userId ?? null,
        conversation_id: conversationId ?? null,
        email: email ?? null,
        image_url: image ?? null
    };

    const { data, error } = await supabase.from("feedback").insert(payload).select().single();
    if (error) {
        const dbError = new Error(error.message);
        dbError.statusCode = 500;
        throw dbError;
    }

    return data;
}

export async function listFeedbackEntries(filters = {}) {
    const {
        category,
        userId,
        sessionId,
        conversationId,
        limit
    } = filters ?? {};

   

    let query = supabase.from("feedback").select("*").order("created_at", { ascending: false });

    if (category) {
        query = query.eq("category", category);
    }
    if (userId) {
        query = query.eq("user_id", userId);
    }
    if (sessionId) {
        query = query.eq("session_id", sessionId);
    }
    if (conversationId) {
        query = query.eq("conversation_id", conversationId);
    }
    if (Number.isInteger(limit) && limit > 0) {
        query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) {
        const dbError = new Error(error.message);
        dbError.statusCode = 500;
        throw dbError;
    }

    return data ?? [];
}

export { allowedStatuses };