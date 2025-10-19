# YouTube MCP Server Setup & Usage Guide

## Overview
This MCP (Model Context Protocol) server enables AI agents to search YouTube for videos when appropriate. The agent automatically decides when to use YouTube search based on user queries.

## Setup Instructions

### 1. Get YouTube API Key
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable **YouTube Data API v3**
4. Go to **Credentials** → **Create Credentials** → **API Key**
5. Copy the API key

### 2. Configure Environment
Add your YouTube API key to `.env`:
```env
YOUTUBE_API_KEY=your_actual_api_key_here
```

### 3. Start the Server
```bash
npm run dev
# or
npm start
```

## API Endpoints

### 1. List Available Resources
**GET** `/api/mcp/resources`

Returns all available MCP resources (tools) that agents can use.

**Response:**
```json
{
  "success": true,
  "resources": [
    {
      "id": "youtube.search",
      "title": "YouTube Search",
      "description": "Search YouTube for videos...",
      "inputSchema": {...},
      "outputSchema": {...}
    }
  ]
}
```

### 2. Execute Resource Operation
**POST** `/api/mcp/execute`

Execute a specific MCP resource operation.

**Request Body:**
```json
{
  "resourceId": "youtube.search",
  "operation": "search",
  "params": {
    "query": "machine learning tutorial",
    "maxResults": 10,
    "order": "relevance",
    "videoDuration": "medium"
  }
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "videoId": "abc123",
      "title": "Machine Learning Tutorial",
      "description": "Learn ML basics...",
      "channelTitle": "Tech Channel",
      "channelId": "UC123",
      "publishedAt": "2024-01-01T00:00:00Z",
      "thumbnails": {...},
      "url": "https://www.youtube.com/watch?v=abc123"
    }
  ],
  "nextPageToken": "CAUQAA",
  "totalResults": 1000000
}
```

### 3. YouTube Search (Convenience Endpoint)
**POST** `/api/mcp/youtube/search`

Direct YouTube search without MCP wrapper.

**Request Body:**
```json
{
  "query": "react hooks tutorial",
  "maxResults": 5,
  "order": "viewCount",
  "videoDuration": "long"
}
```

### 4. Health Check
**GET** `/api/mcp/health`

Check if MCP services are operational.

**Response:**
```json
{
  "success": true,
  "services": {
    "youtube": {
      "status": "healthy",
      "statusCode": 200
    }
  }
}
```

## Search Parameters

### Required
- **query** (string): Search query for YouTube videos

### Optional
- **maxResults** (number, 1-50): Maximum results to return (default: 10)
- **order** (string): Sort order
  - `relevance` (default)
  - `date`
  - `rating`
  - `viewCount`
  - `title`
- **videoDuration** (string): Filter by duration
  - `any` (default)
  - `short` (< 4 minutes)
  - `medium` (4-20 minutes)
  - `long` (> 20 minutes)
- **publishedAfter** (string): RFC 3339 date-time (e.g., `2024-01-01T00:00:00Z`)
- **pageToken** (string): Token for pagination

## Agent Integration

### How Agents Decide to Use YouTube Search

The agent automatically uses YouTube search when:
1. User explicitly requests video content ("show me videos about...")
2. User asks for tutorials or demonstrations
3. User wants visual/multimedia explanations
4. Text-based responses would be insufficient

### Example Agent Prompts

**User:** "I need a tutorial on React hooks"
→ Agent triggers YouTube search with query: "React hooks tutorial"

**User:** "Show me how to cook pasta"
→ Agent triggers YouTube search with query: "how to cook pasta"

**User:** "What are the best machine learning courses?"
→ Agent may use YouTube search for video courses

### Resource Descriptor for Agents

The MCP server provides a resource descriptor that tells agents:
- **When to use it**: "Use when user requests video tutorials, demonstrations, or multimedia content"
- **What parameters are available**: query, maxResults, order, etc.
- **What format results will be in**: videoId, title, description, url, etc.

## Rate Limiting

- **10 requests per second** per user/IP
- Exceeding limits returns HTTP 429 with error message
- Rate limits reset every second

## Error Handling

### Common Errors

**400 Bad Request**
```json
{
  "success": false,
  "error": "Query parameter is required and must be a string"
}
```

**429 Rate Limit Exceeded**
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "Rate limit exceeded. Please wait before making more requests."
}
```

**502 YouTube API Error**
```json
{
  "success": false,
  "error": "YouTube API error",
  "message": "YouTube API error: 403 - Quota exceeded"
}
```

## Testing

### Test with cURL

```bash
# List resources
curl http://localhost:5000/api/mcp/resources

# Search YouTube
curl -X POST http://localhost:5000/api/mcp/youtube/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "javascript tutorial",
    "maxResults": 5
  }'

# Execute via MCP
curl -X POST http://localhost:5000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "resourceId": "youtube.search",
    "operation": "search",
    "params": {
      "query": "python programming",
      "maxResults": 3,
      "order": "relevance"
    }
  }'

# Health check
curl http://localhost:5000/api/mcp/health
```

### Test with JavaScript/Fetch

```javascript
// Search YouTube
const searchYouTube = async (query) => {
  const response = await fetch('http://localhost:5000/api/mcp/youtube/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      maxResults: 10,
      order: 'relevance'
    })
  });
  
  const data = await response.json();
  return data.results;
};

// Usage
const videos = await searchYouTube('web development tutorial');
console.log(videos);
```

## YouTube API Quotas

- **Default quota**: 10,000 units per day
- **Search cost**: 100 units per request
- **Daily limit**: ~100 searches per day with default quota

To increase quota:
1. Go to Google Cloud Console
2. Navigate to YouTube Data API v3
3. Request quota increase

## Security Best Practices

1. **Never commit API keys** to version control
2. **Use environment variables** for sensitive data
3. **Implement authentication** for production use
4. **Monitor API usage** to avoid quota exhaustion
5. **Add request validation** to prevent abuse

## Troubleshooting

### API Key Not Working
- Verify key is correctly set in `.env`
- Check if YouTube Data API v3 is enabled
- Ensure no IP/domain restrictions on the key

### Quota Exceeded
- Monitor usage in Google Cloud Console
- Request quota increase if needed
- Implement caching to reduce API calls

### Rate Limiting Issues
- Adjust rate limits in `youtubeMCP.js`
- Implement user-specific rate limiting
- Add Redis for distributed rate limiting

## Advanced Features

### Caching Results
Add Redis caching to reduce API calls:

```javascript
// In youtubeMCP.js
const cacheKey = `youtube:${query}:${maxResults}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);

// ... perform search ...

await redis.setex(cacheKey, 3600, JSON.stringify(results));
```

### Pagination
Use `nextPageToken` for pagination:

```javascript
const firstPage = await searchYouTube('tutorial');
const secondPage = await searchYouTube('tutorial', {
  pageToken: firstPage.nextPageToken
});
```

### Video Details
Get detailed video information:

```javascript
const response = await fetch('http://localhost:5000/api/mcp/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceId: 'youtube.search',
    operation: 'getVideoDetails',
    params: { videoId: 'abc123' }
  })
});
```

## Support

For issues or questions:
1. Check this documentation
2. Review error messages in server logs
3. Verify API key and quota status
4. Test with health check endpoint
