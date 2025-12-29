// helpers/groq.js
import fetch from "node-fetch";
import env from "../config/env.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

// Constants for layout and styling
const LAYOUT = {
    START_X: 400,
    START_Y: 100,
    NODE_WIDTH: 200,
    NODE_HEIGHT: 90,
    VERTICAL_SPACING: 150,
    HORIZONTAL_SPACING: 250,
};

const COLORS = {
    START_END: "#dbeafe", // blue-100
    PROCESS: "#f3f4f6",   // gray-100
    DECISION: "#fef3c7",  // amber-100
    STROKE: "#1e1e1e",
};

/**
 * Deterministic Layout Algorithm
 * Assigns x,y coordinates to nodes based on their connectivity (BFS layers)
 */
function calculateLayout(nodes) {
    if (!nodes || nodes.length === 0) return [];

    // 1. Build Adjacency Map & Find Roots
    const adj = new Map();
    const reverseAdj = new Map();
    const nodeMap = new Map();

    nodes.forEach(node => {
        nodeMap.set(node.id, node);
        adj.set(node.id, node.next || []);
        if (!reverseAdj.has(node.id)) reverseAdj.set(node.id, []);

        (node.next || []).forEach(targetId => {
            if (!reverseAdj.has(targetId)) reverseAdj.set(targetId, []);
            reverseAdj.get(targetId).push(node.id);
        });
    });

    // 2. Identify Levels (BFS)
    // Find nodes with no incoming edges (roots) or default to first
    let roots = nodes.filter(n => (reverseAdj.get(n.id) || []).length === 0);
    if (roots.length === 0) roots = [nodes[0]];

    const levels = [];
    const visited = new Set();
    let queue = roots.map(n => ({ id: n.id, level: 0 }));

    while (queue.length > 0) {
        const { id, level } = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);

        if (!levels[level]) levels[level] = [];
        levels[level].push(id);

        const neighbors = adj.get(id) || [];
        neighbors.forEach(nid => {
            queue.push({ id: nid, level: level + 1 });
        });
    }

    // 3. Assign Coordinates
    // Center alignment strategy
    const layoutNodes = [];

    levels.forEach((levelNodes, levelIndex) => {
        const levelWidth = levelNodes.length * LAYOUT.HORIZONTAL_SPACING;
        const startX = LAYOUT.START_X - (levelWidth / 2) + (LAYOUT.HORIZONTAL_SPACING / 2);

        levelNodes.forEach((nodeId, idx) => {
            const node = nodeMap.get(nodeId);
            layoutNodes.push({
                ...node,
                x: startX + (idx * LAYOUT.HORIZONTAL_SPACING),
                y: LAYOUT.START_Y + (levelIndex * LAYOUT.VERTICAL_SPACING),
            });
        });
    });

    // Add any disconnected nodes at the bottom
    const placedIds = new Set(layoutNodes.map(n => n.id));
    let extraCount = 0;
    nodes.forEach(node => {
        if (!placedIds.has(node.id)) {
            layoutNodes.push({
                ...node,
                x: LAYOUT.START_X,
                y: LAYOUT.START_Y + (levels.length * LAYOUT.VERTICAL_SPACING) + (extraCount * LAYOUT.VERTICAL_SPACING)
            });
            extraCount++;
        }
    });

    return layoutNodes;
}

/**
 * Generates an Excalidraw flowchart using logical structure extraction + deterministic layout
 */
