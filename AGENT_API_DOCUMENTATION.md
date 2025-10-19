# Agent API Documentation - Integrated YouTube MCP

## Overview
The chat stream endpoint now supports automatic YouTube video search through the MCP (Model Context Protocol) integration. The agent can decide when to search YouTube based on user queries.

## Main Endpoint

### Stream Chat with Agent
**POST** `/api/chat/stream`

This is your primary agent endpoint that now supports YouTube video search alongside text generation, web search, and image search.

#### Authentication
Requires authentication via JWT token in the `Authorization` header:
```
Authorization: Bearer <your_jwt_token>
```

#### Request Body

**Content-Type:** `multipart/form-data` or `application/json`

```json
{
  "prompt": "How do I tie a tie?",
  "conversationId": "optional-conversation-id",
  "options": {
    "includeSearch": true,
    "includeImageSearch": true,
    "includeYouTube": true,
    "systemPrompt": "optional-custom-prompt"
  }
}
```

#### Request Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | User's input message |
| `conversationId` | string | No | null | ID of existing conversation to continue |
| `options.includeSearch` | boolean | No | true (false if files) | Enable Google web search |
| `options.includeImageSearch` | boolean | No | true | Enable image search |
| `options.includeYouTube` | boolean | No | false | Enable YouTube video search |
| `options.systemPrompt` | string | No | Research Assistant | Custom system prompt |

#### Response Format

**Content-Type:** `text/event-stream` (Server-Sent Events)

The endpoint streams multiple event types:

##### 1. Conversation ID Event
```
event: conversationId
data: {"conversationId": "uuid-here"}
```

##### 2. Image Results Event
```
event: images
data: {"images": [{"url": "...", "title": "...", "source": "..."}]}
```

##### 3. YouTube Results Event (NEW)
```
event: youtubeResults
data: {
  "videos": [
    {
      "videoId": "abc123",
      "title": "How to Tie a Tie - Step by Step",
      "description": "Learn the easiest way...",
      "channelTitle": "Style Channel",
      "channelId": "UC123",
      "publishedAt": "2024-01-01T00:00:00Z",
      "thumbnails": {
        "default": {"url": "...", "width": 120, "height": 90},
        "medium": {"url": "...", "width": 320, "height": 180},
        "high": {"url": "...", "width": 480, "height": 360}
      },
      "url": "https://www.youtube.com/watch?v=abc123"
    }
  ]
}
```

##### 4. Message Chunks Event
```
event: message
data: {"text": "Here's how to tie a tie..."}
```

##### 5. Sources Event
```
event: sources
data: {
  "sources": [
    {"url": "https://example.com", "title": "Page Title"}
  ]
}
```

##### 6. Finish Event
```
event: finish
data: {"finishReason": "STOP"}
```

##### 7. Error Event
```
event: error
data: {"message": "Error description"}
```

## When the Agent Uses YouTube

The agent automatically decides to search YouTube when:

1. **Explicit video request**: User asks "show me videos about..."
2. **Tutorial/demonstration**: User requests "how to do X" where visual is helpful
3. **Step-by-step guides**: Tasks that benefit from video demonstration
4. **Visual learning**: Topics better explained through video

### Decision Logic

The agent uses natural language understanding combined with the `includeYouTube` flag:

- **Frontend control**: Set `options.includeYouTube: true` to enable
- **Agent decision**: The MCP resource descriptor guides when to use it
- **Fallback**: If YouTube search fails, the request continues normally

## Usage Examples

### Example 1: Basic Chat with YouTube
```javascript
const response = await fetch('http://localhost:5000/api/chat/stream', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: 'Show me how to make pasta carbonara',
    options: {
      includeYouTube: true,
      includeImageSearch: true
    }
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  const lines = chunk.split('\n\n');
  
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      const eventType = line.split('\n')[0].replace('event: ', '');
      const dataLine = line.split('\n')[1];
      
      if (dataLine && dataLine.startsWith('data: ')) {
        const data = JSON.parse(dataLine.replace('data: ', ''));
        
        switch (eventType) {
          case 'conversationId':
            console.log('Conversation ID:', data.conversationId);
            break;
          case 'youtubeResults':
            console.log('YouTube Videos:', data.videos);
            // Display video thumbnails and links
            break;
          case 'message':
            console.log('AI Response:', data.text);
            break;
          case 'sources':
            console.log('Sources:', data.sources);
            break;
        }
      }
    }
  }
}
```

