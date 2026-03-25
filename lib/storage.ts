import { query } from "./db";
import { v4 as uuidv4 } from "uuid";
import { processSourceClaims } from "./claims";

// ─── Types ──────────────────────────────────────────────────────
export interface Product {
  id: string;
  name: string;
  created_at: string;
}

export interface TestProposal {
  id: string;
  group_id: string;
  version: number;
  created_at: string;
  created_by: string;
  product_id: string | null;
  project_id: string | null;
  title: string;
  objective: string;
  prd_body: string;
  additional_notes: string | null;
  hypothesis: string | null;
  test_type: string | null;
  method: string | null;
  status: string;
}

export interface EvidenceRecord {
  id: string;
  type: string;
  product_id: string;
  project_id: string | null;
  title: string;
  summary: string;
  source_ref: string | null;
  // recorded_at: system ingestion timestamp (auto-set by DB, never editable)
  // source_date: the date the evidence was originally created or published.
  //   For manual entry: user-provided date of the experiment, interview, etc.
  //   For CSV import: map from the source CSV's date column (NOT the import date).
  //   For Gutenberg / external ingestion: pull the work's publication date if available;
  //     fall back to null rather than using the ingestion timestamp.
  //   NEVER default this to recorded_at — stale evidence must be correctly aged.
  recorded_at: string;
  source_date: string | null;
  state: string;
  is_enabled: boolean;
  // PRD 9 columns (optional — have DB defaults, not always selected)
  content_hash?: string | null;
  source_type?: string | null;
  source_external_id?: string | null;
  source_version?: number | null;
  is_tombstoned?: boolean;
  tombstone_reason?: string | null;
}

export interface EvaluationResult {
  id: string;
  run_id: string;
  test_id: string;
  evaluated_at: string;
  provider: string;
  model: string;
  prompt_version: number;
  verdict: string;
  similarity_percentage: number;
  reason: string;
  statement: string;
  recommended_action: string;
  prompt_sent: string | null;
  retrieval_metadata: Record<string, unknown> | null;
  raw_response: Record<string, unknown> | null;
}

export interface EvaluationMatch {
  id: string;
  evaluation_id: string;
  evidence_id: string;
  relationship: string;
  similarity_percentage: number; // kept for backward compat, new evals set to 0
  explanation: string;
}

export interface OperationPrompt {
  id: string;
  name: string;
  version: number;
  text: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DataSource {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  include_in_evaluation: boolean;
  last_synced_at: string | null;
  record_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderSettings {
  id: string;
  provider: string;
  model: string;
  api_key_hash: string | null;
  api_key_last4: string | null;
  last_validated_at: string | null;
  updated_at: string;
}

export interface PageView {
  id: string;
  path: string;
  visitor_id: string;
  session_id: string | null;
  event_type: string;
  meta: string | null;
  ip_address: string | null;
  user_agent: string | null;
  referrer: string | null;
  visited_at: string;
}

// ─── Projects ───────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  product_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getProjects(filters?: {
  product_id?: string;
  status?: string;
}): Promise<Project[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.product_id) {
    conditions.push(`product_id = $${idx++}`);
    params.push(filters.product_id);
  }
  if (filters?.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await query(`SELECT * FROM projects ${where} ORDER BY created_at DESC`, params);
  return rows;
}

export async function getProject(id: string): Promise<Project | undefined> {
  const { rows } = await query("SELECT * FROM projects WHERE id = $1", [id]);
  return rows[0] ?? undefined;
}

export async function createProject(
  data: Pick<Project, "name"> & Partial<Pick<Project, "description" | "status" | "priority" | "product_id">>
): Promise<Project> {
  const { rows } = await query(
    `INSERT INTO projects (name, description, status, priority, product_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.name, data.description ?? null, data.status ?? null, data.priority ?? null, data.product_id ?? null]
  );
  return rows[0];
}

export async function updateProject(
  id: string,
  data: Partial<Project>
): Promise<Project | undefined> {
  // Build dynamic SET clause
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;
  const allowedFields = ["name", "description", "status", "priority", "product_id"] as const;
  for (const field of allowedFields) {
    if (field in data) {
      sets.push(`${field} = $${idx++}`);
      params.push((data as any)[field]);
    }
  }
  sets.push(`updated_at = $${idx++}`);
  params.push(new Date().toISOString());
  params.push(id);

  const { rows } = await query(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] ?? undefined;
}

export async function deleteProject(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM projects WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// ─── Products ───────────────────────────────────────────────────
export async function getProducts(): Promise<Product[]> {
  const { rows } = await query("SELECT * FROM products ORDER BY name ASC");
  return rows;
}

export async function getProduct(id: string): Promise<Product | undefined> {
  const { rows } = await query("SELECT * FROM products WHERE id = $1", [id]);
  return rows[0] ?? undefined;
}

export async function createProduct(name: string): Promise<Product> {
  const { rows } = await query(
    "INSERT INTO products (name) VALUES ($1) RETURNING *",
    [name]
  );
  return rows[0];
}

// ─── Test Proposals ─────────────────────────────────────────────
export async function getTests(filters?: {
  product_id?: string;
  project_id?: string;
  verdict?: string;
  keyword?: string;
}): Promise<TestProposal[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.product_id) {
    conditions.push(`product_id = $${idx++}`);
    params.push(filters.product_id);
  }
  if (filters?.project_id) {
    conditions.push(`project_id = $${idx++}`);
    params.push(filters.project_id);
  }
  if (filters?.keyword) {
    conditions.push(`(title ILIKE $${idx} OR objective ILIKE $${idx})`);
    params.push(`%${filters.keyword}%`);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT * FROM test_proposals ${where} ORDER BY created_at DESC`,
    params
  );
  return rows;
}

