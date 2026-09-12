import { ZodError, type ZodType } from "zod";

interface ChatCompletionResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

type Message = { role: "user" | "assistant"; content: string };

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

  const callModel = async (messages: Message[]): Promise<string> => {
    const request = () => fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 8192, system, messages }),
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
    return content;
  };

  const initialMessages: Message[] = [{ role: "user", content: JSON.stringify(input) }];
  const firstContent = await callModel(initialMessages);
  try {
    return schema.parse(JSON.parse(extractJson(firstContent)));
  } catch (error) {
    // A malformed or schema-violating response (e.g. a list exceeding a stated limit) gets one
    // corrective retry that shows the model its own output and the exact validation failure,
    // instead of discarding the whole pipeline stage on a fixable formatting slip.
    if (!(error instanceof ZodError) && !(error instanceof SyntaxError)) throw error;
    const problem = error instanceof ZodError
      ? `The JSON did not satisfy the required schema: ${error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}.`
      : "The response was not valid JSON.";
    const retryMessages: Message[] = [
      ...initialMessages,
      { role: "assistant", content: firstContent },
      { role: "user", content: `${problem} Return corrected JSON only, satisfying every constraint exactly, including any list length limits.` },
    ];
    const secondContent = await callModel(retryMessages);
    return schema.parse(JSON.parse(extractJson(secondContent)));
  }
}

function extractJson(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1];
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);
  return value;
}