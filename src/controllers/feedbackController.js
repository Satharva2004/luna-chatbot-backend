import { createFeedbackEntry, listFeedbackEntries } from "../helpers/feedback.js";

export async function createFeedback(req, res) {
    try {
        const data = await createFeedbackEntry(req.body);
        res.status(201).json({ success: true, data });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
}

export async function getFeedback(req, res) {
    try {
        const filters = {
            userId: req.query.userId,
            sessionId: req.query.sessionId,
            conversationId: req.query.conversationId,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined
        };

        const data = await listFeedbackEntries(filters);
        res.json({ success: true, data });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
}