export async function getTest(id: string): Promise<TestProposal | undefined> {
  const { rows } = await query("SELECT * FROM test_proposals WHERE id = $1", [id]);
  return rows[0] ?? undefined;
}

export async function createTest(
  data: Omit<TestProposal, "id" | "created_at">
): Promise<TestProposal> {
  const { rows } = await query(
    `INSERT INTO test_proposals (group_id, version, created_by, product_id, project_id, title, objective, prd_body, additional_notes, hypothesis, test_type, method, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      data.group_id, data.version, data.created_by, data.product_id, data.project_id,
      data.title, data.objective, data.prd_body, data.additional_notes,
      data.hypothesis, data.test_type, data.method, data.status,
    ]
  );
  return rows[0];
}

export async function updateTest(
  id: string,
  data: Partial<TestProposal>
): Promise<TestProposal | undefined> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;
  const allowedFields = [
    "group_id", "version", "created_by", "product_id", "project_id",
    "title", "objective", "prd_body", "additional_notes", "hypothesis",
    "test_type", "method", "status",
  ] as const;

  for (const field of allowedFields) {
    if (field in data) {
      sets.push(`${field} = $${idx++}`);
      params.push((data as any)[field]);
    }
  }
  if (sets.length === 0) return getTest(id);

  params.push(id);
  const { rows } = await query(
    `UPDATE test_proposals SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] ?? undefined;
}

export async function deleteTest(id: string): Promise<boolean> {
  // Cascade: remove evaluation_matches → evaluation_results → test_proposal
  const { rows: evalRows } = await query(
    "SELECT id FROM evaluation_results WHERE test_id = $1",
    [id]
  );
  if (evalRows.length > 0) {
    const evalIds = evalRows.map((r: any) => r.id);
    await query(
      `DELETE FROM evaluation_matches WHERE evaluation_id = ANY($1)`,
      [evalIds]
    );
    await query("DELETE FROM evaluation_results WHERE test_id = $1", [id]);
  }
  await query("DELETE FROM test_proposals WHERE id = $1", [id]);
  return true;
}

export async function getTestVersions(groupId: string): Promise<any[]> {
  const { rows } = await query(
    "SELECT id, group_id, version, title, status, created_at FROM test_proposals WHERE group_id = $1 ORDER BY version ASC",
    [groupId]
  );
  return rows;
}

export async function deleteBrokenProposals(): Promise<number> {
  const { rowCount } = await query(
    "DELETE FROM test_proposals WHERE status IN ('draft', 'submitted')"
  );
  return rowCount ?? 0;
}

