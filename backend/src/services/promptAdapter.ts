import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import OpenAI from 'openai';
import { config } from '../config';

const plannerClient = config.openAiApiKey
  ? new OpenAI({
      apiKey: config.openAiApiKey,
    })
  : null;

const projectRoot =
  path.basename(process.cwd()) === 'backend' ? path.resolve(process.cwd(), '..') : process.cwd();

const runCodexExec = async (args: string[], prompt: string): Promise<void> =>
  await new Promise((resolve, reject) => {
    const child = spawn(config.codexCliPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`codex exec timed out after ${config.codexCliTimeoutSeconds} seconds.`));
    }, config.codexCliTimeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to start Codex CLI at "${config.codexCliPath}". ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          [
            `codex exec exited with code ${code ?? 'unknown'}.`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

const extractJson = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Codex CLI returned an empty response.');
  }

  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, '').replace(/\s*```$/, ''),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next shape
    }
  }

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
  }

  throw new Error(`Codex CLI did not return valid JSON.\n${trimmed}`);
};

const extractSchemaObject = (schema: Record<string, unknown>): Record<string, unknown> => {
  const candidate = schema.schema;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }

  return schema;
};

const sanitizeCodexSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCodexSchema(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitizedEntries = Object.entries(value).map(([key, nestedValue]) => [key, sanitizeCodexSchema(nestedValue)]);
  const sanitizedObject = Object.fromEntries(sanitizedEntries) as Record<string, unknown>;

  if (typeof sanitizedObject.$ref === 'string') {
    return { $ref: sanitizedObject.$ref };
  }

  if ('properties' in sanitizedObject && sanitizedObject.properties && typeof sanitizedObject.properties === 'object') {
    sanitizedObject.additionalProperties = false;
    sanitizedObject.required = Object.keys(sanitizedObject.properties as Record<string, unknown>);
  }

  return sanitizedObject;
};

export const generateStructuredOutput = async <T>(params: {
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  openAiModel: string;
  codexModel?: string;
}): Promise<T> => {
  if (config.aiProvider === 'openai') {
    if (!plannerClient) {
      throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai.');
    }

    const response = await plannerClient.chat.completions.create({
      model: params.openAiModel,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: params.schema as {
          name: string;
          strict: boolean;
          schema: Record<string, unknown>;
        },
      },
      messages: [
        {
          role: 'system',
          content: params.systemPrompt,
        },
        {
          role: 'user',
          content: params.userPrompt,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('The planner model did not return any content.');
    }

    return JSON.parse(content) as T;
  }

  if (config.aiProvider !== 'codex_cli') {
    throw new Error(`Unsupported AI_PROVIDER "${config.aiProvider}".`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-agent-codex-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const codexSchema = sanitizeCodexSchema(extractSchemaObject(params.schema));
  const combinedPrompt = [
    params.systemPrompt,
    '',
    'Return only a JSON object that matches the provided schema exactly.',
    '',
    params.userPrompt,
  ].join('\n');

  try {
    await fs.writeFile(schemaPath, JSON.stringify(codexSchema, null, 2), 'utf8');

    await runCodexExec(
      [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--cd',
        projectRoot,
        '--model',
        params.codexModel || config.codexModel,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '-',
      ],
      combinedPrompt,
    );

    const output = await fs.readFile(outputPath, 'utf8');
    return extractJson(output) as T;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};
