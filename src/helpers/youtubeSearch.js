import fetch from 'node-fetch';

/**
 * YouTube MCP (Model Context Protocol) Server
 * Provides YouTube search capabilities for AI agents
 */

class YouTubeMCP {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.googleapis.com/youtube/v3';
    this.rateLimitCache = new Map(); // Simple rate limiting
  }

  /**
   * Get MCP resource descriptor
   * Defines the YouTube search tool for agents
   */
  getResourceDescriptor() {
    return {
      id: 'youtube.search',
      title: 'YouTube Search',
      description: 'Search YouTube for videos. Use when user requests video tutorials, demonstrations, or multimedia content that would be better served by video rather than text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for YouTube videos'
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (1-50)',
            default: 30,
            minimum: 1,
            maximum: 50
          },
          order: {
            type: 'string',
            description: 'Sort order for results',
            enum: ['relevance', 'date', 'rating', 'viewCount', 'title'],
            default: 'relevance'
          },
          videoDuration: {
            type: 'string',
            description: 'Filter by video duration',
            enum: ['any', 'short', 'medium', 'long'],
            default: 'any'
          },
          publishedAfter: {
            type: 'string',
            description: 'RFC 3339 formatted date-time value (e.g., 2024-01-01T00:00:00Z)'
          }
        },
        required: ['query']
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                videoId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                channelTitle: { type: 'string' },
                channelId: { type: 'string' },
                publishedAt: { type: 'string' },
                thumbnails: { type: 'object' },
                url: { type: 'string' }
              }
            }
          },
          nextPageToken: { type: 'string' },
          totalResults: { type: 'number' }
        }
      }
    };
  }

  /**
   * Check rate limiting (simple implementation)
   */
  checkRateLimit(userId = 'default') {
    const now = Date.now();
    const userLimit = this.rateLimitCache.get(userId);
    
    if (userLimit) {
      const timeDiff = now - userLimit.lastRequest;
      if (timeDiff < 1000 && userLimit.count >= 10) {
        throw new Error('Rate limit exceeded. Please wait before making more requests.');
      }
      
      if (timeDiff >= 1000) {
        this.rateLimitCache.set(userId, { lastRequest: now, count: 1 });
      } else {
        userLimit.count++;
        userLimit.lastRequest = now;
      }
    } else {
      this.rateLimitCache.set(userId, { lastRequest: now, count: 1 });
    }
  }

  /**
   * Execute YouTube search
   */
  async search(params) {
    const {
      query,
      maxResults = 30,
      order = 'relevance',
      videoDuration = 'any',
      publishedAfter,
      pageToken,
      userId
    } = params;

    // Validate inputs
    if (!query || typeof query !== 'string') {
      throw new Error('Query parameter is required and must be a string');
    }

    if (maxResults < 1 || maxResults > 50) {
      throw new Error('maxResults must be between 1 and 50');
    }

    // Check rate limiting
    this.checkRateLimit(userId);

    // Build YouTube API URL
    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: query,
      maxResults: maxResults.toString(),
      order,
      type: 'video',
      key: this.apiKey
    });

    if (videoDuration !== 'any') {
      searchParams.append('videoDuration', videoDuration);
    }

    if (publishedAfter) {
      searchParams.append('publishedAfter', publishedAfter);
    }

    if (pageToken) {
      searchParams.append('pageToken', pageToken);
    }

    const url = `${this.baseUrl}/search?${searchParams.toString()}`;

    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `YouTube API error: ${response.status} - ${errorData.error?.message || response.statusText}`
        );
      }

      const data = await response.json();

      // Normalize response to MCP format
      const results = data.items.map(item => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        channelTitle: item.snippet.channelTitle,
        channelId: item.snippet.channelId,
        publishedAt: item.snippet.publishedAt,
        thumbnails: {
          default: item.snippet.thumbnails.default,
          medium: item.snippet.thumbnails.medium,
          high: item.snippet.thumbnails.high
        },
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`
      }));

      return {
        success: true,
        results,
        nextPageToken: data.nextPageToken,
        totalResults: data.pageInfo.totalResults,
        resultsPerPage: data.pageInfo.resultsPerPage
      };
    } catch (error) {
      console.error('YouTube search error:', error);
      throw error;
    }
  }

  /**
   * Get video details by ID
   */
  async getVideoDetails(videoId) {
    if (!videoId) {
      throw new Error('Video ID is required');
    }

    const url = `${this.baseUrl}/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${this.apiKey}`;

    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `YouTube API error: ${response.status} - ${errorData.error?.message || response.statusText}`
        );
      }

      const data = await response.json();

      if (!data.items || data.items.length === 0) {
        throw new Error('Video not found');
      }

      const video = data.items[0];
      return {
        success: true,
        video: {
          videoId: video.id,
          title: video.snippet.title,
          description: video.snippet.description,
          channelTitle: video.snippet.channelTitle,
          channelId: video.snippet.channelId,
          publishedAt: video.snippet.publishedAt,
          thumbnails: video.snippet.thumbnails,
          duration: video.contentDetails.duration,
          viewCount: video.statistics.viewCount,
          likeCount: video.statistics.likeCount,
          commentCount: video.statistics.commentCount,
          url: `https://www.youtube.com/watch?v=${video.id}`
        }
      };
    } catch (error) {
      console.error('YouTube video details error:', error);
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      // Simple search to verify API key works
      const url = `${this.baseUrl}/search?part=snippet&q=test&maxResults=1&type=video&key=${this.apiKey}`;
      const response = await fetch(url);
      
      return {
        status: response.ok ? 'healthy' : 'unhealthy',
        statusCode: response.status
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

export default YouTubeMCP;