// ─── Evidence Records ───────────────────────────────────────────
export async function getEvidence(filters?: {
  product_id?: string;
  keyword?: string;
}): Promise<EvidenceRecord[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.product_id) {
    conditions.push(`product_id = $${idx++}`);
    params.push(filters.product_id);
  }
  if (filters?.keyword) {
    conditions.push(`(title ILIKE $${idx} OR summary ILIKE $${idx})`);
    params.push(`%${filters.keyword}%`);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT id, type, product_id, project_id, title, summary, source_ref, source_date, is_enabled, state, last_synced_at, recorded_at, claims_extraction_status, embedding_model, embedded_at
     FROM evidence_records ${where} ORDER BY recorded_at DESC LIMIT 5000`,
    params
  );
  return rows;
}

export async function getEvidenceById(
  id: string
): Promise<EvidenceRecord | undefined> {
  const { rows } = await query("SELECT * FROM evidence_records WHERE id = $1", [id]);
  return rows[0] ?? undefined;
}

export async function createEvidence(
  data: Omit<EvidenceRecord, "id" | "recorded_at"> & { id?: string; content?: string; is_tombstoned?: boolean; tombstone_reason?: string | null; content_hash?: string; source_type?: string; source_external_id?: string; source_version?: number; last_synced_at?: string }
): Promise<EvidenceRecord> {
  const fields: string[] = [];
  const placeholders: string[] = [];
  const params: any[] = [];
  let idx = 1;

  const insertFields: Record<string, any> = { ...data };
  // Remove computed/auto fields
  delete insertFields.recorded_at;

  for (const [key, value] of Object.entries(insertFields)) {
    if (value !== undefined) {
      fields.push(key);
      placeholders.push(`$${idx++}`);
      params.push(value);
    }
  }

  const { rows } = await query(
    `INSERT INTO evidence_records (${fields.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    params
  );
  return rows[0];
}

export async function upsertTestEvidence(test: TestProposal): Promise<EvidenceRecord | null> {
  if (!test.product_id) return null;
  const sourceRef = `test:${test.id}`;
  const content = [
    test.prd_body,
    test.additional_notes ? `\n\nAdditional Notes: ${test.additional_notes}` : '',
  ].join('').slice(0, 32000);
  const summary = [
    test.objective,
    test.prd_body?.slice(0, 1000),
  ].filter(Boolean).join('\n\n');

  // Check if evidence already exists for this test
  const { rows: existing } = await query(
    "SELECT id FROM evidence_records WHERE source_ref = $1 LIMIT 1",
    [sourceRef]
  );

  if (existing.length > 0) {
    const { rows } = await query(
      `UPDATE evidence_records SET title = $1, summary = $2, content = $3, last_synced_at = $4
       WHERE id = $5 RETURNING *`,
      [test.title, summary, content, new Date().toISOString(), existing[0].id]
    );
    return rows[0];
  }

  // INSERT new record
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO evidence_records (id, type, product_id, title, summary, content, source_ref, state, is_enabled, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [id, 'prior_test', test.product_id, test.title, summary, content, sourceRef, 'current', true, new Date().toISOString()]
  );
  return rows[0];
}

export async function embedEvidence(id: string): Promise<void> {
  const { rows } = await query(
    "SELECT title, summary, content FROM evidence_records WHERE id = $1",
    [id]
  );
  const record = rows[0];
  if (!record) return;

  const { embedTexts } = await import('./claims');
  const textToEmbed = [
    record.title,
    record.content || record.summary,
  ].filter(Boolean).join(' ').slice(0, 32000);

  const [embedding] = await embedTexts([textToEmbed]);
  await query(
    `UPDATE evidence_records SET embedding = $1, embedding_model = $2 WHERE id = $3`,
    [`[${embedding.join(',')}]`, 'text-embedding-3-small', id]
  );
}

export async function toggleEvidenceEnabled(
  id: string,
  is_enabled: boolean
): Promise<EvidenceRecord | undefined> {
  const { rows } = await query(
    "UPDATE evidence_records SET is_enabled = $1 WHERE id = $2 RETURNING *",
    [is_enabled, id]
  );
  return rows[0] ?? undefined;
}

export async function toggleAllEvidenceEnabled(
  is_enabled: boolean,
  product_id?: string
): Promise<number> {
  if (product_id) {
    const { rowCount } = await query(
      "UPDATE evidence_records SET is_enabled = $1 WHERE product_id = $2",
      [is_enabled, product_id]
    );
    return rowCount ?? 0;
  }
  const { rowCount } = await query(
    "UPDATE evidence_records SET is_enabled = $1",
    [is_enabled]
  );
  return rowCount ?? 0;
}

export async function toggleEvidenceBySourcePrefix(
  prefix: string,
  is_enabled: boolean
): Promise<number> {
  // Claims toggle: claims:v1, claims:v2, claims:other
  if (prefix.startsWith("claims:")) {
    const version = prefix.replace("claims:", "");
    let result;
    if (version === "v1" || version === "v2") {
      result = await query(
        "UPDATE claims SET is_enabled = $1 WHERE prompt_version = $2",
        [is_enabled, version]
      );
    } else {
      // "other" — claims without v1/v2
      result = await query(
        "UPDATE claims SET is_enabled = $1 WHERE prompt_version IS NULL",
        [is_enabled]
      );
    }
    return result.rowCount ?? 0;
  }

  // Type-based evidence toggle (e.g. type:stoic_text)
  if (prefix.startsWith("type:")) {
    const typeValue = prefix.replace("type:", "");
    const { rowCount } = await query(
      "UPDATE evidence_records SET is_enabled = $1 WHERE type = $2",
      [is_enabled, typeValue]
    );
    return rowCount ?? 0;
  }

  // Default: source_ref LIKE prefix%
  const { rowCount } = await query(
    "UPDATE evidence_records SET is_enabled = $1 WHERE source_ref LIKE $2",
    [is_enabled, `${prefix}%`]
  );
  return rowCount ?? 0;
}

export async function getEvidenceSourceGroups(): Promise<
  Array<{ prefix: string; label: string; count: number; enabled_count: number }>
> {
  // Source-ref based evidence groups
  const sourceGroups = [
    { prefix: "Project Gutenberg", label: "Sample Data (Gutenberg)", filter: "source_ref LIKE 'Project Gutenberg%'" },
    { prefix: "https://www.notion.so/", label: "Notion Corpus", filter: "source_ref LIKE 'https://www.notion.so/%'" },
    { prefix: "notion:", label: "Notion Workspace (Legacy)", filter: "source_ref LIKE 'notion:%'" },
    { prefix: "test:", label: "Submitted Tests", filter: "source_ref LIKE 'test:%'" },
  ];

  const results: Array<{ prefix: string; label: string; count: number; enabled_count: number }> = [];

  for (const group of sourceGroups) {
    const { rows: totalRows } = await query(
      `SELECT COUNT(*)::int AS cnt FROM evidence_records WHERE ${group.filter}`
    );
    const { rows: enabledRows } = await query(
      `SELECT COUNT(*)::int AS cnt FROM evidence_records WHERE ${group.filter} AND is_enabled = true`
    );

    const total = totalRows[0]?.cnt ?? 0;
    const enabledCount = enabledRows[0]?.cnt ?? 0;

    // Always show "Submitted Tests" even when empty; hide other empty groups
    if (total === 0 && group.prefix !== "test:") continue;

    results.push({
      prefix: group.prefix,
      label: group.label,
      count: total,
      enabled_count: enabledCount,
    });
  }

  // Type-based evidence group: Stoic Text
  try {
    const { rows: stoicTotal } = await query(
      "SELECT COUNT(*)::int AS cnt FROM evidence_records WHERE type = 'stoic_text'"
    );
    const { rows: stoicEnabled } = await query(
      "SELECT COUNT(*)::int AS cnt FROM evidence_records WHERE type = 'stoic_text' AND is_enabled = true"
    );
    if ((stoicTotal[0]?.cnt ?? 0) > 0) {
      results.push({
        prefix: "type:stoic_text",
        label: "Stoic Text",
        count: stoicTotal[0].cnt,
        enabled_count: stoicEnabled[0].cnt,
      });
    }
  } catch {
    // Silently skip
  }

  // Claims split by prompt_version (v1/v2)
  try {
    const { rows: v1Total } = await query("SELECT COUNT(*)::int AS cnt FROM claims WHERE prompt_version = 'v1'");
    const { rows: v1Enabled } = await query("SELECT COUNT(*)::int AS cnt FROM claims WHERE prompt_version = 'v1' AND is_enabled = true");
    const { rows: v2Total } = await query("SELECT COUNT(*)::int AS cnt FROM claims WHERE prompt_version = 'v2'");
    const { rows: v2Enabled } = await query("SELECT COUNT(*)::int AS cnt FROM claims WHERE prompt_version = 'v2' AND is_enabled = true");
    const { rows: otherTotal } = await query("SELECT COUNT(*)::int AS cnt FROM claims WHERE prompt_version IS NULL");
    const { rows: otherEnabled } = await query("SELECT COUNT(*)::int AS cnt FROM claims WHERE prompt_version IS NULL AND is_enabled = true");

    if ((v1Total[0]?.cnt ?? 0) > 0) {
      results.push({ prefix: "claims:v1", label: "V1 Claims", count: v1Total[0].cnt, enabled_count: v1Enabled[0].cnt });
    }
    if ((v2Total[0]?.cnt ?? 0) > 0) {
      results.push({ prefix: "claims:v2", label: "V2 Claims", count: v2Total[0].cnt, enabled_count: v2Enabled[0].cnt });
    }
    if ((otherTotal[0]?.cnt ?? 0) > 0) {
      results.push({ prefix: "claims:other", label: "Other Claims", count: otherTotal[0].cnt, enabled_count: otherEnabled[0].cnt });
    }
  } catch {
    // Claims table may not exist yet — silently skip
  }

  return results;
}

export async function searchEvidence(
  productId: string | null,
  keywords: string[]
): Promise<EvidenceRecord[]> {
  // Sanitize: strip punctuation, cap to avoid issues
  const validKeywords = keywords
    .map((k) => k.replace(/[^a-z0-9]/gi, ""))
    .filter((k) => k.length > 3)
    .slice(0, 5);

  const conditions: string[] = ["is_enabled = true"];
  const params: any[] = [];
  let idx = 1;

  if (productId) {
    conditions.push(`product_id = $${idx++}`);
    params.push(productId);
  }

  if (validKeywords.length > 0) {
    const orParts = validKeywords.map((k) => {
      const p1 = `$${idx++}`;
      params.push(`%${k}%`);
      return `(title ILIKE ${p1} OR summary ILIKE ${p1})`;
    });
    conditions.push(`(${orParts.join(" OR ")})`);
  }

  const { rows } = await query(
    `SELECT * FROM evidence_records WHERE ${conditions.join(" AND ")} LIMIT 10`,
    params
  );
  return rows;
}

// ─── Evaluations ────────────────────────────────────────────────
export async function createEvaluation(
  resultData: Omit<EvaluationResult, "id" | "evaluated_at">,
  matchesData: Omit<EvaluationMatch, "id" | "evaluation_id">[]
): Promise<{ result: EvaluationResult; matches: EvaluationMatch[] }> {
  // Insert evaluation result
  const { rows: resultRows } = await query(
    `INSERT INTO evaluation_results (run_id, test_id, provider, model, prompt_version, verdict, similarity_percentage, reason, statement, recommended_action, prompt_sent, retrieval_metadata, raw_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      resultData.run_id, resultData.test_id, resultData.provider, resultData.model,
      resultData.prompt_version, resultData.verdict, resultData.similarity_percentage,
      resultData.reason, resultData.statement, resultData.recommended_action,
      resultData.prompt_sent,
      resultData.retrieval_metadata ? JSON.stringify(resultData.retrieval_metadata) : null,
      resultData.raw_response ? JSON.stringify(resultData.raw_response) : null,
    ]
  );
  const result = resultRows[0];

  // Insert matches
  const insertedMatches: EvaluationMatch[] = [];
  for (const m of matchesData) {
    const { rows: matchRows } = await query(
      `INSERT INTO evaluation_matches (evaluation_id, evidence_id, relationship, similarity_percentage, explanation)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [result.id, m.evidence_id, m.relationship, m.similarity_percentage, m.explanation]
    );
    insertedMatches.push(matchRows[0]);
  }

  // Update test status to evaluated
  await query(
    "UPDATE test_proposals SET status = 'evaluated' WHERE id = $1",
    [resultData.test_id]
  );

  // PRD 5.2 absorbed: Evaluation feedback loop — feed verdict back as claims
  const settings = await getProviderSettings();
  if (settings?.api_key_hash) {
    const feedbackText = [
      `Evaluation Verdict: ${result.verdict}`,
      result.statement ? `Statement: ${result.statement}` : null,
      result.reason ? `Rationale: ${result.reason}` : null,
      result.recommended_action ? `Recommended Action: ${result.recommended_action}` : null,
    ].filter(Boolean).join("\n\n");

    const test = await getTest(resultData.test_id);

    processSourceClaims({
      sourceType: "evidence",
      sourceId: result.id,
      sourceText: feedbackText,
      productId: test?.product_id || null,
      projectId: test?.project_id || null,
      sourceKind: "evaluation" as any,
      anthropicApiKey: settings.api_key_hash,
    }).catch((err) =>
      console.error("Evaluation feedback claim extraction failed:", err)
    );
  }

  return { result, matches: insertedMatches };
}