export async function generateExcalidrawFlowchart(prompt, options = {}) {
    if (!prompt) throw new Error("Prompt is required");

    const systemPrompt = `
    You are a technical diagram architect.
    Task: Extract the LOGICAL structure of a flowchart from the user's description.
    Output: A clean JSON object containing a list of nodes and their connections.

    RULES:
    1. 'id': clear, unique string (e.g., "start", "verify_email").
    2. 'type': MUST be one of ["start", "process", "decision", "end"].
         - "start"/"end": Use for entry/exit points (Oval shape).
         - "decision": Use for branching logic (Diamond shape).
         - "process": Use for actions/steps (Rectangle shape).
    3. 'label': Short text to display in the box.
    4. 'next': Array of IDs that this node connects TO.
    
    EXAMPLE OUTPUT:
    {
      "nodes": [
        { "id": "start", "type": "start", "label": "Start", "next": ["login"] },
        { "id": "login", "type": "process", "label": "User Login", "next": ["check"] },
        { "id": "check", "type": "decision", "label": "Valid?", "next": ["home", "error"] },
        { "id": "home", "type": "process", "label": "Dashboard", "next": ["end"] },
        { "id": "error", "type": "process", "label": "Show Error", "next": ["login"] },
        { "id": "end", "type": "end", "label": "End", "next": [] }
      ]
    }
    
    Return ONLY JSON.
    `;

    try {
        const response = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.GROQ_KEY}`,
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Flowchart for: ${prompt} \nComplexity: ${options.complexity || 'standard'}` },
                ],
                temperature: 0.1,
                max_tokens: 4000,
                response_format: { type: "json_object" },
            }),
        });

        if (!response.ok) throw new Error(`Groq API Error: ${response.status}`);

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("No content received");

        const parsed = JSON.parse(content);
        if (!parsed.nodes || !Array.isArray(parsed.nodes)) throw new Error("Invalid nodes array");

        // 1. Calculate Positions
        const layoutNodes = calculateLayout(parsed.nodes);

        // 2. Convert to Excalidraw Elements
        const elements = [];

        layoutNodes.forEach(node => {
            // -- SHAPE --
            const shapeId = node.id;
            const textId = `${node.id}-text`;

            let excalidrawType = "rectangle";
            let bgColor = COLORS.PROCESS;
            let roundness = { type: 3 };

            if (node.type === "decision") {
                excalidrawType = "diamond";
                bgColor = COLORS.DECISION;
            } else if (node.type === "start" || node.type === "end") {
                excalidrawType = "ellipse";
                bgColor = COLORS.START_END;
            }

            // Push Shape
            elements.push({
                id: shapeId,
                type: excalidrawType,
                x: node.x,
                y: node.y,
                width: LAYOUT.NODE_WIDTH,
                height: LAYOUT.NODE_HEIGHT,
                strokeColor: COLORS.STROKE,
                backgroundColor: bgColor,
                fillStyle: "solid",
                strokeWidth: 2,
                strokeStyle: "solid",
                roughness: 1,
                opacity: 100,
                groupIds: [],
                roundness: roundness,
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 0,
                isDeleted: false,
                boundElements: [{ id: textId, type: "text" }],
                updated: Date.now(),
                link: null,
                locked: false,
            });

            // Push Text
            elements.push({
                id: textId,
                type: "text",
                x: node.x + 10,
                y: node.y + 35, // rough vertical center
                width: LAYOUT.NODE_WIDTH - 20,
                height: 25,
                text: node.label || "",
                fontSize: 16,
                fontFamily: 1,
                textAlign: "center",
                verticalAlign: "middle",
                containerId: shapeId, // CRITICAL: This auto-centers the text in Excalidraw
                originalText: node.label || "",
                strokeColor: COLORS.STROKE,
                backgroundColor: "transparent",
                fillStyle: "solid",
                strokeWidth: 1,
                strokeStyle: "solid",
                roughness: 0,
                opacity: 100,
                groupIds: [],
                seed: Math.floor(Math.random() * 100000),
                version: 1,
                versionNonce: 0,
                isDeleted: false,
                updated: Date.now(),
                link: null,
                locked: false,
            });

            // Push Arrows (Edges)
            if (node.next && Array.isArray(node.next)) {
                node.next.forEach((targetId, i) => {
                    // Find target coordinates
                    const targetNode = layoutNodes.find(n => n.id === targetId);
                    if (targetNode) {
                        elements.push({
                            id: `${node.id}-to-${targetId}`,
                            type: "arrow",
                            x: node.x + (LAYOUT.NODE_WIDTH / 2),
                            y: node.y + LAYOUT.NODE_HEIGHT,
                            width: 0, // dynamic
                            height: 0, // dynamic
                            strokeColor: COLORS.STROKE,
                            backgroundColor: "transparent",
                            fillStyle: "solid",
                            strokeWidth: 2,
                            strokeStyle: "solid",
                            roughness: 1,
                            opacity: 100,
                            groupIds: [],
                            roundness: { type: 2 },
                            seed: Math.floor(Math.random() * 100000),
                            version: 1,
                            versionNonce: 0,
                            isDeleted: false,
                            boundElements: null,
                            updated: Date.now(),
                            link: null,
                            locked: false,
                            points: [[0, 0], [targetNode.x - node.x, targetNode.y - node.y - LAYOUT.NODE_HEIGHT]],
                            startBinding: { elementId: shapeId, focus: 0.5, gap: 4 },
                            endBinding: { elementId: targetId, focus: 0.5, gap: 4 },
                            endArrowhead: "arrow"
                        });
                    }
                });
            }
        });

        return {
            type: "excalidraw",
            version: 2,
            source: "https://excalidraw.com",
            elements: elements,
            appState: { viewBackgroundColor: "#ffffff", gridSize: null },
            files: {}
        };

    } catch (error) {
        console.error("Layout generation failed:", error);
        throw error;
    }
}

/**
 * Generates a textual flowchart description using Groq
 * @param {string} prompt - Process or system to describe
 * @returns {Promise<string>} - Flowchart description
 */
export async function generateFlowchartDescription(prompt) {
    if (!prompt || typeof prompt !== "string") {
        throw new Error("Prompt must be a non-empty string");
    }

    if (!env.GROQ_KEY) {
        throw new Error("GROQ_KEY environment variable is not set");
    }

    let response;
    try {
        response = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.GROQ_KEY}`,
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [
                    {
                        role: "system",
                        content: `You are an expert at breaking down complex processes into clear, logical flowcharts.

Analyze the process and provide:
1. Key decision points
2. Sequential steps
3. Alternative paths
4. Start and end conditions
5. Error handling flows

Format your response in a structured way suitable for flowchart visualization.`,
                    },
                    { role: "user", content: prompt },
                ],
                temperature: 0.6,
                max_tokens: 3000,
            }),
        });
    } catch (error) {
        throw new Error(`Network error calling Groq API: ${error.message}`);
    }

    if (!response.ok) {
        const status = response.status;
        let errorText = "";
        try {
            errorText = await response.text();
        } catch {
            // Ignore
        }
        throw new Error(`Groq API error ${status}${errorText ? `: ${errorText}` : ""}`);
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new Error(`Failed to parse Groq API response: ${error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("Empty response from Groq API");
    }

    return content.trim();
}

/**
 * Health check for Groq API
 * @returns {Promise<boolean>} - True if API is accessible
 */
export async function checkGroqHealth() {
    try {
        const response = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.GROQ_KEY}`,
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: "user", content: "test" }],
                max_tokens: 4096,
            }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export default {
    generateExcalidrawFlowchart,
    generateFlowchartDescription,
    checkGroqHealth,
    LAYOUT,
    COLORS,
};