### Example 2: React Component with YouTube Support
```jsx
import { useState, useEffect } from 'react';

function ChatWithYouTube() {
  const [messages, setMessages] = useState([]);
  const [videos, setVideos] = useState([]);
  const [input, setInput] = useState('');

  const sendMessage = async () => {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: input,
        options: {
          includeYouTube: true
        }
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let currentMessage = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const events = parseSSE(chunk);

      for (const event of events) {
        switch (event.type) {
          case 'youtubeResults':
            setVideos(event.data.videos);
            break;
          case 'message':
            currentMessage += event.data.text;
            setMessages(prev => [...prev, { role: 'assistant', content: currentMessage }]);
            break;
        }
      }
    }
  };

  return (
    <div>
      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i}>{msg.content}</div>
        ))}
      </div>
      
      {videos.length > 0 && (
        <div className="youtube-results">
          <h3>Related Videos</h3>
          {videos.map(video => (
            <div key={video.videoId} className="video-card">
              <img src={video.thumbnails.medium.url} alt={video.title} />
              <h4>{video.title}</h4>
              <p>{video.channelTitle}</p>
              <a href={video.url} target="_blank">Watch on YouTube</a>
            </div>
          ))}
        </div>
      )}
      
      <input 
        value={input} 
        onChange={(e) => setInput(e.target.value)}
        placeholder="Ask anything..."
      />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
}
```

### Example 3: cURL Request
```bash
curl -X POST http://localhost:5000/api/chat/stream \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "How do I change a tire?",
    "options": {
      "includeYouTube": true,
      "includeImageSearch": true
    }
  }'
```

## Database Schema

The `messages` table now includes a `videos` column to store YouTube results:

```sql
ALTER TABLE messages ADD COLUMN videos JSONB;
```

Example stored data:
```json
{
  "videos": [
    {
      "videoId": "abc123",
      "title": "Video Title",
      "url": "https://www.youtube.com/watch?v=abc123",
      "thumbnails": {...}
    }
  ]
}
```

## Error Handling

### YouTube API Errors
If YouTube search fails, the stream continues without videos:
- No `youtubeResults` event is emitted
- The text response still generates normally
- Error is logged server-side but not exposed to client

### Rate Limiting
YouTube MCP has built-in rate limiting:
- **10 requests per second** per user
- Exceeding limits logs a warning but doesn't fail the request

### API Key Issues
If `YOUTUBE_API_KEY` is missing or invalid:
- YouTube search is silently skipped
- Health check at `/api/mcp/health` shows status
- Other features (text, web search, images) work normally

## Configuration

### Environment Variables
```env
# Required for YouTube functionality
YOUTUBE_API_KEY=your_youtube_api_key_here

# Other required variables
GEMINI_API_KEY=your_gemini_key
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
JWT_SECRET=your_jwt_secret
```

### YouTube API Quotas
- **Default quota**: 10,000 units/day
- **Search cost**: 100 units per request
- **Daily limit**: ~100 searches with default quota

## Testing

### Test YouTube Integration
```bash
# 1. Check MCP health
curl http://localhost:5000/api/mcp/health

# 2. Test direct YouTube search
curl -X POST http://localhost:5000/api/mcp/youtube/search \
  -H "Content-Type: application/json" \
  -d '{"query": "javascript tutorial", "maxResults": 5}'

# 3. Test integrated stream endpoint
curl -X POST http://localhost:5000/api/chat/stream \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Show me React tutorials",
    "options": {"includeYouTube": true}
  }'
```

## Best Practices

1. **Selective YouTube Usage**
   - Only enable `includeYouTube` when videos would be helpful
   - Don't enable for every request to conserve quota

2. **Frontend Caching**
   - Cache video results to avoid duplicate searches
   - Store conversation history with videos

3. **User Experience**
   - Show video thumbnails prominently
   - Allow users to toggle video search on/off
   - Display video metadata (channel, publish date)

4. **Error Handling**
   - Gracefully handle missing videos
   - Don't fail entire request if YouTube unavailable
   - Provide fallback text responses

5. **Performance**
   - YouTube search runs in parallel with image search
   - Doesn't block text generation
   - Results stream as soon as available

## Troubleshooting

### No YouTube Results
1. Check `YOUTUBE_API_KEY` is set in `.env`
2. Verify API key is valid and YouTube Data API v3 is enabled
3. Check quota hasn't been exceeded
4. Ensure `includeYouTube: true` in request options

### Rate Limiting
1. Monitor usage in Google Cloud Console
2. Implement frontend caching
3. Request quota increase if needed

### Integration Issues
1. Check server logs for `[YouTube MCP]` messages
2. Test `/api/mcp/health` endpoint
3. Verify Supabase `messages` table has `videos` column

## Support

For issues:
1. Check server logs for detailed error messages
2. Test MCP endpoints independently
3. Verify all environment variables are set
4. Review YouTube API quota in Google Cloud Console