export async function getEvaluationByTestId(
  testId: string
): Promise<EvaluationResult | undefined> {
  const { rows } = await query(
    "SELECT * FROM evaluation_results WHERE test_id = $1 ORDER BY evaluated_at DESC LIMIT 1",
    [testId]
  );
  return rows[0] ?? undefined;
}

export async function getEvaluationWithMatches(resultId: string) {
  // Try lookup by evaluation_results.id first
  let { rows } = await query(
    "SELECT * FROM evaluation_results WHERE id = $1",
    [resultId]
  );

  if (rows.length === 0) {
    // Fall back to lookup by test_id
    const fallback = await query(
      "SELECT * FROM evaluation_results WHERE test_id = $1 ORDER BY evaluated_at DESC LIMIT 1",
      [resultId]
    );
    rows = fallback.rows;
  }

  const result = rows[0];
  if (!result) return undefined;

  // Always use the actual evaluation id for matches lookup
  const evalId = result.id;
  const { rows: matches } = await query(
    "SELECT * FROM evaluation_matches WHERE evaluation_id = $1",
    [evalId]
  );

  const enrichedMatches = await Promise.all(
    matches.map(async (m: any) => {
      // First try: evidence_id is a direct evidence_records ID
      const evidence = await getEvidenceById(m.evidence_id);
      // Second try: evidence_id is actually a claim ID
      let claim: any = null;
      if (!evidence && m.evidence_id) {
        const { rows: claimRows } = await query(
          "SELECT * FROM claims WHERE id = $1",
          [m.evidence_id]
        );
        if (claimRows.length > 0) {
          const claimData = claimRows[0];
          let sourceEvidence: any = null;
          if (claimData.source_id) {
            const { rows: seRows } = await query(
              "SELECT id, title, source_ref, summary, content FROM evidence_records WHERE id = $1",
              [claimData.source_id]
            );
            sourceEvidence = seRows[0] ?? null;
          }
          claim = { ...claimData, source_evidence: sourceEvidence };
        }
      }
      return { ...m, evidence, claim };
    })
  );

  return { result, matches: enrichedMatches };
}

