// Public API for @assaylabs/decision-layer v2.

export {
  DecisionStore,
  type StoredDecision,
  type DepositContext,
} from "./decisions/store.js";

export {
  parseDecisionTags,
  DECISION_KINDS,
  LEGACY_KIND_ALIASES,
  MAX_BODY_CHARS,
  type DecisionKind,
  type ParsedDecision,
  type ParseResult,
} from "./parser/decisionTagParser.js";

export {
  type MemoryProvider,
  type SearchOptions,
  type SearchResult,
  type Observation,
  type HealthStatus,
  type HealthResult,
  type BatchGetResult,
} from "./providers/MemoryProvider.js";

export {
  ClaudeMemHTTPProvider,
  type ClaudeMemHTTPProviderOptions,
} from "./providers/ClaudeMemHTTPProvider.js";

export {
  runStopDrain,
  type StopHookInput,
  type StopHookResult,
} from "./hooks/stopDrain.js";

export {
  AssayMCPServer,
  type RecallResponse,
  type ExpandResponse,
  type BriefResponse,
} from "./mcp/server.js";

export {
  DECISION_CAPTURE_PROTOCOL,
  IMPORTANT_TOOL_DESCRIPTION,
} from "./mcp/protocol.js";

export { SCHEMA_VERSION } from "./decisions/schema.js";
