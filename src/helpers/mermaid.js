import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

function extractMermaidBlocks(content) {
  if (typeof content !== 'string' || !content.length) {
    return { content, blocks: [] };
  }

  const regex = /```mermaid[\r\n]+([\s\S]*?)```/g;
  const blocks = [];
  let match;
  let index = 0;
  let updatedContent = content;

  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0];
    const diagram = match[1] || '';

    const trimmedDiagram = diagram.trim();
    if (!trimmedDiagram) {
      blocks.push({
        index,
        status: 'failed',
        original: fullMatch,
        replacement: fullMatch,
        error: 'Empty Mermaid diagram',
        id: randomUUID(),
      });
      index += 1;
      continue;
    }

    const replacement = '```mermaid\n' + trimmedDiagram + '\n```';

    blocks.push({
      index,
      status: 'valid',
      original: fullMatch,
      replacement,
      error: undefined,
      id: randomUUID(),
    });

    if (fullMatch !== replacement) {
      updatedContent = updatedContent.replace(fullMatch, replacement);
    }

    index += 1;
  }

  return { content: updatedContent, blocks };
}

export async function processMermaidBlocks({ content, prompt, userId }) {
  const { content: updatedContent, blocks } = extractMermaidBlocks(content);

  return {
    content: updatedContent,
    blocks,
    prompt: typeof prompt === 'string' ? prompt : undefined,
    userId: typeof userId === 'string' ? userId : undefined,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function renderMermaidPng(mermaidCode, outputPath) {
  const tmpInput = path.join(__dirname, 'tmp-diagram.mmd');
  await fs.writeFile(tmpInput, mermaidCode, 'utf8');

  const mmdcPath = path.join(
    __dirname,
    '..',
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'mmdc.cmd' : 'mmdc',
  );

  return new Promise((resolve, reject) => {
    execFile(
      mmdcPath,
      ['-i', tmpInput, '-o', outputPath, '-t', 'neutral', '-b', 'transparent'],
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          return reject(error);
        }
        resolve(outputPath);
      },
    );
  });
}
