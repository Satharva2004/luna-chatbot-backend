# LunaAI Backend

Express backend powering chat, auth, conversation history, uploads, and AI integrations.

## Stack

- Node.js
- Express
- Supabase
- Gemini / OpenAI style integrations
- Multer for uploads

## Features

- Streaming chat responses
- Conversation storage and history
- Auth and JWT handling
- File upload processing
- Chart and media response support
- AI-generated conversation titles

## Run Locally

```bash
npm install
npm run dev
```

Server runs on [http://localhost:5000](http://localhost:5000)

## Environment

Create a `.env` file in `assignment-backend/` with values for:

```env
PORT=5000
NODE_ENV=development

GEMINI_API_KEY=your_key
OPENAI_API_KEY=your_key

SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_key

JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=10d

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_API_KEY=your_google_api_key
GOOGLE_CSE_ID=your_google_cse_id
YOUTUBE_API_KEY=your_youtube_api_key

SERPAPI_KEY=your_serpapi_key

FEATHERLESS_API_KEY=your_featherless_key
FEATHERLESS_BASE_URL=https://api.featherless.ai/v1
FEATHERLESS_MODEL_NAME=Qwen/Qwen2.5-7B-Instruct
```

## Scripts

```bash
npm run dev
npm start
```

## Structure

```text
src/controllers request handlers
src/routes      API routes
src/services    AI and business logic
src/config      env and config
src/server.js   app entry
```

## Notes

This backend is designed to work with the LunaAI frontend in the sibling `frontend/` folder.