export async function getAllEvaluations() {
  const { rows: data } = await query(
    "SELECT * FROM evaluation_results ORDER BY evaluated_at DESC"
  );

  const enriched = await Promise.all(
    data.map(async (r) => {
      const test = await getTest(r.test_id);
      return { ...r, test };
    })
  );
  return enriched;
}

// ─── Related Evaluations ────────────────────────────────────────
export async function getRelatedEvaluations(evaluationId: string, threshold = 25) {
  // Get the current evaluation's matched evidence IDs
  const { rows: currentMatches } = await query(
    "SELECT evidence_id FROM evaluation_matches WHERE evaluation_id = $1",
    [evaluationId]
  );

  if (currentMatches.length === 0) return [];

  const evidenceIds = currentMatches.map((m: any) => m.evidence_id);

  // Find other evaluations that matched any of the same evidence items
  const { rows: relatedMatches } = await query(
    "SELECT evaluation_id, evidence_id FROM evaluation_matches WHERE evidence_id = ANY($1) AND evaluation_id != $2",
    [evidenceIds, evaluationId]
  );

  if (relatedMatches.length === 0) return [];

  // Count shared evidence items per evaluation
  const countMap: Record<string, number> = {};
  relatedMatches.forEach((m: any) => {
    countMap[m.evaluation_id] = (countMap[m.evaluation_id] || 0) + 1;
  });

  const relatedEvalIds = Object.keys(countMap);

  // Fetch those evaluations, only ones meeting the similarity threshold
  const { rows: evaluations } = await query(
    "SELECT * FROM evaluation_results WHERE id = ANY($1) AND similarity_percentage >= $2 ORDER BY similarity_percentage DESC",
    [relatedEvalIds, threshold]
  );

  if (evaluations.length === 0) return [];

  // Enrich with test data and shared evidence count
  const enriched = await Promise.all(
    evaluations.map(async (e: any) => {
      const test = await getTest(e.test_id);
      return { ...e, test, shared_evidence_count: countMap[e.id] || 0 };
    })
  );

  return enriched
    .filter((e) => e.shared_evidence_count > 0)
    .sort((a, b) =>
      b.shared_evidence_count - a.shared_evidence_count ||
      b.similarity_percentage - a.similarity_percentage
    );
}

