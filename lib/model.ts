import type { ZodType } from "zod";

interface ChatCompletionResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

export async function generateStructured<T>(
  system: string,
  input: unknown,
  schema: ZodType<T>,
): Promise<T> {
  const endpoint = process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com/v1/messages";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL;

  if (!apiKey || !model) {
    throw new Error("Set ANTHROPIC_API_KEY and CLAUDE_MODEL before running an agent.");
  }

  const request = () => fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(300_000),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    }),
  });

  let response: Response;
  try {
    response = await request();
  } catch {
    response = await request();
  }

  if (response.status === 429 || response.status >= 500) response = await request();

  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  if (!content) throw new Error("Claude returned no structured content.");
  return schema.parse(JSON.parse(extractJson(content)));
}

function extractJson(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1];
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);
  return value;
}