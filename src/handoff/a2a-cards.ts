import type { RoleId } from "../prefix-builder/assemble-prompt.ts";

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface A2AAgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  provider: { organization: string };
}

const ROLE_PROFILES: Record<
  RoleId,
  { title: string; description: string; skills: A2AAgentSkill[] }
> = {
  director: {
    title: "Director",
    description:
      "L0 chief orchestrator. Decomposes objectives into a Kanban DAG of typed TaskBrief envelopes and gates merges on the binding triad. Never edits implementation files.",
    skills: [
      {
        id: "decompose-objective",
        name: "Decompose Objective",
        description:
          "Translates a mission objective into ordered TaskBrief envelopes with mutation scopes and acceptance criteria.",
        tags: ["planning", "orchestration", "kanban"],
        examples: ["Break the wave objective into sequenced TaskBriefs with DAG dependencies."],
      },
      {
        id: "gate-merge",
        name: "Gate Merge",
        description:
          "Blocks or authorizes merges based on programmer verification, QA red-proof evidence, and drift-guard verdict.",
        tags: ["governance", "merge-gate"],
        examples: ["Verify triad evidence for wave-1 and authorize the merge."],
      },
    ],
  },
  architect: {
    title: "Architect",
    description:
      "L1 principal architect. Owns contracts and token vocabularies, defines module seams, and guards interface stability. Edits contracts and tokens trees only.",
    skills: [
      {
        id: "design-contract",
        name: "Design Contract",
        description:
          "Authors interface contracts, schemas, and token vocabularies with exact validation semantics.",
        tags: ["contracts", "schemas", "design"],
        examples: ["Define the handoff envelope contract revision with migration notes."],
      },
      {
        id: "review-drift",
        name: "Review Drift",
        description:
          "Reviews implementation diffs for contract drift and requires revisions for shape or semantic changes.",
        tags: ["review", "conformance"],
        examples: ["Audit the worker diff for contract drift against the frozen schema."],
      },
    ],
  },
  manager: {
    title: "Manager",
    description:
      "L1 tech lead. Dispatches TaskBrief envelopes to staff, runs worktree isolation, tracks WorkerReceipts, and requires QA PASS before merge. Never edits implementation files.",
    skills: [
      {
        id: "dispatch-brief",
        name: "Dispatch Brief",
        description:
          "Assigns scoped TaskBrief envelopes with toolbox profiles to staff roles in isolated worktrees.",
        tags: ["dispatch", "coordination"],
        examples: ["Dispatch the backend brief with src scope and the appsec profile."],
      },
      {
        id: "track-receipts",
        name: "Track Receipts",
        description:
          "Validates WorkerReceipt envelopes and bounces missing or invalid completion claims.",
        tags: ["tracking", "receipts"],
        examples: ["Validate the staff-backend receipt before forwarding to QA."],
      },
    ],
  },
  "staff-backend": {
    title: "Staff Backend",
    description:
      "L2 polyglot systems builder. Implements server sources, routers, catalogs, and verifiers with exact logic and tests. Activates appsec, android, game, and research profiles on demand.",
    skills: [
      {
        id: "implement-service",
        name: "Implement Service",
        description:
          "Implements and tests backend behavior per specification with zero stubs, emitting a typed WorkerReceipt.",
        tags: ["implementation", "backend", "testing"],
        examples: ["Implement the BM25 catalog scorer with conformance tests."],
      },
      {
        id: "harden-surface",
        name: "Harden Surface",
        description:
          "Hardens a service surface under the appsec profile with scanner-driven verification.",
        tags: ["appsec", "hardening"],
        examples: ["Harden the broker call path and verify with the appsec profile."],
      },
    ],
  },
  "staff-ui": {
    title: "Staff UI",
    description:
      "L2 design engineer and UI crafter. Implements presentation surfaces with layout discipline and DOM geometry gates. Owns ui/web trees; server sources are read-only.",
    skills: [
      {
        id: "craft-surface",
        name: "Craft Surface",
        description:
          "Builds interfaces, layouts, and interaction flows with geometry assertions and accessibility coverage.",
        tags: ["ui", "layout", "accessibility"],
        examples: ["Build the responsive review surface with geometry gate tests."],
      },
      {
        id: "consume-contract",
        name: "Consume Contract",
        description:
          "Wires presentation surfaces to architect contracts via typed envelopes.",
        tags: ["ui", "contracts"],
        examples: ["Wire the verdict view to the QaVerdict schema."],
      },
    ],
  },
  "qa-adversary": {
    title: "QA Adversary",
    description:
      "L2 adversarial QA and SRE auditor. Runs gate batteries, performs red-proof sabotage, records transcripts, and issues blocking verdicts. Never edits product sources.",
    skills: [
      {
        id: "red-proof-sabotage",
        name: "Red-Proof Sabotage",
        description:
          "Breaks the wave invariant transiently, observes suite failure, reverts cleanly, and re-observes green.",
        tags: ["qa", "sabotage", "red-proof"],
        examples: ["Corrupt byte zero of the assembled prefix and confirm the cache test fails."],
      },
      {
        id: "issue-verdict",
        name: "Issue Verdict",
        description:
          "Issues a typed QaVerdict with red-proof evidence that blocks merges on failure.",
        tags: ["qa", "verdict", "governance"],
        examples: ["Issue the wave-1 QaVerdict with the sabotage transcript attached."],
      },
    ],
  },
};

/**
 * Generates a valid Linux Foundation A2A v1.0.1 `agent-card.json`
 * manifest for the given role. The card advertises the role endpoint at
 * `<baseUrl>/a2a/<role>` with fixed protocol version, text-only modes,
 * streaming capability, and the role skill set. Throws fail-closed on
 * unknown roles and non-HTTP(S) base URLs.
 */
export function generateA2AAgentCard(
  role: RoleId,
  baseUrl: string,
): A2AAgentCard {
  const profile = ROLE_PROFILES[role];
  if (profile === undefined) {
    throw new Error(
      `Unknown role "${role}". Expected one of: ${Object.keys(ROLE_PROFILES).join(", ")}.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `Invalid baseUrl "${baseUrl}". Expected an absolute HTTP(S) URL. Failing closed.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid baseUrl "${baseUrl}". Only http and https are accepted. Failing closed.`,
    );
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  return {
    name: `heretek-${role}`,
    description: `${profile.title}: ${profile.description}`,
    url: `${normalized}/a2a/${role}`,
    version: "1.0.1",
    protocolVersion: "1.0.1",
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: profile.skills.map((s) => ({ ...s, tags: [...s.tags], examples: [...s.examples] })),
    provider: { organization: "Heretek-AI" },
  };
}