// ─── Operation Prompts ──────────────────────────────────────────
export async function getActivePrompt(): Promise<OperationPrompt | undefined> {
  const { rows } = await query(
    "SELECT * FROM operation_prompts WHERE is_active = true LIMIT 1"
  );
  return rows[0] ?? undefined;
}

export async function getPrompts(): Promise<OperationPrompt[]> {
  const { rows } = await query(
    "SELECT * FROM operation_prompts ORDER BY version DESC"
  );
  return rows;
}

export async function createPrompt(
  data: Omit<OperationPrompt, "id" | "created_at" | "updated_at">
): Promise<OperationPrompt> {
  const { rows } = await query(
    `INSERT INTO operation_prompts (name, version, text, is_active)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.name, data.version, data.text, data.is_active]
  );
  return rows[0];
}

export async function updatePrompt(
  id: string,
  data: Partial<OperationPrompt>
): Promise<OperationPrompt | undefined> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;
  const allowedFields = ["name", "version", "text", "is_active"] as const;
  for (const field of allowedFields) {
    if (field in data) {
      sets.push(`${field} = $${idx++}`);
      params.push((data as any)[field]);
    }
  }
  sets.push(`updated_at = $${idx++}`);
  params.push(new Date().toISOString());
  params.push(id);

  const { rows } = await query(
    `UPDATE operation_prompts SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] ?? undefined;
}

// ─── Data Sources ────────────────────────────────────────────────
export async function getSources(): Promise<DataSource[]> {
  const { rows } = await query("SELECT * FROM data_sources ORDER BY name ASC");
  return rows;
}

export async function createSource(
  data: Partial<DataSource>
): Promise<DataSource> {
  const fields: string[] = [];
  const placeholders: string[] = [];
  const params: any[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(key);
      placeholders.push(`$${idx++}`);
      params.push(value);
    }
  }

  const { rows } = await query(
    `INSERT INTO data_sources (${fields.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    params
  );
  return rows[0];
}

export async function updateSource(
  id: string,
  data: Partial<DataSource>
): Promise<DataSource | undefined> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && key !== "id") {
      sets.push(`${key} = $${idx++}`);
      params.push(value);
    }
  }
  sets.push(`updated_at = $${idx++}`);
  params.push(new Date().toISOString());
  params.push(id);

  const { rows } = await query(
    `UPDATE data_sources SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] ?? undefined;
}

