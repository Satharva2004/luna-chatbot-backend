import YouTubeMCP from '../helpers/youtubeSearch.js';

// Initialize YouTube MCP with API key from environment
const youtubeMCP = new YouTubeMCP(process.env.YOUTUBE_API_KEY);

/**
 * List available MCP resources
 * GET /api/mcp/resources
 */
export const listResources = async (req, res) => {
  try {
    const resources = [
      youtubeMCP.getResourceDescriptor()
    ];

    res.json({
      success: true,
      resources
    });
  } catch (error) {
    console.error('Error listing MCP resources:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list resources',
      message: error.message
    });
  }
};

/**
 * Execute MCP resource operation
 * POST /api/mcp/execute
 * Body: { resourceId, operation, params }
 */
export const executeResource = async (req, res) => {
  try {
    const { resourceId, operation, params } = req.body;

    if (!resourceId) {
      return res.status(400).json({
        success: false,
        error: 'resourceId is required'
      });
    }

    // Route to appropriate MCP handler
    switch (resourceId) {
      case 'youtube.search':
        return await handleYouTubeSearch(req, res, operation, params);
      
      default:
        return res.status(404).json({
          success: false,
          error: `Resource '${resourceId}' not found`
        });
    }
  } catch (error) {
    console.error('Error executing MCP resource:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute resource',
      message: error.message
    });
  }
};

/**
 * Handle YouTube search operations
 */
async function handleYouTubeSearch(req, res, operation, params) {
  try {
    // Add user ID for rate limiting (if authenticated)
    const userId = req.user?.id || req.ip;
    
    switch (operation) {
      case 'search':
        const searchResults = await youtubeMCP.search({
          ...params,
          userId
        });
        return res.json(searchResults);
      
      case 'getVideoDetails':
        if (!params.videoId) {
          return res.status(400).json({
            success: false,
            error: 'videoId is required for getVideoDetails operation'
          });
        }
        const videoDetails = await youtubeMCP.getVideoDetails(params.videoId);
        return res.json(videoDetails);
      
      default:
        return res.status(400).json({
          success: false,
          error: `Operation '${operation}' not supported for youtube.search`
        });
    }
  } catch (error) {
    console.error('YouTube MCP error:', error);
    
    // Handle rate limiting errors
    if (error.message.includes('Rate limit exceeded')) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        message: error.message
      });
    }

    // Handle API errors
    if (error.message.includes('YouTube API error')) {
      return res.status(502).json({
        success: false,
        error: 'YouTube API error',
        message: error.message
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
}

/**
 * Health check for MCP services
 * GET /api/mcp/health
 */
export const healthCheck = async (req, res) => {
  try {
    const youtubeHealth = await youtubeMCP.healthCheck();

    res.json({
      success: true,
      services: {
        youtube: youtubeHealth
      }
    });
  } catch (error) {
    console.error('Error checking MCP health:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check health',
      message: error.message
    });
  }
};

/**
 * Quick YouTube search endpoint (convenience wrapper)
 * POST /api/mcp/youtube/search
 */
export const youtubeSearch = async (req, res) => {
  try {
    const userId = req.user?.id || req.ip;
    const params = {
      ...req.body,
      userId
    };

    const results = await youtubeMCP.search(params);
    res.json(results);
  } catch (error) {
    console.error('YouTube search error:', error);
    
    if (error.message.includes('Rate limit exceeded')) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Search failed',
      message: error.message
    });
  }
};
