// controllers/excalidrawController.js
import { generateExcalidrawFlowchart, generateFlowchartDescription } from "../helpers/groq.js";

/**
 * Generate Excalidraw flowchart from text description
 */
export async function handleExcalidrawGenerate(req, res) {
    try {
        console.log('Received Excalidraw generation request:', JSON.stringify(req.body, null, 2));

        const { prompt, options = {} } = req.body;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return res.status(400).json({
                error: "Prompt is required and must be a non-empty string"
            });
        }

        // Validate options if provided
        const validOptions = {};
        if (options.style && typeof options.style === 'string') {
            validOptions.style = options.style;
        }
        if (options.complexity && typeof options.complexity === 'string') {
            validOptions.complexity = options.complexity;
        }

        console.log('Generating Excalidraw flowchart for prompt:', prompt);
        console.log('Options:', validOptions);

        const result = await generateExcalidrawFlowchart(prompt, validOptions);

        console.log('Successfully generated Excalidraw flowchart');
        console.log('Elements count:', result.elements?.length || 0);

        res.json({
            success: true,
            data: result,
            metadata: {
                prompt: prompt,
                options: validOptions,
                elementsCount: result.elements?.length || 0,
                generatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error in handleExcalidrawGenerate:', error);

        // Provide detailed error information
        const errorResponse = {
            success: false,
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? {
                stack: error.stack,
                name: error.name
            } : undefined
        };

        // Determine appropriate status code
        let statusCode = 500;
        if (error.message.includes('API error')) {
            statusCode = 502; // Bad Gateway - upstream API error
        } else if (error.message.includes('Invalid JSON')) {
            statusCode = 500; // Internal Server Error - our processing failed
        }

        res.status(statusCode).json(errorResponse);
    }
}

/**
 * Generate a text description of a flowchart (useful for previewing before generating)
 */
export async function handleFlowchartDescribe(req, res) {
    try {
        const { prompt } = req.body;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return res.status(400).json({
                error: "Prompt is required and must be a non-empty string"
            });
        }

        console.log('Generating flowchart description for:', prompt);

        const description = await generateFlowchartDescription(prompt);

        res.json({
            success: true,
            description: description,
            prompt: prompt,
            generatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error in handleFlowchartDescribe:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}

/**
 * Health check endpoint for Excalidraw/Groq integration
 */
export async function handleExcalidrawHealth(req, res) {
    try {
        const groqKey = process.env.GROQ_KEY;

        res.json({
            success: true,
            status: 'healthy',
            groqConfigured: !!groqKey,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            status: 'unhealthy',
            error: error.message
        });
    }
}
