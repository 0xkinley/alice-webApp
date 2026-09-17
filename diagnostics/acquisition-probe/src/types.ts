export const ACQUISITION_PROBE_CONTRACT_VERSION = "alice_acquisition_probe_v1";
export const ACQUISITION_TOOL_NAME = "submit_acquisition_evidence";

export type AcquisitionLeg = "ambient" | "active-retrieval" | "user-mediated";
export type AcquisitionProvider = "chatgpt" | "claude";

export interface AcquisitionRunMetadata {
  fixture_id: string;
  provider: AcquisitionProvider;
  account_plan: string;
  region: string;
  surface: string;
  host_version: string;
  entry_position: string;
  acquisition_leg: AcquisitionLeg;
  trial: number;
  exact_prompt: string;
  exact_prompt_sha256: string;
}

export interface AcquisitionSession {
  contract_version: typeof ACQUISITION_PROBE_CONTRACT_VERSION;
  session_id: string;
  token_sha256: string;
  created_at: string;
  expires_at: string;
  maximum_calls: 1;
  run: AcquisitionRunMetadata;
}

export interface AcquisitionRecord {
  contract_version: typeof ACQUISITION_PROBE_CONTRACT_VERSION;
  record_id: string;
  session_id: string;
  tool_name: typeof ACQUISITION_TOOL_NAME;
  received_at: string;
  expires_at: string;
  run: AcquisitionRunMetadata;
  received_arguments: {
    exact_json: string;
    sha256: string;
    utf8_bytes: number;
  };
  parsed_arguments: Record<string, unknown>;
}

export interface FixtureMarkerGroup {
  project: string[];
  instruction: string[];
  conversations: string[];
  messages: string[];
  decisions: string[];
  open_questions: string[];
  artifacts: string[];
  files: string[];
}

export interface FixtureFileManifest {
  id: string;
  marker: string;
  name: string;
  relative_path: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  required: boolean;
  relationship: string;
}

export interface AcquisitionFixtureManifest {
  contract_version: "alice_acquisition_fixture_v1";
  fixture_id: string;
  generated_at: string;
  project_name: string;
  counts: {
    projects: 1;
    project_instructions: 1;
    conversations: 5;
    messages: 43;
    uploaded_files_required: 4;
    uploaded_files_optional: 1;
    generated_artifacts: 1;
    significant_decisions: 6;
    open_questions: 3;
    superseded_decisions: 1;
    current_working_artifacts: 1;
  };
  markers: FixtureMarkerGroup;
  expected_markers: string[];
  negative_markers: string[];
  conversations: Array<{
    id: string;
    marker: string;
    title: string;
    order: number;
    message_markers: string[];
    relative_path: string;
  }>;
  decisions: Array<{
    marker: string;
    statement: string;
    conversation_id: string;
    status: "current" | "superseded";
    supersedes_marker?: string;
  }>;
  open_questions: Array<{
    marker: string;
    question: string;
    conversation_id: string;
  }>;
  artifact: {
    id: string;
    marker: string;
    title: string;
    relative_path: string;
    sha256: string;
    byte_size: number;
    relationship: string;
  };
  files: FixtureFileManifest[];
  prompt_files: Record<AcquisitionLeg, string>;
}
