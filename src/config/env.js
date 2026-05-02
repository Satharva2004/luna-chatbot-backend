import dotenv from 'dotenv';

// Load environment variables from .env file in development.
if (process.env.NODE_ENV !== 'production') {
  const path = await import('path');
  const { fileURLToPath } = await import('node:url');
  const fs = await import('fs');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, '../../.env');

  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath });
    if (result.error) {
      console.error('Error loading .env file:', result.error);
      process.exit(1);
    }
  } else {
    console.warn('.env file not found, using environment variables from the host');
  }
}

const collectGeminiKeys = () => [
  process.env.GEMINI_API_KEYS,
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY2,
  process.env.GEMINI_API_KEY3,
  process.env.GEMINI_API_KEY4,
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
]
  .flatMap(value => String(value || '').split(','))
  .map(value => value.trim())
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index);

// Verify required environment variables.
const requiredEnvVars = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'GROQ_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]?.trim());

if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

const geminiKeyCount = collectGeminiKeys().length;

console.log('\nEnvironment Configuration:');
console.log('='.repeat(50));
console.log(`- NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`- GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'set' : 'not set'}`);
console.log(`- GEMINI_API_KEY2: ${process.env.GEMINI_API_KEY2 ? 'set' : 'not set'}`);
console.log(`- GEMINI_API_KEY3: ${process.env.GEMINI_API_KEY3 ? 'set' : 'not set'}`);
console.log(`- GEMINI_API_KEY4: ${process.env.GEMINI_API_KEY4 ? 'set' : 'not set'}`);
console.log(`- Gemini key pool: ${geminiKeyCount} key(s) configured`);
console.log(`- SUPABASE_URL: ${process.env.SUPABASE_URL ? 'set' : 'not set'}`);
console.log(`- GROQ_KEY: ${process.env.GROQ_KEY ? 'set' : 'not set'}`);
console.log('='.repeat(50) + '\n');

export default process.env;
