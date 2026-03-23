import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// WS-4: Authority labels for evidence type classification
const TYPE_AUTHORITY: Record<string, string> = {
  prd: 'Product requirement — decided',
  spec: 'Technical specification — decided',
  strategy: 'Strategic direction — decided',
  philosophy: 'Design philosophy — decided',
  decision_note: 'Decision record — decided',
  research: 'User research — observed, not decided',
  interview: 'Customer interview — observed, not decided',
  experiment_result: 'Experiment result — observed',
  support_signal: 'Support signal — observed',
  prior_test: 'Prior test — observed',
};

const matchRelationshipSchema = z.enum(["supports", "constrains", "commits", "defers", "conflicts", "duplicates", "safe", "overlap", "conflict", "unclear"]);

const blockingIssueSchema = z.object({
  type: z.string(),
  description: z.string(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  citations: z.array(z.string()).optional(),
});

const conditionSchema = z.object({
  description: z.string(),
  citations: z.array(z.string()).optional(),
});

const openQuestionSchema = z.object({
  question: z.string(),
  why_it_matters: z.string().optional(),
  citations: z.array(z.string()).optional(),
});

const llmResponseSchema = z.object({
  // V2 taxonomy (execution readiness)
  readiness_verdict: z.enum(["ready", "ready_with_conditions", "blocked", "needs_clarification"]).optional(),
  // V1 taxonomy (legacy compat)
  classification: z.enum(["safe", "overlap", "conflict", "unclear", "ready", "ready_with_conditions", "blocked", "needs_clarification"]).optional(),
  confidence: z.enum(["high", "moderate", "low"]),
  rationale: z.string(),
  matches: z.array(
    z.object({
      id: z.string(),
      relationship: matchRelationshipSchema,
      explanation: z.string(),
    })
  ),
  recommended_action: z.enum(["proceed", "proceed_with_conditions", "revise", "clarify", "escalate", "investigate"]),
  summary_statement: z.string().optional(),
  execution_summary: z.string().optional(),
  blocking_issues: z.array(blockingIssueSchema).optional(),
  required_conditions: z.array(conditionSchema).optional(),
  open_questions: z.array(openQuestionSchema).optional(),
  minimum_edits_to_proceed: z.array(z.string()).optional(),
});

export type LLMResponse = z.infer<typeof llmResponseSchema>;

interface EvalConfig {
  provider: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
}

interface EvidenceRecord {
  id: string;
  type: string;
  title: string;
  summary: string; // PRD 6.5: contains truncated content (~3200 chars)
  source_ref?: string | null;
  state?: string;
}

interface PriorTestRecord {
  id: string;
  title: string;
  objective: string;
  prd_body: string;
  additional_notes?: string | null;
  status: string;
  created_at: string | Date;
}

interface TestProposal {
  title: string;
  objective: string;
  prd_body: string;
  additional_notes?: string | null;
}

function buildPromptPayload(
  proposal: TestProposal,
  contextRecords: EvidenceRecord[],
  priorTests: PriorTestRecord[],
  operationPrompt: string
): string {
  const proposalBlock = [
    `## NEW TEST PROPOSAL`,
    `Title: ${proposal.title}`,
    `Objective: ${proposal.objective}`,
    `PRD Body: ${proposal.prd_body}`,
    proposal.additional_notes
      ? `Additional Notes: ${proposal.additional_notes}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // PRD 6.5: evidence-first format — no claim metadata in prompt
  // WS-4: Use authority labels instead of raw type
  const recordsBlock =
    contextRecords.length > 0
      ? `## EVIDENCE RECORDS (${contextRecords.length} records)\n` +
        contextRecords
          .map((r) => {
            const sourceInfo = r.source_ref ? `\n  Source: ${r.source_ref}` : "";
            const authority = TYPE_AUTHORITY[r.type] || r.type;
            return `- [${r.id}] (${authority}) "${r.title}"${sourceInfo}\n  Content: ${r.summary}`;
          })
          .join("\n")
      : `## EVIDENCE RECORDS\nNo evidence records found in scope.`;

  const priorTestsBlock =
    priorTests.length > 0
      ? `## PRIOR TEST PROPOSALS (${priorTests.length} tests)\n` +
        priorTests
          .map(
            (t) =>
              `- [${t.id}] (${t.status}) "${t.title}": ${t.objective}${
                t.prd_body ? " | " + t.prd_body.slice(0, 200) : ""
              }`
          )
          .join("\n")
      : `## PRIOR TEST PROPOSALS\nNo prior test proposals found.`;

  return `${operationPrompt}\n\n---\n\n${proposalBlock}\n\n${recordsBlock}\n\n${priorTestsBlock}`;
}

const EXPECTED_JSON_FORMAT = `You MUST respond with ONLY a valid JSON object (no markdown, no extra text) matching this exact schema:
{
  "readiness_verdict": "ready" | "ready_with_conditions" | "blocked" | "needs_clarification",
  "confidence": "high" | "moderate" | "low",
  "rationale": "<2-3 sentence explanation of your reasoning>",
  "execution_summary": "<one clear sentence: what must happen for this to execute safely>",
  "blocking_issues": [
    {
      "type": "constraint" | "commitment" | "deferral" | "dependency" | "conflict",
      "description": "<what blocks execution>",
      "severity": "high" | "medium" | "low",
      "citations": ["<evidence record id>"]
    }
  ],
  "required_conditions": [
    {
      "description": "<what must be incorporated before proceeding>",
      "citations": ["<evidence record id>"]
    }
  ],
  "open_questions": [
    {
      "question": "<what needs clarification>",
      "why_it_matters": "<why this matters for execution>",
      "citations": ["<evidence record id>"]
    }
  ],
  "matches": [
    {
      "id": "<evidence record id>",
      "relationship": "supports" | "constrains" | "commits" | "defers" | "conflicts" | "duplicates",
      "explanation": "<one sentence explaining the relationship>"
    }
  ],
  "recommended_action": "proceed" | "proceed_with_conditions" | "revise" | "clarify" | "escalate",
  "minimum_edits_to_proceed": ["<specific change needed>"]
}

Readiness verdict meanings:
- "ready": Can proceed now. No meaningful contradiction with decided context; dependencies and constraints are addressed.
- "ready_with_conditions": Can proceed, but specific adjustments, guardrails, or dependency checks must be incorporated first.
- "blocked": Should not proceed as written — violates constraints, conflicts with commitments/decisions, or reopens deferrals without justification.
- "needs_clarification": Insufficient specificity or evidence to determine execution readiness.

Match relationship types:
- "supports": Evidence validates or reinforces this proposal
- "constrains": Evidence imposes a limitation or guardrail on execution
- "commits": Evidence reflects an active obligation that this proposal must account for
- "defers": Evidence shows this was intentionally deferred — reopening requires justification
- "conflicts": Evidence directly contradicts key claims or assumptions
- "duplicates": Substantially similar work already exists or was completed

Confidence levels:
- "high": Multiple strong evidence matches, clear signal
- "moderate": Some relevant evidence but gaps remain
- "low": Sparse evidence, verdict is speculative

Reasoning priority order — evaluate in this sequence:
1. Decided constraints (hard guardrails)
2. Decided commitments (active obligations)
3. Decided deferrals (intentional non-go decisions)
4. Observed findings and metrics (feasibility validation)
5. Recommendations (suggested approaches)
6. Assumptions (fragility indicators)

IMPORTANT: Evidence records marked "decided" represent finalized product decisions.
Records marked "observed, not decided" represent customer feedback or research findings.
Weight decided evidence more heavily. A decided constraint always outweighs an observed recommendation.

Only return "blocked" when the proposal materially violates prior decisions, hard constraints, active commitments, or intentional deferrals.
If the proposal can proceed with specific conditions, prefer "ready_with_conditions" over "blocked".

If no evidence matches, return empty arrays and use "needs_clarification" verdict.`;

function tryParseJSON(text: string): unknown {
  const cleaned = text
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Normalize LLM response to handle common variations before strict validation
function normalizeLLMResponse(raw: Record<string, unknown>): Record<string, unknown> {
  const classificationMap: Record<string, string> = {
    // V2 taxonomy (execution readiness)
    "ready": "ready",
    "ready_with_conditions": "ready_with_conditions",
    "blocked": "blocked",
    "needs_clarification": "needs_clarification",
    // V1 taxonomy → V2 mapping
    "safe": "ready",
    "overlap": "ready_with_conditions",
    "conflict": "blocked",
    "unclear": "needs_clarification",
    // Legacy 5-category → V2
    "supports": "ready",
    "not_related": "ready",
    "unrelated": "ready",
    "no_relation": "ready",
    "extends": "ready_with_conditions",
    "duplicates": "ready_with_conditions",
    "duplicate": "ready_with_conditions",
    "overlapping": "ready_with_conditions",
    "adjacent": "ready_with_conditions",
    "related": "ready_with_conditions",
    "similar": "ready_with_conditions",
    "relevant": "ready_with_conditions",
    "conflicts": "blocked",
    "contradiction": "blocked",
    "contradicts": "blocked",
    "contradictory": "blocked",
    "insufficient": "needs_clarification",
    "none": "needs_clarification",
  };

  const actionMap: Record<string, string> = {
    "continue": "proceed",
    "go_ahead": "proceed",
    "approve": "proceed",
    "modify": "revise",
    "update": "revise",
    "review": "clarify",
    "check": "clarify",
    "further_investigation": "clarify",
    "investigate": "clarify",
    "proceed_with_conditions": "proceed_with_conditions",
    "clarify": "clarify",
    "escalate": "escalate",
  };

  const relationshipMap: Record<string, string> = {
    // V2 taxonomy (direct)
    "supports": "supports",
    "constrains": "constrains",
    "commits": "commits",
    "defers": "defers",
    "conflicts": "conflicts",
    "duplicates": "duplicates",
    // V1 → V2 mapping
    "safe": "supports",
    "supporting": "supports",
    "not_related": "supports",
    "unrelated": "supports",
    "overlap": "duplicates",
    "extends": "duplicates",
    "duplicate": "duplicates",
    "overlapping": "duplicates",
    "adjacent": "duplicates",
    "similar": "duplicates",
    "related": "duplicates",
    "same": "duplicates",
    "identical": "duplicates",
    "exact": "duplicates",
    "conflict": "conflicts",
    "contradicts": "conflicts",
    "contradictory": "conflicts",
    "contradiction": "conflicts",
    "unclear": "supports",
    "insufficient": "supports",
  };

  const confidenceMap: Record<string, string> = {
    "high": "high",
    "moderate": "moderate",
    "medium": "moderate",
    "low": "low",
    "none": "low",
  };

  // V2: readiness_verdict takes priority, falls back to classification
  const verdictSource = String(raw.readiness_verdict || raw.classification || "insufficient").toLowerCase();
  const action = String(raw.recommended_action || "clarify").toLowerCase();
  const confidence = String(raw.confidence || "low").toLowerCase();

  const normalizedVerdict = classificationMap[verdictSource] || verdictSource;

  const result: Record<string, unknown> = {
    ...raw,
    // Store as both for backward compat — DB column is `verdict`
    readiness_verdict: normalizedVerdict,
    classification: normalizedVerdict,
    confidence: confidenceMap[confidence] || "low",
    recommended_action: actionMap[action] || action,
    matches: Array.isArray(raw.matches) ? raw.matches.map((m: Record<string, unknown>) => {
      const rel = String(m.relationship || "supports").toLowerCase();
      return {
        ...m,
        relationship: relationshipMap[rel] || rel,
      };
    }) : [],
    rationale: raw.rationale || raw.reasoning || raw.reason || "No rationale provided.",
    summary_statement: raw.summary_statement || raw.execution_summary || raw.summary || undefined,
    execution_summary: raw.execution_summary || raw.summary_statement || undefined,
    blocking_issues: Array.isArray(raw.blocking_issues) ? raw.blocking_issues : [],
    required_conditions: Array.isArray(raw.required_conditions) ? raw.required_conditions : [],
    open_questions: Array.isArray(raw.open_questions) ? raw.open_questions : [],
    minimum_edits_to_proceed: Array.isArray(raw.minimum_edits_to_proceed) ? raw.minimum_edits_to_proceed : [],
  };

  // Remove legacy similarity_percentage if present
  delete result.similarity_percentage;

  return result;
}

export async function evaluateTest(
  proposal: TestProposal,
  contextRecords: EvidenceRecord[],
  operationPrompt: string,
  config: EvalConfig,
  priorTests: PriorTestRecord[] = []
): Promise<LLMResponse & { prompt_sent: string; raw_response?: unknown }> {
  const content = buildPromptPayload(
    proposal,
    contextRecords,
    priorTests,
    operationPrompt
  );

  if (config.provider === "anthropic") {
    const client = new Anthropic({ apiKey: config.apiKey });

    // Retry logic for transient API errors (overloaded, rate limits)
    const MAX_RETRIES = 2;
    let response;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await client.messages.create({
          model: config.model,
          max_tokens: config.maxTokens || 2048,
          system: EXPECTED_JSON_FORMAT,
          messages: [{ role: "user", content }],
        });
        break;
      } catch (err: any) {
        const isRetryable =
          err?.status === 529 ||
          err?.status === 429 ||
          err?.error?.type === "overloaded_error" ||
          err?.error?.error?.type === "overloaded_error";
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 5000; // 5s, 10s backoff
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (isRetryable) {
          throw new Error(
            "The AI service is temporarily at capacity. Please wait a moment and try again."
          );
        }
        throw err;
      }
    }
    if (!response) {
      throw new Error("Failed to get a response from the AI service after retries.");
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Anthropic.");
    }

    let parsed = tryParseJSON(textBlock.text);
    if (!parsed) {
      const repairResponse = await client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens || 2048,
        system: EXPECTED_JSON_FORMAT,
        messages: [
          { role: "user", content },
          { role: "assistant", content: textBlock.text },
          {
            role: "user",
            content:
              "Your previous response was not valid JSON. Please return ONLY the valid JSON object with no extra text.",
          },
        ],
      });
      const repairBlock = repairResponse.content.find((b) => b.type === "text");
      if (repairBlock && repairBlock.type === "text") {
        parsed = tryParseJSON(repairBlock.text);
      }
    }

    if (!parsed) {
      throw new Error("Could not parse evaluation response. Please try again.");
    }

    // Normalize common LLM variations before strict validation
    const normalized = normalizeLLMResponse(parsed as Record<string, unknown>);
    const validated = llmResponseSchema.safeParse(normalized);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      console.error("LLM response validation failed:", issues, JSON.stringify(normalized));
      throw new Error(
        `Evaluation response invalid: ${issues}. Try again or adjust the operation prompt.`
      );
    }

    return { ...validated.data, prompt_sent: content, raw_response: parsed };
  }

  throw new Error(
    `Provider "${config.provider}" is not supported. Use "anthropic".`
  );
}

export async function testProviderConnection(config: EvalConfig): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    if (config.provider === "anthropic") {
      const client = new Anthropic({ apiKey: config.apiKey });
      const response = await client.messages.create({
        model: config.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with: ok" }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock) {
        return { success: true, message: "Connection successful." };
      }
      return { success: false, message: "No response from provider." };
    }
    return {
      success: false,
      message: `Provider "${config.provider}" is not supported.`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Connection failed.";
    if (
      msg.includes("401") ||
      msg.includes("authentication") ||
      msg.includes("invalid")
    ) {
      return { success: false, message: "Invalid API key." };
    }
    return { success: false, message: msg };
  }
}