// ─── Provider Settings ──────────────────────────────────────────
export async function getProviderSettings(): Promise<
  ProviderSettings | undefined
> {
  const { rows } = await query("SELECT * FROM provider_settings LIMIT 1");
  return rows[0] ?? undefined;
}

export async function upsertProviderSettings(data: {
  provider: string;
  model: string;
  api_key_hash?: string;
  api_key_last4?: string;
}): Promise<ProviderSettings> {
  const existing = await getProviderSettings();
  if (existing) {
    const { rows } = await query(
      `UPDATE provider_settings SET provider = $1, model = $2, api_key_hash = COALESCE($3, api_key_hash), api_key_last4 = COALESCE($4, api_key_last4), updated_at = $5
       WHERE id = $6 RETURNING *`,
      [data.provider, data.model, data.api_key_hash ?? null, data.api_key_last4 ?? null, new Date().toISOString(), existing.id]
    );
    return rows[0];
  }
  const { rows } = await query(
    `INSERT INTO provider_settings (provider, model, api_key_hash, api_key_last4)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.provider, data.model, data.api_key_hash ?? null, data.api_key_last4 ?? null]
  );
  return rows[0];
}

export async function deleteProviderSettings(): Promise<void> {
  await query("DELETE FROM provider_settings WHERE id IS NOT NULL");
}

// ─── Page Views ─────────────────────────────────────────────────
export async function trackPageView(data: {
  path: string;
  visitor_id: string;
  session_id?: string | null;
  event_type?: string;
  meta?: string | null;
  ip_address?: string;
  user_agent?: string;
  referrer?: string;
}): Promise<PageView> {
  try {
    const { rows } = await query(
      `INSERT INTO page_views (path, visitor_id, session_id, event_type, meta, ip_address, user_agent, referrer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        data.path, data.visitor_id, data.session_id ?? null,
        data.event_type && data.event_type !== "page_view" ? data.event_type : null,
        data.meta ?? null, data.ip_address ?? null, data.user_agent ?? null, data.referrer ?? null,
      ]
    );
    return rows[0];
  } catch (err: any) {
    // Fallback if new columns don't exist yet
    if (err.message?.includes("column")) {
      const { rows } = await query(
        `INSERT INTO page_views (path, visitor_id, ip_address, user_agent, referrer)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [data.path, data.visitor_id, data.ip_address ?? null, data.user_agent ?? null, data.referrer ?? null]
      );
      return rows[0];
    }
    throw err;
  }
}

export async function getPageViewStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [totalRes, allVisitorsRes, todayRes, todayVisitorsRes, topPagesRes] =
    await Promise.all([
      query("SELECT COUNT(*)::int AS cnt FROM page_views"),
      query("SELECT ip_address FROM page_views"),
      query("SELECT COUNT(*)::int AS cnt FROM page_views WHERE visited_at >= $1", [todayStart.toISOString()]),
      query("SELECT ip_address FROM page_views WHERE visited_at >= $1", [todayStart.toISOString()]),
      query("SELECT path FROM page_views"),
    ]);

  const uniqueVisitors = new Set(
    allVisitorsRes.rows.filter((r) => r.ip_address).map((r) => r.ip_address)
  ).size;
  const uniqueToday = new Set(
    todayVisitorsRes.rows.filter((r) => r.ip_address).map((r) => r.ip_address)
  ).size;

  // Build top pages map
  const pathCounts: Record<string, number> = {};
  for (const row of topPagesRes.rows) {
    pathCounts[row.path] = (pathCounts[row.path] ?? 0) + 1;
  }
  const topPages = Object.entries(pathCounts)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total_views: totalRes.rows[0]?.cnt ?? 0,
    unique_visitors: uniqueVisitors,
    views_today: todayRes.rows[0]?.cnt ?? 0,
    unique_today: uniqueToday,
    top_pages: topPages,
  };
}

export async function getDetailedAnalytics() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [allRowsRes, recentRowsRes] = await Promise.all([
    query(
      "SELECT * FROM page_views WHERE visited_at >= $1 ORDER BY visited_at ASC",
      [thirtyDaysAgo.toISOString()]
    ),
    query(
      "SELECT * FROM page_views WHERE visited_at >= $1 ORDER BY visited_at ASC",
      [sevenDaysAgo.toISOString()]
    ),
  ]);

  const BOT_PATTERNS = /bot|crawl|spider|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|preview|headless|phantom|puppeteer|lighthouse|pagespeed|googleother|bingpreview|yandex|baidu|semrush|ahrefs|mj12bot|dotbot|bytespider|gptbot|claude/i;

  const rows = allRowsRes.rows.filter((r) => !BOT_PATTERNS.test(r.user_agent || ""));
  const recent = recentRowsRes.rows.filter((r) => !BOT_PATTERNS.test(r.user_agent || ""));

  const visitors30d = new Set(rows.map((r) => r.ip_address).filter(Boolean)).size;
  const sessions30d = new Set(rows.filter((r) => r.session_id).map((r) => r.session_id)).size;
  const visitors7d = new Set(recent.map((r) => r.ip_address).filter(Boolean)).size;
  const sessions7d = new Set(recent.filter((r) => r.session_id).map((r) => r.session_id)).size;

  const deviceFingerprint = (r: any) => `${r.ip_address || "unknown"}::${parseUA(r.user_agent || "")}`;
  const devices30d = new Set(rows.map(deviceFingerprint)).size;
  const devices7d = new Set(recent.map(deviceFingerprint)).size;

  const browserCounts: Record<string, number> = {};
  for (const r of rows) {
    const browser = parseUA(r.user_agent || "");
    browserCounts[browser] = (browserCounts[browser] ?? 0) + 1;
  }

  const mobilePattern = /mobile|android|iphone|ipad|ipod/i;
  let mobileCount = 0;
  let desktopCount = 0;
  for (const r of rows) {
    if (mobilePattern.test(r.user_agent || "")) mobileCount++;
    else desktopCount++;
  }

  const pageViews = rows.filter((r) => !r.event_type || r.event_type === "page_view");

  const pathCounts: Record<string, number> = {};
  for (const r of pageViews) {
    pathCounts[r.path] = (pathCounts[r.path] ?? 0) + 1;
  }
  const topPages = Object.entries(pathCounts)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const eventCounts: Record<string, number> = {};
  for (const r of rows) {
    const et = r.event_type || "page_view";
    eventCounts[et] = (eventCounts[et] ?? 0) + 1;
  }

  const dailyMap: Record<string, { views: number; visitors: Set<string> }> = {};
  for (const r of rows) {
    const day = r.visited_at instanceof Date ? r.visited_at.toISOString().slice(0, 10) : String(r.visited_at).slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { views: 0, visitors: new Set() };
    dailyMap[day].views++;
    if (r.ip_address) dailyMap[day].visitors.add(r.ip_address);
  }
  const dailyActivity = Object.entries(dailyMap)
    .map(([date, d]) => ({ date, views: d.views, visitors: d.visitors.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sessionMap: Record<string, { visitor_id: string; pages: string[]; events: string[]; start: string; end: string; ua: string; referrer: string }> = {};
  for (const r of recent) {
    const sid = r.session_id || r.visitor_id;
    const visitedAt = r.visited_at instanceof Date ? r.visited_at.toISOString() : String(r.visited_at);
    if (!sessionMap[sid]) {
      sessionMap[sid] = { visitor_id: r.visitor_id, pages: [], events: [], start: visitedAt, end: visitedAt, ua: r.user_agent || "", referrer: r.referrer || "" };
    }
    sessionMap[sid].end = visitedAt;
    if (!r.event_type || r.event_type === "page_view") {
      sessionMap[sid].pages.push(r.path);
    } else {
      sessionMap[sid].events.push(r.event_type);
    }
  }
  const sessions = Object.entries(sessionMap)
    .map(([id, s]) => ({
      id: id.slice(0, 8),
      visitor_id: s.visitor_id.slice(0, 8),
      pages: s.pages,
      events: s.events,
      page_count: s.pages.length,
      start: s.start,
      end: s.end,
      duration_sec: Math.round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 1000),
      ua_short: parseUA(s.ua),
      referrer: s.referrer ? (() => { try { return new URL(s.referrer).hostname.replace("www.", ""); } catch { return "direct"; } })() : "direct",
    }))
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, 50);

  const refCounts: Record<string, number> = {};
  for (const r of rows) {
    let ref = "direct";
    if (r.referrer) {
      try { ref = new URL(r.referrer).hostname.replace("www.", ""); } catch { ref = r.referrer; }
    }
    refCounts[ref] = (refCounts[ref] ?? 0) + 1;
  }
  const topReferrers = Object.entries(refCounts)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    visitors_30d: visitors30d,
    sessions_30d: sessions30d,
    visitors_7d: visitors7d,
    sessions_7d: sessions7d,
    devices_30d: devices30d,
    devices_7d: devices7d,
    browser_breakdown: browserCounts,
    device_type: { mobile: mobileCount, desktop: desktopCount },
    total_events_30d: rows.length,
    top_pages: topPages,
    event_counts: eventCounts,
    daily_activity: dailyActivity,
    sessions,
    top_referrers: topReferrers,
  };
}

function parseUA(ua: string): string {
  if (!ua) return "unknown";
  if (ua.includes("Chrome") && !ua.includes("Edg")) return "Chrome";
  if (ua.includes("Edg")) return "Edge";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("bot") || ua.includes("Bot")) return "Bot";
  return "Other";
}
